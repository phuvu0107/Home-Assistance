# Home Assistant dashboard

A touch-friendly home dashboard built for a Surface Pro mounted on the fridge. It is a static web app (no build step, no backend) hosted on GitHub Pages and installable as a full-screen app from Edge.

**Live site:** https://phuvu0107.github.io/Home-Assistance/

## What's real and what's demo

| Panel | Data |
| --- | --- |
| Clock, date, greeting | Real |
| Weather (current, next hours, 7-day) | Real, from [Open-Meteo](https://open-meteo.com) (free, no API key) |
| Notes, calendar events, settings | Real, saved in the browser on that device |
| Lights, thermostat, security, locks, garage, energy, automations | Demo data until a smart-home hub (for example Home Assistant) is connected |

## Set up on the Surface Pro

1. Open the live site in Microsoft Edge.
2. Click the **App available / Install** icon in the address bar (or **⋯ > Apps > Install this site as an app**).
3. Open the installed app. It launches full screen in landscape.
4. In **Settings** inside the dashboard, set the name for the greeting and the weather city, and leave **Keep screen on** enabled.
5. Optional, in Windows: Settings > System > Power & battery, set "Turn off my screen" to Never while plugged in, and add the app to Startup apps so it opens after a reboot.

The app keeps working offline (weather resumes when the connection is back).

## Deploying

Every push to `main` deploys through `.github/workflows/pages.yml`. One-time setup: in the repo go to **Settings > Pages** and set **Source** to **GitHub Actions**.

## Running locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Files

- `index.html` – page shell (sidebar, top bar, hero, tabs)
- `styles.css` – design tokens, light and dark themes, layout
- `app.js` – state, weather, views and actions
- `icons.js` – inline SVG icon set
- `sw.js`, `manifest.webmanifest`, `icons/` – installable PWA and offline cache
