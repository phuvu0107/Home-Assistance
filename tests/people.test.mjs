// Run with: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { expenseStats, joinNames, LEGACY_MEMBERS, legacyMembersFor, newMember, sortMembers } from '../people.js';

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
