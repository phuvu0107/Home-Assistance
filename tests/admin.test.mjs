import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtBytes, monitors, shortId, worst } from '../admin.js';

const NOW = Date.parse('2026-10-19T20:00:00Z');
const ago = (h) => new Date(NOW - h * 36e5).toISOString();
const stats = (over = {}) => ({
  at: ago(0.5), limit: 1040000, households: 2, people: 3, legacy: 0, legacyActive: 0,
  secrets: { smtp: true, admins: 1 },
  homes: [{ id: 'aaa', members: 2, size: 300000, email: true, emailSent: '2026-10-19-midday' }, { id: 'bbb', members: 1, size: 1000, email: false }],
  ...over,
});
const site = { feedback: true, fitbit: true };
const level = (list, id) => list.find((m) => m.id === id)?.level;

test('all good', () => {
  const list = monitors({ stats: stats(), runs: [{ at: ago(2), home: 'aaa', slot: 'midday', ok: true }], now: NOW, site });
  assert.equal(worst(list), 'ok', JSON.stringify(list));
  assert.match(list.find((m) => m.id === 'email').text, /1 sent in the last day/);
});

test('no report yet is a problem', () => {
  const list = monitors({ stats: null, now: NOW, site });
  assert.equal(list.length, 1);
  assert.equal(worst(list), 'bad');
});

test('a late job warns, a very late one is a problem', () => {
  assert.equal(level(monitors({ stats: stats({ at: ago(5) }), now: NOW, site }), 'job'), 'warn');
  assert.equal(level(monitors({ stats: stats({ at: ago(13) }), now: NOW, site }), 'job'), 'bad');
});

test('failed emails in the last day show the latest reason', () => {
  const runs = [{ at: ago(1), home: 'aaa', slot: 'midday', ok: false, error: 'SMTP login refused' }, { at: ago(30), ok: false }, { at: ago(6), ok: true }];
  const m = monitors({ stats: stats(), runs, now: NOW, site }).find((x) => x.id === 'email');
  assert.equal(m.level, 'bad');
  assert.match(m.text, /1 of 2 emails failed.*SMTP login refused/);
});

test('a household with the email on that got none in two days', () => {
  const s = stats(); s.homes[0].emailSent = '2026-10-15-night';
  assert.equal(level(monitors({ stats: s, now: NOW, site }), 'email'), 'warn');
});

test('missing sending account', () => {
  assert.equal(level(monitors({ stats: stats({ secrets: { smtp: false } }), now: NOW, site }), 'email'), 'bad');
});

test('household data near the 1 MiB limit', () => {
  const s = (size) => stats({ homes: [{ id: 'aaa', members: 2, size }] });
  assert.equal(level(monitors({ stats: s(850000), now: NOW, site }), 'size'), 'warn');
  assert.equal(level(monitors({ stats: s(950000), now: NOW, site }), 'size'), 'bad');
  assert.equal(level(monitors({ stats: s(100), now: NOW, site }), 'size'), 'ok');
});

test('passphrase households still in use, and site settings', () => {
  const list = monitors({ stats: stats({ legacy: 3, legacyActive: 1 }), now: NOW, site: { feedback: false, fitbit: true } });
  assert.equal(level(list, 'legacy'), 'warn');
  assert.equal(level(list, 'config'), 'warn');
  assert.match(list.find((m) => m.id === 'config').text, /FEEDBACK_EMAIL/);
});

test('formatting', () => {
  assert.equal(fmtBytes(1040000), '1016 KB');
  assert.equal(fmtBytes(2 * 1048576), '2.00 MB');
  assert.equal(shortId('abcdefghij'), 'abcdef');
});
