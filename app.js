import { icon, hydrateIcons } from './icons.js';
import { createSync, syncAvailable, SYNC_LIMIT } from './sync.js';
import { accountAvailable, confirmIdentity, createInvite, deleteAccount, deletionPreview, homeEmail, joinHome, joinWithCode, myHome, myHomes, noteAccount, removeAccount, renameHome, saveHomeEmail, showCode, signIn as accountSignIn, signOut as accountSignOut, startHome, useHomeFor, watchHome, watchUser } from './account.js';
import { FRIDGE_CATS, guessCat, learnFromReceipt, readExpense, readReceipt } from './receipt.js';
import { healthAvailable, preloadGoogle, readDays, signIn, signOut, SignInExpired } from './health.js';
import { alertRecipients, alertTopicOf, bucketAlert, newAlertTopic, sendAlerts, testAlert, thanksAlert } from './alerts.js';
import FEEDBACK_EMAIL from './feedback-config.js';
import { adminRulesPublished, fmtBytes, isAdmin, loadAdmin, monitors, shortId, worst } from './admin.js';
import { acceptFriend, addComment, addFriend, addPost, COMMENT_MAX, createGroupInvite, deleteDocAt, dropRequest, feedFor, friendsGate, GROUP_NAME_MAX, groupMoney, joinGroup, leaveGroup, myGroups, myProfile, POST_MAX, renameGroup, saveGroupItem, setLike, setMyName, startGroup, unfriend, watchComments, watchFriends, watchGroup, watchPosts } from './social.js';
import { createPhotos, shrink } from './photos.js';
import { choreDone, choreDue, choreKind, choreLabel, EVENT_REPEATS as REPEATS, nextDay, passTurn, repeatDates, repeatUntil, seasonFor, WEEKDAYS } from './schedule.js';
import { boxChoices, boxesForMonth, boxForDay, boxStats, categoryTotals, cleanBoxName, cleanName, EXPENSE_CATS, expenseCat, expenseStats as moneyStats, guessExpenseCat, householdAccounts, joinNames, legacyMembersFor, MAX_MEMBERS, monthTrend, newJoiners, newMember, PERSON_COLORS, sortMembers } from './people.js';

/* =========================================================
   State (saved in this browser's localStorage)
   ========================================================= */
const STORE_KEY = 'home-dashboard.v2';
const WEATHER_KEY = 'home-dashboard.weather.v1';
const ENERGY_KEY = 'home-dashboard.energy.v1';
// PG&E energy is switched off for now (no Energy page, Home card, Settings row or sync).
// The code stays so it can come back: set this to true and turn the sync back on in pages.yml.
const ENERGY_ON = false;

// The people in the household: state.members, synced like everything else, so each household
// names its own (see people.js). `color` picks one of the c-* color families; `avatar` is an
// image, or empty to show the person's initial.
const members = () => sortMembers(state.members);
const userOf = (id) => members().find((u) => u.id === id);

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// A new household starts empty: the first-run screen asks who lives here.
function defaultState() {
  return {
    settings: {
      place: { name: 'Palo Alto', lat: 37.4419, lon: -122.143 },
      unit: 'F',
      theme: 'auto',
      wakeLock: true,
      clock24: false,
    },
    members: [],
    events: [],
    tasks: [],
    stars: {},
    log: [],
    expenses: [],
    fridge: [],
    thanks: [],
    notes: [],
    bucket: [],
    itinerary: [],
    shopping: [],
    boxes: [],
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
// A household from before people were data gets Phu and Nhi back as its members, with the same
// ids its chores, stars and expenses already use. Runs on load and whenever synced data arrives.
function ensureMembers() {
  const legacy = legacyMembersFor(state);
  if (!legacy) return false;
  state.members = legacy;
  return true;
}
const carriedOver = ensureMembers();
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

// A short note at the bottom of the screen. Each extra argument is a [label, fn] button.
function toast(msg, ...btns) {
  const el = $('#toast');
  el.textContent = msg;
  for (const [label, fn] of btns.filter(Boolean)) {
    const b = Object.assign(document.createElement('button'), { className: 'toast-btn', textContent: label });
    b.onclick = (e) => { e.stopPropagation(); el.hidden = true; fn(); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, btns.some(Boolean) ? 4500 : 2200);
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
  const season = seasonFor(new Date());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (season) document.documentElement.dataset.season = season;
  else delete document.documentElement.dataset.season;
  const bars = { christmas: ['#1A0D10', '#F8EEDC'], autumn: ['#1C1412', '#F3E8D2'] }[season] || ['#14162E', '#F7E7CB'];
  $('meta[name="theme-color"]').content = bars[dark ? 0 : 1];
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
  const line = greeting(now), names = joinNames(members().map((u) => esc(u.name)));
  const g = $('#greeting');
  if (g.dataset.line !== line + names) {
    g.dataset.line = line + names;
    // The household's faces next to the greeting (the first three).
    const faces = $('.hero-people');
    faces.hidden = !members().length;
    faces.setAttribute('aria-label', joinNames(members().map((u) => u.name)));
    faces.innerHTML = members().slice(0, 3).map((u) => avatarImg(u, 'lg')).join('');
    g.innerHTML = `<span class="punch">${line}${names ? `, <span class="nowrap">${names}</span>` : ''}</span>`;
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
  setSkyWeather(hero);
}

/* ---------- Weather moving in the sky ---------- */
// The sky shows today's weather: drifting clouds, rain, snow, mist, a storm flash, sun rays or a
// shooting star on a clear night. Add ?wx=rain (or clear, partly, cloud, fog, drizzle, snow, storm) to the address to preview one.
const WX_PREVIEW = new URLSearchParams(location.search).get('wx');
function skyWeather() {
  if (WX_PREVIEW) return WX_PREVIEW;
  if (!weatherValid()) return '';
  const c = weather.code;
  if (c === 0 || c === 1) return 'clear';
  if (c === 2) return 'partly';
  if (c === 3) return 'cloud';
  if (c === 45 || c === 48) return 'fog';
  if (c >= 51 && c <= 57) return 'drizzle';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if (c >= 95) return 'storm';
  if (c >= 58) return 'rain';
  return 'cloud';
}

function setSkyWeather(hero) {
  const kind = skyWeather();
  if (hero.dataset.wx === kind) return;
  hero.dataset.wx = kind;
  hero.classList.remove('wx-clear', 'wx-partly', 'wx-cloud', 'wx-fog', 'wx-rain', 'wx-snow', 'wx-storm');
  // Drizzle looks like light rain; the classes only need the broad kind.
  if (kind) hero.classList.add(`wx-${kind === 'drizzle' ? 'rain' : kind}`);
  // Fixed "random" spots, so the sky looks the same each time it is built.
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const pct = (a, b) => `${(a + rnd() * (b - a)).toFixed(1)}%`;
  const sec = (a, b) => `${(a + rnd() * (b - a)).toFixed(2)}s`;
  const clouds = (n, top) => Array.from({ length: n }, (_, i) => {
    const dur = 110 + rnd() * 80, at = (i + rnd() * .6) / n;
    return `<div class="track" style="animation-duration:${dur.toFixed(0)}s;animation-delay:-${(at * dur).toFixed(0)}s;--x:${(at * 100).toFixed(0)}%">`
      + `<i class="cloud" style="top:${pct(top[0], top[1])};transform:scale(${(.7 + rnd() * .6).toFixed(2)})"></i></div>`;
  }).join('');
  const drops = (n, slow) => Array.from({ length: n }, () => {
    const d = (slow ? 1.4 : .8) + rnd() * .5;
    return `<i class="drop" style="left:${pct(2, 104)};--y:${pct(5, 75)};animation-duration:${d.toFixed(2)}s;animation-delay:-${(rnd() * d).toFixed(2)}s"></i>`;
  }).join('');
  const flakes = (n) => Array.from({ length: n }, (_, i) => {
    const d = 8 + rnd() * 6;
    return `<i class="flake${i % 3 ? '' : ' s'}" style="left:${pct(0, 100)};--y:${pct(5, 80)};animation-duration:${d.toFixed(1)}s;animation-delay:-${(rnd() * d).toFixed(1)}s"></i>`;
  }).join('');
  const fx = {
    clear: '<i class="shoot"></i>',
    partly: clouds(2, [6, 30]),
    cloud: clouds(4, [0, 40]),
    fog: `<i class="mist" style="top:30%"></i><i class="mist" style="top:58%;animation-duration:34s;animation-delay:-12s"></i>${clouds(2, [10, 30])}`,
    drizzle: clouds(2, [0, 20]) + drops(12, true),
    rain: clouds(3, [0, 22]) + drops(24),
    storm: `<i class="flash"></i>${clouds(3, [0, 22])}${drops(28)}`,
    snow: clouds(2, [0, 20]) + flakes(20),
  }[kind] || '';
  $('#wx-fx').innerHTML = fx;
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
  if (!ENERGY_ON) return;
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
  for (const u of members()) {
    const t = passFor(u.id);
    // Only people still connected: data removed on another screen stays removed.
    if (t && state.health[u.id] && !healthBusy[u.id] && Date.now() - state.health[u.id].at > 20 * 6e4) pullHealth(u.id, t);
  }
}
function refreshHealthViews() {
  if (['health', 'settings', 'home'].includes(currentRoute()) && $('#sheet').hidden && !document.activeElement?.matches('input, textarea')) renderView();
}

const healthPeople = () => members().filter((u) => state.health[u.id]);
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
// The pages you use every day get a tab; the rest sit in the half circle under More.
// The More pages are listed left to right around the arc; sliding straight up from More picks Settings.
const PAGES = [
  { id: 'home', label: 'Home', icon: 'home', main: true },
  { id: 'calendar', label: 'Calendar', icon: 'calendar', main: true },
  { id: 'tasks', label: 'Chores', icon: 'checkSquare', main: true },
  { id: 'friends', label: 'Friends', icon: 'users', main: true },
  { id: 'fridge', label: 'Kitchen', icon: 'fridge' },
  { id: 'piggy', label: 'Piggy Bank', icon: 'piggy' },
  { id: 'bucket', label: 'Bucket list', icon: 'sparkles' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  ...(ENERGY_ON ? [{ id: 'energy', label: 'Energy', icon: 'zap' }] : []),
  { id: 'health', label: 'Health', icon: 'heart' },
  // A small link at the foot of the half circle rather than a page of its own in it.
  { id: 'privacy', label: 'Privacy', icon: 'shield', link: true },
];
const MAIN = PAGES.filter((p) => p.main);
const MORE = PAGES.filter((p) => !p.main && !p.link);
// The half circle holds the More pages plus Send feedback, which opens an email instead of a page.
// The site's admins also get Admin, just before Feedback (and a row at the top of Settings).
const FEEDBACK = { id: 'feedback', label: 'Feedback', icon: 'mail' };
const ADMIN_PAGE = { id: 'admin', label: 'Admin', icon: 'shield' };
let DOME = [...MORE, FEEDBACK];
const ROUTE_ALIAS = { board: 'tasks' }; // the Leaderboard now lives on Chores

const currentRoute = () => {
  let r = location.hash.replace(/^#\/?/, '').split('?')[0];
  r = ROUTE_ALIAS[r] || r;
  return PAGES.some((p) => p.id === r) || r === ADMIN_PAGE.id ? r : 'home';
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
  const m = [...MORE, ADMIN_PAGE].find((p) => p.id === r);
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
// Angles in degrees, left to right, one per item: spread evenly and centred on straight up, so adding
// or removing a page needs no hand-set positions. Few items sit closer together than the full sweep.
const arcFor = (items) => items.map((_, i, all) => {
  const span = Math.min(140, 35 * (all.length - 1));
  return all.length < 2 ? 90 : 90 + span / 2 - (i * span) / (all.length - 1);
});
let ARC = arcFor(DOME);
function setDomeItems(withAdmin) {
  DOME = [...MORE, ...(withAdmin ? [ADMIN_PAGE] : []), FEEDBACK];
  ARC = arcFor(DOME);
}
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
    ${DOME.map((p, i) => `<a class="orb${p.id === r ? ' on' : ''}" role="menuitem" href="${p === FEEDBACK ? feedbackLink() : `#/${p.id}`}" data-i="${i}" style="--orb:${dome.orb}px;--d:${Math.abs(i - (DOME.length - 1) / 2)};left:${dome.xs[i].toFixed(1)}px;top:${(dome.cy - dome.r * Math.sin(rad(ARC[i]))).toFixed(1)}px">${icon(p.icon)}<span class="orb-lbl">${p.label}</span></a>`).join('')}
    <div class="dome-hint" style="left:${dome.cx}px;top:${dome.cy - 18}px">Slide left or right</div>
    <a class="dome-link${r === 'privacy' ? ' on' : ''}" href="#/privacy" style="left:${dome.cx}px;top:${dome.cy - (big ? 46 : 38)}px">${icon('shield')}Privacy</a>`;
  el.classList.toggle('big', big);
  // Revealed by a circle growing out of the More tab.
  const mb = $('#tabs [data-page="more"]').getBoundingClientRect();
  const mx = mb.left + mb.width / 2; const my = mb.top + mb.height / 2;
  el.style.setProperty('--mx', `${mx}px`); el.style.setProperty('--my', `${my}px`);
  el.style.setProperty('--reach', `${Math.ceil(Math.hypot(Math.max(mx - (dome.cx - R), dome.cx + R - mx), my - (dome.cy - R))) + 24}px`);
}
const moreIndex = () => DOME.findIndex((p) => p.id === currentRoute());
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
    const step = Math.max(48, (dome.xs[DOME.length - 1] - dome.xs[0]) / (DOME.length - 1));
    pop = Math.max(0, Math.min(DOME.length - 1, UP + Math.round((e.clientX - g.x) / step)));
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
  if (e.target.closest('.dome-link')) return; // an ordinary link
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
// A prefilled email, with the page and screen size so a report says where it happened.
function feedbackLink() {
  const page = PAGES.find((p) => p.id === currentRoute())?.label || 'Home';
  const body = `\n\n\n---\nPage: ${page}\nScreen: ${window.innerWidth}x${window.innerHeight}\nVersion: ${appVersion || 'local'}`;
  return `mailto:${FEEDBACK_EMAIL || ''}?subject=${encodeURIComponent('Home Assistance feedback')}&body=${encodeURIComponent(body)}`;
}
// The fridge screen often has no email app set up, so the address is offered to copy as well.
function sendFeedback() {
  location.href = feedbackLink();
  if (FEEDBACK_EMAIL) toast(`No email app? Write to ${FEEDBACK_EMAIL}`, ['Copy', () => navigator.clipboard?.writeText(FEEDBACK_EMAIL).then(() => toast('Email address copied'), () => {})]);
}
function navEnd(e, cancelled) {
  const g = navGesture;
  if (e.pointerId !== g.id) return;
  g.id = null;
  $('#tabs').classList.remove('scrubbing'); $('#dome').classList.remove('scrubbing');
  document.querySelectorAll('#tabs .hot, #dome .hot').forEach((x) => x.classList.remove('hot'));
  if (!cancelled && g.pop !== null) { closeDome(); if (DOME[g.pop] === FEEDBACK) sendFeedback(); else goTo(DOME[g.pop].id); return; }
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
    if (e.target.closest('.dome-link')) { closeDome(); return; }
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
  piggy: { action: 'add-menu', label: 'Add expense' },
  bucket: { action: 'add-bucket', label: 'Add to the bucket list' },
};
function setFab(r) {
  const fab = $('#fab'); const f = r === 'calendar' && calView() === 'trip' ? { action: 'add-plan', label: 'Add activity' } : FAB[r];
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
  const scanMoney = `<label class="row"><span class="ibox c-purple-ico">${icon('receipt')}</span><span><b>Scan a receipt</b><small>Snap a receipt and the store, total and day fill in</small></span>${icon('chevron', 'chev')}<input type="file" id="receipt-money" accept="image/*" hidden></label>`;
  const r = currentRoute();
  const items = r === 'fridge' ? [opt('add-fridge', 'plus', 'Add an item', 'Type in one thing'), scan]
    : r === 'piggy' ? [opt('add-expense', 'plus', 'Add an expense', 'Type it in'), scanMoney, opt('add-box', 'box', 'Open a box', 'For a trip or a day out, like Japan Box')]
    : [opt('add-task', 'checkSquare', 'Chore', 'Something to do, with stars'), opt('add-event', 'calendar', 'Event', 'Something on the calendar'),
      opt('add-fridge', 'fridge', 'Kitchen item', 'Something in the fridge'), opt('add-expense', 'piggy', 'Expense', 'Something you paid for'),
      opt('add-note', 'notes', 'Note', 'A sticky note on Home'), opt('add-bucket', 'sparkles', 'Bucket list', 'A trip, dinner or place to go together')];
  openSheet(`${sheetHead(r === 'fridge' ? 'Add to kitchen' : r === 'piggy' ? 'Add expense' : 'Add', 'plus')}<div class="list more-list">${items.join('')}</div>`);
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
// 'both' on an event, chore, expense or bucket list item means everyone in the household.
const everyoneLabel = () => (members().length === 2 ? 'Both' : 'Everyone');
// One avatar for a person, or overlapping faces for 'both'. Unassigned returns ''.
function avatar(who, size = 'md') {
  if (who === 'both') return `<span class="av-pair">${members().slice(0, 3).map((u) => avatarImg(u, size)).join('')}</span>`;
  const u = userOf(who);
  return u ? avatarImg(u, size) : '';
}
// A picture when the person has one, otherwise their initial on their color.
const avatarImg = (u, size) => (u.avatar
  ? `<img class="av av-${size} av-${u.color}" src="${u.avatar}" alt="${esc(u.name)}" title="${esc(u.name)}">`
  : `<span class="av av-${size} av-${u.color} av-initial" role="img" aria-label="${esc(u.name)}" title="${esc(u.name)}">${esc([...u.name.trim()][0]?.toUpperCase() || '?')}</span>`);
const whoName = (who) => (who === 'both' ? (members().length === 2 ? `${members()[0].name} & ${members()[1].name}` : 'Everyone') : userOf(who)?.name || 'Everyone');

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

// A private note on an event or chore. Lists only show a small note icon; the words appear when
// someone taps it, and stay out of the recap email.
const ITEM_NOTE_MAX = 300;
const noteTag = (item, kind) => (item.note ? `<span class="note-tag" role="button" tabindex="0" data-action="peek-note" data-kind="${kind}" data-id="${item.id}" aria-label="Show note" title="Tap to see the note">${icon('notes')}</span>` : '');
function noteField(item) {
  return `<div class="field"><label for="item-note">Note</label>
    ${item.note ? `<button class="btn ghost wide note-reveal" data-action="reveal-note">${icon('lock')} Tap to see the note</button>` : ''}
    <textarea class="input" id="item-note" rows="2" maxlength="${ITEM_NOTE_MAX}" placeholder="Stays hidden until someone taps it"${item.note ? ' hidden' : ''}>${esc(item.note || '')}</textarea></div>`;
}
const pickedNote = () => ($('#item-note')?.value || '').trim().slice(0, ITEM_NOTE_MAX);
// Saving with the note cleared drops the field, so empty notes don't take room in the synced document.
const keepNote = (item) => { if (!item.note) delete item.note; return item; };

// The open note bubble. Any tap, scroll or redraw closes it again.
function closePeek() { $('#note-peek')?.remove(); }
function openPeek(el) {
  const item = (el.dataset.kind === 'task' ? state.tasks : state.events).find((x) => x.id === el.dataset.id);
  if (!item?.note) return;
  const box = Object.assign(document.createElement('div'), { id: 'note-peek', className: 'note-peek', role: 'note', textContent: item.note });
  box.dataset.for = `${el.dataset.kind}:${item.id}`;
  document.body.append(box);
  const r = el.getBoundingClientRect();
  const w = box.offsetWidth;
  box.style.left = `${Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2))}px`;
  const below = r.bottom + 8;
  box.style.top = `${below + box.offsetHeight > innerHeight - 12 ? Math.max(12, r.top - box.offsetHeight - 8) : below}px`;
}

function eventChip(e) {
  return `<button class="ev-chip${e.important ? ' imp' : ''}${eventDone(e) ? ' done' : ''}" data-action="edit-event" data-id="${e.id}">
    ${eventDone(e) ? icon('check', 'ev-done') : avatar(e.who, 'xs')}<b>${e.time ? timeLabel(e) : ''}</b>${impTag(e)}<span>${esc(e.title)}</span></button>`;
}

function eventRow(e, withDate = false) {
  const when = [withDate ? dayLabel(e.date) : '', timeLabel(e), eventDone(e) ? 'Done' : ''].filter(Boolean).join(' · ');
  return `<button class="row${e.important ? ' imp' : ''}" data-action="edit-event" data-id="${e.id}">
    ${avatar(e.who, 'md') || `<span class="ibox c-purple-ico">${icon('calendar')}</span>`}
    <span><b>${esc(e.title)}${impTag(e)}${noteTag(e, 'event')}</b><small>${when}</small></span>${icon('chevron', 'chev')}</button>`;
}

function weekStrip() {
  return `<div class="week">${weather.days.map((d, i) => {
    const w = wmo(d.code, 1);
    const label = i === 0 ? 'Today' : new Date(`${d.date}T12:00`).toLocaleDateString([], { weekday: 'short' });
    return `<div class="wday"><small>${label}</small>${icon(w.icon, w.icon === 'sun' ? 'sun' : '')}<b>${Math.round(d.hi)}°</b><span class="muted">${Math.round(d.lo)}°</span></div>`;
  }).join('')}</div>`;
}

/* ---------- Tasks ---------- */
const weekStartIso = () => { const d = new Date(); return isoDay(addDays(d, -d.getDay())); };

// Daily chores reset each day (or on their weekdays), weekly ones each Sunday (or every few
// weeks), monthly ones on the 1st; one-off chores stay done. See schedule.js.
const isDone = (t) => choreDone(t, isoDay(new Date()));
// Still to do now: not done, and not a weekday chore whose first day hasn't come yet.
const isOwed = (t) => !isDone(t) && choreDue(t, isoDay(new Date()));
// What the chore row says about when it comes up.
function whenLabel(t) {
  const today = isoDay(new Date());
  if (choreKind(t) === 'days' && (isDone(t) || !choreDue(t, today))) {
    const d = nextDay(t, isoDay(addDays(new Date(), 1)));
    return `Next ${d === isoDay(addDays(new Date(), 1)) ? 'tomorrow' : WEEKDAYS[new Date(`${d}T12:00`).getDay()]}`;
  }
  return choreLabel(t);
}
// Chores that take turns move to the next person once the day, week or month they were done in
// is over. Every screen works out the same person, so it doesn't matter which one does it first.
function passTurns() {
  const ids = members().map((u) => u.id);
  return state.tasks.filter((t) => passTurn(t, ids, isoDay(new Date()))).length > 0;
}
const tasksFor = (id) => state.tasks.filter((t) => t.who === id);

/* ---------- Stars ---------- */
// Events earn stars too (5 unless set). An event for both, or for no one, gives each person the stars.
const eventStars = (e) => e.stars ?? 5;
const earners = (who) => (members().some((u) => u.id === who) ? [who] : members().map((u) => u.id));
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
  const order = members().map((u) => u.id);
  return state.tasks.filter((t) => isOwed(t) || t.doneOn === today)
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
function taskCard(t, u, face = false) {
  const done = isDone(t);
  return `<div class="task${done ? ' done' : ''}${t.important ? ' imp' : ''}${face ? ' with-face' : ''}">
    ${face ? avatar(u.id, 'sm') : ''}
    <button class="task-body" data-action="edit-task" data-id="${t.id}">
      <b>${esc(t.title)}${impTag(t)}${noteTag(t, 'task')}</b>
      <small>${face ? `${u.name} · ` : ''}${whenLabel(t)}${t.turns ? ' · takes turns' : ''} <span class="stars">${icon('star')}${t.stars}</span></small>
    </button>
    ${face && done ? thankBtn(`${t.id}@${t.doneOn}@${t.who}`, t.who, t.title) : ''}
    <button class="check ${done ? 'on' : ''}" data-action="toggle-task" data-id="${t.id}" aria-label="${done ? 'Mark not done' : 'Mark done'}: ${esc(t.title)}" aria-pressed="${done}">${icon('check')}</button>
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
    <button class="tev-main" data-action="edit-event" data-id="${e.id}">${icon('calendar')}<b>${e.time ? fmtTime(new Date(`${e.date}T${e.time}`)) : 'All day'}</b><span>${esc(e.title)}</span>${impTag(e)}${noteTag(e, 'event')}</button>
    ${done ? eventThankBtn(e) : ''}
    <button class="tev-check" data-action="toggle-event" data-id="${e.id}" aria-label="${done ? 'Mark not done' : 'Mark done'}: ${esc(e.title)}" aria-pressed="${done}">${icon('check')}</button></div>`;
}

// Home answers "what needs us today?" at a glance: how many chores each person has left,
// what to use up in the kitchen, then today's list and what's coming.
function glanceRow() {
  const people = members().map((u) => {
    const left = tasksFor(u.id).filter(isOwed).length;
    return `<a class="glance" href="#/tasks">${avatar(u.id, 'sm')}<span><b>${left || icon('check')}</b><small>${u.name} · ${left ? `${left === 1 ? 'chore' : 'chores'} left` : 'all done'}</small></span></a>`;
  });
  const soon = (state.fridge || []).filter((it) => daysLeft(it) !== null && daysLeft(it) <= 2).length;
  const kitchen = (state.fridge || []).length
    ? `<a class="glance" href="#/fridge"><span class="ibox c-amber-ico">${icon('fridge')}</span><span><b>${soon || icon('check')}</b><small>${soon ? 'to use soon' : 'kitchen all fresh'}</small></span></a>` : '';
  const buy = (state.shopping || []).length;
  const shop = buy ? `<a class="glance" href="#/fridge"><span class="ibox c-green-ico">${icon('cart')}</span><span><b>${buy}</b><small>to buy</small></span></a>` : '';
  // Someone in more than one household sees which one this is; tapping it goes to switching.
  const where = houseHomes.length > 1 && houseHome
    ? `<a class="glance" href="#/settings"><span class="ibox c-purple-ico">${icon('home')}</span><span><b>${esc(homeName(houseHome))}</b><small>household · switch</small></span></a>` : '';
  return `<div class="glances">${where}${people.join('')}${kitchen}${shop}</div>`;
}

// Who's ahead this week, as one line for the Today card.
function leadLine() {
  const from = weekStartIso();
  const score = (u) => (state.log || []).filter((l) => l.who === u.id && l.date >= from).reduce((a, l) => a + l.stars, 0);
  const [a, b] = members().map((u) => ({ u, n: score(u) })).sort((x, y) => y.n - x.n);
  if (!b || !a.n) return '';
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

// Someone new signed in to the household: every screen says so once, until it's dismissed.
function joinNotice() {
  if (!houseRec || !account.user) return '';
  const fresh = newJoiners(houseAccounts(), account.user.uid, joinsSeen()[houseHome] || []);
  if (!fresh.length) return '';
  const who = joinNames(fresh.map((a) => `<b class="plain">${esc(accountLabel(a))}</b>${a.name && a.email ? ` (${esc(a.email)})` : ''}`));
  return `<div class="sync-banner join-note">${icon('users')}<span>${who} joined this household ${fresh.length === 1 ? fmtShortDate(fresh[0].joined) : 'recently'}. Not someone you know? Remove them in Settings.</span>
    <a class="btn ghost" href="#/settings">Review</a><button class="btn" data-action="join-seen">OK</button></div>`;
}
const fmtShortDate = (ms) => { const d = new Date(ms); const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 864e5);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : `on ${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`; };

// On Home too, since nobody visits Settings when sync quietly stops.
function houseFullBanner() {
  if (houseSync.state !== 'full' && !(houseSync.state === 'ok' && houseFill >= 0.9)) return '';
  return `<a class="sync-banner" href="#/settings">${icon('users')}<span>${houseMessage().text}</span><b>Settings ${icon('arrowRight')}</b></a>`;
}
views.home = () => {
  const today = isoDay(new Date());
  const evs = eventsOn(today);
  // Both people's chores in one list, each row with a face; ticked ones sink to the bottom.
  const order = members().map((u) => u.id);
  const tasks = tasksToday().sort((a, b) => isDone(a) - isDone(b) || order.indexOf(a.who) - order.indexOf(b.who));
  const lead = leadLine();
  const next = state.events.filter((e) => e.date > today).sort(byStart).slice(0, 4);
  return `${houseFullBanner()}${joinNotice()}${thanksInbox()}${bucketInbox()}${glanceRow()}${notesBoard()}
  <div class="grid-home">
    <div class="card a-today">
      <div class="card-head">${icon('checkSquare')}<h2>Today</h2>${lead ? `<a class="link" href="#/tasks">${lead} ${icon('arrowRight')}</a>` : ''}</div>
      ${evs.length ? `<div class="today-evs">${evs.map(todayEvent).join('')}</div>` : ''}
      <div class="task-list">${tasks.map((t) => taskCard(t, userOf(t.who) || members()[0], true)).join('')
        || `<p class="empty-line">${icon('check')} Nothing left today.${lead ? ` ${lead}.` : ''}</p>`}</div>
    </div>
    <div class="home-side">
      <div class="card a-agenda">
        <div class="card-head">${icon('calendar')}<h2>Coming up</h2><a class="link" href="#/calendar">Calendar ${icon('arrowRight')}</a></div>
        <div class="list">${next.map((e) => eventRow(e, true)).join('') || '<p class="empty-line">Nothing else on the calendar this week.</p>'}</div>
      </div>
      ${bucketCard()}
      ${forecastCard()}
      ${ENERGY_ON && energyDays().length ? energyCard() : ''}
    </div>
  </div>`;
};

/* ---------- Calendar ---------- */
let calCursor = new Date();
const HOUR_PX = 52;
const DAY_START = 7; // 7 AM
const DAY_END = 22; // 10 PM

const minutesOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Lay out one day's timed events in side-by-side lanes when they overlap. Times are clipped to the
// visible hours first, so events before 7 AM or after 10 PM, which all sit at the edge, get lanes
// instead of stacking on top of each other. Every event takes at least 30 minutes of space.
function laneLayout(events) {
  const lo = DAY_START * 60;
  const hi = DAY_END * 60;
  const items = events.map((e) => {
    const t = minutesOf(e.time);
    const t2 = Math.max(t + 30, e.end ? minutesOf(e.end) : t + 60);
    const start = Math.min(Math.max(t, lo), hi - 30);
    const end = Math.max(start + 30, Math.min(t2, hi));
    return { e, start, end, lane: 0, lanes: 1 };
  });
  items.sort((a, b) => a.start - b.start);
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
    const tasks = iso === todayIso && calChores() ? calTasksToday().map(taskChip).join('') : '';
    return `<div class="wk-allday">${calEventsOn(iso).filter((e) => !e.time).map(eventChip).join('')}${tasks}</div>`;
  }).join('');
  const cols = days.map((d) => {
    const iso = isoDay(d);
    const timed = laneLayout(calEventsOn(iso).filter((e) => e.time));
    const nowLine = iso === todayIso && nowMin >= DAY_START * 60 && nowMin < DAY_END * 60
      ? `<div class="now-line" style="top:${((nowMin - DAY_START * 60) / 60) * HOUR_PX}px"></div>` : '';
    return `<div class="wk-col" data-action="add-event-at" data-d="${iso}">
      ${timed.map(({ e, start, end, lane, lanes }) => {
        const top = ((start - DAY_START * 60) / 60) * HOUR_PX;
        const height = Math.max(26, ((end - start) / 60) * HOUR_PX - 3);
        return `<button class="wk-ev${eventDone(e) ? ' done' : ''} c-${userOf(e.who)?.color || 'purple'}${e.important ? ' imp' : ''}" data-action="edit-event" data-id="${e.id}"
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
    const evs = calEventsOn(iso);
    const items = [...evs.map(eventChip), ...(iso === todayIso && calChores() ? calTasksToday().map(taskChip) : [])];
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
    const evs = calEventsOn(iso);
    const tasks = iso === todayIso && calChores() ? calTasksToday() : [];
    if (!evs.length && !tasks.length && iso !== todayIso) return '';
    return `<div class="ag-day${iso === todayIso ? ' today' : ''}"><div class="ag-head">${dayLabel(iso)}${iso === todayIso || iso === isoDay(addDays(new Date(), 1)) ? `<small>${new Date(`${iso}T12:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</small>` : ''}</div>
      <div class="list">${evs.map((e) => eventRow(e)).join('')}${tasks.map((t) => taskCard(t, userOf(t.who) || members()[0], true)).join('')}
      ${!evs.length && !tasks.length ? '<p class="empty-line">Nothing planned today.</p>' : ''}</div></div>`;
  }).join('');
  return `<div class="agenda">${blocks || '<p class="empty-line">Nothing planned this week.</p>'}</div>`;
}
// Phones start on the list; wider screens on the week grid. A choice made here sticks on this device.
const calView = () => state.settings.calPick || (matchMedia('(max-width: 600px)').matches ? 'agenda' : 'week');
const calChores = () => !!state.settings.calChores;
// Whose schedule to show. One person's view keeps shared events and ones with nobody picked.
const calWho = () => (userOf(state.settings.calWho) ? state.settings.calWho : '');
const calShows = (who) => !calWho() || !who || who === 'both' || who === calWho();
const calEventsOn = (iso) => eventsOn(iso).filter((e) => calShows(e.who));
const calTasksToday = () => tasksToday().filter((t) => calShows(t.who));

const monthly = () => calView() === 'month' || calView() === 'trip';
function calTitle() {
  if (monthly()) return calCursor.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const s = addDays(calCursor, -calCursor.getDay());
  const e = addDays(s, 6);
  const mon = (d) => d.toLocaleDateString([], { month: 'short' });
  const endPart = s.getMonth() === e.getMonth() ? e.getDate() : `${mon(e)} ${e.getDate()}`;
  return `${mon(s)} ${s.getDate()} – ${endPart}, ${e.getFullYear()}`;
}

const CAL_VIEWS = { agenda: 'List', week: 'Week', month: 'Month', trip: 'Itinerary' };
views.calendar = () => {
  const v = calView();
  return `
  <div class="card cal-card">
    <div class="cal-bar${v === 'trip' ? ' trip' : ''}">
      <button class="btn-round" data-action="cal-move" data-d="-1" aria-label="Previous">${icon('chevronLeft')}</button>
      <button class="btn-round" data-action="cal-move" data-d="1" aria-label="Next">${icon('chevron')}</button>
      <h2>${calTitle()}</h2>
      <button class="btn ghost sm" data-action="cal-today">Today</button>
      <span class="spacer"></span>
      ${v === 'trip' ? '' : `<div class="seg cal-who" role="group" aria-label="Whose schedule">${[['', 'Everyone'], ...members().map((u) => [u.id, u.name])].map(([id, l]) => `<button class="${calWho() === id ? 'on' : ''}" data-action="cal-who" data-who="${id}" aria-pressed="${calWho() === id}">${l}</button>`).join('')}</div>
      <button class="chip-toggle${calChores() ? ' on' : ''}" data-action="cal-chores" aria-pressed="${calChores()}" aria-label="Chores">${icon('checkSquare')} Chores</button>`}
      <div class="seg">${Object.entries(CAL_VIEWS).map(([x, l]) => `<button class="${v === x ? 'on' : ''}" data-action="cal-view" data-v="${x}">${l}</button>`).join('')}</div>
    </div>
    <div class="cal-body">${v === 'trip' ? itineraryView() : v === 'month' ? monthView() : v === 'agenda' ? agendaView() : weekView()}</div>
  </div>`;
};

/* ---------- Itinerary ---------- */
// The household's plans, day by day: each activity has a start and end time, where it is, notes,
// people to call and pictures of the place. Activities are their own synced list (i: items), apart
// from events, so they earn no stars and stay off Home. Pictures live in their own documents
// (photos.js); an activity only lists their ids.
const PLAN_NOTE_MAX = 500;
const PLAN_CONTACT_MAX = 300;
const PLAN_PHOTOS_MAX = 6;
const plansOn = (iso) => (state.itinerary || []).filter((a) => a.date === iso)
  .sort((a, b) => (a.start || '').localeCompare(b.start || '') || String(a.id).localeCompare(String(b.id))); // Any time first, like all-day events
const planTime = (a, t) => fmtTime(new Date(`${a.date}T${t}`));
const planWhen = (a) => (a.start ? `${planTime(a, a.start)}${a.end ? ` – ${planTime(a, a.end)}` : ''}` : 'Any time');
const mapsLink = (place) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
const telLink = (phone) => `tel:${phone.replace(/[^\d+*#]/g, '')}`;
// Contacts are free text; anything that looks like a phone number becomes tap to call.
const withCallLinks = (text) => esc(text).replace(/\+?\d[\d\s().-]{5,}\d/g, (n) => `<a href="${telLink(n)}">${n}</a>`);
// A picture, filled in once it has loaded (fillPhotos).
const photoImg = (id, cls = 'pl-photo') => `<img class="${cls}" data-photo="${esc(id)}" alt="" ${photos.peek(id) ? `src="${photos.peek(id)}"` : ''}>`;
function fillPhotos(root = document) {
  root.querySelectorAll('img[data-photo]:not([src])').forEach(async (img) => {
    const data = await photos.get(img.dataset.photo);
    if (data) img.src = data; else img.classList.add('missing');
  });
}

function planChip(a) {
  return `<span class="ev-chip pl-chip">${a.start ? `<b>${planTime(a, a.start)}</b>` : ''}<span>${esc(a.title)}</span></span>`;
}
function itineraryView() {
  const y = calCursor.getFullYear();
  const m = calCursor.getMonth();
  const first = new Date(y, m, 1);
  const start = new Date(y, m, 1 - first.getDay());
  const weeks = Math.ceil((first.getDay() + new Date(y, m + 1, 0).getDate()) / 7);
  const todayIso = isoDay(new Date());
  const cells = Array.from({ length: weeks * 7 }, (_, i) => {
    const d = addDays(start, i);
    const iso = isoDay(d);
    const acts = plansOn(iso);
    return `<div class="day ${d.getMonth() !== m ? 'other' : ''} ${iso === todayIso ? 'today' : ''}${acts.length ? ' has-plans' : ''}" data-action="open-plan-day" data-d="${iso}">
      <span class="day-num">${d.getDate()}</span>
      <div class="day-evs">${acts.slice(0, 3).map(planChip).join('')}${acts.length > 3 ? `<span class="more">+${acts.length - 3} more</span>` : ''}</div>
      ${acts.length ? `<span class="pl-count" aria-label="${acts.length} planned">${acts.length}</span>` : ''}
    </div>`;
  }).join('');
  return `<p class="hint pl-hint">Tap a day to see its plans or add one.</p>
    <div class="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="dow">${d}</div>`).join('')}${cells}</div>`;
}

// One activity in the day's list, with everything attached to it.
function planCard(a) {
  return `<div class="pl-card">
    <button class="pl-head" data-action="edit-plan" data-id="${esc(a.id)}">
      <span class="pl-time">${icon('clock')}${planWhen(a)}</span>
      <b>${esc(a.title)}</b>${icon('chevron', 'chev')}</button>
    ${a.place ? `<a class="pl-place" href="${mapsLink(a.place)}" target="_blank" rel="noopener">${icon('pin')}<span>${esc(a.place)}</span></a>` : ''}
    ${a.note ? `<p class="pl-note">${esc(a.note)}</p>` : ''}
    ${a.contact ? `<p class="pl-contact">${icon('phone')}<span>${withCallLinks(a.contact)}</span></p>` : ''}
    ${a.photos?.length ? `<div class="pl-photos">${a.photos.map((id) => `<button class="pl-thumb" data-action="view-photo" data-photo-id="${esc(id)}" aria-label="See picture">${photoImg(id)}</button>`).join('')}</div>` : ''}
  </div>`;
}

function planDayHtml(iso) {
  const acts = plansOn(iso);
  return `${sheetHead(new Date(`${iso}T12:00`).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }), 'calendar')}
    ${acts.length ? `<div class="pl-list">${acts.map(planCard).join('')}</div>` : '<p class="muted">Nothing planned yet.</p>'}
    <div class="sheet-actions pl-day-actions"><button class="btn" data-action="add-plan" data-d="${iso}">${icon('plus')} Add activity</button></div>`;
}
function openPlanDay(iso) {
  openSheet(planDayHtml(iso));
  $('#sheet').dataset.kind = 'plan-day';
  $('#sheet').dataset.d = iso;
  fillPhotos($('#sheet'));
}

// The activity being edited: its pictures, and the new ones not saved yet (id -> data URL).
let planDraft = null;
function draftPhotosHtml() {
  const list = planDraft.photos.map((id) => `<div class="pl-thumb">${planDraft.fresh.has(id) ? `<img class="pl-photo" src="${planDraft.fresh.get(id)}" alt="">` : photoImg(id)}
    <button class="pl-x" data-action="del-photo" data-photo-id="${esc(id)}" aria-label="Remove picture">${icon('x')}</button></div>`).join('');
  const add = planDraft.photos.length < PLAN_PHOTOS_MAX ? `<label class="pl-thumb pl-add">${icon('camera')}<span>Add</span><input type="file" id="plan-photo" accept="image/*" multiple hidden></label>` : '';
  return list + add;
}
function redrawDraftPhotos() { const box = $('#pl-photos'); if (box) { box.innerHTML = draftPhotosHtml(); fillPhotos(box); } }
// A new activity starts when the day's last one ends (or at 9 AM), for an hour.
function nextSlot(iso) {
  const last = plansOn(iso).filter((a) => a.end || a.start).at(-1);
  const from = last ? minutesOf(last.end || last.start) : 9 * 60;
  const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { start: hhmm(Math.min(from, 22 * 60)), end: hhmm(Math.min(from + 60, 23 * 60 + 59)) };
}
function openPlanSheet(a, date) {
  const fromDay = $('#sheet').dataset.kind === 'plan-day' && !$('#sheet').hidden;
  const p = a || { id: '', title: '', date, ...nextSlot(date), place: '', note: '', contact: '', photos: [] };
  planDraft = { id: p.id, photos: [...(p.photos || [])], fresh: new Map() };
  openSheet(`${sheetHead(a ? 'Edit activity' : 'New activity', 'calendar')}
    <div class="field"><label for="pl-title">What</label><input class="input" id="pl-title" maxlength="80" value="${esc(p.title)}" placeholder="e.g. Breakfast at the market"></div>
    <div class="field"><label for="pl-date">Day</label><input class="input" type="date" id="pl-date" value="${p.date}"></div>
    <div class="field-row pl-times">
      <div class="field"><label for="pl-start">Starts</label><input class="input" type="time" id="pl-start" value="${p.start || ''}"></div>
      <div class="field"><label for="pl-end">Ends</label><input class="input" type="time" id="pl-end" value="${p.end || ''}"></div>
    </div>
    <div class="field"><label for="pl-place">Where</label><input class="input" id="pl-place" maxlength="160" value="${esc(p.place || '')}" placeholder="Address or place name"></div>
    <div class="field"><label for="pl-note">Notes</label><textarea class="input" id="pl-note" rows="3" maxlength="${PLAN_NOTE_MAX}" placeholder="Tickets, what to bring, booking number">${esc(p.note || '')}</textarea></div>
    <div class="field"><label for="pl-contact">Contacts</label><textarea class="input" id="pl-contact" rows="2" maxlength="${PLAN_CONTACT_MAX}" placeholder="e.g. Tour guide Minh 0912 345 678">${esc(p.contact || '')}</textarea></div>
    <div class="field"><label>Pictures of where to go</label><div class="pl-photos edit" id="pl-photos">${draftPhotosHtml()}</div></div>
    <div class="sheet-actions">
      ${a ? `<button class="btn danger" data-action="del-plan" data-id="${esc(p.id)}">${icon('trash')} Delete</button><span class="spacer"></span>` : ''}
      <button class="btn ghost" data-action="plan-back" data-d="${fromDay ? p.date : ''}">Cancel</button>
      <button class="btn" data-action="save-plan" data-id="${esc(p.id)}">${a ? 'Save' : 'Add activity'}</button>
    </div>`);
  fillPhotos($('#sheet'));
}
async function addDraftPhotos(files) {
  if (!planDraft) return;
  const room = PLAN_PHOTOS_MAX - planDraft.photos.length;
  const list = [...files].slice(0, room);
  if (files.length > room) toast(`Up to ${PLAN_PHOTOS_MAX} pictures per activity`);
  for (const f of list) {
    try {
      const data = await shrink(f);
      const id = `ph${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
      planDraft.photos.push(id); planDraft.fresh.set(id, data);
    } catch (e) { toast(e.message || "Couldn't read that picture"); }
  }
  redrawDraftPhotos();
}

// Full screen, tap anywhere to close. `data` is a picture not saved yet; a tall receipt scrolls.
async function viewPhoto(id, data = null, tall = false) {
  const box = Object.assign(document.createElement('div'), { id: 'photo-view', className: `photo-view${tall ? ' tall' : ''}` });
  box.innerHTML = `<img alt=""><button class="btn-round close" aria-label="Close">${icon('x')}</button>`;
  // Escape closes the picture only, leaving the day's list open behind it.
  const onKey = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); } };
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.append(box);
  const src = data || await photos.get(id);
  if (src) box.querySelector('img').src = src; else { close(); toast("That picture hasn't arrived on this screen yet"); }
}

/* ---------- Tasks ---------- */
// Chores: who's ahead on stars at the top, then each person's list, then the stars history.
views.tasks = () => {
  const b = boardParts();
  return `<div class="section-title">Chores<span class="spacer"></span>${b.seg}</div>
  <div class="lb-cards">${b.cards}</div>
  ${b.note}
  <div class="board">
    ${members().map((u) => `
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
  const rows = buckets.map((b) => ({ ...b, vals: members().map((u) => entries.filter((l) => l.who === u.id && b.match(l.date)).reduce((a, l) => a + l.stars, 0)) }));
  const max = Math.max(...rows.flatMap((r) => r.vals), 1);
  const w = 300 / rows.length; const gw = w * 0.74; const bw = gw / members().length;
  const bars = rows.map((r, i) => r.vals.map((v, j) => {
    const h = (v / max) * 100;
    return v ? `<rect class="bar-${members()[j].color}" x="${(i * w + (w - gw) / 2 + j * bw).toFixed(2)}" y="${(100 - h).toFixed(2)}" width="${(bw * 0.9).toFixed(2)}" height="${h.toFixed(2)}"><title>${r.label}: ${members()[j].name} ${v} stars</title></rect>` : '';
  }).join('')).join('');
  const title = period === 'all' ? 'Stars per week, last 12 weeks' : period === 'week' ? 'Stars per day this week' : 'Stars per day this month';
  return `<div class="energy-chart">
    <div class="chart-top"><span>${title}</span><span>${members().map((u) => `<i class="key bar-${u.color}"></i>${u.name}`).join(' ')} · top ${max}</span></div>
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
  const ranked = members().map((u) => ({ u, stars: score(u) })).sort((a, b) => b.stars - a.stars);
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
// The other person, when there is exactly one other. Bigger households pick who instead.
const otherOf = (id) => (members().length === 2 ? members().find((u) => u.id !== id)?.id || '' : '');
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

// A finished event: one person's is like a chore. A shared one thanks whoever this device isn't
// (in a bigger household the sheet asks who); on the shared screen the sheet asks who's saying
// thanks, and the heart fills once everyone has been thanked.
function eventThankBtn(e) {
  const base = `${e.id}@${e.doneOn}`;
  if (userOf(e.who)) return thankBtn(`${base}@${e.who}`, e.who, e.title);
  if (me() && otherOf(me())) return thankBtn(`${base}@${otherOf(me())}`, otherOf(me()), e.title);
  const sent = members().every((u) => thanksFor(`${base}@${u.id}`).length);
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
  const back = list[0].from;
  openSheet(`${sheetHead(list.length === 1 ? 'A thank-you for you' : `${list.length} thank-yous`, 'heart')}
    <div class="thx-list">${list.map((k) => thanksCard(k, true)).join('')}</div>
    <div class="sheet-actions">
      <button class="btn ghost" data-action="close-sheet">Close</button>
      ${userOf(back) && back !== to ? `<button class="btn" data-action="thank" data-to="${back}" data-from="${to}">${icon('heart')} Thank ${esc(userOf(back).name)} back</button>` : ''}
    </div>`);
  $('#sheet').dataset.kind = 'thanks';
}

// Writing one. Who it's for is worked out where it can be: on someone's own chore it's them, and
// in a two-person household it's whoever isn't sending. The sender is this device's person, or
// the other one of two. Whatever is left is asked: who's sending on the shared screen, and in a
// bigger household who it's for.
function openThankSheet({ win = '', to = '', from = '', title = '', base = '' }) {
  const toKnown = !!userOf(to);
  if (!userOf(from) && me() && me() !== to) from = me();
  if (!userOf(to) && userOf(from) && otherOf(from)) { to = otherOf(from); if (base) win = `${base}@${to}`; }
  if (!userOf(from) && userOf(to) && otherOf(to)) from = otherOf(to);
  const pickFrom = !userOf(from);
  const pickTo = !userOf(to) && members().length > 2;
  const firstOther = (not) => members().find((u) => u.id !== not)?.id || '';
  if (pickFrom) from = userOf(state.settings.lastWriter) && state.settings.lastWriter !== to ? state.settings.lastWriter : firstOther(to);
  if (pickTo) to = firstOther(from);
  else if (!userOf(to)) to = otherOf(from);
  if (!userOf(to) || !userOf(from)) { toast('Add someone else to the household first'); return; }
  const toPicker = `<div class="who-pick" id="thx-to">${members().map((u) => `<button class="who-opt ${u.id === to ? 'on' : ''}" data-action="pick-to" data-who="${u.id}" ${u.id === from ? 'hidden' : ''}>${avatar(u.id, 'sm')}${esc(u.name)}</button>`).join('')}</div>`;
  // The recipient can follow the sender (two people) or be picked (three or more).
  const toFollows = pickTo || (pickFrom && !toKnown);
  openSheet(`${sheetHead(toFollows ? 'Say thanks' : `Thank ${esc(userOf(to).name)}`, 'heart')}
    ${title ? `<p class="thx-for">${avatar(toFollows ? 'both' : to, 'sm')}<span>for <b>${esc(title)}</b></span></p>` : ''}
    ${pickFrom ? `<div class="field"><label>Who's saying thanks?</label>${whoPicker(from, false, 'who-pick', toKnown ? to : '')}${toFollows && !pickTo ? `<p class="hint" id="thx-dir">To ${esc(userOf(to).name)}</p>` : ''}</div>` : ''}
    ${pickTo ? `<div class="field"><label>Who's it for?</label>${toPicker}</div>` : ''}
    <div class="field"><label>Pick one</label><div class="emoji-pick" id="thx-emoji">${THANKS_EMOJI.map((e, i) => `<button class="${i ? '' : 'on'}" data-action="pick-seg" data-v="${e}">${e}</button>`).join('')}</div></div>
    <div class="field"><label for="thx-text">Say something <span class="muted">(optional)</span></label>
      <textarea class="input" id="thx-text" rows="2" maxlength="${THANKS_MAX}" placeholder="Thank you!"></textarea>
      <div class="chips">${THANKS_LINES.map((l) => `<button class="chip" data-action="thanks-line" data-v="${esc(l)}">${esc(l)}</button>`).join('')}</div></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="send-thanks" data-win="${esc(win)}" data-base="${esc(base)}" data-to="${toFollows ? '' : to}" data-from="${pickFrom ? '' : from}" data-title="${esc(title)}">${icon('heart')} Send</button>
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
  const writer = n?.by || me() || state.settings.lastWriter || members()[0].id;
  const color = n?.color || NOTE_COLORS[members().findIndex((u) => u.id === writer) % NOTE_COLORS.length] || 'butter';
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
// state.bucket items: { id, text, kind, by, at, doneAt, doneBy, from, seen, photo }, synced as b: items.
// An item is only ticked off by checking in with a picture of it; photo is that picture's id
// (photos.js). Items ticked off before check-ins existed have no picture and stay done.
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
  const lead = b.photo ? `<button class="bk-pic" data-action="view-photo" data-photo-id="${esc(b.photo)}" aria-label="See the check-in picture">${photoImg(b.photo)}</button>`
    : `<span class="bk-emoji" aria-hidden="true">${kindOf(b)[0]}</span>`;
  return `<div class="task bk${done ? ' done' : ''}">
    ${lead}
    <button class="task-body" data-action="edit-bucket" data-id="${b.id}"><b>${esc(b.text)}</b><small>${sub}${loveTag(b)}</small></button>
    <button class="check ${done ? 'on' : ''}" data-action="tick-bucket" data-id="${b.id}" aria-label="${done ? 'Put back on the list' : 'Check in'}: ${esc(b.text)}" aria-pressed="${done}">${icon('check')}</button>
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

// A done item opens on its check-in picture; changing it is folded away under Edit. The kind
// grid is folded too once an item exists, showing just the kind it has.
function openBucketSheet(b) {
  const kind = b?.kind || 'trip';
  const [ke, kl, kn] = BUCKET_KINDS[kind] || BUCKET_KINDS.do;
  const fields = `<div class="field"><label for="bk-text">What</label><input class="input" id="bk-text" maxlength="${BUCKET_MAX}" value="${esc(b?.text || '')}" placeholder="e.g. Cherry blossoms in Kyoto"${b ? ' data-nofocus' : ''}></div>
    <details class="field bk-kind-fold"${b ? '' : ' open'}><summary><label>Kind</label><span id="bk-kind-now">${ke} ${kl} · ❤️ ${kn}</span><span class="bk-change">Change</span></summary>
      <div class="seg bk-kind" id="bk-kind">${Object.entries(BUCKET_KINDS).map(([k, [e, l, n]]) => `<button class="${k === kind ? 'on' : ''}" data-action="pick-seg" data-v="${k}">${e} ${l}<small>❤️ ${n}</small></button>`).join('')}</div></details>
    ${!b && !me() ? `<div class="field"><label>From</label>${whoPicker(state.settings.lastWriter || members()[0].id, false)}</div>` : ''}
    ${b ? `<p class="hint">Added by ${esc(userOf(b.by)?.name || 'someone')} ${ago(b.at)}${b.doneAt ? ` · done ${dayLabel(isoDay(new Date(b.doneAt)))}, ${wentLine(b).toLowerCase()}` : ''}</p>` : ''}
    <div class="sheet-actions">
      ${b ? `<button class="btn danger" data-action="del-bucket" data-id="${b.id}">${icon('trash')} Remove</button><span class="spacer"></span>` : ''}
      ${b?.doneAt ? '' : '<button class="btn ghost" data-action="close-sheet">Cancel</button>'}
      <button class="btn" data-action="save-bucket" data-id="${b?.id || ''}">${b ? 'Save' : 'Add'}</button>
    </div>`;
  if (b?.doneAt) {
    openSheet(`${sheetHead(esc(b.text), 'sparkles')}
      ${b.photo ? `<button class="bk-memory" data-action="view-photo" data-photo-id="${esc(b.photo)}" aria-label="See the check-in picture full screen">${photoImg(b.photo)}</button>`
        : `<p class="bk-memory none"><span class="bk-emoji">${kindOf(b)[0]}</span><span>Ticked off before check-ins had pictures</span></p>`}
      <p class="bk-went"><b>${esc(wentLine(b))}</b> · ${dayLabel(isoDay(new Date(b.doneAt)))}${loveTag(b)}</p>
      <details class="bk-adjust"><summary>Edit or remove${icon('chevron', 'chev')}</summary>${fields}</details>`);
    fillPhotos($('#sheet'));
  } else openSheet(`${sheetHead(b ? 'Bucket list' : 'Add to the bucket list', 'sparkles')}${fields}`);
  $('#sheet').dataset.kind = 'bucket-edit';
}

// Ticking off is a check-in: it needs a picture of the two of you doing it, and asks who went.
// Most things are done together, so that is picked unless this is someone's own phone.
let bucketPic = null; // { id, data } for the check-in sheet that is open
function bkPicHtml() {
  return bucketPic ? `<label class="bk-shot has"><img class="pl-photo" src="${bucketPic.data}" alt="Check-in picture"><span class="bk-retake">${icon('camera')} Retake</span><input type="file" id="bk-photo" accept="image/*" capture="environment" hidden></label>`
    : `<label class="bk-shot empty">${icon('camera')}<b>Add a picture</b><small>Take one now or pick one from the day</small><input type="file" id="bk-photo" accept="image/*" capture="environment" hidden></label>`;
}
function openBucketTick(b) {
  bucketPic = null;
  openSheet(`${sheetHead('Check in', 'sparkles')}
    <p class="thx-for"><span class="bk-emoji">${kindOf(b)[0]}</span><span><b>${esc(b.text)}</b> · +${loveOf(b)} love points</span></p>
    <div class="field"><label>Picture</label><div id="bk-shot">${bkPicHtml()}</div></div>
    <div class="field"><label>Who went</label>${whoPicker('both', 'both')}</div>
    ${members().length > 1 ? `<p class="hint">${me() && otherOf(me()) ? `${esc(userOf(otherOf(me())).name)} gets a note on their screen` : members().length === 2 ? 'The other person gets a note on their screen' : 'Everyone else gets a note on their screen'} unless you went together.</p>` : ''}
    <div class="sheet-actions">
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="done-bucket" data-id="${b.id}" disabled>${icon('check')} Tick it off</button>
    </div>`);
  $('#sheet').dataset.kind = 'bucket-tick';
}

/* =========================================================
   Friends: a feed shared with friends from any household, and groups
   ========================================================= */
// Everything here lives in its own place in the database (social.js), never in the household's
// synced data, and needs someone signed in. On a shared screen it posts as whoever signed in.
const freshSocial = () => ({ uid: '', state: 'off', note: '', me: null, friends: [], incoming: [], outgoing: [], posts: null, groups: [],
  gid: '', group: undefined, items: [], tab: 'feed', open: new Set(), comments: {}, drafts: {}, busy: '', offs: [], groupOff: null, commentOffs: {}, dirty: false });
let social = freshSocial();
const GROUP_TABS = { feed: 'Feed', plans: 'Plans', bucket: 'Bucket list', money: 'Money' };
const FRIENDS_PATH = 'posts';
const groupPath = (id) => `groups/${id}/items`;
const routeGroup = () => new URLSearchParams(location.hash.split('?')[1] || '').get('g') || '';
const socialMe = () => ({ uid: social.me.uid, name: social.me.name });
const stopOff = (p) => Promise.resolve(p).then((off) => off?.()).catch(() => {});

function stopSocial() {
  social.offs.forEach(stopOff); stopOff(social.groupOff); Object.values(social.commentOffs).forEach(stopOff);
  social = freshSocial();
}
// Redraws Friends when something arrives, unless someone is typing or a sheet is open; then
// it waits until they're done.
function socialRedraw() {
  if (currentRoute() !== 'friends') return;
  if (calmToRender()) { social.dirty = false; renderView(); } else social.dirty = true;
}
document.addEventListener('focusout', () => setTimeout(() => { if (social.dirty) socialRedraw(); }, 0));

function startSocial() {
  const u = account.user;
  if (!u) { if (social.uid) stopSocial(); return; }
  if (social.uid === u.uid) return;
  stopSocial();
  social.uid = u.uid; social.state = 'loading';
  myProfile(u).then((p) => {
    if (social.uid !== u.uid) return;
    social.me = { uid: u.uid, ...p }; social.state = 'ready';
    social.offs.push(watchFriends(u.uid, (f) => { Object.assign(social, f); socialRedraw(); }));
    social.offs.push(watchPosts(u.uid, (list) => { social.posts = list || []; socialRedraw(); }));
    refreshGroups();
  }).catch((e) => { social.state = 'error'; social.note = accountError(e); }).finally(socialRedraw);
}
async function refreshGroups() {
  try { social.groups = await myGroups(social.me.groups || [], social.uid); } catch { /* keep what was shown */ }
  socialRedraw();
}
function watchRouteGroup() {
  const g = routeGroup();
  if (g === social.gid) return;
  stopOff(social.groupOff);
  Object.assign(social, { gid: g, group: g ? undefined : null, items: [], groupOff: null });
  if (g) social.groupOff = watchGroup(g, social.uid, (d) => { if (social.gid === g) { Object.assign(social, d); socialRedraw(); } });
}
// Runs a database step from a button, with a toast if it fails.
async function socialDo(busy, fn, done) {
  if (social.busy) return;
  social.busy = busy; renderView();
  try { const r = await fn(); if (done) done(r); } catch (e) { toast(accountError(e)); }
  social.busy = ''; renderView();
}

// A person from another household: their initial on a color picked from their id.
const colorOf = (uid) => PERSON_COLORS[[...String(uid)].reduce((a, c) => a + c.charCodeAt(0), 0) % PERSON_COLORS.length];
const personAv = (uid, name, size = 'sm') => avatarImg({ name: name || '?', color: colorOf(uid), avatar: '' }, size);
const nameIn = (uid) => social.group?.members.find((m) => m.uid === uid)?.name || 'Someone';
const textHtml = (s) => esc(s).replace(/\n/g, '<br>');

function postCard(p, path) {
  const key = `${path}|${p.id}`;
  const likes = Object.keys(p.likes || {}).length; const liked = !!p.likes?.[social.uid];
  const open = social.open.has(key); const comments = social.comments[key];
  return `<div class="post" data-key="${esc(key)}">
    <div class="post-head">${personAv(p.by, p.name)}<span class="post-who"><b>${esc(p.name || 'Someone')}</b><small>${ago(p.at)}</small></span>
      ${p.by === social.uid ? `<button class="btn-round" data-action="soc-del-post" data-path="${path}" data-id="${p.id}" aria-label="Delete post">${icon('trash')}</button>` : ''}</div>
    <p class="post-text">${textHtml(p.text)}</p>
    <div class="post-acts">
      <button class="post-act${liked ? ' on' : ''}" data-action="soc-like" data-path="${path}" data-id="${p.id}" aria-pressed="${liked}">${liked ? '❤️' : '🤍'} ${likes || ''}<span>Like</span></button>
      <button class="post-act" data-action="soc-comments" data-path="${path}" data-id="${p.id}" aria-expanded="${open}">💬 ${open && comments ? comments.length || '' : ''}<span>${open ? 'Hide comments' : 'Comments'}</span></button>
    </div>
    ${open ? `<div class="comments">${comments ? comments.map((c) => `<div class="comment">${personAv(c.by, c.name, 'xs')}<p><b>${esc(c.name || 'Someone')}</b> ${textHtml(c.text)}<small>${ago(c.at)}</small></p>
        ${c.by === social.uid || p.by === social.uid ? `<button class="btn-round" data-action="soc-del-comment" data-path="${path}" data-id="${p.id}" data-c="${c.id}" aria-label="Delete comment">${icon('x')}</button>` : ''}</div>`).join('') : '<p class="hint">Loading…</p>'}
      <div class="comment-new"><input class="input" maxlength="${COMMENT_MAX}" data-draft="c:${esc(key)}" value="${esc(social.drafts[`c:${key}`] || '')}" placeholder="Write a comment" aria-label="Write a comment">
        <button class="btn" data-action="soc-comment" data-path="${path}" data-id="${p.id}">Send</button></div></div>` : ''}
  </div>`;
}

function composer(path, placeholder) {
  return `<div class="composer">
    <textarea class="input" rows="2" maxlength="${POST_MAX}" data-draft="p:${path}" placeholder="${placeholder}" aria-label="New post">${esc(social.drafts[`p:${path}`] || '')}</textarea>
    <button class="btn" data-action="soc-post" data-path="${path}" ${social.busy ? 'disabled' : ''}>${social.busy === 'post' ? 'Posting…' : 'Post'}</button>
  </div>`;
}

views.friends = () => {
  if (!accountAvailable()) {
    return `<div class="section-title">Friends</div><div class="card"><p class="empty-line">Friends needs household sync. Set it up in Settings › Sync across devices.</p></div>`;
  }
  startSocial();
  // A device in a signed-in household from before this was remembered counts as signed in too.
  const gate = friendsGate(account, !!(readLocal(SIGNED_IN_KEY) || houseHome));
  if (gate === 'checking') return `<div class="section-title">Friends</div><div class="card"><p class="empty-line">Loading…</p></div>`;
  if (gate === 'signin') {
    return `<div class="section-title">Friends</div><div class="card soc-intro">
      <p>Add friends from any household, share posts with them, and make groups for trips, dinners and shared costs. Nothing from your household is shared.</p>
      <button class="btn" data-action="acct-signin">${busyLabel('signin', 'Sign in with Google', 'Signing in…')}</button></div>`;
  }
  if (social.state !== 'ready') {
    return `<div class="section-title">Friends</div><div class="card"><p class="empty-line">${social.state === 'error' ? esc(social.note) : 'Loading…'}</p>
      ${social.state === 'error' ? '<button class="btn ghost" data-action="soc-retry">Try again</button>' : ''}</div>`;
  }
  watchRouteGroup();
  return social.gid ? groupView() : friendsHub();
};

function friendsHub() {
  const friendIds = social.friends.map((f) => f.uid);
  const posts = social.posts ? feedFor(social.posts, social.uid, friendIds) : null;
  const pending = social.outgoing.length;
  return `<div class="section-title">Friends<span class="spacer"></span><span class="hint">${social.friends.length} friend${social.friends.length === 1 ? '' : 's'} · ${social.groups.length} group${social.groups.length === 1 ? '' : 's'}</span></div>
  <div class="bk-page">
    <div class="card">
      <div class="card-head">${icon('users')}<h2>Feed</h2></div>
      ${composer(FRIENDS_PATH, social.friends.length ? 'Share something with your friends' : 'Write something (add a friend so they see it)')}
      <div class="feed">${posts === null ? '<p class="hint">Loading…</p>' : posts.map((p) => postCard(p, FRIENDS_PATH)).join('')
        || '<p class="empty-line">No posts yet. Add a friend with their code, then say hi.</p>'}</div>
    </div>
    <div class="soc-side">
      ${social.incoming.length ? `<div class="card"><div class="card-head">${icon('bell')}<h2>Friend requests</h2></div>
        <div class="list">${social.incoming.map((r) => `<div class="row">${personAv(r.from, r.fromName)}<span><b>${esc(r.fromName || 'Someone')}</b><small>wants to be friends</small></span>
          <span class="spacer"></span><button class="btn ghost" data-action="soc-decline" data-id="${esc(r.id)}">No</button><button class="btn" data-action="soc-accept" data-id="${esc(r.id)}">Accept</button></div>`).join('')}</div></div>` : ''}
      <div class="card">
        <div class="card-head">${personAv(social.uid, social.me.name)}<h2>${esc(social.me.name)}</h2><button class="link" data-action="soc-edit-name">Change name</button></div>
        <p class="hint">Your friend code. Give it to someone so they can add you.</p>
        <div class="soc-code"><b>${showCode(social.me.code)}</b><button class="btn ghost" data-action="soc-copy" data-v="${social.me.code}">Copy</button></div>
        <div class="field"><label for="soc-add">Add a friend</label>
          <div class="comment-new"><input class="input" id="soc-add" data-draft="add" value="${esc(social.drafts.add || '')}" placeholder="Their friend code" autocomplete="off" autocapitalize="characters">
          <button class="btn" data-action="soc-add" ${social.busy ? 'disabled' : ''}>${social.busy === 'add' ? 'Adding…' : 'Add'}</button></div></div>
        ${pending ? `<p class="hint">Waiting for ${esc(joinNames(social.outgoing.map((r) => r.toName || 'someone')))} to say yes.</p>` : ''}
        <div class="list">${social.friends.map((f) => `<div class="row">${personAv(f.uid, f.name)}<span><b>${esc(f.name)}</b></span><span class="spacer"></span>
          <button class="btn-round" data-action="soc-unfriend" data-id="${esc(f.uid)}" aria-label="Remove ${esc(f.name)} as a friend">${icon('x')}</button></div>`).join('')}</div>
      </div>
      <div class="card">
        <div class="card-head">${icon('users')}<h2>Groups</h2></div>
        <div class="list">${social.groups.map((g) => `<a class="row" href="#/friends?g=${g.id}"><span class="av-pair">${g.members.slice(0, 3).map((m) => personAv(m.uid, m.name)).join('')}</span>
          <span><b>${esc(g.name)}</b><small>${g.members.length} ${g.members.length === 1 ? 'person' : 'people'}</small></span>${icon('chevron', 'chev')}</a>`).join('')
          || '<p class="empty-line">A group shares a feed, plans, a bucket list and costs, with people from any household.</p>'}</div>
        <div class="soc-btns"><button class="add-task" data-action="soc-new-group">${icon('plus')} New group</button><button class="add-task" data-action="soc-join-group">Join with a code</button></div>
      </div>
    </div>
  </div>`;
}

/* ---------- One group ---------- */
const groupItems = (type) => social.items.filter((x) => x.type === type);
const groupIds = () => social.group.members.map((m) => m.uid);

function groupView() {
  const g = social.group;
  if (g === undefined) return `<div class="section-title"><a class="btn-round" href="#/friends" aria-label="Back to Friends">${icon('chevronLeft')}</a>Group</div><div class="card"><p class="hint">Loading…</p></div>`;
  if (!g) return `<div class="section-title"><a class="btn-round" href="#/friends" aria-label="Back to Friends">${icon('chevronLeft')}</a>Group</div>
    <div class="card"><p class="empty-line">This group isn't available. You may have left it.</p></div>`;
  const tab = GROUP_TABS[social.tab] ? social.tab : 'feed';
  return `<div class="section-title"><a class="btn-round" href="#/friends" aria-label="Back to Friends">${icon('chevronLeft')}</a>${esc(g.name)}<span class="spacer"></span>
    <button class="btn ghost" data-action="soc-group-invite">${icon('plus')} Invite</button><button class="btn-round" data-action="soc-group-settings" aria-label="Group settings">${icon('settings')}</button></div>
  <div class="soc-members">${g.members.map((m) => `<span class="soc-member">${personAv(m.uid, m.name)}<small>${esc(m.uid === social.uid ? 'You' : m.name)}</small></span>`).join('')}</div>
  <div class="seg soc-tabs">${Object.entries(GROUP_TABS).map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-action="soc-tab" data-v="${k}">${l}</button>`).join('')}</div>
  <div class="card">${{ feed: groupFeed, plans: groupPlans, bucket: groupBucket, money: groupMoneyView }[tab]()}</div>`;
}

function groupFeed() {
  const path = groupPath(social.gid);
  const posts = groupItems('post').sort((a, b) => b.at - a.at);
  return `${composer(path, `Write to ${esc(social.group.name)}`)}
    <div class="feed">${posts.map((p) => postCard(p, path)).join('') || '<p class="empty-line">Nothing here yet. Say hi to the group.</p>'}</div>`;
}

function groupPlans() {
  const today = isoDay(new Date());
  const all = groupItems('event').sort(byStart);
  const row = (e) => {
    const going = Object.keys(e.going || {}).filter((u) => e.going[u]);
    const mine = !!e.going?.[social.uid];
    return `<div class="task">
      <button class="task-body" data-action="soc-edit-plan" data-id="${e.id}"><b>${esc(e.title)}</b><small>${dayLabel(e.date)} · ${timeLabel(e)}${going.length ? ` · ${esc(joinNames(going.map((u) => (u === social.uid ? 'you' : nameIn(u)))))} going` : ''}</small></button>
      <button class="btn ${mine ? '' : 'ghost'}" data-action="soc-going" data-id="${e.id}" aria-pressed="${mine}">${mine ? `${icon('check')} Going` : "I'm in"}</button></div>`;
  };
  const next = all.filter((e) => e.date >= today); const past = all.filter((e) => e.date < today).reverse();
  return `<div class="task-list">${next.map(row).join('') || '<p class="empty-line">No plans yet.</p>'}</div>
    <button class="add-task" data-action="soc-add-plan">${icon('plus')} Add a plan</button>
    ${past.length ? `<details class="soc-past"><summary>Past plans (${past.length})</summary><div class="task-list">${past.map(row).join('')}</div></details>` : ''}`;
}

function groupBucket() {
  const list = groupItems('bucket');
  const open = list.filter((b) => !b.doneAt).sort((a, b) => b.at - a.at);
  const done = list.filter((b) => b.doneAt).sort((a, b) => b.doneAt - a.doneAt);
  const row = (b) => `<div class="task bk${b.doneAt ? ' done' : ''}">
    <button class="task-body" data-action="soc-edit-bucket" data-id="${b.id}"><b>${esc(b.text)}</b><small>${b.doneAt ? `Done ${dayLabel(isoDay(new Date(b.doneAt)))}` : `Added by ${esc(b.by === social.uid ? 'you' : nameIn(b.by))} ${ago(b.at)}`}</small></button>
    <button class="check ${b.doneAt ? 'on' : ''}" data-action="soc-tick-bucket" data-id="${b.id}" aria-label="${b.doneAt ? 'Put back on the list' : 'Tick off'}: ${esc(b.text)}" aria-pressed="${!!b.doneAt}">${icon('check')}</button></div>`;
  return `<div class="task-list">${open.map(row).join('') || '<p class="empty-line">Add a trip, a dinner or a place to go together.</p>'}</div>
    <button class="add-task" data-action="soc-add-bucket">${icon('plus')} Add to the list</button>
    ${done.length ? `<h3 class="bk-group">Done</h3><div class="task-list">${done.map(row).join('')}</div>` : ''}`;
}

function groupMoneyView() {
  const list = groupItems('expense').sort((a, b) => b.date.localeCompare(a.date) || b.at - a.at);
  const ids = groupIds();
  const m = groupMoney(list, ids);
  const who = (u) => (u === social.uid ? 'You' : nameIn(u));
  return `${m.transfers.length ? `<div class="list">${m.transfers.map((t) => `<div class="row"><span><b>${esc(who(t.from))} owe${t.from === social.uid ? '' : 's'} ${esc(t.to === social.uid ? 'you' : nameIn(t.to))} ${fmtCash(t.amount)}</b></span>
      <span class="spacer"></span><button class="btn ghost" data-action="soc-settle" data-from="${esc(t.from)}" data-to="${esc(t.to)}" data-v="${t.amount}">Settle up</button></div>`).join('')}</div>`
      : `<p class="empty-line">${icon('check')} Everyone is square.</p>`}
    <p class="hint">Spent together: ${fmtCash(m.total)} · split evenly between ${ids.length}</p>
    <div class="task-list">${list.map((x) => `<div class="task"><button class="task-body" data-action="soc-edit-expense" data-id="${x.id}">
      <b>${x.kind === 'settle' ? `${esc(who(x.paidBy))} paid ${esc(x.to === social.uid ? 'you' : nameIn(x.to))} back` : esc(x.title)}</b>
      <small>${fmtShort(x.date)} · ${x.kind === 'settle' ? 'Settled up' : `Paid by ${esc(who(x.paidBy))}`}</small></button><b class="soc-amt">${fmtCash(x.amount)}</b></div>`).join('')}</div>
    <button class="add-task" data-action="soc-add-expense">${icon('plus')} Add a cost</button>`;
}

const groupWhoPicker = (selected) => `<div class="who-pick" id="gx-who">${social.group.members.map((m) => `<button class="who-opt${m.uid === selected ? ' on' : ''}" data-action="pick-who" data-who="${esc(m.uid)}">${personAv(m.uid, m.name)}<span>${esc(m.uid === social.uid ? 'You' : m.name)}</span></button>`).join('')}</div>`;
const groupItem = (id) => social.items.find((x) => x.id === id);
const sheetDel = (action, id) => `<button class="btn danger" data-action="${action}" data-id="${id}">${icon('trash')} Remove</button><span class="spacer"></span>`;

function openGroupPlanSheet(e) {
  openSheet(`${sheetHead(e ? 'Plan' : 'Add a plan', 'calendar')}
    <div class="field"><label for="gx-title">What</label><input class="input" id="gx-title" maxlength="80" value="${esc(e?.title || '')}" placeholder="e.g. Hotpot at our place"></div>
    <div class="field-row"><div class="field"><label for="gx-date">Day</label><input class="input" type="date" id="gx-date" value="${e?.date || isoDay(new Date())}"></div>
      <div class="field"><label for="gx-time">Time</label><input class="input" type="time" id="gx-time" value="${e?.time || ''}"></div></div>
    ${e ? `<p class="hint">Added by ${esc(e.by === social.uid ? 'you' : nameIn(e.by))}</p>` : ''}
    <div class="sheet-actions">${e ? sheetDel('soc-del-item', e.id) : ''}<button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="soc-save-plan" data-id="${e?.id || ''}">${e ? 'Save' : 'Add'}</button></div>`);
}
function openGroupBucketSheet(b) {
  openSheet(`${sheetHead(b ? 'Bucket list' : 'Add to the bucket list', 'sparkles')}
    <div class="field"><label for="gx-text">What</label><input class="input" id="gx-text" maxlength="${BUCKET_MAX}" value="${esc(b?.text || '')}" placeholder="e.g. Camping at Big Sur"></div>
    <div class="sheet-actions">${b ? sheetDel('soc-del-item', b.id) : ''}<button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="soc-save-bucket" data-id="${b?.id || ''}">${b ? 'Save' : 'Add'}</button></div>`);
}
function openGroupExpenseSheet(x) {
  if (x?.kind === 'settle') {
    openSheet(`${sheetHead('Settled up', 'piggy')}<p class="hint">${fmtCash(x.amount)} on ${fmtShort(x.date)}</p>
      <div class="sheet-actions">${sheetDel('soc-del-item', x.id)}<button class="btn ghost" data-action="close-sheet">Close</button></div>`);
    return;
  }
  openSheet(`${sheetHead(x ? 'Cost' : 'Add a cost', 'piggy')}
    <div class="field"><label for="gx-title">What</label><input class="input" id="gx-title" maxlength="80" value="${esc(x?.title || '')}" placeholder="e.g. Airbnb"></div>
    <div class="field-row"><div class="field"><label for="gx-amount">Amount</label><input class="input" id="gx-amount" type="number" inputmode="decimal" step="0.01" min="0" value="${x ? x.amount : ''}"></div>
      <div class="field"><label for="gx-date">Day</label><input class="input" type="date" id="gx-date" value="${x?.date || isoDay(new Date())}"></div></div>
    <div class="field"><label>Paid by</label>${groupWhoPicker(x?.paidBy || social.uid)}</div>
    <p class="hint">Split evenly between everyone in the group.</p>
    <div class="sheet-actions">${x ? sheetDel('soc-del-item', x.id) : ''}<button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="soc-save-expense" data-id="${x?.id || ''}">${x ? 'Save' : 'Add'}</button></div>`);
}
function openGroupSettings() {
  openSheet(`${sheetHead('Group', 'settings')}
    <div class="field"><label for="gx-name">Name</label><input class="input" id="gx-name" maxlength="${GROUP_NAME_MAX}" value="${esc(social.group.name)}"></div>
    <div class="sheet-actions"><button class="btn danger" data-action="soc-leave-group">Leave group</button><span class="spacer"></span>
      <button class="btn ghost" data-action="close-sheet">Cancel</button><button class="btn" data-action="soc-rename-group">Save</button></div>`);
}
function openCodeSheet(title, hint, code, expires) {
  openSheet(`${sheetHead(title, 'users')}<p class="hint">${hint}</p>
    <div class="soc-code big"><b>${showCode(code)}</b><button class="btn ghost" data-action="soc-copy" data-v="${code}">Copy</button></div>
    ${expires ? `<p class="hint">Works until ${new Date(expires).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}.</p>` : ''}
    <div class="sheet-actions"><span class="spacer"></span><button class="btn" data-action="close-sheet">Done</button></div>`);
}
function openAskSheet(title, label, action, value = '', placeholder = '') {
  openSheet(`${sheetHead(title, 'users')}
    <div class="field"><label for="gx-ask">${label}</label><input class="input" id="gx-ask" maxlength="${GROUP_NAME_MAX}" value="${esc(value)}" placeholder="${placeholder}" autocomplete="off"></div>
    <div class="sheet-actions"><span class="spacer"></span><button class="btn ghost" data-action="close-sheet">Cancel</button><button class="btn" data-action="${action}">OK</button></div>`);
}

const saveItem = (item) => socialDo('item', () => saveGroupItem(social.gid, item));
const typed = (id) => ($(`#${id}`)?.value || '').trim();

const socialActions = {
  'soc-retry': () => { stopSocial(); renderView(); },
  'soc-copy': (el) => { navigator.clipboard?.writeText(el.dataset.v).then(() => toast('Copied'), () => toast(showCode(el.dataset.v))); },
  'soc-post': (el) => {
    const path = el.dataset.path; const key = `p:${path}`;
    const text = social.drafts[key] || '';
    if (!text.trim()) { toast('Write something first'); return; }
    const seen = path === FRIENDS_PATH ? social.friends.map((f) => f.uid) : null;
    socialDo('post', () => addPost(path, socialMe(), text, seen), () => { social.drafts[key] = ''; });
  },
  'soc-like': (el) => {
    const { path, id } = el.dataset;
    const p = (path === FRIENDS_PATH ? social.posts : social.items).find((x) => x.id === id);
    if (!p) return;
    const on = !p.likes?.[social.uid];
    p.likes = { ...p.likes }; if (on) p.likes[social.uid] = true; else delete p.likes[social.uid];
    if (on) burst(`.post[data-key="${CSS.escape(`${path}|${id}`)}"] .post-act.on`);
    renderView();
    setLike(path, id, social.uid, on).catch((e) => toast(accountError(e)));
  },
  'soc-comments': (el) => {
    const key = `${el.dataset.path}|${el.dataset.id}`;
    if (social.open.has(key)) { social.open.delete(key); stopOff(social.commentOffs[key]); delete social.commentOffs[key]; delete social.comments[key]; } else {
      social.open.add(key);
      social.commentOffs[key] = watchComments(el.dataset.path, el.dataset.id, (list) => { social.comments[key] = list; socialRedraw(); });
    }
    renderView();
  },
  'soc-comment': (el) => {
    const key = `c:${el.dataset.path}|${el.dataset.id}`;
    if (!(social.drafts[key] || '').trim()) return;
    socialDo('comment', () => addComment(el.dataset.path, el.dataset.id, socialMe(), social.drafts[key]), () => { social.drafts[key] = ''; });
  },
  'soc-del-comment': (el) => { deleteDocAt(`${el.dataset.path}/${el.dataset.id}/comments`, el.dataset.c).catch((e) => toast(accountError(e))); },
  'soc-del-post': (el) => {
    if (!confirm('Delete this post?')) return;
    deleteDocAt(el.dataset.path, el.dataset.id).then(() => toast('Post deleted'), (e) => toast(accountError(e)));
  },
  'soc-add': () => {
    const code = social.drafts.add || '';
    socialDo('add', () => addFriend(socialMe(), code, social.friends.map((f) => f.uid)), (r) => {
      const say = { nocode: "That code doesn't match anyone. Check it and try again.", self: "That's your own code.", already: "You're already friends.", asked: 'Asked. You\'ll be friends once they say yes.', friends: "You're friends now." };
      toast(say[r]); if (r === 'asked' || r === 'friends' || r === 'already') social.drafts.add = '';
    });
  },
  'soc-accept': (el) => { const r = social.incoming.find((x) => x.id === el.dataset.id); if (r) socialDo('accept', () => acceptFriend(socialMe(), r), () => toast(`You and ${r.fromName || 'they'} are friends now`)); },
  'soc-decline': (el) => { const r = social.incoming.find((x) => x.id === el.dataset.id); if (r) socialDo('decline', () => dropRequest(r)); },
  'soc-unfriend': (el) => {
    const f = social.friends.find((x) => x.uid === el.dataset.id);
    if (f && confirm(`Remove ${f.name} as a friend? They won't see your new posts.`)) socialDo('unfriend', () => unfriend(social.uid, f.uid));
  },
  'soc-edit-name': () => openAskSheet('Your name', 'What friends see', 'soc-save-name', social.me.name),
  'soc-save-name': () => {
    const v = typed('gx-ask'); if (!v) return;
    closeSheet();
    socialDo('name', () => setMyName(social.uid, social.me.code, v, social.me.groups || []), (name) => { if (name) social.me.name = name; refreshGroups(); });
  },
  'soc-new-group': () => openAskSheet('New group', 'Name', 'soc-start-group', '', 'e.g. Family, Tahoe trip'),
  'soc-start-group': () => {
    const v = typed('gx-ask'); closeSheet();
    socialDo('group', () => startGroup(socialMe(), v), (id) => { social.me.groups = [...(social.me.groups || []), id]; refreshGroups(); location.hash = `#/friends?g=${id}`; });
  },
  'soc-join-group': () => openAskSheet('Join a group', 'Invite code', 'soc-join', '', 'ABCD-EFGH-JK'),
  'soc-join': () => {
    const v = typed('gx-ask'); closeSheet();
    socialDo('join', () => joinGroup(socialMe(), v), (r) => {
      if (r === 'nocode' || r === 'expired') { toast(r === 'expired' ? 'That invite has run out. Ask for a new one.' : "That code doesn't match a group."); return; }
      social.me.groups = [...new Set([...(social.me.groups || []), r])]; refreshGroups(); location.hash = `#/friends?g=${r}`;
    });
  },
  'soc-group-invite': () => socialDo('invite', () => createGroupInvite(social.gid, social.uid),
    ({ code, expires }) => openCodeSheet('Invite to the group', 'Anyone signed in can join with this code: friends, family or another household.', code, expires)),
  'soc-group-settings': openGroupSettings,
  'soc-rename-group': () => { const v = typed('gx-name'); closeSheet(); socialDo('rename', () => renameGroup(social.gid, v), refreshGroups); },
  'soc-leave-group': () => {
    if (!confirm(`Leave ${social.group.name}? You can come back with a new invite.`)) return;
    const id = social.gid; closeSheet();
    socialDo('leave', () => leaveGroup(id, social.uid), () => { social.me.groups = (social.me.groups || []).filter((g) => g !== id); social.groups = social.groups.filter((g) => g.id !== id); location.hash = '#/friends'; });
  },
  'soc-tab': (el) => { social.tab = el.dataset.v; renderView(); },
  'soc-add-plan': () => openGroupPlanSheet(),
  'soc-edit-plan': (el) => openGroupPlanSheet(groupItem(el.dataset.id)),
  'soc-save-plan': (el) => {
    const title = typed('gx-title'); const date = typed('gx-date');
    if (!title || !date) { toast('Add what and which day'); return; }
    const e = groupItem(el.dataset.id);
    closeSheet();
    saveItem(e ? { ...e, title, date, time: typed('gx-time') } : { type: 'event', title, date, time: typed('gx-time'), by: social.uid, at: Date.now(), going: { [social.uid]: true } });
  },
  'soc-going': (el) => {
    const e = groupItem(el.dataset.id); if (!e) return;
    const going = { ...e.going }; if (going[social.uid]) delete going[social.uid]; else going[social.uid] = true;
    saveItem({ ...e, going });
  },
  'soc-add-bucket': () => openGroupBucketSheet(),
  'soc-edit-bucket': (el) => openGroupBucketSheet(groupItem(el.dataset.id)),
  'soc-save-bucket': (el) => {
    const text = typed('gx-text').slice(0, BUCKET_MAX);
    if (!text) { toast('Say what it is first'); return; }
    const b = groupItem(el.dataset.id);
    closeSheet();
    saveItem(b ? { ...b, text } : { type: 'bucket', text, by: social.uid, at: Date.now() });
  },
  'soc-tick-bucket': (el) => {
    const b = groupItem(el.dataset.id); if (!b) return;
    const { doneAt, doneBy, ...rest } = b;
    if (!doneAt) burst(`.task.bk:has([data-id="${b.id}"]) .check`);
    saveItem(doneAt ? rest : { ...rest, doneAt: Date.now(), doneBy: social.uid });
  },
  'soc-add-expense': () => openGroupExpenseSheet(),
  'soc-edit-expense': (el) => openGroupExpenseSheet(groupItem(el.dataset.id)),
  'soc-save-expense': (el) => {
    const title = typed('gx-title'); const amount = Math.round(parseFloat(typed('gx-amount')) * 100) / 100;
    if (!title || !(amount > 0)) { toast('Add what it was and how much'); return; }
    const paidBy = $('#gx-who .who-opt.on')?.dataset.who || social.uid;
    const x = groupItem(el.dataset.id);
    closeSheet();
    saveItem({ ...(x || { type: 'expense', split: true, by: social.uid, at: Date.now() }), title, amount, paidBy, date: typed('gx-date') || isoDay(new Date()) });
  },
  'soc-settle': (el) => {
    const amount = Number(el.dataset.v);
    if (!confirm(`Record that ${el.dataset.from === social.uid ? 'you' : nameIn(el.dataset.from)} paid ${el.dataset.to === social.uid ? 'you' : nameIn(el.dataset.to)} ${fmtCash(amount)}?`)) return;
    saveItem({ type: 'expense', kind: 'settle', paidBy: el.dataset.from, to: el.dataset.to, amount, date: isoDay(new Date()), by: social.uid, at: Date.now() });
  },
  'soc-del-item': (el) => {
    const x = groupItem(el.dataset.id); if (!x) return;
    closeSheet();
    socialDo('del', () => deleteDocAt(groupPath(social.gid), x.id), () => toast('Removed', ['Undo', () => saveItem(x)]));
  },
};
// What's typed on Friends survives a redraw.
document.addEventListener('input', (e) => { const k = e.target.dataset?.draft; if (k) social.drafts[k] = e.target.value; });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.dataset?.draft || e.target.tagName === 'TEXTAREA') return;
  e.target.parentElement.querySelector('[data-action]')?.click();
});

/* =========================================================
   Household sync (same events, chores and expenses on every device)
   ========================================================= */
const HOUSE_PASS_KEY = 'home-dashboard.household-pass.v1';
const HOUSE_BASE_KEY = 'home-dashboard.household-base.v1';
const HOUSE_HOME_KEY = 'home-dashboard.home.v1'; // the signed-in household this device syncs with
const HOUSE_INVITE_KEY = 'home-dashboard.invite.v1';
const HOUSE_HOMES_KEY = 'home-dashboard.homes.v1'; // every household the signed-in person is in
const SIGNED_IN_KEY = 'home-dashboard.signed-in.v1'; // someone was signed in last time this page ran
const readLocal = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const writeLocal = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* ignore */ } };
const savedHouseBase = () => { try { return JSON.parse(localStorage.getItem(HOUSE_BASE_KEY)); } catch { return null; } };
let housePass = readLocal(HOUSE_PASS_KEY);
let houseHome = readLocal(HOUSE_HOME_KEY);
let houseSync = { state: housePass || houseHome ? 'connecting' : 'off' };
// How full the household's shared data is (0 to 1), from the last sync. Everything shares one
// database document with a hard 1 MiB cap, so screens warn well before it fills.
let houseFill = 0;
let houseTyped = ''; // passphrase waiting on "start a new household"
// Signing in: who is signed in on this device (known once Firebase has checked), and the sign-in
// sheet's own state.
let account = { ready: !accountAvailable(), user: null };
let houseMoved = null; // { home, invite } once this screen's passphrase household moved to sign-in
let houseUsePass = false; // the sheet shows the old passphrase form instead of sign-in
let houseBusy = ''; // 'signin' | 'start' | 'join' | 'move' while that is under way
let houseNote = ''; // why the last sign-in step didn't work
let houseInvite = null; // { code, expires } made on this device for the current household
let houseAdding = false; // the sheet is for joining or starting another household
let houseHomes = []; // [{ id, name }] the signed-in person's households
try { houseHomes = JSON.parse(localStorage.getItem(HOUSE_HOMES_KEY)) || []; } catch { houseHomes = []; }
const homeName = (id) => houseHomes.find((h) => h.id === id)?.name || 'Home';
// The household's record, watched while someone is signed in to it: who is signed in to it
// (members, accounts) so everyone can see who joined. null until it has loaded.
let houseRec = null;
let houseWatch = { key: '', stop: null };
const JOINS_SEEN_KEY = 'home-dashboard.joins-seen.v1'; // { home: [uids this device was told joined] }
const joinsSeen = () => { try { return JSON.parse(localStorage.getItem(JOINS_SEEN_KEY)) || {}; } catch { return {}; } };
function watchHouseRec() {
  const u = account.user; const home = houseHome;
  const key = u && home ? `${u.uid}:${home}` : '';
  if (key === houseWatch.key) return;
  houseWatch.stop?.(); houseRec = null;
  houseWatch = { key, stop: null };
  if (!key) return;
  watchHome(home, (rec) => {
    if (houseWatch.key !== key || rec === undefined) return; // offline: keep what was shown
    houseRec = rec;
    if (!rec?.members?.[u.uid]) { removedFromHome(home); return; }
    noteAccount(home, u, rec).catch(() => {});
    if (['home', 'settings'].includes(currentRoute()) && calmToRender()) renderView();
  }).then((stop) => { if (houseWatch.key === key) houseWatch.stop = stop; else stop(); }, () => {});
}
// Someone in the household removed this account (or the household is gone): this screen stops
// syncing with it, keeps its copy, and asks what next.
function removedFromHome(home) {
  if (home !== houseHome) return;
  const name = homeName(home);
  if (house.mode === 'home') house.disconnect();
  houseHome = ''; writeLocal(HOUSE_HOME_KEY, '');
  houseInvite = null; writeLocal(HOUSE_INVITE_KEY, '');
  setHomes(houseHomes.filter((h) => h.id !== home));
  watchHouseRec(); refreshHomes();
  houseNote = `You're no longer in ${name}. Ask someone in it for a new invite code to come back, or start a household of your own.`;
  if (!houseSheetOpen()) openHouseSheet(); else refreshHouse();
}
const houseAccounts = () => householdAccounts(houseRec);
const accountLabel = (a) => a.name || a.email || 'An account';
// The household's summary email settings, read from its record when Settings opens:
// { home, on, to: [addresses], ... }, or { home, loading: true } while that's under way.
let houseEmail = null;
function loadHouseEmail() {
  // Offline? Try again when Settings opens after a while, not on every render.
  if (!houseHome || !account.user || houseEmail?.home === houseHome && !(houseEmail.failed < Date.now() - 30e3)) return;
  const home = houseHome;
  houseEmail = { home, loading: true };
  homeEmail(home).then((e) => { houseEmail = { home, ...(e || {}) }; }, () => { houseEmail = { home, loading: true, failed: Date.now() }; })
    .then(() => { if (currentRoute() === 'settings' && calmToRender()) renderView(); });
}
// Saves the household's email settings, with this screen's time zone and weather place, so the
// email goes out on the household's clock with its own forecast.
async function saveEmail(change) {
  if (!houseHome || !houseEmail || houseEmail.loading) return;
  const { home, loading, ...was } = houseEmail;
  const typed = $('#email-to')?.value;
  const next = { ...was, to: typed === undefined ? was.to || [] : emailList(typed), ...change };
  if (next.on === undefined) next.on = next.to.length > 0; // the first Save turns it on
  if (next.on && !next.to.length) { toast('Add who gets it first'); return; }
  const { lat, lon, name } = state.settings.place;
  Object.assign(next, { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lat, lon, place: name, unit: state.settings.unit });
  try {
    await saveHomeEmail(home, next);
    houseEmail = { home, ...next };
    toast(next.on ? `Summary email on for ${next.to.length === 1 ? next.to[0] : `${next.to.length} people`}` : 'Summary email off');
  } catch (e) { toast(accountError(e)); }
  renderView();
}
// Addresses typed into "Who gets it": any mix of commas, spaces and new lines.
const emailList = (v) => [...new Set(String(v || '').split(/[\s,;]+/).filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)))].slice(0, 10);
try {
  const inv = JSON.parse(localStorage.getItem(HOUSE_INVITE_KEY));
  if (inv?.home === houseHome && inv.expires > Date.now()) houseInvite = inv;
} catch { houseInvite = null; }
const calmToRender = () => $('#sheet').hidden && !document.activeElement?.matches('input, textarea');
const house = createSync({
  getState: () => state,
  onRemote: (apply) => {
    const before = knownIds();
    apply(state);
    announceArrivals(before);
    // Rebuilt Leaderboard entries and carried-over members are sent back to the household;
    // otherwise just keep a copy here.
    if (ensureMembers() | repairLog() | passTurns()) save();
    else try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
    if (calmToRender()) renderView(); // an open sheet re-renders the page when it closes
  },
  onStatus: (st) => {
    const wasFull = houseFullBanner();
    houseSync = st;
    if (st.size) houseFill = st.size / SYNC_LIMIT;
    if (st.state === 'ok') photos.flush();
    // The saved passphrase stopped working: ask for it again.
    if (st.state === 'badpass' && housePass && !houseSheetOpen()) openHouseSheet();
    // Another screen moved this household to sign-in: follow it there.
    if (st.state === 'moved') { houseMoved = { home: st.home, invite: st.invite }; houseUsePass = false; followMove(); }
    if ((currentRoute() === 'settings' || currentRoute() === 'home' && houseFullBanner() !== wasFull) && calmToRender()) renderView();
  },
  onBase: (b) => { try { b ? localStorage.setItem(HOUSE_BASE_KEY, JSON.stringify(b)) : localStorage.removeItem(HOUSE_BASE_KEY); } catch { /* ignore */ } },
});
onSaved = () => { if (house.connected) house.changed(); };
const photos = createPhotos(house);
const FILL_WARN = 0.8;
const fullText = 'Household data is full, so changes made here are not syncing. Delete old events, expenses or notes to make room.';
function houseMessage() {
  const at = houseSync.at ? ago(houseSync.at) : '';
  switch (houseSync.state) {
    case 'ok': if (houseFill >= FILL_WARN) return { ok: false, text: `Household data is ${Math.round(houseFill * 100)}% full. Deleting old events, expenses or notes makes room before it stops syncing.` };
      return { ok: true, text: house.mode === 'home' ? `Synced with everyone in your household. Last sync ${at}.` : `Synced with every device on this passphrase. Last sync ${at}.` };
    case 'connecting': return { ok: true, text: 'Connecting…' };
    case 'new': return { ok: false, text: 'No household uses this passphrase yet. Check it for typos, or start a new household with what is on this device.' };
    case 'offline': return { ok: false, text: 'Offline. Changes are saved here and will sync when the connection is back.' };
    case 'badpass': return { ok: false, text: "That passphrase doesn't unlock this household's data." };
    case 'moved': return { ok: false, text: 'This household moved to sign-in. Sign in with Google to keep this device in sync.' };
    case 'error': return { ok: false, text: "Couldn't reach the sync service. It will keep trying." };
    case 'full': return { ok: false, text: fullText };
    default: return { ok: false, text: 'Not syncing. Events, tasks and expenses stay on this device only.' };
  }
}
/* ---------- Phone alerts (see alerts.js) ---------- */
const appUrl = () => location.href.split('#')[0];
// Fire and forget: the thank-you or tick is already saved and syncing either way.
const phoneAlert = (to, alert) => { if (to.length) sendAlerts(to, alert, { click: appUrl() }); };
function alertsRow() {
  const u = userOf(me());
  // Only on a person's own device in a household: the channel has to reach the others' devices.
  if (!u || !(housePass || houseHome) || !syncAvailable()) return '';
  const topic = alertTopicOf(u);
  if (!topic) {
    return `<div class="setting-row"><div><b>Alerts on ${esc(u.name)}'s phone</b><div class="hint">Get a notification when someone sends you a thank-you or ticks off a bucket list item. Uses the free ntfy app.</div></div>
      <button class="btn" data-action="alerts-on">Turn on</button></div>`;
  }
  return `<div class="setting-row alerts-row"><div><b>Alerts on ${esc(u.name)}'s phone</b>
      <ol class="hint alerts-steps">
        <li>Get the free ntfy app: <a href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noopener">iPhone</a> or <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">Android</a>. Allow its notifications.</li>
        <li>In ntfy, tap the + button and subscribe to <code class="alerts-topic">${topic}</code> <button class="link-btn" data-action="alerts-copy" data-v="${topic}">Copy</button></li>
        <li>Tap Send a test below to check it works.</li>
      </ol>
      <div class="hint">Alerts say who did what, never what a note says. Keep the channel name to yourself: anyone who has it can see your alerts.</div></div>
      <div class="alerts-btns"><button class="btn" data-action="alerts-test">Send a test</button><button class="btn ghost" data-action="alerts-off">Turn off</button></div></div>`;
}
const busyLabel = (what, idle, busy) => (houseBusy === what ? busy : idle);
function houseCard() {
  const head = `<div class="profiles">${members().map((u) => `<button class="profile" data-action="edit-member" data-id="${u.id}" aria-label="Edit ${esc(u.name)}">${avatar(u.id, 'lg')}<b>${esc(u.name)}</b></button>`).join('')}
      ${members().length < MAX_MEMBERS ? `<button class="profile add-member" data-action="add-member"><span class="av av-lg av-none-lg">${icon('plus')}</span><b>Add</b></button>` : ''}</div>
    <div class="setting-row"><div><b>Who uses this device</b><div class="hint">Thank-yous for this person show here and are marked read when opened. Pick Shared for the fridge.</div></div>
      <div class="seg wrap">${[...members().map((u) => [u.id, esc(u.name)]), ['', 'Shared']].map(([id, l]) => `<button class="${me() === id ? 'on' : ''}" data-action="set-me" data-v="${id}">${l}</button>`).join('')}</div></div>
    ${alertsRow()}
    <h3 class="set-sub">Sync across devices</h3>`;
  if (!syncAvailable()) {
    return `<div class="card">${head}
      <p class="hint">Not set up yet. Each device keeps its own events, chores and expenses until sync is turned on for this site.</p>
    </div>`;
  }
  const m = houseMessage();
  const line = m.ok ? `<p class="sync-line">${icon('check')}${m.text}</p>` : `<div class="sync-banner">${icon('users')}<span>${m.text}</span></div>`;
  const u = account.user;
  // A signed-in household: who is signed in, invite codes, signing out.
  if (houseHome) {
    return `<div class="card">${head}${line}
      ${u ? `<p class="hint acct-who">Signed in as <b>${esc(u.email || u.name)}</b></p>` : `<div style="margin:-4px 0 16px"><button class="btn" data-action="acct-signin">${busyLabel('signin', 'Sign in with Google', 'Signing in…')}</button></div>`}
      ${u ? homesBox() : ''}
      ${u ? accountsBox() : ''}
      ${u ? `<div class="field"><label>Invite someone</label>
        ${houseInvite ? `<div class="invite-code" aria-label="Invite code">${showCode(houseInvite.code)}</div>
          <div class="hint">On their phone or another screen: open this app, sign in with Google, then Join with a code. This code works until ${new Date(houseInvite.expires).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}.</div>` : '<div class="hint">Each person signs in with their own Google account, then types a code to join this household.</div>'}
        <div style="margin-top:10px"><button class="btn${houseInvite ? ' ghost' : ''}" data-action="acct-invite">${busyLabel('invite', houseInvite ? 'New code' : 'Make an invite code', 'Making a code…')}</button></div></div>
      <button class="btn ghost" data-action="acct-signout">Sign out on this device</button>` : ''}
    </div>`;
  }
  const passBox = `<div class="field"><label for="house-pass">Household passphrase</label>
      <div style="display:flex;gap:8px"><input class="input" id="house-pass" data-house-pass type="password" autocomplete="off" placeholder="${housePass ? 'Saved on this device' : 'Same phrase on every device'}">
      <button class="btn" data-action="house-connect">${housePass ? 'Update' : 'Connect'}</button></div>
      <div class="hint">Type the same passphrase on each device. Everything is encrypted with it before it leaves this device. Joining a household replaces this device's events, chores and expenses with the shared ones.</div></div>`;
  // A passphrase household: moving it to sign-in is one tap from a signed-in device.
  const move = accountAvailable() && housePass && houseSync.state !== 'moved' ? `<h3 class="set-sub">Sign in instead of a passphrase</h3>
    <p class="hint">Everyone signs in with Google, and new people join with an invite code. Everything in this household moves over, and the other screens follow once someone signs in on them.</p>
    <div style="margin:10px 0 16px"><button class="btn" data-action="${u ? 'acct-move' : 'acct-signin'}">${u ? busyLabel('move', 'Move this household to sign-in', 'Moving…') : busyLabel('signin', 'Sign in with Google to move', 'Signing in…')}</button></div>` : '';
  return `<div class="card">${head}${line}
    ${houseSync.state === 'moved' ? `<div style="margin:-4px 0 16px"><button class="btn" data-action="acct-signin">${busyLabel('signin', 'Sign in with Google', 'Signing in…')}</button></div>` : ''}
    ${houseSync.state === 'new' ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:-4px 0 16px"><button class="btn" data-action="house-create">Start a new household</button><button class="btn ghost" data-action="house-cancel">Cancel</button></div>` : ''}
    ${!housePass && accountAvailable() ? `<div style="margin:-4px 0 16px"><button class="btn" data-action="open-join">Sign in to sync</button></div>` : ''}
    ${houseSync.state === 'moved' ? '' : passBox}
    ${housePass ? '<button class="btn ghost" data-action="house-disconnect">Stop syncing on this device</button>' : ''}
    ${move}
  </div>`;
}

// Every Google account signed in to this household, newest first, so a new one is easy to spot.
function accountsBox() {
  const list = houseAccounts();
  const me = account.user?.uid;
  const when = (a) => (a.uid === me ? 'You' : a.joined ? `Joined ${new Date(a.joined).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: new Date(a.joined).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })}` : 'Joined before this list was kept');
  const rows = list.map((a) => `<div class="setting-row acct-row"><div><b>${esc(a.name || a.email || 'Not opened the app since joining')}</b>
      <small class="hint">${a.name && a.email ? `${esc(a.email)} · ` : ''}${when(a)}</small></div>
      ${a.uid === me ? '' : `<button class="btn ghost" data-action="acct-remove" data-uid="${esc(a.uid)}">Remove</button>`}</div>`).join('');
  return `<div class="field"><label>Signed in to this household</label>
    ${houseRec ? rows : '<div class="hint">Loading…</div>'}
    <div class="hint">Everyone here can see and change everything in this household. Someone you don't know? Remove them: they can only come back with a new invite code.</div></div>`;
}

// The households this person is in: rename this one, switch to another, or add one.
function homesBox() {
  const others = houseHomes.filter((h) => h.id !== houseHome);
  return `<div class="field"><label for="house-name">This household's name</label>
      <div style="display:flex;gap:8px"><input class="input" id="house-name" maxlength="40" value="${esc(homeName(houseHome))}">
      <button class="btn ghost" data-action="house-rename">Save</button></div>
      <div class="hint">Everyone in the household sees this name.</div></div>
    ${others.length ? `<div class="field"><label>Your other households</label>
      ${others.map((h) => `<div class="setting-row home-row"><div><b>${esc(h.name)}</b></div>
        <button class="btn ghost" data-action="house-switch" data-id="${esc(h.id)}" ${houseBusy ? 'disabled' : ''}>${busyLabel(`switch:${h.id}`, 'Switch', 'Switching…')}</button></div>`).join('')}
      <div class="hint">This screen shows one household at a time. Switching brings that household's events, chores and money here; nothing in this one is lost.</div></div>` : ''}
    <div style="margin:0 0 16px"><button class="btn ghost" data-action="house-add">${icon('plus')} Join or start another household</button></div>`;
}

// Sign-in panel: pops up when this device isn't in a household yet, or its sign-in or passphrase
// needs doing again. "Not now" keeps the device on its own until the app is opened again.
// (Not while it plays its closing animation: redrawing it then would open it again.)
const houseSheetOpen = () => !$('#sheet').hidden && !$('#sheet').classList.contains('closing') && $('#sheet').dataset.kind === 'house';
function openHouseSheet() {
  if (!accountAvailable() || houseUsePass || (housePass && !houseMoved)) { openPassSheet(); return; }
  const u = account.user;
  const note = houseNote ? `<div class="sync-banner">${icon('users')}<span>${esc(houseNote)}</span></div>` : '';
  let body;
  if (!account.ready || (u && houseHome && houseSync.state === 'connecting' && !houseAdding)) {
    body = `<p class="house-intro">${account.ready ? 'Connecting to your household…' : 'Checking sign-in…'}</p>`;
  } else if (!u) {
    body = `<p class="house-intro">${houseMoved ? 'This household moved to sign-in. Sign in with Google to keep this screen in sync. Nothing here is lost.'
      : houseHome ? 'Sign in with Google again to keep this device in sync with your household.'
      : 'Sign in with Google to share events, chores and expenses with everyone at home. You can get back in on any device, even a new phone.'}</p>
      ${note}
      <div class="sheet-actions">
        <button class="btn ghost" data-action="close-sheet">Not now</button>
        <button class="btn" data-action="acct-signin" ${houseBusy ? 'disabled' : ''}>${busyLabel('signin', 'Sign in with Google', 'Signing in…')}</button>
      </div>
      ${houseMoved || houseHome ? '' : '<p class="hint setup-join">Set up with a household passphrase before? <button class="link" data-action="acct-use-pass">Use the passphrase</button></p>'}`;
  } else if (houseMoved?.home && !houseNote) {
    body = `<p class="house-intro">Joining your household…</p>`;
  } else {
    body = `<p class="house-intro">Signed in as <b>${esc(u.email || u.name)}</b>.</p>
      ${note}
      <div class="field"><label for="join-code">Join with a code</label>
        <div style="display:flex;gap:8px"><input class="input" id="join-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH-JK" maxlength="16">
        <button class="btn" data-action="acct-join" ${houseBusy ? 'disabled' : ''}>${busyLabel('join', 'Join', 'Joining…')}</button></div>
        <div class="hint">Someone already in your household makes a code in Settings › Household.</div></div>
      ${houseMoved ? '' : `<div class="field"><label>Or start a new household</label>
        <div class="hint" style="margin-bottom:10px">${houseHome ? `It starts empty. ${esc(homeName(houseHome))} stays as it is, and you can switch back in Settings.` : 'It starts with the events, chores and expenses on this screen.'} Invite everyone else after.</div>
        <button class="btn ghost" data-action="acct-start" ${houseBusy ? 'disabled' : ''}>${busyLabel('start', 'Start a household', 'Starting…')}</button></div>`}
      <div class="sheet-actions">
        ${houseAdding ? '' : '<button class="btn ghost" data-action="acct-signout">Use a different account</button>'}
        <button class="btn ghost" data-action="close-sheet">${houseAdding ? 'Cancel' : 'Not now'}</button>
      </div>`;
  }
  openSheet(`${sheetHead(houseMoved ? 'Your household moved' : houseAdding ? 'Another household' : 'Join your household', 'users')}${body}`);
  $('#sheet').dataset.kind = 'house';
}
// The old passphrase panel, for screens on a passphrase household (or set up that way before).
function openPassSheet() {
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
    </div>`}
    ${accountAvailable() && !housePass ? '<p class="hint setup-join">New here? <button class="link" data-action="acct-use-account">Sign in with Google instead</button></p>' : ''}`);
  $('#sheet').dataset.kind = 'house';
}
// The passphrase box next to the button that was tapped (Settings card or the pop-up).
const houseInput = (el) => (el?.closest('.sheet, .card') || document).querySelector('[data-house-pass]');
// Redraws whatever shows the household's state: the open panel, or Settings.
function refreshHouse() {
  if (houseSheetOpen()) openHouseSheet();
  else if (currentRoute() === 'settings' && calmToRender()) renderView();
}
function useHome(home) {
  houseHome = home; writeLocal(HOUSE_HOME_KEY, home);
  if (houseInvite && houseInvite.home !== home) { houseInvite = null; writeLocal(HOUSE_INVITE_KEY, ''); }
  if (home && !houseHomes.some((h) => h.id === home)) setHomes([...houseHomes, { id: home, name: 'Home' }]);
  watchHouseRec();
}
function setHomes(list) { houseHomes = list; writeLocal(HOUSE_HOMES_KEY, list.length ? JSON.stringify(list) : ''); }
// Fetches the signed-in person's households (names can change on another device).
async function refreshHomes() {
  if (!account.user) return;
  try { setHomes(await myHomes(account.user.uid)); } catch { return; } // offline: keep the saved list
  if (houseHome && !houseHomes.some((h) => h.id === houseHome)) setHomes([...houseHomes, { id: houseHome, name: 'Home' }]);
  refreshHouse();
  if (currentRoute() === 'home' && calmToRender()) renderView();
}
// This screen's copy of the household (not its settings), emptied for a household with no data yet.
function emptyHousehold() {
  state = { ...defaultState(), settings: { ...state.settings, me: '' } };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}
// Leaves the household on this screen for another one this person is in. Anything not yet
// synced in the one being left is sent first; if that can't happen, this screen stays put.
async function goToHome(home) {
  let r = house.mode === 'home' ? await house.switchHome(home)
    : (house.disconnect(), await house.connectHome(home, { fresh: true, create: false }));
  if (r === 'new') { emptyHousehold(); r = await house.connectHome(home, { fresh: true }); } // nothing saved there yet
  if (r === 'ok') useHome(home);
  return r;
}
// After a move, the passphrase is no longer needed on this device.
function forgetPass() { housePass = ''; writeLocal(HOUSE_PASS_KEY, ''); }
const unsyncedNote = "Changes on this screen haven't synced yet. Check the connection and try again.";
const accountError = (e) => (navigator.onLine === false ? "You're offline. Connect to the internet and try again."
  : `Something went wrong (${String(e?.code || e?.message || e).replace(/^auth\//, '')}). Try again.`);

// Signed in or out (also when the page loads). The first time, this decides whether the
// sign-in panel needs to show.
let accountChecked = false;
async function onAccount(u) {
  const first = !accountChecked; accountChecked = true;
  account = { ready: true, user: u };
  writeLocal(SIGNED_IN_KEY, u ? '1' : '');
  socialRedraw(); // Friends waits for this on page load
  checkAdmin(u);
  watchHouseRec();
  if (u) {
    refreshHomes();
    if (houseMoved) { await followMove(); return; }
    if (houseHome && !house.connected) house.resumeHome(houseHome, savedHouseBase());
    else if (!houseHome && house.mode !== 'pass') {
      // Signed in on a new device, or again after signing out: find the household.
      let home = null;
      try { home = await myHome(u.uid); } catch { home = null; }
      if (home) {
        useHome(home);
        if (houseSheetOpen()) { houseSync = { state: 'connecting' }; openHouseSheet(); }
        const r = await house.connectHome(home, { fresh: true });
        if (r === 'ok') { toast('Synced with your household'); if (houseSheetOpen()) closeSheet(); }
      } else if (first && !houseSheetOpen()) openHouseSheet(); // signed in, no household yet
    }
  } else {
    if (house.mode === 'home') house.disconnect(); // signed out on this device
    // Not signed in when the app opens: ask, unless an old passphrase household is syncing.
    if (first && !housePass && !houseSheetOpen()) openHouseSheet();
  }
  refreshHouse();
}
// Follows a passphrase household that another screen moved to sign-in. This screen's copy is
// the same household's data, so it is merged in, keeping anything changed here since.
async function followMove() {
  if (!account.user || !houseMoved?.home) { if (!houseSheetOpen()) openHouseSheet(); else refreshHouse(); return; }
  const { home, invite } = houseMoved;
  try {
    await joinHome(account.user, home, invite);
  } catch (e) {
    // The move's code ran out (a screen offline for over a week): someone makes a new one.
    houseNote = e?.code === 'permission-denied' ? 'The code from the move has run out. Ask someone in your household for an invite code (Settings › Household) and type it here.' : accountError(e);
    if (!houseSheetOpen()) openHouseSheet(); else refreshHouse();
    return;
  }
  houseNote = ''; houseMoved = null;
  forgetPass(); useHome(home);
  const r = await house.connectHome(home);
  if (r === 'ok') { toast('Moved to sign-in'); if (houseSheetOpen()) closeSheet(); }
  refreshHouse();
}

/* ---------- Who lives here: first run and Settings ---------- */
// A new household names its people before anything else, since chores, stars and money all
// belong to someone. A screen joining an existing household gets them from there instead.
views.setup = () => `<div class="section-title">Welcome</div>
  <div class="card setup">
    <div class="card-head">${icon('users')}<h2>Who lives here?</h2></div>
    <p class="hint">Add everyone who shares the chores, the calendar and the money. You can change names and colors later in Settings.</p>
    <div class="setup-names" id="setup-names">${[0, 1].map((i) => setupRow(i)).join('')}</div>
    <div class="setup-actions">
      <button class="btn ghost" data-action="setup-add-row">${icon('plus')} Add someone</button>
      <button class="btn" data-action="setup-start">Start</button>
    </div>
    ${houseHome && houseHomes.length > 1 ? `<p class="hint setup-join">Or switch to ${houseHomes.filter((h) => h.id !== houseHome).map((h) => `<button class="link" data-action="house-switch" data-id="${esc(h.id)}">${esc(h.name)}</button>`).join(', ')}</p>`
      : syncAvailable() ? `<p class="hint setup-join">Already using this on another screen? <button class="link" data-action="open-join">Join your household</button></p>` : ''}
  </div>`;
const setupRow = (i) => `<input class="input" data-setup-name maxlength="24" autocomplete="off" placeholder="${i ? 'Another name' : 'Your name'}" aria-label="Name ${i + 1}">`;

function openMemberSheet(u) {
  const all = members();
  const color = u?.color || newMember('', all).color;
  openSheet(`${sheetHead(u ? `Edit ${esc(u.name)}` : 'Add someone', 'users')}
    <div class="field"><label for="mem-name">Name</label><input class="input" id="mem-name" maxlength="24" autocomplete="off" value="${esc(u?.name || '')}" placeholder="e.g. Alex"${u ? ' data-nofocus' : ''}></div>
    <div class="field"><label>Color</label><div class="swatches" id="mem-color">${PERSON_COLORS.map((c) => `<button class="swatch${c === color ? ' on' : ''}" style="background:var(--${c}-fg)" data-action="pick-member-color" data-v="${c}" aria-label="${c}"></button>`).join('')}</div></div>
    <div class="sheet-actions">
      ${u && all.length > 1 ? `<button class="btn danger" data-action="del-member" data-id="${u.id}">${icon('trash')} Remove</button><span class="spacer"></span>` : ''}
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="save-member" data-id="${u?.id || ''}">${u ? 'Save' : 'Add'}</button>
    </div>`);
  $('#sheet').dataset.kind = 'member';
}

/* ---------- Piggy Bank (shared expenses) ---------- */
const fmtCash = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const monthKey = (d) => isoDay(d).slice(0, 7);
let piggyMonth = monthKey(new Date());
const monthBounds = (key) => { const [y, m] = key.split('-').map(Number); return [new Date(y, m - 1, 1), new Date(y, m, 0)]; };
const monthName = (key) => monthBounds(key)[0].toLocaleDateString([], { month: 'long', year: 'numeric' });
const monthRange = (key) => monthBounds(key).map((d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' })).join(' – ');
const expensesIn = (key) => state.expenses.filter((x) => x.date.startsWith(key)).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

// Who paid what, and who owes whom for the shared (split evenly) expenses: see people.js.
// A settle-up entry ({ kind: 'settle', paidBy, to }) is money between two people, not spending.
const isSettle = (x) => x.kind === 'settle';
const spending = (list) => list.filter((x) => !isSettle(x));
const expenseStats = (list) => moneyStats(list, members().map((u) => u.id));
const splitWord = () => (members().length === 2 ? '50/50' : 'evenly');

const boxOf = (x) => x.box && (state.boxes || []).find((b) => b.id === x.box);

function expenseRow(x, showSplit, hideBox) {
  const u = userOf(x.paidBy);
  if (isSettle(x)) {
    return `<button class="row expense settle-row" data-action="edit-expense" data-id="${x.id}">
      ${avatar(x.paidBy, 'md')}
      <span class="ex-main"><b>Settled up</b><small>${u?.name} paid ${userOf(x.to)?.name} back</small></span>
      <span class="ex-amt">${fmtCash(x.amount)}</span></button>`;
  }
  const both = x.paidBy === 'both';
  const note = both ? `Each paid ${members().length === 2 ? 'half' : 'a share'}` : x.split ? (showSplit ? `Split · ${fmtCash(x.amount / Math.max(1, members().length))} each` : 'Split') : `Just ${u?.name}`;
  return `<button class="row expense" data-action="edit-expense" data-id="${x.id}">
    ${avatar(x.paidBy, 'md')}
    <span class="ex-main"><b><span class="ex-cat-ico" title="${EXPENSE_CATS[expenseCat(x)][1]}">${EXPENSE_CATS[expenseCat(x)][0]}</span> ${esc(x.title)}</b><small>${both ? `${everyoneLabel()} paid` : `${u?.name} paid`} · ${note}${!hideBox && boxOf(x) ? ` · ${esc(boxOf(x).name)}` : ''}</small></span>
    ${x.receipt ? `<span class="ex-receipt" aria-label="Has a receipt">${icon('receipt')}</span>` : ''}
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
  // A household of one has nobody to owe.
  const owes = st.transfers;
  const balance = showSplit && members().length > 1 ? `<div class="card balance${owes.length ? '' : ' even'}${owes.length > 1 ? ' many' : ''}">
    ${!owes.length ? `<span class="bal-icon">${icon('check')}</span><div><b>All square</b><small>${fmtCash(st.shared)} shared in ${monthName(key).split(' ')[0]}, ${fmtCash(st.each)} each</small></div>`
      : owes.map((t, i) => {
        const line = `${avatar(t.from, 'md')}<div><small>${userOf(t.from)?.name} owes ${userOf(t.to)?.name}</small><b class="bal-amt">${fmtCash(t.amount)}</b></div>
      <button class="btn" data-action="settle-up" data-i="${i}">${icon('check')} Settle up</button>`;
        return owes.length === 1 ? line : `<div class="bal-line">${line}</div>`;
      }).join('')}
  </div>` : '';
  const share = (u) => (st.total ? (st.paid[u.id] / st.total) * 100 : 0);
  // Boxes for this month go near the top; with none, a short hint sits at the bottom instead.
  const boxes = boxesForMonth(state.boxes, state.expenses, key, isoDay(new Date())).length ? boxesCard(key) : '';
  return `<div class="section-title">Piggy Bank</div>
  <div class="month-nav">
    <button class="btn-round" data-action="piggy-move" data-d="-1" aria-label="Previous month">${icon('chevronLeft')}</button>
    <div class="piggy-month"><h2>${monthName(key)}</h2><span>${monthRange(key)}</span></div>
    <button class="btn-round" data-action="piggy-move" data-d="1" aria-label="Next month">${icon('chevron')}</button>
    ${isNow ? '' : '<button class="btn ghost sm" data-action="piggy-today">This month</button>'}
  </div>
  ${balance}
  ${boxes ? boxes : ''}
  <div class="card spend">
    <div class="spend-top"><b>${fmtCash(st.total)}</b><span>spent · ${list.length} expense${list.length === 1 ? '' : 's'} · ${fmtCash(st.total / daysSoFar)} a day</span></div>
    ${st.total ? `<div class="spend-bar">${members().map((u) => `<i class="bar-${u.color}" style="width:${share(u).toFixed(1)}%"></i>`).join('')}</div>
    <div class="spend-key">${members().map((u) => `<span>${avatarImg(u, 'xs')}${u.name} paid <b>${fmtCash(st.paid[u.id])}</b> · ${Math.round(share(u))}%</span>`).join('')}</div>` : ''}
  </div>
  <div class="card">
    <div class="card-head">${icon('calendar')}<h2>Log</h2></div>
    ${all.length ? Object.entries(byDay).map(([d, xs]) => `<div class="ex-day"><div class="ex-day-head"><span>${dayLabel(d)}</span><span>${fmtCash(spending(xs).reduce((a, x) => a + x.amount, 0))}</span></div>
      <div class="list">${xs.map((x) => expenseRow(x, showSplit)).join('')}</div></div>`).join('')
    : `<div class="piggy-empty">${icon('piggy')}<p>Nothing logged for ${monthName(key)} yet.</p><div class="fr-empty-btns"><button class="btn" data-action="add-expense">${icon('plus')} Add an expense</button><label class="btn ghost">${icon('receipt')} Scan receipt<input type="file" id="receipt-money" accept="image/*" hidden></label></div></div>`}
  </div>
  ${list.length ? categoryCard(list) : ''}
  ${months.length ? trendCard(key, months) : ''}
  ${boxes ? '' : boxesCard(key)}`;
};

// Boxes: a pot for a trip or a day out, like "Japan Box". The card lists the boxes for the month
// shown, each with its whole total (all its months) and who paid it; tapping one opens it.
const boxDays = (b) => (!b.from ? '' : b.to && b.to !== b.from ? `${shortDay(b.from)} – ${shortDay(b.to)}` : shortDay(b.from));
const shortDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
const boxStatsOf = (b) => boxStats(b, state.expenses, members().map((u) => u.id));
function boxesCard(key) {
  const boxes = boxesForMonth(state.boxes, state.expenses, key, isoDay(new Date()));
  const rows = boxes.map((b) => {
    const st = boxStatsOf(b);
    const who = members().length > 1 && st.total ? members().filter((u) => st.paid[u.id]).map((u) => `${u.name} ${fmtCash(st.paid[u.id])}`).join(' · ') : '';
    return `<button class="row box-row" data-action="open-box" data-id="${b.id}">
      <span class="box-ico">${icon('box')}</span>
      <span class="ex-main"><b>${esc(b.name)}</b><small>${[boxDays(b), `${st.count} expense${st.count === 1 ? '' : 's'}`, who].filter(Boolean).join(' · ')}</small></span>
      <span class="ex-amt">${fmtCash(st.total)}</span></button>`;
  }).join('');
  return `<div class="card money-boxes">
    <div class="card-head">${icon('box')}<h2>Boxes</h2><button class="btn ghost sm" data-action="add-box">${icon('plus')} New box</button></div>
    ${rows ? `<div class="list">${rows}</div>` : '<p class="hint">Going on a trip or a day out? Open a box, like Japan Box, and put what you spend there in it to see what it all cost.</p>'}
  </div>`;
}

function openBoxSheet(b) {
  openSheet(`${sheetHead(b ? 'Edit box' : 'New box', 'box')}
    <div class="field"><label for="box-name">Name</label><input class="input" id="box-name" maxlength="30" value="${esc(b?.name || '')}" placeholder="e.g. Japan Box"></div>
    <div class="field-row">
      <div class="field"><label for="box-from">From</label><input class="input" type="date" id="box-from" value="${b?.from || ''}"></div>
      <div class="field"><label for="box-to">To</label><input class="input" type="date" id="box-to" value="${b?.to || ''}"></div>
    </div>
    <div class="hint">Days are optional. With them, expenses you add on those days go in this box by themselves.</div>
    <div class="sheet-actions">
      ${b ? `<button class="btn danger" data-action="del-box" data-id="${b.id}">${icon('trash')} Delete</button><span class="spacer"></span>` : ''}
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="save-box" data-id="${b?.id || ''}">${b ? 'Save' : 'Open box'}</button>
    </div>`);
}

// One box: its total, who paid, who owes whom for it alone, and everything in it.
function openBoxView(b) {
  const st = boxStatsOf(b);
  const showSplit = state.settings.showSplit !== false;
  const share = (u) => (st.total ? (st.paid[u.id] / st.total) * 100 : 0);
  const owes = showSplit && members().length > 1 && st.transfers.length
    ? `<div class="box-owes">${st.transfers.map((t) => `<div>${avatar(t.from, 'sm')}<span>For this box, ${userOf(t.from)?.name} owes ${userOf(t.to)?.name} <b>${fmtCash(t.amount)}</b></span></div>`).join('')}
      <div class="hint">This is already in each month's balance on Piggy Bank, so settle up there.</div></div>` : '';
  openSheet(`${sheetHead(esc(b.name), 'box')}
    <div class="spend box-spend">
      <div class="spend-top"><b>${fmtCash(st.total)}</b><span>${[boxDays(b), `${st.count} expense${st.count === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</span></div>
      ${st.total && members().length > 1 ? `<div class="spend-bar">${members().map((u) => `<i class="bar-${u.color}" style="width:${share(u).toFixed(1)}%"></i>`).join('')}</div>
      <div class="spend-key">${members().map((u) => `<span>${avatarImg(u, 'xs')}${u.name} paid <b>${fmtCash(st.paid[u.id])}</b></span>`).join('')}</div>` : ''}
    </div>
    ${owes}
    ${st.count ? `<div class="list">${st.list.map((x) => expenseRow(x, showSplit, true)).join('')}</div>` : '<p class="hint">Nothing in this box yet.</p>'}
    <div class="sheet-actions">
      <button class="btn ghost" data-action="edit-box" data-id="${b.id}">${icon('settings')} Edit box</button><span class="spacer"></span>
      <button class="btn" data-action="add-box-expense" data-id="${b.id}">${icon('plus')} Add expense</button>
    </div>`);
}

// Spending by category, biggest first. Tapping a category opens the expenses in it, newest first.
// Expenses from before categories are Other.
function categoryList(list) {
  const cats = categoryTotals(list);
  const sum = cats.reduce((n, c) => n + c.total, 0);
  const showSplit = state.settings.showSplit !== false;
  const inCat = (id) => list.filter((x) => expenseCat(x) === id).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  return `<div class="trend-places">${cats.map((c) => `<details class="cat-group">
    <summary class="trend-place"><span class="ex-main"><b>${EXPENSE_CATS[c.id].join(' ')}</b><small>${c.count} expense${c.count === 1 ? '' : 's'} · ${Math.round((c.total / sum) * 100)}%</small></span>
      <span class="trend-pbar"><i style="width:${((c.total / cats[0].total) * 100).toFixed(1)}%"></i></span><span class="ex-amt">${fmtCash(c.total)}</span>${icon('chevron', 'chev')}</summary>
    <div class="list cat-items">${inCat(c.id).map((x) => `<div class="cat-item"><span>${dayLabel(x.date)}</span>${expenseRow(x, showSplit)}</div>`).join('')}</div>
  </details>`).join('')}</div>`;
}
function categoryCard(list) {
  return `<div class="card money-cats">
    <div class="card-head">${icon('chart')}<h2>By category</h2></div>
    ${categoryList(list)}
  </div>`;
}

// How spending moves over the months: the six up to the one shown, each person's share stacked
// in their colour, the average, the change from the month before and where the money went.
// Tapping a month opens it.
const TREND_MONTHS = 6;
function trendCard(key, months) {
  const t = monthTrend(state.expenses, members().map((u) => u.id), key, TREND_MONTHS);
  const now = t.months.at(-1); const prev = t.months.at(-2);
  const short = (k) => monthBounds(k)[0].toLocaleDateString([], { month: 'short' });
  const whole = (n) => fmtCash(Math.round(n)).replace(/\.00$/, '');
  const change = prev.total ? (now.total - prev.total) / prev.total : null;
  const top = t.months.reduce((a, mo) => (mo.total > a.total ? mo : a), t.months[0]);
  const avgLine = t.average ? `<i class="trend-avg" style="bottom:${((t.average / t.max) * 100).toFixed(1)}%"></i>` : '';
  const bars = t.months.map((mo) => {
    const h = t.max ? (mo.total / t.max) * 100 : 0;
    const parts = mo.total ? members().map((u) => `<i class="bar-${u.color}" style="height:${((mo.paid[u.id] / mo.total) * 100).toFixed(1)}%"></i>`).join('') : '';
    return `<button class="trend-col${mo.key === key ? ' on' : ''}" data-action="piggy-goto" data-m="${mo.key}" aria-label="${monthName(mo.key)}: ${fmtCash(mo.total)}">
      <small>${mo.total ? whole(mo.total) : ''}</small>
      <span class="trend-bar"><span style="height:${h.toFixed(1)}%">${parts}</span>${avgLine}</span>
      <span class="trend-m">${short(mo.key)}</span></button>`;
  }).join('');
  return `<div class="card money-trend">
    <div class="card-head">${icon('chart')}<h2>Month by month</h2></div>
    <div class="trend-tiles">
      <div><small>Average a month</small><b>${whole(t.average)}</b></div>
      <div><small>vs ${monthName(prev.key).split(' ')[0]}</small><b class="${change === null ? '' : change > 0 ? 'up' : 'down'}">${change === null ? '–' : `${change > 0 ? '+' : ''}${Math.round(change * 100)}%`}</b></div>
      <div><small>Biggest month</small><b>${top.total ? `${short(top.key)} · ${whole(top.total)}` : '–'}</b></div>
    </div>
    <div class="trend-chart">${bars}</div>
    ${members().length > 1 ? `<div class="spend-key">${members().map((u) => `<span><i class="key bar-${u.color}"></i>${u.name}</span>`).join('')}<span><i class="key avg"></i>Average</span></div>` : ''}
    ${t.spent.length ? `<h3 class="trend-sub">Where it went · ${short(t.months[0].key)} – ${short(key)}</h3>
    ${categoryList(t.spent)}` : ''}
    ${months.length > 1 ? `<h3 class="trend-sub">Every month</h3>
    <div class="list">${months.map((m) => { const s2 = expenseStats(expensesIn(m)); return `<button class="row month-row${m === key ? ' on' : ''}" data-action="piggy-goto" data-m="${m}">
      <span class="ex-main"><b>${monthName(m)}</b><small>${members().map((u) => `${u.name} ${fmtCash(s2.paid[u.id])}`).join(' · ')}</small></span><span class="ex-amt">${fmtCash(s2.total)}</span></button>`; }).join('')}</div>` : ''}
  </div>`;
}

// The expense being edited: its receipt picture id, and the picture itself when it is new.
// A receipt is its own document like itinerary pictures (photos.js); the expense keeps the id.
const RECEIPT_SIDE = 1800;
let moneyDraft = null;
function receiptBoxHtml() {
  const { receipt, fresh } = moneyDraft;
  if (!receipt) return `<label class="pl-thumb pl-add rc-thumb">${icon('receipt')}<span>Add photo</span><input type="file" id="ex-receipt-file" accept="image/*" hidden></label>`;
  return `<div class="pl-thumb rc-thumb"><button class="rc-open" data-action="view-receipt" aria-label="See receipt">${fresh ? `<img class="pl-photo" src="${fresh}" alt="">` : photoImg(receipt)}</button>
    <button class="pl-x" data-action="del-receipt" aria-label="Remove receipt">${icon('x')}</button></div>`;
}
function redrawReceipt() { const box = $('#ex-receipt'); if (box) { box.innerHTML = receiptBoxHtml(); fillPhotos(box); } }
const newPhotoId = () => `ph${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
async function attachReceipt(file) {
  if (!moneyDraft) return;
  try {
    const data = await shrink(file, RECEIPT_SIDE);
    moneyDraft.receipt = newPhotoId(); moneyDraft.fresh = data;
    redrawReceipt();
  } catch (e) { toast(e.message || "Couldn't read that picture"); }
}

// `scan` is what a receipt photo gave ({ store, amount, date, picture }), to check before adding.
function openExpenseSheet(ex, scan, inBox) {
  const today = isoDay(new Date());
  const inMonth = piggyMonth === monthKey(new Date()) ? today : isoDay(monthBounds(piggyMonth)[0]);
  const x = ex || { id: '', title: scan?.store || '', amount: scan?.amount ?? '', date: scan ? scan.date || today : inMonth, paidBy: members()[0].id, split: true, cat: guessExpenseCat(scan?.store) };
  const cat = expenseCat(x);
  const box = ex ? x.box || '' : inBox || boxForDay(state.boxes, x.date);
  const boxes = boxChoices(state.boxes, x.date, box);
  moneyDraft = scan?.picture ? { receipt: newPhotoId(), fresh: scan.picture } : { receipt: ex?.receipt || '', fresh: null };
  openSheet(`${sheetHead(ex ? 'Edit expense' : scan ? 'From your receipt' : 'New expense', 'piggy')}
    ${scan ? `<p class="hint">${scan.amount ? 'Check what the reader got, then pick who paid.' : "The total wasn't readable, so type it in."}</p>` : ''}
    <div class="field"><label for="ex-title">What was it?</label><input class="input" id="ex-title" value="${esc(x.title)}" placeholder="e.g. Groceries"></div>
    <div class="field"><label>Category</label><div class="seg ex-cat" id="ex-cat"${ex ? ' data-picked="1"' : ''}>${Object.entries(EXPENSE_CATS).map(([k, [e, l]]) => `<button class="${k === cat ? 'on' : ''}" data-action="pick-seg" data-v="${k}">${e} ${l}</button>`).join('')}</div></div>
    <div class="field-row">
      <div class="field"><label for="ex-amount">Amount</label><input class="input" id="ex-amount" type="number" inputmode="decimal" step="0.01" min="0" value="${x.amount}" placeholder="0.00"></div>
      <div class="field"><label for="ex-date">Day</label><input class="input" type="date" id="ex-date" value="${x.date}"></div>
    </div>
    ${boxes.length ? `<div class="field"><label>Box</label><div class="seg wrap ex-box" id="ex-box">${[{ id: '', name: 'None' }, ...boxes].map((b) => `<button class="${b.id === box ? 'on' : ''}" data-action="pick-seg" data-v="${b.id}">${esc(b.name)}</button>`).join('')}</div></div>` : ''}
    <div class="field"><label>Who paid?</label>${whoPicker(x.paidBy, members().length > 1 ? 'both' : false)}${members().length > 1 ? `<div class="hint">${everyoneLabel()} means ${members().length === 2 ? 'each of you paid half' : 'everyone paid an equal share'}, so nobody owes anything on it.</div>` : ''}</div>
    <div class="setting-row imp-row"><div><b>Split ${splitWord()}</b><div class="hint">Counts toward what each of you owes. Turn off for a personal expense.</div></div>
      <button class="switch" id="ex-split" role="switch" aria-checked="${!!x.split}" data-action="toggle-important"></button></div>
    <div class="field"><label>Receipt</label><div class="pl-photos edit" id="ex-receipt">${receiptBoxHtml()}</div>
      ${scan?.picture ? '<div class="hint">Saved with this expense so you can look at it later.</div>' : ''}</div>
    <div class="sheet-actions">
      ${ex ? `<button class="btn danger" data-action="del-expense" data-id="${x.id}">${icon('trash')} Delete</button><span class="spacer"></span>` : ''}
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="save-expense" data-id="${x.id}">${ex ? 'Save' : 'Add expense'}</button>
    </div>`);
  if (!ex && !scan) setTimeout(() => $('#ex-title')?.focus(), 50);
  fillPhotos($('#sheet'));
}
async function scanExpense(file) {
  openSheet(`${sheetHead('Reading receipt', 'receipt')}
    <p class="hint">Reading the total on this device. This can take a few seconds.</p>
    <div class="rc-bar"><i id="rc-progress"></i></div>`);
  $('#sheet').dataset.kind = 'receipt-money';
  try {
    // The picture is kept with the expense, so shrink it while the reader works.
    const picture = shrink(file, RECEIPT_SIDE).catch(() => null);
    const found = await readExpense(file, (p) => { const b = $('#rc-progress'); if (b) b.style.width = `${Math.round(p * 100)}%`; });
    if ($('#sheet').dataset.kind === 'receipt-money') openExpenseSheet(null, { ...found, picture: await picture });
  } catch (err) {
    closeSheet();
    toast(err.message || "Couldn't read that photo");
  }
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
/* The shopping list: things to buy, shared by the household. Running out of something in the
   kitchen offers to add it, and a scanned grocery receipt ticks off what it bought. */
const SHOP_MAX = 60; // characters per item
const shopKey = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/s\b/g, '');
function addToShopping(name) {
  name = cleanName(name).slice(0, SHOP_MAX);
  state.shopping ||= [];
  if (!name || state.shopping.some((x) => shopKey(x.name) === shopKey(name))) return false;
  state.shopping.push({ id: `g${Date.now()}`, name, by: me(), at: Date.now() });
  return true;
}
// Receipt lines are short and shouty ("ORG BANANAS"), so a list item counts as bought when every
// word of it shows up in a kept receipt name, or the other way round.
function tickOffShopping(names) {
  const keys = names.map((n) => shopKey(n).split(' '));
  const bought = (state.shopping || []).filter((x) => {
    const want = shopKey(x.name).split(' ');
    return keys.some((k) => want.every((w) => k.includes(w)) || k.every((w) => want.includes(w)));
  });
  state.shopping = (state.shopping || []).filter((x) => !bought.includes(x));
  return bought;
}
function shoppingCard() {
  const list = state.shopping || [];
  return `<div class="card shop-card"><div class="card-head">${icon('cart')}<h2>Shopping list</h2>${list.length ? `<span class="hint">${list.length} to buy</span>` : ''}</div>
    <div class="shop-new"><input class="input" id="shop-new" data-draft="shop" maxlength="${SHOP_MAX}" value="${esc(social.drafts.shop || '')}" placeholder="Add something to buy" aria-label="Add something to buy" autocomplete="off">
      <button class="btn" data-action="add-shop" aria-label="Add to the shopping list">${icon('plus')}</button></div>
    ${list.length ? `<div class="fr-list shop-list">${list.map((x) => `<div class="fr-row shop-row">
      <button class="check" data-action="got-shop" data-id="${x.id}" aria-label="Got ${esc(x.name)}">${icon('check')}</button>
      <span class="fr-main"><b>${esc(x.name)}</b>${userOf(x.by) ? `<small>Added by ${esc(userOf(x.by).name)}</small>` : ''}</span></div>`).join('')}</div>`
    : '<p class="muted shop-empty">Nothing to buy. Things you run out of can be added with one tap.</p>'}</div>`;
}
// One list, soonest use-by first, so nothing shows twice. Chips at the top narrow it to one kind.
let fridgeCat = 'all';
views.fridge = () => {
  const items = state.fridge || [];
  if (!items.length) {
    return `<div class="section-title">Kitchen</div>${shoppingCard()}<div class="card fr-empty">${icon('fridge')}<p>Nothing logged yet. Add what's in the fridge, or snap a grocery receipt and the items get added for you.</p>
      <div class="fr-empty-btns"><button class="btn" data-action="add-fridge">${icon('plus')} Add an item</button><label class="btn ghost">${icon('receipt')} Scan receipt<input type="file" id="receipt-file" accept="image/*" hidden></label></div></div>`;
  }
  const cats = FRIDGE_CATS.filter((c) => items.some((it) => catOf(it.cat).id === c.id));
  if (fridgeCat !== 'all' && !cats.some((c) => c.id === fridgeCat)) fridgeCat = 'all';
  const shown = items.filter((it) => fridgeCat === 'all' || catOf(it.cat).id === fridgeCat)
    .sort((a, b) => (a.use || '9').localeCompare(b.use || '9') || a.name.localeCompare(b.name));
  const soon = items.filter((it) => daysLeft(it) !== null && daysLeft(it) <= 2).length;
  const chip = (id, label, n) => `<button class="chip${fridgeCat === id ? ' on' : ''}" data-action="fridge-cat" data-v="${id}">${label}<span>${n}</span></button>`;
  return `<div class="section-title">Kitchen<span class="spacer"></span><span class="hint">${soon ? `${soon} to use soon` : 'All fresh'}</span></div>
  ${shoppingCard()}
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
    <div class="rc-list" data-nofocus>${found.map((f, i) => `<div class="rc-row" data-i="${i}" data-read="${esc(f.name)}">
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
  const who = members().some((u) => u.id === state.settings.healthWho) ? state.settings.healthWho : (people[0]?.id || members()[0].id);
  const pick = `<div class="seg">${members().map((u) => `<button class="${who === u.id ? 'on' : ''}" data-action="health-who" data-v="${u.id}">${u.name}</button>`).join('')}</div>`;
  const days = healthDays(who);
  const keys = Object.keys(days).sort();
  if (!healthAvailable()) {
    return `<div class="section-title">Health</div>
    <div class="card energy-empty"><div class="sync-banner">${icon('heart')}<span>Fitbit sign-in isn't set up for this site yet.</span></div></div>`;
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
    return `<p class="hint">Not set up yet. Fitbit sign-in needs a one-time setup for this site${admin.on ? ', in <a href="#/admin">Admin</a>' : ' by whoever runs it'}.</p>`;
  }
  return `${members().map((u) => healthRow(u.id)).join('')}
    <p class="hint">Each person signs in with the Google account their Fitbit uses. Google's pass lasts about an hour and stays on this screen only; the daily numbers are shared with the household when sync is on.</p>
    ${healthPeople().length ? `<div style="display:flex;gap:8px;flex-wrap:wrap">${healthPeople().map((u) => `<button class="btn ghost" data-action="health-disconnect" data-v="${u.id}">${icon('trash')} Remove ${u.name}'s data</button>`).join('')}</div>` : ''}`;
}

// A connection is one row with its status; tapping it opens the details and setup steps.
let openConn = null; // stays open across re-renders
const connRow = (id, ic, title, status, ok, body) => `<details class="conn" data-conn="${id}"${openConn === id ? ' open' : ''}>
  <summary><span class="ibox ${ok ? 'c-green-ico' : 'c-amber-ico'}">${icon(ic)}</span><span class="conn-text"><b>${title}</b><small>${status}</small></span>${icon('chevron', 'chev')}</summary>
  <div class="conn-body">${body}</div></details>`;

// Settings › Connections › Summary email: the household turns its own email on and says who gets it.
function emailConn() {
  const e = houseEmail?.home === houseHome ? houseEmail : null;
  const on = !!(e?.on && e.to?.length);
  const status = !houseHome || !account.user ? 'Needs a signed-in household' : e?.failed ? "Couldn't check, offline?" : !e || e.loading ? 'Checking…'
    : on ? `On · ${e.to.length === 1 ? e.to[0] : `${e.to.length} people`}` : e.on === undefined ? 'Not turned on here yet' : 'Off';
  const body = !houseHome || !account.user
    ? `<p class="hint">Sign in and join or start a household (in <b>Sync across devices</b> above), then turn the email on here.</p>`
    : `<p class="hint">Emails everyone you list at 7:30 AM, noon, 5 PM and 9 PM with what's on, open chores, stars, the shopping list and anything in the fridge to use up.</p>
      <div class="setting-row"><div><b>Email this household</b></div>
        <button class="switch" role="switch" aria-checked="${on}" data-action="email-toggle" aria-label="Email this household"${!e || e.loading ? ' disabled' : ''}></button></div>
      <div class="field"><label for="email-to">Who gets it</label>
        <div style="display:flex;gap:8px"><input class="input" id="email-to" type="text" inputmode="email" autocomplete="off" placeholder="you@example.com, them@example.com" value="${esc((e?.to || []).join(', '))}">
        <button class="btn" data-action="email-save"${!e || e.loading ? ' disabled' : ''}>Save</button></div>
        <div class="hint">Up to 10 addresses. Times and weather follow ${esc(state.settings.place.name)} and this screen's clock (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}); saving here updates them.</div></div>`;
  return connRow('email', 'bell', 'Summary email', status, on, body);
}

/* ---------- Admin: site-wide stats, checks and setup, for the site's admins only (admin.js) ---------- */
let admin = { on: false, uid: null, data: null, loading: false, failed: false, asked: 0 };
// Asked at sign-in, and again when Settings or Admin opens, since access can be granted (the
// ADMIN_EMAILS secret, the published rules) while a screen stays open. For everyone else the
// database refuses, and nothing shows.
function checkAdmin(u) {
  if (!u) { admin = { on: false, uid: null, data: null, loading: false, failed: false, asked: 0 }; setDomeItems(false); return; }
  if (admin.uid === u.uid) return;
  admin = { on: false, uid: u.uid, data: null, loading: false, failed: false, asked: 0 };
  askAdmin();
}
function askAdmin() {
  const uid = admin.uid;
  admin.asked = Date.now();
  isAdmin().then((on) => {
    if (admin.uid !== uid || !on || admin.on) return;
    admin.on = true;
    setDomeItems(true);
    loadAdminData();
  });
}
// Why Admin isn't showing, for the Admin page when someone who isn't (yet) an admin opens it.
let adminRules = null;
function checkAdminRules() {
  if (!account.user || adminRules?.loading || adminRules?.at > Date.now() - 15e3) return;
  adminRules = { loading: true };
  adminRulesPublished().then((ok) => { adminRules = { ok, at: Date.now() }; if (currentRoute() === 'admin' && calmToRender()) renderView(); });
}
function recheckAdmin() {
  if (account.user && admin.uid === account.user.uid && !admin.on && Date.now() - admin.asked > 15e3) askAdmin();
}
function loadAdminData() {
  if (!admin.on || admin.loading) return;
  admin.loading = true;
  loadAdmin().then((d) => { admin.data = d; admin.failed = false; }, () => { admin.failed = true; })
    .then(() => { admin.loading = false; if (['admin', 'settings'].includes(currentRoute()) && calmToRender()) renderView(); });
}
const adminChecks = () => monitors({ ...(admin.data || {}), site: { feedback: !!FEEDBACK_EMAIL, fitbit: healthAvailable() } });
const LEVEL = { ok: ['c-green-ico', 'check', 'OK'], warn: ['c-amber-ico', 'bell', 'Check'], bad: ['c-red-ico', 'x', 'Problem'] };

// Settings › Admin: only the site's admins see this row.
function adminRow() {
  recheckAdmin();
  if (!admin.on) return '';
  const w = admin.data ? worst(adminChecks()) : 'ok';
  const n = admin.data ? adminChecks().filter((m) => m.level !== 'ok').length : 0;
  return `<h3 class="set-group">Admin</h3>
    <div class="card conns"><a class="conn admin-link" href="#/admin"><span class="conn-sum"><span class="ibox ${LEVEL[w][0]}">${icon('shield')}</span>
      <span class="conn-text"><b>Admin</b><small>${!admin.data ? 'Stats, checks and site setup' : n ? `${n} check${n === 1 ? ' needs' : 's need'} a look` : 'All checks OK'}</small></span>${icon('chevron', 'chev')}</span></a></div>`;
}

const ghSecret = (name) => `<code>${name}</code>`;
function adminSetup() {
  return `<div class="card conns">
    ${connRow('a-admins', 'shield', 'Who can open Admin', 'ADMIN_EMAILS secret', true, `
      <p class="hint">Admin opens for the Google accounts listed in the ${ghSecret('ADMIN_EMAILS')} secret (commas between them). The Daily summary email job copies the list into the database each hour, and the database rules only let those accounts read the admin records.</p>
      <ol class="hint"><li>In the Home-Assistance repo, open <b>Settings › Secrets and variables › Actions</b> and add ${ghSecret('ADMIN_EMAILS')}.</li>
        <li>Publish <code>firestore.rules</code> in the Firebase console (<b>Firestore Database › Rules</b>) whenever it changes.</li>
        <li>Run <b>Daily summary email</b> in the repo's <b>Actions</b> tab to fill the stats now instead of within the hour.</li></ol>`)}
    ${connRow('a-email', 'bell', 'Summary email', admin.data?.stats?.secrets?.smtp ? 'Sending account set up' : 'Sending account not set up', !!admin.data?.stats?.secrets?.smtp, `
      <ol class="hint">
        <li>On the Gmail account that sends, create an <b>app password</b> (Google Account › Security › 2-Step Verification › App passwords).</li>
        <li>In the Home-Assistance repo, open <b>Settings › Secrets and variables › Actions</b> and add ${ghSecret('EMAIL_SMTP_USER')} (that Gmail address), ${ghSecret('EMAIL_SMTP_PASSWORD')} (the app password) and ${ghSecret('FIREBASE_SERVICE_ACCOUNT')} (Firebase console › <b>Project settings › Service accounts › Generate new private key</b>, the whole file).</li>
        <li>Each household turns its own email on in Settings › Connections. To send one now, run <b>Daily summary email</b> in the repo's <b>Actions</b> tab with the household's id from the list above.</li>
      </ol>`)}
    ${connRow('a-fitbit', 'heart', 'Fitbit sign-in', healthAvailable() ? 'Set up' : 'Not set up', healthAvailable(), `
      <ol class="hint">
        <li>In Google Cloud, turn on the <b>Google Health API</b> and add each person's Google account as a test user.</li>
        <li>Create a <b>Web application</b> OAuth client with <code>${esc(location.origin)}</code> as an authorized JavaScript origin.</li>
        <li>Save its client ID as the GitHub secret ${ghSecret('GOOGLE_HEALTH_CLIENT_ID')} and run <b>Deploy to GitHub Pages</b>.</li>
      </ol>`)}
    ${connRow('a-feedback', 'mail', 'Feedback address', FEEDBACK_EMAIL ? 'Set up' : 'Not set up', !!FEEDBACK_EMAIL, `
      <p class="hint">Feedback in the More menu opens an email to the address in the ${ghSecret('FEEDBACK_EMAIL')} secret. Add it, then run <b>Deploy to GitHub Pages</b>.</p>`)}
    ${ENERGY_ON ? connRow('a-pge', 'zap', 'PG&amp;E energy', 'One household, set up with GitHub secrets', true, `
      <p class="hint">No screen signs in to PG&amp;E itself. A GitHub job signs in every morning and saves the usage, locked with a passphrase.</p>
      <ol class="hint">
        <li>In the Home-Assistance repo on GitHub, open <b>Settings › Secrets and variables › Actions</b> and add ${ghSecret('PGE_USERNAME')}, ${ghSecret('PGE_PASSWORD')} and ${ghSecret('ENERGY_PASSPHRASE')} (a phrase you make up).</li>
        <li>PG&amp;E sends a code the first time a new device signs in. On your computer run <code>python3 sync/pge_pair.py</code>, enter the code, and save the line it prints as ${ghSecret('PGE_LOGIN_DATA')}. It lasts about six months.</li>
        <li>In the repo's <b>Actions</b> tab, run <b>Deploy to GitHub Pages</b>. It then runs every morning by itself.</li>
        <li>Type the same passphrase in Settings › Connections › PG&amp;E energy on each screen.</li>
      </ol>`) : ''}
  </div>`;
}

function adminWhyNot() {
  if (!account.user) return '';
  checkAdminRules();
  const r = adminRules;
  const rules = !r || r.loading ? 'Checking the database rules…'
    : r.ok === true ? 'The database rules with the admin section are published.'
    : r.ok === false ? 'The database rules don\'t have the admin section yet: publish <code>firestore.rules</code> in the Firebase console (Firestore Database › Rules).'
    : "Couldn't check the database rules (offline?).";
  return `<ul class="hint admin-why">
    <li>Signed in as <b>${esc(account.user.email || 'an account with no email')}</b>. The <code>ADMIN_EMAILS</code> secret must hold exactly this address.</li>
    <li>${rules}</li>
    <li>The Daily summary email job copies <code>ADMIN_EMAILS</code> into the database each hour; run it by hand in Actions to do it now.</li></ul>`;
}

views.admin = () => {
  recheckAdmin();
  if (!admin.on) {
    return `<div class="section-title">Admin</div>
      <div class="card"><p class="empty-line">This page is for whoever runs the site.${account.user ? '' : ' Sign in first.'}</p>${adminWhyNot()}</div>`;
  }
  if (!admin.data && !admin.loading && !admin.failed) loadAdminData();
  const d = admin.data;
  const st = d?.stats;
  const refresh = `<button class="btn ghost" data-action="admin-refresh"${admin.loading ? ' disabled' : ''}>${admin.loading ? 'Loading…' : 'Refresh'}</button>`;
  if (!d) {
    return `<div class="section-title">Admin<span class="spacer"></span>${refresh}</div>
      <div class="card"><p class="empty-line">${admin.failed ? "Couldn't load the admin records. Offline, or the latest firestore.rules aren't published yet." : 'Loading…'}</p></div>${adminSetup()}`;
  }
  const checks = adminChecks();
  const tile = (ic, label, n, sub) => `<div class="card tile"><small>${icon(ic)}${label}</small><b>${(n ?? 0).toLocaleString()}</b><span>${sub}</span></div>`;
  const limit = st?.limit || 1040000;
  const homes = st?.homes || [];
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–');
  return `<div class="admin">
  <div class="section-title">Admin<span class="spacer"></span>${refresh}</div>
  <p class="hint admin-note">Only the site's admins can see this page. ${st ? `Numbers from ${when(st.at)}${st.job ? ` (<a href="${esc(st.job)}" target="_blank" rel="noopener">job run</a>)` : ''}.` : ''}</p>
  <h3 class="set-group">Monitors</h3>
  <div class="card conns">${checks.map((m) => `<div class="conn mon mon-${m.level}" data-mon="${m.id}"><span class="conn-sum"><span class="ibox ${LEVEL[m.level][0]}" title="${LEVEL[m.level][2]}">${icon(LEVEL[m.level][1])}</span>
    <span class="conn-text"><b>${m.title}</b><small>${esc(m.text)}</small></span></span></div>`).join('')}</div>
  ${st ? `<h3 class="set-group">Stats</h3>
  <div class="energy-tiles admin-tiles">
    ${tile('home', 'Households', st.households, `${(st.people || 0).toLocaleString()} people in them`)}
    ${tile('users', 'Accounts', st.accounts, 'Signed in with Google')}
    ${tile('heart', 'Friendships', st.friendships, `${(st.groups || 0).toLocaleString()} groups · ${(st.posts || 0).toLocaleString()} posts`)}
    ${tile('lock', 'Passphrase households', st.legacy, `${st.legacyActive || 0} used in 30 days`)}
  </div>
  <div class="card"><div class="card-head">${icon('chart')}<h2>Households</h2><span class="hint">Biggest first · data limit ${fmtBytes(limit)}</span></div>
    ${homes.length ? `<div class="table-wrap"><table class="energy-table admin-homes">
      <thead><tr><th>Household</th><th>People</th><th>Data</th><th>Email</th><th>Last change</th><th></th></tr></thead>
      <tbody>${homes.map((h) => { const pct = Math.min(100, Math.round((h.size / limit) * 100)); return `<tr>
        <td><code>${esc(shortId(h.id))}</code>${h.id === houseHome ? ' <span class="hint">(this screen)</span>' : ''}</td><td>${h.members}</td>
        <td><div class="admin-bar${pct >= 90 ? ' bad' : pct >= 80 ? ' warn' : ''}"><i style="width:${pct}%"></i></div><small>${fmtBytes(h.size)} · ${pct}%</small></td>
        <td>${h.email ? `On · ${h.emailTo || 1}` : '–'}${h.emailSent ? `<br><small class="hint">${esc(h.emailSent)}</small>` : ''}</td>
        <td>${when(h.changed)}</td>
        <td><button class="btn ghost" data-action="admin-copy" data-v="${esc(h.id)}" aria-label="Copy household id">Copy id</button></td></tr>`; }).join('')}</tbody>
    </table></div>` : '<p class="empty-line">No households yet.</p>'}</div>` : ''}
  <div class="card"><div class="card-head">${icon('mail')}<h2>Recent summary emails</h2><span class="hint">Newest first</span></div>
    ${d.runs.length ? `<div class="table-wrap"><table class="energy-table">
      <thead><tr><th>When</th><th>Household</th><th>Email</th><th>Result</th></tr></thead>
      <tbody>${d.runs.slice(0, 20).map((r) => `<tr><td>${when(r.at)}</td><td><code>${esc(shortId(r.home))}</code></td><td>${esc(r.slot)}${r.byHand ? ' (by hand)' : ''}</td>
        <td>${r.ok ? 'Sent' : `<span class="admin-fail">Failed</span><br><small class="hint">${esc(r.error || '')}</small>`}</td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="empty-line">None sent since the Admin page started keeping track.</p>'}</div>
  <h3 class="set-group">This screen</h3>
  <div class="card">
    <div class="setting-row"><div><b>App version</b><div class="hint">${appVersion ? `<code>${esc(appVersion.slice(0, 7))}</code>${updateReady ? ' · a newer version is out; this screen reloads by itself' : ' · up to date'}` : 'Running from a local copy'}</div></div></div>
    <div class="setting-row"><div><b>Household sync</b><div class="hint">${esc(houseMessage().text)}${houseSync.size ? ` ${fmtBytes(houseSync.size)} of ${fmtBytes(limit)}.` : ''}</div></div></div>
  </div>
  <h3 class="set-group">Site setup</h3>
  ${adminSetup()}
  </div>`;
};

views.settings = () => {
  const s = state.settings;
  loadHouseEmail();
  const pge = syncMessage();
  const fit = healthPeople();
  return `
  <div class="settings">
  <div class="section-title">Settings</div>
    ${adminRow()}
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
      <div class="setting-row"><div><b>Show who owes whom</b><div class="hint">The ${splitWord()} balance and Settle up on the Money tab.</div></div>
        <button class="switch" role="switch" aria-checked="${s.showSplit !== false}" data-action="toggle-split" aria-label="Show who owes whom"></button></div>
    </div>
    <h3 class="set-group">Household</h3>
    ${houseCard()}
    <h3 class="set-group">Connections</h3>
    <div class="card conns">
      ${ENERGY_ON ? connRow('pge', 'zap', 'PG&amp;E energy', energyDays().length ? `${energyDays().length} days of data${pge.ok ? '' : ' · not syncing'}` : 'Not connected', pge.ok, `
        ${syncBanner(true, false)}
        <div class="field"><label for="energy-pass">Sync passphrase</label>
          <div style="display:flex;gap:8px"><input class="input" id="energy-pass" type="password" autocomplete="off" placeholder="${energyPass ? 'Saved on this device' : 'The ENERGY_PASSPHRASE you chose'}">
          <button class="btn" data-action="energy-connect">${energyPass ? 'Update' : 'Connect'}</button></div></div>
        <p class="hint">Or load a PG&amp;E <b>Download My Data</b> CSV by hand.${energyDays().length ? ` ${energyDays().length} days stored, ${fmtShort(energyDays()[0])} to ${fmtShort(energyDays().at(-1))}.` : ''}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <label class="btn ghost">${icon('plug')} Load PG&amp;E file<input type="file" id="energy-file" accept=".csv,text/csv" multiple hidden></label>
          ${energyPass ? `<button class="btn ghost" data-action="energy-disconnect">Stop syncing</button>` : ''}
          ${energyDays().length ? `<button class="btn ghost" data-action="clear-energy">${icon('trash')} Remove data</button>` : ''}
        </div>`) : ''}
      ${connRow('fitbit', 'heart', 'Fitbit health', !healthAvailable() ? 'Not set up for this site' : fit.length ? `${fit.map((u) => u.name).join(' and ')} connected` : 'Nobody connected yet', healthAvailable() && fit.length > 0, healthBody())}
      ${emailConn()}
    </div>
    <h3 class="set-group">Danger zone</h3>
    <div class="card">
      <p class="hint">Display settings stay on this device. Events, chores and expenses are shared with your other devices when sync is on. <a href="#/privacy">What is kept and who sees it</a></p>
      <div class="danger-btns">
        <button class="btn danger" data-action="reset">${icon('trash')} Clear events and chores</button>
        ${account.user ? `<button class="btn danger" data-action="acct-delete">${icon('trash')} Delete my account</button>` : ''}
      </div>
    </div>
  </div>`;
};

// What the app keeps, who sees it and how to delete it. Also the app's privacy policy: it shows
// before anyone is set up, so #/privacy can be linked from outside the app.
views.privacy = () => {
  const u = account.user;
  const sec = (title, ic, body) => `<div class="card privacy-sec"><h3 class="privacy-h">${icon(ic)}${title}</h3>${body}</div>`;
  return `
  <div class="settings privacy">
  <div class="section-title">Privacy</div>
  <p class="hint privacy-lead">This page says what the app keeps about you, who can see it, and how to delete it. Last changed October 19, 2026.</p>
  ${sec('The short version', 'shieldCheck', `<ul class="privacy-list">
    <li>Your household's events, chores, money and notes are seen only by the people in your household.</li>
    <li>There are no ads, no tracking and no analytics, and nothing is sold or shared for marketing.</li>
    <li>You can delete your account and everything that is only yours at any time, from this page or Settings.</li>
  </ul>`)}
  ${sec('What is kept', 'lock', `<ul class="privacy-list">
    <li><b>Your sign-in.</b> Your Google account's name, email address and an account id, so you can sign in on any device. The app never sees your Google password.</li>
    <li><b>Your household.</b> Whatever you add: events, chores and stars, the kitchen and shopping lists, expenses and receipt pictures, money boxes, the bucket list and check-in pictures, the itinerary with its places, contacts and pictures, thank-yous, notes, and each person's name, color and picture.</li>
    <li><b>Health, if you connect it.</b> Steps, sleep, resting heart rate and weight from Fitbit, read with your permission. You can disconnect in Settings › Connections.</li>
    <li><b>Friends, if you use it.</b> Your Friends name and code, who your friends are, your posts, comments and likes, and the groups you are in with their plans, bucket list and shared money.</li>
    <li><b>Summary email, if your household turns it on.</b> The addresses it goes to, and your household's time zone and weather place.</li>
    <li><b>On this device.</b> Display settings, a copy of your household so it works offline, and pictures you've seen.</li>
  </ul>`)}
  ${sec('Who sees it', 'users', `<ul class="privacy-list">
    <li>Everything in a household is shared with everyone in that household, on every device they sign in on. Hidden notes are hidden on screen, not from the people in the household.</li>
    <li>A post on Friends is seen by the friends you had when you posted it. Everything in a group is seen by everyone in the group.</li>
    <li>Friends and groups never see your household's data.</li>
    <li>The data is kept by Google Firebase, protected by sign-in rules that let only those people in. It is not end-to-end encrypted, so whoever runs the app could reach it to fix a problem you report.</li>
  </ul>`)}
  ${sec('Other services the app uses', 'plug', `<ul class="privacy-list">
    <li><b>Google Firebase</b> for sign-in and storing the data above.</li>
    <li><b>Open-Meteo</b> gets the weather place you picked (a city's location) to show the forecast. Nothing else about you.</li>
    <li><b>Google Health</b> (Fitbit), only when someone connects their own account.</li>
    <li><b>ntfy</b> sends phone alerts, only if you turn them on. An alert says who did what, never what a note says.</li>
    <li><b>GitHub</b> hosts the app, runs the job that sends the summary email and, for a household that set it up, reads its PG&amp;E energy use.</li>
    <li>Receipts are read on this device. The picture only leaves it if you keep it on the expense.</li>
  </ul>`)}
  ${sec('Deleting your data', 'trash', `<ul class="privacy-list">
    <li><b>Delete my account</b> deletes your sign-in, your Friends name, code, friendships, posts and comments, and takes you out of every household and group.</li>
    <li>A household or group nobody else is in is deleted with everything in it.</li>
    <li>A household or group other people still use stays for them, so their calendar and money still add up. Your summary email address is taken off it. To remove what you added there, edit or delete it before you go, or ask someone in the household.</li>
    <li>Invite codes you made stop working within a week. This device's copy is cleared; other devices keep theirs until they are cleared in Settings.</li>
    <li>Deleting happens straight away and can't be undone.</li>
  </ul>
  ${u ? `<button class="btn danger" data-action="acct-delete">${icon('trash')} Delete my account</button>`
    : '<p class="hint">Sign in (Settings › Household) to delete your account.</p>'}`)}
  ${sec('Questions', 'mail', `<p class="hint">Write to us with Feedback in the More menu${FEEDBACK_EMAIL ? ` or at <a href="${feedbackLink()}">${esc(FEEDBACK_EMAIL)}</a>` : ''}. If this page changes, the date at the top changes too.</p>`)}
  </div>`;
};

// Delete my account: what it will do, then a typed DELETE to go ahead.
let delAcct = null; // { homes, busy, note } while the sheet is open
function openDeleteSheet() {
  const d = delAcct || {};
  const homes = d.homes;
  const list = !homes ? '<p class="hint">Checking your households…</p>'
    : !homes.length ? '<p class="hint">You are not in a household.</p>'
    : `<ul class="privacy-list">${homes.map((h) => `<li><b>${esc(h.name)}</b>: ${h.gone ? "you're the only one in it, so it is deleted with everything in it."
      : `stays for the ${h.others === 1 ? 'other person' : `${h.others} others`} in it. You are taken out.`}</li>`).join('')}</ul>`;
  openSheet(`${sheetHead('Delete my account', 'trash')}
    <p class="house-intro">This deletes your sign-in, your Friends profile, posts and comments, and takes you out of every household and group. It can't be undone.</p>
    ${list}
    ${d.note ? `<div class="sync-banner">${icon('users')}<span>${esc(d.note)}</span></div>` : ''}
    <div class="field"><label for="del-confirm">Type DELETE to confirm</label>
      <input class="input" id="del-confirm" autocomplete="off" autocapitalize="characters" spellcheck="false" data-nofocus></div>
    <p class="hint">Google will ask you to pick your account once more.</p>
    <div class="sheet-actions">
      <button class="btn ghost" data-action="close-sheet" ${d.busy ? 'disabled' : ''}>Cancel</button>
      <button class="btn danger" data-action="acct-delete-go" ${d.busy || !homes ? 'disabled' : ''}>${d.busy ? 'Deleting…' : 'Delete my account'}</button>
    </div>`);
  $('#sheet').dataset.kind = 'delete';
}
const deleteSheetOpen = () => !$('#sheet').hidden && $('#sheet').dataset.kind === 'delete';
// This device forgets the account and the household it was showing.
async function forgetHere() {
  stopSocial();
  // An old passphrase household on this screen isn't the account's, so it stays as it is.
  const signedInHome = house.mode === 'home' || (!!houseHome && house.mode !== 'pass');
  if (house.mode === 'home') house.disconnect();
  houseHome = ''; writeLocal(HOUSE_HOME_KEY, '');
  houseInvite = null; writeLocal(HOUSE_INVITE_KEY, '');
  setHomes([]); houseAdding = false; houseNote = '';
  if (signedInHome) { emptyHousehold(); await photos.clearHere().catch(() => {}); }
  try { await accountSignOut(); } catch { /* signed out here anyway */ }
}

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
  closePeek();
  if ((swipe.on || swipe.busy) && !swipeNav) return; // not mid-swipe; the swipe renders when it lands
  const r = currentRoute();
  const view = $('#view');
  const y = window.scrollY;
  const prev = $('#wk-scroll');
  if (prev) wkScroll = prev.scrollTop;
  // Privacy reads the same before anyone is set up, so its link works as the app's privacy policy.
  view.innerHTML = members().length || r === 'admin' || r === 'privacy' ? views[r]() : views.setup();
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
  playBurst();
  fillPhotos(view);
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
  delete $('#sheet').dataset.back;
  $('#sheet').innerHTML = html;
  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
  const first = $('#sheet').querySelector('input, textarea');
  if (first && !$('#sheet [data-nofocus]')) setTimeout(() => first.focus(), 50);
}
// Plays the closing animation, then hides the sheet.
function closeSheet() {
  if ($('#sheet').hidden) return;
  houseAdding = false;
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

// Person picker shared by the sheets. allowBoth: true adds Both (Everyone, past two people) and
// Anyone; 'both' adds only Both. A household of one has no Both. `id` names the picker when a
// sheet has two.
function whoPicker(selected, allowBoth, id = 'who-pick', skip = '') {
  const both = allowBoth && members().length > 1;
  const opts = [...members().filter((u) => u.id !== skip).map((u) => ({ id: u.id, label: esc(u.name) })), ...(both ? [{ id: 'both', label: everyoneLabel() }] : []), ...(allowBoth === true ? [{ id: '', label: 'Anyone' }] : [])];
  return `<div class="who-pick" id="${id}">${opts.map((o) => `
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
    ${noteField(e)}
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
const MAX_REPEATS = 60; // all events share one synced document, so keep a series small
const seriesOf = (e) => (e.series ? state.events.filter((x) => x.series === e.series).sort(byStart) : [e]);

function repeatFields(date) {
  return `<div class="field"><label>Repeats</label><div class="seg wrap" id="ev-repeat">${Object.entries(REPEATS).map(([k, l]) => `<button class="${k ? '' : 'on'}" data-action="pick-repeat" data-v="${k}">${l}</button>`).join('')}</div></div>
    <div class="field" id="ev-until-field" hidden><label for="ev-until">Repeats until</label><input class="input" type="date" id="ev-until" min="${date}"></div>`;
}
function seriesNote(e) {
  const all = seriesOf(e);
  if (all.length < 2) return '';
  return `<p class="hint">Repeats ${all.length} times, ${dayLabel(all[0].date)} to ${dayLabel(all[all.length - 1].date)}. Changes and Delete apply to this day only.</p>`;
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

// An event opened from a day pop-up returns to that day (showing the change) instead of closing.
function closeOrBack(day = $('#sheet').dataset.back) {
  if (day) openDaySheet(day); else closeSheet();
}

// Ticked from the day pop-up: redraw it so the tick shows there too.
function redrawDaySheet() {
  const sheet = $('#sheet');
  if (!sheet.hidden && sheet.dataset.kind === 'day') sheet.innerHTML = daySheetHtml(sheet.dataset.d);
  playBurst();
}

// A little pop and sparkle on a check or emoji the moment it's ticked or picked. Pages get
// re-rendered right after a tap (and again when a sheet closes), so the new copy of the button
// picks the animation up where the old one was, using a negative delay.
const BURST_MS = 600;
// A new sticky note gets the 'stuck' class instead, which slaps it onto the board.
let burstAt = 0, burstSel = '', burstCls = 'burst';
function burst(sel, cls = 'burst') { burstAt = Date.now(); burstSel = sel; burstCls = cls; }
function burstOn(el, t = 0, cls = 'burst') {
  el.classList.remove(cls);
  void el.offsetWidth; // restart the animation on a second quick tap
  el.style.setProperty('--burst-t', `${-t}ms`);
  el.classList.add(cls);
}
function playBurst() {
  const t = Date.now() - burstAt;
  if (!burstSel || t > BURST_MS) return;
  document.querySelectorAll(burstSel).forEach((el) => { if (!el.classList.contains(burstCls)) burstOn(el, t, burstCls); });
}

function openDaySheet(iso) {
  openSheet(daySheetHtml(iso));
  $('#sheet').dataset.kind = 'day';
  $('#sheet').dataset.d = iso;
}

function openTaskSheet(task, who = members()[0].id) {
  const t = task || { id: '', title: '', who, repeat: 'daily', stars: 5 };
  const kind = choreKind(t);
  const days = t.days?.length ? t.days : [new Date().getDay()];
  const every = Number(t.every) || 1;
  openSheet(`${sheetHead(task ? 'Edit chore' : 'New chore', 'checkSquare')}
    <div class="field"><label for="task-title">Chore</label><input class="input" id="task-title" value="${esc(t.title)}" placeholder="e.g. Take out trash"></div>
    <div class="field"><label>Assigned to</label>${whoPicker(t.who, false)}</div>
    ${impRow(t.important)}
    <div class="field"><label>Repeats</label><div class="seg wrap" id="task-repeat">${Object.entries(CHORE_REPEATS).map(([k, l]) => `<button class="${kind === k ? 'on' : ''}" data-action="pick-chore-repeat" data-v="${k}">${l}</button>`).join('')}</div></div>
    <div class="field" id="task-days-field"${kind === 'days' ? '' : ' hidden'}><label>On</label><div class="seg" id="task-days">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button class="${days.includes(d) ? 'on' : ''}" data-action="pick-weekday" data-v="${d}" aria-pressed="${days.includes(d)}">${WEEKDAYS[d]}</button>`).join('')}</div></div>
    <div class="field" id="task-every-field"${kind === 'weekly' ? '' : ' hidden'}><label>Every</label><div class="seg" id="task-every">${[1, 2, 3, 4].map((n) => `<button class="${every === n ? 'on' : ''}" data-action="pick-seg" data-v="${n}">${n === 1 ? 'Week' : `${n} weeks`}</button>`).join('')}</div></div>
    ${members().length > 1 ? `<div class="setting-row imp-row"><div><b>Take turns</b><div class="hint">Once it's done, it moves to the next person when it comes up again. Assigned to is whose turn it is now.</div></div>
      <button class="switch" id="task-turns" role="switch" aria-checked="${!!t.turns}" data-action="toggle-important"></button></div>` : ''}
    <div class="field-row">
      <div class="field"><label>Stars</label><div class="seg" id="task-stars">${[1, 3, 5, 10].map((n) => `<button class="${t.stars === n ? 'on' : ''}" data-action="pick-seg" data-v="${n}">${n}</button>`).join('')}</div></div>
    </div>
    ${noteField(t)}
    <div class="sheet-actions">
      ${task ? `<button class="btn danger" data-action="del-task" data-id="${t.id}">${icon('trash')} Delete</button><span class="spacer"></span>` : ''}
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="save-task" data-id="${t.id}">${task ? 'Save' : 'Add chore'}</button>
    </div>`);
}
const CHORE_REPEATS = { daily: 'Daily', days: 'Some days', weekly: 'Weekly', monthly: 'Monthly', once: 'Once' };
// The sheet's pick, in the shape older versions of the app still read (see schedule.js).
function pickedSchedule() {
  const kind = $('#task-repeat .on')?.dataset.v || 'daily';
  const days = [...document.querySelectorAll('#task-days .on')].map((b) => Number(b.dataset.v)).sort();
  const every = Number($('#task-every .on')?.dataset.v || 1);
  if (kind === 'days') return days.length ? { repeat: 'daily', days } : null;
  if (kind === 'weekly') return { repeat: 'weekly', ...(every > 1 && { every }) };
  if (kind === 'monthly') return { repeat: 'weekly', every: 'month' };
  return { repeat: kind };
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
    // Saying thanks in a bigger household: the sender drops out of who it can be for.
    const toPick = $('#thx-to');
    if (toPick && el.closest('#who-pick')) {
      toPick.querySelectorAll('.who-opt').forEach((b) => { b.hidden = b.dataset.who === el.dataset.who; });
      if (!toPick.querySelector('.who-opt.on:not([hidden])')) toPick.querySelectorAll('.who-opt').forEach((b) => b.classList.toggle('on', b === toPick.querySelector('.who-opt:not([hidden])')));
    }
    const face = $('#note-paper > .av');
    if (face && userOf(el.dataset.who)) face.outerHTML = avatar(el.dataset.who, 'sm');
  },
  'peek-note': (el) => openPeek(el),
  'reveal-note': (el) => { el.remove(); $('#item-note').hidden = false; $('#item-note').focus(); },
  'toggle-important': (el) => el.setAttribute('aria-checked', String(el.getAttribute('aria-checked') !== 'true')),
  'pick-seg': (el) => {
    el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
    el.parentElement.dataset.picked = '1'; // stops the expense category following the name
    if (el.parentElement.id === 'bk-kind') { $('#bk-kind-now').textContent = el.textContent.replace('❤️', ' · ❤️'); el.closest('details').open = false; }
    if (el.parentElement.classList.contains('emoji-pick')) burstOn(el);
  },

  'cal-move': (el) => {
    const d = Number(el.dataset.d);
    calCursor = monthly()
      ? new Date(calCursor.getFullYear(), calCursor.getMonth() + d, 1)
      : addDays(calCursor, d * 7);
  },
  'cal-today': () => { calCursor = new Date(); },
  'cal-view': (el) => { state.settings.calPick = el.dataset.v; save(); setFab(currentRoute()); },
  'cal-who': (el) => { state.settings.calWho = el.dataset.who; save(); },
  'cal-chores': () => { state.settings.calChores = !state.settings.calChores; save(); },
  'open-day': (el) => openDaySheet(el.dataset.d),
  'add-event': (el) => {
    const day = !$('#sheet').hidden && $('#sheet').dataset.kind === 'day' ? $('#sheet').dataset.d : '';
    openEventSheet(null, el.dataset.d);
    if (day) $('#sheet').dataset.back = day;
  },
  'add-event-at': (el, e) => {
    const y = e.clientY - el.getBoundingClientRect().top;
    const h = Math.min(DAY_END - 1, DAY_START + Math.floor(y / HOUR_PX));
    openEventSheet(null, el.dataset.d, `${String(h).padStart(2, '0')}:00`);
  },
  'edit-event': (el) => {
    const day = !$('#sheet').hidden && $('#sheet').dataset.kind === 'day' ? $('#sheet').dataset.d : '';
    openEventSheet(state.events.find((x) => x.id === el.dataset.id));
    if (day) $('#sheet').dataset.back = day; // from a day pop-up: Mark done and Save go back to it
  },
  'save-event': (el) => {
    const title = $('#ev-title').value.trim();
    const date = $('#ev-date').value;
    if (!title || !date) { toast('Add a title and a date'); return; }
    const data = { title, date, time: $('#ev-time').value || '', end: $('#ev-end').value || '', who: pickedWho(), important: pickedImportant(), stars: Number($('#ev-stars .on')?.dataset.v ?? 5), note: pickedNote() };
    const existing = state.events.find((x) => x.id === el.dataset.id);
    if (existing) {
      // Stars already given keep their old count and people: take them back first, give the new ones after.
      const redo = eventDone(existing) && (existing.stars !== data.stars || existing.who !== data.who);
      if (redo) awardStars(existing, 'event', false);
      keepNote(Object.assign(existing, data));
      if (redo) awardStars(existing, 'event', true);
    } else {
      const rep = $('#ev-repeat .on')?.dataset.v || '';
      const until = $('#ev-until')?.value || '';
      if (rep && !until) { toast('Pick the day it stops repeating'); return; }
      if (rep && until < date) { toast('The end day must be on or after the start'); return; }
      const dates = repeatDates(date, rep, until, MAX_REPEATS);
      if (dates.length > MAX_REPEATS) { toast(`That's over ${MAX_REPEATS} days. Pick an earlier end day (${MAX_REPEATS} at most).`); return; }
      const id = `e${Date.now()}`;
      const series = dates.length > 1 ? id : undefined;
      dates.forEach((d, i) => state.events.push(keepNote({ id: i ? `${id}-${i}` : id, ...data, date: d, ...(series && { series }) })));
      if (series) toast(`Added ${dates.length} days`);
    }
    calCursor = new Date(`${date}T12:00`);
    closeOrBack($('#sheet').dataset.back && date);
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
    if (eventDone(e)) burst(`[data-action="toggle-event"][data-id="${e.id}"]:not(.btn)`);
    if (el.dataset.close) closeOrBack();
    redrawDaySheet();
  },
  'pick-chore-repeat': (el) => {
    el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
    $('#task-days-field').hidden = el.dataset.v !== 'days';
    $('#task-every-field').hidden = el.dataset.v !== 'weekly';
  },
  'pick-weekday': (el) => { el.classList.toggle('on'); el.setAttribute('aria-pressed', el.classList.contains('on')); },
  'pick-repeat': (el) => {
    el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
    const until = $('#ev-until');
    $('#ev-until-field').hidden = !el.dataset.v;
    const date = $('#ev-date').value;
    until.min = date;
    // A new kind of repeat starts from its own default: a week of days, a year of months, ten years.
    if (el.dataset.v) until.value = repeatUntil(date, el.dataset.v);
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

  'open-plan-day': (el) => openPlanDay(el.dataset.d),
  'add-plan': (el) => openPlanSheet(null, el.dataset.d || isoDay(new Date())),
  'edit-plan': (el) => openPlanSheet(state.itinerary.find((a) => a.id === el.dataset.id)),
  'plan-back': (el) => { planDraft = null; if (el.dataset.d) openPlanDay(el.dataset.d); else closeSheet(); },
  'del-photo': (el) => {
    planDraft.photos = planDraft.photos.filter((id) => id !== el.dataset.photoId);
    planDraft.fresh.delete(el.dataset.photoId);
    redrawDraftPhotos();
  },
  'view-photo': (el) => viewPhoto(el.dataset.photoId),
  'view-receipt': () => { if (moneyDraft?.receipt) viewPhoto(moneyDraft.receipt, moneyDraft.fresh, true); },
  'del-receipt': () => { if (moneyDraft) { moneyDraft.receipt = ''; moneyDraft.fresh = null; redrawReceipt(); } },
  'save-plan': (el) => {
    const title = $('#pl-title').value.trim();
    const date = $('#pl-date').value;
    const start = $('#pl-start').value || '';
    const end = $('#pl-end').value || '';
    if (!title || !date) { toast('Add what it is and the day'); return; }
    if (end && !start) { toast('Add a start time too'); return; }
    if (start && end && end <= start) { toast('It has to end after it starts'); return; }
    const data = { title: title.slice(0, 80), date, start, end, place: $('#pl-place').value.trim().slice(0, 160), note: $('#pl-note').value.trim().slice(0, PLAN_NOTE_MAX), contact: $('#pl-contact').value.trim().slice(0, PLAN_CONTACT_MAX), photos: [...planDraft.photos] };
    // Empty fields are left out, so they don't take room in the synced document.
    for (const k of ['place', 'note', 'contact']) if (!data[k]) delete data[k];
    for (const k of ['photos']) if (!data[k].length) delete data[k];
    const existing = state.itinerary.find((a) => a.id === el.dataset.id);
    const before = existing?.photos || [];
    if (existing) {
      for (const k of ['place', 'note', 'contact', 'photos']) delete existing[k];
      Object.assign(existing, data);
    } else state.itinerary.push({ id: `i${Date.now()}`, ...data });
    const { fresh } = planDraft;
    planDraft = null;
    for (const [id, d] of fresh) if (data.photos?.includes(id)) photos.add(id, d);
    before.filter((id) => !data.photos?.includes(id)).forEach((id) => photos.drop(id));
    calCursor = new Date(`${date}T12:00`);
    openPlanDay(date);
  },
  'del-plan': (el) => {
    const a = state.itinerary.find((x) => x.id === el.dataset.id);
    if (!a || !confirm(`Delete "${a.title}"?`)) return;
    state.itinerary = state.itinerary.filter((x) => x !== a);
    (a.photos || []).forEach((id) => photos.drop(id));
    planDraft = null;
    openPlanDay(a.date);
  },

  'add-task': (el) => openTaskSheet(null, el.dataset.who),
  'edit-task': (el) => openTaskSheet(state.tasks.find((x) => x.id === el.dataset.id)),
  'save-task': (el) => {
    const title = $('#task-title').value.trim();
    if (!title) { toast('Name the chore first'); return; }
    const sched = pickedSchedule();
    if (!sched) { toast('Pick at least one day'); return; }
    const data = {
      title,
      who: pickedWho() || members()[0].id,
      ...sched,
      stars: Number($('#task-stars .on')?.dataset.v || 5),
      important: pickedImportant(),
      ...($('#task-turns')?.getAttribute('aria-checked') === 'true' && { turns: true }),
      note: pickedNote(),
    };
    const existing = state.tasks.find((x) => x.id === el.dataset.id);
    const today = isoDay(new Date());
    if (existing) {
      // A new schedule counts from today, so every few weeks starts this week.
      const moved = ['repeat', 'days', 'every'].some((k) => JSON.stringify(existing[k]) !== JSON.stringify(data[k]));
      ['days', 'every', 'turns'].forEach((k) => delete existing[k]);
      keepNote(Object.assign(existing, data, moved && { from: today }));
    } else state.tasks.push(keepNote({ id: `t${Date.now()}`, doneOn: '', ...data, from: today }));
    closeSheet();
  },
  'del-task': (el) => {
    state.tasks = state.tasks.filter((t) => t.id !== el.dataset.id);
    closeSheet();
  },
  'toggle-task': (el) => {
    const t = state.tasks.find((x) => x.id === el.dataset.id);
    awardStars(t, 'task', !isDone(t));
    if (isDone(t)) burst(`[data-action="toggle-task"][data-id="${t.id}"]`);
    redrawDaySheet();
  },

  thank: (el) => openThankSheet({ win: el.dataset.win, to: el.dataset.to, from: el.dataset.from, title: el.dataset.title, base: el.dataset.base }),
  // Who a thank-you is for, in a household of three or more. The sender can't pick themselves.
  'pick-to': (el) => { el.parentElement.querySelectorAll('.who-opt').forEach((b) => b.classList.toggle('on', b === el)); },
  'thanks-line': (el) => { $('#thx-text').value = el.dataset.v; },
  'send-thanks': (el) => {
    const from = el.dataset.from || pickedWho();
    const to = el.dataset.to || $('#thx-to .who-opt.on:not([hidden])')?.dataset.who || otherOf(from);
    if (!userOf(to) || !userOf(from) || to === from) { toast('Pick who it is for'); return; }
    if (el.dataset.base) el.dataset.win = `${el.dataset.base}@${to}`;
    if ($('#who-pick')) state.settings.lastWriter = from;
    const text = $('#thx-text').value.trim().slice(0, THANKS_MAX);
    const emoji = $('#thx-emoji .on')?.dataset.v || THANKS_EMOJI[0];
    (state.thanks ||= []).push({ id: `k${Date.now()}`, from, to, emoji, text, ...(el.dataset.win && { win: el.dataset.win, for: el.dataset.title }), at: Date.now(), readAt: 0 });
    if (el.dataset.win) burst(`.heart-btn[data-win="${CSS.escape(el.dataset.win)}"]`);
    closeSheet();
    toast(`Sent to ${userOf(to).name} ${emoji}`);
    phoneAlert(alertRecipients(members(), from).filter((u) => u.id === to), thanksAlert(userOf(from).name, emoji));
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
    const by = pickedWho() || members()[0].id;
    const data = { text, by, color: $('#note-color .on')?.dataset.v || 'butter' };
    const n = state.notes.find((x) => x.id === el.dataset.id);
    if (n) {
      // Changing how long it stays counts from today; leaving it alone keeps the day it was given.
      const keepWas = !n.until ? '' : n.until === isoDay(new Date()) ? 'today' : 'week';
      Object.assign(n, data, keep === keepWas ? {} : { until });
    } else {
      const id = `n${Date.now()}`;
      (state.notes ||= []).push({ id, ...data, until, at: Date.now() });
      burst(`.sticky[data-id="${id}"]`, 'stuck');
    }
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
      const by = me() || pickedWho() || members()[0].id;
      const id = `b${Date.now()}`;
      (state.bucket ||= []).push({ id, text, kind, by, at: Date.now() });
      state.settings.lastWriter = by;
      burst(`.task.bk:has([data-id="${id}"]) .bk-emoji`);
    }
    closeSheet();
  },
  'del-bucket': (el) => {
    const b = state.bucket.find((x) => x.id === el.dataset.id);
    if (!b) return;
    const at = state.bucket.indexOf(b);
    state.bucket = state.bucket.filter((x) => x !== b);
    const pic = b.photo && photos.peek(b.photo);
    if (b.photo) photos.drop(b.photo);
    closeSheet();
    toast('Removed from the list', ['Undo', () => { state.bucket.splice(at, 0, b); if (pic) photos.add(b.photo, pic); save(); renderView(); }]);
  },
  'tick-bucket': (el) => {
    const b = state.bucket.find((x) => x.id === el.dataset.id);
    if (!b) return;
    if (!b.doneAt) { openBucketTick(b); return; }
    const was = { ...b };
    // Putting it back on the list throws the check-in picture away; the next check-in takes a new one.
    const pic = b.photo && photos.peek(b.photo);
    if (b.photo) photos.drop(b.photo);
    for (const k of ['doneAt', 'doneBy', 'from', 'seen', 'photo']) delete b[k];
    toast('Back on the list', ['Undo', () => { Object.assign(b, was); if (pic) photos.add(b.photo, pic); save(); renderView(); }]);
  },
  'done-bucket': (el) => {
    const b = state.bucket.find((x) => x.id === el.dataset.id);
    if (!b) return;
    if (!bucketPic) { toast('Add a picture to check in'); return; }
    const doneBy = pickedWho() || 'both';
    // Whoever ticked it off: this phone's owner, or on the fridge the one person who went.
    const from = me() || (userOf(doneBy) ? doneBy : '');
    Object.assign(b, { doneAt: Date.now(), doneBy, photo: bucketPic.id, ...(from && { from }) });
    photos.add(bucketPic.id, bucketPic.data);
    bucketPic = null;
    burst(`[data-action="tick-bucket"][data-id="${b.id}"]`);
    closeSheet();
    toast(`Ticked off ${b.text} · +${loveOf(b)} love points ❤️`);
    // Same people as the Home notice: everyone but the one who ticked it off.
    if (from) phoneAlert(alertRecipients(members(), from), bucketAlert(userOf(from).name, loveOf(b)));
  },
  'set-me': (el) => { state.settings.me = el.dataset.v; },
  'alerts-on': () => { const m = state.members.find((x) => x.id === me()); if (m) m.alerts = newAlertTopic(); },
  'alerts-off': () => { const m = state.members.find((x) => x.id === me()); if (m) delete m.alerts; },
  'alerts-copy': (el) => { navigator.clipboard?.writeText(el.dataset.v).then(() => toast('Copied'), () => toast(el.dataset.v)); },
  'alerts-test': async () => {
    const n = await sendAlerts(members().filter((u) => u.id === me()), testAlert(), { click: appUrl() });
    toast(n ? 'Test sent. It should show up on this phone in a few seconds.' : "Couldn't reach ntfy. Check the connection and try again.");
  },
  'setup-add-row': () => {
    const box = $('#setup-names');
    if (!box || box.children.length >= MAX_MEMBERS) return;
    box.insertAdjacentHTML('beforeend', setupRow(box.children.length));
    box.lastElementChild.focus();
  },
  'setup-start': () => {
    const names = [...document.querySelectorAll('[data-setup-name]')].map((i) => cleanName(i.value)).filter(Boolean);
    if (!names.length) { toast('Type at least one name'); return; }
    state.members = names.reduce((list, n) => [...list, newMember(n, list)], []);
    render();
  },
  'open-join': () => { houseUsePass = false; openHouseSheet(); },
  'add-member': () => openMemberSheet(null),
  'edit-member': (el) => { const u = userOf(el.dataset.id); if (u) openMemberSheet(u); },
  'pick-member-color': (el) => { el.parentElement.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b === el)); },
  'save-member': (el) => {
    const name = cleanName($('#mem-name').value);
    if (!name) { toast('Type a name first'); return; }
    const color = $('#mem-color .on')?.dataset.v;
    const m = (state.members ||= []).find((x) => x.id === el.dataset.id);
    if (m) Object.assign(m, { name, ...(color && { color }) });
    else if (members().length < MAX_MEMBERS) state.members.push({ ...newMember(name, members()), ...(color && { color }) });
    closeSheet();
    tickClock();
  },
  // Their history (stars, the Leaderboard, past expenses) stays; only chores still on their list
  // need a new owner first, so nothing is left with nobody to do it.
  'del-member': (el) => {
    const u = userOf(el.dataset.id);
    if (!u) return;
    if (state.tasks.some((t) => t.who === u.id)) { toast(`Move or delete ${u.name}'s chores first`); return; }
    if (!confirm(`Remove ${u.name} from the household? Their past stars and expenses stay in the history.`)) return;
    state.members = state.members.filter((x) => x.id !== u.id);
    if (state.settings.me === u.id) state.settings.me = '';
    closeSheet();
    tickClock();
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
  'acct-use-pass': () => { houseUsePass = true; openHouseSheet(); },
  'acct-use-account': () => { houseUsePass = false; houseSync = { state: 'off' }; openHouseSheet(); },
  'acct-signin': async () => {
    if (houseBusy) return;
    houseBusy = 'signin'; houseNote = ''; refreshHouse();
    try {
      await accountSignIn(); // what happens next follows from onAccount
    } catch (e) {
      houseNote = accountError(e);
      if (!houseSheetOpen() && currentRoute() === 'settings') toast(houseNote);
    }
    houseBusy = ''; refreshHouse();
  },
  'acct-signout': async () => {
    if (house.mode === 'home') house.disconnect();
    houseHome = ''; writeLocal(HOUSE_HOME_KEY, '');
    houseInvite = null; writeLocal(HOUSE_INVITE_KEY, '');
    setHomes([]); houseAdding = false;
    houseNote = '';
    try { await accountSignOut(); } catch { /* signed out here anyway */ }
    if (!houseSheetOpen()) toast('Signed out. This device keeps its copy but stops syncing.');
    refreshHouse();
  },
  'acct-delete': async () => {
    if (!account.user) return;
    delAcct = {}; openDeleteSheet();
    try { delAcct.homes = await deletionPreview(account.user.uid); } catch { delAcct.note = "Couldn't check your households. Are you offline?"; }
    if (deleteSheetOpen()) openDeleteSheet();
  },
  'acct-delete-go': async () => {
    const u = account.user;
    if (!u || !delAcct?.homes || delAcct.busy) return;
    if ($('#del-confirm')?.value.trim().toUpperCase() !== 'DELETE') { delAcct.note = 'Type DELETE in the box first.'; openDeleteSheet(); return; }
    delAcct.busy = true; delAcct.note = ''; openDeleteSheet();
    let done = null;
    try {
      const who = await confirmIdentity();
      if (who === 'cancelled') delAcct.note = 'Nothing was deleted.';
      else done = await deleteAccount(u.uid, u.email);
    } catch (e) {
      delAcct.note = e?.code === 'auth/user-mismatch' ? `Pick ${u.email} in the Google window. Nothing was deleted.`
        : `Couldn't finish (${String(e?.code || e?.message || e).replace(/^auth\//, '')}). Try again; anything already deleted stays deleted.`;
    }
    if (!done) { delAcct.busy = false; if (deleteSheetOpen()) openDeleteSheet(); return; }
    await forgetHere();
    delAcct = null; closeSheet();
    toast(done === 'relogin' ? 'Your data is deleted. To delete the sign-in too, sign in again and tap Delete my account once more.'
      : 'Your account is deleted.');
    render();
  },
  'acct-start': async () => {
    const u = account.user;
    if (!u || houseBusy) return;
    houseBusy = 'start'; houseNote = ''; openHouseSheet();
    try {
      // Already in a household: send what's left to it, then start the new one empty.
      const another = !!houseHome && house.mode === 'home';
      if (another && !(await house.leave())) throw Object.assign(new Error(), { code: 'unsynced' });
      const home = await startHome(u);
      if (another) emptyHousehold();
      useHome(home);
      const r = await house.connectHome(home, { fresh: another }); // a first household starts from what is on this screen
      if (r === 'ok') { houseAdding = false; toast('Household started. Invite everyone from Settings.'); closeSheet(); } else houseNote = houseMessage().text;
    } catch (e) { houseNote = e?.code === 'unsynced' ? unsyncedNote : accountError(e); }
    houseBusy = ''; refreshHouse();
  },
  'acct-join': async (el) => {
    const u = account.user;
    const code = el.closest('.sheet')?.querySelector('#join-code')?.value || '';
    if (!u || houseBusy) return;
    if (!code.trim()) { toast('Type the code first'); return; }
    houseBusy = 'join'; houseNote = ''; openHouseSheet();
    try {
      const home = await joinWithCode(u, code);
      if (home === 'nocode') houseNote = "That code doesn't work. Check it for typos, or ask for a new one.";
      else if (home === 'expired') houseNote = 'That code has run out. Ask for a new one.';
      else {
        // A screen following a moved household keeps its copy (the same household's data);
        // any other device takes the household's data instead of mixing its own in.
        const following = !!houseMoved;
        let r;
        if (house.mode === 'home') {
          // Already in a household: this one joins the list and shows here instead.
          r = await goToHome(home);
          if (r === 'offline') houseNote = unsyncedNote;
        } else {
          if (house.connected) house.disconnect();
          houseMoved = null; forgetPass(); useHome(home);
          r = await house.connectHome(home, { fresh: !following });
        }
        if (r === 'ok') { houseAdding = false; refreshHomes(); toast('Joined the household'); closeSheet(); } else houseNote ||= houseMessage().text;
      }
    } catch (e) { houseNote = accountError(e); }
    houseBusy = ''; refreshHouse();
  },
  'join-seen': () => {
    const seen = joinsSeen();
    seen[houseHome] = [...new Set([...(seen[houseHome] || []), ...houseAccounts().map((a) => a.uid)])];
    writeLocal(JOINS_SEEN_KEY, JSON.stringify(seen));
    renderView();
  },
  'acct-remove': async (el) => {
    const a = houseAccounts().find((x) => x.uid === el.dataset.uid);
    if (!a || !houseHome || a.uid === account.user?.uid) return;
    if (!confirm(`Remove ${accountLabel(a)}${a.name && a.email ? ` (${a.email})` : ''} from this household? They won't be able to see or change anything in it. What they added stays.`)) return;
    try { await removeAccount(houseHome, a.uid); toast(`Removed ${accountLabel(a)}`); } catch (e) { toast(accountError(e)); }
    renderView();
  },
  'house-add': () => { houseAdding = true; houseNote = ''; openHouseSheet(); },
  'house-switch': async (el) => {
    const u = account.user; const home = el.dataset.id;
    if (!u || houseBusy || !home || home === houseHome) return;
    houseBusy = `switch:${home}`; refreshHouse();
    const r = await goToHome(home);
    houseBusy = '';
    if (r === 'ok') {
      useHomeFor(u.uid, home).catch(() => {}); // where a new device starts; this one is already there
      toast(`Switched to ${homeName(home)}`);
    } else toast(r === 'offline' ? unsyncedNote : houseMessage().text);
    renderView();
  },
  'email-save': (el) => saveEmail({ to: emailList(el.closest('.field')?.querySelector('#email-to')?.value) }),
  'email-toggle': () => saveEmail({ on: !houseEmail?.on }),
  'admin-refresh': () => { loadAdminData(); renderView(); },
  'admin-copy': (el) => Promise.resolve(navigator.clipboard?.writeText(el.dataset.v)).then(() => toast(navigator.clipboard ? 'Household id copied' : el.dataset.v), () => toast(el.dataset.v)),
  'house-rename': async (el) => {
    const name = cleanName(el.closest('.field')?.querySelector('#house-name')?.value || '').slice(0, 40);
    if (!name || !houseHome) return;
    try {
      await renameHome(houseHome, name);
      setHomes(houseHomes.map((h) => (h.id === houseHome ? { ...h, name } : h)));
      toast('Saved');
    } catch (e) { toast(accountError(e)); }
    renderView();
  },
  'acct-invite': async () => {
    const u = account.user;
    if (!u || !houseHome || houseBusy) return;
    houseBusy = 'invite'; refreshHouse();
    try {
      const inv = await createInvite(houseHome, u.uid);
      houseInvite = { ...inv, home: houseHome };
      writeLocal(HOUSE_INVITE_KEY, JSON.stringify(houseInvite));
    } catch (e) { toast(accountError(e)); }
    houseBusy = ''; refreshHouse();
  },
  'acct-move': () => {
    openSheet(`${sheetHead('Move to sign-in', 'users')}
      <p class="house-intro">Everything in this household moves to a new one that people sign in to with Google. Nothing is deleted: the passphrase copy stays as it is.</p>
      <p class="house-intro">Other screens and phones show a Sign in button the next time they sync. After signing in, they carry on where they were.</p>
      <div class="sheet-actions">
        <button class="btn ghost" data-action="close-sheet">Cancel</button>
        <button class="btn" data-action="acct-move-go">Move</button>
      </div>`);
    $('#sheet').dataset.kind = 'house-move';
  },
  'acct-move-go': async (el) => {
    const u = account.user;
    if (!u || !housePass || house.mode !== 'pass' || houseBusy) return;
    houseBusy = 'move'; el.disabled = true; el.textContent = 'Moving…';
    const pass = housePass; const base = savedHouseBase();
    try {
      const home = await startHome(u);
      const inv = await createInvite(home, u.uid);
      const r = await house.moveTo(home, inv.code);
      if (r !== 'ok') throw new Error(houseMessage().text);
      useHome(home); forgetPass();
      houseInvite = { ...inv, home }; writeLocal(HOUSE_INVITE_KEY, JSON.stringify(houseInvite));
      toast('Moved. Invite people from Settings.');
    } catch (e) {
      // Back to the passphrase household as it was; nothing there was changed.
      house.disconnect(); house.resume(pass, base);
      toast(`Couldn't move: ${accountError(e)}`);
    }
    houseBusy = ''; closeSheet(); refreshHouse();
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
    else burst(`[data-action="use-fridge"][data-id="${it.id}"]`);
    // A slip of the finger is one tap to put back.
    const undo = ['Undo', () => {
      const cur = state.fridge.find((x) => x.id === before.id);
      if (cur) Object.assign(cur, before); else state.fridge.splice(at, 0, before);
      save(); renderView();
    }];
    // The last one gone is the moment to remember to buy more.
    const more = ['Add to list', () => { if (addToShopping(it.name)) { save(); renderView(); toast(`${it.name} is on the shopping list`); } }];
    if (it.qty <= 0 && !(state.shopping || []).some((x) => shopKey(x.name) === shopKey(it.name))) toast(`${it.name} is used up`, more, undo);
    else toast(it.qty <= 0 ? `${it.name} is used up` : `Used one ${it.name}`, undo);
  },
  'fridge-cat': (el) => { fridgeCat = el.dataset.v; },
  'add-shop': () => {
    const box = $('#shop-new');
    if (!box.value.trim()) { box.focus(); return; }
    if (!addToShopping(box.value)) toast("It's already on the list");
    social.drafts.shop = '';
    setTimeout(() => $('#shop-new')?.focus(), 0); // keep typing the next thing
  },
  'got-shop': (el) => {
    const at = state.shopping.findIndex((x) => x.id === el.dataset.id);
    if (at < 0) return;
    const [x] = state.shopping.splice(at, 1);
    toast(`Got ${x.name}`, ['Undo', () => { state.shopping.splice(at, 0, x); save(); renderView(); }]);
  },
  'rc-tick': (el) => {
    el.classList.toggle('on'); el.closest('.rc-row').classList.toggle('off', !el.classList.contains('on'));
    if (el.classList.contains('on')) burstOn(el);
  },
  'save-receipt': () => {
    const today = isoDay(new Date()); const t = Date.now();
    let n = 0; const read = [];
    $('#sheet').querySelectorAll('.rc-row').forEach((row, i) => {
      const name = row.querySelector('.rc-name').value.trim();
      if (!row.querySelector('.rc-tick').classList.contains('on') || !name) return;
      const cat = row.querySelector('.rc-cat').value;
      const qty = Math.max(1, Math.round(Number(row.querySelector('.rc-qty').value) || 1));
      const same = state.fridge.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (same) { same.qty += qty; same.added = today; same.use = suggestUse(cat) || same.use; } else state.fridge.push({ id: `f${t + i}`, name, qty, cat, added: today, use: suggestUse(cat) });
      n += 1;
      read.push({ read: row.dataset.read || '', kept: name });
    });
    // Names kept as read, or fixed by hand, teach the reader this household's words.
    learnFromReceipt(read);
    const bought = tickOffShopping(read.map((r) => r.kept));
    closeSheet();
    toast(`Added ${n} item${n === 1 ? '' : 's'} to the fridge${bought.length ? ` and ticked ${bought.length} off the shopping list` : ''}`);
  },
  'edit-expense': (el) => openExpenseSheet(state.expenses.find((x) => x.id === el.dataset.id)),
  'add-box': () => openBoxSheet(null),
  'open-box': (el) => { const b = (state.boxes || []).find((x) => x.id === el.dataset.id); if (b) openBoxView(b); },
  'edit-box': (el) => openBoxSheet((state.boxes || []).find((x) => x.id === el.dataset.id)),
  'add-box-expense': (el) => openExpenseSheet(null, null, el.dataset.id),
  'save-box': (el) => {
    const name = cleanBoxName($('#box-name').value);
    let from = $('#box-from').value; let to = $('#box-to').value;
    if (!name) { toast('Give the box a name'); return; }
    if (!from && to) from = to;
    if (to && to < from) [from, to] = [to, from];
    const data = { name, ...(from && { from }), ...(to && to !== from && { to }) };
    state.boxes ||= [];
    const b = state.boxes.find((x) => x.id === el.dataset.id);
    if (b) { delete b.from; delete b.to; Object.assign(b, data); } else state.boxes.push({ id: `m${Date.now()}`, ...data, by: me(), at: Date.now() });
    if (from && !b) piggyMonth = from.slice(0, 7);
    closeSheet();
    toast(b ? 'Box saved' : `${name} is open`);
  },
  'del-box': (el) => {
    const b = (state.boxes || []).find((x) => x.id === el.dataset.id);
    if (!b || !confirm(`Delete ${b.name}? Its expenses stay in Money, just not in a box.`)) return;
    state.expenses.forEach((x) => { if (x.box === b.id) delete x.box; });
    state.boxes = state.boxes.filter((x) => x !== b);
    closeSheet();
  },
  'save-expense': (el) => {
    const title = $('#ex-title').value.trim();
    const amount = Math.round(Number($('#ex-amount').value) * 100) / 100;
    const date = $('#ex-date').value;
    if (!title || !(amount > 0) || !date) { toast('Add what it was, the amount and the day'); return; }
    const data = { title, amount, date, paidBy: pickedWho() || members()[0].id, split: $('#ex-split').getAttribute('aria-checked') === 'true', cat: $('#ex-cat .on')?.dataset.v || 'other' };
    const existing = state.expenses.find((x) => x.id === el.dataset.id);
    const { receipt, fresh } = moneyDraft || {};
    if (receipt) data.receipt = receipt;
    // Without a box picker (no boxes yet) the expense keeps whatever box it had.
    const box = $('#ex-box') ? $('#ex-box .on')?.dataset.v || '' : existing?.box || '';
    if (box) data.box = box;
    if (existing) {
      if (!box) delete existing.box;
      if (existing.receipt && existing.receipt !== receipt) photos.drop(existing.receipt);
      if (!receipt) delete existing.receipt;
      Object.assign(existing, data);
    } else state.expenses.push({ id: `x${Date.now()}`, ...data });
    if (receipt && fresh) photos.add(receipt, fresh);
    moneyDraft = null;
    piggyMonth = date.slice(0, 7);
    closeSheet();
  },
  'settle-up': (el) => {
    const t = expenseStats(expensesIn(piggyMonth)).transfers[Number(el.dataset.i) || 0];
    if (!t) return;
    const from = userOf(t.from); const to = userOf(t.to);
    if (!confirm(`Mark that ${from.name} paid ${to.name} ${fmtCash(t.amount)}?`)) return;
    const today = isoDay(new Date());
    const date = piggyMonth === monthKey(new Date()) ? today : isoDay(monthBounds(piggyMonth)[1]);
    state.expenses.push({ id: `x${Date.now()}`, kind: 'settle', title: 'Settled up', amount: t.amount, date, paidBy: t.from, to: t.to, split: false });
    burst('.balance .bal-icon'); // shows once everyone is square
    toast(expenseStats(expensesIn(piggyMonth)).transfers.length ? `${from.name} is square with ${to.name}` : 'All square');
  },
  'del-expense': (el) => {
    const gone = state.expenses.find((x) => x.id === el.dataset.id);
    if (gone?.receipt) photos.drop(gone.receipt);
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
    state = { ...defaultState(), settings: state.settings, members: state.members, stars: state.stars, log: state.log, expenses: state.expenses, fridge: state.fridge, health: state.health, thanks: state.thanks, notes: state.notes, bucket: state.bucket, boxes: state.boxes, events: [], tasks: [] };
    save();
  },
};

// Actions that only open or edit a sheet don't need the page behind it re-rendered.
Object.assign(actions, socialActions);
// Friends redraws itself when its data changes, so its buttons don't redraw the page here.
const NO_RERENDER = new Set([...Object.keys(socialActions), 'open-plan-day', 'add-plan', 'edit-plan', 'plan-back', 'del-photo', 'view-photo', 'view-receipt', 'del-receipt', 'save-plan', 'del-plan', 'setup-add-row', 'open-join', 'acct-delete', 'acct-use-pass', 'acct-use-account', 'acct-move', 'add-member', 'edit-member', 'pick-member-color', 'open-bucket-news', 'add-bucket', 'edit-bucket', 'thank', 'pick-to', 'thanks-line', 'view-thanks', 'add-note', 'edit-note', 'pick-color', 'add-menu', 'pick-who', 'pick-seg', 'pick-repeat', 'pick-chore-repeat', 'pick-weekday', 'toggle-important', 'peek-note', 'reveal-note', 'open-day', 'add-event', 'add-event-at', 'edit-event', 'add-task', 'edit-task', 'place-search', 'add-expense', 'edit-expense', 'add-box', 'open-box', 'edit-box', 'add-box-expense', 'add-fridge', 'edit-fridge', 'rc-tick', 'alerts-copy', 'alerts-test']);

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  // A second tap on the same note icon closes its bubble instead of reopening it.
  const peeked = $('#note-peek')?.dataset.for;
  closePeek();
  if (el?.dataset.action === 'peek-note' && peeked === `${el.dataset.kind}:${el.dataset.id}`) return;
  if (!el) return;
  const name = el.dataset.action;
  const fn = actions[name];
  if (!fn) return;
  fn(el, e);
  save();
  if (!NO_RERENDER.has(name)) renderView(['cal-move', 'cal-today', 'cal-view', 'cal-chores', 'cal-who'].includes(name) ? 'cal' : undefined);
});

$('#sheet-backdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePeek();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('note-tag')) { e.preventDefault(); e.stopPropagation(); e.target.click(); }
}, true);
document.addEventListener('scroll', closePeek, true);
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
  const exCat = $('#ex-cat');
  if (e.target.id === 'ex-title' && exCat && !exCat.dataset.picked) {
    const g = guessExpenseCat(e.target.value);
    exCat.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === g));
  }
});
document.addEventListener('change', (e) => {
  if (!['receipt-file', 'receipt-money'].includes(e.target.id) || !e.target.files[0]) return;
  (e.target.id === 'receipt-file' ? scanReceipt : scanExpense)(e.target.files[0]);
  e.target.value = '';
});
document.addEventListener('change', (e) => {
  if (e.target.id !== 'plan-photo' || !e.target.files.length) return;
  addDraftPhotos(e.target.files);
  e.target.value = '';
});
document.addEventListener('change', (e) => {
  if (e.target.id !== 'ex-receipt-file' || !e.target.files[0]) return;
  attachReceipt(e.target.files[0]);
  e.target.value = '';
});
document.addEventListener('change', async (e) => {
  if (e.target.id !== 'bk-photo' || !e.target.files[0]) return;
  const f = e.target.files[0];
  e.target.value = '';
  try {
    bucketPic = { id: `ph${Date.now()}${Math.random().toString(36).slice(2, 6)}`, data: await shrink(f) };
  } catch (err) { toast(err.message || "Couldn't read that picture"); return; }
  const box = $('#bk-shot');
  if (box) box.innerHTML = bkPicHtml();
  const go = $('#sheet [data-action="done-bucket"]');
  if (go) go.disabled = false;
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
if (carriedOver | repairLog() | tidyNotes() | passTurns()) save();
render();
fetchWeather();
syncEnergy();
syncWakeLock();
// A signed-in household connects once Firebase says who is signed in (onAccount); an old
// passphrase household connects straight away.
if (houseHome && accountAvailable()) houseSync = { state: 'connecting' };
else if (housePass && syncAvailable()) house.resume(housePass, savedHouseBase());
if (accountAvailable()) {
  watchUser(onAccount).catch(() => { account = { ready: true, user: null }; refreshHouse(); });
} else if (!housePass && syncAvailable()) {
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
    if (passTurns()) save(); // a new day, week or month hands turn-taking chores on
    // Refresh relative times ("2 minutes ago") without disturbing open dialogs or typing.
    if ($('#sheet').hidden && !document.activeElement?.matches('input, textarea') && members().length) renderView();
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
