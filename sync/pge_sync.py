"""Daily PG&E sync, run by the Pages workflow.

Signs in to PG&E, reads daily usage and cost for the electric and gas
meters, merges it with the file already on the site, and writes an
encrypted `energy.enc.json` for the dashboard.

Environment:
  PGE_USERNAME, PGE_PASSWORD   PG&E account sign-in
  PGE_LOGIN_DATA               JSON from pge_pair.py (lets the job skip the emailed code)
  ENERGY_PASSPHRASE            passphrase typed once on the dashboard
  PREV_URL                     URL of the file currently on the site (optional)
  OUT                          where to write the encrypted file
"""

import asyncio
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta

import aiohttp
from opower import AggregateType, MeterType, MfaChallenge, Opower, create_cookie_jar

from energy_crypto import decrypt, encrypt

DAYS = 120


def previous(passphrase: str) -> tuple[dict, bytes | None]:
    """The data already published, so a day PG&E stops returning isn't lost."""
    url = os.environ.get("PREV_URL")
    if not url:
        return {"electric": {}, "gas": {}}, None
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            raw = r.read()
        return decrypt(json.loads(raw), passphrase), raw
    except Exception as err:  # first run, or the passphrase changed
        print(f"No previous energy file used ({err})")
        return {"electric": {}, "gas": {}}, None


async def billing(api: Opower, account, kind: str, out: dict) -> None:
    """Past bills (start date, usage, billed cost), so the dashboard can follow PG&E's billing cycles."""
    try:
        start = datetime.now() - timedelta(days=400)
        for read in await api.async_get_cost_reads(account, AggregateType.BILL, start, datetime.now()):
            day = read.start_time.strftime("%Y-%m-%d")
            bill = out["bills"].setdefault(day, {})
            bill[kind] = [round(read.consumption, 3), round(read.provided_cost, 2)]
    except Exception as err:  # bills are a nice-to-have; daily data still syncs
        print(f"No {kind} bills ({err})")


async def forecast(api: Opower, out: dict) -> None:
    """The current bill: when it started, when it ends, and PG&E's projected cost."""
    try:
        for f in await api.async_get_forecast():
            kind = "gas" if f.account.meter_type == MeterType.GAS else "electric"
            out["forecast"] = {**out.get("forecast", {}), "start": f.start_date.isoformat(), "end": f.end_date.isoformat(),
                               kind: [round(f.cost_to_date, 2), round(f.forecasted_cost, 2), round(f.typical_cost, 2)]}
    except Exception as err:
        print(f"No bill forecast ({err})")


async def fetch() -> dict:
    login_data = json.loads(os.environ.get("PGE_LOGIN_DATA") or "{}")
    out = {"electric": {}, "gas": {}, "bills": {}}
    async with aiohttp.ClientSession(cookie_jar=create_cookie_jar()) as session:
        api = Opower(session, "pge", os.environ["PGE_USERNAME"], os.environ["PGE_PASSWORD"], None, login_data)
        try:
            await api.async_login()
        except MfaChallenge:
            sys.exit("PG&E wants a new verification code. Run sync/pge_pair.py and update the PGE_LOGIN_DATA secret.")
        end = datetime.now()
        start = end - timedelta(days=DAYS)
        for account in await api.async_get_accounts():
            if account.meter_type not in (MeterType.ELEC, MeterType.GAS):
                continue
            kind = "gas" if account.meter_type == MeterType.GAS else "electric"
            for read in await api.async_get_cost_reads(account, AggregateType.DAY, start, end):
                day = read.start_time.strftime("%Y-%m-%d")
                cur = out[kind].setdefault(day, [0, 0])
                cur[0] = round(cur[0] + read.consumption, 3)
                cur[1] = round(cur[1] + read.provided_cost, 2)
            await billing(api, account, kind, out)
        await forecast(api, out)
    return out


def main() -> None:
    passphrase = os.environ["ENERGY_PASSPHRASE"]
    target = os.environ.get("OUT", "energy.enc.json")
    data, prev_raw = previous(passphrase)
    # Keep the last published file in place if the sync below fails.
    if prev_raw:
        with open(target, "wb") as f:
            f.write(prev_raw)
    fresh = asyncio.run(fetch())
    for kind in ("electric", "gas"):
        data.setdefault(kind, {}).update(fresh[kind])
    for start, bill in fresh["bills"].items():
        data.setdefault("bills", {}).setdefault(start, {}).update(bill)
    if fresh.get("forecast"):
        data["forecast"] = fresh["forecast"]
    data["syncedAt"] = int(datetime.now().timestamp() * 1000)
    with open(target, "w") as f:
        json.dump(encrypt(data, passphrase), f)
    print(f"Fetched {len(fresh['electric'])} electric and {len(fresh['gas'])} gas days and {len(fresh['bills'])} bills from PG&E")
    if fresh.get("forecast"):
        print(f"Current bill: {fresh['forecast']['start']} to {fresh['forecast']['end']}")


if __name__ == "__main__":
    main()
