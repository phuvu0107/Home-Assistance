"""Email the household a short summary four times a day: 7 AM, noon, 5 PM and 9 PM.

Run by .github/workflows/daily-email.yml. It reads the same household document the
dashboard syncs to (see sync.js) and sends one email through an SMTP account (a Gmail
app password works).

Needs these environment variables (GitHub secrets):
  FIREBASE_CONFIG       the same secret the site uses for sync
  HOME_ID and FIREBASE_SERVICE_ACCOUNT
                        a signed-in household: its id (Settings › Connections › Summary email)
                        and a Firebase service account key (JSON) that can read it
  or HOUSEHOLD_PASSPHRASE  for a household still on a passphrase
  EMAIL_SMTP_USER       the account that sends, e.g. you@gmail.com
  EMAIL_SMTP_PASSWORD   its app password
  EMAIL_TO              where to send, comma separated
Optional: ENERGY_PASSPHRASE and ENERGY_URL for yesterday's PG&E numbers,
EMAIL_SMTP_HOST / EMAIL_SMTP_PORT (default smtp.gmail.com:465), EMAIL_TIMEZONE,
WEATHER_LAT / WEATHER_LON (for the forecast at the top of every email), SLOT (morning, midday, evening or night) to force one, and DRY_RUN=1 to print instead of send.
"""

import base64
import datetime as dt
import hashlib
import html
import json
import os
import re
import smtplib
import sys
import urllib.request
from email.message import EmailMessage
from zoneinfo import ZoneInfo

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

# Households from before people were data (see people.js). Newer ones keep their people as p: items.
LEGACY_USERS = {"phu": "Phu", "nhi": "Nhi"}
LOVE = {"milestone": 200, "trip": 100, "learn": 50, "adventure": 40, "give": 30, "place": 25,
        "show": 20, "do": 15, "cook": 10, "date": 10, "food": 10}  # love points per bucket list kind, as in app.js
SALT = b"home-dashboard household sync v1"  # must match sync.js
ITER = 310_000
WMO = {0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy", 45: "Fog", 48: "Fog", 51: "Drizzle", 53: "Drizzle",
       55: "Drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow",
       80: "Showers", 81: "Showers", 82: "Heavy showers", 95: "Thunderstorms", 96: "Thunderstorms", 99: "Thunderstorms"}


def get_json(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def firebase_config():
    raw = os.environ["FIREBASE_CONFIG"]
    body = raw[raw.index("{"): raw.rindex("}") + 1]
    body = re.sub(r"//[^\n]*", "", body)
    body = re.sub(r"([{,]\s*)([A-Za-z_]\w*)\s*:", r'\1"\2":', body)
    return json.loads(re.sub(r",\s*}", "}", body))


def documents_url(cfg):
    host = os.environ.get("FIRESTORE_EMULATOR_HOST")  # local testing against the Firebase emulator
    base = f"http://{host}" if host else "https://firestore.googleapis.com"
    return f"{base}/v1/projects/{cfg['projectId']}/databases/(default)/documents"


def household_state(passphrase):
    """A passphrase household's items, decrypted, in the same shape sync.js keeps them."""
    cfg = firebase_config()
    doc_id = hashlib.sha256(f"home-dashboard:{passphrase}".encode()).hexdigest()
    fields = get_json(f"{documents_url(cfg)}/households/{doc_id}?key={cfg['apiKey']}")["fields"]
    if "moved" in fields:
        print("This passphrase household moved to sign-in, so its data here is out of date. "
              "Add the HOME_ID and FIREBASE_SERVICE_ACCOUNT secrets (see README).", file=sys.stderr)
    box = {k: v["stringValue"] for k, v in fields["box"]["mapValue"]["fields"].items() if "stringValue" in v}
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=SALT, iterations=ITER).derive(passphrase.encode())
    doc = json.loads(AESGCM(key).decrypt(base64.b64decode(box["iv"]), base64.b64decode(box["data"]), None))
    return state_from(doc["items"])


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


def home_state(home, account_json):
    """A signed-in household's items. The database rules only let members read it, so this signs
    in as a service account, which the rules don't apply to."""
    account = json.loads(account_json)
    cfg = {"projectId": account["project_id"]}
    req = urllib.request.Request(f"{documents_url(cfg)}/homes/{home}/data/main",
                                 headers={"Authorization": f"Bearer {'owner' if os.environ.get('FIRESTORE_EMULATOR_HOST') else service_token(account)}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        fields = json.load(r)["fields"]
    return state_from(json.loads(fields["box"]["mapValue"]["fields"]["json"]["stringValue"])["items"])


def state_from(items):
    lists = {"e": "events", "t": "tasks", "x": "expenses", "l": "log", "f": "fridge", "k": "thanks", "n": "notes", "b": "bucket", "p": "members"}
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


def weather(tz, day=0):
    """The forecast for today (day=0) or tomorrow (day=1): sky, high and low with the hour
    each one happens, sunrise, sunset and the chance of rain."""
    lat, lon = os.environ.get("WEATHER_LAT", "37.4419"), os.environ.get("WEATHER_LON", "-122.143")
    try:
        f = get_json(f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&daily=weather_code,"
                     f"temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max&hourly=temperature_2m"
                     f"&temperature_unit=fahrenheit&timezone={tz}&forecast_days=2")
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
MAX_WAIT = dt.timedelta(hours=5, minutes=30)  # a job can run 6 hours
MAX_LATE = dt.timedelta(hours=1)


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

    def open_task(t):
        if t.get("repeat") == "daily":
            return t.get("doneOn") != iso
        if t.get("repeat") == "weekly":
            return (t.get("doneOn") or "") < week_start
        return not t.get("doneOn")
    task_lines = []
    for uid, name in USERS.items():
        mine = [t for t in state["tasks"] if t.get("who") == uid and open_task(t)]
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
    text = hello + "\n\n" + "\n\n".join(t + "\n" + "\n".join(f"- {l}" for l in lines) for t, lines in sections) + f"\n\n{sign}\n— Your fridge\n"
    return subject, text, page(slot, now, hello, sign, sky, sections[1:] if sky else sections)


# Email clients ignore stylesheets and most layout CSS, so everything is inline and laid out with tables.
THEMES = {  # soft background tint, accent, small label above the greeting
    "morning": ("#fdf6ee", "#c2410c", "Morning briefing"),
    "midday": ("#f1f7fb", "#0369a1", "Midday check-in"),
    "evening": ("#f8f4fb", "#7e22ce", "Evening check-in"),
    "night": ("#f2f3f9", "#4338ca", "Tonight's recap"),
}
ICONS = {"Today": "📅", "Still to come today": "⏳", "Tomorrow": "📅", "Tasks": "✅", "Tasks still open": "✅", "Stars": "⭐",
         "Today's stars": "⭐", "Use soon from the fridge": "🥬", "Piggy Bank": "🐷", "Energy": "⚡", "Coming up this week": "🗓️"}
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
            f'<tr><td style="padding:22px 20px 26px;text-align:center;color:#6b7280;font-size:14px">{esc(sign)}<br>— Your fridge 🧊</td></tr>'
            f'</table></div>')


def plan(tz):
    """For a scheduled run: which email comes next and how long to wait for it. GitHub starts
    scheduled runs hours late, so an hourly run picks the next email up to MAX_WAIT ahead and
    waits for its time. An email whose time passed more than MAX_LATE ago is not sent."""
    now = dt.datetime.now(ZoneInfo(tz))
    for day in (now.date(), now.date() + dt.timedelta(days=1)):
        for slot, (h, m) in SEND_AT.items():
            at = dt.datetime(day.year, day.month, day.day, h, m, tzinfo=ZoneInfo(tz))
            if at >= now - MAX_LATE:
                if at - now > MAX_WAIT:
                    return None
                return slot, at, max(0, int((at - now).total_seconds()))


def main():
    if sys.argv[1:] == ["--plan"]:  # writes slot, key and wait for the workflow's next steps
        nxt = plan(os.environ.get("EMAIL_TIMEZONE", "America/Los_Angeles"))
        out = f"slot={nxt[0]}\nkey={nxt[1]:%Y-%m-%d}-{nxt[0]}\nwait={nxt[2]}\n" if nxt else "slot=\n"
        print(f"Next: the {nxt[0]} email at {nxt[1]:%a %H:%M}, in {nxt[2] // 60} min." if nxt else "No email due in the next few hours.")
        with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a") as f:
            f.write(out)
        return
    signed_in = os.environ.get("HOME_ID", "").strip() and os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    need = (["EMAIL_TO"] if signed_in else ["FIREBASE_CONFIG", "HOUSEHOLD_PASSPHRASE", "EMAIL_TO"]) \
        + ([] if os.environ.get("DRY_RUN") else ["EMAIL_SMTP_USER", "EMAIL_SMTP_PASSWORD"])
    missing = [k for k in need if not os.environ.get(k, "").strip()]
    if missing:
        print("Daily email is off until these secrets are added: " + ", ".join(missing))
        return
    tz = os.environ.get("EMAIL_TIMEZONE", "America/Los_Angeles")
    now = dt.datetime.now(ZoneInfo(tz))
    slot = os.environ.get("SLOT", "").strip().replace("auto", "") or SLOTS[min(SLOTS, key=lambda h: abs(h - now.hour))]
    if signed_in:
        state = home_state(os.environ["HOME_ID"].strip(), os.environ["FIREBASE_SERVICE_ACCOUNT"])
    else:
        state = household_state(os.environ["HOUSEHOLD_PASSPHRASE"].strip())
    morning = slot == "morning"
    energy = energy_yesterday((now.date() - dt.timedelta(days=1)).isoformat()) if morning else None
    subject, text, page = build(state, now, energy, weather(tz, 1 if slot == "night" else 0), slot)

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"Home dashboard <{os.environ.get('EMAIL_SMTP_USER', 'dry-run')}>"
    msg["To"] = os.environ["EMAIL_TO"]
    msg["Importance"], msg["X-Priority"], msg["X-MSMail-Priority"] = "High", "1", "High"  # the red "!" in Outlook and Apple Mail
    msg.set_content(text)
    msg.add_alternative(page, subtype="html")
    if os.environ.get("DRY_RUN"):
        print(subject + "\n\n" + text)
        return
    host, port = os.environ.get("EMAIL_SMTP_HOST", "smtp.gmail.com"), int(os.environ.get("EMAIL_SMTP_PORT", "465"))
    with smtplib.SMTP_SSL(host, port, timeout=30) as s:
        s.login(os.environ["EMAIL_SMTP_USER"], os.environ["EMAIL_SMTP_PASSWORD"])
        s.send_message(msg)
    print(f"Sent: {subject}")


if __name__ == "__main__":
    main()
