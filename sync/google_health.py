"""Small Google Health API client (standard library only), shared by the sign-in and sync scripts."""

import json
import urllib.error
import urllib.parse
import urllib.request

TOKEN_URL = "https://oauth2.googleapis.com/token"
API = "https://health.googleapis.com/v4/users/me/dataTypes"
SCOPES = [
    "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
    "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
    "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
]


class SignInExpired(Exception):
    """Google refused the saved sign-in (revoked, or older than 7 days while the app is in Testing)."""


def _call(req: urllib.request.Request) -> dict:
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as err:
        body = err.read().decode(errors="replace")
        if err.code in (400, 401) and "invalid_grant" in body:
            raise SignInExpired() from None
        # Keep only Google's short message: the body never holds health data, but stay brief.
        try:
            msg = json.loads(body)["error"]
            msg = msg.get("message", msg) if isinstance(msg, dict) else msg
        except Exception:
            msg = body[:200]
        raise RuntimeError(f"HTTP {err.code}: {msg}") from None


def post_form(url: str, fields: dict) -> dict:
    return _call(urllib.request.Request(url, data=urllib.parse.urlencode(fields).encode(), method="POST"))


def access_token(client_id: str, client_secret: str, refresh_token: str) -> str:
    return post_form(TOKEN_URL, {"client_id": client_id, "client_secret": client_secret,
                                 "refresh_token": refresh_token, "grant_type": "refresh_token"})["access_token"]


def api(token: str, path: str, body: dict | None = None, query: dict | None = None) -> dict:
    url = f"{API}/{path}" + (f"?{urllib.parse.urlencode(query)}" if query else "")
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 method="POST" if body is not None else "GET",
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    return _call(req)
