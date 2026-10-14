import { icon, hydrateIcons } from './icons.js';
import { createSync, syncAvailable } from './sync.js';
import { FRIDGE_CATS, guessCat, readReceipt } from './receipt.js';
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
    log: [],
    expenses: [],
    fridge: [],
    thanks: [],
    notes: [],
    bucket: [],
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

// A short note at the bottom of the screen. `undo` is an optional [label, fn] button.
function toast(msg, undo) {
  const el = $('#toast');
  el.textContent = msg;
  if (undo) {
    const b = Object.assign(document.createElement('button'), { className: 'toast-btn', textContent: undo[0] });
    b.onclick = (e) => { e.stopPropagation(); el.hidden = true; undo[1](); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, undo ? 4500 : 2200);
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

// A new greeting each day, the same on every screen.
const GREETINGS = {
  night: ['Still up', 'Hello, night owls', 'Sweet dreams soon', 'Bedtime yet', 'Midnight snack', 'Psst, go to sleep'],
  morning: ['Good morning', 'Rise and shine', 'Coffee first', 'Up and at it', 'Morning, sleepyheads', 'Hello, sunshine', 'Wakey wakey', 'Top of the morning', 'Fresh day, who dis'],
  afternoon: ['Good afternoon', 'Snack o\'clock', 'Halfway there', 'Keep it rolling', 'Nap time', 'Hey there, legends', 'Hang in there', 'Hello, busy bees'],
  evening: ['Good evening', 'Dinner time', 'Couch time', 'You made it', 'Evening, chefs', 'Feet up', 'What\'s for dinner', 'Day done, well done'],
};
function greeting(now) {
  const h = now.getHours();
  const list = GREETINGS[h < 5 || h >= 22 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'];
  const day = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / 864e5);
  return list[day % list.length];
}

function tickClock() {
  const now = new Date();
  const h = now.getHours();
  const line = greeting(now), names = USERS.map((u) => u.name).join(' and ');
  const g = $('#greeting');
  if (g.dataset.line !== line) {
    g.dataset.line = line;
    g.innerHTML = `<span class="punch">${line}, <span class="nowrap">${names}</span></span>`;
  }
  $('#date').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
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
  // On a narrow panel the text fills the left side, so the arc stays on the right.
  // On a phone the weather takes the bottom row, so the arc stays above it.
  const narrow = hero.clientWidth < 600;
  const x = narrow ? 72 + p * 22 : 30 + p * 64;
  const y = narrow ? 66 - Math.sin(p * Math.PI) * 48 : 92 - Math.sin(p * Math.PI) * 78;
  if (skyReady) {
    orb.style.left = `${x.toFixed(2)}%`;
    orb.style.top = `${y.toFixed(2)}%`;
  }
  orb.dataset.kind = sky.kind;
  // Sky color follows the real sun: warm morning until 11, bright midday, a sunset glow from
  // ninety minutes before sunset until 45 minutes after, then night.
  let pod = 'night';
  const h = new Date(now).getHours();
  if (sky.kind === 'sun') pod = sky.set - now < 54e5 ? 'evening' : h < 11 ? 'morning' : 'day';
  else if (now - sky.set >= 0 && now - sky.set < 27e5) pod = 'evening';
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
  const sunLine = sky.kind === 'sun'
    ? `Sunset at ${fmtTime(new Date(sky.set))}`
    : `Sunrise at ${fmtTime(new Date(now < sky.rise ? sky.rise : sunToday().nextRise))}`;
  if ($('#sun-note').textContent !== sunLine) $('#sun-note').textContent = sunLine;
  // Weather sits in the panel's corner; there is no separate card to wait on.
  const wx = weatherValid()
    ? `${icon(wmo(weather.code, weather.isDay).icon)}<b>${Math.round(weather.temp)}°</b><span><em>${wmo(weather.code, weather.isDay).label}</em><em>H ${Math.round(weather.hi)}° · L ${Math.round(weather.lo)}°</em></span>` : '';
  const box = $('#hero-wx');
  if (box.dataset.v !== wx) { box.innerHTML = wx; box.dataset.v = wx; }
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
    : `<div class="sync-banner">${icon('zap')}<span>${m.text.replace(/ in Settings/, ' below')}</span></div>`;
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
    const { days, skipped, reasons } = await readDays(token);
    const mine = state.health[who]?.days || {};
    const cutoff = isoDay(addDays(new Date(), -120));
    const merged = Object.fromEntries(Object.entries({ ...mine, ...Object.fromEntries(Object.entries(days).map(([d, v]) => [d, { ...mine[d], ...v }])) })
      .filter(([d]) => d >= cutoff).sort(([a], [b]) => a.localeCompare(b)));
    state.health[who] = { at: Date.now(), days: merged };
    // Say what Google answered, so a missing permission and a Fitbit-side problem look different.
    if (skipped.length) healthNote[who] = `Couldn't read ${skipped.map((k) => `${k} (${reasons[k]})`).join(', ')}. If Google mentions permission, tap Update and allow every box on Google's screen.`;
    else if (!Object.values(days).some((d) => d.sleep)) healthNote[who] = 'Fitbit returned no sleep for the last 30 days. Check that the watch was worn overnight and has synced in the Fitbit app.';
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
// Three pages you use every day get a tab; the rest sit in the half circle under More.
// The More pages are listed left to right around the arc; sliding straight up from More picks Settings.
const PAGES = [
  { id: 'home', label: 'Home', icon: 'home', main: true },
  { id: 'calendar', label: 'Calendar', icon: 'calendar', main: true },
  { id: 'tasks', label: 'Chores', icon: 'checkSquare', main: true },
  { id: 'fridge', label: 'Kitchen', icon: 'fridge' },
  { id: 'piggy', label: 'Money', icon: 'piggy' },
  { id: 'bucket', label: 'Bucket list', icon: 'sparkles' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'energy', label: 'Energy', icon: 'zap' },
  { id: 'health', label: 'Health', icon: 'heart' },
];
const MAIN = PAGES.filter((p) => p.main);
const MORE = PAGES.filter((p) => !p.main);
const ROUTE_ALIAS = { board: 'tasks' }; // the Leaderboard now lives on Chores

const currentRoute = () => {
  let r = location.hash.replace(/^#\/?/, '').split('?')[0];
  r = ROUTE_ALIAS[r] || r;
  return PAGES.some((p) => p.id === r) ? r : 'home';
};

// The tabs are drawn once; switching tabs slides the highlight to the new one.
// They float as a see-through bar at the bottom of every screen. While a More page is open,
// the More tab wears that page's icon and name.
function renderNav() {
  const r = currentRoute();
  const tabs = $('#tabs');
  if (!tabs.children.length) {
    // More sits in the middle, so sliding straight up from it lands on Settings at the top of the half circle.
    const tab = (p) => `<a class="tab" href="#/${p.id}" data-page="${p.id}">${icon(p.icon)}<span>${p.label}</span></a>`;
    tabs.innerHTML = `<span class="tab-ink" aria-hidden="true"></span>${MAIN.slice(0, 2).map(tab).join('')}
      <button class="tab" data-page="more" aria-haspopup="menu" aria-expanded="false"></button>${MAIN.slice(2).map(tab).join('')}`;
  }
  const on = MAIN.some((p) => p.id === r) ? r : 'more';
  tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.page === on));
  const m = MORE.find((p) => p.id === r);
  const more = tabs.querySelector('[data-page="more"]');
  const key = m ? m.id : 'more';
  if (more.dataset.shows !== key) {
    more.dataset.shows = key;
    more.innerHTML = m ? `${icon(m.icon)}<span>${m.label}</span>` : `${icon('more', 'more-dots')}<span>More</span>`;
    more.setAttribute('aria-label', m ? `More, showing ${m.label}` : 'More');
  }
  closeDome();
  moveInk();
}
// The highlight is placed by measuring the tab, so it works for the bottom bar and the side rail alike.
function tabBox(t) {
  const bar = t.parentElement;
  const a = t.getBoundingClientRect(); const b = bar.getBoundingClientRect();
  return { left: a.left - b.left + bar.scrollLeft - bar.clientLeft, top: a.top - b.top + bar.scrollTop - bar.clientTop, width: a.width, height: a.height };
}
function placeInk(box) {
  const ink = $('#tabs .tab-ink');
  if (!ink || !box) return;
  ink.style.width = `${box.width}px`; ink.style.height = `${box.height}px`;
  ink.style.transform = `translate(${box.left}px, ${box.top}px)`;
}
// While the half circle is open the highlight sits on More, so only one thing is lit at a time.
function moveInk() {
  const t = document.body.classList.contains('dome-open') ? $('#tabs [data-page="more"]') : $('#tabs .tab.active');
  if (t) placeInk(tabBox(t));
}
/* ---------- More: a half circle that opens out of the More tab ----------
   Tap More, then tap a page. Or hold More, slide up, then left or right: a ring follows the finger
   and the page under it opens on release. Sliding along the bar picks a main tab the same way. */
const ARC = [160, 132, 104, 76, 48, 20]; // degrees, left to right, one per More page
const UP = MORE.findIndex((p) => p.id === 'settings'); // straight up from More
let domeOpen = false;
let dome = null; // geometry of the open half circle, in screen pixels
function buildDome() {
  const bar = $('#tabs').getBoundingClientRect();
  const R = Math.round(Math.min(window.innerWidth / 2 - 12, window.innerWidth >= 900 ? 270 : 186));
  const big = R > 220;
  dome = { cx: bar.left + bar.width / 2, cy: bar.top - 8, R, r: Math.round(R * 0.72), orb: big ? 70 : 48, lens: big ? 86 : 60 };
  const rad = (a) => (a * Math.PI) / 180;
  dome.xs = ARC.map((a) => dome.cx + dome.r * Math.cos(rad(a)));
  const r = currentRoute();
  const el = $('#dome');
  el.innerHTML = `<div class="dome-disc" style="left:${dome.cx - R}px;top:${dome.cy - R}px;width:${2 * R}px;height:${R}px"></div>
    <div class="dome-arm" style="left:${dome.cx}px;top:${dome.cy}px;--r:${dome.r}px;--lens:${dome.lens}px"><span class="dome-lens"></span></div>
    ${MORE.map((p, i) => `<a class="orb${p.id === r ? ' on' : ''}" role="menuitem" href="#/${p.id}" data-i="${i}" style="--orb:${dome.orb}px;--d:${Math.abs(i - (MORE.length - 1) / 2)};left:${dome.xs[i].toFixed(1)}px;top:${(dome.cy - dome.r * Math.sin(rad(ARC[i]))).toFixed(1)}px">${icon(p.icon)}<span class="orb-lbl">${p.label}</span></a>`).join('')}
    <div class="dome-hint" style="left:${dome.cx}px;top:${dome.cy - 18}px">Slide left or right</div>`;
  el.classList.toggle('big', big);
  // Revealed by a circle growing out of the More tab.
  const mb = $('#tabs [data-page="more"]').getBoundingClientRect();
  const mx = mb.left + mb.width / 2; const my = mb.top + mb.height / 2;
  el.style.setProperty('--mx', `${mx}px`); el.style.setProperty('--my', `${my}px`);
  el.style.setProperty('--reach', `${Math.ceil(Math.hypot(Math.max(mx - (dome.cx - R), dome.cx + R - mx), my - (dome.cy - R))) + 24}px`);
}
const moreIndex = () => MORE.findIndex((p) => p.id === currentRoute());
// The ring swings around the rim to the page picked.
function placeLens(i) {
  const arm = $('#dome .dome-arm');
  if (!arm) return;
  arm.style.opacity = i < 0 ? 0 : 1;
  if (i >= 0) arm.style.setProperty('--a', ARC[i]);
}
function openDome() {
  if (domeOpen || !$('#sheet').hidden) return;
  domeOpen = true;
  buildDome();
  const arm = $('#dome .dome-arm');
  arm.style.transition = 'none'; placeLens(moreIndex()); void arm.offsetWidth; arm.style.transition = '';
  $('#dome').getBoundingClientRect(); // start the reveal from closed
  $('#dome').classList.add('open');
  document.body.classList.add('dome-open');
  $('#tabs [data-page="more"]').setAttribute('aria-expanded', 'true');
  moveInk();
}
function closeDome() {
  if (!domeOpen) return;
  domeOpen = false;
  $('#dome').classList.remove('open');
  document.body.classList.remove('dome-open');
  $('#tabs [data-page="more"]')?.setAttribute('aria-expanded', 'false');
  moveInk();
}
// Above the bar, the page is picked by how far left or right the finger is: whichever page sits
// closest sideways wins. So from More you slide up and then sideways, and the page nearest More
// (Health) is the one right above it. On a fresh press the finger has to be on the half circle itself.
function domeSlot(x, y, sliding) {
  if (!domeOpen || !dome) return null;
  // A slide that began on More keeps steering the half circle even while the finger is still over the bar.
  if ((!sliding && y > dome.cy + 6) || y < dome.cy - dome.R - 80) return null;
  if (!sliding && Math.hypot(x - dome.cx, dome.cy - y) > dome.R + 10) return null;
  let best = 0;
  dome.xs.forEach((v, i) => { if (Math.abs(v - x) < Math.abs(dome.xs[best] - x)) best = i; });
  return best;
}
function barSlot(x, y) {
  const r = $('#tabs').getBoundingClientRect();
  if (x < r.left - 8 || x > r.right + 8 || y < r.top - 10 || y > r.bottom + 30) return null;
  const tabs = [...$('#tabs').querySelectorAll('.tab')];
  return Math.max(0, Math.min(tabs.length - 1, Math.floor(((x - r.left) / r.width) * tabs.length)));
}
const navGesture = { id: null };
function navTrack(e) {
  const g = navGesture;
  // A press that starts on More (or on the half circle) only ever picks from the half circle;
  // the bar's own tabs answer only to presses that start on them.
  let pop = g.from === 'bar' ? null : g.from === 'more' && !g.moved ? null : domeSlot(e.clientX, e.clientY, true);
  // From More, the pick follows how far the finger has moved sideways from where it pressed:
  // straight up is Settings, then one page per step left or right.
  if (pop !== null && g.from === 'more') {
    const step = Math.max(48, (dome.xs[MORE.length - 1] - dome.xs[0]) / (MORE.length - 1));
    pop = Math.max(0, Math.min(MORE.length - 1, UP + Math.round((e.clientX - g.x) / step)));
  }
  const bar = g.from === 'bar' ? barSlot(e.clientX, e.clientY) : null;
  if (pop !== g.pop || bar !== g.bar) { if ((pop ?? bar) !== null && g.moved) navigator.vibrate?.(6); }
  g.pop = pop; g.bar = bar;
  $('#dome').querySelectorAll('.orb').forEach((o, i) => o.classList.toggle('hot', i === pop));
  const tabs = [...$('#tabs').querySelectorAll('.tab')];
  tabs.forEach((t, i) => t.classList.toggle('hot', i === bar));
  placeLens(pop ?? moreIndex());
  if (bar !== null) placeInk(tabBox(tabs[bar])); else moveInk();
}
function navStart(e) {
  if (navGesture.id !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const pop = domeSlot(e.clientX, e.clientY);
  const bar = pop === null ? barSlot(e.clientX, e.clientY) : null;
  if (pop === null && bar === null) { if (domeOpen) { e.preventDefault(); closeDome(); moveInk(); } return; }
  e.preventDefault();
  e.currentTarget.setPointerCapture(e.pointerId);
  const from = pop !== null ? 'pop' : $('#tabs').querySelectorAll('.tab')[bar].dataset.page === 'more' ? 'more' : 'bar';
  Object.assign(navGesture, { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, from, pop: null, bar: null, opened: false });
  if (from === 'more' && !domeOpen) { openDome(); navGesture.opened = true; }
  $('#tabs').classList.add('scrubbing'); $('#dome').classList.add('scrubbing');
  navTrack(e);
}
function navMove(e) {
  if (e.pointerId !== navGesture.id) return;
  if (!navGesture.moved && Math.hypot(e.clientX - navGesture.x, e.clientY - navGesture.y) > 6) navGesture.moved = true;
  navTrack(e);
}
const goTo = (id) => { if (id === currentRoute()) render(); else location.hash = `#/${id}`; };
function navEnd(e, cancelled) {
  const g = navGesture;
  if (e.pointerId !== g.id) return;
  g.id = null;
  $('#tabs').classList.remove('scrubbing'); $('#dome').classList.remove('scrubbing');
  document.querySelectorAll('#tabs .hot, #dome .hot').forEach((x) => x.classList.remove('hot'));
  if (!cancelled && g.pop !== null) { closeDome(); goTo(MORE[g.pop].id); return; }
  // A tap on More opens the half circle and leaves it open; tapping More again closes it.
  if (g.from === 'more') { if (!cancelled && !g.opened && !g.moved) closeDome(); placeLens(moreIndex()); moveInk(); return; }
  const page = g.bar !== null && $('#tabs').querySelectorAll('.tab')[g.bar].dataset.page;
  if (!cancelled && page && page !== 'more') { closeDome(); goTo(page); return; }
  placeLens(moreIndex()); moveInk();
}
for (const el of [$('#tabs'), $('#dome')]) {
  el.addEventListener('pointerdown', navStart);
  el.addEventListener('pointermove', navMove);
  el.addEventListener('pointerup', (e) => navEnd(e, false));
  el.addEventListener('pointercancel', (e) => navEnd(e, true));
  // Taps are handled above; only keyboard presses (detail 0) go through as clicks.
  el.addEventListener('click', (e) => {
    if (e.detail !== 0) { e.preventDefault(); return; }
    if (e.target.closest('[data-page="more"]')) { e.preventDefault(); domeOpen ? closeDome() : (openDome(), $('#dome .orb')?.focus()); }
  });
}
$('#dome-scrim').addEventListener('pointerdown', (e) => { e.preventDefault(); closeDome(); placeLens(moreIndex()); moveInk(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && domeOpen) { closeDome(); $('#tabs [data-page="more"]').focus(); } });
window.addEventListener('resize', () => { if (domeOpen) closeDome(); });

// One add button, in the same corner on every page. Pages that can add more than one kind of
// thing open a short menu.
const FAB = {
  home: { action: 'add-menu', label: 'Add' },
  calendar: { action: 'add-event', label: 'Add event' },
  tasks: { action: 'add-task', label: 'Add chore' },
  fridge: { action: 'add-menu', label: 'Add to kitchen' },
  piggy: { action: 'add-expense', label: 'Add expense' },
  bucket: { action: 'add-bucket', label: 'Add to the bucket list' },
};
function setFab(r) {
  const fab = $('#fab'); const f = FAB[r];
  fab.hidden = !f;
  if (!f) return;
  fab.dataset.action = f.action;
  fab.dataset.d = isoDay(new Date());
  fab.setAttribute('aria-label', f.label);
  if (!fab.firstChild) fab.innerHTML = icon('plus');
}
function openAddMenu() {
  const opt = (action, ic, title, note) => `<button class="row" data-action="${action}" data-d="${isoDay(new Date())}"><span class="ibox c-purple-ico">${icon(ic)}</span><span><b>${title}</b><small>${note}</small></span>${icon('chevron', 'chev')}</button>`;
  const scan = `<label class="row"><span class="ibox c-purple-ico">${icon('receipt')}</span><span><b>Scan a receipt</b><small>Snap a grocery receipt and pick what goes in</small></span>${icon('chevron', 'chev')}<input type="file" id="receipt-file" accept="image/*" hidden></label>`;
  const items = currentRoute() === 'fridge'
    ? [opt('add-fridge', 'plus', 'Add an item', 'Type in one thing'), scan]
    : [opt('add-task', 'checkSquare', 'Chore', 'Something to do, with stars'), opt('add-event', 'calendar', 'Event', 'Something on the calendar'),
      opt('add-fridge', 'fridge', 'Kitchen item', 'Something in the fridge'), opt('add-expense', 'piggy', 'Expense', 'Something you paid for'),
      opt('add-note', 'notes', 'Note', 'A sticky note on Home'), opt('add-bucket', 'sparkles', 'Bucket list', 'A trip, dinner or place to go together')];
  openSheet(`${sheetHead(currentRoute() === 'fridge' ? 'Add to kitchen' : 'Add', 'plus')}<div class="list more-list">${items.join('')}</div>`);
  $('#sheet').dataset.kind = 'add';
}
// The bar can change width without a window resize (a page scrollbar appearing, fonts loading).
new ResizeObserver(moveInk).observe($('#tabs'));
document.fonts?.ready.then(() => { moveInk(); requestAnimationFrame(() => $('#tabs').classList.add('ink-ready')); });

/* Swipe left or right anywhere on a page to move to the next tab.
   The page and the tab highlight follow the finger, then settle. */
const swipe = { id: null, x: 0, y: 0, dx: 0, on: false, samples: [], done: false, frame: 0, rects: null };
let swipeNav = false; // the next render comes from a swipe
const scrollsSideways = (el) => {
  for (; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
};
// Tab positions are measured once when a drag starts, so moving the finger never forces a layout.
function measureTabs() {
  return Object.fromEntries([...$('#tabs').querySelectorAll('.tab')].map((t) => [t.dataset.page, tabBox(t)]));
}
function inkBetween(a, b, t) {
  const mix = (k) => a[k] + (b[k] - a[k]) * t;
  placeInk({ left: mix('left'), top: mix('top'), width: mix('width'), height: mix('height') });
}
// Only the three main pages swipe; a page from More stays put.
function swipeNeighbor(dir) {
  const i = MAIN.findIndex((p) => p.id === currentRoute());
  return i < 0 ? undefined : MAIN[i + dir];
}
const view = $('#view');
view.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || swipe.id !== null || swipe.busy || !$('#sheet').hidden) return;
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
    swipe.rects = measureTabs(); swipe.w = view.clientWidth; swipe.peekId = null;
    // The neighbor page sits beside this one at the top of the screen, so it slides in under the finger.
    swipe.top = Math.max(0, window.scrollY - view.offsetTop);
    view.setPointerCapture(e.pointerId);
    view.classList.add('dragging'); $('#tabs').classList.add('dragging');
    return;
  }
  const raw = e.clientX - swipe.x;
  const next = swipeNeighbor(raw < 0 ? 1 : -1);
  // Past the first or last tab the page only gives a little, like a rubber band.
  swipe.dx = next ? raw : raw / (1 + Math.abs(raw) / 60);
  swipe.samples.push([e.timeStamp, e.clientX]); if (swipe.samples.length > 6) swipe.samples.shift();
  // Draw at most once per frame; touch screens can send moves faster than the display refreshes.
  if (!swipe.frame) swipe.frame = requestAnimationFrame(() => {
    swipe.frame = 0;
    if (!swipe.on) return;
    const w = swipe.w; const dx = swipe.dx;
    const nb = swipeNeighbor(dx < 0 ? 1 : -1);
    showPeek(nb, dx < 0 ? 1 : -1);
    view.style.transform = `translate3d(${dx}px,0,0)`;
    if (peek) peek.style.transform = `translate3d(${dx + (dx < 0 ? 1 : -1) * (w + PEEK_GAP)}px,0,0)`;
    const cur = swipe.rects[currentRoute()];
    if (cur) inkBetween(cur, nb ? swipe.rects[nb.id] : cur, Math.min(Math.abs(dx) / (w * 0.6), 1));
  });
});
// A copy of the next (or previous) page, drawn beside the current one during a swipe.
const PEEK_GAP = 24;
let peek = null;
function showPeek(page, dir) {
  if (!page) { dropPeek(); return; }
  if (swipe.peekId === page.id) return;
  swipe.peekId = page.id;
  peek ||= Object.assign(document.createElement('div'), { className: 'view view-peek' });
  peek.setAttribute('aria-hidden', 'true');
  peek.innerHTML = views[page.id]();
  const wk = peek.querySelector('.wk-scroll');
  if (wk) wk.scrollTop = wkScroll ?? Math.max(0, (new Date().getHours() - DAY_START - 1) * HOUR_PX);
  peek.style.top = `${view.offsetTop + swipe.top}px`;
  peek.style.left = `${view.offsetLeft}px`;
  peek.style.width = `${swipe.w}px`;
  peek.dataset.dir = dir;
  if (!peek.isConnected) view.after(peek);
}
function dropPeek() { peek?.remove(); swipe.peekId = null; }
function endSwipe(e, cancelled) {
  if (e.pointerId !== swipe.id) return;
  swipe.id = null;
  if (!swipe.on) return;
  swipe.on = false; cancelAnimationFrame(swipe.frame); swipe.frame = 0;
  swipe.done = true; setTimeout(() => { swipe.done = false; }, 350);
  const [t0, x0] = swipe.samples[0];
  const v = (e.clientX - x0) / Math.max(e.timeStamp - t0, 1); // px per ms
  const dir = swipe.dx < 0 ? 1 : -1;
  const next = swipeNeighbor(dir);
  const go = !cancelled && next && (Math.abs(swipe.dx) > view.clientWidth * 0.22 || (Math.abs(v) > 0.45 && Math.sign(v) === -dir));
  $('#tabs').classList.remove('dragging');
  view.classList.remove('dragging');
  const w = swipe.w;
  swipe.busy = true;
  // A quick flick finishes faster; the rest of the slide takes at most a quarter second.
  const ms = (left) => Math.round(Math.min(260, Math.max(140, left / Math.max(Math.abs(v), 1.2))));
  if (go) {
    showPeek(next, dir);
    const t = ms(w - Math.abs(swipe.dx));
    for (const el of [view, peek]) el.style.transition = `transform ${t}ms cubic-bezier(.2, .8, .3, 1)`;
    view.style.transform = `translate3d(${-dir * (w + PEEK_GAP)}px,0,0)`;
    peek.style.transform = 'translate3d(0,0,0)';
    inkBetween(swipe.rects[currentRoute()], swipe.rects[next.id], 1);
    setTimeout(() => {
      // The page under the finger becomes the page: same content, no second animation.
      swipeNav = true;
      history.replaceState(null, '', `#/${next.id}`);
      render();
      // The new page was shown from its top; scroll so it stays exactly where it was.
      if (swipe.top) window.scrollTo(0, view.offsetTop);
      swipe.busy = false;
    }, t);
  } else {
    const t = ms(Math.abs(swipe.dx));
    for (const el of [view, peek].filter(Boolean)) el.style.transition = `transform ${t}ms cubic-bezier(.2, .8, .3, 1)`;
    view.style.transform = 'translate3d(0,0,0)';
    if (peek) peek.style.transform = `translate3d(${dir * (w + PEEK_GAP)}px,0,0)`;
    moveInk();
    setTimeout(() => { view.style.transition = ''; view.style.transform = ''; dropPeek(); swipe.busy = false; }, t);
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

function dayLabel(iso) {
  if (iso === isoDay(new Date())) return 'Today';
  if (iso === isoDay(addDays(new Date(), 1))) return 'Tomorrow';
  return new Date(`${iso}T12:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

const timeLabel = (e) => (e.time ? fmtTime(new Date(`${e.date}T${e.time}`)) : 'All day');

// Compact event used in the calendar grids: avatar, start time, title.
// Items marked important get a small red dot wherever they show.
const impTag = (item) => (item.important ? '<span class="imp-dot" role="img" aria-label="Important" title="Important"></span>' : '');
const impRow = (on) => `<div class="setting-row imp-row"><div><b>Important</b><div class="hint">Marks it with a red dot.</div></div>
  <button class="switch imp-switch" id="imp-switch" role="switch" aria-checked="${!!on}" data-action="toggle-important"></button></div>`;
const pickedImportant = () => $('#imp-switch')?.getAttribute('aria-checked') === 'true';

function eventChip(e) {
  return `<button class="ev-chip${e.important ? ' imp' : ''}${eventDone(e) ? ' done' : ''}" data-action="edit-event" data-id="${e.id}">
    ${eventDone(e) ? icon('check', 'ev-done') : avatar(e.who, 'xs')}<b>${e.time ? timeLabel(e) : ''}</b>${impTag(e)}<span>${esc(e.title)}</span></button>`;
}

function eventRow(e, withDate = false) {
  const when = [withDate ? dayLabel(e.date) : '', timeLabel(e), eventDone(e) ? 'Done' : ''].filter(Boolean).join(' · ');
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

/* ---------- Stars ---------- */
// Events earn stars too (5 unless set). An event for both, or for no one, gives each person the stars.
const eventStars = (e) => e.stars ?? 5;
const earners = (who) => (USERS.some((u) => u.id === who) ? [who] : USERS.map((u) => u.id));
const eventDone = (e) => !!e.doneOn;

// Ticks a task or event on or off: moves the stars and keeps a dated log for the Leaderboard.
function awardStars(item, kind, on) {
  const date = on ? isoDay(new Date()) : item.doneOn;
  const n = kind === 'event' ? eventStars(item) : item.stars;
  const people = earners(item.who);
  state.log ||= [];
  for (const who of people) {
    state.stars[who] = Math.max(0, (state.stars[who] || 0) + (on ? n : -n));
    const id = `${item.id}@${date}@${who}`;
    state.log = state.log.filter((l) => l.id !== id);
    if (on) state.log.push({ id, who, stars: n, date, kind, title: item.title });
  }
  item.doneOn = on ? date : '';
  // Keep 100 days: enough for the Leaderboard's 12-week chart, and the whole household shares one
  // synced document (1 MB at most), so old entries would only crowd it.
  const cutoff = isoDay(addDays(new Date(), -100));
  state.log = state.log.filter((l) => l.date >= cutoff);
  if (on && n) toast(`+${n} stars for ${people.map((w) => userOf(w).name).join(' & ')}`);
}
// Every ticked task and event should have its Leaderboard entry. Entries can go missing when a
// screen running an older version of the app syncs (it either didn't log stars yet or dropped the
// log), so rebuild any that are missing from the tick itself. Star totals are left alone.
function repairLog() {
  const cutoff = isoDay(addDays(new Date(), -100));
  const have = new Set((state.log ||= []).map((l) => l.id));
  let added = 0;
  const check = (item, kind, n) => {
    if (!item.doneOn || item.doneOn < cutoff) return;
    for (const who of earners(item.who)) {
      const id = `${item.id}@${item.doneOn}@${who}`;
      if (have.has(id)) continue;
      have.add(id); added++;
      state.log.push({ id, who, stars: n, date: item.doneOn, kind, title: item.title });
    }
  };
  (state.tasks || []).forEach((t) => check(t, 'task', t.stars || 0));
  (state.events || []).forEach((e) => check(e, 'event', eventStars(e)));
  return added > 0;
}
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

// `face` puts the person's avatar and name on the row, for lists that mix both people.
let justTicked = null; // the tick that was just made gets a little pop
function taskCard(t, u, face = false) {
  const done = isDone(t);
  return `<div class="task${done ? ' done' : ''}${t.important ? ' imp' : ''}${face ? ' with-face' : ''}">
    ${face ? avatar(u.id, 'sm') : ''}
    <button class="task-body" data-action="edit-task" data-id="${t.id}">
      <b>${esc(t.title)}${impTag(t)}</b>
      <small>${face ? `${u.name} · ` : ''}${REPEAT_LABEL[t.repeat]} <span class="stars">${icon('star')}${t.stars}</span></small>
    </button>
    ${face && done ? thankBtn(`${t.id}@${t.doneOn}@${t.who}`, t.who, t.title) : ''}
    <button class="check ${done ? 'on' : ''}${done && justTicked === t.id ? ' pop' : ''}" data-action="toggle-task" data-id="${t.id}" aria-label="${done ? 'Mark not done' : 'Mark done'}: ${esc(t.title)}" aria-pressed="${done}">${icon('check')}</button>
  </div>`;
}

function personHead(u, size = 'lg') {
  const list = tasksFor(u.id);
  const done = list.filter(isDone).length;
  return `<div class="person-head">
    ${avatar(u.id, size)}
    <div><h2>${u.name}</h2><small>${list.length ? `${done} of ${list.length} done` : 'No chores yet'}</small></div>
  </div>`;
}

/* ---------- Home ---------- */
// Today's calendar events, shown above each person's tasks on Home. Events that have ended fade back.
function todayEvent(e) {
  const now = new Date();
  const endAt = e.time ? new Date(`${e.date}T${e.end || e.time}`) : null;
  const past = endAt && endAt < now;
  const done = eventDone(e);
  return `<div class="today-ev${e.important ? ' imp' : ''}${past && !done ? ' past' : ''}${done ? ' done' : ''}">
    <button class="tev-main" data-action="edit-event" data-id="${e.id}">${icon('calendar')}<b>${e.time ? fmtTime(new Date(`${e.date}T${e.time}`)) : 'All day'}</b><span>${esc(e.title)}</span>${impTag(e)}</button>
    ${done ? eventThankBtn(e) : ''}
    <button class="tev-check" data-action="toggle-event" data-id="${e.id}" aria-label="${done ? 'Mark not done' : 'Mark done'}: ${esc(e.title)}" aria-pressed="${done}">${icon('check')}</button></div>`;
}

// Home answers "what needs us today?" at a glance: how many chores each person has left,
// what to use up in the kitchen, then today's list and what's coming.
function glanceRow() {
  const people = USERS.map((u) => {
    const left = tasksFor(u.id).filter((t) => !isDone(t)).length;
    return `<a class="glance" href="#/tasks">${avatar(u.id, 'sm')}<span><b>${left || icon('check')}</b><small>${u.name} · ${left ? `${left === 1 ? 'chore' : 'chores'} left` : 'all done'}</small></span></a>`;
  });
  const soon = (state.fridge || []).filter((it) => daysLeft(it) !== null && daysLeft(it) <= 2).length;
  const kitchen = (state.fridge || []).length
    ? `<a class="glance" href="#/fridge"><span class="ibox c-amber-ico">${icon('fridge')}</span><span><b>${soon || icon('check')}</b><small>${soon ? 'to use soon' : 'kitchen all fresh'}</small></span></a>` : '';
  return `<div class="glances">${people.join('')}${kitchen}</div>`;
}

// Who's ahead this week, as one line for the Today card.
function leadLine() {
  const from = weekStartIso();
  const score = (u) => (state.log || []).filter((l) => l.who === u.id && l.date >= from).reduce((a, l) => a + l.stars, 0);
  const [a, b] = USERS.map((u) => ({ u, n: score(u) })).sort((x, y) => y.n - x.n);
  if (!a.n) return '';
  return a.n === b.n ? `All square at ${a.n} ★` : `${a.u.name} leads by ${a.n - b.n} ★`;
}

// The rest of the week's weather, shown once it has loaded (the panel above has the current temperature).
function forecastCard() {
  if (!weatherValid()) return '';
  const hours = weather.hours.map((h) => {
    const hw = wmo(h.code, h.isDay);
    return `<div class="hour">${icon(hw.icon, hw.icon === 'sun' ? 'sun' : '')}<small>${fmtTime(new Date(h.time), false)}</small><b>${Math.round(h.temp)}°</b></div>`;
  }).join('');
  return `<div class="card forecast">
    <div class="card-head">${icon('partly')}<h2>Forecast</h2><span class="hint">${esc(state.settings.place.name)}</span></div>
    <div class="hourly">${hours}</div>
    ${weekStrip()}
  </div>`;
}

views.home = () => {
  const today = isoDay(new Date());
  const evs = eventsOn(today);
  // Both people's chores in one list, each row with a face; ticked ones sink to the bottom.
  const order = USERS.map((u) => u.id);
  const tasks = tasksToday().sort((a, b) => isDone(a) - isDone(b) || order.indexOf(a.who) - order.indexOf(b.who));
  const lead = leadLine();
  const next = state.events.filter((e) => e.date > today).sort(byStart).slice(0, 4);
  return `${thanksInbox()}${bucketInbox()}${glanceRow()}${notesBoard()}
  <div class="grid-home">
    <div class="card a-today">
      <div class="card-head">${icon('checkSquare')}<h2>Today</h2>${lead ? `<a class="link" href="#/tasks">${lead} ${icon('arrowRight')}</a>` : ''}</div>
      ${evs.length ? `<div class="today-evs">${evs.map(todayEvent).join('')}</div>` : ''}
      <div class="task-list">${tasks.map((t) => taskCard(t, userOf(t.who) || USERS[0], true)).join('')
        || `<p class="empty-line">${icon('check')} Nothing left today.${lead ? ` ${lead}.` : ''}</p>`}</div>
    </div>
    <div class="home-side">
      <div class="card a-agenda">
        <div class="card-head">${icon('calendar')}<h2>Coming up</h2><a class="link" href="#/calendar">Calendar ${icon('arrowRight')}</a></div>
        <div class="list">${next.map((e) => eventRow(e, true)).join('') || '<p class="empty-line">Nothing else on the calendar this week.</p>'}</div>
      </div>
      ${bucketCard()}
      ${forecastCard()}
      ${energyDays().length ? energyCard() : ''}
    </div>
  </div>`;
};

/* ---------- Calendar ---------- */
let calCursor = new Date();
const HOUR_PX = 52;
const DAY_START = 7; // 7 AM
const DAY_END = 22; // 10 PM

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
    const tasks = iso === todayIso && calChores() ? tasksToday().map(taskChip).join('') : '';
    return `<div class="wk-allday">${eventsOn(iso).filter((e) => !e.time).map(eventChip).join('')}${tasks}</div>`;
  }).join('');
  const cols = days.map((d) => {
    const iso = isoDay(d);
    const timed = laneLayout(eventsOn(iso).filter((e) => e.time));
    const nowLine = iso === todayIso && nowMin >= DAY_START * 60 && nowMin < DAY_END * 60
      ? `<div class="now-line" style="top:${((nowMin - DAY_START * 60) / 60) * HOUR_PX}px"></div>` : '';
    return `<div class="wk-col" data-action="add-event-at" data-d="${iso}">
      ${timed.map(({ e, start, end, lane, lanes }) => {
        // Clip to the visible hours, so an event starting before 7 AM doesn't run past its end.
        const from = Math.min(Math.max(start, DAY_START * 60), DAY_END * 60);
        const to = Math.min(Math.max(end, DAY_START * 60), DAY_END * 60);
        const top = Math.min(((from - DAY_START * 60) / 60) * HOUR_PX, (DAY_END - DAY_START) * HOUR_PX - 26);
        const height = Math.max(26, ((to - from) / 60) * HOUR_PX - 3);
        return `<button class="wk-ev${eventDone(e) ? ' done' : ''} ${e.who ? `c-${e.who === 'both' ? 'purple' : userOf(e.who).color}` : 'c-purple'}${e.important ? ' imp' : ''}" data-action="edit-event" data-id="${e.id}"
          style="top:${top}px;height:${height}px;left:calc(${(lane / lanes) * 100}% + 2px);width:calc(${100 / lanes}% - 4px)">
          <span class="wk-ev-top">${eventDone(e) ? icon('check', 'ev-done') : avatar(e.who, 'xs')}<b>${timeLabel(e)}</b>${impTag(e)}</span><span class="wk-ev-title">${esc(e.title)}</span></button>`;
      }).join('')}${nowLine}</div>`;
  }).join('');
  return `<div class="wk">
    <div class="wk-head"><div></div>${head}</div>
    <div class="wk-allrow"><div class="wk-gutter-label">All day${calChores() && days.some((d) => isoDay(d) === todayIso) && state.tasks.length ? '<br>&amp; chores' : ''}</div>${allDay}</div>
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
    const items = [...evs.map(eventChip), ...(iso === todayIso && calChores() ? tasksToday().map(taskChip) : [])];
    return `<div class="day ${d.getMonth() !== m ? 'other' : ''} ${iso === todayIso ? 'today' : ''}" data-action="open-day" data-d="${iso}">
      <span class="day-num">${d.getDate()}</span>
      <div class="day-evs">${items.slice(0, 4).join('')}${items.length > 4 ? `<span class="more">+${items.length - 4} more</span>` : ''}</div>
    </div>`;
  }).join('');
  return `<div class="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="dow">${d}</div>`).join('')}${cells}</div>`;
}

// The week as a list, the easiest way to read a calendar on a phone.
function agendaView() {
  const start = addDays(calCursor, -calCursor.getDay());
  const todayIso = isoDay(new Date());
  const days = Array.from({ length: 7 }, (_, i) => isoDay(addDays(start, i)));
  const blocks = days.map((iso) => {
    const evs = eventsOn(iso);
    const tasks = iso === todayIso && calChores() ? tasksToday() : [];
    if (!evs.length && !tasks.length && iso !== todayIso) return '';
    return `<div class="ag-day${iso === todayIso ? ' today' : ''}"><div class="ag-head">${dayLabel(iso)}${iso === todayIso || iso === isoDay(addDays(new Date(), 1)) ? `<small>${new Date(`${iso}T12:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</small>` : ''}</div>
      <div class="list">${evs.map((e) => eventRow(e)).join('')}${tasks.map((t) => taskCard(t, userOf(t.who) || USERS[0], true)).join('')}
      ${!evs.length && !tasks.length ? '<p class="empty-line">Nothing planned today.</p>' : ''}</div></div>`;
  }).join('');
  return `<div class="agenda">${blocks || '<p class="empty-line">Nothing planned this week.</p>'}</div>`;
}
// Phones start on the list; wider screens on the week grid. A choice made here sticks on this device.
const calView = () => state.settings.calPick || (matchMedia('(max-width: 600px)').matches ? 'agenda' : 'week');
const calChores = () => !!state.settings.calChores;

function calTitle() {
  if (calView() === 'month') return calCursor.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const s = addDays(calCursor, -calCursor.getDay());
  const e = addDays(s, 6);
  const mon = (d) => d.toLocaleDateString([], { month: 'short' });
  const endPart = s.getMonth() === e.getMonth() ? e.getDate() : `${mon(e)} ${e.getDate()}`;
  return `${mon(s)} ${s.getDate()} – ${endPart}, ${e.getFullYear()}`;
}

const CAL_VIEWS = { agenda: 'List', week: 'Week', month: 'Month' };
views.calendar = () => {
  const v = calView();
  return `
  <div class="card cal-card">
    <div class="cal-bar">
      <button class="btn-round" data-action="cal-move" data-d="-1" aria-label="Previous">${icon('chevronLeft')}</button>
      <button class="btn-round" data-action="cal-move" data-d="1" aria-label="Next">${icon('chevron')}</button>
      <h2>${calTitle()}</h2>
      <button class="btn ghost sm" data-action="cal-today">Today</button>
      <span class="spacer"></span>
      <button class="chip-toggle${calChores() ? ' on' : ''}" data-action="cal-chores" aria-pressed="${calChores()}">${icon('checkSquare')} Chores</button>
      <div class="seg">${Object.entries(CAL_VIEWS).map(([x, l]) => `<button class="${v === x ? 'on' : ''}" data-action="cal-view" data-v="${x}">${l}</button>`).join('')}</div>
    </div>
    <div class="cal-body">${v === 'month' ? monthView() : v === 'agenda' ? agendaView() : weekView()}</div>
  </div>`;
};

/* ---------- Tasks ---------- */
// Chores: who's ahead on stars at the top, then each person's list, then the stars history.
views.tasks = () => {
  const b = boardParts();
  return `<div class="section-title">Chores<span class="spacer"></span>${b.seg}</div>
  <div class="lb-cards">${b.cards}</div>
  ${b.note}
  <div class="board">
    ${USERS.map((u) => `
      <div class="card board-col">
        ${personHead(u, 'md')}
        <div class="task-list">${tasksFor(u.id).map((t) => taskCard(t, u)).join('') || `<button class="empty-line as-btn" data-action="add-task" data-who="${u.id}">${icon('plus')} Add ${u.name}'s first chore</button>`}</div>
      </div>`).join('')}
  </div>
  ${b.history}
  ${winsJar()}`;
};

/* ---------- Leaderboard ---------- */
const BOARD_PERIODS = { week: 'This week', month: 'This month', all: 'All time' };

function boardStart(period) {
  const now = new Date();
  if (period === 'week') return weekStartIso();
  if (period === 'month') return isoDay(new Date(now.getFullYear(), now.getMonth(), 1));
  return '';
}

// Days in a row, up to today, with at least one thing done (today can still be in progress).
function streak(who) {
  const days = new Set((state.log || []).filter((l) => l.who === who).map((l) => l.date));
  let d = new Date();
  if (!days.has(isoDay(d))) d = addDays(d, -1);
  let n = 0;
  while (days.has(isoDay(d))) { n++; d = addDays(d, -1); }
  return n;
}

// Stars per person, side by side: the days of this week or month, or the last 12 weeks for all time.
function boardChart(period, entries) {
  let buckets;
  if (period === 'all') {
    const start = addDays(new Date(weekStartIso() + 'T12:00'), -77);
    buckets = Array.from({ length: 12 }, (_, i) => {
      const from = isoDay(addDays(start, i * 7)); const to = isoDay(addDays(start, i * 7 + 6));
      return { label: `Week of ${fmtShort(from)}`, short: fmtShort(from), match: (d) => d >= from && d <= to };
    });
  } else {
    const start = new Date(boardStart(period) + 'T12:00');
    const n = period === 'week' ? 7 : new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    buckets = Array.from({ length: n }, (_, i) => {
      const key = isoDay(addDays(start, i));
      const d = new Date(key + 'T12:00');
      return { label: d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }), short: period === 'week' ? d.toLocaleDateString([], { weekday: 'short' }) : String(d.getDate()), match: (x) => x === key };
    });
  }
  const rows = buckets.map((b) => ({ ...b, vals: USERS.map((u) => entries.filter((l) => l.who === u.id && b.match(l.date)).reduce((a, l) => a + l.stars, 0)) }));
  const max = Math.max(...rows.flatMap((r) => r.vals), 1);
  const w = 300 / rows.length; const gw = w * 0.74; const bw = gw / USERS.length;
  const bars = rows.map((r, i) => r.vals.map((v, j) => {
    const h = (v / max) * 100;
    return v ? `<rect class="bar-${USERS[j].color}" x="${(i * w + (w - gw) / 2 + j * bw).toFixed(2)}" y="${(100 - h).toFixed(2)}" width="${(bw * 0.9).toFixed(2)}" height="${h.toFixed(2)}"><title>${r.label}: ${USERS[j].name} ${v} stars</title></rect>` : '';
  }).join('')).join('');
  const title = period === 'all' ? 'Stars per week, last 12 weeks' : period === 'week' ? 'Stars per day this week' : 'Stars per day this month';
  return `<div class="energy-chart">
    <div class="chart-top"><span>${title}</span><span>${USERS.map((u) => `<i class="key bar-${u.color}"></i>${u.name}`).join(' ')} · top ${max}</span></div>
    <svg viewBox="0 0 300 100" preserveAspectRatio="none" style="height:170px" role="img" aria-label="${title}">${bars}</svg>
    <div class="chart-axis"><span>${rows[0].short}</span><span>${rows[rows.length - 1].short}</span></div>
  </div>`;
}

function boardParts() {
  const period = BOARD_PERIODS[state.settings.boardPeriod] ? state.settings.boardPeriod : 'week';
  const from = boardStart(period);
  const entries = (state.log || []).filter((l) => l.date >= from);
  // All time uses the running totals, which also count stars earned before the log began.
  const score = (u) => (period === 'all' ? state.stars[u.id] || 0 : entries.filter((l) => l.who === u.id).reduce((a, l) => a + l.stars, 0));
  const ranked = USERS.map((u) => ({ u, stars: score(u) })).sort((a, b) => b.stars - a.stars);
  const tied = ranked.length > 1 && ranked[0].stars === ranked[1].stars;
  const gap = ranked.length > 1 ? ranked[0].stars - ranked[1].stars : 0;
  const seg = `<div class="seg">${Object.entries(BOARD_PERIODS).map(([k, l]) => `<button class="${period === k ? 'on' : ''}" data-action="board-period" data-v="${k}">${l}</button>`).join('')}</div>`;
  const cards = ranked.map(({ u, stars }, i) => {
    const lead = !tied && i === 0 && stars > 0;
    const s = streak(u.id);
    return `<div class="card lb-card${lead ? ' lead' : ''}">
      ${avatar(u.id, 'md')}
      <div class="lb-who"><h2>${u.name}${lead ? `<span class="lb-tag">${icon('trophy')} Leading${gap ? ` by ${gap}` : ''}</span>` : ''}</h2>
        <small>${s ? `${icon('flame')} ${s}-day streak` : 'No streak yet'}</small></div>
      <div class="lb-stars">${icon('star')}<b>${stars}</b></div>
    </div>`;
  }).join('');
  const recent = [...entries].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  // The chart only earns its space once there are a few days to compare.
  const activeDays = new Set((period === 'all' ? state.log || [] : entries).map((l) => l.date)).size;
  const history = recent.length ? `<div class="lb-grid${activeDays >= 3 ? '' : ' one'}">
      ${activeDays >= 3 ? `<div class="card">${boardChart(period, state.log || [])}</div>` : ''}
      <div class="card">
        <div class="card-head">${icon('star')}<h2>Recent stars</h2></div>
        <div class="list lb-recent">${recent.map((l) => `<div class="lb-row">${avatar(l.who, 'sm')}<span><b>${esc(l.title)}</b><small>${l.kind === 'event' ? 'Event' : 'Chore'} · ${dayLabel(l.date)}</small></span><em>+${l.stars}</em>${thankBtn(l.id, l.who, l.title)}</div>`).join('')}</div>
      </div>
    </div>` : '';
  const note = tied && ranked[0].stars > 0 ? '<p class="hint lb-note">All square. The next tick takes the lead.</p>' : '';
  return { seg, cards, note, history };
}

/* =========================================================
   Thank-you notes (the wins jar) and sticky notes on Home
   ========================================================= */
// There are no logins, so each device says who uses it (Settings › Household). A phone set to Nhi
// only shows thank-yous sent to Nhi and marks them read when she opens them; the shared fridge
// screen (nobody picked) shows everyone's, each with who it is for.
const me = () => (userOf(state.settings.me) ? state.settings.me : '');
const otherOf = (id) => USERS.find((u) => u.id !== id)?.id || '';
const THANKS_EMOJI = ['❤️', '🙏', '🎉', '⭐', '💪', '☕'];
const THANKS_LINES = ['Thank you!', "You're the best", 'Saw that. Legend.', "Couldn't do it without you"];
const THANKS_MAX = 140; // characters; everything shares one synced document
const NOTE_MAX = 200;
const NOTE_COLORS = ['butter', 'sage', 'blush', 'sky', 'lilac'];
const NOTE_KEEP = { '': 'Always', today: 'Today', week: 'This week' };

const byNewest = (a, b) => (b.at || 0) - (a.at || 0);
const thanksFor = (winId) => (state.thanks || []).filter((k) => k.win === winId);
// Unread thank-yous this device should show: the owner's, or everyone's on a shared screen.
const unreadThanks = () => (state.thanks || []).filter((k) => !k.readAt && (!me() || k.to === me())).sort(byNewest);
const liveNotes = () => (state.notes || []).filter((n) => !n.until || n.until >= isoDay(new Date())).sort(byNewest);
// A note from the other person is new until its reader taps it. Shared screens don't track this.
const isNewNote = (n) => !!me() && n.by !== me() && !n.seen?.[me()] && Date.now() - n.at < 3 * 864e5;
const unreadCount = () => unreadThanks().length + liveNotes().filter(isNewNote).length + (me() ? newDones().length : 0);

// Taken-down notes and thank-yous read more than six months ago leave the shared document.
function tidyNotes() {
  const today = isoDay(new Date());
  const old = Date.now() - 182 * 864e5;
  const notes = (state.notes ||= []).filter((n) => !n.until || n.until >= today);
  const thanks = (state.thanks ||= []).filter((k) => !k.readAt || k.at >= old);
  const changed = notes.length !== state.notes.length || thanks.length !== state.thanks.length;
  state.notes = notes; state.thanks = thanks;
  return changed;
}

// The Home tab (and the installed app's icon, where the system supports it) shows how many are waiting.
function updateBadge() {
  const n = unreadCount();
  const home = $('#tabs [data-page="home"]');
  if (home) {
    let b = home.querySelector('.tab-badge');
    if (!n) b?.remove();
    else {
      if (!b) { b = Object.assign(document.createElement('i'), { className: 'tab-badge' }); home.append(b); }
      b.textContent = n > 9 ? '9+' : n;
    }
  }
  try { if (n) navigator.setAppBadge?.(n).catch(() => {}); else navigator.clearAppBadge?.().catch(() => {}); } catch { /* not supported */ }
}

// The heart next to a win. Your own wins have none; a win you already thanked shows a filled heart.
function thankBtn(winId, who, title) {
  if (!userOf(who) || who === me()) return '';
  const sent = thanksFor(winId).some((k) => k.to === who);
  return `<button class="heart-btn${sent ? ' on' : ''}" data-action="${sent ? 'view-thanks' : 'thank'}" data-win="${esc(winId)}" data-to="${who}" data-title="${esc(title)}"
    aria-label="${sent ? `Thanked ${userOf(who).name}` : `Thank ${userOf(who).name}`} for ${esc(title)}">${icon('heart')}</button>`;
}

// A finished event: one person's is like a chore. A shared one thanks whoever this device isn't;
// on the shared screen the sheet asks who's saying thanks, and is done once both have.
function eventThankBtn(e) {
  const base = `${e.id}@${e.doneOn}`;
  if (userOf(e.who)) return thankBtn(`${base}@${e.who}`, e.who, e.title);
  if (me()) return thankBtn(`${base}@${otherOf(me())}`, otherOf(me()), e.title);
  const sent = USERS.every((u) => thanksFor(`${base}@${u.id}`).length);
  return `<button class="heart-btn${sent ? ' on' : ''}" data-action="thank" data-base="${esc(base)}" data-title="${esc(e.title)}" aria-label="Say thanks for ${esc(e.title)}">${icon('heart')}</button>`;
}

// Top of Home: who has a thank-you waiting. One strip per person on a shared screen.
function thanksInbox() {
  const list = unreadThanks();
  if (!list.length) return '';
  const people = [...new Set(list.map((k) => k.to))];
  return `<div class="inbox">${people.map((to) => {
    const mine = list.filter((k) => k.to === to);
    const froms = [...new Set(mine.map((k) => k.from))];
    const who = me() ? 'you' : userOf(to)?.name;
    const head = mine.length === 1 ? `${userOf(mine[0].from)?.name} sent ${who} a thank-you` : `${mine.length} thank-yous for ${who}`;
    return `<button class="inbox-strip" data-action="open-thanks" data-to="${to}">
      <span class="inbox-face">${froms.map((f) => avatar(f, 'sm')).join('')}<i>${mine[0].emoji || '💌'}</i></span>
      <span><b>${esc(head)}</b><small>Tap to open${me() ? '' : ` · for ${esc(userOf(to)?.name)}`}</small></span>${icon('chevron', 'chev')}</button>`;
  }).join('')}</div>`;
}

function thanksCard(k, big = false) {
  const from = userOf(k.from); const to = userOf(k.to);
  const seen = k.readAt ? `Seen ${ago(k.readAt)}` : 'Not opened yet';
  return `<div class="thx${big ? ' big' : ''}">
    <span class="thx-emoji">${k.emoji || '💌'}</span>
    <div class="thx-body">
      <p>${esc(k.text || 'Thank you!')}</p>
      <small>${avatar(k.from, 'xs')}${esc(from?.name || '')} to ${esc(to?.name || '')}${k.for ? ` · for ${esc(k.for)}` : ''} · ${ago(k.at)}${big ? '' : ` · ${seen}`}</small>
    </div></div>`;
}

// Opening the strip shows every unread note for that person and marks them read.
function openThanks(to) {
  const list = (state.thanks || []).filter((k) => k.to === to && !k.readAt).sort(byNewest);
  if (!list.length) return;
  const now = Date.now();
  list.forEach((k) => { k.readAt = now; });
  const back = otherOf(to);
  openSheet(`${sheetHead(list.length === 1 ? 'A thank-you for you' : `${list.length} thank-yous`, 'heart')}
    <div class="thx-list">${list.map((k) => thanksCard(k, true)).join('')}</div>
    <div class="sheet-actions">
      <button class="btn ghost" data-action="close-sheet">Close</button>
      <button class="btn" data-action="thank" data-to="${back}">${icon('heart')} Thank ${esc(userOf(back)?.name)} back</button>
    </div>`);
  $('#sheet').dataset.kind = 'thanks';
}

// Writing one. From is always the other person, since a two-person household only has one choice.
// Who it's for is worked out, never picked: on someone's own chore it's them, and otherwise it's
// whoever isn't sending. The only question ever asked is who's sending, and only on the shared
// screen for something both of you did (or a thank-you for nothing in particular).
function openThankSheet({ win = '', to = '', title = '', base = '' }) {
  if (!userOf(to) && me()) { to = otherOf(me()); if (base) win = `${base}@${to}`; }
  const pickFrom = !userOf(to);
  const from = pickFrom ? state.settings.lastWriter || USERS[0].id : otherOf(to);
  if (pickFrom) to = otherOf(from);
  openSheet(`${sheetHead(pickFrom ? 'Say thanks' : `Thank ${esc(userOf(to).name)}`, 'heart')}
    ${title ? `<p class="thx-for">${avatar(pickFrom ? 'both' : to, 'sm')}<span>for <b>${esc(title)}</b></span></p>` : ''}
    ${pickFrom ? `<div class="field"><label>Who's saying thanks?</label>${whoPicker(from, false)}<p class="hint" id="thx-dir">To ${esc(userOf(to).name)}</p></div>` : ''}
    <div class="field"><label>Pick one</label><div class="emoji-pick" id="thx-emoji">${THANKS_EMOJI.map((e, i) => `<button class="${i ? '' : 'on'}" data-action="pick-seg" data-v="${e}">${e}</button>`).join('')}</div></div>
    <div class="field"><label for="thx-text">Say something <span class="muted">(optional)</span></label>
      <textarea class="input" id="thx-text" rows="2" maxlength="${THANKS_MAX}" placeholder="Thank you!"></textarea>
      <div class="chips">${THANKS_LINES.map((l) => `<button class="chip" data-action="thanks-line" data-v="${esc(l)}">${esc(l)}</button>`).join('')}</div></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="send-thanks" data-win="${esc(win)}" data-base="${esc(base)}" data-to="${to}" data-title="${esc(title)}">${icon('heart')} Send</button>
    </div>`);
  $('#sheet').dataset.kind = 'thank';
}

// One sent thank-you: what it said, whether it has been seen, and a way to take it back.
function openThanksDetail(k) {
  openSheet(`${sheetHead('Thank-you', 'heart')}
    <div class="thx-list">${thanksCard(k)}</div>
    <div class="sheet-actions">
      <button class="btn danger" data-action="del-thanks" data-id="${k.id}">${icon('trash')} Take back</button><span class="spacer"></span>
      <button class="btn ghost" data-action="close-sheet">Close</button>
    </div>`);
}

// Chores: every thank-you from one week, newest first, with arrows to flip back through older weeks.
let jarWeek = 0; // 0 = this week, 1 = last week, ...
function winsJar() {
  const start = addDays(new Date(`${weekStartIso()}T12:00`), -7 * jarWeek);
  const from = isoDay(start); const to = isoDay(addDays(start, 6));
  const list = (state.thanks || []).filter((k) => { const d = isoDay(new Date(k.at)); return d >= from && d <= to; }).sort(byNewest);
  const label = jarWeek === 0 ? 'This week' : jarWeek === 1 ? 'Last week' : `${fmtShort(from)} – ${fmtShort(to)}`;
  const more = (state.thanks || []).some((k) => isoDay(new Date(k.at)) < from);
  return `<div class="card jar">
    <div class="card-head">${icon('heart')}<h2>Wins jar</h2>
      <span class="jar-nav"><button class="btn-round sm" data-action="jar-week" data-d="1" aria-label="Earlier week" ${more ? '' : 'disabled'}>${icon('chevronLeft')}</button>
      <span>${label}</span><button class="btn-round sm" data-action="jar-week" data-d="-1" aria-label="Later week" ${jarWeek ? '' : 'disabled'}>${icon('chevron')}</button></span></div>
    <div class="thx-list">${list.map((k) => `<button class="thx-open" data-action="view-thanks" data-id="${k.id}">${thanksCard(k)}</button>`).join('')
      || `<p class="empty-line">${jarWeek ? 'No thank-yous that week.' : 'Nothing in the jar yet this week. Tap the heart next to a win to say thanks.'}</p>`}</div>
    <button class="add-task" data-action="thank">${icon('heart')} Send a thank-you</button>
  </div>`;
}

// A sticky note. The writer's face sits in the top-left corner, holding it up like a magnet.
const TILTS = [-1.4, 1, -0.5, 1.5, -1, 0.6];
const tiltOf = (id) => TILTS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % TILTS.length];
function stickyNote(n) {
  const until = !n.until ? '' : n.until === isoDay(new Date()) ? ' · today only' : ` · until ${dayLabel(n.until)}`;
  return `<button class="sticky p-${NOTE_COLORS.includes(n.color) ? n.color : 'butter'}${isNewNote(n) ? ' new' : ''}" style="--tilt:${tiltOf(n.id)}deg" data-action="edit-note" data-id="${n.id}">
    ${avatar(n.by, 'sm')}${isNewNote(n) ? '<span class="sticky-new">New</span>' : ''}
    <span class="sticky-text">${esc(n.text)}</span>
    <small>${esc(userOf(n.by)?.name || '')} · ${ago(n.at)}${until}</small></button>`;
}
function notesBoard() {
  const list = liveNotes();
  if (!list.length) return `<button class="note-add solo" data-action="add-note">${icon('notes')} Leave a note</button>`;
  return `<div class="notes-board" aria-label="Notes">${list.map(stickyNote).join('')}
    <button class="note-add" data-action="add-note" aria-label="Leave a note">${icon('plus')}<span>Note</span></button></div>`;
}

function openNoteSheet(n) {
  const writer = n?.by || me() || state.settings.lastWriter || USERS[0].id;
  const color = n?.color || NOTE_COLORS[USERS.findIndex((u) => u.id === writer) % NOTE_COLORS.length] || 'butter';
  const keep = !n?.until ? '' : n.until === isoDay(new Date()) ? 'today' : 'week';
  openSheet(`${sheetHead(n ? 'Note' : 'New note', 'notes')}
    <div class="note-edit p-${color}" id="note-paper"${n ? ' data-nofocus' : ''}>${avatar(writer, 'sm')}
      <textarea id="note-text" rows="4" maxlength="${NOTE_MAX}" placeholder="Write something for the fridge…">${esc(n?.text || '')}</textarea>
      <small id="note-count">${(n?.text || '').length}/${NOTE_MAX}</small></div>
    <div class="field"><label>From</label>${whoPicker(writer, false)}</div>
    <div class="field"><label>Color</label><div class="swatches" id="note-color">${NOTE_COLORS.map((c) => `<button class="swatch p-${c}${c === color ? ' on' : ''}" data-action="pick-color" data-v="${c}" aria-label="${c}"></button>`).join('')}</div></div>
    <div class="field"><label>Keep it up</label><div class="seg" id="note-keep">${Object.entries(NOTE_KEEP).map(([k, l]) => `<button class="${k === keep ? 'on' : ''}" data-action="pick-seg" data-v="${k}">${l}</button>`).join('')}</div></div>
    <div class="sheet-actions">
      ${n ? `<button class="btn danger" data-action="del-note" data-id="${n.id}">${icon('trash')} Take down</button><span class="spacer"></span>` : ''}
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="save-note" data-id="${n?.id || ''}">${n ? 'Save' : 'Stick it up'}</button>
    </div>`);
  $('#sheet').dataset.kind = 'note';
}

// When the other device sends something, say so even if this screen is on another page.
function announceArrivals(before) {
  const fresh = (state.thanks || []).filter((k) => !before.has(k.id) && !k.readAt && (!me() || k.to === me()));
  const notes = liveNotes().filter((n) => !before.has(n.id) && (!me() || n.by !== me()));
  const ticked = newDones().filter((b) => !before.has(`${b.id}✓`));
  const added = (state.bucket || []).filter((b) => !before.has(b.id) && !b.doneAt && (!me() || b.by !== me()));
  if (fresh.length) toast(`${userOf(fresh[0].from)?.name} sent ${me() ? 'you' : userOf(fresh[0].to)?.name} a thank-you ${fresh[0].emoji || '💌'}`);
  else if (ticked.length) toast(`${userOf(ticked[0].from)?.name} ticked off ${ticked[0].text} 🎉`);
  else if (notes.length) toast(`${userOf(notes[0].by)?.name} left a note`);
  else if (added.length) toast(`${userOf(added[0].by)?.name} added ${added[0].text} to the bucket list`);
}
// Ids seen so far, plus a ✓ mark for each bucket list item already ticked off.
const knownIds = () => new Set([...(state.thanks || []), ...(state.notes || []), ...(state.bucket || [])].map((x) => x.id)
  .concat((state.bucket || []).filter((b) => b.doneAt).map((b) => `${b.id}✓`)));

/* =========================================================
   Bucket list: trips, dinners and places to do together
   ========================================================= */
// state.bucket items: { id, text, kind, by, at, doneAt, doneBy, from, seen }, synced as b: items.
// doneBy is who went (phu, nhi or both); from is who ticked it off, on their own phone or by picking
// themselves on the fridge. The other person gets a strip on Home, a toast and the badge until
// they open it, and the recap email mentions it for two days.
// Each kind is worth a fixed number of love points, by how much it takes: eating out is easy,
// a place is a bit more, a trip is big.
const BUCKET_KINDS = {
  milestone: ['🏡', 'Milestone', 200], trip: ['✈️', 'Trip', 100], learn: ['🎓', 'Learn together', 50],
  adventure: ['🏕️', 'Adventure', 40], give: ['💛', 'Give back', 30], place: ['📍', 'Place', 25],
  show: ['🎟️', 'Show or game', 20], do: ['✨', 'Do', 15], cook: ['🍳', 'Cook together', 10],
  date: ['🎬', 'Date night', 10], food: ['🍜', 'Food', 10],
};
const BUCKET_MAX = 100; // characters; everything shares one synced document
const kindOf = (b) => BUCKET_KINDS[b.kind] || BUCKET_KINDS.do;
// Love points come from the kind, and the two of you earn them together when an item is ticked
// off. The total is worked out from the list, so nothing extra is synced.
const loveOf = (b) => kindOf(b)[2];
const loveTag = (b) => `<span class="love">❤️ ${loveOf(b)}</span>`;
const lovePoints = () => bucketDone().reduce((n, b) => n + loveOf(b), 0);
const bucketOpen = () => (state.bucket || []).filter((b) => !b.doneAt).sort(byNewest);
const bucketDone = () => (state.bucket || []).filter((b) => b.doneAt).sort((a, b) => b.doneAt - a.doneAt);
// Ticked off by one person and not yet opened by the other. A shared screen shows it until the
// other person's phone opens it, or for three days.
const isNewDone = (b) => !!b.doneAt && !!userOf(b.from) && !b.seen && Date.now() - b.doneAt < 3 * 864e5 && (!me() || b.from !== me());
const newDones = () => (state.bucket || []).filter(isNewDone).sort((a, b) => b.doneAt - a.doneAt);
const wentLine = (b) => (b.doneBy === 'both' ? 'Together' : userOf(b.doneBy)?.name || 'Done');

function bucketRow(b) {
  const done = !!b.doneAt;
  const sub = done ? `${wentLine(b)} · ${dayLabel(isoDay(new Date(b.doneAt)))}` : `Added by ${esc(userOf(b.by)?.name || 'someone')} ${ago(b.at)}`;
  return `<div class="task bk${done ? ' done' : ''}">
    <span class="bk-emoji" aria-hidden="true">${kindOf(b)[0]}</span>
    <button class="task-body" data-action="edit-bucket" data-id="${b.id}"><b>${esc(b.text)}</b><small>${sub}${loveTag(b)}</small></button>
    <button class="check ${done ? 'on' : ''}" data-action="tick-bucket" data-id="${b.id}" aria-label="${done ? 'Put back on the list' : 'Tick off'}: ${esc(b.text)}" aria-pressed="${done}">${icon('check')}</button>
  </div>`;
}

// Home: a few things still to do, newest first.
function bucketCard() {
  const open = bucketOpen(); const done = bucketDone().length;
  return `<div class="card bucket">
    <div class="card-head">${icon('sparkles')}<h2>Bucket list</h2><a class="link" href="#/bucket">${done ? `❤️ ${lovePoints()} · ` : ''}See all ${icon('arrowRight')}</a></div>
    <div class="task-list">${open.slice(0, 4).map(bucketRow).join('')
      || `<p class="empty-line">${done ? 'All done. Time to dream up the next one.' : 'Add a trip, a dinner or a place you want to go together.'}</p>`}</div>
    <button class="add-task" data-action="add-bucket">${icon('plus')} Add to the list</button>
  </div>`;
}

// Top of Home: what the other person ticked off.
function bucketInbox() {
  const list = newDones();
  if (!list.length) return '';
  const b = list[0]; const who = userOf(b.from)?.name;
  const head = list.length === 1 ? `${who} ticked off ${b.text}` : `${who} ticked off ${list.length} things`;
  return `<div class="inbox"><button class="inbox-strip" data-action="open-bucket-news">
    <span class="inbox-face">${avatar(b.from, 'sm')}<i>🎉</i></span>
    <span><b>${esc(head)}</b><small>Bucket list${list.length === 1 ? ` · +${loveOf(b)} love points${b.doneBy === 'both' ? ' together' : ''}` : ''} · Tap to see</small></span>${icon('chevron', 'chev')}</button></div>`;
}

// The Bucket list page: everything still to do, kind by kind, then everything done.
views.bucket = () => {
  const open = bucketOpen(); const done = bucketDone();
  const groups = Object.entries(BUCKET_KINDS).map(([k, [e, l, n]]) => [e, `${l} · ❤️ ${n} each`, open.filter((b) => kindOf(b) === BUCKET_KINDS[k])]).filter(([, , list]) => list.length);
  const toEarn = open.reduce((n, b) => n + loveOf(b), 0);
  return `<div class="section-title">Bucket list<span class="spacer"></span><span class="hint">${open.length} to do · ${done.length} done</span></div>
  <div class="bk-page">
    <div class="card">
      <div class="card-head">${icon('sparkles')}<h2>To do</h2>${toEarn ? `<span class="hint">❤️ ${toEarn} to earn</span>` : ''}</div>
      ${groups.map(([e, l, list]) => `<h3 class="bk-group">${e} ${l}</h3><div class="task-list">${list.map(bucketRow).join('')}</div>`).join('')
        || '<p class="empty-line">Nothing on the list yet. Add a trip, a dinner or a place you want to go together.</p>'}
      <button class="add-task" data-action="add-bucket">${icon('plus')} Add to the list</button>
    </div>
    <div class="card">
      <div class="love-total"><b>❤️ ${lovePoints()}</b><span>love points earned together</span></div>
      <div class="card-head">${icon('check')}<h2>Done</h2></div>
      <div class="task-list">${done.map(bucketRow).join('') || '<p class="empty-line">Nothing ticked off yet.</p>'}</div>
    </div>
  </div>`;
};

function openBucketSheet(b) {
  const kind = b?.kind || 'trip';
  openSheet(`${sheetHead(b ? 'Bucket list' : 'Add to the bucket list', 'sparkles')}
    <div class="field"><label for="bk-text">What</label><input class="input" id="bk-text" maxlength="${BUCKET_MAX}" value="${esc(b?.text || '')}" placeholder="e.g. Cherry blossoms in Kyoto"${b ? ' data-nofocus' : ''}></div>
    <div class="field"><label>Kind</label><div class="seg bk-kind" id="bk-kind">${Object.entries(BUCKET_KINDS).map(([k, [e, l, n]]) => `<button class="${k === kind ? 'on' : ''}" data-action="pick-seg" data-v="${k}">${e} ${l}<small>❤️ ${n}</small></button>`).join('')}</div></div>
    ${!b && !me() ? `<div class="field"><label>From</label>${whoPicker(state.settings.lastWriter || USERS[0].id, false)}</div>` : ''}
    ${b ? `<p class="hint">Added by ${esc(userOf(b.by)?.name || 'someone')} ${ago(b.at)}${b.doneAt ? ` · done ${dayLabel(isoDay(new Date(b.doneAt)))}, ${wentLine(b).toLowerCase()}` : ''}</p>` : ''}
    <div class="sheet-actions">
      ${b ? `<button class="btn danger" data-action="del-bucket" data-id="${b.id}">${icon('trash')} Remove</button><span class="spacer"></span>` : ''}
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="save-bucket" data-id="${b?.id || ''}">${b ? 'Save' : 'Add'}</button>
    </div>`);
  $('#sheet').dataset.kind = 'bucket-edit';
}

// Ticking off asks who went. Most things are done together, so that is picked unless this is someone's own phone.
function openBucketTick(b) {
  openSheet(`${sheetHead('Ticked off!', 'sparkles')}
    <p class="thx-for"><span class="bk-emoji">${kindOf(b)[0]}</span><span><b>${esc(b.text)}</b> · +${loveOf(b)} love points</span></p>
    <div class="field"><label>Who went</label>${whoPicker('both', 'both')}</div>
    <p class="hint">${me() ? `${esc(userOf(otherOf(me()))?.name)} gets a note on their screen` : 'The other person gets a note on their screen'} unless you went together.</p>
    <div class="sheet-actions">
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="done-bucket" data-id="${b.id}">${icon('check')} Tick it off</button>
    </div>`);
  $('#sheet').dataset.kind = 'bucket-tick';
}

/* =========================================================
   Household sync (same events, chores and expenses on every device)
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
    const before = knownIds();
    apply(state);
    announceArrivals(before);
    // Rebuilt Leaderboard entries are sent back to the household; otherwise just keep a copy here.
    if (repairLog()) save();
    else try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
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
  const head = `<div class="profiles">${USERS.map((u) => `<div class="profile">${avatar(u.id, 'lg')}<b>${u.name}</b></div>`).join('')}</div>
    <div class="setting-row"><div><b>Who uses this device</b><div class="hint">Thank-yous for this person show here and are marked read when opened. Pick Shared for the fridge.</div></div>
      <div class="seg">${[...USERS.map((u) => [u.id, u.name]), ['', 'Shared']].map(([id, l]) => `<button class="${me() === id ? 'on' : ''}" data-action="set-me" data-v="${id}">${l}</button>`).join('')}</div></div>
    <h3 class="set-sub">Sync across devices</h3>`;
  if (!syncAvailable()) {
    return `<div class="card">${head}
      <p class="hint">Not set up yet. Each device keeps its own events, chores and expenses until sync is turned on for this site.</p>
    </div>`;
  }
  const m = houseMessage();
  return `<div class="card">${head}
    ${m.ok ? `<p class="sync-line">${icon('check')}${m.text}</p>` : `<div class="sync-banner">${icon('users')}<span>${m.text}</span></div>`}
    ${houseSync.state === 'new' ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:-4px 0 16px"><button class="btn" data-action="house-create">Start a new household</button><button class="btn ghost" data-action="house-cancel">Cancel</button></div>` : ''}
    <div class="field"><label for="house-pass">Household passphrase</label>
      <div style="display:flex;gap:8px"><input class="input" id="house-pass" data-house-pass type="password" autocomplete="off" placeholder="${housePass ? 'Saved on this device' : 'Same phrase on every device'}">
      <button class="btn" data-action="house-connect">${housePass ? 'Update' : 'Connect'}</button></div>
      <div class="hint">Type the same passphrase on each device. Everything is encrypted with it before it leaves this device. Joining a household replaces this device's events, chores and expenses with the shared ones.</div></div>
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
    <p class="house-intro">Type your household passphrase to see the same events, chores and expenses as everyone else.</p>
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
// Paid by 'both' means each paid half, so nobody owes on it. A settle-up entry
// ({ kind: 'settle', paidBy, to }) is money between the two of you, not spending.
const isSettle = (x) => x.kind === 'settle';
const spending = (list) => list.filter((x) => !isSettle(x));
function expenseStats(list) {
  const paid = Object.fromEntries(USERS.map((u) => [u.id, 0]));
  const sharedPaid = { ...paid };
  let total = 0; let shared = 0;
  const [a, b] = USERS;
  const add = (to, who, n) => { for (const id of who === 'both' ? USERS.map((u) => u.id) : [who]) to[id] = (to[id] || 0) + (who === 'both' ? n / 2 : n); };
  let settled = 0; // paid from b to a, minus a to b
  list.forEach((x) => {
    if (isSettle(x)) { settled += x.paidBy === b.id ? x.amount : -x.amount; return; }
    total += x.amount; add(paid, x.paidBy, x.amount);
    if (x.split) { shared += x.amount; add(sharedPaid, x.paidBy, x.amount); }
  });
  const net = sharedPaid[a.id] - shared / 2 - settled; // > 0 means b owes a
  return { total, paid, shared, each: shared / 2, owed: Math.abs(net), from: net > 0 ? b : a, to: net > 0 ? a : b };
}

function expenseRow(x, showSplit) {
  const u = userOf(x.paidBy);
  if (isSettle(x)) {
    return `<button class="row expense settle-row" data-action="edit-expense" data-id="${x.id}">
      ${avatar(x.paidBy, 'md')}
      <span class="ex-main"><b>Settled up</b><small>${u?.name} paid ${userOf(x.to)?.name} back</small></span>
      <span class="ex-amt">${fmtCash(x.amount)}</span></button>`;
  }
  const both = x.paidBy === 'both';
  const note = both ? 'Each paid half' : x.split ? (showSplit ? `Split · ${fmtCash(x.amount / 2)} each` : 'Split') : `Just ${u?.name}`;
  return `<button class="row expense" data-action="edit-expense" data-id="${x.id}">
    ${avatar(x.paidBy, 'md')}
    <span class="ex-main"><b>${esc(x.title)}</b><small>${both ? 'Both paid' : `${u?.name} paid`} · ${note}</small></span>
    <span class="ex-amt">${fmtCash(x.amount)}</span></button>`;
}

views.piggy = () => {
  const key = piggyMonth;
  const all = expensesIn(key);
  const list = spending(all);
  const st = expenseStats(all);
  const showSplit = state.settings.showSplit !== false; // on unless turned off in Settings
  const [, last] = monthBounds(key);
  const isNow = key === monthKey(new Date());
  const daysSoFar = isNow ? new Date().getDate() : last.getDate();
  const byDay = {};
  all.forEach((x) => { (byDay[x.date] ||= []).push(x); });
  const months = [...new Set(state.expenses.map((x) => x.date.slice(0, 7)))].sort().reverse();

  // What people come here for first: who owes whom. Then where the month's money went.
  const balance = showSplit ? `<div class="card balance${st.owed < 0.005 ? ' even' : ''}">
    ${st.owed < 0.005 ? `<span class="bal-icon">${icon('check')}</span><div><b>All square</b><small>${fmtCash(st.shared)} shared in ${monthName(key).split(' ')[0]}, ${fmtCash(st.each)} each</small></div>`
      : `${avatar(st.from.id, 'md')}<div><small>${st.from.name} owes ${st.to.name}</small><b class="bal-amt">${fmtCash(st.owed)}</b></div>
      <button class="btn" data-action="settle-up">${icon('check')} Settle up</button>`}
  </div>` : '';
  const share = (u) => (st.total ? (st.paid[u.id] / st.total) * 100 : 0);
  return `<div class="section-title">Money</div>
  <div class="month-nav">
    <button class="btn-round" data-action="piggy-move" data-d="-1" aria-label="Previous month">${icon('chevronLeft')}</button>
    <div class="piggy-month"><h2>${monthName(key)}</h2><span>${monthRange(key)}</span></div>
    <button class="btn-round" data-action="piggy-move" data-d="1" aria-label="Next month">${icon('chevron')}</button>
    ${isNow ? '' : '<button class="btn ghost sm" data-action="piggy-today">This month</button>'}
  </div>
  ${balance}
  <div class="card spend">
    <div class="spend-top"><b>${fmtCash(st.total)}</b><span>spent · ${list.length} expense${list.length === 1 ? '' : 's'} · ${fmtCash(st.total / daysSoFar)} a day</span></div>
    ${st.total ? `<div class="spend-bar">${USERS.map((u) => `<i class="bar-${u.color}" style="width:${share(u).toFixed(1)}%"></i>`).join('')}</div>
    <div class="spend-key">${USERS.map((u) => `<span>${avatarImg(u, 'xs')}${u.name} paid <b>${fmtCash(st.paid[u.id])}</b> · ${Math.round(share(u))}%</span>`).join('')}</div>` : ''}
  </div>
  <div class="card">
    <div class="card-head">${icon('calendar')}<h2>Log</h2></div>
    ${all.length ? Object.entries(byDay).map(([d, xs]) => `<div class="ex-day"><div class="ex-day-head"><span>${dayLabel(d)}</span><span>${fmtCash(spending(xs).reduce((a, x) => a + x.amount, 0))}</span></div>
      <div class="list">${xs.map((x) => expenseRow(x, showSplit)).join('')}</div></div>`).join('')
    : `<div class="piggy-empty">${icon('piggy')}<p>Nothing logged for ${monthName(key)} yet.</p><button class="btn" data-action="add-expense">${icon('plus')} Add an expense</button></div>`}
  </div>
  ${months.length > 1 ? `<div class="card">
    <div class="card-head">${icon('piggy')}<h2>By month</h2></div>
    <div class="list">${months.map((m) => { const s2 = expenseStats(expensesIn(m)); return `<button class="row month-row${m === key ? ' on' : ''}" data-action="piggy-goto" data-m="${m}">
      <span class="ex-main"><b>${monthName(m)}</b><small>${USERS.map((u) => `${u.name} ${fmtCash(s2.paid[u.id])}`).join(' · ')}</small></span><span class="ex-amt">${fmtCash(s2.total)}</span></button>`; }).join('')}</div>
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
    <div class="field"><label>Who paid?</label>${whoPicker(x.paidBy, 'both')}<div class="hint">Both means each of you paid half, so nobody owes anything on it.</div></div>
    <div class="setting-row imp-row"><div><b>Split 50/50</b><div class="hint">Counts toward what each of you owes. Turn off for a personal expense.</div></div>
      <button class="switch" id="ex-split" role="switch" aria-checked="${!!x.split}" data-action="toggle-important"></button></div>
    <div class="sheet-actions">
      ${ex ? `<button class="btn danger" data-action="del-expense" data-id="${x.id}">${icon('trash')} Delete</button><span class="spacer"></span>` : ''}
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="save-expense" data-id="${x.id}">${ex ? 'Save' : 'Add expense'}</button>
    </div>`);
  if (!ex) setTimeout(() => $('#ex-title')?.focus(), 50);
}

/* ---------- Fridge ---------- */
// Each item: { id, name, qty, cat, added, use } with `use` an optional use-by day.
const catOf = (id) => FRIDGE_CATS.find((c) => c.id === id) || FRIDGE_CATS.at(-1);
const daysLeft = (it) => (it.use ? daysIncl(isoDay(new Date()), it.use) - 1 : null);
const suggestUse = (cat) => (catOf(cat).days ? isoDay(addDays(new Date(), catOf(cat).days)) : '');
function useLabel(it) {
  const d = daysLeft(it);
  if (d === null) return '';
  if (d < 0) return `<span class="use late">Past use-by</span>`;
  if (d === 0) return `<span class="use late">Use today</span>`;
  return `<span class="use${d <= 2 ? ' soon' : ''}">Use in ${d} day${d === 1 ? '' : 's'}</span>`;
}
function fridgeRow(it) {
  const d = daysLeft(it);
  return `<div class="fr-row">
    <span class="fr-ico">${icon(catOf(it.cat).icon)}</span>
    <button class="fr-main" data-action="edit-fridge" data-id="${it.id}">
      <b>${esc(it.name)}</b><small>${it.use ? useLabel(it) : `Added ${fmtShort(it.added)}`}</small></button>
    <span class="fr-qty${d !== null && d <= 0 ? ' late' : ''}">×${it.qty}</span>
    <button class="btn-round sm" data-action="use-fridge" data-id="${it.id}" aria-label="Use one ${esc(it.name)}">${icon('minus')}</button></div>`;
}
// One list, soonest use-by first, so nothing shows twice. Chips at the top narrow it to one kind.
let fridgeCat = 'all';
views.fridge = () => {
  const items = state.fridge || [];
  if (!items.length) {
    return `<div class="section-title">Kitchen</div><div class="card fr-empty">${icon('fridge')}<p>Nothing logged yet. Add what's in the fridge, or snap a grocery receipt and the items get added for you.</p>
      <div class="fr-empty-btns"><button class="btn" data-action="add-fridge">${icon('plus')} Add an item</button><label class="btn ghost">${icon('receipt')} Scan receipt<input type="file" id="receipt-file" accept="image/*" hidden></label></div></div>`;
  }
  const cats = FRIDGE_CATS.filter((c) => items.some((it) => catOf(it.cat).id === c.id));
  if (fridgeCat !== 'all' && !cats.some((c) => c.id === fridgeCat)) fridgeCat = 'all';
  const shown = items.filter((it) => fridgeCat === 'all' || catOf(it.cat).id === fridgeCat)
    .sort((a, b) => (a.use || '9').localeCompare(b.use || '9') || a.name.localeCompare(b.name));
  const soon = items.filter((it) => daysLeft(it) !== null && daysLeft(it) <= 2).length;
  const chip = (id, label, n) => `<button class="chip${fridgeCat === id ? ' on' : ''}" data-action="fridge-cat" data-v="${id}">${label}<span>${n}</span></button>`;
  return `<div class="section-title">Kitchen<span class="spacer"></span><span class="hint">${soon ? `${soon} to use soon` : 'All fresh'}</span></div>
  <div class="chips fr-chips">${chip('all', 'All', items.length)}${cats.map((c) => chip(c.id, c.label, items.filter((it) => catOf(it.cat).id === c.id).length)).join('')}</div>
  <div class="card"><div class="fr-list">${shown.map(fridgeRow).join('')}</div></div>`;
};
const catSelect = (id, cur) => `<select class="input" id="${id}">${FRIDGE_CATS.map((c) => `<option value="${c.id}"${c.id === cur ? ' selected' : ''}>${c.label}</option>`).join('')}</select>`;
function openFridgeSheet(it) {
  const x = it || { id: '', name: '', qty: 1, cat: 'other', use: '' };
  openSheet(`${sheetHead(it ? 'Edit item' : 'Add to fridge', 'fridge')}
    <div class="field"><label for="fr-name">Item</label><input class="input" id="fr-name" value="${esc(x.name)}" placeholder="e.g. Eggs"></div>
    <div class="field-row">
      <div class="field"><label for="fr-qty">How many</label><input class="input" id="fr-qty" type="number" inputmode="numeric" min="1" step="1" value="${x.qty}"></div>
      <div class="field"><label for="fr-cat">Kind</label>${catSelect('fr-cat', x.cat)}</div>
    </div>
    <div class="field"><label for="fr-use">Use by <span class="muted">(optional)</span></label><input class="input" type="date" id="fr-use" value="${x.use || ''}"></div>
    <div class="sheet-actions">
      ${it ? `<button class="btn danger" data-action="del-fridge" data-id="${x.id}">${icon('trash')} Remove</button><span class="spacer"></span>` : ''}
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="save-fridge" data-id="${x.id}">${it ? 'Save' : 'Add'}</button>
    </div>`);
}
// The receipt's items, ticked, for a once-over before they go in the fridge.
function openReceiptSheet(found) {
  openSheet(`${sheetHead('From your receipt', 'receipt')}
    ${found.length ? `<p class="hint">Untick anything that isn't for the fridge and fix any names the reader got wrong.</p>
    <div class="rc-list" data-nofocus>${found.map((f, i) => `<div class="rc-row" data-i="${i}">
      <button class="check on rc-tick" data-action="rc-tick" aria-label="Include">${icon('check')}</button>
      <input class="input rc-name" value="${esc(f.name)}" aria-label="Item">
      <input class="input rc-qty" type="number" min="1" value="${f.qty}" aria-label="How many">
      ${catSelect(`rc-cat-${i}`, f.cat).replace('class="input"', 'class="input rc-cat"')}</div>`).join('')}</div>`
    : `<p class="hint">No items found on that photo. Try again with the receipt flat, in good light and filling the frame.</p>`}
    <div class="sheet-actions">
      <button class="btn ghost" data-action="close-sheet">${found.length ? 'Cancel' : 'Close'}</button>
      ${found.length ? `<button class="btn" data-action="save-receipt">Add to fridge</button>` : ''}
    </div>`);
  $('#sheet').dataset.kind = 'receipt';
}
async function scanReceipt(file) {
  openSheet(`${sheetHead('Reading receipt', 'receipt')}
    <p class="hint">Reading the items on this device. This can take a few seconds.</p>
    <div class="rc-bar"><i id="rc-progress"></i></div>`);
  $('#sheet').dataset.kind = 'receipt';
  try {
    const found = await readReceipt(file, (p) => { const b = $('#rc-progress'); if (b) b.style.width = `${Math.round(p * 100)}%`; });
    if ($('#sheet').dataset.kind === 'receipt') openReceiptSheet(found);
  } catch (err) {
    closeSheet();
    toast(err.message || "Couldn't read that photo");
  }
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

function healthBody() {
  preloadGoogle().catch(() => {});
  if (!healthAvailable()) {
    return `<p class="hint">Not set up yet. Fitbit sign-in needs a one-time setup for this site.</p>
      <details class="setup"><summary>One-time setup</summary><ol class="hint">
        <li>In Google Cloud, turn on the <b>Google Health API</b> and add each person's Google account as a test user.</li>
        <li>Create a <b>Web application</b> OAuth client with <code>${esc(location.origin)}</code> as an authorized JavaScript origin.</li>
        <li>Save its client ID as the GitHub secret <code>GOOGLE_HEALTH_CLIENT_ID</code> and run <b>Deploy to GitHub Pages</b>.</li>
      </ol></details>`;
  }
  return `${USERS.map((u) => healthRow(u.id)).join('')}
    <p class="hint">Each person signs in with the Google account their Fitbit uses. Google's pass lasts about an hour and stays on this screen only; the daily numbers are shared with the household when sync is on.</p>
    ${healthPeople().length ? `<div style="display:flex;gap:8px;flex-wrap:wrap">${healthPeople().map((u) => `<button class="btn ghost" data-action="health-disconnect" data-v="${u.id}">${icon('trash')} Remove ${u.name}'s data</button>`).join('')}</div>` : ''}`;
}

// A connection is one row with its status; tapping it opens the details and setup steps.
let openConn = null; // stays open across re-renders
const connRow = (id, ic, title, status, ok, body) => `<details class="conn" data-conn="${id}"${openConn === id ? ' open' : ''}>
  <summary><span class="ibox ${ok ? 'c-green-ico' : 'c-amber-ico'}">${icon(ic)}</span><span class="conn-text"><b>${title}</b><small>${status}</small></span>${icon('chevron', 'chev')}</summary>
  <div class="conn-body">${body}</div></details>`;

views.settings = () => {
  const s = state.settings;
  const pge = syncMessage();
  const fit = healthPeople();
  return `
  <div class="settings">
  <div class="section-title">Settings</div>
    <h3 class="set-group">Display</h3>
    <div class="card">
      <div class="field"><label for="set-place">Weather location</label>
        <div style="display:flex;gap:8px"><input class="input" id="set-place" placeholder="Search a city" value="${esc(s.place.name)}">
        <button class="btn" data-action="place-search" aria-label="Search">${icon('search')}</button></div>
        <div class="chips" id="place-results"></div></div>
      <div class="setting-row"><div><b>Temperature</b></div>
        <div class="seg">${['F', 'C'].map((u) => `<button class="${s.unit === u ? 'on' : ''}" data-action="set-unit" data-v="${u}">°${u}</button>`).join('')}</div></div>
      <div class="setting-row"><div><b>Theme</b><div class="hint">Auto goes dark from 9 PM to 6 AM.</div></div>
        <div class="seg">${['auto', 'light', 'dark'].map((t) => `<button class="${s.theme === t ? 'on' : ''}" data-action="set-theme" data-v="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
      <div class="setting-row"><div><b>24-hour clock</b></div>
        <button class="switch" role="switch" aria-checked="${s.clock24}" data-action="set-clock24" aria-label="24-hour clock"></button></div>
      <div class="setting-row"><div><b>Keep screen on</b><div class="hint">Stops the screen from sleeping while the dashboard is open.</div></div>
        <button class="switch" role="switch" aria-checked="${s.wakeLock}" data-action="set-wake" aria-label="Keep screen on"></button></div>
      <div class="setting-row"><div><b>Show who owes whom</b><div class="hint">The 50/50 balance and Settle up on the Money tab.</div></div>
        <button class="switch" role="switch" aria-checked="${s.showSplit !== false}" data-action="toggle-split" aria-label="Show who owes whom"></button></div>
    </div>
    <h3 class="set-group">Household</h3>
    ${houseCard()}
    <h3 class="set-group">Connections</h3>
    <div class="card conns">
      ${connRow('pge', 'zap', 'PG&amp;E energy', energyDays().length ? `${energyDays().length} days of data${pge.ok ? '' : ' · not syncing'}` : 'Not connected', pge.ok, `
        ${syncBanner(true, false)}
        <div class="field"><label for="energy-pass">Sync passphrase</label>
          <div style="display:flex;gap:8px"><input class="input" id="energy-pass" type="password" autocomplete="off" placeholder="${energyPass ? 'Saved on this device' : 'The ENERGY_PASSPHRASE you chose'}">
          <button class="btn" data-action="energy-connect">${energyPass ? 'Update' : 'Connect'}</button></div></div>
        <details class="setup"><summary>How to sign in to PG&amp;E (one time)</summary>
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
        </div>`)}
      ${connRow('fitbit', 'heart', 'Fitbit health', !healthAvailable() ? 'Not set up for this site' : fit.length ? `${fit.map((u) => u.name).join(' and ')} connected` : 'Nobody connected yet', healthAvailable() && fit.length > 0, healthBody())}
      ${connRow('email', 'bell', 'Summary email', '7 AM, noon, 5 PM and 9 PM', true, `
        <p class="hint">A GitHub job emails the household with what's on, open chores, stars and anything in the fridge to use up.</p>
        <details class="setup"><summary>Turn it on (one time)</summary><ol class="hint">
          <li>On the sending Gmail account, create an <b>app password</b> (Google Account › Security › 2-Step Verification › App passwords).</li>
          <li>In the Home-Assistance repo, open <b>Settings › Secrets and variables › Actions</b> and add <code>EMAIL_SMTP_USER</code> (that Gmail address), <code>EMAIL_SMTP_PASSWORD</code> (the app password), <code>EMAIL_TO</code> (who gets it, comma separated) and <code>HOUSEHOLD_PASSPHRASE</code> (the passphrase you sync with).</li>
          <li>To try it now, run <b>Daily summary email</b> in the repo's <b>Actions</b> tab.</li>
        </ol></details>`)}
    </div>
    <h3 class="set-group">Danger zone</h3>
    <div class="card">
      <p class="hint">Display settings stay on this device. Events, chores and expenses are shared with your other devices when sync is on. Weather comes from Open-Meteo.</p>
      <button class="btn danger" data-action="reset">${icon('trash')} Clear events and chores</button>
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
  if ((swipe.on || swipe.busy) && !swipeNav) return; // not mid-swipe; the swipe renders when it lands
  const r = currentRoute();
  const view = $('#view');
  const y = window.scrollY;
  const prev = $('#wk-scroll');
  if (prev) wkScroll = prev.scrollTop;
  view.innerHTML = views[r]();
  const wk = $('#wk-scroll');
  if (wk) wk.scrollTop = wkScroll ?? Math.max(0, (new Date().getHours() - DAY_START - 1) * HOUR_PX);
  window.scrollTo(0, y);
  if (swipeNav) {
    // Arrived by swipe: the page already slid in, so just swap it in place.
    swipeNav = false; anim = null;
    view.style.transition = ''; view.style.transform = ''; dropPeek();
  }
  if (anim === 'fwd' || anim === 'back') animate(view, `enter-${anim}`);
  else if (anim === 'cal') animate($('.cal-body'), 'fade-in');
  updateBadge();
}

let lastRoute = null;
function render() {
  const r = currentRoute();
  const order = (id) => PAGES.findIndex((p) => p.id === id);
  // The big sky panel is for Home; other pages get a slim strip with the time.
  $('#hero').classList.toggle('slim', r !== 'home');
  setFab(r);
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
  if (first && !$('#sheet [data-nofocus]')) setTimeout(() => first.focus(), 50);
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
// allowBoth: true adds Both and Anyone; 'both' adds only Both.
function whoPicker(selected, allowBoth) {
  const opts = [...USERS.map((u) => ({ id: u.id, label: u.name })), ...(allowBoth ? [{ id: 'both', label: 'Both' }] : []), ...(allowBoth === true ? [{ id: '', label: 'Anyone' }] : [])];
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
    ${ev ? seriesNote(e) : repeatFields(e.date)}
    <div class="field"><label>Stars when done</label><div class="seg" id="ev-stars">${[0, 1, 3, 5, 10].map((n) => `<button class="${eventStars(e) === n ? 'on' : ''}" data-action="pick-seg" data-v="${n}">${n || 'None'}</button>`).join('')}</div></div>
    ${impRow(e.important)}
    ${ev && e.date <= isoDay(new Date()) ? `<button class="btn ${eventDone(e) ? 'ghost' : 'done-btn'} wide" data-action="toggle-event" data-id="${e.id}" data-close="1">${icon('check')} ${eventDone(e) ? 'Mark not done' : 'Mark done'}</button>` : ''}
    ${ev && seriesOf(e).length > 1 ? `<button class="btn ghost wide" data-action="del-series" data-id="${e.id}">${icon('trash')} Delete all ${seriesOf(e).length} days</button>` : ''}
    <div class="sheet-actions">
      ${ev ? `<button class="btn danger" data-action="del-event" data-id="${e.id}">${icon('trash')} Delete</button><span class="spacer"></span>` : ''}
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="save-event" data-id="${e.id}">${ev ? 'Save' : 'Add event'}</button>
    </div>`);
}

// A repeating event is saved as one event per day, linked by a shared series id. Each day can
// then be ticked, earn stars and be edited on its own, and screens on older versions of the app
// simply see ordinary events.
const REPEATS = { '': 'Never', daily: 'Every day', weekly: 'Every week' };
const REPEAT_STEP = { daily: 1, weekly: 7 };
const MAX_REPEATS = 60; // all events share one synced document, so keep a series small
const seriesOf = (e) => (e.series ? state.events.filter((x) => x.series === e.series).sort(byStart) : [e]);
const defaultUntil = (date, rep) => (date ? isoDay(addDays(new Date(`${date}T12:00`), rep === 'weekly' ? 28 : 6)) : '');

function repeatFields(date) {
  return `<div class="field"><label>Repeats</label><div class="seg" id="ev-repeat">${Object.entries(REPEATS).map(([k, l]) => `<button class="${k ? '' : 'on'}" data-action="pick-repeat" data-v="${k}">${l}</button>`).join('')}</div></div>
    <div class="field" id="ev-until-field" hidden><label for="ev-until">Repeats until</label><input class="input" type="date" id="ev-until" min="${date}"></div>`;
}
function seriesNote(e) {
  const all = seriesOf(e);
  if (all.length < 2) return '';
  return `<p class="hint">Repeats ${all.length} times, ${dayLabel(all[0].date)} to ${dayLabel(all[all.length - 1].date)}. Changes and Delete apply to this day only.</p>`;
}
// The days a new event lands on: its own date, then every day or week up to the end day.
function repeatDates(date, rep, until) {
  if (!rep) return [date];
  const out = [];
  for (let d = new Date(`${date}T12:00`); isoDay(d) <= until; d = addDays(d, REPEAT_STEP[rep])) out.push(isoDay(d));
  return out;
}

function daySheetHtml(iso) {
  const evs = eventsOn(iso);
  const tasks = iso === isoDay(new Date()) ? tasksToday() : [];
  return `${sheetHead(new Date(`${iso}T12:00`).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }), 'calendar')}
    ${evs.length ? `<div class="list">${evs.map((e) => eventRow(e)).join('')}</div>` : ''}
    ${tasks.length ? `<div class="task-list day-tasks">${tasks.map((t) => taskCard(t, userOf(t.who), true)).join('')}</div>` : ''}
    ${evs.length || tasks.length ? '' : '<p class="muted">Nothing planned.</p>'}
    <div class="sheet-actions"><button class="btn" data-action="add-event" data-d="${iso}">${icon('plus')} Add event</button></div>`;
}

// Ticked from the day pop-up: redraw it so the tick shows there too.
function redrawDaySheet() {
  const sheet = $('#sheet');
  if (!sheet.hidden && sheet.dataset.kind === 'day') sheet.innerHTML = daySheetHtml(sheet.dataset.d);
}

function openDaySheet(iso) {
  openSheet(daySheetHtml(iso));
  $('#sheet').dataset.kind = 'day';
  $('#sheet').dataset.d = iso;
}

function openTaskSheet(task, who = USERS[0].id) {
  const t = task || { id: '', title: '', who, repeat: 'daily', stars: 5 };
  openSheet(`${sheetHead(task ? 'Edit chore' : 'New chore', 'checkSquare')}
    <div class="field"><label for="task-title">Chore</label><input class="input" id="task-title" value="${esc(t.title)}" placeholder="e.g. Take out trash"></div>
    <div class="field"><label>Assigned to</label>${whoPicker(t.who, false)}</div>
    ${impRow(t.important)}
    <div class="field-row">
      <div class="field"><label>Repeats</label><div class="seg" id="task-repeat">${Object.entries(REPEAT_LABEL).map(([k, l]) => `<button class="${t.repeat === k ? 'on' : ''}" data-action="pick-seg" data-v="${k}">${l}</button>`).join('')}</div></div>
      <div class="field"><label>Stars</label><div class="seg" id="task-stars">${[1, 3, 5, 10].map((n) => `<button class="${t.stars === n ? 'on' : ''}" data-action="pick-seg" data-v="${n}">${n}</button>`).join('')}</div></div>
    </div>
    <div class="sheet-actions">
      ${task ? `<button class="btn danger" data-action="del-task" data-id="${t.id}">${icon('trash')} Delete</button><span class="spacer"></span>` : ''}
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="save-task" data-id="${t.id}">${task ? 'Save' : 'Add chore'}</button>
    </div>`);
}

/* =========================================================
   Actions
   ========================================================= */
const actions = {
  'close-sheet': closeSheet,
  'add-menu': openAddMenu,
  'pick-who': (el) => {
    el.parentElement.querySelectorAll('.who-opt').forEach((b) => b.classList.toggle('on', b === el));
    // The note being written shows the face of whoever it is from.
    const dir = $('#thx-dir');
    if (dir) dir.textContent = `To ${userOf(otherOf(el.dataset.who))?.name}`;
    const face = $('#note-paper > .av');
    if (face && userOf(el.dataset.who)) face.outerHTML = avatar(el.dataset.who, 'sm');
  },
  'toggle-important': (el) => el.setAttribute('aria-checked', String(el.getAttribute('aria-checked') !== 'true')),
  'pick-seg': (el) => {
    el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
  },

  'cal-move': (el) => {
    const d = Number(el.dataset.d);
    calCursor = calView() === 'month'
      ? new Date(calCursor.getFullYear(), calCursor.getMonth() + d, 1)
      : addDays(calCursor, d * 7);
  },
  'cal-today': () => { calCursor = new Date(); },
  'cal-view': (el) => { state.settings.calPick = el.dataset.v; save(); },
  'cal-chores': () => { state.settings.calChores = !state.settings.calChores; save(); },
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
    const data = { title, date, time: $('#ev-time').value || '', end: $('#ev-end').value || '', who: pickedWho(), important: pickedImportant(), stars: Number($('#ev-stars .on')?.dataset.v ?? 5) };
    const existing = state.events.find((x) => x.id === el.dataset.id);
    if (existing) {
      // Stars already given keep their old count and people: take them back first, give the new ones after.
      const redo = eventDone(existing) && (existing.stars !== data.stars || existing.who !== data.who);
      if (redo) awardStars(existing, 'event', false);
      Object.assign(existing, data);
      if (redo) awardStars(existing, 'event', true);
    } else {
      const rep = $('#ev-repeat .on')?.dataset.v || '';
      const until = $('#ev-until')?.value || '';
      if (rep && !until) { toast('Pick the day it stops repeating'); return; }
      if (rep && until < date) { toast('The end day must be on or after the start'); return; }
      const dates = repeatDates(date, rep, until);
      if (dates.length > MAX_REPEATS) { toast(`That's ${dates.length} days. Pick an earlier end day (${MAX_REPEATS} at most).`); return; }
      const id = `e${Date.now()}`;
      const series = dates.length > 1 ? id : undefined;
      dates.forEach((d, i) => state.events.push({ id: i ? `${id}-${i}` : id, ...data, date: d, ...(series && { series }) }));
      if (series) toast(`Added ${dates.length} days`);
    }
    calCursor = new Date(`${date}T12:00`);
    closeSheet();
  },
  'toggle-event': (el) => {
    const e = state.events.find((x) => x.id === el.dataset.id);
    if (!e) return;
    if (!eventDone(e) && e.date > isoDay(new Date())) { toast("This hasn't happened yet"); return; }
    // From the event pop-up, use the people and stars picked there, so switching to Both and
    // tapping Mark done pays both instead of only whoever the event had before.
    if (el.dataset.close && !eventDone(e)) {
      if ($('#who-pick .who-opt.on')) e.who = pickedWho();
      if ($('#ev-stars .on')) e.stars = Number($('#ev-stars .on').dataset.v);
    }
    awardStars(e, 'event', !eventDone(e));
    if (el.dataset.close) closeSheet();
    redrawDaySheet();
  },
  'pick-repeat': (el) => {
    el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
    const until = $('#ev-until');
    $('#ev-until-field').hidden = !el.dataset.v;
    const date = $('#ev-date').value;
    until.min = date;
    if (el.dataset.v && (!until.value || until.value < date)) until.value = defaultUntil(date, el.dataset.v);
  },
  'board-period': (el) => { state.settings.boardPeriod = el.dataset.v; },
  'del-event': (el) => {
    state.events = state.events.filter((e) => e.id !== el.dataset.id);
    closeSheet();
  },
  'del-series': (el) => {
    const e = state.events.find((x) => x.id === el.dataset.id);
    if (!e?.series || !confirm(`Delete all ${seriesOf(e).length} days of "${e.title}"?`)) return;
    state.events = state.events.filter((x) => x.series !== e.series);
    closeSheet();
  },

  'add-task': (el) => openTaskSheet(null, el.dataset.who),
  'edit-task': (el) => openTaskSheet(state.tasks.find((x) => x.id === el.dataset.id)),
  'save-task': (el) => {
    const title = $('#task-title').value.trim();
    if (!title) { toast('Name the chore first'); return; }
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
    awardStars(t, 'task', !isDone(t));
    justTicked = t.id; setTimeout(() => { justTicked = null; }, 600);
    redrawDaySheet();
  },

  thank: (el) => openThankSheet({ win: el.dataset.win, to: el.dataset.to, title: el.dataset.title, base: el.dataset.base }),
  'thanks-line': (el) => { $('#thx-text').value = el.dataset.v; },
  'send-thanks': (el) => {
    const to = $('#who-pick') ? otherOf(pickedWho()) : el.dataset.to;
    if (!userOf(to)) return;
    if (el.dataset.base) el.dataset.win = `${el.dataset.base}@${to}`;
    if ($('#who-pick')) state.settings.lastWriter = pickedWho();
    const text = $('#thx-text').value.trim().slice(0, THANKS_MAX);
    const emoji = $('#thx-emoji .on')?.dataset.v || THANKS_EMOJI[0];
    (state.thanks ||= []).push({ id: `k${Date.now()}`, from: otherOf(to), to, emoji, text, ...(el.dataset.win && { win: el.dataset.win, for: el.dataset.title }), at: Date.now(), readAt: 0 });
    closeSheet();
    toast(`Sent to ${userOf(to).name} ${emoji}`);
  },
  'open-thanks': (el) => openThanks(el.dataset.to),
  'view-thanks': (el) => {
    const k = el.dataset.id ? state.thanks.find((x) => x.id === el.dataset.id) : thanksFor(el.dataset.win).find((x) => x.to === el.dataset.to);
    if (k) openThanksDetail(k);
  },
  'del-thanks': (el) => {
    const k = state.thanks.find((x) => x.id === el.dataset.id);
    if (!k) return;
    state.thanks = state.thanks.filter((x) => x !== k);
    closeSheet();
    toast('Taken back', ['Undo', () => { state.thanks.push(k); save(); renderView(); }]);
  },
  'jar-week': (el) => { jarWeek = Math.max(0, jarWeek + Number(el.dataset.d)); },
  'add-note': () => openNoteSheet(null),
  'edit-note': (el) => {
    const n = state.notes.find((x) => x.id === el.dataset.id);
    if (!n) return;
    if (isNewNote(n)) n.seen = { ...n.seen, [me()]: Date.now() };
    openNoteSheet(n);
  },
  'pick-color': (el) => {
    el.parentElement.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b === el));
    $('#note-paper').className = `note-edit p-${el.dataset.v}`;
  },
  'save-note': (el) => {
    const text = $('#note-text').value.trim().slice(0, NOTE_MAX);
    if (!text) { toast('Write something first'); return; }
    const keep = $('#note-keep .on')?.dataset.v || '';
    const until = keep === 'today' ? isoDay(new Date()) : keep === 'week' ? isoDay(addDays(new Date(), 6)) : '';
    const by = pickedWho() || USERS[0].id;
    const data = { text, by, color: $('#note-color .on')?.dataset.v || 'butter' };
    const n = state.notes.find((x) => x.id === el.dataset.id);
    if (n) {
      // Changing how long it stays counts from today; leaving it alone keeps the day it was given.
      const keepWas = !n.until ? '' : n.until === isoDay(new Date()) ? 'today' : 'week';
      Object.assign(n, data, keep === keepWas ? {} : { until });
    } else (state.notes ||= []).push({ id: `n${Date.now()}`, ...data, until, at: Date.now() });
    state.settings.lastWriter = by;
    closeSheet();
  },
  'del-note': (el) => {
    const n = state.notes.find((x) => x.id === el.dataset.id);
    if (!n) return;
    const at = state.notes.indexOf(n);
    state.notes = state.notes.filter((x) => x !== n);
    closeSheet();
    toast('Note taken down', ['Undo', () => { state.notes.splice(at, 0, n); save(); renderView(); }]);
  },
  // Opening the news marks it seen on that person's phone. The fridge leaves it for the phone.
  'open-bucket-news': () => {
    if (me()) newDones().forEach((b) => { b.seen = Date.now(); });
    goTo('bucket');
  },
  'add-bucket': () => openBucketSheet(null),
  'edit-bucket': (el) => { const b = state.bucket.find((x) => x.id === el.dataset.id); if (b) openBucketSheet(b); },
  'save-bucket': (el) => {
    const text = $('#bk-text').value.trim().replace(/\s+/g, ' ').slice(0, BUCKET_MAX);
    if (!text) { toast('Say what it is first'); return; }
    const kind = $('#bk-kind .on')?.dataset.v || 'do';
    const b = state.bucket.find((x) => x.id === el.dataset.id);
    if (b) Object.assign(b, { text, kind });
    else {
      const by = me() || pickedWho() || USERS[0].id;
      (state.bucket ||= []).push({ id: `b${Date.now()}`, text, kind, by, at: Date.now() });
      state.settings.lastWriter = by;
    }
    closeSheet();
  },
  'del-bucket': (el) => {
    const b = state.bucket.find((x) => x.id === el.dataset.id);
    if (!b) return;
    const at = state.bucket.indexOf(b);
    state.bucket = state.bucket.filter((x) => x !== b);
    closeSheet();
    toast('Removed from the list', ['Undo', () => { state.bucket.splice(at, 0, b); save(); renderView(); }]);
  },
  'tick-bucket': (el) => {
    const b = state.bucket.find((x) => x.id === el.dataset.id);
    if (!b) return;
    if (!b.doneAt) { openBucketTick(b); return; }
    const was = { ...b };
    for (const k of ['doneAt', 'doneBy', 'from', 'seen']) delete b[k];
    toast('Back on the list', ['Undo', () => { Object.assign(b, was); save(); renderView(); }]);
  },
  'done-bucket': (el) => {
    const b = state.bucket.find((x) => x.id === el.dataset.id);
    if (!b) return;
    const doneBy = pickedWho() || 'both';
    // Whoever ticked it off: this phone's owner, or on the fridge the one person who went.
    const from = me() || (userOf(doneBy) ? doneBy : '');
    Object.assign(b, { doneAt: Date.now(), doneBy, ...(from && { from }) });
    closeSheet();
    toast(`Ticked off ${b.text} · +${loveOf(b)} love points ❤️`);
  },
  'set-me': (el) => { state.settings.me = el.dataset.v; },

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
  'add-fridge': () => openFridgeSheet(null),
  'edit-fridge': (el) => openFridgeSheet(state.fridge.find((x) => x.id === el.dataset.id)),
  'save-fridge': (el) => {
    const name = $('#fr-name').value.trim();
    if (!name) { toast('Add what the item is'); return; }
    const data = { name, qty: Math.max(1, Math.round(Number($('#fr-qty').value) || 1)), cat: $('#fr-cat').value, use: $('#fr-use').value };
    const existing = state.fridge.find((x) => x.id === el.dataset.id);
    if (existing) Object.assign(existing, data);
    else state.fridge.push({ id: `f${Date.now()}`, added: isoDay(new Date()), ...data, use: data.use || suggestUse(data.cat) });
    closeSheet();
  },
  'del-fridge': (el) => { state.fridge = state.fridge.filter((x) => x.id !== el.dataset.id); closeSheet(); },
  'use-fridge': (el) => {
    const it = state.fridge.find((x) => x.id === el.dataset.id);
    if (!it) return;
    const before = { ...it }; const at = state.fridge.indexOf(it);
    it.qty -= 1;
    if (it.qty <= 0) state.fridge = state.fridge.filter((x) => x !== it);
    // A slip of the finger is one tap to put back.
    toast(it.qty <= 0 ? `${it.name} is used up` : `Used one ${it.name}`, ['Undo', () => {
      const cur = state.fridge.find((x) => x.id === before.id);
      if (cur) Object.assign(cur, before); else state.fridge.splice(at, 0, before);
      save(); renderView();
    }]);
  },
  'fridge-cat': (el) => { fridgeCat = el.dataset.v; },
  'rc-tick': (el) => { el.classList.toggle('on'); el.closest('.rc-row').classList.toggle('off', !el.classList.contains('on')); },
  'save-receipt': () => {
    const today = isoDay(new Date()); const t = Date.now();
    let n = 0;
    $('#sheet').querySelectorAll('.rc-row').forEach((row, i) => {
      const name = row.querySelector('.rc-name').value.trim();
      if (!row.querySelector('.rc-tick').classList.contains('on') || !name) return;
      const cat = row.querySelector('.rc-cat').value;
      const qty = Math.max(1, Math.round(Number(row.querySelector('.rc-qty').value) || 1));
      const same = state.fridge.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (same) { same.qty += qty; same.added = today; same.use = suggestUse(cat) || same.use; } else state.fridge.push({ id: `f${t + i}`, name, qty, cat, added: today, use: suggestUse(cat) });
      n += 1;
    });
    closeSheet();
    toast(`Added ${n} item${n === 1 ? '' : 's'} to the fridge`);
  },
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
  'settle-up': () => {
    const st = expenseStats(expensesIn(piggyMonth));
    if (st.owed < 0.005) return;
    if (!confirm(`Mark that ${st.from.name} paid ${st.to.name} ${fmtCash(st.owed)}?`)) return;
    const today = isoDay(new Date());
    const date = piggyMonth === monthKey(new Date()) ? today : isoDay(monthBounds(piggyMonth)[1]);
    state.expenses.push({ id: `x${Date.now()}`, kind: 'settle', title: 'Settled up', amount: Math.round(st.owed * 100) / 100, date, paidBy: st.from.id, to: st.to.id, split: false });
    toast('All square');
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
  'toggle-split': () => { state.settings.showSplit = state.settings.showSplit === false; },

  reset: () => {
    if (!confirm('Clear all events and chores on this device?')) return;
    state = { ...defaultState(), settings: state.settings, expenses: state.expenses, fridge: state.fridge, health: state.health, thanks: state.thanks, notes: state.notes, bucket: state.bucket, events: [], tasks: [] };
    save();
  },
};

// Actions that only open or edit a sheet don't need the page behind it re-rendered.
const NO_RERENDER = new Set(['open-bucket-news', 'add-bucket', 'edit-bucket', 'thank', 'thanks-line', 'view-thanks', 'add-note', 'edit-note', 'pick-color', 'add-menu', 'pick-who', 'pick-seg', 'pick-repeat', 'toggle-important', 'open-day', 'add-event', 'add-event-at', 'edit-event', 'add-task', 'edit-task', 'place-search', 'add-expense', 'edit-expense', 'add-fridge', 'edit-fridge', 'rc-tick']);

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const name = el.dataset.action;
  const fn = actions[name];
  if (!fn) return;
  fn(el, e);
  save();
  if (!NO_RERENDER.has(name)) renderView(['cal-move', 'cal-today', 'cal-view', 'cal-chores'].includes(name) ? 'cal' : undefined);
});

$('#sheet-backdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
document.addEventListener('toggle', (e) => {
  const c = e.target.closest?.('.conn');
  if (c && e.target === c) openConn = c.open ? c.dataset.conn : (openConn === c.dataset.conn ? null : openConn);
}, true);

// Refresh the page behind a sheet when it closes, so a saved event or task shows up.
const sheetObserver = new MutationObserver(() => { if ($('#sheet').hidden) renderView(); });
sheetObserver.observe($('#sheet'), { attributes: true, attributeFilter: ['hidden'] });

// A new fridge item picks its kind from the name, until the kind is chosen by hand.
document.addEventListener('input', (e) => {
  if (e.target.id === 'note-text') $('#note-count').textContent = `${e.target.value.length}/${NOTE_MAX}`;
  if (e.target.id === 'fr-cat') e.target.dataset.picked = '1';
  const cat = $('#fr-cat');
  if (e.target.id === 'fr-name' && cat && !cat.dataset.picked && !$('#sheet [data-action="del-fridge"]')) cat.value = guessCat(e.target.value);
});
document.addEventListener('change', (e) => {
  if (e.target.id !== 'receipt-file' || !e.target.files[0]) return;
  scanReceipt(e.target.files[0]);
  e.target.value = '';
});
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
if (repairLog() | tidyNotes()) save();
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

// Always-on screens (the fridge tablet) can run for days without a reload, and an old version
// syncing with newer ones causes trouble. Each deploy writes version.txt; when it changes, reload
// as soon as nobody is in the middle of something.
let appVersion = null; let updateReady = false;
async function checkVersion() {
  try {
    const res = await fetch(`version.txt?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return; // not deployed this way (running locally)
    const v = (await res.text()).trim();
    if (!v) return;
    appVersion ??= v;
    if (v !== appVersion) updateReady = true;
  } catch { return; } // offline: try again later
  reloadIfReady();
}
function reloadIfReady() {
  if (updateReady && calmToRender() && !swipe.on && !swipe.busy) location.reload();
}
checkVersion();
setInterval(checkVersion, 10 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });
setInterval(reloadIfReady, 30 * 1000);
