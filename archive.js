// Older expenses and events move out of the household's one shared document (which can't grow
// past 1 MiB) into a document of their own per year beside it. The last twelve full months, and
// the month we're in, always stay. Pure date and list logic here; sync.js stores the documents and
// app.js shows archived months read-only when someone goes back to them.

const pad = (n) => String(n).padStart(2, '0');

// The first day that stays in the main document: the 1st of the month a year before this one.
// On 2026-11-09 that is 2025-11-01, so October 2025 and older are archived.
export function archiveCutoff(today) {
  const [y, m] = today.split('-').map(Number);
  return `${y - 1}-${pad(m)}-01`;
}

// What can move, grouped by year: expenses and events dated before the cutoff. An expense in a
// money box stays, because the box adds up all of its expenses together; so does anything with
// no proper date.
export function pickArchivable(state, cutoff) {
  const years = {};
  const add = (kind, x) => { ((years[x.date.slice(0, 4)] ||= { expenses: [], events: [] })[kind]).push(x); };
  const old = (x) => typeof x.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.date < cutoff;
  for (const x of state.expenses || []) if (old(x) && !x.box) add('expenses', x);
  for (const e of state.events || []) if (old(e)) add('events', e);
  return years;
}

// One year's archive with more added to it. The same item arriving twice (two screens archiving at
// the same moment) is kept once.
export function mergeArchive(had, add) {
  const out = {};
  for (const kind of ['expenses', 'events']) {
    const byId = new Map((had?.[kind] || []).map((x) => [x.id, x]));
    for (const x of add?.[kind] || []) byId.set(x.id, x);
    out[kind] = [...byId.values()];
  }
  return out;
}

// The state with the archived items taken out.
export function withoutArchived(state, moved) {
  const ids = (kind) => new Set(Object.values(moved).flatMap((y) => y[kind].map((x) => x.id)));
  const xs = ids('expenses'); const es = ids('events');
  return {
    expenses: (state.expenses || []).filter((x) => !xs.has(x.id)),
    events: (state.events || []).filter((e) => !es.has(e.id)),
  };
}
