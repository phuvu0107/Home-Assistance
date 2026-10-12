"""One-time PG&E sign-in on your own computer.

PG&E emails or texts a code the first time a new device signs in. Run this
once, enter the code, and paste the printed line into the PGE_LOGIN_DATA
GitHub secret so the daily job is treated as a known device.

  pip install -r sync/requirements.txt
  python3 sync/pge_pair.py
"""

import asyncio
import getpass
import json

import aiohttp
from opower import MfaChallenge, Opower, create_cookie_jar


async def main() -> None:
    username = input("PG&E username: ").strip()
    password = getpass.getpass("PG&E password: ")
    login_data: dict = {}
    async with aiohttp.ClientSession(cookie_jar=create_cookie_jar()) as session:
        try:
            await Opower(session, "pge", username, password).async_login()
            print("PG&E signed in without a code, so PGE_LOGIN_DATA can stay empty.")
            return
        except MfaChallenge as challenge:
            handler = challenge.handler
            options = await handler.async_get_mfa_options()
            if options:
                keys = list(options)
                for i, k in enumerate(keys, 1):
                    print(f"  [{i}] {options[k]}")
                pick = keys[int(input("Send the code to which one? ")) - 1]
                await handler.async_select_mfa_option(pick)
            login_data = await handler.async_submit_mfa_code(input("Code from PG&E: ").strip())
        # Confirm the saved login works before handing it over.
        await Opower(session, "pge", username, password, None, login_data).async_login()
    print("\nSigned in. Paste this line into the PGE_LOGIN_DATA secret:\n")
    print(json.dumps(login_data))
    if login_data.get("expiryDateTime"):
        print(f"\nPG&E says this stays valid until {login_data['expiryDateTime']}.")


if __name__ == "__main__":
    asyncio.run(main())
