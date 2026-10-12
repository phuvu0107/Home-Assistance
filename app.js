import { icon, hydrateIcons } from './icons.js';

/* =========================================================
   State (saved in this browser's localStorage)
   ========================================================= */
const STORE_KEY = 'home-dashboard.v1';
const WEATHER_KEY = 'home-dashboard.weather.v1';

const minutesAgo = (m) => Date.now() - m * 60000;
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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
    notes: [
      { id: 'n1', text: 'Buy milk, eggs, and spinach 🥬', color: 'yellow', ts: minutesAgo(90) },
      { id: 'n2', text: 'Dentist on Thursday 4:30 PM', color: 'blue', ts: minutesAgo(300) },
    ],
    events: [
      { id: 'e1', title: 'Soccer practice', date: isoDay(new Date()), time: '17:30' },
      { id: 'e2', title: 'Dentist', date: isoDay(new Date(Date.now() + 3 * 864e5)), time: '16:30' },
    ],
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
  if (currentRoute() === 'home') renderView();
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
  { id: 'notes', label: 'Notes', icon: 'notes' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

const currentRoute = () => {
  const r = location.hash.replace(/^#\/?/, '').split('?')[0];
  return PAGES.some((p) => p.id === r) ? r : 'home';
};

function renderNav() {
  const r = currentRoute();
  $('#tabs').innerHTML = PAGES.map((p) => `
    <a class="tab ${p.id === r ? 'active' : ''}" href="#/${p.id}">${icon(p.icon)}<span>${p.label}</span></a>`).join('');
}

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

function upcomingEvents(limit) {
  const todayIso = isoDay(new Date());
  return state.events
    .filter((e) => e.date >= todayIso)
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))
    .slice(0, limit);
}

function dayLabel(iso) {
  if (iso === isoDay(new Date())) return 'Today';
  if (iso === isoDay(new Date(Date.now() + 864e5))) return 'Tomorrow';
  return new Date(`${iso}T12:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function weekStrip() {
  return `<div class="week">${weather.days.map((d, i) => {
    const w = wmo(d.code, 1);
    const label = i === 0 ? 'Today' : new Date(`${d.date}T12:00`).toLocaleDateString([], { weekday: 'short' });
    return `<div class="wday"><small>${label}</small>${icon(w.icon, w.icon === 'sun' ? 'sun' : '')}<b>${Math.round(d.hi)}°</b><span class="muted">${Math.round(d.lo)}°</span></div>`;
  }).join('')}</div>`;
}

views.home = () => `
  <div class="grid-home">
    ${weatherCard()}
    <div class="card a-agenda">
      <div class="card-head">${icon('calendar')}<h2>Coming up</h2><a class="link" href="#/calendar">Calendar ${icon('arrowRight')}</a></div>
      <div class="list">${upcomingEvents(5).map((e) => eventRow(e, true)).join('') || '<p class="muted">Nothing on the calendar yet.</p>'}</div>
      <button class="btn ghost add-btn" data-action="add-event" data-d="${isoDay(new Date())}">${icon('plus')} Add event</button>
    </div>
    <div class="card a-notes">
      <div class="card-head">${icon('notes')}<h2>Notes</h2><a class="link" href="#/notes">All notes ${icon('arrowRight')}</a></div>
      <div class="notes notes-mini">
        <button class="note note-new" data-action="add-note">${icon('plus')}New note</button>
        ${state.notes.slice(0, 3).map(noteHtml).join('')}
      </div>
    </div>
  </div>`;

let calCursor = new Date();
let calSelected = null;

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
  const when = [withDate ? dayLabel(e.date) : '', e.time ? fmtTime(d) : 'All day'].filter(Boolean).join(' · ');
  return `<div class="row c-purple"><span class="ibox">${icon('calendar')}</span>
    <span><b>${esc(e.title)}</b><small>${when}</small></span>
    <button class="btn-round" style="margin-left:auto" data-action="del-event" data-id="${e.id}" aria-label="Delete">${icon('trash')}</button></div>`;
}

views.notes = () => `
  <div class="section-title">Notes</div>
  <div class="notes">
    <button class="note note-new" data-action="add-note">${icon('plus')}New note</button>
    ${state.notes.map(noteHtml).join('')}
  </div>`;

function noteHtml(n) {
  return `<div class="note n-${n.color}">
    <p>${esc(n.text)}</p>
    <footer>${ago(n.ts)}<button data-action="del-note" data-id="${n.id}" aria-label="Delete note">${icon('trash')}</button></footer>
  </div>`;
}

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
      <p class="hint">Notes, events and settings are saved on this device only. Weather comes from Open-Meteo.</p>
      <button class="btn danger" data-action="reset">${icon('trash')} Clear notes and events</button>
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
  'close-sheet': closeSheet,

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
    if (!confirm('Clear all notes and events on this device?')) return;
    state = { ...defaultState(), settings: state.settings, notes: [], events: [] };
    save();
    applyTheme();
    fetchWeather();
  },
};

// Actions that only touch a sheet or navigate don't need a full re-render.
const NO_RERENDER = new Set(['add-note', 'note-color', 'add-event', 'place-search']);

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const name = el.dataset.action;
  const fn = actions[name];
  if (!fn) return;
  fn(el, e);
  save();
  if (!NO_RERENDER.has(name)) renderView();
});

$('#sheet-backdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

// Refresh the page behind a sheet when it closes, so a saved note or event shows up.
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
   Search
   ========================================================= */
const searchInput = $('#search');
const searchOut = $('#search-results');

function runSearch() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) { searchOut.hidden = true; return; }
  const hits = [];
  PAGES.forEach((p) => { if (p.label.toLowerCase().includes(q)) hits.push({ ic: p.icon, label: p.label, meta: 'Page', href: `#/${p.id}` }); });
  state.notes.forEach((n) => { if (n.text.toLowerCase().includes(q)) hits.push({ ic: 'notes', label: n.text.slice(0, 60), meta: 'Note', href: '#/notes' }); });
  state.events.forEach((ev) => { if (ev.title.toLowerCase().includes(q)) hits.push({ ic: 'calendar', label: ev.title, meta: dayLabel(ev.date), href: '#/calendar' }); });
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
