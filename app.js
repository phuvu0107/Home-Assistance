import { icon, hydrateIcons } from './icons.js';

/* =========================================================
   State (saved in this browser's localStorage)
   ========================================================= */
const STORE_KEY = 'home-dashboard.v1';
const WEATHER_KEY = 'home-dashboard.weather.v1';

const ROOMS = [
  { id: 'living', name: 'Living Room', icon: 'sofa', art: 'art-living' },
  { id: 'bedroom', name: 'Bedroom', icon: 'bed', art: 'art-bedroom' },
  { id: 'kitchen', name: 'Kitchen', icon: 'utensils', art: 'art-kitchen' },
  { id: 'office', name: 'Office', icon: 'monitor', art: 'art-office' },
  { id: 'outdoor', name: 'Outdoor', icon: 'tree', art: 'art-outdoor' },
];

const minutesAgo = (m) => Date.now() - m * 60000;

function defaultState() {
  return {
    settings: {
      name: 'Truong',
      place: { name: 'Palo Alto', lat: 37.4419, lon: -122.143 },
      unit: 'F',
      theme: 'auto',
      wakeLock: true,
      clock24: false,
    },
    devices: [
      { id: 'l1', room: 'living', name: 'Ceiling light', type: 'light', on: true },
      { id: 'l2', room: 'living', name: 'Floor lamp', type: 'light', on: true },
      { id: 'tv', room: 'living', name: 'TV', type: 'tv', on: false },
      { id: 'l3', room: 'bedroom', name: 'Ceiling light', type: 'light', on: true },
      { id: 'l4', room: 'bedroom', name: 'Bedside lamp', type: 'light', on: false },
      { id: 'fan', room: 'bedroom', name: 'Ceiling fan', type: 'fan', on: false },
      { id: 'l5', room: 'kitchen', name: 'Pendant lights', type: 'light', on: true },
      { id: 'l6', room: 'kitchen', name: 'Under-cabinet lights', type: 'light', on: true },
      { id: 'fridge', room: 'kitchen', name: 'Fridge', type: 'plug', on: true, locked: true },
      { id: 'oven', room: 'kitchen', name: 'Oven', type: 'plug', on: false },
      { id: 'l7', room: 'office', name: 'Desk lamp', type: 'light', on: true },
      { id: 'pc', room: 'office', name: 'Computer', type: 'plug', on: true },
      { id: 'l8', room: 'outdoor', name: 'Porch light', type: 'light', on: true },
      { id: 'l9', room: 'outdoor', name: 'Garden lights', type: 'light', on: true },
      { id: 'l10', room: 'outdoor', name: 'Driveway light', type: 'light', on: false },
    ],
    thermostat: { target: 72, mode: 'heat' },
    security: { mode: 'away' },
    locks: [
      { id: 'front', name: 'Front door', locked: true },
      { id: 'back', name: 'Back door', locked: true },
      { id: 'side', name: 'Side gate', locked: false },
    ],
    garage: { open: false },
    automations: [
      { id: 'a1', name: 'Good morning', desc: 'Weekdays 6:30 AM · Kitchen lights on, 70°', icon: 'sun', on: true },
      { id: 'a2', name: 'Away mode', desc: 'When everyone leaves · Lights off, arm security', icon: 'shieldCheck', on: true },
      { id: 'a3', name: 'Bedtime', desc: 'Every day 11:00 PM · Lights off, lock doors', icon: 'moon', on: true },
      { id: 'a4', name: 'Porch at sunset', desc: 'At sunset · Porch and garden lights on', icon: 'bulb', on: false },
    ],
    activity: [
      { icon: 'bulb', color: 'amber', text: 'Living room light turned off', ts: minutesAgo(2) },
      { icon: 'lock', color: 'blue', text: 'Front door locked', ts: minutesAgo(12) },
      { icon: 'washer', color: 'blue', text: 'Washer finished', ts: minutesAgo(45) },
      { icon: 'thermo', color: 'blue', text: 'Temperature changed to 72°', ts: minutesAgo(60) },
      { icon: 'garage', color: 'purple', text: 'Garage door opened', ts: minutesAgo(120) },
    ],
    notes: [
      { id: 'n1', text: 'Buy milk, eggs, and spinach 🥬', color: 'yellow', ts: minutesAgo(90) },
      { id: 'n2', text: 'Dentist on Thursday 4:30 PM', color: 'blue', ts: minutesAgo(300) },
    ],
    events: [],
    seenActivity: 0,
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

function log(text, iconName, color = 'blue') {
  state.activity.unshift({ icon: iconName, color, text, ts: Date.now() });
  state.activity = state.activity.slice(0, 40);
  save();
  updateBadge();
}

/* =========================================================
   Helpers
   ========================================================= */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const roomOf = (id) => ROOMS.find((r) => r.id === id);

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

const lightsOn = () => state.devices.filter((d) => d.type === 'light' && d.on).length;
const lightsTotal = () => state.devices.filter((d) => d.type === 'light').length;

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
  const pod = partOfDay(h);
  const heroPod = document.documentElement.dataset.theme === 'dark' ? 'night' : pod;
  const greet = { morning: 'Good morning', day: 'Good afternoon', evening: 'Good evening', night: 'Good evening' }[pod];
  const name = state.settings.name.trim();
  $('#greeting').textContent = name ? `${greet}, ${name}` : greet;
  $('#date').textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  $('#clock').textContent = fmtTime(now);
  const hero = $('#hero');
  if (!hero.classList.contains(heroPod)) {
    hero.classList.remove('morning', 'day', 'evening', 'night');
    hero.classList.add(heroPod);
  }
  const isNight = h >= 19 || h < 6;
  const todHtml = icon(isNight ? 'moon' : 'sun');
  if ($('#tod-icon').dataset.v !== String(isNight)) {
    $('#tod-icon').innerHTML = todHtml;
    $('#tod-icon').dataset.v = String(isNight);
  }
  $('#avatar').textContent = (name[0] || 'H').toUpperCase();
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
    + '&daily=temperature_2m_max,temperature_2m_min,weather_code'
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
    };
    try { localStorage.setItem(WEATHER_KEY, JSON.stringify(weather)); } catch { /* ignore */ }
  } catch (err) {
    console.warn('Weather fetch failed', err);
  }
  renderSideWeather();
  if (currentRoute() === 'home') renderView();
}

function weatherValid() {
  const { lat, lon } = state.settings.place;
  return weather && weather.unit === state.settings.unit && weather.placeKey === `${lat},${lon}`;
}

function renderSideWeather() {
  const el = $('#side-weather');
  if (!weatherValid()) { el.innerHTML = ''; return; }
  const w = wmo(weather.code, weather.isDay);
  el.innerHTML = `${icon(w.icon)}<div><b>${Math.round(weather.temp)}°${state.settings.unit}</b><small>${w.label} · ${esc(state.settings.place.name)}</small></div>`;
  el.querySelector('.ico').style.color = 'var(--amber-fg)';
}

/* =========================================================
   Navigation
   ========================================================= */
const PAGES = [
  { id: 'home', label: 'Home', tab: 'Overview', icon: 'home' },
  { id: 'devices', label: 'Devices', icon: 'monitor' },
  { id: 'automations', label: 'Automations', icon: 'automation' },
  { id: 'energy', label: 'Energy', icon: 'zap' },
  { id: 'security', label: 'Security', icon: 'shield' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'notes', label: 'Notes', icon: 'notes' },
  { id: 'settings', label: 'Settings', icon: 'settings', sideOnly: true },
];

const currentRoute = () => {
  const r = location.hash.replace(/^#\/?/, '').split('?')[0];
  return PAGES.some((p) => p.id === r) ? r : 'home';
};

function renderNav() {
  const r = currentRoute();
  $('#side-nav').innerHTML = PAGES.map((p) => `
    <a class="side-link ${p.id === r ? 'active' : ''}" href="#/${p.id}">${icon(p.icon)}<span>${p.label}</span></a>`).join('');
  $('#tabs').innerHTML = PAGES.filter((p) => !p.sideOnly).map((p) => `
    <a class="tab ${p.id === r ? 'active' : ''}" href="#/${p.id}">${icon(p.icon)}<span>${p.tab || p.label}</span></a>`).join('');
}

/* =========================================================
   Views
   ========================================================= */
const views = {};

function tileHtml({ action, color, ic, title, sub }) {
  return `<button class="tile c-${color}" data-action="${action}">
    <span class="ibox">${icon(ic)}</span>
    <span><b>${title}</b><small>${sub}</small></span>
    ${icon('chevron', 'chev')}
  </button>`;
}

function securityLabel() {
  return { away: 'Armed (Away)', home: 'Armed (Home)', off: 'Disarmed' }[state.security.mode];
}

function activityRows(items) {
  if (!items.length) return '<p class="muted">Nothing yet.</p>';
  return items.map((a) => `
    <div class="row c-${a.color}">
      <span class="ibox">${icon(a.icon)}</span>
      <span><b>${esc(a.text)}</b><small>${ago(a.ts)}</small></span>
    </div>`).join('');
}

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
      <a class="link" href="#/weather" data-action="weather-week">${icon('chevron')}</a></div>
    <div class="weather-now">
      <div class="big-ico ${weather.isDay ? '' : 'night'}">${icon(w.icon)}</div>
      <div><div class="temp">${Math.round(weather.temp)}°${u}</div><div class="cond">${w.label}</div></div>
      <div class="hl">H: ${Math.round(weather.hi)}° &nbsp; L: ${Math.round(weather.lo)}°<br>${esc(state.settings.place.name)}</div>
    </div>
    <div class="hourly">
      <div class="hour now">${icon(w.icon)}<small>Now</small><b>${Math.round(weather.temp)}°</b></div>
      ${hours}
    </div>
  </div>`;
}

/* Demo energy curve: deterministic per day so it doesn't jump on refresh. */
function energyHours(dayOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() - dayOffset);
  let seed = d.getFullYear() * 400 + d.getMonth() * 31 + d.getDate();
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  return Array.from({ length: 24 }, (_, h) => {
    const base = h < 6 ? 0.25 : h < 9 ? 0.55 : h < 17 ? 0.4 : h < 22 ? 0.95 : 0.45;
    return +(base * (0.75 + rnd() * 0.5)).toFixed(2);
  });
}

function energyCard(extraClass = 'a-energy') {
  const nowH = new Date().getHours();
  const today = energyHours(0);
  const used = today.slice(0, nowH + 1).reduce((a, b) => a + b, 0);
  const yest = energyHours(1).slice(0, nowH + 1).reduce((a, b) => a + b, 0);
  const pct = Math.round(((used - yest) / yest) * 100);
  const max = Math.max(...today);
  const bars = today.map((v, h) => `<i class="${h > nowH ? 'future' : ''}" style="height:${(v / max) * 100}%"></i>`).join('');
  return `<div class="card ${extraClass}">
    <div class="card-head">${icon('chart')}<h2>Energy Usage</h2><a class="link" href="#/energy">View details ${icon('arrowRight')}</a></div>
    <div class="energy">
      <div class="energy-total">
        <div class="val">${used.toFixed(1)} <span>kWh</span></div>
        <small>Today</small>
        <span class="trend"><b class="${pct > 0 ? 'up' : ''}">${icon(pct > 0 ? 'arrowUp' : 'arrowDown')}${Math.abs(pct)}%</b> vs. yesterday</span>
      </div>
      <div class="bars">
        <div class="bars-plot">${bars}</div>
        <div class="bars-axis"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>12 AM</span></div>
      </div>
    </div>
  </div>`;
}

function roomCard(r) {
  const devs = state.devices.filter((d) => d.room === r.id);
  const types = [...new Set(devs.map((d) => ({ light: 'Lights', tv: 'TV', fan: 'Fan' }[d.type] || d.name)))];
  const on = devs.filter((d) => d.type === 'light' && d.on).length;
  return `<a class="room" href="#/devices?room=${r.id}">
    <div class="room-head"><span class="ibox">${icon(r.icon)}</span>
      <span style="min-width:0"><b>${r.name}</b><small>${types.slice(0, 3).join(' · ')}</small></span>${icon('chevron', 'chev')}</div>
    <div class="room-art ${r.art}">${icon(r.icon)}</div>
    <div class="room-foot"><span class="dot"></span>${on ? `${on} light${on > 1 ? 's' : ''} on` : 'All good'}</div>
  </a>`;
}

views.home = () => `
  <div class="grid-overview">
    <div class="card a-status">
      <div class="card-head">${icon('home')}<div><h2>Home Status</h2><div class="sub"><span class="dot"></span>All systems running</div></div></div>
      <div class="tiles">
        ${tileHtml({ action: 'go-lights', color: 'amber', ic: 'bulb', title: 'Lights', sub: `${lightsOn()} / ${lightsTotal()} on` })}
        ${tileHtml({ action: 'thermostat', color: 'blue', ic: 'thermo', title: 'Thermostat', sub: `${state.thermostat.target}°` })}
        ${tileHtml({ action: 'go-security', color: 'green', ic: state.security.mode === 'off' ? 'shieldOff' : 'shieldCheck', title: 'Security', sub: securityLabel() })}
        ${tileHtml({ action: 'garage', color: 'purple', ic: 'garage', title: 'Garage', sub: state.garage.open ? 'Open' : 'Closed' })}
      </div>
    </div>
    ${weatherCard()}
    <div class="card a-activity">
      <div class="card-head">${icon('clock')}<h2>Recent Activity</h2><a class="link" href="#/activity" data-action="all-activity">View all ${icon('arrowRight')}</a></div>
      <div class="list">${activityRows(state.activity.slice(0, 5))}</div>
    </div>
    <div class="card a-actions">
      <div class="card-head">${icon('zap')}<h2>Quick Actions</h2></div>
      <div class="actions">
        <button class="action c-amber" data-action="all-lights"><span class="ibox">${icon('bulb')}</span>${lightsOn() ? 'Turn off all lights' : 'Turn on all lights'}</button>
        <button class="action c-blue" data-action="thermostat"><span class="ibox">${icon('thermo')}</span>Set temperature</button>
        <button class="action c-green" data-action="toggle-arm"><span class="ibox">${icon('shieldCheck')}</span>${state.security.mode === 'off' ? 'Arm security' : 'Disarm security'}</button>
        <button class="action c-purple" data-action="garage"><span class="ibox">${icon('garage')}</span>${state.garage.open ? 'Close garage' : 'Open garage'}</button>
      </div>
    </div>
    ${energyCard()}
    <div class="card a-rooms">
      <div class="card-head">${icon('home')}<h2>My Home</h2><a class="link" href="#/devices">View all devices ${icon('arrowRight')}</a></div>
      <div class="rooms">${ROOMS.slice(0, 4).map(roomCard).join('')}</div>
    </div>
  </div>
  <p class="demo-note">Smart home panels are showing demo data until a hub is connected. Weather is live.</p>`;

function deviceIcon(d) {
  return { light: 'bulb', tv: 'tv', fan: 'fan', plug: 'plug' }[d.type] || 'plug';
}

views.devices = () => {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const only = q.get('room');
  const rooms = only ? ROOMS.filter((r) => r.id === only) : ROOMS;
  return `
    <div class="section-title">${only ? `<a class="btn ghost" href="#/devices">${icon('chevronLeft')} All rooms</a>` : ''}
      Devices<span class="spacer"></span>
      <button class="btn ghost" data-action="all-lights">${icon('power')} ${lightsOn() ? 'All lights off' : 'All lights on'}</button></div>
    <div class="page-grid">
      ${rooms.map((r) => `
        <div class="card">
          <div class="card-head">${icon(r.icon)}<h2>${r.name}</h2></div>
          ${state.devices.filter((d) => d.room === r.id).map((d) => `
            <div class="device ${d.on ? 'on' : ''}">
              <span class="ibox">${icon(deviceIcon(d))}</span>
              <span><b>${esc(d.name)}</b><small>${d.on ? 'On' : 'Off'}</small></span>
              <span class="ctl">${d.locked ? '<small class="muted">Always on</small>'
                : `<button class="switch" role="switch" aria-checked="${d.on}" aria-label="${esc(d.name)}" data-action="toggle-device" data-id="${d.id}"></button>`}</span>
            </div>`).join('')}
        </div>`).join('')}
      ${!only || only === 'living' ? `
        <div class="card">
          <div class="card-head">${icon('thermo')}<h2>Thermostat</h2></div>
          ${thermoHtml()}
        </div>` : ''}
    </div>`;
};

function thermoHtml() {
  const t = state.thermostat;
  return `<div class="thermo">
      <button class="btn-round" data-action="temp" data-d="-1" aria-label="Lower">${icon('minus')}</button>
      <div class="t">${t.target}°</div>
      <button class="btn-round" data-action="temp" data-d="1" aria-label="Raise">${icon('plus')}</button>
    </div>
    <div style="text-align:center"><div class="seg">
      ${['heat', 'cool', 'auto', 'off'].map((m) => `<button class="${t.mode === m ? 'on' : ''}" data-action="thermo-mode" data-m="${m}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}
    </div></div>`;
}

views.automations = () => `
  <div class="section-title">Automations</div>
  <div class="card" style="max-width:820px">
    ${state.automations.map((a) => `
      <div class="device ${a.on ? 'on' : ''}">
        <span class="ibox">${icon(a.icon)}</span>
        <span><b>${esc(a.name)}</b><small>${esc(a.desc)}</small></span>
        <span class="ctl"><button class="switch" role="switch" aria-checked="${a.on}" data-action="toggle-auto" data-id="${a.id}" aria-label="${esc(a.name)}"></button></span>
      </div>`).join('')}
    <p class="hint" style="margin-top:14px">These are examples. Once a hub like Home Assistant is connected, your real automations will show up here.</p>
  </div>`;

views.energy = () => {
  const days = Array.from({ length: 7 }, (_, i) => 6 - i).map((off) => {
    const d = new Date(); d.setDate(d.getDate() - off);
    const hrs = energyHours(off);
    const total = off === 0 ? hrs.slice(0, new Date().getHours() + 1).reduce((a, b) => a + b, 0) : hrs.reduce((a, b) => a + b, 0);
    return { label: d.toLocaleDateString([], { weekday: 'short' }), total };
  });
  const max = Math.max(...days.map((d) => d.total));
  const week = days.reduce((a, d) => a + d.total, 0);
  return `
    <div class="section-title">Energy</div>
    <div class="page-grid" style="grid-template-columns:1fr">
      ${energyCard('')}
      <div class="card">
        <div class="card-head">${icon('calendar')}<h2>Last 7 days</h2><span class="link">${week.toFixed(1)} kWh total</span></div>
        <div class="bars" style="border:0;padding:0">
          <div class="bars-plot" style="min-height:180px;gap:18px">${days.map((d) => `<i style="height:${(d.total / max) * 100}%"></i>`).join('')}</div>
          <div class="bars-axis" style="justify-content:space-around">${days.map((d) => `<span>${d.label}<br><b style="color:var(--text)">${d.total.toFixed(1)}</b></span>`).join('')}</div>
        </div>
      </div>
    </div>
    <p class="demo-note">Demo data. Connect a smart meter or hub to see real usage.</p>`;
};

views.security = () => `
  <div class="section-title">Security</div>
  <div class="page-grid">
    <div class="card" style="grid-column:1/-1">
      <div class="card-head">${icon('shield')}<h2>Alarm</h2><span class="link">${securityLabel()}</span></div>
      <div class="big-mode">
        ${[['off', 'Disarmed', 'shieldOff'], ['home', 'Home', 'home'], ['away', 'Away', 'shieldCheck']].map(([m, l, ic]) => `
          <button class="mode ${state.security.mode === m ? 'on' : ''}" data-action="sec-mode" data-m="${m}">${icon(ic)}${l}</button>`).join('')}
      </div>
    </div>
    <div class="card">
      <div class="card-head">${icon('lock')}<h2>Locks</h2></div>
      ${state.locks.map((l) => `
        <div class="device ${l.locked ? '' : 'on'}">
          <span class="ibox">${icon(l.locked ? 'lock' : 'unlock')}</span>
          <span><b>${esc(l.name)}</b><small>${l.locked ? 'Locked' : 'Unlocked'}</small></span>
          <span class="ctl"><button class="btn ${l.locked ? 'ghost' : ''}" data-action="toggle-lock" data-id="${l.id}">${l.locked ? 'Unlock' : 'Lock'}</button></span>
        </div>`).join('')}
    </div>
    <div class="card">
      <div class="card-head">${icon('garage')}<h2>Garage</h2></div>
      <div class="device ${state.garage.open ? 'on' : ''}">
        <span class="ibox">${icon('garage')}</span>
        <span><b>Garage door</b><small>${state.garage.open ? 'Open' : 'Closed'}</small></span>
        <span class="ctl"><button class="btn" data-action="garage">${state.garage.open ? 'Close' : 'Open'}</button></span>
      </div>
    </div>
  </div>
  <p class="demo-note">Demo data. Real locks and alarm need a connected hub.</p>`;

let calCursor = new Date();
let calSelected = null;
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

views.calendar = () => {
  const y = calCursor.getFullYear();
  const m = calCursor.getMonth();
  const first = new Date(y, m, 1);
  const start = new Date(y, m, 1 - first.getDay());
  const todayIso = isoDay(new Date());
  const sel = calSelected || todayIso;
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const iso = isoDay(d);
    const n = state.events.filter((e) => e.date === iso).length;
    return `<button class="day ${d.getMonth() !== m ? 'other' : ''} ${iso === todayIso ? 'today' : ''} ${iso === sel ? 'sel' : ''}" data-action="cal-pick" data-d="${iso}">
      ${d.getDate()}<span class="pips">${'<i></i>'.repeat(Math.min(n, 4))}</span></button>`;
  }).join('');
  const dayEvents = state.events.filter((e) => e.date === sel).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const upcoming = state.events.filter((e) => e.date >= todayIso).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))).slice(0, 6);
  const selDate = new Date(`${sel}T12:00:00`);
  return `
    <div class="section-title">Calendar</div>
    <div class="page-grid" style="grid-template-columns:2fr 1fr">
      <div class="card">
        <div class="card-head">
          <button class="btn-round" data-action="cal-move" data-d="-1" aria-label="Previous month">${icon('chevronLeft')}</button>
          <h2 style="flex:1;text-align:center">${first.toLocaleDateString([], { month: 'long', year: 'numeric' })}</h2>
          <button class="btn-round" data-action="cal-move" data-d="1" aria-label="Next month">${icon('chevron')}</button>
        </div>
        <div class="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="dow">${d}</div>`).join('')}${cells}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="card">
          <div class="card-head">${icon('calendar')}<h2>${selDate.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</h2></div>
          <div class="list">${dayEvents.map(eventRow).join('') || '<p class="muted">No events.</p>'}</div>
          <button class="btn" style="margin-top:14px" data-action="add-event" data-d="${sel}">${icon('plus')} Add event</button>
        </div>
        <div class="card">
          <div class="card-head">${icon('clock')}<h2>Upcoming</h2></div>
          <div class="list">${upcoming.map((e) => eventRow(e, true)).join('') || '<p class="muted">Nothing coming up.</p>'}</div>
        </div>
      </div>
    </div>`;
};

function eventRow(e, withDate = false) {
  const d = new Date(`${e.date}T${e.time || '12:00'}`);
  const when = [withDate ? d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : '', e.time ? fmtTime(d) : 'All day'].filter(Boolean).join(' · ');
  return `<div class="row c-purple"><span class="ibox">${icon('calendar')}</span>
    <span><b>${esc(e.title)}</b><small>${when}</small></span>
    <button class="btn-round" style="margin-left:auto" data-action="del-event" data-id="${e.id}" aria-label="Delete">${icon('trash')}</button></div>`;
}

views.notes = () => `
  <div class="section-title">Notes</div>
  <div class="notes">
    <button class="note note-new" data-action="add-note">${icon('plus')}New note</button>
    ${state.notes.map((n) => `
      <div class="note n-${n.color}">
        <p>${esc(n.text)}</p>
        <footer>${ago(n.ts)}<button data-action="del-note" data-id="${n.id}" aria-label="Delete note">${icon('trash')}</button></footer>
      </div>`).join('')}
  </div>`;

views.settings = () => {
  const s = state.settings;
  return `
  <div class="section-title">Settings</div>
  <div class="page-grid" style="grid-template-columns:repeat(auto-fill,minmax(380px,1fr))">
    <div class="card">
      <div class="card-head">${icon('home')}<h2>Household</h2></div>
      <div class="field"><label for="set-name">Name in the greeting</label>
        <input class="input" id="set-name" value="${esc(s.name)}" placeholder="e.g. Truong, or The Vu family"></div>
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
      <div class="card-head">${icon('sparkles')}<h2>About</h2></div>
      <p class="hint">Everything you change here (notes, events, settings) is saved on this device only. Smart-home controls are demo data until a hub such as Home Assistant is connected.</p>
      <button class="btn danger" data-action="reset">${icon('trash')} Reset demo data</button>
    </div>
  </div>`;
};

function renderView() {
  const r = currentRoute();
  const view = $('#view');
  const y = window.scrollY;
  view.innerHTML = views[r]();
  window.scrollTo(0, y);
}

function render() {
  renderNav();
  renderView();
}

/* =========================================================
   Sheets (modal dialogs)
   ========================================================= */
function openSheet(html) {
  $('#sheet').innerHTML = html;
  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
  const first = $('#sheet').querySelector('input, textarea');
  if (first) setTimeout(() => first.focus(), 50);
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
}
const sheetHead = (title, ic) => `<h3>${icon(ic)}${title}<button class="btn-round close" data-action="close-sheet" aria-label="Close">${icon('x')}</button></h3>`;

function openThermostat() {
  openSheet(`${sheetHead('Thermostat', 'thermo')}<div id="thermo-body">${thermoHtml()}</div>`);
}

function openWeek() {
  if (!weatherValid()) return;
  openSheet(`${sheetHead(`7-day forecast · ${esc(state.settings.place.name)}`, 'sun')}
    <div class="list">${weather.days.map((d) => {
      const w = wmo(d.code, 1);
      const label = new Date(`${d.date}T12:00`).toLocaleDateString([], { weekday: 'long' });
      return `<div class="row"><span class="ibox" style="background:var(--amber-bg);color:var(--amber-fg)">${icon(w.icon)}</span>
        <span><b>${label}</b><small>${w.label}</small></span>
        <span style="margin-left:auto;font-weight:600">${Math.round(d.hi)}° <span class="muted">${Math.round(d.lo)}°</span></span></div>`;
    }).join('')}</div>`);
}

function openAllActivity() {
  state.seenActivity = Date.now();
  save();
  updateBadge();
  openSheet(`${sheetHead('All activity', 'clock')}<div class="list">${activityRows(state.activity)}</div>`);
}

function openAddNote() {
  const colors = ['yellow', 'pink', 'blue', 'green', 'purple'];
  openSheet(`${sheetHead('New note', 'notes')}
    <div class="field"><textarea class="input" id="note-text" rows="5" placeholder="Shopping list, reminder, message for the family…"></textarea></div>
    <div class="field"><label>Color</label><div class="chips">${colors.map((c, i) => `
      <button class="chip n-${c}" data-action="note-color" data-c="${c}" style="width:44px;height:44px;border-radius:50%;${i === 0 ? 'outline:2px solid var(--accent)' : ''}" aria-label="${c}"></button>`).join('')}</div></div>
    <div class="sheet-actions"><button class="btn ghost" data-action="close-sheet">Cancel</button><button class="btn" data-action="save-note" data-c="yellow">Save note</button></div>`);
}

function openAddEvent(date) {
  openSheet(`${sheetHead('New event', 'calendar')}
    <div class="field"><label for="ev-title">Title</label><input class="input" id="ev-title" placeholder="e.g. Soccer practice"></div>
    <div style="display:flex;gap:12px">
      <div class="field" style="flex:1"><label for="ev-date">Date</label><input class="input" type="date" id="ev-date" value="${date}"></div>
      <div class="field" style="flex:1"><label for="ev-time">Time (optional)</label><input class="input" type="time" id="ev-time"></div>
    </div>
    <div class="sheet-actions"><button class="btn ghost" data-action="close-sheet">Cancel</button><button class="btn" data-action="save-event">Add event</button></div>`);
}

/* =========================================================
   Actions
   ========================================================= */
const actions = {
  'go-lights': () => { location.hash = '#/devices'; },
  'go-security': () => { location.hash = '#/security'; },
  thermostat: openThermostat,
  'weather-week': (el, e) => { e.preventDefault(); openWeek(); },
  'all-activity': (el, e) => { e.preventDefault(); openAllActivity(); },
  'close-sheet': closeSheet,

  'all-lights': () => {
    const turnOn = lightsOn() === 0;
    state.devices.forEach((d) => { if (d.type === 'light') d.on = turnOn; });
    log(turnOn ? 'All lights turned on' : 'All lights turned off', 'bulb', 'amber');
    toast(turnOn ? 'All lights on' : 'All lights off');
  },
  'toggle-device': (el) => {
    const d = state.devices.find((x) => x.id === el.dataset.id);
    d.on = !d.on;
    log(`${roomOf(d.room).name} ${d.name.toLowerCase()} turned ${d.on ? 'on' : 'off'}`, deviceIcon(d), 'amber');
  },
  temp: (el) => {
    const t = state.thermostat;
    t.target = Math.min(85, Math.max(55, t.target + Number(el.dataset.d)));
    clearTimeout(actions.temp.t);
    actions.temp.t = setTimeout(() => log(`Temperature changed to ${t.target}°`, 'thermo', 'blue'), 1200);
    save();
    const body = $('#thermo-body');
    if (body) body.innerHTML = thermoHtml();
  },
  'thermo-mode': (el) => {
    state.thermostat.mode = el.dataset.m;
    log(`Thermostat set to ${el.dataset.m}`, 'thermo', 'blue');
    const body = $('#thermo-body');
    if (body) body.innerHTML = thermoHtml();
  },
  'toggle-arm': () => {
    state.security.mode = state.security.mode === 'off' ? 'away' : 'off';
    log(state.security.mode === 'off' ? 'Security disarmed' : 'Security armed (Away)', 'shieldCheck', 'green');
    toast(securityLabel());
  },
  'sec-mode': (el) => {
    state.security.mode = el.dataset.m;
    log(`Security set to ${securityLabel().toLowerCase()}`, 'shieldCheck', 'green');
  },
  'toggle-lock': (el) => {
    const l = state.locks.find((x) => x.id === el.dataset.id);
    l.locked = !l.locked;
    log(`${l.name} ${l.locked ? 'locked' : 'unlocked'}`, l.locked ? 'lock' : 'unlock', 'blue');
  },
  garage: () => {
    state.garage.open = !state.garage.open;
    log(`Garage door ${state.garage.open ? 'opened' : 'closed'}`, 'garage', 'purple');
    toast(`Garage ${state.garage.open ? 'opening' : 'closing'}`);
  },
  'toggle-auto': (el) => {
    const a = state.automations.find((x) => x.id === el.dataset.id);
    a.on = !a.on;
    save();
  },

  'add-note': openAddNote,
  'note-color': (el) => {
    $('#sheet').querySelectorAll('[data-action="note-color"]').forEach((b) => { b.style.outline = ''; });
    el.style.outline = '2px solid var(--accent)';
    $('#sheet [data-action="save-note"]').dataset.c = el.dataset.c;
  },
  'save-note': (el) => {
    const text = $('#note-text').value.trim();
    if (!text) return;
    state.notes.unshift({ id: `n${Date.now()}`, text, color: el.dataset.c, ts: Date.now() });
    log('New note added', 'notes', 'amber');
    closeSheet();
  },
  'del-note': (el) => {
    state.notes = state.notes.filter((n) => n.id !== el.dataset.id);
    save();
  },

  'cal-move': (el) => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + Number(el.dataset.d), 1); },
  'cal-pick': (el) => { calSelected = el.dataset.d; },
  'add-event': (el) => openAddEvent(el.dataset.d),
  'save-event': () => {
    const title = $('#ev-title').value.trim();
    const date = $('#ev-date').value;
    if (!title || !date) return;
    state.events.push({ id: `e${Date.now()}`, title, date, time: $('#ev-time').value || '' });
    calSelected = date;
    log(`Event added: ${title}`, 'calendar', 'purple');
    closeSheet();
  },
  'del-event': (el) => {
    state.events = state.events.filter((e) => e.id !== el.dataset.id);
    save();
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
  reset: () => {
    if (!confirm('Reset all notes, events and demo devices on this device?')) return;
    state = defaultState();
    save();
    applyTheme();
    fetchWeather();
  },
};

// Actions that only touch a sheet or navigate don't need a full re-render.
const NO_RERENDER = new Set(['go-lights', 'go-security', 'thermostat', 'weather-week', 'all-activity', 'add-note', 'note-color', 'add-event', 'place-search', 'temp', 'thermo-mode']);

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const name = el.dataset.action;
  const fn = actions[name];
  if (!fn) return;
  fn(el, e);
  save();
  if (!NO_RERENDER.has(name)) renderView();
  else if (name === 'temp' || name === 'thermo-mode') {
    if (currentRoute() !== 'home' || $('#sheet').hidden) renderView();
  }
});

$('#sheet-backdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

// The thermostat sheet edits state live; refresh the page behind it when it closes.
const sheetObserver = new MutationObserver(() => { if ($('#sheet').hidden) renderView(); });
sheetObserver.observe($('#sheet'), { attributes: true, attributeFilter: ['hidden'] });

// Settings: name field saves as you type.
document.addEventListener('input', (e) => {
  if (e.target.id === 'set-name') {
    state.settings.name = e.target.value;
    save();
    tickClock();
  }
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
   Search & notifications
   ========================================================= */
const searchInput = $('#search');
const searchOut = $('#search-results');

function runSearch() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) { searchOut.hidden = true; return; }
  const hits = [];
  PAGES.forEach((p) => { if (p.label.toLowerCase().includes(q)) hits.push({ ic: p.icon, label: p.label, meta: 'Page', href: `#/${p.id}` }); });
  ROOMS.forEach((r) => { if (r.name.toLowerCase().includes(q)) hits.push({ ic: r.icon, label: r.name, meta: 'Room', href: `#/devices?room=${r.id}` }); });
  state.devices.forEach((d) => {
    const room = roomOf(d.room).name;
    if (`${room} ${d.name} ${d.type}`.toLowerCase().includes(q)) hits.push({ ic: deviceIcon(d), label: `${d.name}`, meta: `${room} · ${d.on ? 'On' : 'Off'}`, href: `#/devices?room=${d.room}` });
  });
  state.notes.forEach((n) => { if (n.text.toLowerCase().includes(q)) hits.push({ ic: 'notes', label: n.text.slice(0, 60), meta: 'Note', href: '#/notes' }); });
  state.events.forEach((ev) => { if (ev.title.toLowerCase().includes(q)) hits.push({ ic: 'calendar', label: ev.title, meta: ev.date, href: '#/calendar' }); });
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
  if (!e.target.closest('#bell, #bell-pop')) $('#bell-pop').hidden = true;
});

function updateBadge() {
  const unseen = state.activity.some((a) => a.ts > (state.seenActivity || 0));
  $('#bell-badge').hidden = !unseen;
}
$('#bell').addEventListener('click', () => {
  const pop = $('#bell-pop');
  if (!pop.hidden) { pop.hidden = true; return; }
  pop.innerHTML = `<h4>Notifications</h4><div class="list">${activityRows(state.activity.slice(0, 6))}</div>`;
  pop.hidden = false;
  state.seenActivity = Date.now();
  save();
  updateBadge();
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
render();
renderSideWeather();
updateBadge();
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
