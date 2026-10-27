"""What the Admin page shows: how many households, people and friends there are, how full each
household's data is, and how the summary email job has been doing.

The summary email job (daily_email.py) calls this about once an hour. It signs in as a service
account, so it can count across every household; the app can't, because the database rules only
let people see their own. It writes three records, which only the site's admins can read
(firestore.rules):
  admin/access  who the admins are: the Google accounts in the ADMIN_EMAILS secret
  admin/stats   counts and each household's data size (no household's contents)
  admin/runs    the latest summary emails sent or failed, newest first

Reading every household's data to measure it costs one read per household an hour, well within
Firebase's free daily reads for a few hundred households.
"""

import datetime as dt
import json
import os
import re

SYNC_LIMIT = 1040000  # the most a household's data can hold, as in sync.js
KEEP_RUNS = 60  # emails kept in admin/runs
REPORT_EVERY = 3300  # seconds between reports while the email job waits


def to_value(v):
    """A Firestore REST value from a plain Python value."""
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: to_value(x) for k, x in v.items()}}}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [to_value(x) for x in v]}}
    return {"stringValue": str(v)}


def from_value(v):
    """A plain Python value from a Firestore REST value."""
    if "mapValue" in v:
        return {k: from_value(x) for k, x in v["mapValue"].get("fields", {}).items()}
    if "arrayValue" in v:
        return [from_value(x) for x in v["arrayValue"].get("values", [])]
    if "integerValue" in v:
        return int(v["integerValue"])
    for kind in ("stringValue", "booleanValue", "doubleValue", "timestampValue"):
        if kind in v:
            return v[kind]
    return None


def from_fields(fields):
    return from_value({"mapValue": {"fields": fields or {}}})


def put(store, path, data):
    store.call(path, {"fields": {k: to_value(v) for k, v in data.items()}}, "PATCH")


def count(store, collection):
    """How many documents a collection holds, counted by the database (one read per 1,000)."""
    got = store.call(":runAggregationQuery", {"structuredAggregationQuery": {
        "structuredQuery": {"from": [{"collectionId": collection}]},
        "aggregations": [{"alias": "n", "count": {}}]}}, "POST")
    for row in got if isinstance(got, list) else [got]:
        n = row.get("result", {}).get("aggregateFields", {}).get("n", {}).get("integerValue")
        if n is not None:
            return int(n)
    return 0


def listing(store, collection, *fields):
    """Every document in a collection, with only these fields: [(id, fields, updateTime)]."""
    out, page = [], ""
    mask = "".join(f"&mask.fieldPaths={f}" for f in fields)
    while True:
        got = store.call(f"{collection}?pageSize=300{mask}{page}")
        for d in got.get("documents", []):
            out.append((d["name"].rsplit("/", 1)[1], from_fields(d.get("fields")), d.get("updateTime", "")))
        if not got.get("nextPageToken"):
            return out
        page = f"&pageToken={got['nextPageToken']}"


def data_size(box):
    """Bytes a household's data takes up, measured the way sync.js measures it."""
    return len(json.dumps(box, separators=(",", ":"), ensure_ascii=False))


def admin_emails():
    """The addresses in ADMIN_EMAILS, however they're written: commas, spaces or new lines between
    them, with or without quotes or <angle brackets> around them."""
    return sorted({a.lower() for a in re.findall(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", os.environ.get("ADMIN_EMAILS", ""))})


def masked(email):
    """An address with most of its name hidden, for the job's log (which is public)."""
    name, _, domain = email.partition("@")
    return f"{name[:2]}***{name[-1:] if len(name) > 3 else ''}@{domain}"


# What each kind of synced item is, as in sync.js (h: is one person's Fitbit numbers).
KINDS = {"e": "events", "t": "chores", "x": "expenses", "l": "ticks", "f": "kitchen", "k": "thanks", "n": "notes",
         "b": "bucket", "p": "people", "i": "itinerary", "g": "shopping", "m": "boxes", "h": "fitbit"}
TICK_DAYS = 14


def usage_of(items, now):
    """How one household uses the app, as counts only: {kind: [items, changed in the last 7 days]},
    when anything last changed (ms), and ticks per day ({YYYY-MM-DD: n}) for the last TICK_DAYS."""
    week = (now - dt.timedelta(days=7)).timestamp() * 1000
    first = (now - dt.timedelta(days=TICK_DAYS - 1)).date().isoformat()
    kinds, last, ticks = {}, 0, {}
    for key, it in (items or {}).items():
        kind = KINDS.get(key.split(":")[0]) if ":" in key else None
        if not kind or not isinstance(it, dict):
            continue
        u = it.get("u") if isinstance(it.get("u"), (int, float)) else 0
        k = kinds.setdefault(kind, [0, 0])
        k[0] += 1
        k[1] += u >= week
        last = max(last, u)
        if kind == "ticks" and str(it.get("date", "")) >= first:
            ticks[it["date"]] = ticks.get(it["date"], 0) + 1
    return kinds, last, ticks


def gather(store, emailing):
    """The admin/stats record. `emailing(home, rec)` says whether a household gets the email."""
    now = dt.datetime.now(dt.timezone.utc)
    homes = []
    usage, ticks, last_seen = {}, {}, []
    for home, rec, _ in listing(store, "homes", "members", "email", "emailSent"):
        row = {"id": home, "members": len(rec.get("members") or {}), "email": bool(emailing(home, rec)),
               "emailTo": len((rec.get("email") or {}).get("to") or []) if isinstance(rec.get("email"), dict) else 0,
               "emailSent": rec.get("emailSent") or "", "size": 0, "changed": ""}
        try:
            d = store.call(f"homes/{home}/data/main")
            box = from_fields(d.get("fields")).get("box")
            row["size"] = data_size(box)
            row["changed"] = d.get("updateTime", "")
            kinds, last, days = usage_of(json.loads(box.get("json") or "{}").get("items"), now)
            for kind, (n, wk) in kinds.items():
                u = usage.setdefault(kind, {"households": 0, "items": 0, "week": 0})
                u["households"] += n > 0
                u["items"] += n
                u["week"] += wk
            for day, n in days.items():
                ticks[day] = ticks.get(day, 0) + n
            last_seen.append(last)
        except Exception:  # started but never synced: no data yet
            pass
        homes.append(row)
    homes.sort(key=lambda h: -h["size"])
    legacy = listing(store, "households", "at")
    month_ago = (now - dt.timedelta(days=30)).isoformat().replace("+00:00", "Z")
    run = os.environ.get("GITHUB_RUN_ID")
    return {
        "at": now.isoformat().replace("+00:00", "Z"),
        "limit": SYNC_LIMIT,
        "households": len(homes),
        "people": sum(h["members"] for h in homes),
        "accounts": count(store, "users"),
        "friendships": count(store, "friendships"),
        "groups": count(store, "groups"),
        "posts": count(store, "posts"),
        "legacy": len(legacy),
        "legacyActive": sum(1 for _, _, t in legacy if t >= month_ago),
        "homes": homes[:200],
        # How the app is used, across every household: counts only, never what anything says.
        "usage": usage,
        "active": {f"d{n}": sum(1 for t in last_seen if t >= (now - dt.timedelta(days=n)).timestamp() * 1000) for n in (1, 7, 30)},
        "ticks": [{"day": (now - dt.timedelta(days=i)).date().isoformat(),
                   "n": ticks.get((now - dt.timedelta(days=i)).date().isoformat(), 0)} for i in range(TICK_DAYS - 1, -1, -1)],
        # Which of the job's settings are filled in (never their values).
        "secrets": {"smtp": bool(os.environ.get("EMAIL_SMTP_USER") and os.environ.get("EMAIL_SMTP_PASSWORD")),
                    "admins": len(admin_emails()), "homeId": bool(os.environ.get("HOME_ID", "").strip())},
        "job": f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{run}"
               if run and os.environ.get("GITHUB_REPOSITORY") else "",
    }


def report(store, emailing, sent):
    """Writes admin/access, admin/stats and the emails in `sent` to admin/runs, then empties `sent`."""
    emails = admin_emails()
    if emails:
        put(store, "admin/access", {"emails": emails})
    print(f"Admin page open to: {', '.join(masked(e) for e in emails) or 'nobody (ADMIN_EMAILS has no address)'}")
    put(store, "admin/stats", gather(store, emailing))
    if sent:
        try:
            had = from_fields(store.call("admin/runs").get("fields")).get("list") or []
        except Exception:  # the first report
            had = []
        put(store, "admin/runs", {"list": (list(reversed(sent)) + had)[:KEEP_RUNS]})
        sent.clear()
