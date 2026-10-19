// Firestore rules for sign-in households, run against the emulator (needs Java and firebase-tools):
//   RULES=firestore.rules npx firebase emulators:exec --project demo-home --only firestore "node --test tests/rules.emulator.mjs"
import test, { after, before } from 'node:test';
import { readFileSync } from 'node:fs';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteField, doc, getDoc, setDoc, Timestamp, updateDoc, deleteDoc } from 'firebase/firestore';

let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-home', firestore: { rules: readFileSync(process.env.RULES, 'utf8'), host: '127.0.0.1', port: 8080 } });
});
after(() => env.cleanup());

const db = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
const inDays = (d) => Timestamp.fromMillis(Date.now() + d * 864e5);

test('starting a household, and only members see it', async () => {
  await assertSucceeds(setDoc(doc(db('ann'), 'homes/h1'), { members: { ann: true }, name: 'Home' }));
  await assertFails(setDoc(doc(db('bob'), 'homes/h2'), { members: { bob: true, ann: true } }));
  await assertFails(setDoc(doc(db(null), 'homes/h3'), { members: {} }));
  await assertSucceeds(setDoc(doc(db('ann'), 'homes/h1/data/main'), { items: { 'e:1': { title: 'x' } } }));
  await assertSucceeds(getDoc(doc(db('ann'), 'homes/h1/data/main')));
  await assertFails(getDoc(doc(db('bob'), 'homes/h1/data/main')));
  await assertFails(getDoc(doc(db('bob'), 'homes/h1')));
  await assertFails(setDoc(doc(db('bob'), 'homes/h1/data/main'), { items: {} }));
  await assertFails(getDoc(doc(db(null), 'homes/h1/data/main')));
});

test('joining needs a live invite for that household', async () => {
  await assertFails(updateDoc(doc(db('bob'), 'homes/h1'), { 'members.bob': true }));
  await assertFails(updateDoc(doc(db('bob'), 'homes/h1'), { 'members.bob': true, invite: 'NOSUCHCODE' }));
  await assertFails(setDoc(doc(db('bob'), 'invites/BOBSCODE1'), { home: 'h1', by: 'bob', expires: inDays(7) }));
  await assertFails(setDoc(doc(db('ann'), 'invites/LONGLIFE1'), { home: 'h1', by: 'ann', expires: inDays(30) }));
  await assertSucceeds(setDoc(doc(db('ann'), 'invites/OLDCODE11'), { home: 'h1', by: 'ann', expires: inDays(-1) }));
  await assertFails(updateDoc(doc(db('bob'), 'homes/h1'), { 'members.bob': true, invite: 'OLDCODE11' }));
  await assertSucceeds(setDoc(doc(db('ann'), 'invites/ANNCODE11'), { home: 'h1', by: 'ann', expires: inDays(7) }));
  await assertSucceeds(getDoc(doc(db('bob'), 'invites/ANNCODE11')));
  await assertFails(getDoc(doc(db(null), 'invites/ANNCODE11')));
  // An invite for one household doesn't open another.
  await assertSucceeds(setDoc(doc(db('cat'), 'homes/h9'), { members: { cat: true } }));
  await assertFails(updateDoc(doc(db('bob'), 'homes/h9'), { 'members.bob': true, invite: 'ANNCODE11' }));
  // Can't bring a friend along or rename the household while joining.
  await assertFails(updateDoc(doc(db('bob'), 'homes/h1'), { 'members.bob': true, 'members.eve': true, invite: 'ANNCODE11' }));
  await assertFails(updateDoc(doc(db('bob'), 'homes/h1'), { 'members.bob': true, invite: 'ANNCODE11', name: 'Mine' }));
  await assertSucceeds(updateDoc(doc(db('bob'), 'homes/h1'), { 'members.bob': true, invite: 'ANNCODE11' }));
  await assertSucceeds(getDoc(doc(db('bob'), 'homes/h1/data/main')));
});

test('members rename and remove, but cannot add people', async () => {
  await assertSucceeds(updateDoc(doc(db('ann'), 'homes/h1'), { name: 'Our home' }));
  await assertFails(updateDoc(doc(db('ann'), 'homes/h1'), { 'members.eve': true }));
  await assertSucceeds(updateDoc(doc(db('ann'), 'homes/h1'), { 'members.bob': deleteField() }));
  await assertFails(getDoc(doc(db('bob'), 'homes/h1/data/main')));
});

test('people only see their own pointer; invites delete by their maker', async () => {
  await assertSucceeds(setDoc(doc(db('ann'), 'users/ann'), { home: 'h1' }));
  await assertFails(getDoc(doc(db('bob'), 'users/ann')));
  await assertFails(deleteDoc(doc(db('bob'), 'invites/ANNCODE11')));
  await assertSucceeds(deleteDoc(doc(db('ann'), 'invites/ANNCODE11')));
});

test('joining uses the invite up; outsiders cannot delete it', async () => {
  await assertSucceeds(setDoc(doc(db('ann'), 'homes/h3'), { members: { ann: true }, name: 'Home' }));
  await assertSucceeds(setDoc(doc(db('ann'), 'invites/ONCEONLY1'), { home: 'h3', by: 'ann', expires: inDays(7) }));
  await assertFails(deleteDoc(doc(db('eve'), 'invites/ONCEONLY1')));
  await assertSucceeds(updateDoc(doc(db('bob'), 'homes/h3'), { 'members.bob': true, invite: 'ONCEONLY1' }));
  await assertSucceeds(deleteDoc(doc(db('bob'), 'invites/ONCEONLY1')));
  await assertFails(updateDoc(doc(db('eve'), 'homes/h3'), { 'members.eve': true, invite: 'ONCEONLY1' }));
});

test('old passphrase households keep working', async () => {
  const id = 'a'.repeat(64);
  await assertSucceeds(setDoc(doc(db(null), `households/${id}`), { box: { v: 1 }, at: 1 }));
  await assertSucceeds(getDoc(doc(db(null), `households/${id}`)));
});

test('deleting an account: only a household nobody else is in can be deleted', async () => {
  await assertSucceeds(setDoc(doc(db('ann'), 'homes/h4'), { members: { ann: true }, name: 'Home' }));
  await assertSucceeds(setDoc(doc(db('ann'), 'invites/LEAVEME11'), { home: 'h4', by: 'ann', expires: inDays(7) }));
  await assertSucceeds(updateDoc(doc(db('bob'), 'homes/h4'), { 'members.bob': true, invite: 'LEAVEME11' }));
  await assertSucceeds(setDoc(doc(db('ann'), 'homes/h4/data/main'), { items: {} }));
  // Others still use it: nobody can delete it, and outsiders can't touch it.
  await assertFails(deleteDoc(doc(db('ann'), 'homes/h4')));
  await assertFails(deleteDoc(doc(db('eve'), 'homes/h4')));
  // Bob deletes his account: he leaves, Ann keeps everything.
  await assertSucceeds(updateDoc(doc(db('bob'), 'homes/h4'), { 'members.bob': deleteField() }));
  await assertSucceeds(getDoc(doc(db('ann'), 'homes/h4/data/main')));
  // Now Ann is the only one: she can delete the data and the household.
  await assertFails(deleteDoc(doc(db('bob'), 'homes/h4')));
  await assertSucceeds(deleteDoc(doc(db('ann'), 'homes/h4/data/main')));
  await assertSucceeds(deleteDoc(doc(db('ann'), 'homes/h4')));
  await assertSucceeds(deleteDoc(doc(db('ann'), 'users/ann')));
});
