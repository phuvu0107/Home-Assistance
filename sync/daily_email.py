"""Email each household that asked for it a short summary four times a day: 7:30 AM, noon,
5 PM and 9 PM on that household's own clock.

Run by .github/workflows/daily-email.yml. A household turns the email on in the app (Settings ›
Connections › Summary email), which saves who gets it, its time zone and its weather location on
the household's record (homes/{home}.email). This script signs in as a service account, finds
every household with the email on, reads the same data the dashboard syncs (see sync.js) and
sends through one SMTP account (a Gmail app password works). Each email is marked on the
household's record once sent (homes/{home}.emailSent), so it goes out once.

Needs these environment variables (GitHub secrets):
  FIREBASE_SERVICE_ACCOUNT  a Firebase service account key (JSON) that can read the households
  EMAIL_SMTP_USER       the account that sends, e.g. you@gmail.com
  EMAIL_SMTP_PASSWORD   its app password
Optional: HOME_ID, the one household that gets yesterday's PG&E numbers (ENERGY_PASSPHRASE and
ENERGY_URL); it also still gets the email at EMAIL_TO until it is turned on in the app.
EMAIL_SMTP_HOST / EMAIL_SMTP_PORT (default smtp.gmail.com:465). For a run started by hand:
HOME (one household's id) and SLOT (morning, midday, evening or night) send that email now.
DRY_RUN=1 prints instead of sending.
ADMIN_EMAILS (optional): the Google accounts that can open the Admin page; each run also writes
its stats (admin_report.py).
"""

import base64
import datetime as dt
import html
import json
import os
import re
import smtplib
import sys
import time
import urllib.request
from email.message import EmailMessage
from zoneinfo import ZoneInfo

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

import admin_report

# Households from before people were data (see people.js). Newer ones keep their people as p: items.
LEGACY_USERS = {"phu": "Phu", "nhi": "Nhi"}
LOVE = {"milestone": 200, "trip": 100, "learn": 50, "adventure": 40, "give": 30, "place": 25,
        "show": 20, "do": 15, "cook": 10, "date": 10, "food": 10}  # love points per bucket list kind, as in app.js
WMO = {0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy", 45: "Fog", 48: "Fog", 51: "Drizzle", 53: "Drizzle",
       55: "Drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow",
       80: "Showers", 81: "Showers", 82: "Heavy showers", 95: "Thunderstorms", 96: "Thunderstorms", 99: "Thunderstorms"}


def get_json(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def documents_url(cfg):
    host = os.environ.get("FIRESTORE_EMULATOR_HOST")  # local testing against the Firebase emulator
    base = f"http://{host}" if host else "https://firestore.googleapis.com"
    return f"{base}/v1/projects/{cfg['projectId']}/databases/(default)/documents"


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def service_token(account):
    """An access token for the service account, from a signed JWT (Google's OAuth server-to-server flow)."""
    now = int(dt.datetime.now(dt.timezone.utc).timestamp())
    head = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = b64url(json.dumps({"iss": account["client_email"], "scope": "https://www.googleapis.com/auth/datastore",
                                "aud": account["token_uri"], "iat": now, "exp": now + 600}).encode())
    key = serialization.load_pem_private_key(account["private_key"].encode(), password=None)
    sig = b64url(key.sign(f"{head}.{claims}".encode(), padding.PKCS1v15(), hashes.SHA256()))
    body = f"grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={head}.{claims}.{sig}".encode()
    req = urllib.request.Request(account["token_uri"], data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["access_token"]


class Store:
    """The household database, read and written as a service account, which the database rules
    don't apply to (they only let members read a household)."""

    def __init__(self, account_json):
        self.account = json.loads(account_json)
        self.base = documents_url({"projectId": self.account["project_id"]})
        self.token, self.token_at = None, 0

    def call(self, path, body=None, method="GET"):
        if os.environ.get("FIRESTORE_EMULATOR_HOST"):
            self.token = "owner"
        elif time.time() - self.token_at > 1800:  # tokens last an hour; a run can last six
            self.token, self.token_at = service_token(self.account), time.time()
        url = self.base + (path if path.startswith(":") else f"/{path}")  # ":runQuery" and the like
        req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body else None,
                                     headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)

    def homes(self):
        """Every household: {id: {"name", "email", "emailSent"}}."""
        out, page = {}, ""
        while True:
            got = self.call(f"homes?pageSize=300&mask.fieldPaths=name&mask.fieldPaths=email&mask.fieldPaths=emailSent{page}")
            for d in got.get("documents", []):
                out[d["name"].rsplit("/", 1)[1]] = value({"mapValue": {"fields": d.get("fields", {})}})
            if not got.get("nextPageToken"):
                return out
            page = f"&pageToken={got['nextPageToken']}"

    def state(self, home):
        """A household's items, in the same shape sync.js keeps them."""
        fields = self.call(f"homes/{home}/data/main")["fields"]
        return state_from(json.loads(fields["box"]["mapValue"]["fields"]["json"]["stringValue"])["items"])

    def mark_sent(self, home, key):
        self.call(f"homes/{home}?updateMask.fieldPaths=emailSent&currentDocument.exists=true",
                  {"fields": {"emailSent": {"stringValue": key}}}, "PATCH")


def value(v):
    """A plain Python value from a Firestore REST value."""
    if "mapValue" in v:
        return {k: value(x) for k, x in v["mapValue"].get("fields", {}).items()}
    if "arrayValue" in v:
        return [value(x) for x in v["arrayValue"].get("values", [])]
    for kind in ("stringValue", "booleanValue", "doubleValue"):
        if kind in v:
            return v[kind]
    if "integerValue" in v:
        return int(v["integerValue"])
    return None


# When chores come due; the same rules as schedule.js in the app.
def chore_start(t, today):
    days, every = t.get("days") or [], t.get("every")
    sunday = lambda d: d - dt.timedelta(days=(d.weekday() + 1) % 7)
    if t.get("repeat") == "daily":
        if not days:
            return today
        return next((today - dt.timedelta(days=i) for i in range(7) if (today - dt.timedelta(days=i)).isoweekday() % 7 in days), today)
    if t.get("repeat") == "weekly":
        if every == "month":
            return today.replace(day=1)
        n = max(1, min(4, int(every or 1)))
        week = sunday(today)
        start = sunday(dt.date.fromisoformat(t["from"])) if t.get("from") else week
        return week - dt.timedelta(weeks=((week - start).days // 7) % n)
    return None


def chore_done(t, today):
    start = chore_start(t, today)
    return bool(t.get("doneOn")) and (start is None or t["doneOn"] >= start.isoformat())


def chore_open(t, today):
    # A weekday chore added after its day this week isn't owed until the next one.
    due = not (t.get("repeat") == "daily" and t.get("days") and t.get("from") and chore_start(t, today).isoformat() < t["from"])
    return due and not chore_done(t, today)


def chore_owner(t, today, ids):
    # Turn-taking chores pass on after the stretch they were done in, even if no screen has done it yet.
    who = t.get("who")
    if t.get("turns") and t.get("doneOn") and t.get("turned") != t["doneOn"] and not chore_done(t, today) and who in ids and len(ids) > 1:
        return ids[(ids.index(who) + 1) % len(ids)]
    return who


def state_from(items):
    lists = {"e": "events", "t": "tasks", "x": "expenses", "l": "log", "f": "fridge", "k": "thanks", "n": "notes", "b": "bucket", "p": "members", "g": "shopping"}
    state = {name: [v for k, v in items.items() if k.startswith(p + ":")] for p, name in lists.items()}
    state["stars"] = items.get("stars", {}).get("value", {})
    return state


def people(state):
    """{id: name} for the household's people, in the app's order."""
    members = sorted(state.get("members") or [], key=lambda u: (u.get("order", 0), str(u.get("id"))))
    return {u["id"]: u.get("name") or "?" for u in members if u.get("id")} or dict(LEGACY_USERS)


def transfers(month, ids):
    """Who owes whom for a month of expenses, as in people.js: split expenses are shared evenly,
    paid by 'both' means everyone paid an equal share, and settle-ups move money between two people."""
    balance = dict.fromkeys(ids, 0.0)
    for x in month:
        if x.get("kind") == "settle":
            if x.get("paidBy") in balance:
                balance[x["paidBy"]] += x["amount"]
            if x.get("to") in balance:
                balance[x["to"]] -= x["amount"]
        elif x.get("split"):
            payers = ids if x.get("paidBy") == "both" else [x.get("paidBy")]
            for p in payers:
                if p in balance:
                    balance[p] += x["amount"] / len(payers)
            for p in ids:
                balance[p] -= x["amount"] / len(ids)
    rank = lambda side: sorted(([p, v] for p, v in side if v >= 0.005), key=lambda pv: (-pv[1], ids.index(pv[0])))
    owed, owes = rank(balance.items()), rank((p, -v) for p, v in balance.items())
    out, i, j = [], 0, 0
    while i < len(owes) and j < len(owed):
        v = min(owes[i][1], owed[j][1])
        if v >= 0.005:
            out.append((owes[i][0], owed[j][0], round(v, 2)))
        owes[i][1] -= v
        owed[j][1] -= v
        i += owes[i][1] < 0.005
        j += owed[j][1] < 0.005
    return out


def energy_yesterday(day):
    pw, url = os.environ.get("ENERGY_PASSPHRASE"), os.environ.get("ENERGY_URL")
    if not pw or not url:
        return None
    try:
        sys.path.insert(0, os.path.dirname(__file__))
        from energy_crypto import decrypt
        data = decrypt(get_json(url), pw)
    except Exception as e:  # energy is a bonus; the email still goes out
        print(f"Energy skipped: {e}")
        return None
    e = data.get("electric", {}).get(day)
    g = data.get("gas", {}).get(day)
    if not e and not g:
        return None
    kwh, cost = (e or [0, 0])[0], (e or [0, 0])[1] + (g or [0, 0])[1]
    return f"{kwh:.1f} kWh" + (f", ${cost:.2f}" if cost else "")


WMO_ICON = {0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️", 45: "🌫️", 48: "🌫️", 51: "🌦️", 53: "🌦️", 55: "🌦️", 61: "🌧️", 63: "🌧️",
            65: "🌧️", 71: "🌨️", 73: "🌨️", 75: "❄️", 80: "🌦️", 81: "🌧️", 82: "⛈️", 95: "⛈️", 96: "⛈️", 99: "⛈️"}


def clock(iso):
    return dt.datetime.fromisoformat(iso).strftime("%-I:%M %p")


def weather(where, day=0):
    """The forecast at a household's place (tz, lat, lon, unit) for today (day=0) or tomorrow
    (day=1): sky, high and low with the hour each one happens, sunrise, sunset and the chance of rain."""
    unit = "celsius" if where.get("unit") == "C" else "fahrenheit"
    try:
        f = get_json(f"https://api.open-meteo.com/v1/forecast?latitude={where['lat']}&longitude={where['lon']}&daily=weather_code,"
                     f"temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max&hourly=temperature_2m"
                     f"&temperature_unit={unit}&timezone={where['tz']}&forecast_days=2")
    except Exception as e:
        print(f"Weather skipped: {e}")
        return None
    d, h = f["daily"], f["hourly"]
    date = d["time"][day]
    hours = [(t, v) for t, v in zip(h["time"], h["temperature_2m"]) if t.startswith(date) and v is not None]
    hot, cold = max(hours, key=lambda x: x[1]), min(hours, key=lambda x: x[1])
    hour = lambda t: dt.datetime.fromisoformat(t).strftime("%-I %p")
    code = d["weather_code"][day]
    return {"when": "Tomorrow" if day else "Today", "icon": WMO_ICON.get(code, "🌡️"), "sky": WMO.get(code, "Mixed"),
            "hi": round(hot[1]), "hi_at": hour(hot[0]), "lo": round(cold[1]), "lo_at": hour(cold[0]),
            "sunrise": clock(d["sunrise"][day]), "sunset": clock(d["sunset"][day]),
            "rain": d.get("precipitation_probability_max", [None, None])[day]}


def weather_lines(w):
    rain = f" · {w['rain']}% chance of rain" if w.get("rain") else ""
    return [f"{w['sky']}, {w['hi']}° / {w['lo']}°{rain}",
            f"Warmest {w['hi']}° around {w['hi_at']} · coolest {w['lo']}° around {w['lo_at']}",
            f"Sunrise {w['sunrise']} · sunset {w['sunset']}"]


def fmt_time(hhmm):
    return dt.datetime.strptime(hhmm, "%H:%M").strftime("%-I:%M %p")


def who_label(who, users):
    return ("both" if len(users) == 2 else "everyone") if who == "both" else users.get(who, "")


SLOTS = {7: "morning", 12: "midday", 17: "evening", 21: "night"}
# When each email goes out. The morning one waits until :30 for the 7 AM deploy's PG&E data.
SEND_AT = {"morning": (7, 30), "midday": (12, 0), "evening": (17, 0), "night": (21, 0)}
MAX_LATE = dt.timedelta(hours=1)  # an email more than this late is skipped
RUN_FOR = 5.5 * 3600  # a job can run 6 hours; the next hourly run takes over
CHECK_EVERY = 600  # look for newly turned-on households this often while waiting
PALO_ALTO = {"tz": "America/Los_Angeles", "lat": 37.4419, "lon": -122.143, "unit": "F"}


def build(state, now, energy, sky, slot="morning"):
    """One email. Morning is the full day ahead; midday and evening cover what's left of
    today; night recaps today's stars and looks at tomorrow."""
    USERS = people(state)
    today = now.date()
    iso = today.isoformat()
    yday = (today - dt.timedelta(days=1)).isoformat()
    tomorrow = (today + dt.timedelta(days=1)).isoformat()
    week_start = (today - dt.timedelta(days=(today.weekday() + 1) % 7)).isoformat()  # Sunday, like the app
    sections = []  # (title, [lines])

    def event_line(e, day=False):
        when = dt.date.fromisoformat(e["date"]).strftime("%a") + " · " if day else ""
        return (f"{when}{fmt_time(e['time']) if e.get('time') else 'All day'} · {e['title']}"
                + (f" ({who_label(e.get('who'), USERS)})" if e.get("who") else "") + (" · IMPORTANT" if e.get("important") else ""))
    on = lambda day: sorted((e for e in state["events"] if e.get("date") == day), key=lambda e: e.get("time") or "")
    events = on(iso)
    if slot in ("midday", "evening"):  # only what hasn't started yet
        events = [e for e in events if e.get("time") and e["time"] >= now.strftime("%H:%M")]
    if slot == "night":
        events = on(tomorrow)
        sections.append(("Tomorrow", [event_line(e) for e in events] or ["Nothing on the calendar."]))
    else:
        title = "Today" if slot == "morning" else "Still to come today"
        sections.append((title, [event_line(e) for e in events] or ["Nothing else on the calendar." if slot != "morning" else "Nothing on the calendar."]))

    task_lines = []
    for uid, name in USERS.items():
        mine = [t for t in state["tasks"] if chore_owner(t, today, list(USERS)) == uid and chore_open(t, today)]
        if mine:
            task_lines.append(f"{name}: " + ", ".join(t["title"] + (" (important)" if t.get("important") else "") for t in mine))
    task_count = sum(len(l.split(": ", 1)[1].split(", ")) for l in task_lines)
    sections.append(("Tasks" if slot == "morning" else "Tasks still open", task_lines or ["All caught up."]))

    stars = lambda uid, since, until=None: sum(l.get("stars", 0) for l in state["log"]
                                               if l.get("who") == uid and l.get("date", "") >= since and (until is None or l["date"] <= until))
    if slot == "morning":
        sections.append(("Stars", ["Yesterday: " + " · ".join(f"{n} +{stars(u, yday, yday)}" for u, n in USERS.items()),
                                   "This week: " + " · ".join(f"{n} {stars(u, week_start)}" for u, n in USERS.items())]))
    elif slot == "night":
        sections.insert(0, ("Today's stars", ["Today: " + " · ".join(f"{n} +{stars(u, iso, iso)}" for u, n in USERS.items()),
                                              "This week: " + " · ".join(f"{n} {stars(u, week_start)}" for u, n in USERS.items())]))

    def days_left(it):
        return (dt.date.fromisoformat(it["use"]) - today).days if it.get("use") else None
    soon = sorted((it for it in state["fridge"] if days_left(it) is not None and days_left(it) <= (2 if slot != "night" else 1)), key=days_left)
    if soon and slot != "midday":
        sections.append(("Use soon from the fridge", [
            f"{it['name']} · " + ("past use-by" if days_left(it) < 0 else "today" if days_left(it) == 0 else f"in {days_left(it)} day{'s' if days_left(it) > 1 else ''}")
            for it in soon]))

    month = [x for x in state["expenses"] if x.get("date", "").startswith(iso[:7])]
    if month and slot == "morning":
        spent = [x for x in month if x.get("kind") != "settle"]
        owing = transfers(month, list(USERS))
        owe = "" if len(USERS) < 2 else " ".join(f"{USERS[f]} owes {USERS[t]} ${v:.2f}." for f, t, v in owing) or "All square."
        sections.append(("Piggy Bank", [f"{now.strftime('%B')} so far: ${sum(x['amount'] for x in spent):.2f}. {owe}".strip()]))

    if energy and slot == "morning":
        sections.append(("Energy", [f"Yesterday: {energy}"]))

    upcoming = sorted((e for e in state["events"] if (tomorrow if slot == "night" else iso) < e.get("date", "") <= (today + dt.timedelta(days=6)).isoformat()),
                      key=lambda e: (e["date"], e.get("time") or ""))
    if upcoming and slot in ("morning", "night"):
        sections.append(("Coming up this week", [event_line(e, day=True) for e in upcoming[:6]]))

    # Thank-yous nobody has opened in the app yet go first, so they're seen even without opening it.
    # Each shows up for two days of emails, then waits in the app.
    recent = now.timestamp() * 1000 - 2 * 864e5
    unread = sorted((k for k in state.get("thanks", []) if not k.get("readAt") and k.get("at", 0) >= recent), key=lambda k: k.get("at", 0))
    if unread:
        sections.insert(0, ("Thank-you notes", [
            f"{k.get('emoji') or '💌'} {USERS.get(k.get('from'), '')} to {USERS.get(k.get('to'), '')}: \u201c{k.get('text') or 'Thank you!'}\u201d"
            + (f" (for {k['for']})" if k.get("for") else "") for k in unread]))
    # Bucket list items ticked off in the last two days, so the other person hears about it.
    ticked = sorted((b for b in state.get("bucket", []) if b.get("doneAt", 0) >= recent), key=lambda b: b["doneAt"])
    if ticked:
        went = lambda b: "together" if b.get("doneBy") == "both" else f"by {USERS.get(b.get('doneBy'), 'someone')}"
        sections.insert(1 if unread else 0, ("Ticked off the bucket list", [f"🎉 {b.get('text', '')} ({went(b)}, +{LOVE.get(b.get('kind'), 15)} love points)" for b in ticked]))
    shopping = [g.get("name", "") for g in state.get("shopping", [])]
    if shopping and slot in ("midday", "evening"):  # on the way home
        sections.append(("Shopping list", shopping[:20] + ([f"and {len(shopping) - 20} more"] if len(shopping) > 20 else [])))
    notes = sorted((n for n in state.get("notes", []) if not n.get("until") or n["until"] >= iso), key=lambda n: -n.get("at", 0))
    if notes and slot in ("morning", "night"):
        sections.append(("Notes on the fridge", [f"{USERS.get(n.get('by'), '')}: {' '.join(n.get('text', '').split())}" for n in notes[:8]]))

    plural = lambda n, w: f"{n} {w}{'s' if n != 1 else ''}"
    subject = {
        "morning": f"{now.strftime('%A, %b %-d')} · {plural(len(events), 'event')}, {plural(task_count, 'task')}",
        "midday": f"Midday check-in · {plural(task_count, 'task')} open",
        "evening": f"Evening check-in · {plural(task_count, 'task')} open",
        "night": f"Tonight's recap · tomorrow has {plural(len(events), 'event')}",
    }[slot]
    if unread:
        subject = f"💌 {subject}"
    greet = {"morning": "Good morning", "midday": "Good afternoon", "evening": "Good evening", "night": "Good night"}[slot]
    sign = {"morning": "Have a great day!", "midday": "Keep it up!", "evening": "Enjoy your evening!", "night": "Sleep well!"}[slot]
    names = list(USERS.values())
    hello = f"{greet}, {', '.join(names[:-1]) + ' and ' + names[-1] if len(names) > 1 else names[0]}!"
    if sky:
        sections.insert(0, (f"Weather {sky['when'].lower()}", weather_lines(sky)))
    text = hello + "\n\n" + "\n\n".join(t + "\n" + "\n".join(f"- {l}" for l in lines) for t, lines in sections) + f"\n\n{sign}\n— Your fridge\n\n{STOP}\n"
    return subject, text, page(slot, now, hello, sign, sky, sections[1:] if sky else sections)


# Email clients ignore stylesheets and most layout CSS, so everything is inline and laid out with tables.
THEMES = {  # soft background tint, accent, small label above the greeting
    "morning": ("#fdf6ee", "#c2410c", "Morning briefing"),
    "midday": ("#f1f7fb", "#0369a1", "Midday check-in"),
    "evening": ("#f8f4fb", "#7e22ce", "Evening check-in"),
    "night": ("#f2f3f9", "#4338ca", "Tonight's recap"),
}
ICONS = {"Today": "📅", "Still to come today": "⏳", "Tomorrow": "📅", "Tasks": "✅", "Tasks still open": "✅", "Stars": "⭐",
         "Today's stars": "⭐", "Use soon from the fridge": "🥬", "Piggy Bank": "🐷", "Energy": "⚡", "Coming up this week": "🗓️", "Shopping list": "🛒"}
STOP = "To stop these emails, turn them off in the app: Settings › Connections › Summary email."
FONT = "-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif"


def page(slot, now, hello, sign, sky, sections):
    tint, accent, kicker = THEMES[slot]
    esc = html.escape
    header = (f'<td style="background:{tint};padding:30px 28px 26px;border-radius:18px 18px 0 0;border-bottom:3px solid {accent}">'
              f'<div style="font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:{accent}">{kicker}</div>'
              f'<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:27px;line-height:1.25;color:#1c2333;margin-top:8px">{esc(hello)}</div>'
              f'<div style="font-size:14px;color:#6b7280;margin-top:6px">{now.strftime("%A, %B %-d")}</div></td>')
    cards = ""
    if sky:
        rain = f" · 💧 {sky['rain']}% rain" if sky.get("rain") else ""
        stat = lambda icon, label, value, note: (
            f'<td width="25%" style="padding:10px 4px;text-align:center;background:#fff;border-radius:12px">'
            f'<div style="font-size:20px">{icon}</div><div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-top:2px">{label}</div>'
            f'<div style="font-size:16px;font-weight:700;color:#1c2333">{value}</div><div style="font-size:12px;color:#6b7280">{note}</div></td>')
        gap = '<td width="6" style="font-size:0">&nbsp;</td>'
        cards += (f'<tr><td style="padding:20px 20px 0"><div style="background:#f0f9ff;border-radius:16px;padding:16px">'
                  f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
                  f'<td style="font-size:44px;width:56px;vertical-align:middle">{sky["icon"]}</td>'
                  f'<td style="vertical-align:middle"><div style="font-size:12px;color:#0369a1;font-weight:700;text-transform:uppercase;letter-spacing:.6px">Weather {esc(sky["when"].lower())}</div>'
                  f'<div style="font-size:20px;font-weight:700;color:#1c2333">{esc(sky["sky"])} · {sky["hi"]}° / {sky["lo"]}°</div>'
                  f'<div style="font-size:13px;color:#475569">{rain.lstrip(" ·")}</div></td></tr></table>'
                  f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px"><tr>'
                  + stat("🔥", "Warmest", f"{sky['hi']}°", sky["hi_at"]) + gap + stat("🧊", "Coolest", f"{sky['lo']}°", sky["lo_at"]) + gap
                  + stat("🌅", "Sunrise", sky["sunrise"].replace(" AM", ""), "AM") + gap + stat("🌇", "Sunset", sky["sunset"].replace(" PM", ""), "PM")
                  + '</tr></table></div></td></tr>')
    for title, lines in sections:
        items = "".join(f'<tr><td style="padding:5px 0;border-top:1px solid #f1f5f9;font-size:15px;color:#1c2333">{esc(l)}</td></tr>' for l in lines)
        cards += (f'<tr><td style="padding:16px 20px 0"><div style="border:1px solid #eef0f4;border-radius:16px;padding:14px 16px">'
                  f'<div style="font-size:13px;font-weight:700;color:{accent};text-transform:uppercase;letter-spacing:.6px;padding-bottom:6px">'
                  f'{ICONS.get(title, "•")}&nbsp; {esc(title)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">{items}</table></div></td></tr>')
    return (f'<div style="background:#f3f4f6;padding:20px 8px;font-family:{FONT};line-height:1.45">'
            f'<table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:18px">'
            f'<tr>{header}</tr>{cards}'
            f'<tr><td style="padding:22px 20px 26px;text-align:center;color:#6b7280;font-size:14px">{esc(sign)}<br>— Your fridge 🧊'
            f'<div style="font-size:12px;color:#9ca3af;margin-top:14px">{esc(STOP)}</div></td></tr>'
            f'</table></div>')


def zone(name):
    try:
        return ZoneInfo(name)
    except Exception:
        return ZoneInfo(PALO_ALTO["tz"])


def settings_for(home, rec):
    """Who gets a household's email and where the household is, or None when it's off."""
    e = rec.get("email")
    if isinstance(e, dict):  # turned on or off in the app
        to = [a.strip() for a in e.get("to") or [] if isinstance(a, str) and "@" in a]
        if not e.get("on") or not to:
            return None
        num = lambda v, d: v if isinstance(v, (int, float)) else d
        return {"to": to[:10], "tz": zone(e.get("tz") or "").key, "lat": num(e.get("lat"), PALO_ALTO["lat"]),
                "lon": num(e.get("lon"), PALO_ALTO["lon"]), "unit": "C" if e.get("unit") == "C" else "F"}
    # Set up with GitHub secrets before households could turn it on themselves.
    to = [a.strip() for a in os.environ.get("EMAIL_TO", "").split(",") if "@" in a]
    if home == os.environ.get("HOME_ID", "").strip() and to:
        return {**PALO_ALTO, "to": to, "tz": zone(os.environ.get("EMAIL_TIMEZONE") or PALO_ALTO["tz"]).key}
    return None


def slot_times(tz, now):
    """Each email's send time in this time zone, yesterday through tomorrow, as (time, slot)."""
    here = now.astimezone(ZoneInfo(tz)).date()
    return [(dt.datetime(d.year, d.month, d.day, h, m, tzinfo=ZoneInfo(tz)), slot)
            for d in (here - dt.timedelta(days=1), here, here + dt.timedelta(days=1)) for slot, (h, m) in SEND_AT.items()]


def due(tz, now):
    """The email whose time has come in this time zone, as (slot, key), or None. GitHub starts
    scheduled runs late, so an email up to MAX_LATE past its time still goes."""
    for at, slot in slot_times(tz, now):
        if at <= now < at + MAX_LATE:
            return slot, f"{at:%Y-%m-%d}-{slot}"
    return None


def next_at(tz, now):
    return min(at for at, _ in slot_times(tz, now) if at > now)


def send(store, home, where, slot):
    now = dt.datetime.now(ZoneInfo(where["tz"]))
    state = store.state(home)
    mine = home == os.environ.get("HOME_ID", "").strip()  # the PG&E account belongs to one household
    energy = energy_yesterday((now.date() - dt.timedelta(days=1)).isoformat()) if slot == "morning" and mine else None
    subject, text, page = build(state, now, energy, weather(where, 1 if slot == "night" else 0), slot)

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"Hometide <{os.environ.get('EMAIL_SMTP_USER', 'dry-run')}>"
    msg["To"] = ", ".join(where["to"])
    msg["Importance"], msg["X-Priority"], msg["X-MSMail-Priority"] = "High", "1", "High"  # the red "!" in Outlook and Apple Mail
    msg.set_content(text)
    msg.add_alternative(page, subtype="html")
    if os.environ.get("DRY_RUN"):
        print(f"To {msg['To']}: {subject}\n\n{text}")
        return
    host, port = os.environ.get("EMAIL_SMTP_HOST", "smtp.gmail.com"), int(os.environ.get("EMAIL_SMTP_PORT", "465"))
    with smtplib.SMTP_SSL(host, port, timeout=30) as s:
        s.login(os.environ["EMAIL_SMTP_USER"], os.environ["EMAIL_SMTP_PASSWORD"])
        s.send_message(msg)
    print(f"Sent to {home}: {subject}")


def send_due(store, now):
    """Sends every household's email whose time has come, once. Returns when the next one is due."""
    upcoming = []
    for home, rec in store.homes().items():
        where = settings_for(home, rec)
        if not where:
            continue
        upcoming.append(next_at(where["tz"], now))
        d = due(where["tz"], now)
        if not d or rec.get("emailSent") == d[1]:
            continue
        try:
            # Marked before sending: if sending then fails, that one email is missed, rather
            # than a household getting it again every few minutes.
            if not os.environ.get("DRY_RUN"):
                store.mark_sent(home, d[1])
            send(store, home, where, d[0])
            note(home, d[0])
        except Exception as e:  # one household's trouble doesn't stop the others' emails
            print(f"{home}: the {d[0]} email failed: {e}", file=sys.stderr)
            note(home, d[0], e)
    return min(upcoming, default=None)


SENT = []  # emails sent or failed since the last admin report


def note(home, slot, error=None, by_hand=False):
    row = {"at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
           "home": home, "slot": slot, "ok": error is None}
    if error is not None:
        row["error"] = str(error)[:200]
    if by_hand:
        row["byHand"] = True
    SENT.append(row)


def report(store):
    """Updates what the Admin page shows. Its trouble never stops the emails."""
    if os.environ.get("DRY_RUN"):
        return
    try:
        admin_report.report(store, lambda home, rec: settings_for(home, rec) is not None, SENT)
    except Exception as e:
        print(f"Couldn't update the admin stats: {e}", file=sys.stderr)


def main():
    need = ["FIREBASE_SERVICE_ACCOUNT"] + ([] if os.environ.get("DRY_RUN") else ["EMAIL_SMTP_USER", "EMAIL_SMTP_PASSWORD"])
    missing = [k for k in need if not os.environ.get(k, "").strip()]
    if missing:
        print("The summary email is off until these secrets are added: " + ", ".join(missing))
        if "FIREBASE_SERVICE_ACCOUNT" not in missing:
            report(Store(os.environ["FIREBASE_SERVICE_ACCOUNT"]))  # the Admin page still gets its stats
        return
    store = Store(os.environ["FIREBASE_SERVICE_ACCOUNT"])
    if os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch" or os.environ.get("SEND_HOME"):
        # Started by hand: one household's email right now, whether or not it's time.
        home = (os.environ.get("SEND_HOME") or os.environ.get("HOME_ID") or "").strip()
        rec = store.homes().get(home)
        where = rec is not None and settings_for(home, rec)
        if not where:
            print(f"Household {home or '(none given)'} hasn't turned on the summary email in Settings.")
            return
        hour = dt.datetime.now(ZoneInfo(where["tz"])).hour
        slot = os.environ.get("SLOT", "").strip().replace("auto", "") or SLOTS[min(SLOTS, key=lambda h: abs(h - hour))]
        try:
            send(store, home, where, slot)
            note(home, slot, by_hand=True)
        except Exception as e:
            note(home, slot, e, by_hand=True)
            raise
        finally:
            report(store)
        return
    # Scheduled: keep sending each household's emails as they come due, then hand over to the next run.
    stop = time.monotonic() + RUN_FOR
    reported = None
    while True:
        now = dt.datetime.now(dt.timezone.utc)
        nxt = send_due(store, now)
        if os.environ.get("DRY_RUN"):
            return
        if SENT or reported is None or time.monotonic() - reported > admin_report.REPORT_EVERY:
            report(store)
            reported = time.monotonic()
        wait = CHECK_EVERY if nxt is None else max(30, min(CHECK_EVERY, (nxt - now).total_seconds() + 5))
        if time.monotonic() + wait > stop:
            return
        time.sleep(wait)


if __name__ == "__main__":
    main()
