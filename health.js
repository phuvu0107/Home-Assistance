// Fitbit data from the Google Health API, read right in the browser.
//
// Each person taps "Connect" and signs in with the Google account their Fitbit uses. Google
// hands this page a short-lived pass (about an hour) that can only read health data; it is kept
// in this tab only and never saved. The daily numbers it reads are what the dashboard keeps.

import CLIENT_ID from './health-config.js';

const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
].join(' ');
const API = 'https://health.googleapis.com/v4/users/me/dataTypes';
const DAYS = 30;

export const healthAvailable = () => !!(CLIENT_ID || window.HOME_HEALTH_BACKEND);

let gisP = null;
// Google's sign-in library. Loaded ahead of time so a tap can open the sign-in popup right away
// (browsers block popups that open after a delay).
export function preloadGoogle() {
  if (!healthAvailable() || window.HOME_HEALTH_BACKEND) return Promise.resolve();
  gisP ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => { gisP = null; reject(new Error("Google sign-in couldn't load. Check the connection.")); };
    document.head.append(s);
  });
  return gisP;
}

// Opens Google's sign-in. Call it straight from a tap. Resolves with { token, exp }.
// `again` skips the account picker for someone who already connected.
export function signIn({ again = false } = {}) {
  if (window.HOME_HEALTH_BACKEND) return window.HOME_HEALTH_BACKEND.signIn();
  const oauth = window.google?.accounts?.oauth2;
  if (!oauth) return preloadGoogle().then(() => Promise.reject(new Error('Google sign-in is ready now. Tap Connect again.')));
  return new Promise((resolve, reject) => {
    oauth.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (r) => {
        if (r.error) { reject(new Error(r.error_description || r.error)); return; }
        if (!oauth.hasGrantedAnyScope(r, ...SCOPES.split(' '))) { reject(new Error('No health data was shared. Tick the boxes on Google’s screen and try again.')); return; }
        resolve({ token: r.access_token, exp: Date.now() + (Number(r.expires_in) - 60) * 1000 });
      },
      error_callback: (e) => reject(new Error(e?.type === 'popup_closed' ? 'Sign-in was closed before it finished.' : "Google sign-in didn't open. Allow pop-ups for this site and try again.")),
    }).requestAccessToken({ prompt: again ? '' : 'select_account' });
  });
}

export function signOut(token) {
  try { window.google?.accounts?.oauth2?.revoke(token, () => {}); } catch { /* ignore */ }
}

/* ---------- Reading data ---------- */
export class SignInExpired extends Error {}

async function call(token, path, body, query) {
  const url = `${API}/${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new SignInExpired('Sign-in expired');
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error?.message || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const civil = (d) => ({ date: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }, time: { hours: 0 } });
const dayOf = (c) => `${c.date.year}-${String(c.date.month).padStart(2, '0')}-${String(c.date.day).padStart(2, '0')}`;

async function listAll(token, kind, filter) {
  const points = [];
  let pageToken;
  do {
    const r = await call(token, `${kind}/dataPoints`, null, { filter, pageSize: 25, ...(pageToken ? { pageToken } : {}) });
    points.push(...(r.dataPoints || []));
    pageToken = r.nextPageToken;
  } while (pageToken && points.length < 500);
  return points;
}

// The last 30 days, keyed by date:
// { steps, km, azm, rhr, kg, sleep: [asleep, deep, light, rem, awake] (minutes) }.
// Anything that can't be read is skipped, so one missing permission doesn't hide the rest.
export async function readDays(token) {
  const days = {};
  const skipped = [];
  const put = (d, k, v) => { (days[d] ||= {})[k] = v; };
  const end = new Date(); end.setDate(end.getDate() + 1);
  const start = new Date(end); start.setDate(start.getDate() - DAYS);
  const range = { start: civil(start), end: civil(end) };

  const rollups = [
    ['steps', 'steps', 'steps', (v) => Number(v.countSum || 0)],
    ['distance', 'distance', 'km', (v) => Math.round(Number(v.millimetersSum || 0) / 1e4) / 100],
    ['active-zone-minutes', 'activeZoneMinutes', 'azm', (v) => Object.values(v).reduce((a, b) => a + Number(b || 0), 0)],
    ['weight', 'weight', 'kg', (v) => Math.round(v.weightGramsAvg / 10) / 100],
  ];
  const tries = rollups.map(async ([kind, field, key, read]) => {
    const r = await call(token, `${kind}/dataPoints:dailyRollUp`, { range, windowSizeDays: 1, pageSize: 100 });
    for (const p of r.rollupDataPoints || []) if (p[field]) put(dayOf(p.civilStartTime), key, read(p[field]));
  });
  tries.push((async () => {
    for (const p of await listAll(token, 'daily-resting-heart-rate', `daily_resting_heart_rate.date >= "${isoDay(start)}"`)) {
      const r = p.dailyRestingHeartRate;
      if (r?.date && r.beatsPerMinute) put(dayOf({ date: r.date }), 'rhr', Number(r.beatsPerMinute));
    }
  })());
  tries.push((async () => {
    for (const p of await listAll(token, 'sleep', `sleep.interval.civil_end_time >= "${isoDay(start)}"`)) {
      const s = p.sleep || {};
      const woke = s.interval?.civilEndTime;
      const sum = s.summary || {};
      if (!woke || !Number(sum.minutesAsleep)) continue;
      const stage = Object.fromEntries((sum.stagesSummary || []).map((x) => [x.type, Number(x.minutes || 0)]));
      const d = dayOf(woke);
      const cur = days[d]?.sleep || [0, 0, 0, 0, 0];
      // Naps on the same day add up.
      const add = [Number(sum.minutesAsleep), stage.DEEP || 0, stage.LIGHT || 0, stage.REM || 0, Number(sum.minutesAwake || 0)];
      put(d, 'sleep', cur.map((v, i) => v + add[i]));
    }
  })());
  const names = [...rollups.map(([k]) => k), 'resting heart rate', 'sleep'];
  const results = await Promise.allSettled(tries);
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      if (r.reason instanceof SignInExpired) throw r.reason;
      skipped.push(names[i]);
    }
  });
  if (skipped.length === names.length) throw new Error(results[0].reason?.message || "Couldn't read any Fitbit data.");
  return { days, skipped };
}
