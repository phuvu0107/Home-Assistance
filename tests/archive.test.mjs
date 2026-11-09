// Run with: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveCutoff, mergeArchive, pickArchivable, withoutArchived } from '../archive.js';

test('the last twelve full months and this one stay', () => {
  assert.equal(archiveCutoff('2026-11-09'), '2025-11-01');
  assert.equal(archiveCutoff('2026-01-31'), '2025-01-01');
});

test('old expenses and events move, grouped by year; boxed expenses stay', () => {
  const state = {
    expenses: [
      { id: 'x1', date: '2024-03-02', amount: 5 },
      { id: 'x2', date: '2025-10-31', amount: 7 },
      { id: 'x3', date: '2025-11-01', amount: 9 }, // inside the year: stays
      { id: 'x4', date: '2025-02-01', amount: 9, box: 'm1' }, // in a money box: stays
    ],
    events: [{ id: 'e1', date: '2025-06-01', title: 'Old' }, { id: 'e2', date: '2026-11-10', title: 'Soon' }, { id: 'e3', title: 'No date' }],
  };
  const moving = pickArchivable(state, '2025-11-01');
  assert.deepEqual(Object.keys(moving).sort(), ['2024', '2025']);
  assert.deepEqual(moving['2024'].expenses.map((x) => x.id), ['x1']);
  assert.deepEqual(moving['2025'].expenses.map((x) => x.id), ['x2']);
  assert.deepEqual(moving['2025'].events.map((x) => x.id), ['e1']);
  const left = withoutArchived(state, moving);
  assert.deepEqual(left.expenses.map((x) => x.id), ['x3', 'x4']);
  assert.deepEqual(left.events.map((x) => x.id), ['e2', 'e3']);
});

test('archiving the same item twice keeps one copy', () => {
  const a = mergeArchive(null, { expenses: [{ id: 'x1', amount: 5 }], events: [] });
  const b = mergeArchive(a, { expenses: [{ id: 'x1', amount: 5 }, { id: 'x2', amount: 1 }], events: [{ id: 'e1' }] });
  assert.deepEqual(b.expenses.map((x) => x.id), ['x1', 'x2']);
  assert.deepEqual(b.events.map((x) => x.id), ['e1']);
});
