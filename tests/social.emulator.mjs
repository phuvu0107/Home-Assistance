// Firestore rules for friends, posts and groups, run against the emulator (needs Java and firebase-tools):
//   RULES=firestore.rules npx firebase emulators:exec --project demo-home --only firestore "node --test tests/social.emulator.mjs"
import test, { after, before } from 'node:test';
import { readFileSync } from 'node:fs';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, deleteField, doc, getDoc, getDocs, limit, query, setDoc, Timestamp, updateDoc, where } from 'firebase/firestore';

let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-social', firestore: { rules: readFileSync(process.env.RULES, 'utf8'), host: '127.0.0.1', port: 8080 } });
});
after(() => env.cleanup());

const db = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
const inDays = (d) => Timestamp.fromMillis(Date.now() + d * 864e5);

test('friend codes: anyone signed in can look one up, nobody can take one', async () => {
  await assertSucceeds(setDoc(doc(db('ann'), 'friendCodes/ANNCODE1'), { uid: 'ann', name: 'Ann' }));
  await assertFails(setDoc(doc(db('bob'), 'friendCodes/ANNCODE1'), { uid: 'bob', name: 'Bob' }));
  await assertFails(setDoc(doc(db('bob'), 'friendCodes/BOBCODE1'), { uid: 'ann', name: 'Ann' }));
  await assertSucceeds(getDoc(doc(db('bob'), 'friendCodes/ANNCODE1')));
  await assertFails(getDoc(doc(db(null), 'friendCodes/ANNCODE1')));
  await assertFails(getDocs(collection(db('bob'), 'friendCodes')));
});

test('becoming friends needs the other person to say yes', async () => {
  await assertFails(setDoc(doc(db('ann'), 'friendships/ann_bob'), { users: ['ann', 'bob'], names: {} }));
  await assertFails(setDoc(doc(db('ann'), 'friendRequests/bob_ann'), { from: 'bob', to: 'ann' }));
  await assertSucceeds(setDoc(doc(db('ann'), 'friendRequests/ann_bob'), { from: 'ann', to: 'bob', fromName: 'Ann', at: 1 }));
  await assertSucceeds(getDocs(query(collection(db('bob'), 'friendRequests'), where('to', '==', 'bob'))));
  await assertFails(getDocs(query(collection(db('cat'), 'friendRequests'), where('to', '==', 'bob'))));
  // Ann asked, so Ann can't accept her own request.
  await assertFails(setDoc(doc(db('ann'), 'friendships/ann_bob'), { users: ['ann', 'bob'], names: {} }));
  await assertFails(setDoc(doc(db('cat'), 'friendships/ann_cat'), { users: ['ann', 'cat'], names: {} }));
  await assertFails(setDoc(doc(db('bob'), 'friendships/bob_ann'), { users: ['bob', 'ann'], names: {} }));
  await assertSucceeds(setDoc(doc(db('bob'), 'friendships/ann_bob'), { users: ['ann', 'bob'], names: { ann: 'Ann', bob: 'Bob' } }));
  await assertSucceeds(deleteDoc(doc(db('bob'), 'friendRequests/ann_bob')));
  await assertSucceeds(getDocs(query(collection(db('ann'), 'friendships'), where('users', 'array-contains', 'ann'))));
  await assertFails(getDoc(doc(db('cat'), 'friendships/ann_bob')));
  await assertSucceeds(updateDoc(doc(db('ann'), 'friendships/ann_bob'), { 'names.ann': 'Annie' }));
  await assertFails(updateDoc(doc(db('ann'), 'friendships/ann_bob'), { 'names.bob': 'X' }));
  await assertFails(updateDoc(doc(db('ann'), 'friendships/ann_bob'), { users: ['ann', 'cat'] }));
});

test('posts: only the people listed see them; they can like, not edit', async () => {
  const p = 'posts/0001abc';
  await assertFails(setDoc(doc(db('ann'), p), { by: 'bob', seen: ['ann', 'bob'], text: 'hi', likes: {} }));
  await assertFails(setDoc(doc(db('ann'), p), { by: 'ann', seen: ['bob'], text: 'hi', likes: {} }));
  await assertFails(setDoc(doc(db('ann'), p), { by: 'ann', seen: ['ann'], text: 'x'.repeat(1001), likes: {} }));
  await assertSucceeds(setDoc(doc(db('ann'), p), { by: 'ann', name: 'Ann', seen: ['ann', 'bob'], text: 'hi', at: 1, likes: {} }));
  await assertSucceeds(getDoc(doc(db('bob'), p)));
  await assertFails(getDoc(doc(db('cat'), p)));
  await assertSucceeds(getDocs(query(collection(db('bob'), 'posts'), where('seen', 'array-contains', 'bob'), limit(60))));
  await assertFails(getDocs(query(collection(db('cat'), 'posts'), limit(60))));
  await assertSucceeds(updateDoc(doc(db('bob'), p), { 'likes.bob': true }));
  await assertFails(updateDoc(doc(db('bob'), p), { 'likes.ann': true }));
  await assertFails(updateDoc(doc(db('bob'), p), { text: 'changed' }));
  await assertFails(updateDoc(doc(db('cat'), p), { 'likes.cat': true }));
  await assertSucceeds(updateDoc(doc(db('bob'), p), { 'likes.bob': deleteField() }));
  // Comments
  await assertSucceeds(setDoc(doc(db('bob'), `${p}/comments/c1`), { by: 'bob', name: 'Bob', text: 'nice', at: 2 }));
  await assertFails(setDoc(doc(db('bob'), `${p}/comments/c2`), { by: 'ann', text: 'fake', at: 2 }));
  await assertFails(setDoc(doc(db('cat'), `${p}/comments/c3`), { by: 'cat', text: 'hi', at: 2 }));
  await assertSucceeds(getDocs(collection(db('ann'), `${p}/comments`)));
  await assertFails(getDocs(collection(db('cat'), `${p}/comments`)));
  await assertSucceeds(deleteDoc(doc(db('ann'), `${p}/comments/c1`))); // the writer of the post tidies up
  await assertFails(deleteDoc(doc(db('bob'), p)));
  await assertSucceeds(deleteDoc(doc(db('ann'), p)));
});

test('groups: join with a live invite, members share everything inside', async () => {
  await assertFails(setDoc(doc(db('ann'), 'groups/g1'), { name: 'Trip', members: { ann: true, bob: true } }));
  await assertSucceeds(setDoc(doc(db('ann'), 'groups/g1'), { name: 'Trip', members: { ann: true }, names: { ann: 'Ann' } }));
  await assertFails(getDoc(doc(db('bob'), 'groups/g1')));
  await assertFails(updateDoc(doc(db('bob'), 'groups/g1'), { 'members.bob': true, 'names.bob': 'Bob' }));
  await assertFails(updateDoc(doc(db('ann'), 'groups/g1'), { 'members.bob': true }));
  await assertFails(setDoc(doc(db('bob'), 'groupInvites/BOBCODE11'), { group: 'g1', by: 'bob', expires: inDays(7) }));
  await assertFails(setDoc(doc(db('ann'), 'groupInvites/LONGLIFE1'), { group: 'g1', by: 'ann', expires: inDays(30) }));
  await assertSucceeds(setDoc(doc(db('ann'), 'groupInvites/OLDCODE11'), { group: 'g1', by: 'ann', expires: inDays(-1) }));
  await assertFails(updateDoc(doc(db('bob'), 'groups/g1'), { 'members.bob': true, 'names.bob': 'Bob', invite: 'OLDCODE11' }));
  await assertSucceeds(setDoc(doc(db('ann'), 'groupInvites/ANNCODE11'), { group: 'g1', by: 'ann', expires: inDays(7) }));
  // Joining can't bring a friend along or rename others.
  await assertFails(updateDoc(doc(db('bob'), 'groups/g1'), { 'members.bob': true, 'members.cat': true, invite: 'ANNCODE11' }));
  await assertFails(updateDoc(doc(db('bob'), 'groups/g1'), { 'members.bob': true, 'names.ann': 'X', invite: 'ANNCODE11' }));
  await assertSucceeds(updateDoc(doc(db('bob'), 'groups/g1'), { 'members.bob': true, 'names.bob': 'Bob', invite: 'ANNCODE11' }));
  await assertSucceeds(getDoc(doc(db('bob'), 'groups/g1')));
  // Inside the group
  await assertSucceeds(setDoc(doc(db('bob'), 'groups/g1/items/e1'), { type: 'event', title: 'Dinner', date: '2026-11-01', by: 'bob' }));
  await assertSucceeds(setDoc(doc(db('ann'), 'groups/g1/items/e1/comments/c1'), { by: 'ann', text: 'yes' }));
  await assertSucceeds(getDocs(collection(db('ann'), 'groups/g1/items')));
  await assertFails(getDocs(collection(db('cat'), 'groups/g1/items')));
  await assertFails(setDoc(doc(db('cat'), 'groups/g1/items/x'), { type: 'post', text: 'spam' }));
  // Members rename the group or leave, but can't remove someone else.
  await assertSucceeds(updateDoc(doc(db('bob'), 'groups/g1'), { name: 'Big trip' }));
  await assertFails(updateDoc(doc(db('bob'), 'groups/g1'), { 'members.ann': deleteField() }));
  await assertSucceeds(updateDoc(doc(db('bob'), 'groups/g1'), { 'members.bob': deleteField(), 'names.bob': deleteField() }));
  await assertFails(getDocs(collection(db('bob'), 'groups/g1/items')));
});

test('household data stays closed to friends and group members', async () => {
  await assertSucceeds(setDoc(doc(db('ann'), 'homes/h1'), { members: { ann: true }, name: 'Home' }));
  await assertSucceeds(setDoc(doc(db('ann'), 'homes/h1/data/main'), { items: {} }));
  await assertFails(getDoc(doc(db('bob'), 'homes/h1/data/main')));
});

test('deleting an account: a group nobody else is in can be deleted', async () => {
  await assertSucceeds(setDoc(doc(db('ann'), 'groups/solo'), { name: 'Solo', members: { ann: true }, names: { ann: 'Ann' } }));
  await assertSucceeds(setDoc(doc(db('ann'), 'groupInvites/SOLOCODE1'), { group: 'solo', by: 'ann', expires: Timestamp.fromMillis(Date.now() + 864e5) }));
  await assertSucceeds(updateDoc(doc(db('bob'), 'groups/solo'), { 'members.bob': true, 'names.bob': 'Bob', invite: 'SOLOCODE1' }));
  await assertFails(deleteDoc(doc(db('ann'), 'groups/solo')));
  await assertFails(deleteDoc(doc(db('eve'), 'groups/solo')));
  await assertSucceeds(updateDoc(doc(db('bob'), 'groups/solo'), { 'members.bob': deleteField(), 'names.bob': deleteField() }));
  await assertFails(deleteDoc(doc(db('bob'), 'groups/solo')));
  await assertSucceeds(deleteDoc(doc(db('ann'), 'groups/solo')));
});
