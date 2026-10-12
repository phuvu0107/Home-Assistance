"""Daily Fitbit sync through the Google Health API, run by the Pages workflow.

For each person with a saved sign-in, reads daily steps, distance, active zone
minutes, resting heart rate, sleep and weight, merges them with the file already
on the site, and writes an encrypted `health.enc.json` (same passphrase as the
energy file).

Environment:
  GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_CLIENT_SECRET   the OAuth client
  HEALTH_TOKEN_PHU, HEALTH_TOKEN_NHI                     sign-ins from health_pair.py (either may be empty)
  ENERGY_PASSPHRASE                                      passphrase typed once on the dashboard
  PREV_URL                                               URL of the file currently on the site (optional)
  OUT                                                    where to write the encrypted file
"""

import json
import os
import sys
import urllib.request
from datetime import date, datetime, timedelta

from energy_crypto import decrypt, encrypt
from google_health import SignInExpired, access_token, api

DAYS = 30
PEOPLE = ("phu", "nhi")


def previous(passphrase: str) -> tuple[dict, bytes | None]:
    url = os.environ.get("PREV_URL")
    if not url:
        return {"people": {}}, None
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            raw = r.read()
        return decrypt(json.loads(raw), passphrase), raw
    except Exception as err:  # first run, or the passphrase changed
        print(f"No previous health file used ({err})")
        return {"people": {}}, None


def civil(d: date) -> dict:
    return {"date": {"year": d.year, "month": d.month, "day": d.day}, "time": {"hours": 0}}


def day_of(c: dict) -> str:
    d = c["date"]
    return f"{d['year']:04d}-{d['month']:02d}-{d['day']:02d}"


def rollup(token: str, kind: str, start: date, end: date) -> list:
    body = {"range": {"start": civil(start), "end": civil(end)}, "windowSizeDays": 1, "pageSize": 100}
    return api(token, f"{kind}/dataPoints:dailyRollUp", body).get("rollupDataPoints", [])


def listed(token: str, kind: str, filt: str) -> list:
    points, page = [], None
    while True:
        q = {"filter": filt, "pageSize": 25}
        if page:
            q["pageToken"] = page
        r = api(token, f"{kind}/dataPoints", query=q)
        points += r.get("dataPoints", [])
        page = r.get("nextPageToken")
        if not page or len(points) > 500:
            return points


def fetch_person(token: str) -> tuple[dict, list]:
    """Daily values keyed by date, and the names of anything that couldn't be read."""
    days: dict = {}
    skipped = []
    end = date.today() + timedelta(days=1)
    start = end - timedelta(days=DAYS)
    put = lambda d, k, v: days.setdefault(d, {}).__setitem__(k, v)

    rollups = {
        "steps": lambda p: int(p["steps"].get("countSum", 0)),
        "distance": lambda p: round(int(p["distance"].get("millimetersSum", 0)) / 1e6, 2),  # km
        "active-zone-minutes": lambda p: sum(int(v) for v in p["activeZoneMinutes"].values()),
        "weight": lambda p: round(p["weight"]["weightGramsAvg"] / 1000, 2),  # kg
    }
    keys = {"steps": "steps", "distance": "km", "active-zone-minutes": "azm", "weight": "kg"}
    field = {"steps": "steps", "distance": "distance", "active-zone-minutes": "activeZoneMinutes", "weight": "weight"}
    for kind, read in rollups.items():
        try:
            for p in rollup(token, kind, start, end):
                if p.get(field[kind]):
                    put(day_of(p["civilStartTime"]), keys[kind], read(p))
        except SignInExpired:
            raise
        except Exception as err:
            skipped.append(f"{kind} ({err})")

    try:
        for p in listed(token, "daily-resting-heart-rate", f'daily_resting_heart_rate.date >= "{start.isoformat()}"'):
            r = p.get("dailyRestingHeartRate") or {}
            if r.get("date") and r.get("beatsPerMinute"):
                put(day_of({"date": r["date"]}), "rhr", int(r["beatsPerMinute"]))
    except SignInExpired:
        raise
    except Exception as err:
        skipped.append(f"resting heart rate ({err})")

    try:
        for p in listed(token, "sleep", f'sleep.interval.civil_end_time >= "{start.isoformat()}"'):
            s = p.get("sleep") or {}
            woke = s.get("interval", {}).get("civilEndTime")
            summary = s.get("summary") or {}
            if not woke or not summary.get("minutesAsleep"):
                continue
            d = day_of(woke)
            stages = {x.get("type"): int(x.get("minutes", 0)) for x in summary.get("stagesSummary", [])}
            cur = days.get(d, {}).get("sleep", [0, 0, 0, 0, 0])
            # Asleep, deep, light, REM, awake (minutes). Naps on the same day add up.
            add = [int(summary["minutesAsleep"]), stages.get("DEEP", 0), stages.get("LIGHT", 0), stages.get("REM", 0),
                   int(summary.get("minutesAwake", 0))]
            put(d, "sleep", [a + b for a, b in zip(cur, add)])
    except SignInExpired:
        raise
    except Exception as err:
        skipped.append(f"sleep ({err})")
    return days, skipped


def main() -> None:
    passphrase = os.environ["ENERGY_PASSPHRASE"]
    target = os.environ.get("OUT", "health.enc.json")
    cid, secret = os.environ.get("GOOGLE_HEALTH_CLIENT_ID", ""), os.environ.get("GOOGLE_HEALTH_CLIENT_SECRET", "")
    data, prev_raw = previous(passphrase)
    if prev_raw:  # keep the last published file in place if anything below fails
        with open(target, "wb") as f:
            f.write(prev_raw)
    people = data.setdefault("people", {})
    now = int(datetime.now().timestamp() * 1000)
    linked = 0
    for who in PEOPLE:
        refresh = os.environ.get(f"HEALTH_TOKEN_{who.upper()}", "").strip()
        if not refresh:
            continue
        linked += 1
        person = people.setdefault(who, {"days": {}})
        try:
            days, skipped = fetch_person(access_token(cid, secret, refresh))
        except SignInExpired:
            person["status"] = "signin"
            print(f"{who.title()}: Google sign-in expired. Run sync/health_pair.py and update HEALTH_TOKEN_{who.upper()}.")
            continue
        except Exception as err:
            person["status"] = "error"
            print(f"{who.title()}: couldn't read Google Health ({err})")
            continue
        for d, vals in days.items():
            person["days"].setdefault(d, {}).update(vals)
        # Keep about 13 months.
        cutoff = (date.today() - timedelta(days=400)).isoformat()
        person["days"] = {d: v for d, v in sorted(person["days"].items()) if d >= cutoff}
        person["status"] = "ok"
        person["syncedAt"] = now
        print(f"{who.title()}: {len(days)} days from Google Health" + (f"; skipped {'; '.join(skipped)}" if skipped else ""))
    if not linked:
        sys.exit("No HEALTH_TOKEN_* secrets yet. Run sync/health_pair.py first.")
    data["syncedAt"] = now
    with open(target, "w") as f:
        json.dump(encrypt(data, passphrase), f)


if __name__ == "__main__":
    main()
