// Household accounts: sign in with Google, then start a household or join one with an invite code.
// Who may see a household is decided by the database's rules (firestore.rules), not by a shared
// passphrase, so a lost phone or a forgotten phrase never locks anyone out: signing in again on
// any device finds the household.
import { firebase, firebaseConfigured } from './firebase.js';
import { forgetSocial } from './social.js';

export const accountAvailable = () => firebaseConfigured();

// No look-alike letters or digits (0/O, 1/I/L), so a code read aloud or off a screen types right.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INVITE_DAYS = 7;
const randomCode = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
// What people type: any case, with spaces or dashes ("abcd-efgh").
export const cleanCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const showCode = (code) => code.replace(/(.{4})(?=.)/g, '$1-');

const person = (u) => (u ? { uid: u.uid, email: u.email || '', name: u.displayName || '' } : null);

// Calls back with the signed-in person (or null) now and whenever that changes.
export async function watchUser(cb) {
  const { auth, au } = await firebase();
  return auth.onAuthStateChanged(au, (u) => cb(person(u)));
}

export async function signIn() {
  const { auth, au } = await firebase();
  // Tests against the Firebase emulator sign in as a made-up person instead of opening Google.
  if (window.HOME_FIREBASE_EMULATOR && window.HOME_TEST_USER) {
    const t = window.HOME_TEST_USER;
    return person((await auth.signInWithCredential(au, auth.GoogleAuthProvider.credential(JSON.stringify({ sub: t, email: `${t}@example.com`, email_verified: true })))).user);
  }
  const provider = new auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    return person((await auth.signInWithPopup(au, provider)).user);
  } catch (e) {
    // Installed apps (the fridge screen) and some browsers block pop-ups: go to Google and back.
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'].includes(e?.code)) {
      await auth.signInWithRedirect(au, provider);
      return null;
    }
    if (e?.code === 'auth/popup-closed-by-user') return null;
    throw e;
  }
}

export async function signOut() {
  const { auth, au } = await firebase();
  await auth.signOut(au);
}

// The household this person last used, if any.
export async function myHome(uid) {
  const { fs, db } = await firebase();
  const s = await fs.getDoc(fs.doc(db, `users/${uid}`));
  return s.exists() ? s.data().home || null : null;
}

// Every household this person belongs to, with names: [{ id, name }]. Accounts from before
// there could be several only have `home`, so it is always counted. A household that has
// since removed them (or no longer exists) is left out.
export async function myHomes(uid) {
  const { fs, db } = await firebase();
  const s = await fs.getDoc(fs.doc(db, `users/${uid}`));
  const d = s.exists() ? s.data() : {};
  const ids = [...new Set([...(d.homes || []), d.home].filter(Boolean))];
  const found = await Promise.all(ids.map(async (id) => {
    try {
      const h = await fs.getDoc(fs.doc(db, `homes/${id}`));
      return h.exists() ? { id, name: h.data().name || 'Home' } : null;
    } catch { return null; }
  }));
  return found.filter(Boolean);
}

// Adds a household to this person's list and makes it the one they use now. Merged in, so the
// other households on the list stay.
async function remember(uid, home) {
  const { fs, db } = await firebase();
  await fs.setDoc(fs.doc(db, `users/${uid}`), { home, homes: fs.arrayUnion(home) }, { merge: true });
}

// Switching households: the one this person opens next time they sign in on a new device.
export async function useHomeFor(uid, home) {
  const { fs, db } = await firebase();
  await fs.setDoc(fs.doc(db, `users/${uid}`), { home }, { merge: true });
}

export async function renameHome(home, name) {
  const { fs, db } = await firebase();
  await fs.updateDoc(fs.doc(db, `homes/${home}`), { name });
}

// The household's summary email ({ on, to: [addresses], tz, lat, lon, unit }), or null if it was
// never set. A GitHub job reads it to know who to email and when (sync/daily_email.py).
export async function homeEmail(home) {
  const { fs, db } = await firebase();
  const s = await fs.getDoc(fs.doc(db, `homes/${home}`));
  return s.exists() ? s.data().email || null : null;
}

export async function saveHomeEmail(home, email) {
  const { fs, db } = await firebase();
  await fs.updateDoc(fs.doc(db, `homes/${home}`), { email });
}

// Who an account is on the household's list of signed-in accounts, so everyone in it can see
// who joined and when. Any member may change the list (the rules let members remove people).
const accountEntry = (u, fs) => ({ name: String(u.name || '').slice(0, 60), email: String(u.email || '').slice(0, 100), joined: fs.serverTimestamp() });

// A new household with this person as its only member.
export async function startHome(u, name = 'Home') {
  const { fs, db } = await firebase();
  const home = randomCode(20).toLowerCase();
  await fs.setDoc(fs.doc(db, `homes/${home}`), { members: { [u.uid]: true }, accounts: { [u.uid]: accountEntry(u, fs) }, name });
  await remember(u.uid, home);
  return home;
}

// A code that lets someone else join this household for the next week.
export async function createInvite(home, uid) {
  const { fs, db } = await firebase();
  const code = randomCode(10);
  const expires = Date.now() + INVITE_DAYS * 864e5;
  await fs.setDoc(fs.doc(db, `invites/${code}`), { home, by: uid, expires: fs.Timestamp.fromMillis(expires) });
  return { code, expires };
}

// Adds this person to the household the invite is for. Returns the household id, or
// 'nocode' / 'expired' when the code doesn't work.
export async function joinWithCode(u, typed) {
  const { fs, db } = await firebase();
  const code = cleanCode(typed);
  if (code.length < 8) return 'nocode';
  const s = await fs.getDoc(fs.doc(db, `invites/${code}`));
  if (!s.exists()) return 'nocode';
  const { home, expires } = s.data();
  if (expires.toMillis() < Date.now()) return 'expired';
  await joinHome(u, home, code);
  // A code works once. Rules published before this change don't allow it; the code then
  // simply runs out after its week, as before.
  await fs.deleteDoc(fs.doc(db, `invites/${code}`)).catch(() => {});
  return home;
}

// Joining with a code already known to be for this household (a passphrase household that
// moved to sign-in leaves one behind for its other screens).
export async function joinHome(u, home, code) {
  const { fs, db } = await firebase();
  const ref = fs.doc(db, `homes/${home}`);
  // Already a member (a screen following a move, or a code typed twice)? Then this isn't joining,
  // and the date they first joined stays.
  let had = false;
  try { had = !!(await fs.getDoc(ref)).data()?.members?.[u.uid]; } catch { had = false; } // not a member yet: can't read it
  // Members can't add people, but someone not in the household yet can add themselves
  // with a live invite. Already a member? The update simply changes nothing.
  await fs.updateDoc(ref, { [`members.${u.uid}`]: true, invite: code });
  // Now a member, they add themselves to the list everyone sees. A separate write, so joining
  // works with the rules as already published.
  if (!had) await fs.updateDoc(ref, { [`accounts.${u.uid}`]: accountEntry(u, fs) }).catch(() => {});
  await remember(u.uid, home);
}

// Calls back with the household's record ({ members, accounts, name, ... }) now and whenever it
// changes, or with null once this account can no longer see it (removed, or it was deleted).
export async function watchHome(home, cb) {
  const { fs, db } = await firebase();
  // Offline with nothing saved yet looks like "no such household": wait for the server instead.
  return fs.onSnapshot(fs.doc(db, `homes/${home}`), (s) => cb(s.exists() ? s.data() : s.metadata.fromCache ? undefined : null),
    (e) => cb(e?.code === 'permission-denied' ? null : undefined));
}

// Keeps this account's name and email on the household's list up to date (accounts that joined
// before the list existed get added the first time they open the app). Their join date isn't
// known, so none is made up.
export async function noteAccount(home, u, rec) {
  const had = rec?.accounts?.[u.uid];
  const name = String(u.name || '').slice(0, 60); const email = String(u.email || '').slice(0, 100);
  if (!rec?.members?.[u.uid] || had && had.name === name && had.email === email) return;
  const { fs, db } = await firebase();
  await fs.updateDoc(fs.doc(db, `homes/${home}`), { [`accounts.${u.uid}.name`]: name, [`accounts.${u.uid}.email`]: email });
}

// Takes an account out of the household: it can no longer see or change anything in it. What
// they added stays. They can only come back with a new invite code.
export async function removeAccount(home, uid) {
  const { fs, db } = await firebase();
  await fs.updateDoc(fs.doc(db, `homes/${home}`), { [`members.${uid}`]: fs.deleteField(), [`accounts.${uid}`]: fs.deleteField() });
}

/* ---------- Deleting an account ---------- */

// What deleting an account does to each household this person is in: one nobody else is in
// goes with everything in it; any other stays as it is for the others and just loses this
// person. homes: [{ id, name, members: { uid: true } }] -> [{ id, name, others, gone }]
export function homesAfterLeaving(homes, uid) {
  return homes.filter((h) => h.members?.[uid]).map((h) => {
    const others = Object.keys(h.members).filter((m) => m !== uid && h.members[m]).length;
    return { id: h.id, name: h.name || 'Home', others, gone: others === 0 };
  });
}

// The summary email setting with this address taken off its list, or null if it isn't on it.
export function emailWithout(email, address) {
  const a = String(address || '').toLowerCase();
  if (!a || !email?.to?.some((t) => String(t).toLowerCase() === a)) return null;
  return { ...email, to: email.to.filter((t) => String(t).toLowerCase() !== a) };
}

async function homesOf(uid) {
  const { fs, db } = await firebase();
  const s = await fs.getDoc(fs.doc(db, `users/${uid}`));
  const d = s.exists() ? s.data() : {};
  const ids = [...new Set([...(d.homes || []), d.home].filter(Boolean))];
  const homes = await Promise.all(ids.map(async (id) => {
    try {
      const h = await fs.getDoc(fs.doc(db, `homes/${id}`));
      return h.exists() ? { id, ...h.data() } : null;
    } catch { return null; } // no longer in it
  }));
  return { me: d, homes: homes.filter(Boolean) };
}

// For the confirmation: what happens to each household.
export async function deletionPreview(uid) {
  return homesAfterLeaving((await homesOf(uid)).homes, uid);
}

// Google asks the person to pick their account again, because deleting an account needs a
// fresh sign-in. 'ok', 'cancelled', or 'blocked' when this screen can't show the Google window
// (the deletion then tries anyway).
export async function confirmIdentity() {
  const { auth, au } = await firebase();
  const u = au.currentUser;
  if (!u) return 'cancelled';
  if (window.HOME_FIREBASE_EMULATOR && window.HOME_TEST_USER) {
    const t = window.HOME_TEST_USER;
    await auth.reauthenticateWithCredential(u, auth.GoogleAuthProvider.credential(JSON.stringify({ sub: t, email: `${t}@example.com` })));
    return 'ok';
  }
  const provider = new auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account', login_hint: u.email || '' });
  try {
    await auth.reauthenticateWithPopup(u, provider);
    return 'ok';
  } catch (e) {
    if (['auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(e?.code)) return 'cancelled';
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(e?.code)) return 'blocked';
    throw e; // auth/user-mismatch: they picked a different account
  }
}

// Deletes everything that is this person's own: their sign-in, which households they are in,
// their Friends name, code, friendships, posts and comments, and every household and group
// only they are in. A household or group others still use stays as it is for them, minus this
// person. Safe to run again if it stops halfway. Returns 'done', or 'relogin' when everything
// is deleted except the sign-in itself, which needs a fresh sign-in first.
export async function deleteAccount(uid, address) {
  const { fs, db, auth, au } = await firebase();
  const { me, homes } = await homesOf(uid);
  await forgetSocial(uid, me.groups || [], me.social?.code || '');

  for (const h of homes) {
    if (!h.members?.[uid]) continue;
    const ref = fs.doc(db, `homes/${h.id}`);
    if (homesAfterLeaving([h], uid)[0].gone) {
      // Its data and pictures, then the household itself. Rules published before deleting
      // accounts existed only let the last person leave, which still leaves nothing behind.
      for (const x of (await fs.getDocs(fs.collection(db, `homes/${h.id}/data`))).docs) await fs.deleteDoc(x.ref);
      try { await fs.deleteDoc(ref); continue; } catch { /* leave it instead */ }
      await fs.updateDoc(ref, { [`members.${uid}`]: fs.deleteField() });
      continue;
    }
    const patch = { [`members.${uid}`]: fs.deleteField(), [`accounts.${uid}`]: fs.deleteField() };
    const email = emailWithout(h.email, address);
    if (email) patch.email = email;
    await fs.updateDoc(ref, patch);
  }

  await fs.deleteDoc(fs.doc(db, `users/${uid}`));
  try {
    if (au.currentUser?.uid === uid) await auth.deleteUser(au.currentUser);
  } catch (e) {
    if (e?.code === 'auth/requires-recent-login') return 'relogin';
    throw e;
  }
  return 'done';
}
