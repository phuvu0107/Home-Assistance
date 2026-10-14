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

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

USERS = {"phu": "Phu", "nhi": "Nhi"}
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
    lists = {"e": "events", "t": "tasks", "x": "expenses", "l": "log", "f": "fridge", "k": "thanks", "n": "notes"}
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
