"""One-time Google sign-in for a person's Fitbit data, run on your own computer.

It opens Google's sign-in page in your browser, then prints a line to save as
that person's GitHub secret (HEALTH_TOKEN_PHU or HEALTH_TOKEN_NHI). Nothing is
saved on disk. Uses only the Python standard library.

  python3 sync/health_pair.py
"""

import base64
import getpass
import hashlib
import http.server
import os
import secrets
import threading
import urllib.parse
import webbrowser

from google_health import SCOPES, TOKEN_URL, api, post_form


def main() -> None:
    client_id = os.environ.get("GOOGLE_HEALTH_CLIENT_ID") or input("Client ID: ").strip()
    client_secret = os.environ.get("GOOGLE_HEALTH_CLIENT_SECRET") or getpass.getpass("Client secret: ").strip()
    who = (input("Whose Fitbit is this, Phu or Nhi? ").strip() or "Phu").upper()

    got: dict = {}
    done = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
            if "code" in q or "error" in q:
                got.update(q)
                done.set()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<p style='font:16px sans-serif'>Signed in. You can close this tab and go back to the terminal.</p>")

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    redirect = f"http://127.0.0.1:{server.server_port}"
    threading.Thread(target=server.serve_forever, daemon=True).start()

    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": client_id, "redirect_uri": redirect, "response_type": "code", "scope": " ".join(SCOPES),
        "access_type": "offline", "prompt": "consent", "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256",
    })
    print("\nOpening Google sign-in. Sign in with the account your Fitbit uses.")
    print(f"If no browser opens, visit:\n{url}\n")
    webbrowser.open(url)
    done.wait()
    server.shutdown()
    if got.get("error"):
        raise SystemExit(f"Google said: {got['error']}")
    if got.get("state") != state:
        raise SystemExit("The sign-in reply didn't match this request. Run the script again.")

    tokens = post_form(TOKEN_URL, {"client_id": client_id, "client_secret": client_secret, "code": got["code"],
                                   "code_verifier": verifier, "grant_type": "authorization_code", "redirect_uri": redirect})
    if "refresh_token" not in tokens:
        raise SystemExit("Google didn't return a long-lived sign-in. Remove the app at myaccount.google.com/permissions and try again.")
    granted = set(tokens.get("scope", "").split())
    missing = [s.rsplit(".", 2)[-2] for s in SCOPES if s not in granted]
    if missing:
        print(f"Note: these permissions weren't granted, so that data will be skipped: {', '.join(missing)}")
    # Check the sign-in can actually read data before handing it over.
    try:
        api(tokens["access_token"], "steps/dataPoints", query={"pageSize": 1})
        print("Checked: Google Health data is readable.")
    except Exception as err:
        print(f"Signed in, but reading steps failed ({err}). The token may still work for other data.")
    print(f"\nSigned in. Save this line as the GitHub secret HEALTH_TOKEN_{who}:\n")
    print(tokens["refresh_token"])


if __name__ == "__main__":
    main()
