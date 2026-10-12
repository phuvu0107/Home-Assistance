"""Write the site's sync-config.js from the FIREBASE_CONFIG secret at deploy time.

The secret can be the `firebaseConfig = { ... }` block exactly as the Firebase
console shows it, or plain JSON. Keeping it in a secret keeps the key out of git.
"""

import json
import os
import re
import sys

raw = os.environ.get("FIREBASE_CONFIG", "").strip()
if not raw:
    sys.exit(0)  # no secret: the repo's sync-config.js (sync off) is published as is
body = raw[raw.index("{"): raw.rindex("}") + 1]
body = re.sub(r"//[^\n]*", "", body)                     # comments
body = re.sub(r"([{,]\s*)([A-Za-z_]\w*)\s*:", r'\1"\2":', body)  # bare keys -> "keys"
body = re.sub(r",\s*}", "}", body)                        # trailing comma
config = json.loads(body)
if not config.get("apiKey") or not config.get("projectId"):
    sys.exit("FIREBASE_CONFIG is missing apiKey or projectId")
with open(sys.argv[1], "w") as f:
    f.write(f"export default {json.dumps(config)};\n")
print(f"Sync config written for project {config['projectId']}")
