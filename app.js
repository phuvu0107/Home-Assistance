import { icon, hydrateIcons } from './icons.js';

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
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
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

function energyCard() {
  const all = energyDays();
  if (!all.length) return '';
  const last = all[all.length - 1];
  const span = (from, n) => Array.from({ length: n }, (_, i) => isoDay(addDays(new Date(`${from}T12:00`), i)));
  const recent = span(isoDay(addDays(new Date(`${last}T12:00`), -29)), 30);
  const before = span(isoDay(addDays(new Date(`${last}T12:00`), -59)), 30).filter((d) => all.includes(d));
  const now = sumDays(recent.filter((d) => all.includes(d)));
  const prev = sumDays(before);
  const month = sumDays(all.filter((d) => d.slice(0, 7) === last.slice(0, 7)));
  const hasCost = now.cost > 0;
  const val = (d) => (hasCost ? d.cost : d.kwh);
  const totals = recent.map((d) => dayTotal(d));
  const max = Math.max(...totals.map(val), 0.01);
  const bars = totals.map((d, i) => {
    const hE = ((hasCost ? d.eCost : d.kwh) / max) * 100;
    const hG = hasCost ? (d.gCost / max) * 100 : 0;
    return `<rect class="bar-e" x="${i * 10 + 1.5}" y="${100 - hE}" width="7" height="${hE}" rx="1.5"></rect>${hG ? `<rect class="bar-g" x="${i * 10 + 1.5}" y="${100 - hE - hG}" width="7" height="${hG}" rx="1.5"></rect>` : ''}`;
  }).join('');
  const change = prev.cost > 0 && before.length >= 25 ? Math.round(((now.cost - prev.cost) / prev.cost) * 100) : null;
  return `<div class="card a-energy">
    <div class="card-head">${icon('zap')}<h2>Energy</h2><span class="hint">PG&amp;E data through ${fmtShort(last)}</span></div>
    <div class="energy">
      <div class="energy-stats">
        <div><small>${new Date(`${last}T12:00`).toLocaleDateString([], { month: 'long' })} so far</small><b>${hasCost ? fmtMoney(month.cost) : `${Math.round(month.kwh)} kWh`}</b></div>
        <div><small>Last 30 days</small><b>${hasCost ? fmtMoney(now.cost) : `${Math.round(now.kwh)} kWh`}</b>
          ${change === null ? '' : change === 0 ? '<span class="trend">Same as the 30 days before</span>' : `<span class="trend ${change > 0 ? 'up' : 'down'}">${icon(change > 0 ? 'arrowUp' : 'arrowDown')}${Math.abs(change)}% vs the 30 days before</span>`}</div>
        <div><small>Used</small><b class="sm">${Math.round(now.kwh)} kWh${now.therms ? ` · ${Math.round(now.therms)} therms` : ''}</b></div>
      </div>
      <div class="energy-chart">
        <div class="chart-top"><span>${hasCost ? 'Cost' : 'kWh'} per day</span><span>${hasCost ? `${now.therms ? '<i class="key-e"></i>Electric <i class="key-g"></i>Gas · ' : ''}max ${fmtMoney(max)}` : `max ${max.toFixed(1)} kWh`}</span></div>
        <svg viewBox="0 0 300 100" preserveAspectRatio="none" role="img" aria-label="Daily ${hasCost ? 'cost' : 'usage'}, last 30 days">${bars}</svg>
        <div class="chart-axis"><span>${fmtShort(recent[0])}</span><span>${fmtShort(last)}</span></div>
      </div>
    </div>
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
  ink.style.width = `${t.offsetWidth}px`;
  ink.style.transform = `translateX(${t.offsetLeft - 6}px)`;
}
window.addEventListener('resize', moveInk);
document.fonts?.ready.then(() => { moveInk(); requestAnimationFrame(() => $('#tabs').classList.add('ink-ready')); });

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
function eventChip(e) {
  return `<button class="ev-chip" data-action="edit-event" data-id="${e.id}">
    ${avatar(e.who, 'xs')}<b>${e.time ? timeLabel(e) : ''}</b><span>${esc(e.title)}</span></button>`;
}

function eventRow(e, withDate = false) {
  const when = [withDate ? dayLabel(e.date) : '', timeLabel(e)].filter(Boolean).join(' · ');
  return `<button class="row" data-action="edit-event" data-id="${e.id}">
    ${avatar(e.who, 'md') || `<span class="ibox c-purple-ico">${icon('calendar')}</span>`}
    <span><b>${esc(e.title)}</b><small>${when}</small></span>${icon('chevron', 'chev')}</button>`;
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

function taskCard(t, u) {
  const done = isDone(t);
  return `<div class="task ${done ? `done c-${u.color}` : ''}">
    <button class="task-body" data-action="edit-task" data-id="${t.id}">
      <b>${esc(t.title)}</b>
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
views.home = () => `
  <div class="grid-home">
    ${weatherCard()}
    <div class="card a-agenda">
      <div class="card-head">${icon('calendar')}<h2>Coming up</h2><a class="link" href="#/calendar">Calendar ${icon('arrowRight')}</a></div>
      <div class="list">${upcomingEvents(4).map((e) => eventRow(e, true)).join('') || '<p class="muted">Nothing on the calendar yet.</p>'}</div>
    </div>
    <div class="card a-tasks">
      <div class="card-head">${icon('checkSquare')}<h2>Today's tasks</h2><a class="link" href="#/tasks">All tasks ${icon('arrowRight')}</a></div>
      <div class="home-tasks">
        ${USERS.map((u) => {
          const open = tasksFor(u.id).filter((t) => !isDone(t));
          return `<div class="home-person">${personHead(u, 'md')}
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
  const allDay = days.map((d) => `<div class="wk-allday">${eventsOn(isoDay(d)).filter((e) => !e.time).map(eventChip).join('')}</div>`).join('');
  const cols = days.map((d) => {
    const iso = isoDay(d);
    const timed = laneLayout(eventsOn(iso).filter((e) => e.time));
    const nowLine = iso === todayIso && nowMin >= DAY_START * 60 && nowMin < DAY_END * 60
      ? `<div class="now-line" style="top:${((nowMin - DAY_START * 60) / 60) * HOUR_PX}px"></div>` : '';
    return `<div class="wk-col" data-action="add-event-at" data-d="${iso}">
      ${timed.map(({ e, start, end, lane, lanes }) => {
        const top = Math.max(0, ((start - DAY_START * 60) / 60) * HOUR_PX);
        const height = Math.max(26, ((end - start) / 60) * HOUR_PX - 3);
        return `<button class="wk-ev ${e.who ? `c-${e.who === 'both' ? 'purple' : userOf(e.who).color}` : 'c-purple'}" data-action="edit-event" data-id="${e.id}"
          style="top:${top}px;height:${height}px;left:calc(${(lane / lanes) * 100}% + 2px);width:calc(${100 / lanes}% - 4px)">
          <span class="wk-ev-top">${avatar(e.who, 'xs')}<b>${timeLabel(e)}</b></span><span class="wk-ev-title">${esc(e.title)}</span></button>`;
      }).join('')}${nowLine}</div>`;
  }).join('');
  return `<div class="wk">
    <div class="wk-head"><div></div>${head}</div>
    <div class="wk-allrow"><div class="wk-gutter-label">All day</div>${allDay}</div>
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
    return `<div class="day ${d.getMonth() !== m ? 'other' : ''} ${iso === todayIso ? 'today' : ''}" data-action="open-day" data-d="${iso}">
      <span class="day-num">${d.getDate()}</span>
      <div class="day-evs">${evs.slice(0, 3).map(eventChip).join('')}${evs.length > 3 ? `<span class="more">+${evs.length - 3} more</span>` : ''}</div>
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

views.settings = () => {
  const s = state.settings;
  return `
  <div class="section-title">Settings</div>
  <div class="page-grid" style="grid-template-columns:repeat(auto-fill,minmax(380px,1fr))">
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
      <div class="setting-row"><div><b>Keep screen on</b><div class="hint">Stops the Surface from sleeping while the dashboard is open.</div></div>
        <button class="switch" role="switch" aria-checked="${s.wakeLock}" data-action="set-wake"></button></div>
    </div>
    <div class="card">
      <div class="card-head">${icon('zap')}<h2>Energy</h2></div>
      <p class="hint">On PG&amp;E's Energy Usage page, choose <b>Download My Data</b>, pick CSV and a date range, then load the file here. Electric and gas files both work, and newer files update older days.</p>
      ${energyDays().length ? `<p class="hint">Loaded ${energyDays().length} days, ${fmtShort(energyDays()[0])} to ${fmtShort(energyDays().at(-1))}.</p>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <label class="btn">${icon('plug')} Load PG&amp;E file<input type="file" id="energy-file" accept=".csv,text/csv" multiple hidden></label>
        ${energyDays().length ? `<button class="btn ghost" data-action="clear-energy">${icon('trash')} Remove</button>` : ''}
      </div>
    </div>
    <div class="card">
      <div class="card-head">${icon('sparkles')}<h2>About</h2></div>
      <p class="hint">Events, tasks and settings are saved on this device only. Weather comes from Open-Meteo.</p>
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
}

/* =========================================================
   Sheets (modal dialogs)
   ========================================================= */
let sheetTimer = null;
function openSheet(html) {
  clearTimeout(sheetTimer);
  $('#sheet').classList.remove('closing');
  $('#sheet-backdrop').classList.remove('closing');
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
    <div class="sheet-actions">
      ${ev ? `<button class="btn danger" data-action="del-event" data-id="${e.id}">${icon('trash')} Delete</button><span class="spacer"></span>` : ''}
      <button class="btn ghost" data-action="close-sheet">Cancel</button>
      <button class="btn" data-action="save-event" data-id="${e.id}">${ev ? 'Save' : 'Add event'}</button>
    </div>`);
}

function openDaySheet(iso) {
  const evs = eventsOn(iso);
  openSheet(`${sheetHead(new Date(`${iso}T12:00`).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }), 'calendar')}
    <div class="list">${evs.map((e) => eventRow(e)).join('') || '<p class="muted">No events.</p>'}</div>
    <div class="sheet-actions"><button class="btn" data-action="add-event" data-d="${iso}">${icon('plus')} Add event</button></div>`);
}

function openTaskSheet(task, who = USERS[0].id) {
  const t = task || { id: '', title: '', who, repeat: 'daily', stars: 5 };
  openSheet(`${sheetHead(task ? 'Edit task' : 'New task', 'checkSquare')}
    <div class="field"><label for="task-title">Task</label><input class="input" id="task-title" value="${esc(t.title)}" placeholder="e.g. Take out trash"></div>
    <div class="field"><label>Assigned to</label>${whoPicker(t.who, false)}</div>
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
    const data = { title, date, time: $('#ev-time').value || '', end: $('#ev-end').value || '', who: pickedWho() };
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
  'clear-energy': () => { energy = null; try { localStorage.removeItem(ENERGY_KEY); } catch { /* ignore */ } toast('Energy data removed'); },
  reset: () => {
    if (!confirm('Clear all events and tasks on this device?')) return;
    state = { ...defaultState(), settings: state.settings, events: [], tasks: [] };
    save();
  },
};

// Actions that only open or edit a sheet don't need the page behind it re-rendered.
const NO_RERENDER = new Set(['pick-who', 'pick-seg', 'open-day', 'add-event', 'add-event-at', 'edit-event', 'add-task', 'edit-task', 'place-search']);

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
   Search
   ========================================================= */
const searchInput = $('#search');
const searchOut = $('#search-results');

function runSearch() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) { searchOut.hidden = true; return; }
  const hits = [];
  PAGES.forEach((p) => { if (p.label.toLowerCase().includes(q)) hits.push({ ic: p.icon, label: p.label, meta: 'Page', href: `#/${p.id}` }); });
  state.tasks.forEach((t) => { if (t.title.toLowerCase().includes(q)) hits.push({ ic: 'checkSquare', label: t.title, meta: `Task · ${whoName(t.who)}`, href: '#/tasks' }); });
  state.events.forEach((ev) => { if (ev.title.toLowerCase().includes(q)) hits.push({ ic: 'calendar', label: ev.title, meta: `${dayLabel(ev.date)} · ${whoName(ev.who)}`, href: '#/calendar' }); });
  searchOut.innerHTML = hits.length
    ? hits.slice(0, 12).map((h) => `<button data-href="${h.href}">${icon(h.ic)}<span>${esc(h.label)}</span><small>${esc(h.meta)}</small></button>`).join('')
    : '<div class="empty">No results</div>';
  searchOut.hidden = false;
}
searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('focus', runSearch);
searchOut.addEventListener('click', (e) => {
  const b = e.target.closest('[data-href]');
  if (!b) return;
  location.hash = b.dataset.href;
  searchInput.value = '';
  searchOut.hidden = true;
  searchInput.blur();
});
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.search')) searchOut.hidden = true;
});

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
syncWakeLock();

window.addEventListener('hashchange', () => {
  closeSheet();
  render();
  window.scrollTo(0, 0);
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
window.addEventListener('online', fetchWeather);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
