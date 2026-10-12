# Home Assistant dashboard

A touch-friendly home dashboard built for a Surface Pro mounted on the fridge. It is a static web app (no build step, no backend) hosted on GitHub Pages and installable as a full-screen app from Edge.

**Live site:** https://phuvu0107.github.io/Home-Assistance/

## Pages

- **Home**: "Good morning/afternoon/evening, Phu and Nhi", live weather (now, next hours, 7 days), upcoming events and each person's open tasks, all on one screen.
- **Calendar**: Week view (events by day and time) and Month view, switched with the toggle. Each event shows who it's for, its start time and its title. The + button adds an event; tap an event to edit or delete it, or tap an empty slot in Week view to add one at that hour.
- **Tasks**: a column each for Phu and Nhi with done counts and stars. Tasks repeat daily, weekly or once, and daily and weekly tasks reset on their own.
- **Energy**: PG&E use and cost over 30 days, 90 days or 12 months, split into electric and gas, plus a month-by-month table. Home shows a short summary.
- **Settings**: weather city, °F/°C, theme, 24-hour clock, keep screen on, and the PG&E sync passphrase.

Phu's and Nhi's avatars live in `avatars/` as SVG files.

Weather comes from [Open-Meteo](https://open-meteo.com) (free, no API key). Events, tasks and settings are saved in the browser on the device.

## Set up on the Surface Pro

1. Open the live site in Microsoft Edge.
2. Click the **App available / Install** icon in the address bar (or **⋯ > Apps > Install this site as an app**).
3. Open the installed app. It launches full screen in landscape.
4. In **Settings** inside the dashboard, set the weather city and leave **Keep screen on** enabled.
5. Optional, in Windows: Settings > System > Power & battery, set "Turn off my screen" to Never while plugged in, and add the app to Startup apps so it opens after a reboot.

The app keeps working offline (weather resumes when the connection is back).

## PG&E energy sync

The dashboard never signs in to PG&E itself. The Pages workflow does it every morning (about 7 AM Pacific): `sync/pge_sync.py` signs in with the [opower](https://github.com/tronikos/opower) library, reads daily usage and cost for the electric and gas meters, and publishes `data/energy.enc.json` with the site. That file is encrypted (PBKDF2 + AES-GCM) with a passphrase you choose, so the public site only shows scrambled data. The Surface unlocks it with the same passphrase.

Your PG&E username and password live only in GitHub's encrypted Actions secrets. They are not in the code, the site or the browser.

One-time setup:

1. In the repo, open **Settings > Secrets and variables > Actions** and add these secrets:
   - `PGE_USERNAME` and `PGE_PASSWORD`: your PG&E sign-in.
   - `ENERGY_PASSPHRASE`: any phrase you make up.
2. PG&E sends a code by email or text the first time a new device signs in. Run this once on your computer, enter the code, and save the line it prints as the `PGE_LOGIN_DATA` secret:
   ```sh
   pip install -r sync/requirements.txt
   python3 sync/pge_pair.py
   ```
   If PG&E later asks for a code again, the dashboard shows "Not syncing". Run the script again and update the secret.
3. In the **Actions** tab, run **Deploy to GitHub Pages** once (**Run workflow**).
4. On the Surface, open **Settings > PG&E energy**, type the same passphrase and tap **Connect**.

You can also load a PG&E **Download My Data** CSV in the same Settings card instead.

## Deploying

Every push to `main` deploys through `.github/workflows/pages.yml`, and it also runs every morning to refresh the PG&E data. One-time setup: in the repo go to **Settings > Pages** and set **Source** to **GitHub Actions**.

## Running locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Files

- `index.html` – page shell (top bar, hero, tabs)
- `styles.css` – design tokens, light and dark themes, layout
- `app.js` – state, weather, views and actions
- `icons.js` – inline SVG icon set
- `avatars/` – Phu's and Nhi's avatars
- `sw.js`, `manifest.webmanifest`, `icons/` – installable PWA and offline cache
- `sync/` – the daily PG&E sync, the one-time sign-in script and the encryption helper
