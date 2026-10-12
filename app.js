import { icon, hydrateIcons } from './icons.js';
import { createSync, syncAvailable } from './sync.js';
import { healthAvailable, preloadGoogle, readDays, signIn, signOut, SignInExpired } from './health.js';

/* =========================================================
   State (saved in this browser's localStorage)
   ========================================================= */
const STORE_KEY = 'home-dashboard.v2';
const WEATHER_KEY = 'home-dashboard.weather.v1';
const ENERGY_KEY = 'home-dashboard.energy.v1';

// The two people in the household. `color` picks one of the existing c-* color families.
const USERS = [
  { id: 'phu', name: 'Phu', color: 'blue', avatar: 'avatars/phu.svg' },
  { id: 'nhi', name: 'Nhi', color: 'rose', avatar: 'avatars/nhi.svg' },
];
const userOf = (id) => USERS.find((u) => u.id === id);

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function defaultState() {
  const today = new Date();
  return {
    settings: {
      place: { name: 'Palo Alto', lat: 37.4419, lon: -122.143 },
      unit: 'F',
      theme: 'auto',
      wakeLock: true,
      clock24: false,
      calView: 'week',
    },
    events: [
      { id: 'e1', title: 'Soccer practice', date: isoDay(today), time: '17:30', end: '19:00', who: 'phu' },
      { id: 'e2', title: 'Grocery run', date: isoDay(addDays(today, 1)), time: '10:00', end: '11:00', who: 'both' },
      { id: 'e3', title: 'Dentist', date: isoDay(addDays(today, 3)), time: '16:30', end: '17:30', who: 'nhi' },
      { id: 'e4', title: 'Date night', date: isoDay(addDays(today, 4)), time: '19:00', end: '21:00', who: 'both' },
    ],
    tasks: [
      { id: 't1', title: 'Take out trash', who: 'phu', repeat: 'daily', stars: 5, doneOn: '' },
      { id: 't2', title: 'Load dishwasher', who: 'phu', repeat: 'daily', stars: 5, doneOn: '' },
      { id: 't3', title: 'Mow the lawn', who: 'phu', repeat: 'weekly', stars: 10, doneOn: '' },
      { id: 't4', title: 'Water plants', who: 'nhi', repeat: 'daily', stars: 5, doneOn: '' },
      { id: 't5', title: 'Laundry', who: 'nhi', repeat: 'weekly', stars: 10, doneOn: '' },
      { id: 't6', title: 'Book dentist follow-up', who: 'nhi', repeat: 'once', stars: 3, doneOn: '' },
    ],
    stars: { phu: 0, nhi: 0 },
    expenses: [],
    health: {},
  };
}

function loadState() {
  const base = defaultState();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && typeof saved === 'object') {
      return { ...base, ...saved, settings: { ...base.settings, ...saved.settings } };
    }
  } catch { /* storage unavailable or corrupt: start fresh */ }
  return base;
}

let state = loadState();
let onSaved = () => {}; // household sync hooks in here
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  onSaved();
}

/* =========================================================
   Helpers
   ========================================================= */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function fmtTime(date, withMinutes = true) {
  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: withMinutes ? '2-digit' : undefined,
    hour12: !state.settings.clock24,
  });
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 2200);
}

function partOfDay(h) {
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'day';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

/* =========================================================
   Theme, clock and hero
   ========================================================= */
function applyTheme() {
  const { theme } = state.settings;
  const h = new Date().getHours();
  const dark = theme === 'dark' || (theme === 'auto' && (h >= 21 || h < 6));
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('meta[name="theme-color"]').content = dark ? '#12151c' : '#f6f3ee';
}

function tickClock() {
  const now = new Date();
  const h = now.getHours();
  const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  $('#greeting').textContent = `${greet}, ${USERS.map((u) => u.name).join(' and ')}`;
  $('#date').textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  $('#clock').textContent = fmtTime(now);
  updateSky(now.getTime());
}

/* ---------- Sun and moon in the greeting panel ---------- */
// Today's sunrise and sunset (epoch ms) for the weather city, with a 6:30/18:30 local guess until weather loads.
function sunToday() {
  if (weather?.sun?.length && weatherValid()) {
    const today = weather.sun.find((d) => d.date === isoDay(new Date())) || weather.sun[0];
    const next = weather.sun[weather.sun.indexOf(today) + 1];
    return { rise: today.rise, set: today.set, nextRise: next ? next.rise : today.rise + 864e5 };
  }
  const d = new Date();
  const at = (h, m) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  return { rise: at(6, 30), set: at(18, 30), nextRise: at(6, 30) + 864e5 };
}

// Where the sun (between sunrise and sunset) or moon (between sunset and the next sunrise) sits on its arc, 0 to 1.
function skyState(now) {
  const { rise, set, nextRise } = sunToday();
  if (now >= rise && now < set) return { kind: 'sun', p: (now - rise) / (set - rise), rise, set };
  const start = now >= set ? set : set - 864e5;
  const end = now >= set ? nextRise : rise;
  return { kind: 'moon', p: (now - start) / (end - start), rise, set };
}

let skyReady = false; // the first placement waits a moment so the sun or moon visibly rises into place
function updateSky(now) {
  const orb = $('#orb');
  const hero = $('#hero');
  const sky = skyState(now);
  const p = Math.min(1, Math.max(0, sky.p));
  // Arc across the right part of the panel; it starts and ends just below the hills.
  const x = 30 + p * 64;
  const y = 92 - Math.sin(p * Math.PI) * 78;
  if (skyReady) {
    orb.style.left = `${x.toFixed(2)}%`;
    orb.style.top = `${y.toFixed(2)}%`;
  }
  orb.dataset.kind = sky.kind;
  // Sky color follows the real sun: an hour of dawn, daytime, ninety minutes of dusk, then night.
  let pod = 'night';
  if (sky.kind === 'sun') pod = now - sky.rise < 36e5 ? 'morning' : sky.set - now < 54e5 ? 'evening' : 'day';
  if (document.documentElement.dataset.theme === 'dark') pod = 'night';
  if (!hero.classList.contains(pod)) {
    hero.classList.remove('morning', 'day', 'evening', 'night');
    hero.classList.add(pod);
  }
  const tod = $('#tod-icon');
  if (tod.dataset.v !== sky.kind) {
    tod.innerHTML = icon(sky.kind);
    tod.dataset.v = sky.kind;
  }
  const label = sky.kind === 'sun'
    ? `Sunset at ${fmtTime(new Date(sky.set))}`
    : `Sunrise at ${fmtTime(new Date(now < sky.rise ? sky.rise : sunToday().nextRise))}`;
  if ($('#sun-note').textContent !== label) $('#sun-note').textContent = label;
}

/* =========================================================
   Weather (Open-Meteo, no API key)
   ========================================================= */
let weather = null;
try { weather = JSON.parse(localStorage.getItem(WEATHER_KEY)); } catch { weather = null; }

function wmo(code, isDay = 1) {
  if (code === 0) return { label: 'Clear', icon: isDay ? 'sun' : 'moon' };
  if (code <= 2) return { label: code === 1 ? 'Mostly clear' : 'Partly cloudy', icon: isDay ? 'partly' : 'moon' };
  if (code === 3) return { label: 'Cloudy', icon: 'cloud' };
  if (code === 45 || code === 48) return { label: 'Foggy', icon: 'fog' };
  if (code >= 51 && code <= 57) return { label: 'Drizzle', icon: 'rain' };
  if (code >= 61 && code <= 67) return { label: 'Rain', icon: 'rain' };
  if (code >= 71 && code <= 77) return { label: 'Snow', icon: 'snow' };
  if (code >= 80 && code <= 82) return { label: 'Showers', icon: 'rain' };
  if (code >= 85 && code <= 86) return { label: 'Snow showers', icon: 'snow' };
  if (code >= 95) return { label: 'Thunderstorm', icon: 'storm' };
  return { label: '—', icon: 'cloud' };
}

async function fetchWeather() {
  const { lat, lon } = state.settings.place;
  const unit = state.settings.unit === 'C' ? 'celsius' : 'fahrenheit';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,weather_code,is_day'
    + '&hourly=temperature_2m,weather_code,is_day'
    + '&daily=temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset'
    + `&temperature_unit=${unit}&timezone=auto&forecast_days=7`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    const cur = d.current;
    const curHour = cur.time.slice(0, 13); // "YYYY-MM-DDTHH"
    let start = d.hourly.time.findIndex((t) => t.slice(0, 13) === curHour);
    if (start < 0) start = 0;
    const hours = [];
    for (let i = start + 1; i < start + 5 && i < d.hourly.time.length; i++) {
      hours.push({ time: d.hourly.time[i], temp: d.hourly.temperature_2m[i], code: d.hourly.weather_code[i], isDay: d.hourly.is_day[i] });
    }
    weather = {
      fetchedAt: Date.now(),
      unit: state.settings.unit,
      placeKey: `${lat},${lon}`,
      temp: cur.temperature_2m,
      code: cur.weather_code,
      isDay: cur.is_day,
      hi: d.daily.temperature_2m_max[0],
      lo: d.daily.temperature_2m_min[0],
      hours,
      days: d.daily.time.map((t, i) => ({ date: t, hi: d.daily.temperature_2m_max[i], lo: d.daily.temperature_2m_min[i], code: d.daily.weather_code[i] })),
      // Open-Meteo gives local times for the city; convert with its UTC offset so the sun follows that city's clock.
      sun: d.daily.time.map((t, i) => ({
        date: t,
        rise: Date.parse(`${d.daily.sunrise[i]}Z`) - d.utc_offset_seconds * 1000,
        set: Date.parse(`${d.daily.sunset[i]}Z`) - d.utc_offset_seconds * 1000,
      })),
    };
    try { localStorage.setItem(WEATHER_KEY, JSON.stringify(weather)); } catch { /* ignore */ }
  } catch (err) {
    console.warn('Weather fetch failed', err);
  }
  tickClock();
  if (currentRoute() === 'home') renderView();
}

/* =========================================================
   Energy (PG&E Green Button CSV, loaded by hand in Settings)
   ========================================================= */
// Shape: { electric: { 'YYYY-MM-DD': [kWh, cost] }, gas: { 'YYYY-MM-DD': [therms, cost] } }
let energy = null;
try { energy = JSON.parse(localStorage.getItem(ENERGY_KEY)); } catch { energy = null; }
const saveEnergy = () => { try { localStorage.setItem(ENERGY_KEY, JSON.stringify(energy)); } catch { /* ignore */ } };

const csvCells = (line) => (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim());
const money = (v) => Number(String(v || '').replace(/[$,\s]/g, '')) || 0;

// Reads a PG&E "Download My Data" CSV (usage or billing export) into daily totals.
// Returns the number of days read, or 0 when the file isn't in that format.
function importGreenButton(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^"?TYPE"?,/i.test(l));
  if (at < 0) return 0;
  const head = csvCells(lines[at]).map((h) => h.toUpperCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  const iType = col(/^TYPE$/); const iDate = col(/^(START )?DATE$/); const iUse = col(/^USAGE/);
  const iUnit = col(/^UNITS$/); const iCost = col(/^COST$/);
  if (iDate < 0 || iUse < 0) return 0;
  energy = energy || { electric: {}, gas: {} };
  const days = new Set();
  const fresh = {};
  for (const line of lines.slice(at + 1)) {
    const c = csvCells(line);
    if (c.length <= iUse || !/^\d{4}-\d{2}-\d{2}$/.test(c[iDate])) continue;
    const label = `${c[iType] || ''} ${iUnit >= 0 ? c[iUnit] : ''} ${head[iUse]}`.toLowerCase();
    const kind = /gas|therm/.test(label) ? 'gas' : 'electric';
    const key = `${kind}|${c[iDate]}`;
    // A day in a new file replaces that day from older files instead of adding to it.
    if (!fresh[key]) { fresh[key] = true; energy[kind][c[iDate]] = [0, 0]; }
    const d = energy[kind][c[iDate]];
    d[0] += Number(c[iUse]) || 0;
    d[1] += iCost >= 0 ? money(c[iCost]) : 0;
    days.add(c[iDate]);
  }
  if (!days.size) return 0;
  energy.loadedAt = Date.now();
  saveEnergy();
  return days.size;
}

const energyDays = () => [...new Set([...Object.keys(energy?.electric || {}), ...Object.keys(energy?.gas || {})])].sort();
const dayTotal = (iso) => {
  const e = energy.electric[iso] || [0, 0]; const g = energy.gas[iso] || [0, 0];
  return { kwh: e[0], therms: g[0], eCost: e[1], gCost: g[1], cost: e[1] + g[1] };
};
const sumDays = (list) => list.map(dayTotal).reduce((a, d) => ({ kwh: a.kwh + d.kwh, therms: a.therms + d.therms, cost: a.cost + d.cost }), { kwh: 0, therms: 0, cost: 0 });
const fmtMoney = (n) => `$${n.toFixed(n >= 100 ? 0 : 2)}`;
const fmtShort = (iso) => new Date(`${iso}T12:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });

// Auto sync: the Pages workflow publishes data/energy.enc.json every morning
// (see sync/pge_sync.py). The passphrase typed in Settings unlocks it here.
const PASS_KEY = 'home-dashboard.energy-pass.v1';
let energyPass = '';
try { energyPass = localStorage.getItem(PASS_KEY) || ''; } catch { energyPass = ''; }
let energySync = { state: energyPass ? 'checking' : 'off' };

const fromB64 = (v) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
async function decryptEnergy(box, pass) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(box.salt), iterations: box.iter },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function syncEnergy() {
  if (!energyPass) { energySync = { state: 'off' }; return; }
  let box;
  try {
    const res = await fetch('data/energy.enc.json', { cache: 'no-store' });
    if (res.status === 404) { energySync = { state: 'nofile' }; refreshEnergyViews(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    box = await res.json();
  } catch {
    energySync = { state: 'unreachable', at: energy?.syncedAt };
    refreshEnergyViews();
    return;
  }
  try {
    const data = await decryptEnergy(box, energyPass);
    energy = energy || { electric: {}, gas: {} };
    for (const k of ['electric', 'gas']) energy[k] = { ...(energy[k] || {}), ...(data[k] || {}) };
    energy.bills = { ...(energy.bills || {}), ...(data.bills || {}) };
    if (data.forecast) energy.forecast = data.forecast;
    energy.syncedAt = data.syncedAt;
    saveEnergy();
    energySync = { state: Date.now() - data.syncedAt > 36 * 36e5 ? 'stale' : 'ok', at: data.syncedAt };
  } catch {
    energySync = { state: 'badpass' };
  }
  refreshEnergyViews();
}
function refreshEnergyViews() {
  if (['home', 'energy', 'settings'].includes(currentRoute()) && $('#sheet').hidden && !document.activeElement?.matches('input, textarea')) renderView();
}

// One sentence on whether PG&E data is flowing, and what to do if it isn't.
function syncMessage() {
  const at = energySync.at ? ago(energySync.at) : '';
  switch (energySync.state) {
    case 'ok': return { ok: true, text: `Syncing from PG&E every morning. Last update ${at}.` };
    case 'checking': return { ok: true, text: 'Checking for new PG&E data…' };
    case 'stale': return { ok: false, text: `Not syncing. The last PG&E update was ${at}, so the PG&E sign-in may need renewing in Settings.` };
    case 'nofile': return { ok: false, text: "Not syncing. The daily PG&E job hasn't published any data yet. Finish signing in to PG&E in Settings." };
    case 'badpass': return { ok: false, text: "Not syncing. The passphrase on this device doesn't match. Re-enter it in Settings." };
    case 'unreachable': return { ok: false, text: `Can't reach the PG&E data right now${at ? `. Last update ${at}` : ''}. It will try again.` };
    default: return { ok: false, text: 'Not syncing. Sign in to PG&E in Settings to get daily updates.' };
  }
}
// `always` also shows the all-good line; `link` sends a not-syncing banner to Settings.
function syncBanner(always = false, link = true) {
  const m = syncMessage();
  if (m.ok && !always) return '';
  if (m.ok) return `<p class="sync-line">${icon('check')}${m.text}</p>`;
  return link
    ? `<a class="sync-banner" href="#/settings">${icon('zap')}<span>${m.text}</span><b>Settings ${icon('arrowRight')}</b></a>`
    : `<div class="sync-banner">${icon('zap')}<span>${m.text}</span></div>`;
}

// Daily or monthly rows for a range, newest last. Each row: { key, label, kwh, therms, eCost, gCost, cost }
/* PG&E bills every 29 or 30 days, so "this bill" follows the billing cycle, not the calendar month.
   Cycle start dates come from past bills and the current bill's forecast in the synced file. */
const dayAt = (iso) => new Date(`${iso}T12:00`);
const daysIncl = (a, b) => Math.round((dayAt(b) - dayAt(a)) / 864e5) + 1;
function cycleStarts() {
  const s = new Set(Object.keys(energy?.bills || {}));
  if (energy?.forecast?.start) s.add(energy.forecast.start);
  return [...s].sort();
}
// The billing cycle that contains `iso` (today by default), or null before any cycle dates have synced.
function cycleFor(iso = isoDay(new Date())) {
  const starts = cycleStarts();
  const i = starts.filter((d) => d <= iso).length - 1;
  if (i < 0) return null;
  let start = starts[i];
  if (starts[i + 1]) return { start, end: isoDay(addDays(dayAt(starts[i + 1]), -1)), known: true };
  const f = energy.forecast;
  let end = f?.start === start && f.end ? f.end : isoDay(addDays(dayAt(start), 29));
  if (daysIncl(start, end) > 31) end = isoDay(addDays(dayAt(end), -1));
  let known = f?.start === start;
  // The bill closed but the next one hasn't synced yet: assume a 30-day cycle follows.
  while (end < iso) { start = isoDay(addDays(dayAt(end), 1)); end = isoDay(addDays(dayAt(start), 29)); known = false; }
  return { start, end, known };
}
function previousCycle(c) {
  const before = isoDay(addDays(dayAt(c.start), -1));
  const p = cycleFor(before);
  return p && p.start < c.start ? { ...p, end: before } : { start: isoDay(addDays(dayAt(before), -29)), end: before, known: false };
}
const cycleRange = (c) => `${fmtShort(c.start)} – ${fmtShort(c.end)}`;
// PG&E's projection for the current bill, when the forecast matches this cycle.
function billForecast(c) {
  const f = energy?.forecast;
  if (!f || !c || f.start !== c.start) return null;
  const sum = (i) => (f.electric?.[i] || 0) + (f.gas?.[i] || 0);
  return { toDate: sum(0), projected: sum(1), typical: sum(2) };
}
const billed = (start) => { const b = energy?.bills?.[start]; return b ? (b.electric?.[1] || 0) + (b.gas?.[1] || 0) : null; };

function energyRows(range) {
  const all = energyDays();
  if (!all.length) return [];
  const last = new Date(`${all[all.length - 1]}T12:00`);
  if (range === 'cycle' || range === 'last') {
    let c = cycleFor();
    if (!c) return energyRows('30');
    if (range === 'last') c = previousCycle(c);
    return Array.from({ length: daysIncl(c.start, c.end) }, (_, i) => {
      const key = isoDay(addDays(dayAt(c.start), i));
      return { key, label: fmtShort(key), days: all.includes(key) ? 1 : 0, ...dayTotal(key) };
    });
  }
  if (range === '12m') {
    return Array.from({ length: 12 }, (_, i) => {
      const m = new Date(last.getFullYear(), last.getMonth() - 11 + i, 1);
      const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
      const days = all.filter((d) => d.startsWith(key)).map(dayTotal);
      const t = days.reduce((a, d) => ({ kwh: a.kwh + d.kwh, therms: a.therms + d.therms, eCost: a.eCost + d.eCost, gCost: a.gCost + d.gCost }), { kwh: 0, therms: 0, eCost: 0, gCost: 0 });
      return { key, label: m.toLocaleDateString([], { month: 'short' }), days: days.length, ...t, cost: t.eCost + t.gCost };
    });
  }
  const n = Number(range) || 30;
  return Array.from({ length: n }, (_, i) => {
    const key = isoDay(addDays(last, i - n + 1));
    return { key, label: fmtShort(key), days: all.includes(key) ? 1 : 0, ...dayTotal(key) };
  });
}

function energyChart(rows, height = 130) {
  const hasCost = rows.some((r) => r.cost > 0);
  const val = (r) => (hasCost ? r.cost : r.kwh);
  const max = Math.max(...rows.map(val), 0.01);
  const w = 300 / rows.length;
  const bw = Math.max(1, w * 0.72);
  const bars = rows.map((r, i) => {
    const x = (i * w + (w - bw) / 2).toFixed(2);
    const hE = ((hasCost ? r.eCost : r.kwh) / max) * 100;
    const hG = hasCost ? (r.gCost / max) * 100 : 0;
    return `<rect class="bar-e" x="${x}" y="${100 - hE}" width="${bw.toFixed(2)}" height="${hE}"><title>${r.label}: ${hasCost ? fmtMoney(r.eCost) : `${r.kwh.toFixed(1)} kWh`}</title></rect>${hG ? `<rect class="bar-g" x="${x}" y="${100 - hE - hG}" width="${bw.toFixed(2)}" height="${hG}"><title>${r.label} gas: ${fmtMoney(r.gCost)}</title></rect>` : ''}`;
  }).join('');
  const gas = rows.some((r) => r.gCost > 0);
  return `<div class="energy-chart">
    <div class="chart-top"><span>${hasCost ? 'Cost' : 'kWh'} per ${rows.length === 12 ? 'month' : 'day'}</span><span>${hasCost && gas ? '<i class="key-e"></i>Electric <i class="key-g"></i>Gas · ' : ''}top ${hasCost ? fmtMoney(max) : `${max.toFixed(1)} kWh`}</span></div>
    <svg viewBox="0 0 300 100" preserveAspectRatio="none" style="height:${height}px" role="img" aria-label="${hasCost ? 'Cost' : 'Usage'} chart">${bars}</svg>
    <div class="chart-axis"><span>${rows[0].label}</span><span>${rows[rows.length - 1].label}</span></div>
  </div>`;
}

function energyTotals(rows) {
  const t = rows.reduce((a, r) => ({ kwh: a.kwh + r.kwh, therms: a.therms + r.therms, eCost: a.eCost + r.eCost, gCost: a.gCost + r.gCost, days: a.days + r.days }), { kwh: 0, therms: 0, eCost: 0, gCost: 0, days: 0 });
  return { ...t, cost: t.eCost + t.gCost };
}

function energyCard() {
  const all = energyDays();
  const head = `<div class="card-head">${icon('zap')}<h2>Energy</h2>${all.length ? `<a class="link" href="#/energy">Details ${icon('arrowRight')}</a>` : ''}</div>`;
  if (!all.length) return `<div class="card a-energy">${head}${syncBanner()}</div>`;
  const last = all[all.length - 1];
  const c = cycleFor();
  const fmt = (t) => (t.cost > 0 ? fmtMoney(t.cost) : `${Math.round(t.kwh)} kWh`);
  let stats; let rows;
  if (c) {
    rows = energyRows('cycle');
    const now = energyTotals(rows);
    const fc = billForecast(c);
    const prev = previousCycle(c);
    const prevT = energyTotals(energyRows('last'));
    const dayN = Math.min(daysIncl(c.start, isoDay(new Date())), daysIncl(c.start, c.end));
    stats = `<div><small>This bill so far</small><b>${fmt(now)}</b><span class="stat-note">Day ${dayN} of ${daysIncl(c.start, c.end)} · since ${fmtShort(c.start)}</span></div>
      ${fc && fc.projected ? `<div><small>Projected bill</small><b>${fmtMoney(fc.projected)}</b><span class="stat-note">PG&amp;E's estimate</span></div>`
        : `<div><small>Last bill</small><b>${fmt(billed(prev.start) !== null ? { cost: billed(prev.start) } : prevT)}</b><span class="stat-note">${cycleRange(prev)}</span></div>`}`;
  } else {
    rows = energyRows('30');
    const now = energyTotals(rows);
    const month = sumDays(all.filter((d) => d.slice(0, 7) === last.slice(0, 7)));
    stats = `<div><small>${new Date(`${last}T12:00`).toLocaleDateString([], { month: 'long' })} so far</small><b>${fmt(month)}</b></div>
      <div><small>Last 30 days</small><b>${fmt(now)}</b></div>`;
  }
  return `<div class="card a-energy">${head}
    <div class="energy">
      <div class="energy-stats">${stats}</div>
      ${energyChart(rows)}
    </div>
    <p class="hint energy-foot">PG&amp;E data through ${fmtShort(last)}</p>
    ${syncBanner()}
  </div>`;
}

/* =========================================================
   Health (Fitbit, read in the browser through the Google Health API, see health.js)
   ========================================================= */
// state.health: { phu: { at, days: { 'YYYY-MM-DD': { steps, km, azm, rhr, kg, sleep: [asleep, deep, light, rem, awake] } } } }
// It is shared with the household like events and tasks. Google's sign-in pass stays in this tab only.
const HEALTH_PASS_KEY = 'home-dashboard.health-pass.v1';
let healthPasses = {};
try { healthPasses = JSON.parse(sessionStorage.getItem(HEALTH_PASS_KEY)) || {}; } catch { healthPasses = {}; }
const savePasses = () => { try { sessionStorage.setItem(HEALTH_PASS_KEY, JSON.stringify(healthPasses)); } catch { /* ignore */ } };
const healthBusy = {}; // who -> true while reading
const healthNote = {}; // who -> last problem, shown under their status

const passFor = (who) => (healthPasses[who]?.exp > Date.now() ? healthPasses[who].token : null);

// Reads the last 30 days for one person and keeps them. `token` comes from Google's sign-in.
async function pullHealth(who, token) {
  healthBusy[who] = true; delete healthNote[who]; refreshHealthViews();
  try {
    const { days, skipped } = await readDays(token);
    const mine = state.health[who]?.days || {};
    const cutoff = isoDay(addDays(new Date(), -120));
    const merged = Object.fromEntries(Object.entries({ ...mine, ...Object.fromEntries(Object.entries(days).map(([d, v]) => [d, { ...mine[d], ...v }])) })
      .filter(([d]) => d >= cutoff).sort(([a], [b]) => a.localeCompare(b)));
    state.health[who] = { at: Date.now(), days: merged };
    if (skipped.length) healthNote[who] = `Couldn't read ${skipped.join(', ')}. Reconnect and allow every box on Google's screen to include it.`;
    save();
  } catch (e) {
    if (e instanceof SignInExpired) { delete healthPasses[who]; savePasses(); healthNote[who] = 'The Google sign-in ended. Tap Update to sign in again.'; }
    else healthNote[who] = `Couldn't read Fitbit data: ${e.message}`;
  } finally {
    healthBusy[who] = false;
    refreshHealthViews();
  }
}
// Opens Google's sign-in for one person (must run straight from a tap), then reads their data.
function connectHealth(who, again) {
  signIn({ again })
    .then((pass) => { healthPasses[who] = pass; savePasses(); return pullHealth(who, pass.token); })
    .catch((e) => { healthNote[who] = e.message; refreshHealthViews(); });
}
// While someone's sign-in pass is still good in this tab, keep their numbers fresh without asking.
function refreshHealthQuietly() {
  for (const u of USERS) {
    const t = passFor(u.id);
    // Only people still connected: data removed on another screen stays removed.
    if (t && state.health[u.id] && !healthBusy[u.id] && Date.now() - state.health[u.id].at > 20 * 6e4) pullHealth(u.id, t);
  }
}
function refreshHealthViews() {
  if (['health', 'settings', 'home'].includes(currentRoute()) && $('#sheet').hidden && !document.activeElement?.matches('input, textarea')) renderView();
}

const healthPeople = () => USERS.filter((u) => state.health[u.id]);
const healthDays = (who) => state.health[who]?.days || {};
const fmtMins = (m) => (m < 60 ? `${Math.round(m)}m` : `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`);
const avgOf = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);

// One person's connect / update row: status line and the button that goes with it.
function healthRow(who) {
  const u = userOf(who);
  const p = state.health[who];
  if (healthBusy[who]) return `<div class="health-row"><p class="sync-line">${icon('heart')}Reading ${u.name}'s Fitbit…</p></div>`;
  const note = healthNote[who] ? `<div class="sync-banner">${icon('heart')}<span>${esc(healthNote[who])}</span></div>` : '';
  if (!p) {
    return `<div class="health-row">${note}<div class="health-line">${avatar(who)}<span>${u.name} hasn't connected a Fitbit.</span>
      <button class="btn" data-action="health-connect" data-v="${who}">Connect</button></div></div>`;
  }
  const stale = Date.now() - p.at > 24 * 36e5;
  return `<div class="health-row">${note}<div class="health-line">${avatar(who)}<span>${u.name}'s Fitbit · updated ${ago(p.at)}${stale ? '. Tap Update for the latest' : ''}</span>
    <button class="btn${stale ? '' : ' ghost'}" data-action="health-update" data-v="${who}">Update</button></div></div>`;
}

// Bars for the last `n` days. `parts` stacks several values per day: [[value(day), class], ...].
function healthChart(who, n, title, parts, fmt) {
  const days = healthDays(who);
  const rows = Array.from({ length: n }, (_, i) => {
    const key = isoDay(addDays(new Date(), i - n + 1));
    return { key, label: fmtShort(key), vals: parts.map(([f]) => (days[key] ? f(days[key]) || 0 : 0)) };
  });
  const max = Math.max(...rows.map((r) => r.vals.reduce((a, b) => a + b, 0)), 1);
  const w = 300 / n; const bw = Math.max(1, w * 0.68);
  const bars = rows.map((r, i) => {
    let y = 100;
    const total = r.vals.reduce((a, b) => a + b, 0);
    return r.vals.map((v, j) => {
      const h = (v / max) * 100; y -= h;
      return v ? `<rect class="${parts[j][1]}" x="${(i * w + (w - bw) / 2).toFixed(2)}" y="${y.toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}"><title>${r.label}: ${fmt(total)}</title></rect>` : '';
    }).join('');
  }).join('');
  return `<div class="energy-chart">
    <div class="chart-top"><span>${title}</span><span>${parts.length > 1 ? `${parts.map(([, c, l]) => `<i class="key ${c}"></i>${l}`).join(' ')} · ` : ''}top ${fmt(max)}</span></div>
    <svg viewBox="0 0 300 100" preserveAspectRatio="none" style="height:180px" role="img" aria-label="${title}">${bars}</svg>
    <div class="chart-axis"><span>${rows[0].label}</span><span>${rows[n - 1].label}</span></div>
  </div>`;
}

function weatherValid() {
  const { lat, lon } = state.settings.place;
  return weather && weather.unit === state.settings.unit && weather.placeKey === `${lat},${lon}`;
}

/* =========================================================
   Navigation
   ========================================================= */
const PAGES = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'tasks', label: 'Tasks', icon: 'checkSquare' },
  { id: 'piggy', label: 'Piggy Bank', icon: 'piggy' },
  { id: 'energy', label: 'Energy', icon: 'zap' },
  { id: 'health', label: 'Health', icon: 'heart' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

const currentRoute = () => {
  const r = location.hash.replace(/^#\/?/, '').split('?')[0];
  return PAGES.some((p) => p.id === r) ? r : 'home';
};

// The tabs are drawn once; switching tabs slides the highlight to the new one.
function renderNav() {
  const r = currentRoute();
  const tabs = $('#tabs');
  if (!tabs.children.length) {
    tabs.innerHTML = `<span class="tab-ink" aria-hidden="true"></span>${PAGES.map((p) => `
      <a class="tab" href="#/${p.id}" data-page="${p.id}">${icon(p.icon)}<span>${p.label}</span></a>`).join('')}`;
  }
  tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.page === r));
  moveInk();
}
function moveInk() {
  const t = $('#tabs .tab.active');
  const ink = $('#tabs .tab-ink');
  if (!t || !ink) return;
  const r = t.getBoundingClientRect();
  const bar = t.parentElement.getBoundingClientRect();
  ink.style.width = `${r.width}px`;
  ink.style.transform = `translateX(${r.left - bar.left + t.parentElement.scrollLeft - t.parentElement.clientLeft - 6}px)`;
}
// The bar can change width without a window resize (a page scrollbar appearing, fonts loading).
new ResizeObserver(moveInk).observe($('#tabs'));
document.fonts?.ready.then(() => { moveInk(); requestAnimationFrame(() => $('#tabs').classList.add('ink-ready')); });

// Light the tab up the moment a finger lands on it, before the tap finishes.
$('#tabs').addEventListener('pointerdown', (e) => {
  const t = e.target.closest('.tab');
  if (!t || t.classList.contains('active')) return;
  $('#tabs .tab.active')?.classList.remove('active');
  t.classList.add('active');
  moveInk();
});

/* Swipe left or right anywhere on a page to move to the next tab.
   The page and the tab highlight follow the finger, then settle. */
const swipe = { id: null, x: 0, y: 0, dx: 0, on: false, samples: [], done: false };
const scrollsSideways = (el) => {
  for (; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
};
function inkBetween(a, b, t) {
  const ink = $('#tabs .tab-ink');
  const bar = $('#tabs').getBoundingClientRect();
  const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect();
  const left = ra.left + (rb.left - ra.left) * t; const width = ra.width + (rb.width - ra.width) * t;
  ink.style.width = `${width}px`;
  ink.style.transform = `translateX(${left - bar.left + $('#tabs').scrollLeft - $('#tabs').clientLeft - 6}px)`;
}
function swipeNeighbor(dir) {
  const i = PAGES.findIndex((p) => p.id === currentRoute()) + dir;
  return PAGES[i];
}
const view = $('#view');
view.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || swipe.id !== null || !$('#sheet').hidden) return;
  if (e.target.closest('input, textarea, select, .switch') || scrollsSideways(e.target)) return;
  Object.assign(swipe, { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, on: false, done: false, samples: [[e.timeStamp, e.clientX]] });
});
view.addEventListener('pointermove', (e) => {
  if (e.pointerId !== swipe.id) return;
  const dx = e.clientX - swipe.x; const dy = e.clientY - swipe.y;
  if (!swipe.on) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe.id = null; return; }
    if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    swipe.on = true; swipe.x = e.clientX; // start from here so the page doesn't jump
    view.setPointerCapture(e.pointerId);
    view.classList.add('dragging'); $('#tabs').classList.add('dragging');
    return;
  }
  const raw = e.clientX - swipe.x;
  const next = swipeNeighbor(raw < 0 ? 1 : -1);
  // Past the first or last tab the page only gives a little, like a rubber band.
  swipe.dx = next ? raw : raw / (1 + Math.abs(raw) / 60);
  swipe.samples.push([e.timeStamp, e.clientX]); if (swipe.samples.length > 6) swipe.samples.shift();
  const w = view.clientWidth;
  view.style.transform = `translate3d(${swipe.dx}px,0,0)`;
  view.style.opacity = String(1 - Math.min(Math.abs(swipe.dx) / w, 1) * 0.35);
  const cur = $(`#tabs .tab[data-page="${currentRoute()}"]`);
  if (next) inkBetween(cur, $(`#tabs .tab[data-page="${next.id}"]`), Math.min(Math.abs(raw) / (w * 0.6), 1));
  else moveInk();
});
function endSwipe(e, cancelled) {
  if (e.pointerId !== swipe.id) return;
  swipe.id = null;
  if (!swipe.on) return;
  swipe.done = true; setTimeout(() => { swipe.done = false; }, 350);
  const [t0, x0] = swipe.samples[0];
  const v = (e.clientX - x0) / Math.max(e.timeStamp - t0, 1); // px per ms
  const dir = swipe.dx < 0 ? 1 : -1;
  const next = swipeNeighbor(dir);
  const go = !cancelled && next && (Math.abs(swipe.dx) > view.clientWidth * 0.22 || (Math.abs(v) > 0.45 && Math.sign(v) === -dir));
  $('#tabs').classList.remove('dragging');
  view.classList.remove('dragging');
  if (go) {
    view.classList.add('leaving');
    view.style.transform = `translate3d(${-dir * Math.min(view.clientWidth * 0.3, 160)}px,0,0)`;
    view.style.opacity = '0';
    setTimeout(() => {
      view.classList.remove('leaving'); view.style.transform = ''; view.style.opacity = '';
      location.hash = `#/${next.id}`;
    }, 140);
  } else {
    view.classList.add('settling');
    view.style.transform = ''; view.style.opacity = '';
    moveInk();
    setTimeout(() => view.classList.remove('settling'), 320);
  }
}
view.addEventListener('pointerup', (e) => endSwipe(e, false));
view.addEventListener('pointercancel', (e) => endSwipe(e, true));
// A swipe that ends over a button shouldn't also press it.
view.addEventListener('click', (e) => { if (swipe.done) { swipe.done = false; e.stopPropagation(); e.preventDefault(); } }, true);

/* =========================================================
   Views
   ========================================================= */
const views = {};

function weatherCard() {
  if (!weatherValid()) {
    return `<div class="card a-weather weather-card">
      <div class="card-head">${icon('sun')}<h2>Weather</h2></div>
      <p class="muted">${navigator.onLine ? 'Loading weather…' : 'Offline. Weather will load when the connection is back.'}</p></div>`;
  }
  const w = wmo(weather.code, weather.isDay);
  const u = state.settings.unit;
  const hours = weather.hours.map((h) => {
    const hw = wmo(h.code, h.isDay);
    const label = fmtTime(new Date(h.time), false);
    return `<div class="hour">${icon(hw.icon, hw.icon === 'sun' ? 'sun' : '')}<small>${label}</small><b>${Math.round(h.temp)}°</b></div>`;
  }).join('');
  return `<div class="card a-weather weather-card">
    <div class="card-head"><span style="color:var(--amber-fg);font-size:24px;display:inline-flex">${icon(w.icon)}</span><h2>Weather</h2>
</div>
    <div class="weather-now">
      <div class="big-ico ${weather.isDay ? '' : 'night'}">${icon(w.icon)}</div>
      <div><div class="temp">${Math.round(weather.temp)}°${u}</div><div class="cond">${w.label}</div></div>
      <div class="hl">H: ${Math.round(weather.hi)}° &nbsp; L: ${Math.round(weather.lo)}°<br>${esc(state.settings.place.name)}</div>
    </div>
    <div class="hourly">
      <div class="hour now">${icon(w.icon)}<small>Now</small><b>${Math.round(weather.temp)}°</b></div>
      ${hours}
    </div>
    ${weekStrip()}
  </div>`;
}

/* ---------- People ---------- */
// One avatar for a person, or an overlapping pair for 'both'. Unassigned returns ''.
function avatar(who, size = 'md') {
  if (who === 'both') return `<span class="av-pair">${USERS.map((u) => avatarImg(u, size)).join('')}</span>`;
  const u = userOf(who);
  return u ? avatarImg(u, size) : '';
}
const avatarImg = (u, size) => `<img class="av av-${size} av-${u.color}" src="${u.avatar}" alt="${u.name}" title="${u.name}">`;
const whoName = (who) => (who === 'both' ? `${USERS[0].name} & ${USERS[1].name}` : userOf(who)?.name || 'Everyone');

/* ---------- Events ---------- */
const byStart = (a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''));
const eventsOn = (iso) => state.events.filter((e) => e.date === iso).sort(byStart);

function upcomingEvents(limit) {
  const todayIso = isoDay(new Date());
  return state.events.filter((e) => e.date >= todayIso).sort(byStart).slice(0, limit);
}

function dayLabel(iso) {
  if (iso === isoDay(new Date())) return 'Today';
  if (iso === isoDay(addDays(new Date(), 1))) return 'Tomorrow';
  return new Date(`${iso}T12:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

const timeLabel = (e) => (e.time ? fmtTime(new Date(`${e.date}T${e.time}`)) : 'All day');

// Compact event used in the calendar grids: avatar, start time, title.
// Items marked important get a red "Important" tag and red styling everywhere they show.
const impTag = (item) => (item.important ? '<span class="imp-tag">Important</span>' : '');
const impRow = (on) => `<div class="setting-row imp-row"><div><b>Important</b><div class="hint">Shows an Important tag and turns it red.</div></div>
  <button class="switch imp-switch" id="imp-switch" role="switch" aria-checked="${!!on}" data-action="toggle-important"></button></div>`;
const pickedImportant = () => $('#imp-switch')?.getAttribute('aria-checked') === 'true';

function eventChip(e) {
  return `<button class="ev-chip${e.important ? ' imp' : ''}" data-action="edit-event" data-id="${e.id}">
    ${avatar(e.who, 'xs')}<b>${e.time ? timeLabel(e) : ''}</b>${impTag(e)}<span>${esc(e.title)}</span></button>`;
}

function eventRow(e, withDate = false) {
  const when = [withDate ? dayLabel(e.date) : '', timeLabel(e)].filter(Boolean).join(' · ');
  return `<button class="row${e.important ? ' imp' : ''}" data-action="edit-event" data-id="${e.id}">
    ${avatar(e.who, 'md') || `<span class="ibox c-purple-ico">${icon('calendar')}</span>`}
    <span><b>${esc(e.title)}${impTag(e)}</b><small>${when}</small></span>${icon('chevron', 'chev')}</button>`;
}

function weekStrip() {
  return `<div class="week">${weather.days.map((d, i) => {
    const w = wmo(d.code, 1);
    const label = i === 0 ? 'Today' : new Date(`${d.date}T12:00`).toLocaleDateString([], { weekday: 'short' });
    return `<div class="wday"><small>${label}</small>${icon(w.icon, w.icon === 'sun' ? 'sun' : '')}<b>${Math.round(d.hi)}°</b><span class="muted">${Math.round(d.lo)}°</span></div>`;
  }).join('')}</div>`;
}

/* ---------- Tasks ---------- */
const REPEAT_LABEL = { daily: 'Daily', weekly: 'Weekly', once: 'Once' };
const weekStartIso = () => { const d = new Date(); return isoDay(addDays(d, -d.getDay())); };

// Daily tasks reset each day and weekly tasks each Sunday; one-off tasks stay done.
function isDone(t) {
  if (!t.doneOn) return false;
  if (t.repeat === 'daily') return t.doneOn === isoDay(new Date());
  if (t.repeat === 'weekly') return t.doneOn >= weekStartIso();
  return true;
}
const tasksFor = (id) => state.tasks.filter((t) => t.who === id);
// Tasks have no date of their own, so the calendar shows them on today: the open ones,
// plus any ticked off today (struck through), each person's together.
const tasksToday = () => {
  const today = isoDay(new Date());
  const order = USERS.map((u) => u.id);
  return state.tasks.filter((t) => !isDone(t) || t.doneOn === today)
    .sort((a, b) => order.indexOf(a.who) - order.indexOf(b.who) || isDone(a) - isDone(b));
};

// Compact task for the calendar grids: a tick box and the title, in the person's color.
function taskChip(t) {
  const done = isDone(t);
  const u = userOf(t.who);
  return `<div class="task-chip c-${u?.color || 'purple'}${done ? ' done' : ''}${t.important ? ' imp' : ''}">
    <button class="tc-check" data-action="toggle-task" data-id="${t.id}" aria-label="${done ? 'Mark not done' : 'Mark done'}: ${esc(t.title)}" aria-pressed="${done}">${icon('check')}</button>
    <button class="tc-title" data-action="edit-task" data-id="${t.id}">${esc(t.title)}</button></div>`;
}

function taskCard(t, u) {
  const done = isDone(t);
  return `<div class="task ${done ? `done c-${u.color}` : ''}${t.important ? ' imp' : ''}">
    <button class="task-body" data-action="edit-task" data-id="${t.id}">
      <b>${esc(t.title)}${impTag(t)}</b>
      <small>${REPEAT_LABEL[t.repeat]} <span class="stars">${icon('star')}${t.stars}</span></small>
    </button>
    <button class="check ${done ? 'on' : ''}" data-action="toggle-task" data-id="${t.id}" aria-label="${done ? 'Mark not done' : 'Mark done'}" aria-pressed="${done}">${icon('check')}</button>
  </div>`;
}

function personHead(u, size = 'lg') {
  const list = tasksFor(u.id);
  const done = list.filter(isDone).length;
  return `<div class="person-head">
    ${avatar(u.id, size)}
    <div><h2>${u.name}</h2>
      <div class="pills"><span class="pill">${icon('check')}${done}/${list.length}</span><span class="pill">${icon('star')}${state.stars[u.id] || 0}</span></div>
    </div>
  </div>`;
}

/* ---------- Home ---------- */
// Today's calendar events, shown above each person's tasks on Home. Events that have ended fade back.
function todayEvent(e) {
  const now = new Date();
  const endAt = e.time ? new Date(`${e.date}T${e.end || e.time}`) : null;
  const past = endAt && endAt < now;
  return `<button class="today-ev${e.important ? ' imp' : ''}${past ? ' past' : ''}" data-action="edit-event" data-id="${e.id}">
    ${icon('calendar')}<b>${e.time ? fmtTime(new Date(`${e.date}T${e.time}`)) : 'All day'}</b><span>${esc(e.title)}</span>${impTag(e)}</button>`;
}

views.home = () => `
  <div class="grid-home">
    ${weatherCard()}
    <div class="card a-agenda">
      <div class="card-head">${icon('calendar')}<h2>Coming up</h2><a class="link" href="#/calendar">Calendar ${icon('arrowRight')}</a></div>
      <div class="list">${upcomingEvents(4).map((e) => eventRow(e, true)).join('') || '<p class="muted">Nothing on the calendar yet.</p>'}</div>
    </div>
    <div class="card a-tasks">
      <div class="card-head">${icon('checkSquare')}<h2>Today</h2><a class="link" href="#/tasks">All tasks ${icon('arrowRight')}</a></div>
      <div class="home-tasks">
        ${USERS.map((u) => {
          const open = tasksFor(u.id).filter((t) => !isDone(t));
          const evs = eventsOn(isoDay(new Date())).filter((e) => !e.who || e.who === 'both' || e.who === u.id);
          return `<div class="home-person">${personHead(u, 'md')}
            ${evs.length ? `<div class="today-evs">${evs.map(todayEvent).join('')}</div>` : ''}
            <div class="task-list">${open.slice(0, 2).map((t) => taskCard(t, u)).join('') || '<p class="muted">All done for now.</p>'}</div>
            ${open.length > 2 ? `<a class="more-link" href="#/tasks">+${open.length - 2} more</a>` : ''}</div>`;
        }).join('')}
      </div>
    </div>
    ${energyCard()}
  </div>`;

/* ---------- Calendar ---------- */
let calCursor = new Date();
const HOUR_PX = 52;
const DAY_START = 6; // 6 AM
const DAY_END = 23; // 11 PM

const minutesOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Lay out one day's timed events in side-by-side lanes when they overlap.
function laneLayout(events) {
  const items = events.map((e) => {
    const start = minutesOf(e.time);
    const end = Math.max(start + 30, e.end ? minutesOf(e.end) : start + 60);
    return { e, start, end, lane: 0, lanes: 1 };
  });
  let group = [];
  let groupEnd = -1;
  const flush = () => { const n = Math.max(...group.map((g) => g.lane)) + 1; group.forEach((g) => { g.lanes = n; }); group = []; };
  items.forEach((it) => {
    if (group.length && it.start >= groupEnd) flush();
    const used = new Set(group.filter((g) => g.end > it.start).map((g) => g.lane));
    while (used.has(it.lane)) it.lane++;
    group.push(it);
    groupEnd = Math.max(groupEnd, it.end);
  });
  if (group.length) flush();
  return items;
}

function weekView() {
  const start = addDays(calCursor, -calCursor.getDay());
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const todayIso = isoDay(new Date());
  const hours = Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const head = days.map((d) => `<div class="wk-day ${isoDay(d) === todayIso ? 'today' : ''}">
      <small>${d.toLocaleDateString([], { weekday: 'short' })}</small><b>${d.getDate()}</b></div>`).join('');
  const allDay = days.map((d) => {
    const iso = isoDay(d);
    const tasks = iso === todayIso ? tasksToday().map(taskChip).join('') : '';
    return `<div class="wk-allday">${eventsOn(iso).filter((e) => !e.time).map(eventChip).join('')}${tasks}</div>`;
  }).join('');
  const cols = days.map((d) => {
    const iso = isoDay(d);
    const timed = laneLayout(eventsOn(iso).filter((e) => e.time));
    const nowLine = iso === todayIso && nowMin >= DAY_START * 60 && nowMin < DAY_END * 60
      ? `<div class="now-line" style="top:${((nowMin - DAY_START * 60) / 60) * HOUR_PX}px"></div>` : '';
    return `<div class="wk-col" data-action="add-event-at" data-d="${iso}">
      ${timed.map(({ e, start, end, lane, lanes }) => {
        // Clip to the visible hours, so an event starting before 6 AM doesn't run past its end.
        const from = Math.min(Math.max(start, DAY_START * 60), DAY_END * 60);
        const to = Math.min(Math.max(end, DAY_START * 60), DAY_END * 60);
        const top = Math.min(((from - DAY_START * 60) / 60) * HOUR_PX, (DAY_END - DAY_START) * HOUR_PX - 26);
        const height = Math.max(26, ((to - from) / 60) * HOUR_PX - 3);
        return `<button class="wk-ev ${e.who ? `c-${e.who === 'both' ? 'purple' : userOf(e.who).color}` : 'c-purple'}${e.important ? ' imp' : ''}" data-action="edit-event" data-id="${e.id}"
          style="top:${top}px;height:${height}px;left:calc(${(lane / lanes) * 100}% + 2px);width:calc(${100 / lanes}% - 4px)">
          <span class="wk-ev-top">${avatar(e.who, 'xs')}<b>${timeLabel(e)}</b>${impTag(e)}</span><span class="wk-ev-title">${esc(e.title)}</span></button>`;
      }).join('')}${nowLine}</div>`;
  }).join('');
  return `<div class="wk">
    <div class="wk-head"><div></div>${head}</div>
    <div class="wk-allrow"><div class="wk-gutter-label">All day${days.some((d) => isoDay(d) === todayIso) && state.tasks.length ? '<br>&amp; tasks' : ''}</div>${allDay}</div>
    <div class="wk-scroll" id="wk-scroll">
      <div class="wk-grid" style="height:${hours.length * HOUR_PX}px">
        <div class="wk-hours">${hours.map((h) => `<span style="top:${(h - DAY_START) * HOUR_PX}px">${fmtTime(new Date(2000, 0, 1, h), false)}</span>`).join('')}</div>
        ${cols}
      </div>
    </div>
  </div>`;
}

function monthView() {
  const y = calCursor.getFullYear();
  const m = calCursor.getMonth();
  const first = new Date(y, m, 1);
  const start = new Date(y, m, 1 - first.getDay());
  const weeks = Math.ceil((first.getDay() + new Date(y, m + 1, 0).getDate()) / 7);
  const todayIso = isoDay(new Date());
  const cells = Array.from({ length: weeks * 7 }, (_, i) => {
    const d = addDays(start, i);
    const iso = isoDay(d);
    const evs = eventsOn(iso);
    const items = [...evs.map(eventChip), ...(iso === todayIso ? tasksToday().map(taskChip) : [])];
    return `<div class="day ${d.getMonth() !== m ? 'other' : ''} ${iso === todayIso ? 'today' : ''}" data-action="open-day" data-d="${iso}">
      <span class="day-num">${d.getDate()}</span>
      <div class="day-evs">${items.slice(0, 4).join('')}${items.length > 4 ? `<span class="more">+${items.length - 4} more</span>` : ''}</div>
    </div>`;
  }).join('');
  return `<div class="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="dow">${d}</div>`).join('')}${cells}</div>`;
}

function calTitle() {
  if (state.settings.calView === 'month') return calCursor.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const s = addDays(calCursor, -calCursor.getDay());
  const e = addDays(s, 6);
  const mon = (d) => d.toLocaleDateString([], { month: 'short' });
  const endPart = s.getMonth() === e.getMonth() ? e.getDate() : `${mon(e)} ${e.getDate()}`;
  return `${mon(s)} ${s.getDate()} – ${endPart}, ${e.getFullYear()}`;
}

views.calendar = () => {
  const v = state.settings.calView;
  return `
  <div class="card cal-card">
    <div class="cal-bar">
      <button class="btn-round" data-action="cal-move" data-d="-1" aria-label="Previous">${icon('chevronLeft')}</button>
      <button class="btn-round" data-action="cal-move" data-d="1" aria-label="Next">${icon('chevron')}</button>
      <h2>${calTitle()}</h2>
      <button class="btn ghost sm" data-action="cal-today">Today</button>
      <span class="spacer"></span>
      <div class="seg">${['week', 'month'].map((x) => `<button class="${v === x ? 'on' : ''}" data-action="cal-view" data-v="${x}">${x === 'week' ? 'Week' : 'Month'}</button>`).join('')}</div>
      <button class="btn-round accent" data-action="add-event" data-d="${isoDay(new Date())}" aria-label="Add event">${icon('plus')}</button>
    </div>
    <div class="cal-body">${v === 'month' ? monthView() : weekView()}</div>
  </div>`;
};

/* ---------- Tasks ---------- */
views.tasks = () => `
  <div class="section-title">Tasks<span class="spacer"></span>
    <button class="btn-round accent" data-action="add-task" aria-label="Add task">${icon('plus')}</button></div>
  <div class="board">
    ${USERS.map((u) => `
      <div class="card board-col">
        ${personHead(u)}
        <div class="task-list">${tasksFor(u.id).map((t) => taskCard(t, u)).join('') || '<p class="muted">No tasks yet.</p>'}</div>
        <button class="add-task" data-action="add-task" data-who="${u.id}">${icon('plus')} Add a task for ${u.name}</button>
      </div>`).join('')}
  </div>`;

/* =========================================================
   Household sync (same events, tasks and expenses on every device)
   ========================================================= */
const HOUSE_PASS_KEY = 'home-dashboard.household-pass.v1';
const HOUSE_BASE_KEY = 'home-dashboard.household-base.v1';
let housePass = '';
try { housePass = localStorage.getItem(HOUSE_PASS_KEY) || ''; } catch { housePass = ''; }
let houseSync = { state: housePass ? 'connecting' : 'off' };
let houseTyped = ''; // passphrase waiting on "start a new household"
const calmToRender = () => $('#sheet').hidden && !document.activeElement?.matches('input, textarea');
const house = createSync({
  getState: () => state,
  onRemote: (apply) => {
    apply(state);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
    if (calmToRender()) renderView(); // an open sheet re-renders the page when it closes
  },
  onStatus: (st) => {
    houseSync = st;
    // The saved passphrase stopped working: ask for it again.
    if (st.state === 'badpass' && housePass && !houseSheetOpen()) openHouseSheet();
    if (currentRoute() === 'settings' && calmToRender()) renderView();
  },
  onBase: (b) => { try { b ? localStorage.setItem(HOUSE_BASE_KEY, JSON.stringify(b)) : localStorage.removeItem(HOUSE_BASE_KEY); } catch { /* ignore */ } },
});
onSaved = () => { if (house.connected) house.changed(); };
function houseMessage() {
  const at = houseSync.at ? ago(houseSync.at) : '';
  switch (houseSync.state) {
    case 'ok': return { ok: true, text: `Synced with every device on this passphrase. Last sync ${at}.` };
    case 'connecting': return { ok: true, text: 'Connecting…' };
    case 'new': return { ok: false, text: 'No household uses this passphrase yet. Check it for typos, or start a new household with what is on this device.' };
    case 'offline': return { ok: false, text: 'Offline. Changes are saved here and will sync when the connection is back.' };
    case 'badpass': return { ok: false, text: "That passphrase doesn't unlock this household's data." };
    case 'error': return { ok: false, text: "Couldn't reach the sync service. It will keep trying." };
    default: return { ok: false, text: 'Not syncing. Events, tasks and expenses stay on this device only.' };
  }
}
function houseCard() {
  if (!syncAvailable()) {
    return `<div class="card">
      <div class="card-head">${icon('users')}<h2>Sync across devices</h2></div>
      <div class="sync-banner">${icon('users')}<span>Not set up yet. Each device keeps its own events, tasks and expenses until sync is turned on for this site.</span></div>
    </div>`;
  }
  const m = houseMessage();
  return `<div class="card">
    <div class="card-head">${icon('users')}<h2>Sync across devices</h2></div>
    ${m.ok ? `<p class="sync-line">${icon('check')}${m.text}</p>` : `<div class="sync-banner">${icon('users')}<span>${m.text}</span></div>`}
    ${houseSync.state === 'new' ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:-4px 0 16px"><button class="btn" data-action="house-create">Start a new household</button><button class="btn ghost" data-action="house-cancel">Cancel</button></div>` : ''}
    <div class="field"><label for="house-pass">Household passphrase</label>
      <div style="display:flex;gap:8px"><input class="input" id="house-pass" data-house-pass type="password" autocomplete="off" placeholder="${housePass ? 'Saved on this device' : 'Same phrase on every device'}">
      <button class="btn" data-action="house-connect">${housePass ? 'Update' : 'Connect'}</button></div>
      <div class="hint">Type the same passphrase on each device. Everything is encrypted with it before it leaves this device. Joining a household replaces this device's events, tasks and expenses with the shared ones.</div></div>
    ${housePass ? '<button class="btn ghost" data-action="house-disconnect">Stop syncing on this device</button>' : ''}
  </div>`;
}

// Sign-in panel: pops up when this device isn't in a household yet, or its passphrase
// needs typing again. "Not now" keeps the device on its own until the app is opened again.
const houseSheetOpen = () => !$('#sheet').hidden && $('#sheet').dataset.kind === 'house';
function openHouseSheet() {
  const st = houseSync.state;
  const note = st === 'new' ? 'No household uses this passphrase yet. Check it for typos, or start a new household with what is on this device.'
    : st === 'badpass' ? "That passphrase doesn't unlock the household. Type it again."
    : st === 'error' ? "Couldn't reach the sync service. Check the connection and try again."
    : st === 'offline' ? "You're offline. Connect to the internet to join the household." : '';
  openSheet(`${sheetHead('Join your household', 'users')}
    <p class="house-intro">Type your household passphrase to see the same events, tasks and expenses as everyone else.</p>
    ${note ? `<div class="sync-banner">${icon('users')}<span>${note}</span></div>` : ''}
    ${st === 'new' ? `<div class="sheet-actions" style="justify-content:flex-start;margin:0 0 16px">
        <button class="btn" data-action="house-create">Start a new household</button>
        <button class="btn ghost" data-action="house-cancel">Try again</button></div>` : `
    <div class="field"><label for="house-pass-pop">Household passphrase</label>
      <input class="input" id="house-pass-pop" data-house-pass type="password" autocomplete="off" placeholder="Same phrase on every device"></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-action="close-sheet">Not now</button>
      <button class="btn" data-action="house-connect" ${st === 'connecting' ? 'disabled' : ''}>${st === 'connecting' ? 'Connecting…' : 'Connect'}</button>
    </div>`}`);
  $('#sheet').dataset.kind = 'house';
}
// The passphrase box next to the button that was tapped (Settings card or the pop-up).
const houseInput = (el) => (el?.closest('.sheet, .card') || document).querySelector('[data-house-pass]');

/* ---------- Piggy Bank (shared expenses) ---------- */
const fmtCash = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const monthKey = (d) => isoDay(d).slice(0, 7);
let piggyMonth = monthKey(new Date());
const monthBounds = (key) => { const [y, m] = key.split('-').map(Number); return [new Date(y, m - 1, 1), new Date(y, m, 0)]; };
const monthName = (key) => monthBounds(key)[0].toLocaleDateString([], { month: 'long', year: 'numeric' });
const monthRange = (key) => monthBounds(key).map((d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' })).join(' – ');
const expensesIn = (key) => state.expenses.filter((x) => x.date.startsWith(key)).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

// Who paid what, and who owes whom for the shared (split 50/50) expenses.
function expenseStats(list) {
  const paid = Object.fromEntries(USERS.map((u) => [u.id, 0]));
  const sharedPaid = { ...paid };
  let total = 0; let shared = 0;
  list.forEach((x) => {
    total += x.amount; paid[x.paidBy] = (paid[x.paidBy] || 0) + x.amount;
    if (x.split) { shared += x.amount; sharedPaid[x.paidBy] = (sharedPaid[x.paidBy] || 0) + x.amount; }
  });
  const [a, b] = USERS;
  const net = sharedPaid[a.id] - shared / 2; // > 0 means b owes a
  return { total, paid, shared, each: shared / 2, owed: Math.abs(net), from: net > 0 ? b : a, to: net > 0 ? a : b };
}

function expenseRow(x, showSplit) {
  const u = userOf(x.paidBy);
  const note = x.split ? (showSplit ? `Split · ${fmtCash(x.amount / 2)} each` : 'Split') : `Just ${u?.name}`;
  return `<button class="row expense" data-action="edit-expense" data-id="${x.id}">
    ${avatar(x.paidBy, 'md')}
    <span class="ex-main"><b>${esc(x.title)}</b><small>${u?.name} paid · ${note}</small></span>
    <span class="ex-amt">${fmtCash(x.amount)}</span></button>`;
}

views.piggy = () => {
  const key = piggyMonth;
  const list = expensesIn(key);
  const st = expenseStats(list);
  const showSplit = !!state.settings.showSplit;
  const [first, last] = monthBounds(key);
  const isNow = key === monthKey(new Date());
  const daysSoFar = isNow ? new Date().getDate() : last.getDate();
  const byDay = {};
  list.forEach((x) => { (byDay[x.date] ||= []).push(x); });
  const months = [...new Set(state.expenses.map((x) => x.date.slice(0, 7)))].sort().reverse();

  return `<div class="section-title">Piggy Bank<span class="spacer"></span>
    <button class="btn-round accent" data-action="add-expense" aria-label="Add expense">${icon('plus')}</button></div>
  <div class="card piggy-bar">
    <button class="btn-round" data-action="piggy-move" data-d="-1" aria-label="Previous month">${icon('chevronLeft')}</button>
    <button class="btn-round" data-action="piggy-move" data-d="1" aria-label="Next month">${icon('chevron')}</button>
    <div class="piggy-month"><h2>${monthName(key)}</h2><span>${monthRange(key)}</span></div>
    ${isNow ? '' : '<button class="btn ghost sm" data-action="piggy-today">This month</button>'}
    <span class="spacer"></span>
    <div class="split-toggle"><span>Show split</span><button class="switch" role="switch" aria-checked="${showSplit}" data-action="toggle-split" aria-label="Show split"></button></div>
  </div>
  <div class="energy-tiles">
    <div class="card tile"><small>Total spent</small><b>${fmtCash(st.total)}</b><span>${list.length} expense${list.length === 1 ? '' : 's'}</span></div>
    ${USERS.map((u) => `<div class="card tile"><small>${avatarImg(u, 'xs')}&nbsp;${u.name} paid</small><b>${fmtCash(st.paid[u.id])}</b><span>${st.total ? Math.round((st.paid[u.id] / st.total) * 100) : 0}% of the month</span></div>`).join('')}
    <div class="card tile"><small>Average per day</small><b>${fmtCash(st.total / daysSoFar)}</b><span>over ${daysSoFar} day${daysSoFar === 1 ? '' : 's'}</span></div>
  </div>
  ${showSplit ? `<div class="card split-card">
    <div class="card-head">${icon('users')}<h2>Split 50/50</h2><span class="hint">${fmtCash(st.shared)} of shared costs, ${fmtCash(st.each)} each</span></div>
    <div class="split-people">${USERS.map((u) => {
      const sp = expensesIn(key).filter((x) => x.split && x.paidBy === u.id).reduce((a, x) => a + x.amount, 0);
      return `<div class="split-person">${avatarImg(u, 'md')}<div><b>${u.name}</b><small>Paid ${fmtCash(sp)} · share ${fmtCash(st.each)}</small></div></div>`;
    }).join('')}</div>
    <div class="settle ${st.owed < 0.005 ? 'even' : ''}">${st.owed < 0.005 ? 'All square this month' : `<b>${st.from.name}</b> owes <b>${st.to.name}</b> <b class="settle-amt">${fmtCash(st.owed)}</b>`}</div>
  </div>` : ''}
  <div class="card">
    <div class="card-head">${icon('calendar')}<h2>Log</h2><span class="hint">${first.toLocaleDateString([], { month: 'short', day: 'numeric' })} to ${last.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span></div>
    ${list.length ? Object.entries(byDay).map(([d, xs]) => `<div class="ex-day"><div class="ex-day-head"><span>${dayLabel(d)}</span><span>${fmtCash(xs.reduce((a, x) => a + x.amount, 0))}</span></div>
      <div class="list">${xs.map((x) => expenseRow(x, showSplit)).join('')}</div></div>`).join('')
    : `<div class="piggy-empty">${icon('piggy')}<p>Nothing logged for ${monthName(key)} yet.</p><button class="btn" data-action="add-expense">${icon('plus')} Add an expense</button></div>`}
  </div>
  ${months.length ? `<div class="card">
    <div class="card-head">${icon('piggy')}<h2>By month</h2></div>
    <div class="table-wrap"><table class="energy-table">
      <thead><tr><th>Month</th><th>Dates</th>${USERS.map((u) => `<th>${u.name}</th>`).join('')}<th>Total</th></tr></thead>
      <tbody>${months.map((m) => { const s2 = expenseStats(expensesIn(m)); return `<tr class="${m === key ? 'on' : ''}" data-action="piggy-goto" data-m="${m}">
        <td>${monthName(m)}</td><td class="muted">${monthRange(m)}</td>${USERS.map((u) => `<td>${fmtCash(s2.paid[u.id])}</td>`).join('')}<td><b>${fmtCash(s2.total)}</b></td></tr>`; }).join('')}</tbody>
    </table></div>
  </div>` : ''}`;
};

function openExpenseSheet(ex) {
  const today = isoDay(new Date());
  const inMonth = piggyMonth === monthKey(new Date()) ? today : isoDay(monthBounds(piggyMonth)[0]);
  const x = ex || { id: '', title: '', amount: '', date: inMonth, paidBy: USERS[0].id, split: true };
  openSheet(`${sheetHead(ex ? 'Edit expense' : 'New expense', 'piggy')}
    <div class="field"><label for="ex-title">What was it?</label><input class="input" id="ex-title" value="${esc(x.title)}" placeholder="e.g. Groceries"></div>
    <div class="field-row">
      <div class="field"><label for="ex-amount">Amount</label><input class="input" id="ex-amount" type="number" inputmode="decimal" step="0.01" min="0" value="${x.amount}" placeholder="0.00"></div>
      <div class="field"><label for="ex-date">Day</label><input class="input" type="date" id="ex-date" value="${x.date}"></div>
    </div>
    <div class="field"><label>Who paid?</label>${whoPicker(x.paidBy, false)}</div>
    <div class="setting-row imp-row"><div><b>Split 50/50</b><div class="hint">Counts toward what each of you owes. Turn off for a personal expense.</div></div>
      <button class="switch" id="ex-split" role="switch" aria-checked="${!!x.split}" data-action="toggle-important"></button></div>
    <div class="sheet-actions">
      ${ex ? `<button class="btn danger" data-action="del-expense" data-id="${x.id}">${icon('trash')} Delete</button><span class="spacer"></span>` : ''}
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="save-expense" data-id="${x.id}">${ex ? 'Save' : 'Add expense'}</button>
    </div>`);
  if (!ex) setTimeout(() => $('#ex-title')?.focus(), 50);
}

/* ---------- Energy ---------- */
const ENERGY_RANGES = [['cycle', 'This bill'], ['last', 'Last bill'], ['90', '90 days'], ['12m', '12 months']];
views.energy = () => {
  const range = ENERGY_RANGES.some(([k]) => k === state.settings.energyRange) ? state.settings.energyRange : 'cycle';
  const all = energyDays();
  if (!all.length) {
    return `<div class="section-title">Energy</div>
    <div class="card energy-empty">${syncBanner()}
      <p class="hint">Once PG&amp;E data comes in, this page shows your use and cost for the current bill, past bills and the last year, split into electric and gas.</p></div>`;
  }
  const today = isoDay(new Date());
  const cur = cycleFor();
  const isBill = range === 'cycle' || range === 'last';
  const c = isBill && cur ? (range === 'last' ? previousCycle(cur) : cur) : null;
  const rows = energyRows(range);
  const t = energyTotals(rows);
  const perDay = t.days ? t.cost / t.days : 0;
  const fc = range === 'cycle' ? billForecast(c) : null;
  const bill = c && range === 'last' ? billed(c.start) : null;
  let note = '';
  if (isBill && !c) note = `<p class="hint cycle-note">Billing cycle dates come with the next morning's PG&amp;E sync. Until then this shows the last 30 days.</p>`;
  else if (range === 'cycle') {
    const dayN = Math.min(daysIncl(c.start, today), daysIncl(c.start, c.end));
    const left = daysIncl(today, c.end) - 1;
    note = `<div class="card cycle-bar"><div><small>Current bill</small><b>${cycleRange(c)}</b></div>
      <div><small>Day</small><b>${dayN} of ${daysIncl(c.start, c.end)}</b></div>
      <div><small>Days left</small><b>${Math.max(left, 0)}</b></div>
      <div class="cycle-progress"><span style="width:${Math.round((dayN / daysIncl(c.start, c.end)) * 100)}%"></span></div>
      <p class="hint">${c.known ? '' : 'Bill dates are estimated until PG&amp;E sends this cycle. '}PG&amp;E data through ${fmtShort(all[all.length - 1])}; the latest day or two can lag.</p></div>`;
  } else if (range === 'last') {
    note = `<p class="hint cycle-note">Last bill: ${cycleRange(c)} (${daysIncl(c.start, c.end)} days)${c.known ? '' : ', estimated dates'}.</p>`;
  }
  const lastTile = fc && fc.projected
    ? `<div class="card tile"><small>Projected bill</small><b>${fmtMoney(fc.projected)}</b><span>PG&amp;E's estimate${fc.typical ? ` · usually ${fmtMoney(fc.typical)}` : ''}</span></div>`
    : bill !== null
      ? `<div class="card tile"><small>Billed</small><b>${fmtMoney(bill)}</b><span>${fmtMoney(perDay)} a day on average</span></div>`
      : `<div class="card tile"><small>Average per day</small><b>${fmtMoney(perDay)}</b><span>${t.days ? (t.kwh / t.days).toFixed(1) : 0} kWh a day</span></div>`;

  // Past bills when cycle dates are known, calendar months otherwise.
  const starts = cycleStarts();
  let table;
  if (cur && starts.length >= 2) {
    const cycles = [];
    for (let x = cur, i = 0; x && i < 13; i++) {
      cycles.push(x);
      const p = previousCycle(x);
      if (!p.known) break; // only bills PG&E has actually sent
      x = p;
    }
    table = `<div class="card-head">${icon('calendar')}<h2>By bill</h2><span class="hint">Each PG&amp;E billing cycle, newest first</span></div>
    <div class="table-wrap"><table class="energy-table">
      <thead><tr><th>Bill</th><th>Electric</th><th>Gas</th><th>Total</th></tr></thead>
      <tbody>${cycles.map((x) => {
        const m = energyTotals(all.filter((d) => d >= x.start && d <= x.end).map((d) => ({ days: 1, ...dayTotal(d) })));
        const b = billed(x.start);
        const isCur = x.start === cur.start;
        return `<tr><td>${cycleRange(x)} <span class="muted">(${daysIncl(x.start, x.end)} days${isCur ? ', so far' : ''})</span></td>
          <td>${fmtMoney(m.eCost)} <span class="muted">${Math.round(m.kwh)} kWh</span></td>
          <td>${fmtMoney(m.gCost)} <span class="muted">${Math.round(m.therms)} therms</span></td>
          <td><b>${fmtMoney(m.cost)}</b>${b !== null && !isCur ? ` <span class="muted">billed ${fmtMoney(b)}</span>` : ''}</td></tr>`;
      }).join('')}</tbody>
    </table></div>`;
  } else {
    const months = energyRows('12m').filter((r) => r.days).reverse();
    table = `<div class="card-head">${icon('calendar')}<h2>By month</h2><span class="hint">PG&amp;E data through ${fmtShort(all[all.length - 1])}</span></div>
    <div class="table-wrap"><table class="energy-table">
      <thead><tr><th>Month</th><th>Electric</th><th>Gas</th><th>Total</th></tr></thead>
      <tbody>${months.map((m) => `<tr><td>${new Date(`${m.key}-15T12:00`).toLocaleDateString([], { month: 'long', year: 'numeric' })}${m.days < 28 ? ` <span class="muted">(${m.days} days)</span>` : ''}</td>
        <td>${fmtMoney(m.eCost)} <span class="muted">${Math.round(m.kwh)} kWh</span></td>
        <td>${fmtMoney(m.gCost)} <span class="muted">${Math.round(m.therms)} therms</span></td>
        <td><b>${fmtMoney(m.cost)}</b></td></tr>`).join('')}</tbody>
    </table></div>`;
  }

  return `<div class="section-title">Energy<span class="spacer"></span>
    <div class="seg">${ENERGY_RANGES.map(([k, l]) => `<button class="${range === k ? 'on' : ''}" data-action="energy-range" data-v="${k}">${l}</button>`).join('')}</div></div>
  ${syncBanner(true)}
  ${note}
  <div class="energy-tiles">
    <div class="card tile"><small>${range === 'cycle' && c ? 'So far this bill' : 'Total cost'}</small><b>${fmtMoney(t.cost)}</b><span>${t.days} day${t.days === 1 ? '' : 's'} of data</span></div>
    <div class="card tile"><small><i class="key-e"></i>Electric</small><b>${fmtMoney(t.eCost)}</b><span>${Math.round(t.kwh).toLocaleString()} kWh</span></div>
    <div class="card tile"><small><i class="key-g"></i>Gas</small><b>${fmtMoney(t.gCost)}</b><span>${Math.round(t.therms).toLocaleString()} therms</span></div>
    ${lastTile}
  </div>
  <div class="card energy-main">${energyChart(rows, 220)}</div>
  <div class="card">${table}</div>`;
};

views.health = () => {
  preloadGoogle().catch(() => {});
  refreshHealthQuietly();
  const people = healthPeople();
  const who = USERS.some((u) => u.id === state.settings.healthWho) ? state.settings.healthWho : (people[0]?.id || USERS[0].id);
  const pick = `<div class="seg">${USERS.map((u) => `<button class="${who === u.id ? 'on' : ''}" data-action="health-who" data-v="${u.id}">${u.name}</button>`).join('')}</div>`;
  const days = healthDays(who);
  const keys = Object.keys(days).sort();
  if (!healthAvailable()) {
    return `<div class="section-title">Health</div>
    <div class="card energy-empty"><div class="sync-banner">${icon('heart')}<span>Fitbit sign-in isn't set up for this site yet. See Settings for the one-time setup.</span></div></div>`;
  }
  if (!keys.length) {
    return `<div class="section-title">Health<span class="spacer"></span>${pick}</div>
    <div class="card energy-empty">${healthRow(who)}
      <p class="hint">Sign in with the Google account ${userOf(who).name}'s Fitbit uses. Steps, sleep, resting heart rate and weight for the last 30 days then show here, and on the household's other screens when sync is on.</p></div>`;
  }
  const metric = state.settings.unit === 'C';
  const today = isoDay(new Date());
  // The 7 full days before today, so a half-finished today doesn't pull the average down.
  const lastWeek = (f) => keys.filter((k) => k >= isoDay(addDays(new Date(), -7)) && k < today).map((k) => f(days[k])).filter((v) => v);
  const latest = (f) => { for (let i = keys.length - 1; i >= 0; i--) { const v = f(days[keys[i]]); if (v) return [v, keys[i]]; } return [null, null]; };
  const when = (k) => (k === today ? 'today' : k === isoDay(addDays(new Date(), -1)) ? 'yesterday' : fmtShort(k));

  const steps = days[today]?.steps || 0;
  const [sleep, sleepDay] = latest((d) => d.sleep?.[0] && d.sleep);
  const [rhr, rhrDay] = latest((d) => d.rhr);
  const [kg, kgDay] = latest((d) => d.kg);
  const weight = (v) => (metric ? `${v.toFixed(1)} kg` : `${(v * 2.20462).toFixed(1)} lb`);
  const dist = days[today]?.km ? (metric ? `${days[today].km.toFixed(1)} km` : `${(days[today].km * 0.621371).toFixed(1)} mi`) : '';
  const azm = keys.filter((k) => k > isoDay(addDays(new Date(), -7))).reduce((a, k) => a + (days[k].azm || 0), 0);

  const tiles = [
    `<div class="card tile"><small>${icon('activity')}Steps today</small><b>${steps.toLocaleString()}</b><span>${dist ? `${dist} · ` : ''}${Math.round(avgOf(lastWeek((d) => d.steps))).toLocaleString()} a day this week</span></div>`,
    `<div class="card tile"><small>${icon('moon')}Sleep</small><b>${sleep ? fmtMins(sleep[0]) : '–'}</b><span>${sleep ? `${when(sleepDay) === 'today' ? 'Last night' : `Night before ${when(sleepDay)}`} · deep ${fmtMins(sleep[1])}, REM ${fmtMins(sleep[3])}` : 'No sleep logged yet'}</span></div>`,
    `<div class="card tile"><small>${icon('heart')}Resting heart rate</small><b>${rhr ? `${rhr} bpm` : '–'}</b><span>${rhr ? `${when(rhrDay)}${lastWeek((d) => d.rhr).length ? ` · ${Math.round(avgOf(lastWeek((d) => d.rhr)))} bpm average this week` : ''}` : 'Not measured yet'}</span></div>`,
    kg ? `<div class="card tile"><small>Weight</small><b>${weight(kg)}</b><span>Last logged ${when(kgDay)}</span></div>`
      : `<div class="card tile"><small>${icon('zap')}Active zone minutes</small><b>${azm}</b><span>Last 7 days</span></div>`,
  ];
  const recent = keys.filter((k) => k > isoDay(addDays(new Date(), -7))).reverse();
  return `<div class="section-title">Health<span class="spacer"></span>${pick}</div>
  <div class="card health-status">${healthRow(who)}</div>
  <div class="energy-tiles">${tiles.join('')}</div>
  <div class="page-grid health-charts">
    <div class="card">${healthChart(who, 14, 'Steps, last 14 days', [[(d) => d.steps, 'bar-steps']], (v) => Math.round(v).toLocaleString())}</div>
    <div class="card">${healthChart(who, 14, 'Sleep, last 14 nights', [[(d) => d.sleep?.[1], 'bar-deep', 'Deep'], [(d) => d.sleep?.[3], 'bar-rem', 'REM'], [(d) => (d.sleep ? Math.max(d.sleep[0] - d.sleep[1] - d.sleep[3], 0) : 0), 'bar-light', 'Light']], fmtMins)}</div>
  </div>
  <div class="card"><div class="card-head">${icon('calendar')}<h2>This week</h2><span class="hint">${userOf(who).name}'s Fitbit</span></div>
    <div class="table-wrap"><table class="energy-table">
      <thead><tr><th>Day</th><th>Steps</th><th>Sleep</th><th>Resting HR</th><th>Zone min</th></tr></thead>
      <tbody>${recent.map((k) => { const d = days[k]; return `<tr><td>${new Date(`${k}T12:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</td>
        <td>${d.steps ? d.steps.toLocaleString() : '–'}</td><td>${d.sleep?.[0] ? fmtMins(d.sleep[0]) : '–'}</td>
        <td>${d.rhr ? `${d.rhr} bpm` : '–'}</td><td>${d.azm ?? '–'}</td></tr>`; }).join('')}</tbody>
    </table></div></div>`;
};

function healthCard() {
  preloadGoogle().catch(() => {});
  const head = `<div class="card-head">${icon('heart')}<h2>Fitbit health</h2></div>`;
  if (!healthAvailable()) {
    return `<div class="card">${head}
      <div class="sync-banner">${icon('heart')}<span>Not set up yet. Fitbit sign-in needs a one-time setup for this site.</span></div>
      <details class="setup" open><summary>One-time setup</summary><ol class="hint">
        <li>In Google Cloud, turn on the <b>Google Health API</b> and add each person's Google account as a test user.</li>
        <li>Create a <b>Web application</b> OAuth client with <code>${esc(location.origin)}</code> as an authorized JavaScript origin.</li>
        <li>Save its client ID as the GitHub secret <code>GOOGLE_HEALTH_CLIENT_ID</code> and run <b>Deploy to GitHub Pages</b>.</li>
      </ol></details></div>`;
  }
  return `<div class="card">${head}
    ${USERS.map((u) => healthRow(u.id)).join('')}
    <p class="hint">Each person signs in with the Google account their Fitbit uses. Google's pass lasts about an hour and stays on this screen only; the daily numbers are shared with the household when sync is on.</p>
    ${healthPeople().length ? `<div style="display:flex;gap:8px;flex-wrap:wrap">${healthPeople().map((u) => `<button class="btn ghost" data-action="health-disconnect" data-v="${u.id}">${icon('trash')} Remove ${u.name}'s data</button>`).join('')}</div>` : ''}
  </div>`;
}

views.settings = () => {
  const s = state.settings;
  return `
  <div class="section-title">Settings</div>
  <div class="page-grid" style="grid-template-columns:repeat(auto-fill,minmax(380px,1fr))">
    ${houseCard()}
    <div class="card">
      <div class="card-head">${icon('home')}<h2>Household</h2></div>
      <div class="profiles">${USERS.map((u) => `<div class="profile">${avatar(u.id, 'lg')}<b>${u.name}</b></div>`).join('')}</div>
      <div class="field"><label for="set-place">Weather location</label>
        <div style="display:flex;gap:8px"><input class="input" id="set-place" placeholder="Search a city" value="${esc(s.place.name)}">
        <button class="btn" data-action="place-search">${icon('search')}</button></div>
        <div class="chips" id="place-results"></div></div>
    </div>
    <div class="card">
      <div class="card-head">${icon('monitor')}<h2>Display</h2></div>
      <div class="setting-row"><div><b>Temperature</b></div>
        <div class="seg">${['F', 'C'].map((u) => `<button class="${s.unit === u ? 'on' : ''}" data-action="set-unit" data-v="${u}">°${u}</button>`).join('')}</div></div>
      <div class="setting-row"><div><b>Theme</b><div class="hint">Auto goes dark from 9 PM to 6 AM.</div></div>
        <div class="seg">${['auto', 'light', 'dark'].map((t) => `<button class="${s.theme === t ? 'on' : ''}" data-action="set-theme" data-v="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
      <div class="setting-row"><div><b>24-hour clock</b></div>
        <button class="switch" role="switch" aria-checked="${s.clock24}" data-action="set-clock24"></button></div>
      <div class="setting-row"><div><b>Keep screen on</b><div class="hint">Stops the screen from sleeping while the dashboard is open.</div></div>
        <button class="switch" role="switch" aria-checked="${s.wakeLock}" data-action="set-wake"></button></div>
    </div>
    <div class="card">
      <div class="card-head">${icon('zap')}<h2>PG&amp;E energy</h2></div>
      ${syncBanner(true, false)}
      <div class="field"><label for="energy-pass">Sync passphrase</label>
        <div style="display:flex;gap:8px"><input class="input" id="energy-pass" type="password" autocomplete="off" placeholder="${energyPass ? 'Saved on this device' : 'The ENERGY_PASSPHRASE you chose'}">
        <button class="btn" data-action="energy-connect">${energyPass ? 'Update' : 'Connect'}</button></div></div>
      <details class="setup"${energyPass ? '' : ' open'}><summary>How to sign in to PG&amp;E (one time)</summary>
        <p class="hint">This device never signs in to PG&amp;E itself. A GitHub job signs in to PG&amp;E every morning and saves your usage, locked with your passphrase.</p>
        <ol class="hint">
          <li>In the Home-Assistance repo on GitHub, open <b>Settings › Secrets and variables › Actions</b> and add <code>PGE_USERNAME</code>, <code>PGE_PASSWORD</code> and <code>ENERGY_PASSPHRASE</code> (a phrase you make up).</li>
          <li>PG&amp;E sends a code the first time a new device signs in. On your computer run <code>python3 sync/pge_pair.py</code>, enter the code, and save the line it prints as <code>PGE_LOGIN_DATA</code>.</li>
          <li>In the repo's <b>Actions</b> tab, run <b>Deploy to GitHub Pages</b>. It then runs every morning by itself.</li>
          <li>Type the same passphrase above and tap Connect.</li>
        </ol></details>
      <p class="hint">Or load a PG&amp;E <b>Download My Data</b> CSV by hand.${energyDays().length ? ` ${energyDays().length} days stored, ${fmtShort(energyDays()[0])} to ${fmtShort(energyDays().at(-1))}.` : ''}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <label class="btn ghost">${icon('plug')} Load PG&amp;E file<input type="file" id="energy-file" accept=".csv,text/csv" multiple hidden></label>
        ${energyPass ? `<button class="btn ghost" data-action="energy-disconnect">Stop syncing</button>` : ''}
        ${energyDays().length ? `<button class="btn ghost" data-action="clear-energy">${icon('trash')} Remove data</button>` : ''}
      </div>
    </div>
    ${healthCard()}
    <div class="card">
      <div class="card-head">${icon('sparkles')}<h2>About</h2></div>
      <p class="hint">Display settings stay on this device. Events, tasks and expenses are shared with your other devices when sync is on. Weather comes from Open-Meteo.</p>
      <button class="btn danger" data-action="reset">${icon('trash')} Clear events and tasks</button>
    </div>
  </div>`;
};

let wkScroll = null;
// Replays a CSS entrance animation on an element.
function animate(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  // Drop the class once it has played, so later re-renders don't replay it.
  clearTimeout(el.animTimer);
  el.animTimer = setTimeout(() => el.classList.remove(cls), 700);
}
function renderView(anim) {
  const r = currentRoute();
  const view = $('#view');
  const y = window.scrollY;
  const prev = $('#wk-scroll');
  if (prev) wkScroll = prev.scrollTop;
  view.innerHTML = views[r]();
  const wk = $('#wk-scroll');
  if (wk) wk.scrollTop = wkScroll ?? Math.max(0, (new Date().getHours() - DAY_START - 1) * HOUR_PX);
  window.scrollTo(0, y);
  if (anim === 'fwd' || anim === 'back') animate(view, `enter-${anim}`);
  else if (anim === 'cal') animate($('.cal-body'), 'fade-in');
}

let lastRoute = null;
function render() {
  const r = currentRoute();
  const order = (id) => PAGES.findIndex((p) => p.id === id);
  const anim = lastRoute && lastRoute !== r ? (order(r) > order(lastRoute) ? 'fwd' : 'back') : null;
  lastRoute = r;
  renderNav();
  renderView(anim);
  moveInk();
}

/* =========================================================
   Sheets (modal dialogs)
   ========================================================= */
let sheetTimer = null;
function openSheet(html) {
  clearTimeout(sheetTimer);
  $('#sheet').classList.remove('closing');
  $('#sheet-backdrop').classList.remove('closing');
  delete $('#sheet').dataset.kind;
  $('#sheet').innerHTML = html;
  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
  const first = $('#sheet').querySelector('input, textarea');
  if (first) setTimeout(() => first.focus(), 50);
}
// Plays the closing animation, then hides the sheet.
function closeSheet() {
  if ($('#sheet').hidden) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('#sheet').classList.add('closing');
  $('#sheet-backdrop').classList.add('closing');
  clearTimeout(sheetTimer);
  sheetTimer = setTimeout(() => {
    $('#sheet').hidden = true;
    $('#sheet-backdrop').hidden = true;
    $('#sheet').classList.remove('closing');
    $('#sheet-backdrop').classList.remove('closing');
  }, reduced ? 0 : 160);
}
const sheetHead = (title, ic) => `<h3>${icon(ic)}${title}<button class="btn-round close" data-action="close-sheet" aria-label="Close">${icon('x')}</button></h3>`;

// Person picker shared by the event and task sheets. `allowBoth` adds "Both" and "Anyone".
function whoPicker(selected, allowBoth) {
  const opts = [...USERS.map((u) => ({ id: u.id, label: u.name })), ...(allowBoth ? [{ id: 'both', label: 'Both' }, { id: '', label: 'Anyone' }] : [])];
  return `<div class="who-pick" id="who-pick">${opts.map((o) => `
    <button class="who-opt ${o.id === selected ? 'on' : ''}" data-action="pick-who" data-who="${o.id}">${avatar(o.id, 'sm') || `<span class="av-none">${icon('calendar')}</span>`}${o.label}</button>`).join('')}</div>`;
}
const pickedWho = () => $('#who-pick .who-opt.on')?.dataset.who ?? '';

function openEventSheet(ev, date, time = '') {
  const e = ev || { id: '', title: '', date, time, end: '', who: '' };
  openSheet(`${sheetHead(ev ? 'Edit event' : 'New event', 'calendar')}
    <div class="field"><label for="ev-title">Title</label><input class="input" id="ev-title" value="${esc(e.title)}" placeholder="e.g. Soccer practice"></div>
    <div class="field"><label>Who</label>${whoPicker(e.who, true)}</div>
    <div class="field-row">
      <div class="field"><label for="ev-date">Date</label><input class="input" type="date" id="ev-date" value="${e.date}"></div>
      <div class="field"><label for="ev-time">Starts</label><input class="input" type="time" id="ev-time" value="${e.time}"></div>
      <div class="field"><label for="ev-end">Ends</label><input class="input" type="time" id="ev-end" value="${e.end || ''}"></div>
    </div>
    <p class="hint">Leave Starts empty for an all-day event.</p>
    ${impRow(e.important)}
    <div class="sheet-actions">
      ${ev ? `<button class="btn danger" data-action="del-event" data-id="${e.id}">${icon('trash')} Delete</button><span class="spacer"></span>` : ''}
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="save-event" data-id="${e.id}">${ev ? 'Save' : 'Add event'}</button>
    </div>`);
}

function daySheetHtml(iso) {
  const evs = eventsOn(iso);
  const tasks = iso === isoDay(new Date()) ? tasksToday() : [];
  return `${sheetHead(new Date(`${iso}T12:00`).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }), 'calendar')}
    <div class="list">${evs.map((e) => eventRow(e)).join('') || '<p class="muted">No events.</p>'}</div>
    ${USERS.map((u) => {
      const mine = tasks.filter((t) => t.who === u.id);
      return mine.length ? `<h3 class="sheet-sub">${avatar(u.id, 'xs')}${u.name}'s tasks</h3>
        <div class="task-list">${mine.map((t) => taskCard(t, u)).join('')}</div>` : '';
    }).join('')}
    <div class="sheet-actions"><button class="btn" data-action="add-event" data-d="${iso}">${icon('plus')} Add event</button></div>`;
}

function openDaySheet(iso) {
  openSheet(daySheetHtml(iso));
  $('#sheet').dataset.kind = 'day';
  $('#sheet').dataset.d = iso;
}

function openTaskSheet(task, who = USERS[0].id) {
  const t = task || { id: '', title: '', who, repeat: 'daily', stars: 5 };
  openSheet(`${sheetHead(task ? 'Edit task' : 'New task', 'checkSquare')}
    <div class="field"><label for="task-title">Task</label><input class="input" id="task-title" value="${esc(t.title)}" placeholder="e.g. Take out trash"></div>
    <div class="field"><label>Assigned to</label>${whoPicker(t.who, false)}</div>
    ${impRow(t.important)}
    <div class="field-row">
      <div class="field"><label>Repeats</label><div class="seg" id="task-repeat">${Object.entries(REPEAT_LABEL).map(([k, l]) => `<button class="${t.repeat === k ? 'on' : ''}" data-action="pick-seg" data-v="${k}">${l}</button>`).join('')}</div></div>
      <div class="field"><label>Stars</label><div class="seg" id="task-stars">${[1, 3, 5, 10].map((n) => `<button class="${t.stars === n ? 'on' : ''}" data-action="pick-seg" data-v="${n}">${n}</button>`).join('')}</div></div>
    </div>
    <div class="sheet-actions">
      ${task ? `<button class="btn danger" data-action="del-task" data-id="${t.id}">${icon('trash')} Delete</button><span class="spacer"></span>` : ''}
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="save-task" data-id="${t.id}">${task ? 'Save' : 'Add task'}</button>
    </div>`);
}

/* =========================================================
   Actions
   ========================================================= */
const actions = {
  'close-sheet': closeSheet,
  'pick-who': (el) => {
    el.parentElement.querySelectorAll('.who-opt').forEach((b) => b.classList.toggle('on', b === el));
  },
  'toggle-important': (el) => el.setAttribute('aria-checked', String(el.getAttribute('aria-checked') !== 'true')),
  'pick-seg': (el) => {
    el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
  },

  'cal-move': (el) => {
    const d = Number(el.dataset.d);
    calCursor = state.settings.calView === 'month'
      ? new Date(calCursor.getFullYear(), calCursor.getMonth() + d, 1)
      : addDays(calCursor, d * 7);
  },
  'cal-today': () => { calCursor = new Date(); },
  'cal-view': (el) => { state.settings.calView = el.dataset.v; save(); },
  'open-day': (el) => openDaySheet(el.dataset.d),
  'add-event': (el) => openEventSheet(null, el.dataset.d),
  'add-event-at': (el, e) => {
    const y = e.clientY - el.getBoundingClientRect().top;
    const h = Math.min(DAY_END - 1, DAY_START + Math.floor(y / HOUR_PX));
    openEventSheet(null, el.dataset.d, `${String(h).padStart(2, '0')}:00`);
  },
  'edit-event': (el) => openEventSheet(state.events.find((x) => x.id === el.dataset.id)),
  'save-event': (el) => {
    const title = $('#ev-title').value.trim();
    const date = $('#ev-date').value;
    if (!title || !date) { toast('Add a title and a date'); return; }
    const data = { title, date, time: $('#ev-time').value || '', end: $('#ev-end').value || '', who: pickedWho(), important: pickedImportant() };
    const existing = state.events.find((x) => x.id === el.dataset.id);
    if (existing) Object.assign(existing, data);
    else state.events.push({ id: `e${Date.now()}`, ...data });
    calCursor = new Date(`${date}T12:00`);
    closeSheet();
  },
  'del-event': (el) => {
    state.events = state.events.filter((e) => e.id !== el.dataset.id);
    closeSheet();
  },

  'add-task': (el) => openTaskSheet(null, el.dataset.who),
  'edit-task': (el) => openTaskSheet(state.tasks.find((x) => x.id === el.dataset.id)),
  'save-task': (el) => {
    const title = $('#task-title').value.trim();
    if (!title) { toast('Name the task first'); return; }
    const data = {
      title,
      who: pickedWho() || USERS[0].id,
      repeat: $('#task-repeat .on')?.dataset.v || 'daily',
      stars: Number($('#task-stars .on')?.dataset.v || 5),
      important: pickedImportant(),
    };
    const existing = state.tasks.find((x) => x.id === el.dataset.id);
    if (existing) Object.assign(existing, data);
    else state.tasks.push({ id: `t${Date.now()}`, doneOn: '', ...data });
    closeSheet();
  },
  'del-task': (el) => {
    state.tasks = state.tasks.filter((t) => t.id !== el.dataset.id);
    closeSheet();
  },
  'toggle-task': (el) => {
    const t = state.tasks.find((x) => x.id === el.dataset.id);
    const done = isDone(t);
    t.doneOn = done ? '' : isoDay(new Date());
    state.stars[t.who] = Math.max(0, (state.stars[t.who] || 0) + (done ? -t.stars : t.stars));
    if (!done) toast(`+${t.stars} stars for ${userOf(t.who).name}`);
    // Ticked from the day pop-up: redraw it so the tick shows there too.
    const sheet = $('#sheet');
    if (!sheet.hidden && sheet.dataset.kind === 'day') sheet.innerHTML = daySheetHtml(sheet.dataset.d);
  },

  'set-unit': (el) => { state.settings.unit = el.dataset.v; save(); fetchWeather(); },
  'set-theme': (el) => { state.settings.theme = el.dataset.v; save(); applyTheme(); tickClock(); },
  'set-clock24': () => { state.settings.clock24 = !state.settings.clock24; save(); tickClock(); },
  'set-wake': () => { state.settings.wakeLock = !state.settings.wakeLock; save(); syncWakeLock(); },
  'place-search': searchPlace,
  'pick-place': (el) => {
    state.settings.place = { name: el.dataset.name, lat: Number(el.dataset.lat), lon: Number(el.dataset.lon) };
    save();
    toast(`Weather location set to ${el.dataset.name}`);
    fetchWeather();
  },
  'energy-range': (el) => { state.settings.energyRange = el.dataset.v; save(); },
  'house-connect': async (el) => {
    const popup = houseSheetOpen() && !!el.closest('.sheet');
    const input = houseInput(el);
    const v = input?.value || '';
    if (!v) { toast('Type the passphrase first'); return; }
    input.blur();
    if (v !== housePass) house.disconnect();
    if (popup) { houseSync = { state: 'connecting' }; openHouseSheet(); }
    const r = await house.connect(v);
    if (r === 'new') houseTyped = v;
    if (r === 'ok') {
      housePass = v; try { localStorage.setItem(HOUSE_PASS_KEY, v); } catch { /* ignore */ }
      toast('Synced');
      if (popup) closeSheet();
    } else if (popup) openHouseSheet();
    renderView();
  },
  'house-create': async () => {
    if (!houseTyped) return;
    const popup = houseSheetOpen();
    const r = await house.connect(houseTyped, { create: true });
    if (r === 'ok') {
      housePass = houseTyped; try { localStorage.setItem(HOUSE_PASS_KEY, housePass); } catch { /* ignore */ }
      toast('Household created');
      if (popup) closeSheet();
    } else if (popup) openHouseSheet();
    houseTyped = ''; renderView();
  },
  'house-cancel': () => {
    houseTyped = ''; houseSync = { state: housePass ? 'ok' : 'off' };
    if (houseSheetOpen()) openHouseSheet();
  },
  'house-disconnect': () => {
    house.disconnect(); housePass = '';
    try { localStorage.removeItem(HOUSE_PASS_KEY); } catch { /* ignore */ }
  },
  'energy-connect': () => {
    const v = $('#energy-pass').value;
    if (!v) { toast('Type the passphrase first'); return; }
    energyPass = v;
    try { localStorage.setItem(PASS_KEY, v); } catch { /* ignore */ }
    energySync = { state: 'checking' };
    $('#energy-pass').blur();
    syncEnergy();
  },
  'energy-disconnect': () => {
    energyPass = '';
    try { localStorage.removeItem(PASS_KEY); } catch { /* ignore */ }
    energySync = { state: 'off' };
  },
  'health-who': (el) => { state.settings.healthWho = el.dataset.v; },
  'health-connect': (el) => connectHealth(el.dataset.v, false),
  'health-update': (el) => {
    const t = passFor(el.dataset.v);
    if (t) pullHealth(el.dataset.v, t); else connectHealth(el.dataset.v, true);
  },
  'health-disconnect': (el) => {
    const who = el.dataset.v;
    if (healthPasses[who]) signOut(healthPasses[who].token);
    delete healthPasses[who]; savePasses();
    delete state.health[who]; delete healthNote[who];
    toast(`${userOf(who).name}'s health data removed`);
  },
  'clear-energy': () => { energy = null; try { localStorage.removeItem(ENERGY_KEY); } catch { /* ignore */ } toast('Energy data removed'); },
  'add-expense': () => openExpenseSheet(null),
  'edit-expense': (el) => openExpenseSheet(state.expenses.find((x) => x.id === el.dataset.id)),
  'save-expense': (el) => {
    const title = $('#ex-title').value.trim();
    const amount = Math.round(Number($('#ex-amount').value) * 100) / 100;
    const date = $('#ex-date').value;
    if (!title || !(amount > 0) || !date) { toast('Add what it was, the amount and the day'); return; }
    const data = { title, amount, date, paidBy: pickedWho() || USERS[0].id, split: $('#ex-split').getAttribute('aria-checked') === 'true' };
    const existing = state.expenses.find((x) => x.id === el.dataset.id);
    if (existing) Object.assign(existing, data);
    else state.expenses.push({ id: `x${Date.now()}`, ...data });
    piggyMonth = date.slice(0, 7);
    closeSheet();
  },
  'del-expense': (el) => {
    state.expenses = state.expenses.filter((x) => x.id !== el.dataset.id);
    closeSheet();
  },
  'piggy-move': (el) => {
    const [y, m] = piggyMonth.split('-').map(Number);
    piggyMonth = monthKey(new Date(y, m - 1 + Number(el.dataset.d), 1));
  },
  'piggy-today': () => { piggyMonth = monthKey(new Date()); },
  'piggy-goto': (el) => { piggyMonth = el.dataset.m; window.scrollTo({ top: 0, behavior: 'smooth' }); },
  'toggle-split': () => { state.settings.showSplit = !state.settings.showSplit; },

  reset: () => {
    if (!confirm('Clear all events and tasks on this device?')) return;
    state = { ...defaultState(), settings: state.settings, expenses: state.expenses, health: state.health, events: [], tasks: [] };
    save();
  },
};

// Actions that only open or edit a sheet don't need the page behind it re-rendered.
const NO_RERENDER = new Set(['pick-who', 'pick-seg', 'toggle-important', 'open-day', 'add-event', 'add-event-at', 'edit-event', 'add-task', 'edit-task', 'place-search', 'add-expense', 'edit-expense']);

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const name = el.dataset.action;
  const fn = actions[name];
  if (!fn) return;
  fn(el, e);
  save();
  if (!NO_RERENDER.has(name)) renderView(['cal-move', 'cal-today', 'cal-view'].includes(name) ? 'cal' : undefined);
});

$('#sheet-backdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

// Refresh the page behind a sheet when it closes, so a saved event or task shows up.
const sheetObserver = new MutationObserver(() => { if ($('#sheet').hidden) renderView(); });
sheetObserver.observe($('#sheet'), { attributes: true, attributeFilter: ['hidden'] });

document.addEventListener('change', async (e) => {
  if (e.target.id !== 'energy-file') return;
  let read = 0;
  for (const f of e.target.files) read += importGreenButton(await f.text());
  toast(read ? `Energy data now covers ${energyDays().length} days` : "That file doesn't look like a PG&E Download My Data CSV");
  renderView();
});

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'set-place' && e.key === 'Enter') searchPlace();
  if (e.target.matches?.('[data-house-pass]') && e.key === 'Enter') e.target.closest('.sheet, .card')?.querySelector('[data-action="house-connect"]')?.click();
});

async function searchPlace() {
  const q = $('#set-place').value.trim();
  const out = $('#place-results');
  if (!q) return;
  out.innerHTML = '<span class="hint">Searching…</span>';
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en`);
    const d = await res.json();
    if (!d.results?.length) { out.innerHTML = '<span class="hint">No matches.</span>'; return; }
    out.innerHTML = d.results.map((r) => `
      <button class="chip" data-action="pick-place" data-name="${esc(r.name)}" data-lat="${r.latitude}" data-lon="${r.longitude}">
        ${esc(r.name)}<span class="muted">${esc([r.admin1, r.country_code].filter(Boolean).join(', '))}</span></button>`).join('');
  } catch {
    out.innerHTML = '<span class="hint">Search failed. Check the connection.</span>';
  }
}

/* =========================================================
   Keep the screen awake (Wake Lock API)
   ========================================================= */
let wakeLock = null;
async function syncWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (state.settings.wakeLock && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!state.settings.wakeLock && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* needs a user gesture on some browsers; retried on next tap */ }
}
document.addEventListener('visibilitychange', syncWakeLock);
document.addEventListener('pointerup', () => { if (state.settings.wakeLock && !wakeLock) syncWakeLock(); });

/* =========================================================
   Boot
   ========================================================= */
hydrateIcons();
applyTheme();
tickClock();
setTimeout(() => { skyReady = true; tickClock(); }, 400);
render();
fetchWeather();
syncEnergy();
syncWakeLock();
if (housePass && syncAvailable()) {
  let savedBase = null;
  try { savedBase = JSON.parse(localStorage.getItem(HOUSE_BASE_KEY)); } catch { savedBase = null; }
  house.resume(housePass, savedBase);
} else if (syncAvailable()) {
  openHouseSheet(); // not in a household yet: ask every time the app opens
}
window.addEventListener('online', () => house.retry());

window.addEventListener('hashchange', () => {
  closeSheet();
  window.scrollTo(0, 0);
  render();
});

let lastMinute = new Date().getMinutes();
setInterval(() => {
  tickClock();
  const m = new Date().getMinutes();
  if (m !== lastMinute) {
    lastMinute = m;
    applyTheme();
    // Refresh relative times ("2 minutes ago") without disturbing open dialogs or typing.
    if ($('#sheet').hidden && !document.activeElement?.matches('input, textarea')) renderView();
  }
}, 1000);
setInterval(fetchWeather, 15 * 60 * 1000);
setInterval(syncEnergy, 60 * 60 * 1000);
setInterval(refreshHealthQuietly, 30 * 60 * 1000);
window.addEventListener('online', () => { fetchWeather(); syncEnergy(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
