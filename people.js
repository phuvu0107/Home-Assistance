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
