// Run with: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { boxChoices, boxesForMonth, boxForDay, boxStats, cleanBoxName, expenseStats, joinNames, LEGACY_MEMBERS, legacyMembersFor, newMember, sortMembers } from '../people.js';

const two = ['phu', 'nhi'];

// What the app showed before people were data, for two people a and b.
function oldStats(list, [a, b]) {
  const shared = list.filter((x) => x.kind !== 'settle' && x.split);
  const paidA = shared.filter((x) => x.paidBy === a || x.paidBy === 'both').reduce((n, x) => n + (x.paidBy === 'both' ? x.amount / 2 : x.amount), 0);
  const settled = list.filter((x) => x.kind === 'settle').reduce((n, x) => n + (x.paidBy === b ? x.amount : -x.amount), 0);
  const net = paidA - shared.reduce((n, x) => n + x.amount, 0) / 2 - settled; // > 0 means b owes a
  return Math.abs(net) < 0.005 ? [] : [{ from: net > 0 ? b : a, to: net > 0 ? a : b, amount: Math.round(Math.abs(net) * 100) / 100 }];
}

test('an existing two-person household keeps Phu and Nhi, in order', () => {
  const state = { settings: { me: '' }, tasks: [{ id: 't1', who: 'nhi' }], events: [], stars: { phu: 10, nhi: 4 } };
  const got = legacyMembersFor(state);
  assert.deepEqual(got.map((u) => u.id), ['phu', 'nhi']);
  assert.deepEqual(got.map((u) => u.avatar), ['avatars/phu.svg', 'avatars/nhi.svg']);
  // Synced items come back sorted by id ('nhi' before 'phu'); order keeps Phu first.
  assert.deepEqual(sortMembers([got[1], got[0]]).map((u) => u.name), ['Phu', 'Nhi']);
});

test('a household that already has members, or a brand new one, gets no legacy members', () => {
  assert.equal(legacyMembersFor({ members: [{ id: 'm1', name: 'An' }], stars: { phu: 1 } }), null);
  assert.equal(legacyMembersFor({ settings: {}, tasks: [], events: [], stars: {} }), null);
});

test('legacy members are copies, so editing one never changes the defaults', () => {
  const got = legacyMembersFor({ stars: { phu: 1 } });
  got[0].name = 'Changed';
  assert.equal(LEGACY_MEMBERS[0].name, 'Phu');
});

test('a new person gets an unused color and goes last', () => {
  const m = newMember('  Bao   Tran ', LEGACY_MEMBERS);
  assert.equal(m.name, 'Bao Tran');
  assert.equal(m.color, 'green');
  assert.equal(m.order, 2);
  assert.ok(!['phu', 'nhi', 'both', ''].includes(m.id));
});

test('two-person money matches what the app showed before', () => {
  const cases = [
    [],
    [{ amount: 80, paidBy: 'phu', split: true }],
    [{ amount: 80, paidBy: 'phu', split: true }, { amount: 30, paidBy: 'nhi', split: true }],
    [{ amount: 50, paidBy: 'both', split: true }, { amount: 12.34, paidBy: 'nhi', split: true }],
    [{ amount: 100, paidBy: 'phu', split: true }, { kind: 'settle', amount: 50, paidBy: 'nhi', to: 'phu' }],
    [{ amount: 100, paidBy: 'phu', split: true }, { kind: 'settle', amount: 70, paidBy: 'nhi', to: 'phu' }],
    [{ amount: 40, paidBy: 'nhi', split: false }, { amount: 9.99, paidBy: 'phu', split: true }],
  ];
  for (const list of cases) assert.deepEqual(expenseStats(list, two).transfers, oldStats(list, two), JSON.stringify(list));
});

test('totals and who paid what, with Both paying half each', () => {
  const st = expenseStats([{ amount: 50, paidBy: 'both', split: true }, { amount: 20, paidBy: 'phu', split: false }], two);
  assert.equal(st.total, 70);
  assert.deepEqual(st.paid, { phu: 45, nhi: 25 });
  assert.equal(st.each, 25);
  assert.deepEqual(st.transfers, []);
});

test('three people split evenly and settle in as few payments as possible', () => {
  const ids = ['a', 'b', 'c'];
  const st = expenseStats([{ amount: 90, paidBy: 'a', split: true }, { amount: 30, paidBy: 'b', split: true }], ids);
  assert.equal(st.each, 40);
  assert.deepEqual(st.transfers, [{ from: 'c', to: 'a', amount: 40 }, { from: 'b', to: 'a', amount: 10 }]);
  const after = expenseStats([{ amount: 90, paidBy: 'a', split: true }, { amount: 30, paidBy: 'b', split: true },
    { kind: 'settle', amount: 40, paidBy: 'c', to: 'a' }, { kind: 'settle', amount: 10, paidBy: 'b', to: 'a' }], ids);
  assert.deepEqual(after.transfers, []);
});

test('names read naturally', () => {
  assert.equal(joinNames(['Phu']), 'Phu');
  assert.equal(joinNames(['Phu', 'Nhi']), 'Phu and Nhi');
  assert.equal(joinNames(['An', 'Binh', 'Chi']), 'An, Binh and Chi');
});

test('money trend lists every month up to the shown one, with gaps at zero', async () => {
  const { monthTrend } = await import('../people.js');
  const list = [
    { date: '2026-08-03', amount: 40, paidBy: 'phu', split: true, title: 'Costco' },
    { date: '2026-08-20', amount: 10, paidBy: 'nhi', split: true, title: 'costco ' },
    { date: '2026-10-01', amount: 30, paidBy: 'both', split: true, title: 'Rent' },
    { date: '2026-10-02', amount: 5, paidBy: 'nhi', to: 'phu', kind: 'settle' },
    { date: '2025-01-01', amount: 999, paidBy: 'phu', title: 'Long ago' },
  ];
  const t = monthTrend(list, two, '2026-10', 6);
  assert.deepEqual(t.months.map((m) => m.key), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  assert.deepEqual(t.months.map((m) => m.total), [0, 0, 0, 50, 0, 30]);
  assert.deepEqual(t.months.at(-1).paid, { phu: 15, nhi: 15 });
  assert.equal(t.months.at(-1).count, 1); // the settle-up isn't spending
  assert.equal(t.average, 80 / 3); // August to October
  assert.equal(t.max, 50);
  assert.deepEqual(t.spent.map((x) => x.title), ['Costco', 'costco ', 'Rent']); // not the settle-up or 2025
});
test('money trend crosses the new year', async () => {
  const { monthTrend } = await import('../people.js');
  assert.deepEqual(monthTrend([], two, '2027-02', 4).months.map((m) => m.key), ['2026-11', '2026-12', '2027-01', '2027-02']);
  assert.equal(monthTrend([], two, '2027-02', 4).average, 0);
});

test('expenses without a known category count as Other', async () => {
  const { categoryTotals, expenseCat } = await import('../people.js');
  assert.equal(expenseCat({ title: 'Old one' }), 'other');
  assert.equal(expenseCat({ cat: 'pets' }), 'other'); // a category from a newer version
  assert.equal(expenseCat({ cat: 'dining' }), 'dining');
  const list = [
    { amount: 40, cat: 'groceries' }, { amount: 10, cat: 'groceries' }, { amount: 30 },
    { amount: 25, cat: 'dining' }, { kind: 'settle', amount: 99, paidBy: 'a', to: 'b' },
  ];
  assert.deepEqual(categoryTotals(list), [
    { id: 'groceries', total: 50, count: 2 }, { id: 'other', total: 30, count: 1 }, { id: 'dining', total: 25, count: 1 },
  ]);
});
test('a first category guess from the name', async () => {
  const { guessExpenseCat } = await import('../people.js');
  assert.equal(guessExpenseCat('Costco'), 'groceries');
  assert.equal(guessExpenseCat("TRADER JOE'S #123"), 'groceries');
  assert.equal(guessExpenseCat('Pho Hoa dinner'), 'dining');
  assert.equal(guessExpenseCat('PG&E'), 'bills');
  assert.equal(guessExpenseCat('Rent'), 'bills');
  assert.equal(guessExpenseCat('Chevron'), 'transport');
  assert.equal(guessExpenseCat('Home Depot'), 'home');
  assert.equal(guessExpenseCat('Walgreens'), 'health');
  assert.equal(guessExpenseCat('Something else'), 'other');
});

test('a box adds up only its own expenses, over every month, and who owes whom inside it', () => {
  const japan = { id: 'm1', name: 'Japan Box', from: '2026-11-02', to: '2026-11-09' };
  const list = [
    { id: 'x1', title: 'Ramen', amount: 40, date: '2026-11-03', paidBy: 'phu', split: true, box: 'm1' },
    { id: 'x2', title: 'Hotel', amount: 600, date: '2026-10-20', paidBy: 'nhi', split: true, box: 'm1' },
    { id: 'x3', title: 'Groceries', amount: 80, date: '2026-11-03', paidBy: 'phu', split: true },
    { id: 'x4', title: 'Taxi', amount: 30, date: '2026-11-04', paidBy: 'phu', split: true, box: 'm2' },
  ];
  const st = boxStats(japan, list, two);
  assert.equal(st.total, 640);
  assert.equal(st.count, 2);
  assert.deepEqual(st.paid, { phu: 40, nhi: 600 });
  assert.deepEqual(st.transfers, [{ from: 'phu', to: 'nhi', amount: 280 }]);
  assert.equal(st.last, '2026-11-03');
  assert.deepEqual(st.list.map((x) => x.id), ['x1', 'x2']);
});

test('the Money page shows boxes with spending that month or days in it, newest first', () => {
  const boxes = [
    { id: 'm1', name: 'Japan', from: '2026-11-02', to: '2026-11-09' },
    { id: 'm2', name: 'Picnic' },
    { id: 'm3', name: 'Old trip', from: '2026-08-01', to: '2026-08-03' },
    { id: 'm4', name: 'Beach day', from: '2026-10-25' },
  ];
  const list = [{ id: 'x1', amount: 600, date: '2026-10-20', paidBy: 'nhi', box: 'm1' }];
  // October: Japan has the hotel booked in October; Beach day is in it; the empty Picnic box is new.
  assert.deepEqual(boxesForMonth(boxes, list, '2026-10', '2026-10-19').map((b) => b.id), ['m1', 'm4', 'm2']);
  // November: Japan's days; the empty Picnic box only shows in the current month.
  assert.deepEqual(boxesForMonth(boxes, list, '2026-11', '2026-10-19').map((b) => b.id), ['m1']);
  assert.deepEqual(boxesForMonth(boxes, list, '2026-08', '2026-10-19').map((b) => b.id), ['m3']);
});

test('a new expense starts in the box whose days cover it, and old boxes leave the picker', () => {
  const boxes = [
    { id: 'm1', name: 'Japan', from: '2026-11-02', to: '2026-11-09' },
    { id: 'm2', name: 'Picnic' },
    { id: 'm3', name: 'Old trip', from: '2026-01-01', to: '2026-01-03' },
    { id: 'm4', name: 'Beach day', from: '2026-11-05' },
  ];
  assert.equal(boxForDay(boxes, '2026-11-03'), 'm1');
  assert.equal(boxForDay(boxes, '2026-11-05'), 'm4'); // the later start wins
  assert.equal(boxForDay(boxes, '2026-11-20'), ''); // boxes without days are picked by hand
  assert.deepEqual(boxChoices(boxes, '2026-11-20').map((b) => b.id), ['m4', 'm1', 'm2']);
  assert.deepEqual(boxChoices(boxes, '2026-11-20', 'm3').map((b) => b.id), ['m4', 'm1', 'm3', 'm2']);
});

test('box names are tidied and kept short', () => {
  assert.equal(cleanBoxName('  Japan   <Box> '), 'Japan Box');
  assert.equal(cleanBoxName('x'.repeat(50)).length, 30);
});
