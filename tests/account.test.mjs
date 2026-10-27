import test from 'node:test';
import assert from 'node:assert/strict';
import { emailWithout, homesAfterLeaving } from '../account.js';
import { groupItemAfterLeaving } from '../social.js';

test('deleting an account deletes only households nobody else is in', () => {
  const homes = [
    { id: 'a', name: 'Ours', members: { ann: true, bob: true } },
    { id: 'b', name: 'Cabin', members: { ann: true } },
    { id: 'c', members: { bob: true } }, // no longer in it
  ];
  assert.deepEqual(homesAfterLeaving(homes, 'ann'), [
    { id: 'a', name: 'Ours', others: 1, gone: false },
    { id: 'b', name: 'Cabin', others: 0, gone: true },
  ]);
});

test('the summary email stops going to someone who deleted their account', () => {
  const email = { on: true, to: ['Ann@Example.com', 'bob@example.com'], tz: 'America/Los_Angeles' };
  assert.deepEqual(emailWithout(email, 'ann@example.com'), { on: true, to: ['bob@example.com'], tz: 'America/Los_Angeles' });
  assert.equal(emailWithout(email, 'eve@example.com'), null);
  assert.equal(emailWithout(null, 'ann@example.com'), null);
  assert.equal(emailWithout(email, ''), null);
});

test('a group keeps shared plans and money, drops the leaver\'s posts', () => {
  assert.equal(groupItemAfterLeaving({ type: 'post', by: 'ann', text: 'hi' }, 'ann'), 'drop');
  assert.equal(groupItemAfterLeaving({ type: 'post', by: 'bob', text: 'hi' }, 'ann'), null);
  assert.equal(groupItemAfterLeaving({ type: 'expense', by: 'ann', paidBy: 'ann', amount: 10 }, 'ann'), null);
  assert.deepEqual(groupItemAfterLeaving({ type: 'event', by: 'bob', going: { ann: true, bob: true } }, 'ann'), { type: 'event', by: 'bob', going: { bob: true } });
});
