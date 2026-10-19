// The people in a household, and the money between them.
//
// Each household names its own people. They live in state.members and sync to every device as
// p: items, so nothing about who lives here is written into the app. Kept free of the page so the
// rules can be tested on their own (tests/people.test.mjs).

// Colors a person can have; each is one of the c-* color families in styles.css. Purple is left
// for things everyone shares.
export const PERSON_COLORS = ['blue', 'rose', 'green', 'amber'];
export const MAX_MEMBERS = 6;
export const NAME_MAX = 24;

// Phu and Nhi's household was set up before people were data. Its items already point at these
// ids, so a household that uses them gets them back as its members, with their own avatars.
export const LEGACY_MEMBERS = [
  { id: 'phu', name: 'Phu', color: 'blue', avatar: 'avatars/phu.svg', order: 0 },
  { id: 'nhi', name: 'Nhi', color: 'rose', avatar: 'avatars/nhi.svg', order: 1 },
];

// Names go straight into the page in many places, so characters that mean something in HTML are
// left out (an apostrophe is fine). Applied when a name is typed and again when one is read.
export const cleanName = (s) => String(s || '').replace(/[<>&"`]/g, '').trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);

// Members as the page uses them: in order, and with only values that are safe to put in the page
// (a synced record could come from anywhere).
export const sortMembers = (list) => [...(list || [])].filter((u) => /^[a-z0-9]+$/i.test(u?.id) && u.id !== 'both')
  .map((u) => ({ ...u, name: cleanName(u.name) || '?', color: PERSON_COLORS.includes(u.color) ? u.color : 'blue',
    avatar: /^avatars\/[a-z0-9-]+\.svg$/.test(u.avatar || '') ? u.avatar : '' }))
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)));

// Every person id anything in the household points at.
function referencedIds(state) {
  const ids = new Set([...Object.keys(state.stars || {}), ...Object.keys(state.health || {}), state.settings?.me, state.settings?.lastWriter]);
  const add = (...v) => v.forEach((x) => ids.add(x));
  (state.tasks || []).forEach((t) => add(t.who));
  (state.events || []).forEach((e) => add(e.who));
  (state.expenses || []).forEach((x) => add(x.paidBy, x.to));
  (state.log || []).forEach((l) => add(l.who));
  (state.thanks || []).forEach((k) => add(k.from, k.to));
  (state.notes || []).forEach((n) => add(n.by));
  (state.bucket || []).forEach((b) => add(b.by, b.from, b.doneBy));
  return ids;
}

// The members a household with none yet should get: Phu and Nhi when its data already points at
// them, otherwise null (a new household names its own people).
export function legacyMembersFor(state) {
  if ((state.members || []).length) return null;
  const ids = referencedIds(state);
  return LEGACY_MEMBERS.some((u) => ids.has(u.id)) ? LEGACY_MEMBERS.map((u) => ({ ...u })) : null;
}

// A new person: the first color nobody has yet, placed after everyone else.
export function newMember(name, members, now = Date.now()) {
  const used = new Set(members.map((u) => u.color));
  const color = PERSON_COLORS.find((c) => !used.has(c)) || PERSON_COLORS[members.length % PERSON_COLORS.length];
  const order = members.reduce((n, u) => Math.max(n, (u.order ?? 0) + 1), 0);
  return { id: `m${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: cleanName(name), color, avatar: '', order };
}

// "Phu", "Phu and Nhi", "An, Binh and Chi".
export function joinNames(names) {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/* ---------- Money ---------- */
// Who paid what in a list of expenses, and who owes whom for the shared ones.
// - A split expense is shared evenly by everyone in the household.
// - Paid by 'both' means everyone paid an equal share, so nobody owes on it.
// - A settle-up entry ({ kind: 'settle', paidBy, to, amount }) is money passed between two
//   people, not spending.
// With two people this gives exactly what the app always showed.
export function expenseStats(list, ids) {
  const zero = () => Object.fromEntries(ids.map((id) => [id, 0]));
  const paid = zero(); const balance = zero(); // balance > 0: the household owes this person
  const n = ids.length || 1;
  let total = 0; let shared = 0;
  const spread = (to, who, amount) => {
    const payers = who === 'both' ? ids : [who];
    payers.forEach((id) => { if (id in to) to[id] += amount / payers.length; });
  };
  for (const x of list) {
    if (x.kind === 'settle') {
      if (x.paidBy in balance) balance[x.paidBy] += x.amount;
      if (x.to in balance) balance[x.to] -= x.amount;
      continue;
    }
    total += x.amount; spread(paid, x.paidBy, x.amount);
    if (x.split) {
      shared += x.amount; spread(balance, x.paidBy, x.amount);
      ids.forEach((id) => { balance[id] -= x.amount / n; });
    }
  }
  return { total, paid, shared, each: shared / n, balance, transfers: transfersFor(balance, ids) };
}

// The fewest payments that make everyone square: the one who owes most pays the one owed most,
// and so on. Each payment is rounded to the cent; anything under half a cent is left alone.
export function transfersFor(balance, ids) {
  const rank = (a, b) => b.v - a.v || ids.indexOf(a.id) - ids.indexOf(b.id);
  const owed = ids.map((id) => ({ id, v: balance[id] || 0 })).filter((p) => p.v >= 0.005).sort(rank);
  const owes = ids.map((id) => ({ id, v: -(balance[id] || 0) })).filter((p) => p.v >= 0.005).sort(rank);
  const out = [];
  let i = 0; let j = 0;
  while (i < owes.length && j < owed.length) {
    const v = Math.min(owes[i].v, owed[j].v);
    if (v >= 0.005) out.push({ from: owes[i].id, to: owed[j].id, amount: Math.round(v * 100) / 100 });
    owes[i].v -= v; owed[j].v -= v;
    if (owes[i].v < 0.005) i++;
    if (owed[j].v < 0.005) j++;
  }
  return out;
}

// Spending month by month, for the `count` months up to and including `last` ('YYYY-MM'),
// oldest first. Months with nothing logged are still there, at zero, so gaps show.
// `places` is where the money went over those months: the biggest totals by name, case ignored.
export function monthTrend(list, ids, last, count = 6) {
  const [y, m] = last.split('-').map(Number);
  const keys = Array.from({ length: count }, (_, i) => {
    const d = new Date(y, m - count + i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const months = keys.map((key) => {
    const st = expenseStats(list.filter((x) => x.date?.startsWith(key)), ids);
    return { key, total: st.total, paid: st.paid, count: list.filter((x) => x.kind !== 'settle' && x.date?.startsWith(key)).length };
  });
  const byName = new Map();
  for (const x of list) {
    if (x.kind === 'settle' || !keys.includes(x.date?.slice(0, 7))) continue;
    const name = String(x.title || '').trim();
    const k = name.toLowerCase();
    const p = byName.get(k) || { name, total: 0, count: 0 };
    p.total += x.amount; p.count += 1;
    byName.set(k, p);
  }
  const places = [...byName.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  // The average leaves out months before anything was logged, so a new household isn't dragged down.
  const from = months.findIndex((mo) => mo.count);
  const used = from < 0 ? [] : months.slice(from);
  const average = used.length ? used.reduce((n, mo) => n + mo.total, 0) / used.length : 0;
  return { months, places, average, max: Math.max(0, ...months.map((mo) => mo.total)) };
}

// General spending categories, in the order the picker shows them. An expense keeps the id in
// `cat`; one without it (logged before categories) or with an id this version doesn't know counts
// as Other.
export const EXPENSE_CATS = {
  groceries: ['🛒', 'Groceries'], dining: ['🍽️', 'Dining out'], transport: ['🚗', 'Transport'],
  bills: ['💡', 'Bills'], home: ['🏠', 'Home'], health: ['💊', 'Health'], shopping: ['🛍️', 'Shopping'],
  fun: ['🎉', 'Fun'], travel: ['✈️', 'Travel'], other: ['📦', 'Other'],
};
export const expenseCat = (x) => (x?.cat && x.cat !== 'other' && EXPENSE_CATS[x.cat] ? x.cat : 'other');

// A first guess from what was typed or the store a receipt came from; the person can change it.
const CAT_WORDS = {
  groceries: 'grocery groceries market supermarket costco safeway trader joe joes foods sprouts aldi kroger hmart walmart produce',
  dining: 'restaurant dinner lunch breakfast brunch cafe coffee starbucks pho boba tea pizza sushi burger taco bar takeout doordash ubereats grubhub chipotle mcdonald bakery',
  bills: 'rent mortgage pg&e pge electric electricity water internet wifi comcast xfinity verizon t-mobile tmobile insurance netflix spotify subscription utility utilities bill',
  transport: 'gas fuel chevron shell arco uber lyft parking toll bart caltrain bus train carwash tesla charging',
  home: 'depot lowes ikea furniture cleaning repair hardware garden plants decor home',
  health: 'pharmacy cvs walgreens doctor dentist clinic hospital medicine gym vitamins health',
  shopping: 'amazon clothes clothing shoes mall gift gifts electronics bestbuy uniqlo',
  fun: 'movie movies cinema concert tickets game games bowling museum fun',
  travel: 'hotel airbnb flight airline airport trip travel vacation',
};
export function guessExpenseCat(title) {
  const text = ` ${String(title || '').toLowerCase().replace(/[^a-z0-9&-]+/g, ' ')} `;
  for (const [cat, words] of Object.entries(CAT_WORDS)) {
    if (words.split(' ').some((w) => text.includes(` ${w} `) || (w.length > 4 && text.includes(` ${w}`)))) return cat;
  }
  return 'other';
}

// Spending by category, biggest first, leaving settle-ups out. Categories with nothing are left off.
export function categoryTotals(list) {
  const by = new Map();
  for (const x of list) {
    if (x.kind === 'settle') continue;
    const id = expenseCat(x);
    const c = by.get(id) || { id, total: 0, count: 0 };
    c.total += x.amount; c.count += 1;
    by.set(id, c);
  }
  return [...by.values()].sort((a, b) => b.total - a.total || Object.keys(EXPENSE_CATS).indexOf(a.id) - Object.keys(EXPENSE_CATS).indexOf(b.id));
}

// Boxes: named pots for a trip or a day out ("Japan Box"), synced as m: items
// { id, name, from?, to? } with optional 'YYYY-MM-DD' days (from without to is a single day). An expense goes in one box by keeping
// its id in `box`; an expense without one is everyday spending, as before boxes.
export const BOX_NAME_MAX = 30;
export const cleanBoxName = (s) => String(s || '').replace(/[<>&"`]/g, '').trim().replace(/\s+/g, ' ').slice(0, BOX_NAME_MAX);
const inBox = (box) => (x) => x.box === box.id && x.kind !== 'settle';
const addDays = (day, n) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

// What went into a box over its whole life, not one month: total, who paid and who owes whom
// for it alone. `last` is the day of its latest expense.
export function boxStats(box, list, ids) {
  const xs = list.filter(inBox(box)).sort((a, b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id)));
  return { ...expenseStats(xs, ids), list: xs, count: xs.length, last: xs[0]?.date || '' };
}

// The boxes the Money page shows for a month ('YYYY-MM'): any with an expense that month, or
// whose days overlap it; a box with no days and nothing in it yet shows in the current month.
// Newest first.
export function boxesForMonth(boxes, list, key, today) {
  const end = `${key}-31`; const start = `${key}-01`;
  return (boxes || []).filter((b) => list.some((x) => inBox(b)(x) && x.date.startsWith(key))
    || (b.from && b.from <= end && (b.to || b.from) >= start)
    || (!b.from && !list.some(inBox(b)) && today.startsWith(key)))
    .sort(newestBox);
}
const newestBox = (a, b) => (b.from || '').localeCompare(a.from || '') || String(b.id).localeCompare(String(a.id), undefined, { numeric: true });

// The boxes an expense on `day` can go in: any without an end day, or that ended no more than
// 60 days before it (receipts come in late). `keep` is the box it's already in, always offered.
export function boxChoices(boxes, day, keep = '') {
  const since = addDays(day, -60);
  return (boxes || []).filter((b) => b.id === keep || !b.to || b.to >= since).sort(newestBox);
}

// The box a new expense on `day` starts in: the one whose days cover it, latest start first.
// Boxes without days are only picked by hand.
export function boxForDay(boxes, day) {
  return (boxes || []).filter((b) => b.from && b.from <= day && (b.to || b.from) >= day).sort(newestBox)[0]?.id || '';
}
