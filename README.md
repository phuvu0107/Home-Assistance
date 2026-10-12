# Home Assistant dashboard

A touch-friendly home dashboard for a shared screen at home: a tablet on the fridge, a laptop on the counter, a wall-mounted display or just your phone. It's a static web app (no build step) hosted on GitHub Pages, with optional encrypted sync between devices, and it can be installed as a full-screen app from Chrome, Edge or Safari.

**Live site:** https://phuvu0107.github.io/Home-Assistance/

![Home page](docs/screenshots/home.png)

*Screenshots use sample events, tasks, weather and energy data.*

## Features

### Home
A greeting for Phu and Nhi by time of day, live weather (now, the next hours and 7 days), what's coming up on the calendar, each person's open tasks and a short energy summary. The sun moves across the greeting panel from the city's real sunrise to sunset, and the moon and stars come out after dark.

| Day | Night (auto dark theme) |
| --- | --- |
| ![Home by day](docs/screenshots/home.png) | ![Home at night](docs/screenshots/home-night.png) |

### Calendar
Week view (a time grid) and Month view, switched with a toggle. Each event shows who it's for, its start time and its title. The + button adds an event, tapping an event edits or deletes it, and tapping an empty slot in Week view adds one at that hour. Turn on **Important** in an event's sheet to give it a red Important tag everywhere it shows up.

| Week | Month |
| --- | --- |
| ![Calendar week view](docs/screenshots/calendar-week.png) | ![Calendar month view](docs/screenshots/calendar-month.png) |

### Tasks
A column each for Phu and Nhi with done counts and stars. Tasks repeat daily, weekly or once, and daily and weekly tasks reset on their own. Tap a task to edit who it's for, how often it repeats and how many stars it's worth. Tasks can be marked **Important** too, which turns them red with the same tag.

| Board | Editing a task |
| --- | --- |
| ![Tasks board](docs/screenshots/tasks.png) | ![Edit task sheet](docs/screenshots/task-sheet.png) |

### Piggy Bank
Shared expenses, one month at a time (the 1st through the last day). Log the day, what it was, the amount and who paid. The page shows the month's total, what each person paid and a daily average, with a log grouped by day and a month-by-month table. Turn on **Show split** to see each person's half of the shared costs and who owes whom. Expenses can be marked as personal so they stay out of the split.

![Piggy Bank page](docs/screenshots/piggy.png)

### Energy
PG&E use and cost over 30 days, 90 days or 12 months, split into electric and gas, with a month-by-month table. Data syncs every morning (see [PG&E energy sync](#pge-energy-sync)), and the page says plainly when it isn't syncing.

![Energy page](docs/screenshots/energy.png)

### Settings
Sync across devices, weather city, °F/°C, light/dark/auto theme, 24-hour clock, keep screen on, and the PG&E sync passphrase with one-time sign-in steps.

![Settings page](docs/screenshots/settings.png)

### Works on any screen
The layout adapts from a wide display down to a phone. On touch screens you can swipe left or right to move between tabs, with the page following your finger. Motion is turned off when the device asks for reduced motion.

<img src="docs/screenshots/phone.png" alt="Dashboard on a phone" width="320">

Phu's and Nhi's avatars live in `avatars/` as SVG files. Weather comes from [Open-Meteo](https://open-meteo.com) (free, no API key). Display settings are saved in the browser on each device; events, tasks and expenses are shared across devices once [sync](#sync-across-devices) is on.

## Set up on your device

1. Open the live site in your browser.
2. Install it as an app so it opens full screen:
   - **Chrome or Edge** (Windows, Mac, Android, ChromeOS): click the install icon in the address bar, or open the browser menu and choose **Install** (Edge: **Apps › Install this site as an app**).
   - **Safari on iPhone or iPad**: tap **Share › Add to Home Screen**.
   - **Safari on Mac**: choose **File › Add to Dock**.
3. In **Settings** inside the dashboard, set the weather city and turn on **Keep screen on**.
4. Optional, for an always-on screen, stop the device itself from sleeping while it's plugged in:
   - **Windows**: Settings › System › Power & battery › set the screen to never turn off when plugged in, and add the app to Startup apps.
   - **iPad**: Settings › Display & Brightness › Auto-Lock › Never.
   - **Android**: Settings › Display › Screen timeout, or Developer options › Stay awake.
   - **Mac**: System Settings › Lock Screen › turn the display off: Never (when on power adapter).

The app keeps working offline, and weather resumes when the connection is back. Events and tasks are stored per device, so each screen keeps its own list.

## PG&E energy sync

The dashboard never signs in to PG&E itself. The Pages workflow does it every morning (about 7 AM Pacific): `sync/pge_sync.py` signs in with the [opower](https://github.com/tronikos/opower) library, reads daily usage and cost for the electric and gas meters, and publishes `data/energy.enc.json` with the site. That file is encrypted (PBKDF2 + AES-GCM) with a passphrase you choose, so the public site only shows scrambled data. Each device unlocks it with the same passphrase.

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
4. On each device running the dashboard, open **Settings > PG&E energy**, type the same passphrase and tap **Connect**.

You can also load a PG&E **Download My Data** CSV in the same Settings card instead.

## Sync across devices

Events, tasks, stars and expenses can be shared by every device in the house through a free [Firebase](https://firebase.google.com) Firestore database. Data is encrypted in the browser with a household passphrase before it's sent, so the database only stores scrambled data, and the record's name is a hash of the passphrase.

One-time setup:
1. Create a Firebase project, then add a Firestore database in production mode.
2. Replace the Firestore rules with:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{db}/documents {
       match /households/{id} {
         allow get, create, update: if id.size() == 64;
       }
     }
   }
   ```
3. Register a web app in Project settings and paste its `firebaseConfig` into `sync-config.js`.
4. On the first device, open **Settings › Sync across devices**, type a passphrase and tap **Start a new household**. On every other device, type the same passphrase. Joining replaces that device's events, tasks and expenses with the shared ones.

Changes show up on the other screens within a second or two. Edits made offline are kept and sync when the connection comes back, and two people editing at once both keep their changes.

## Deploying

Every push to `main` deploys through `.github/workflows/pages.yml`, and it also runs every morning to refresh the PG&E data. One-time setup: in the repo go to **Settings > Pages** and set **Source** to **GitHub Actions**.

## Running locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Files

- `index.html` – page shell (greeting, tabs)
- `styles.css` – design tokens, light and dark themes, layout and motion
- `app.js` – state, weather, views and actions
- `icons.js` – inline SVG icon set
- `sync.js`, `sync-config.js` – encrypted household sync (Firebase Firestore)
- `avatars/` – Phu's and Nhi's avatars
- `sw.js`, `manifest.webmanifest`, `icons/` – installable PWA and offline cache
- `sync/` – the daily PG&E sync, the one-time sign-in script and the encryption helper
- `docs/screenshots/` – the README screenshots (sample data)
