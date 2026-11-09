import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanCode, feedFor, friendsGate, householdFeed, householdIds, groupMoney, newestFirstId, pairId, reportId, reportOf, showCode, visibleFeed } from '../social.js';

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

test('the household feed shows posts made in it, and older posts by the people in it', () => {
  const posts = [
    { by: 'nhi', at: 3, home: 'h1' },
    { by: 'phu', at: 1 }, // from before the Feed
    { by: 'ann', at: 4 }, // an old friend, not in the household
    { by: 'phu', at: 5, home: 'h2' }, // another household Phu is in
    { by: 'phu', at: 2, home: 'h1' },
  ];
  assert.deepEqual(householdFeed(posts, 'h1', ['phu', 'nhi']).map((p) => p.at), [3, 2, 1]);
  assert.deepEqual(householdFeed(posts, 'h2', ['phu']).map((p) => p.at), [5, 1]);
});

test('everyone signed in to the household sees its posts', () => {
  assert.deepEqual(householdIds({ members: { phu: true, nhi: true, old: false } }), ['phu', 'nhi']);
  assert.deepEqual(householdIds(null), []);
});

test('hidden posts and hidden people leave the Feed only for the person who hid them', () => {
  const posts = [{ id: 'a', by: 'ann' }, { id: 'b', by: 'bob' }, { id: 'c', by: 'bob' }, { id: 'd', by: 'cat' }];
  assert.deepEqual(visibleFeed(posts).map((p) => p.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(visibleFeed(posts, ['a'], ['bob']).map((p) => p.id), ['d']);
  assert.deepEqual(visibleFeed(posts, undefined, ['cat']).map((p) => p.id), ['a', 'b', 'c']);
});

test('a report copies the words, not the pictures, and keeps to known reasons', () => {
  const post = { id: 'p1', by: 'bob', name: 'Bob <b>', text: '  rude words  ', photos: ['data:image/jpeg;base64,x', 'data:image/jpeg;base64,y'] };
  const r = reportOf(post, { uid: 'ann', name: 'Ann' }, 'nonsense', 'home1');
  assert.equal(r.text, 'rude words');
  assert.equal(r.pics, 2);
  assert.equal(r.reason, 'other');
  assert.equal(r.postName, 'Bob b');
  assert.equal(r.by, 'ann');
  assert.ok(!('photos' in r));
  assert.equal(reportOf({ ...post, photos: undefined, photo: 'data:x' }, { uid: 'ann', name: 'Ann' }, 'spam').pics, 1);
  assert.equal(reportId('p1', 'ann'), 'p1_ann');
});
