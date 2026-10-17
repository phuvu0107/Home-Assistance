// Friends and groups: people from any household can be friends, post to a shared feed, and form
// groups with their own feed, plans, bucket list and shared money.
//
// None of this lives in a household's synced document: it has its own collections in the
// database (see firestore.rules), so a household's data is never touched and never grows.
// The pure helpers at the top are tested on their own (tests/social.test.mjs).
import { firebase } from './firebase.js';
import { expenseStats } from './people.js';

export const POST_MAX = 1000;
export const COMMENT_MAX = 500;
export const GROUP_NAME_MAX = 40;
export const FEED_SIZE = 60;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INVITE_DAYS = 7;
const randomCode = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
export const cleanCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const showCode = (code) => String(code || '').replace(/(.{4})(?=.)/g, '$1-');
export const cleanText = (s, max) => String(s || '').replace(/\r/g, '').trim().slice(0, max);
export const cleanPersonName = (s) => String(s || '').replace(/[<>&"`]/g, '').trim().replace(/\s+/g, ' ').slice(0, 40);

// Ids that sort newest first, so the database hands back the latest posts without an index.
// 9 base-36 characters until the year 2286.
export const newestFirstId = (now = Date.now()) => (1e13 - now).toString(36).padStart(9, '0') + randomCode(6).toLowerCase();
export const pairId = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

// The feed as a person sees it: their own posts and their friends', newest first. A post from
// someone who isn't (or is no longer) a friend is left out even if it lists this person.
export function feedFor(posts, uid, friendIds) {
  const ok = new Set([uid, ...friendIds]);
  return posts.filter((p) => ok.has(p.by)).sort((a, b) => (b.at || 0) - (a.at || 0));
}

// A group's money: everyone in the group shares each expense evenly unless it says otherwise.
export const groupMoney = (items, ids) => expenseStats(items.filter((x) => x.type === 'expense'), ids);

/* ---------- Database ---------- */

const db = async () => firebase();

// This person's name and friend code, made the first time they open Friends.
export async function myProfile(user) {
  const { fs, db: d } = await db();
  const ref = fs.doc(d, `users/${user.uid}`);
  const s = await fs.getDoc(ref);
  const social = (s.exists() && s.data().social) || {};
  if (social.code) return { name: social.name || 'Me', code: social.code, groups: s.data().groups || [] };
  const name = cleanPersonName(user.name || user.email.split('@')[0]) || 'Me';
  const code = randomCode(8);
  await fs.setDoc(fs.doc(d, `friendCodes/${code}`), { uid: user.uid, name });
  await fs.setDoc(ref, { social: { name, code } }, { merge: true });
  return { name, code, groups: (s.exists() && s.data().groups) || [] };
}

// A new name shows for friends and in this person's groups; old posts keep the name they had.
export async function setMyName(uid, code, typed, groupIds = []) {
  const { fs, db: d } = await db();
  const name = cleanPersonName(typed);
  if (!name) return null;
  await fs.setDoc(fs.doc(d, `users/${uid}`), { social: { name, code } }, { merge: true });
  await fs.setDoc(fs.doc(d, `friendCodes/${code}`), { uid, name });
  const pairs = await fs.getDocs(fs.query(fs.collection(d, 'friendships'), fs.where('users', 'array-contains', uid)));
  await Promise.all([...pairs.docs.map((x) => fs.updateDoc(x.ref, { [`names.${uid}`]: name })),
    ...groupIds.map((g) => fs.updateDoc(fs.doc(d, `groups/${g}`), { [`names.${uid}`]: name }).catch(() => {}))]);
  return name;
}

// Asks the owner of a friend code to be friends. Returns 'nocode', 'self', 'already', 'asked'
// or 'friends' (they had already asked this person, so this says yes).
export async function addFriend(me, typed, friendIds) {
  const { fs, db: d } = await db();
  const code = cleanCode(typed);
  if (code.length < 8) return 'nocode';
  const s = await fs.getDoc(fs.doc(d, `friendCodes/${code}`));
  if (!s.exists()) return 'nocode';
  const them = s.data();
  if (them.uid === me.uid) return 'self';
  if (friendIds.includes(them.uid)) return 'already';
  const theirs = await fs.getDoc(fs.doc(d, `friendRequests/${them.uid}_${me.uid}`)).catch(() => null);
  if (theirs?.exists()) { await acceptFriend(me, theirs.data()); return 'friends'; }
  await fs.setDoc(fs.doc(d, `friendRequests/${me.uid}_${them.uid}`), { from: me.uid, to: them.uid, fromName: me.name, toName: cleanPersonName(them.name), at: Date.now() });
  return 'asked';
}

export async function acceptFriend(me, req) {
  const { fs, db: d } = await db();
  const users = [req.from, me.uid].sort();
  await fs.setDoc(fs.doc(d, `friendships/${pairId(req.from, me.uid)}`), { users, names: { [req.from]: cleanPersonName(req.fromName), [me.uid]: me.name }, at: Date.now() });
  await fs.deleteDoc(fs.doc(d, `friendRequests/${req.from}_${me.uid}`));
}

export async function dropRequest(req) {
  const { fs, db: d } = await db();
  await fs.deleteDoc(fs.doc(d, `friendRequests/${req.from}_${req.to}`));
}

export async function unfriend(uid, other) {
  const { fs, db: d } = await db();
  await fs.deleteDoc(fs.doc(d, `friendships/${pairId(uid, other)}`));
}

const docsOf = (snap) => snap.docs.map((x) => ({ id: x.id, ...x.data() }));

// Calls back with { incoming, outgoing, friends: [{ uid, name }] } now and on every change.
export async function watchFriends(uid, cb) {
  const { fs, db: d } = await db();
  const now = { incoming: [], outgoing: [], friends: [] };
  const send = () => cb({ ...now });
  const offs = [
    fs.onSnapshot(fs.query(fs.collection(d, 'friendRequests'), fs.where('to', '==', uid)), (s) => { now.incoming = docsOf(s); send(); }, () => {}),
    fs.onSnapshot(fs.query(fs.collection(d, 'friendRequests'), fs.where('from', '==', uid)), (s) => { now.outgoing = docsOf(s); send(); }, () => {}),
    fs.onSnapshot(fs.query(fs.collection(d, 'friendships'), fs.where('users', 'array-contains', uid)), (s) => {
      now.friends = docsOf(s).map((f) => { const o = f.users.find((u) => u !== uid); return { uid: o, name: cleanPersonName(f.names?.[o]) || 'Friend' }; })
        .sort((a, b) => a.name.localeCompare(b.name));
      send();
    }, () => {}),
  ];
  return () => offs.forEach((off) => off());
}

/* ---------- Posts ---------- */
// A post is shown to the friends its writer had when they posted it. The path is 'posts' for the
// Friends feed or 'groups/<id>/items' for a group's feed.

export async function addPost(path, me, text, seen) {
  const { fs, db: d } = await db();
  const body = cleanText(text, POST_MAX);
  if (!body) return;
  const post = { type: 'post', by: me.uid, name: me.name, text: body, at: Date.now(), likes: {} };
  if (seen) post.seen = [...new Set([me.uid, ...seen])].slice(0, 300);
  await fs.setDoc(fs.doc(d, `${path}/${newestFirstId()}`), post);
}

export async function watchPosts(uid, cb) {
  const { fs, db: d } = await db();
  const q = fs.query(fs.collection(d, 'posts'), fs.where('seen', 'array-contains', uid), fs.limit(FEED_SIZE));
  return fs.onSnapshot(q, (s) => cb(docsOf(s)), () => cb(null));
}

export async function setLike(path, id, uid, on) {
  const { fs, db: d } = await db();
  await fs.updateDoc(fs.doc(d, `${path}/${id}`), { [`likes.${uid}`]: on ? true : fs.deleteField() });
}

export async function deleteDocAt(path, id) {
  const { fs, db: d } = await db();
  await fs.deleteDoc(fs.doc(d, `${path}/${id}`));
}

export async function watchComments(path, id, cb) {
  const { fs, db: d } = await db();
  return fs.onSnapshot(fs.collection(d, `${path}/${id}/comments`), (s) => cb(docsOf(s).sort((a, b) => a.at - b.at)), () => cb([]));
}

export async function addComment(path, id, me, text) {
  const { fs, db: d } = await db();
  const body = cleanText(text, COMMENT_MAX);
  if (!body) return;
  const at = Date.now();
  await fs.setDoc(fs.doc(d, `${path}/${id}/comments/${at.toString(36)}${randomCode(4).toLowerCase()}`), { by: me.uid, name: me.name, text: body, at });
}

/* ---------- Groups ---------- */

async function rememberGroup(uid, g, on = true) {
  const { fs, db: d } = await db();
  await fs.setDoc(fs.doc(d, `users/${uid}`), { groups: on ? fs.arrayUnion(g) : fs.arrayRemove(g) }, { merge: true });
}

// The groups this person is in: [{ id, name, members: { uid: name } }]. A group that has since
// gone (or that they left on another device) is left out.
export async function myGroups(ids, uid) {
  const { fs, db: d } = await db();
  const found = await Promise.all(ids.map(async (id) => {
    try {
      const s = await fs.getDoc(fs.doc(d, `groups/${id}`));
      return s.exists() ? groupOf(id, s.data(), uid) : null;
    } catch { return null; }
  }));
  return found.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

function groupOf(id, g, uid) {
  const members = Object.keys(g.members || {}).filter((u) => g.members[u] === true)
    .map((u) => ({ uid: u, name: cleanPersonName(g.names?.[u]) || 'Someone' }))
    .sort((a, b) => (a.uid === uid ? -1 : b.uid === uid ? 1 : a.name.localeCompare(b.name)));
  return { id, name: cleanPersonName(g.name) || 'Group', members };
}

export async function watchGroup(id, uid, cb) {
  const { fs, db: d } = await db();
  const offs = [
    fs.onSnapshot(fs.doc(d, `groups/${id}`), (s) => cb({ group: s.exists() && s.data().members?.[uid] ? groupOf(id, s.data(), uid) : null }), () => cb({ group: null })),
    fs.onSnapshot(fs.collection(d, `groups/${id}/items`), (s) => cb({ items: docsOf(s) }), () => cb({ items: [] })),
  ];
  return () => offs.forEach((off) => off());
}

export async function startGroup(me, typed) {
  const { fs, db: d } = await db();
  const id = randomCode(20).toLowerCase();
  const name = cleanPersonName(typed).slice(0, GROUP_NAME_MAX) || 'Our group';
  await fs.setDoc(fs.doc(d, `groups/${id}`), { name, members: { [me.uid]: true }, names: { [me.uid]: me.name } });
  await rememberGroup(me.uid, id);
  return id;
}

export async function renameGroup(id, typed) {
  const { fs, db: d } = await db();
  const name = cleanPersonName(typed).slice(0, GROUP_NAME_MAX);
  if (name) await fs.updateDoc(fs.doc(d, `groups/${id}`), { name });
}

export async function createGroupInvite(id, uid) {
  const { fs, db: d } = await db();
  const code = randomCode(10);
  const expires = Date.now() + INVITE_DAYS * 864e5;
  await fs.setDoc(fs.doc(d, `groupInvites/${code}`), { group: id, by: uid, expires: fs.Timestamp.fromMillis(expires) });
  return { code, expires };
}

// Returns the group id, or 'nocode' / 'expired'.
export async function joinGroup(me, typed) {
  const { fs, db: d } = await db();
  const code = cleanCode(typed);
  if (code.length < 8) return 'nocode';
  const s = await fs.getDoc(fs.doc(d, `groupInvites/${code}`));
  if (!s.exists()) return 'nocode';
  const { group, expires } = s.data();
  if (expires.toMillis() < Date.now()) return 'expired';
  await fs.updateDoc(fs.doc(d, `groups/${group}`), { [`members.${me.uid}`]: true, [`names.${me.uid}`]: me.name, invite: code });
  await rememberGroup(me.uid, group);
  return group;
}

export async function leaveGroup(id, uid) {
  const { fs, db: d } = await db();
  await fs.updateDoc(fs.doc(d, `groups/${id}`), { [`members.${uid}`]: fs.deleteField(), [`names.${uid}`]: fs.deleteField() });
  await rememberGroup(uid, id, false);
}

// Plans, bucket list items and expenses in a group. Each is its own document.
export async function saveGroupItem(id, item) {
  const { fs, db: d } = await db();
  const itemId = item.id || newestFirstId();
  const { id: _, ...rest } = item;
  await fs.setDoc(fs.doc(d, `groups/${id}/items/${itemId}`), rest);
  return itemId;
}
