/* When chores come due and which days a repeating event lands on. Pure date logic on 'YYYY-MM-DD'
   strings, so it can be tested without the app. */

const at = (iso) => new Date(`${iso}T12:00`);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plus = (day, n) => { const d = at(day); d.setDate(d.getDate() + n); return iso(d); };
const weekOf = (day) => plus(day, -at(day).getDay()); // the Sunday a week starts on
const daysBetween = (a, b) => Math.round((at(b) - at(a)) / 864e5);

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* A chore's `repeat` stays 'daily', 'weekly' or 'once' so screens on an older version still
   understand it. Extra fields narrow it down:
   - daily + days [2, 4]: only on those weekdays (0 is Sunday)
   - weekly + every 2..4: every few weeks, counted from the week of `from`
   - weekly + every 'month': once a month */
export function choreKind(t) {
  if (t.repeat === 'daily') return t.days?.length ? 'days' : 'daily';
  if (t.repeat === 'weekly') return t.every === 'month' ? 'monthly' : 'weekly';
  return 'once';
}

// The first day of the stretch a chore is done for right now: ticking it on or after this day
// counts. One-off chores have no stretch.
export function periodStart(t, today) {
  switch (choreKind(t)) {
    case 'daily': return today;
    case 'days': {
      for (let i = 0; i < 7; i++) { const d = plus(today, -i); if (t.days.includes(at(d).getDay())) return d; }
      return today;
    }
    case 'weekly': {
      const n = Math.max(1, Math.min(4, Number(t.every) || 1));
      const week = weekOf(today);
      const weeks = Math.floor(daysBetween(weekOf(t.from || week), week) / 7);
      return plus(week, -7 * (((weeks % n) + n) % n));
    }
    case 'monthly': return `${today.slice(0, 7)}-01`;
    default: return null;
  }
}

export function choreDone(t, today) {
  if (!t.doneOn) return false;
  const start = periodStart(t, today);
  return start === null || t.doneOn >= start;
}

// A weekday chore added on a Wednesday for Tuesdays isn't owed until the next Tuesday.
export function choreDue(t, today) {
  return choreKind(t) !== 'days' || !t.from || periodStart(t, today) >= t.from;
}

// The next day a weekday chore comes up, counting today.
export function nextDay(t, today) {
  for (let i = 0; i < 7; i++) { const d = plus(today, i); if (t.days?.includes(at(d).getDay())) return d; }
  return today;
}

export function choreLabel(t) {
  switch (choreKind(t)) {
    case 'days': return [...t.days].sort((a, b) => a - b).map((d) => WEEKDAYS[d]).join(', ');
    case 'weekly': return Number(t.every) > 1 ? `Every ${t.every} weeks` : 'Weekly';
    case 'monthly': return 'Monthly';
    case 'daily': return 'Daily';
    default: return 'Once';
  }
}

// Chores that take turns pass to the next person once the stretch they were done in is over.
// `turned` remembers which tick was already passed on, so every screen moves it just once.
export function passTurn(t, ids, today) {
  if (!t.turns || !t.doneOn || t.turned === t.doneOn || choreDone(t, today) || ids.length < 2) return false;
  const i = ids.indexOf(t.who);
  t.who = ids[(i + 1) % ids.length];
  t.turned = t.doneOn;
  return true;
}

/* The days a new repeating event lands on, from its own date up to `until`. Monthly keeps the
   day of the month (the 31st falls on the last day of shorter months); yearly keeps the date
   (Feb 29 falls on Feb 28). */
export const EVENT_REPEATS = { '': 'Never', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };
export function repeatDates(date, rep, until, max = Infinity) {
  if (!rep) return [date];
  const [y, m, d] = date.split('-').map(Number);
  const out = [];
  for (let i = 0; out.length <= max; i++) {
    let day;
    if (rep === 'daily' || rep === 'weekly') day = plus(date, i * (rep === 'daily' ? 1 : 7));
    else {
      const months = rep === 'monthly' ? m - 1 + i : m - 1 + 12 * i;
      const last = new Date(y, months + 1, 0).getDate();
      day = iso(new Date(y, months, Math.min(d, last), 12));
    }
    if (day > until) break;
    out.push(day);
  }
  return out;
}
export function repeatUntil(date, rep) {
  if (!date || !rep) return '';
  const steps = { daily: 6, weekly: 4, monthly: 11, yearly: 9 }[rep];
  return repeatDates(date, rep, '9999-12-31', steps).at(-1);
}
