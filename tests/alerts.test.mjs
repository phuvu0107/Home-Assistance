// Run with: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { alertRecipients, alertTopicOf, bucketAlert, newAlertTopic, NTFY, sendAlerts, thanksAlert } from '../alerts.js';

const people = [{ id: 'phu', name: 'Phu', alerts: newAlertTopic() }, { id: 'nhi', name: 'Nhi', alerts: newAlertTopic() }, { id: 'm1', name: 'Kim' }];

test('each person gets their own random private channel', () => {
  const a = newAlertTopic();
  assert.match(a, /^home-[0-9a-f]{24}$/);
  assert.notEqual(a, newAlertTopic());
  assert.equal(alertTopicOf({ alerts: a }), a);
  // Anything else on a synced record (an old true flag, something made up) is no channel.
  for (const v of [true, '', 'home-x', `${a}&x`, undefined]) assert.equal(alertTopicOf({ alerts: v }), '');
});

test('only people who turned alerts on hear about it, never the sender', () => {
  assert.deepEqual(alertRecipients(people, 'phu').map((u) => u.id), ['nhi']);
  assert.deepEqual(alertRecipients(people, 'm1').map((u) => u.id), ['phu', 'nhi']);
  assert.deepEqual(alertRecipients(undefined, 'phu'), []);
});

test('alerts say who did what, never the note itself', () => {
  assert.equal(thanksAlert('Nhi', '🌸').title, 'Nhi sent you a thank-you 🌸');
  assert.equal(thanksAlert('Nhi').title, 'Nhi sent you a thank-you 💌');
  assert.match(bucketAlert('Phu', 100).message, /\+100 love points/);
});

test('sends one simple JSON request per person to ntfy', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
  const n = await sendAlerts(people, thanksAlert('Kim'), { click: 'https://x.test/', fetchFn });
  assert.equal(n, 2);
  assert.equal(calls[0].url, `${NTFY}/`);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers, undefined); // no custom headers, so no CORS preflight
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.topic, people[0].alerts);
  assert.equal(calls.length, 2); // Kim has no channel
  assert.equal(body.click, 'https://x.test/');
  assert.equal(body.title, 'Kim sent you a thank-you 💌');
});

test('a failed alert never throws', async () => {
  const boom = async () => { throw new Error('offline'); };
  assert.equal(await sendAlerts(people, thanksAlert('Kim'), { fetchFn: boom }), 0);
});
