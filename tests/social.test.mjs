import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanCode, feedFor, friendsGate, groupMoney, newestFirstId, pairId, showCode } from '../social.js';

test('ids sort newest first', () => {
  const ids = [1700000000000, 1800000000000, 1750000000000].map((t) => newestFirstId(t));
  assert.deepEqual([...ids].sort(), [ids[1], ids[2], ids[0]]);
  assert.equal(newestFirstId(Date.now()).length, 15);
});

test('a pair of friends has one id whichever way round', () => {
  assert.equal(pairId('bob', 'ann'), 'ann_bob');
  assert.equal(pairId('ann', 'bob'), 'ann_bob');
});

test('codes type in any case, with dashes', () => {
  assert.equal(cleanCode(' abcd-efgh '), 'ABCDEFGH');
  assert.equal(showCode('ABCDEFGHJK'), 'ABCD-EFGH-JK');
});

test('the feed shows only your own and your friends\' posts, newest first', () => {
  const posts = [{ by: 'ann', at: 1 }, { by: 'stranger', at: 5 }, { by: 'bob', at: 3 }, { by: 'me', at: 2 }];
  assert.deepEqual(feedFor(posts, 'me', ['ann', 'bob']).map((p) => p.by), ['bob', 'me', 'ann']);
});

test('group money splits evenly and settles up', () => {
  const items = [
    { type: 'expense', split: true, title: 'Airbnb', amount: 300, paidBy: 'ann' },
    { type: 'event', title: 'Dinner' },
    { type: 'expense', split: true, title: 'Gas', amount: 60, paidBy: 'bob' },
  ];
  const m = groupMoney(items, ['ann', 'bob', 'cat']);
  assert.equal(m.total, 360);
  assert.deepEqual(m.transfers, [{ from: 'cat', to: 'ann', amount: 120 }, { from: 'bob', to: 'ann', amount: 60 }]);
  const after = groupMoney([...items, { type: 'expense', kind: 'settle', paidBy: 'cat', to: 'ann', amount: 120 }], ['ann', 'bob', 'cat']);
  assert.deepEqual(after.transfers, [{ from: 'bob', to: 'ann', amount: 60 }]);
});

test('Friends waits for sign-in to restore instead of flashing the sign-in button', () => {
  const loading = { ready: false, user: null };
  assert.equal(friendsGate(loading, true), 'checking');
  assert.equal(friendsGate(loading, false), 'signin');
  assert.equal(friendsGate({ ready: true, user: null }, true), 'signin');
  assert.equal(friendsGate({ ready: true, user: { uid: 'me' } }, true), 'in');
});
