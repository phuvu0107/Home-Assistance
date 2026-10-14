"""Email the household a short summary four times a day: 7 AM, noon, 5 PM and 9 PM.

Run by .github/workflows/daily-email.yml. It reads the same encrypted household
document the dashboard syncs to (see sync.js), unlocks it with the household
passphrase, and sends one email through an SMTP account (a Gmail app password works).

Needs these environment variables (GitHub secrets):
  FIREBASE_CONFIG       the same secret the site uses for sync
  HOUSEHOLD_PASSPHRASE  the passphrase typed on each device
  EMAIL_SMTP_USER       the account that sends, e.g. you@gmail.com
  EMAIL_SMTP_PASSWORD   its app password
  EMAIL_TO              where to send, comma separated
Optional: ENERGY_PASSPHRASE and ENERGY_URL for yesterday's PG&E numbers,
EMAIL_SMTP_HOST / EMAIL_SMTP_PORT (default smtp.gmail.com:465), EMAIL_TIMEZONE,
WEATHER_LAT / WEATHER_LON, SLOT (morning, midday, evening or night) to force one, and DRY_RUN=1 to print instead of send.
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

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

USERS = {"phu": "Phu", "nhi": "Nhi"}
LOVE = {"trip": 100, "place": 25, "do": 15, "food": 10}  # love points per bucket list kind, as in app.js
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


def household_state(passphrase):
    """The household's items, decrypted, in the same shape sync.js keeps them."""
    cfg = firebase_config()
    doc_id = hashlib.sha256(f"home-dashboard:{passphrase}".encode()).hexdigest()
    url = (f"https://firestore.googleapis.com/v1/projects/{cfg['projectId']}/databases/(default)"
           f"/documents/households/{doc_id}?key={cfg['apiKey']}")
    box = {k: v["stringValue"] for k, v in get_json(url)["fields"]["box"]["mapValue"]["fields"].items() if "stringValue" in v}
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=SALT, iterations=ITER).derive(passphrase.encode())
    doc = json.loads(AESGCM(key).decrypt(base64.b64decode(box["iv"]), base64.b64decode(box["data"]), None))
    items = doc["items"]
    lists = {"e": "events", "t": "tasks", "x": "expenses", "l": "log", "f": "fridge", "k": "thanks", "n": "notes", "b": "bucket"}
    state = {name: [v for k, v in items.items() if k.startswith(p + ":")] for p, name in lists.items()}
    state["stars"] = items.get("stars", {}).get("value", {})
    return state


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


def weather(tz):
    lat, lon = os.environ.get("WEATHER_LAT", "37.4419"), os.environ.get("WEATHER_LON", "-122.143")
    try:
        w = get_json(f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&daily=weather_code,"
                     f"temperature_2m_max,temperature_2m_min,sunset&temperature_unit=fahrenheit&timezone={tz}&forecast_days=1")["daily"]
    except Exception as e:
        print(f"Weather skipped: {e}")
        return None
    sunset = dt.datetime.fromisoformat(w["sunset"][0]).strftime("%-I:%M %p")
    return (f"{WMO.get(w['weather_code'][0], 'Mixed')}, {round(w['temperature_2m_max'][0])}° / "
            f"{round(w['temperature_2m_min'][0])}°. Sunset at {sunset}.")


def fmt_time(hhmm):
    return dt.datetime.strptime(hhmm, "%H:%M").strftime("%-I:%M %p")


def who_label(who):
    return "both" if who == "both" else USERS.get(who, "")


SLOTS = {7: "morning", 12: "midday", 17: "evening", 21: "night"}
MAX_LATE = dt.timedelta(minutes=90)  # a scheduled run later than this sends nothing


def build(state, now, energy, sky, slot="morning"):
    """One email. Morning is the full day ahead; midday and evening cover what's left of
    today; night recaps today's stars and looks at tomorrow."""
    today = now.date()
    iso = today.isoformat()
    yday = (today - dt.timedelta(days=1)).isoformat()
    tomorrow = (today + dt.timedelta(days=1)).isoformat()
    week_start = (today - dt.timedelta(days=(today.weekday() + 1) % 7)).isoformat()  # Sunday, like the app
    sections = []  # (title, [lines])

    def event_line(e, day=False):
        when = dt.date.fromisoformat(e["date"]).strftime("%a") + " · " if day else ""
        return (f"{when}{fmt_time(e['time']) if e.get('time') else 'All day'} · {e['title']}"
                + (f" ({who_label(e.get('who'))})" if e.get("who") else "") + (" · IMPORTANT" if e.get("important") else ""))
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
        if sky and slot == "morning":
            sections[-1][1].append(sky)

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
        a, b = list(USERS)
        spent = [x for x in month if x.get("kind") != "settle"]
        shared = [x for x in spent if x.get("split")]
        paid_a = sum(x["amount"] / 2 if x.get("paidBy") == "both" else x["amount"] for x in shared if x.get("paidBy") in (a, "both"))
        settled = sum(x["amount"] if x.get("paidBy") == b else -x["amount"] for x in month if x.get("kind") == "settle")
        net = paid_a - sum(x["amount"] for x in shared) / 2 - settled  # > 0 means b owes a
        owe = "All square." if abs(net) < 0.005 else f"{USERS[b] if net > 0 else USERS[a]} owes {USERS[a] if net > 0 else USERS[b]} ${abs(net):.2f}."
        sections.append(("Piggy Bank", [f"{now.strftime('%B')} so far: ${sum(x['amount'] for x in spent):.2f}. {owe}"]))

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
    hello = f"{greet}, {' and '.join(USERS.values())}!"
    text = hello + "\n\n" + "\n\n".join(t + "\n" + "\n".join(f"- {l}" for l in lines) for t, lines in sections) + f"\n\n{sign}\n— Your fridge\n"
    body = "".join(f'<h3 style="margin:22px 0 6px;font-size:15px">{html.escape(t)}</h3><ul style="margin:0;padding-left:20px">'
                   + "".join(f'<li style="margin:3px 0">{html.escape(l)}</li>' for l in lines) + "</ul>" for t, lines in sections)
    page = (f'<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.45;color:#1c2333;max-width:560px">'
            f'<p style="font-size:17px;margin:0">{html.escape(hello)}</p>{body}'
            f'<p style="margin-top:24px;color:#6b7280">{sign}<br>— Your fridge</p></div>')
    return subject, text, page


def pick_slot(now, tz):
    """Which email this run is. Scheduled runs pass the cron line, and GitHub can start them
    late, so the slot comes from when the run was meant to start, not from the clock now.
    The workflow fires for both summer and winter time; the run for the other one stops here."""
    cron = os.environ.get("SCHEDULE", "").split()
    if not cron:  # started by hand: pick the nearest slot
        return SLOTS[min(SLOTS, key=lambda h: abs(h - now.hour))]
    utc_now = dt.datetime.now(dt.timezone.utc)
    meant = utc_now.replace(hour=int(cron[1]), minute=int(cron[0]), second=0, microsecond=0)
    if meant > utc_now + dt.timedelta(minutes=5):
        meant -= dt.timedelta(days=1)  # meant for just before midnight UTC
    slot = SLOTS.get(meant.astimezone(ZoneInfo(tz)).hour)
    late = utc_now - meant
    if slot and late > MAX_LATE:
        # GitHub has started scheduled runs hours late; a 7 AM email at 2 PM is just noise.
        print(f"Skipping the {slot} email: GitHub started this run {late.seconds // 3600}h {late.seconds % 3600 // 60}m late.")
        return "late"
    return slot


def main():
    need = ["FIREBASE_CONFIG", "HOUSEHOLD_PASSPHRASE", "EMAIL_TO"] + ([] if os.environ.get("DRY_RUN") else ["EMAIL_SMTP_USER", "EMAIL_SMTP_PASSWORD"])
    missing = [k for k in need if not os.environ.get(k, "").strip()]
    if missing:
        print("Daily email is off until these secrets are added: " + ", ".join(missing))
        return
    tz = os.environ.get("EMAIL_TIMEZONE", "America/Los_Angeles")
    now = dt.datetime.now(ZoneInfo(tz))
    slot = os.environ.get("SLOT", "").strip().replace("auto", "") or pick_slot(now, tz)
    if slot == "late":
        return
    if not slot:
        print("Not an email hour in this time zone today (the other summer/winter time run sends it).")
        return
    state = household_state(os.environ["HOUSEHOLD_PASSPHRASE"].strip())
    morning = slot == "morning"
    energy = energy_yesterday((now.date() - dt.timedelta(days=1)).isoformat()) if morning else None
    subject, text, page = build(state, now, energy, weather(tz) if morning else None, slot)

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"Home dashboard <{os.environ.get('EMAIL_SMTP_USER', 'dry-run')}>"
    msg["To"] = os.environ["EMAIL_TO"]
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
