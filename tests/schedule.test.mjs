// Run with: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { choreDone, choreDue, choreKind, choreLabel, nextDay, passTurn, periodStart, repeatDates, repeatUntil, seasonFor } from '../schedule.js';

// 2026-10-19 is a Monday.
const MON = '2026-10-19';

test('old chores keep working the way they did', () => {
  assert.equal(choreDone({ repeat: 'daily', doneOn: MON }, MON), true);
  assert.equal(choreDone({ repeat: 'daily', doneOn: '2026-10-18' }, MON), false);
  assert.equal(choreDone({ repeat: 'weekly', doneOn: '2026-10-18' }, MON), true); // Sunday starts the week
  assert.equal(choreDone({ repeat: 'weekly', doneOn: '2026-10-17' }, MON), false);
  assert.equal(choreDone({ repeat: 'once', doneOn: '2025-01-01' }, MON), true);
  assert.equal(choreDone({ repeat: 'once', doneOn: '' }, MON), false);
  assert.equal(choreLabel({ repeat: 'weekly' }), 'Weekly');
});

test('a Tuesday chore stays done until the next Tuesday', () => {
  const bins = { repeat: 'daily', days: [2], doneOn: '2026-10-13', from: '2026-10-01' };
  assert.equal(choreKind(bins), 'days');
  assert.equal(periodStart(bins, MON), '2026-10-13');
  assert.equal(choreDone(bins, MON), true);
  assert.equal(choreDone(bins, '2026-10-20'), false);
  assert.equal(nextDay(bins, MON), '2026-10-20');
  assert.equal(choreLabel({ repeat: 'daily', days: [4, 2] }), 'Tue, Thu');
});

test("a weekday chore added after this week's day isn't owed yet", () => {
  const bins = { repeat: 'daily', days: [2], doneOn: '', from: '2026-10-15' };
  assert.equal(choreDue(bins, MON), false);
  assert.equal(choreDue(bins, '2026-10-20'), true);
  assert.equal(choreDue({ repeat: 'daily', doneOn: '' }, MON), true);
});

test('every 2 weeks counts from the week the chore started', () => {
  const sheets = { repeat: 'weekly', every: 2, from: '2026-10-11' };
  assert.equal(periodStart(sheets, '2026-10-12'), '2026-10-11');
  assert.equal(periodStart(sheets, MON), '2026-10-11'); // second week of the stretch
  assert.equal(periodStart(sheets, '2026-10-25'), '2026-10-25');
  assert.equal(choreDone({ ...sheets, doneOn: '2026-10-12' }, MON), true);
  assert.equal(choreDone({ ...sheets, doneOn: '2026-10-12' }, '2026-10-26'), false);
  assert.equal(choreLabel(sheets), 'Every 2 weeks');
});

test('monthly chores reset on the 1st', () => {
  const filter = { repeat: 'weekly', every: 'month', doneOn: '2026-10-02' };
  assert.equal(choreKind(filter), 'monthly');
  assert.equal(choreDone(filter, '2026-10-31'), true);
  assert.equal(choreDone(filter, '2026-11-01'), false);
});

test('taking turns passes the chore on once, after its stretch ends', () => {
  const ids = ['phu', 'nhi'];
  const dishes = { repeat: 'daily', turns: true, who: 'phu', doneOn: MON };
  assert.equal(passTurn(dishes, ids, MON), false); // still today: stays with whoever did it
  assert.equal(passTurn(dishes, ids, '2026-10-20'), true);
  assert.equal(dishes.who, 'nhi');
  assert.equal(passTurn(dishes, ids, '2026-10-20'), false); // a second screen doesn't pass it again
  assert.equal(passTurn({ repeat: 'daily', turns: true, who: 'phu', doneOn: '' }, ids, MON), false);
});

test('monthly and yearly event repeats keep the date', () => {
  assert.deepEqual(repeatDates('2026-01-31', 'monthly', '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(repeatDates('2028-02-29', 'yearly', '2030-12-31'), ['2028-02-29', '2029-02-28', '2030-02-28']);
  assert.deepEqual(repeatDates(MON, 'weekly', '2026-11-02'), [MON, '2026-10-26', '2026-11-02']);
  assert.deepEqual(repeatDates(MON, '', ''), [MON]);
  assert.equal(repeatUntil('2026-10-19', 'yearly'), '2035-10-19');
  assert.equal(repeatUntil('2026-10-19', 'monthly'), '2027-09-19');
  assert.equal(repeatUntil('2026-10-19', 'daily'), '2026-10-25');
});

test('seasonal palettes: Autumn Sep 1 to Nov 30, Christmas Dec 1 to Jan 6', () => {
  const on = (y, m, d) => seasonFor(new Date(y, m - 1, d));
  assert.equal(on(2026, 8, 31), '');
  assert.equal(on(2026, 9, 1), 'autumn');
  assert.equal(on(2026, 10, 26), 'autumn');
  assert.equal(on(2026, 11, 30), 'autumn');
  assert.equal(on(2026, 12, 1), 'christmas');
  assert.equal(on(2026, 12, 31), 'christmas');
  assert.equal(on(2027, 1, 6), 'christmas');
  assert.equal(on(2027, 1, 7), '');
  assert.equal(on(2027, 5, 15), '');
});
