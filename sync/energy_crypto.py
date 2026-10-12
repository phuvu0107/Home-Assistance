"""Encrypts the energy file so the public site never shows readable usage.

The dashboard decrypts it in the browser with the same passphrase
(PBKDF2-SHA256 key, AES-GCM), see `decryptEnergy` in app.js.
"""

import base64
import json
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ITERATIONS = 310_000


def _key(passphrase: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS)
    return kdf.derive(passphrase.encode())


def encrypt(data: dict, passphrase: str) -> dict:
    salt, iv = os.urandom(16), os.urandom(12)
    sealed = AESGCM(_key(passphrase, salt)).encrypt(iv, json.dumps(data, separators=(",", ":")).encode(), None)
    b64 = lambda b: base64.b64encode(b).decode()
    return {"v": 1, "iter": ITERATIONS, "salt": b64(salt), "iv": b64(iv), "data": b64(sealed)}


def decrypt(box: dict, passphrase: str) -> dict:
    raw = lambda k: base64.b64decode(box[k])
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=raw("salt"), iterations=box["iter"]).derive(passphrase.encode())
    return json.loads(AESGCM(key).decrypt(raw("iv"), raw("data"), None))
