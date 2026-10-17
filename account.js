// Household accounts: sign in with Google, then start a household or join one with an invite code.
// Who may see a household is decided by the database's rules (firestore.rules), not by a shared
// passphrase, so a lost phone or a forgotten phrase never locks anyone out: signing in again on
// any device finds the household.
import { firebase, firebaseConfigured } from './firebase.js';

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
    return person((await auth.signInWithCredential(au, auth.GoogleAuthProvider.credential(JSON.stringify({ sub: t, email: `${t}@example.com` })))).user);
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

// A new household with this person as its only member.
export async function startHome(uid, name = 'Home') {
  const { fs, db } = await firebase();
  const home = randomCode(20).toLowerCase();
  await fs.setDoc(fs.doc(db, `homes/${home}`), { members: { [uid]: true }, name });
  await remember(uid, home);
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
export async function joinWithCode(uid, typed) {
  const { fs, db } = await firebase();
  const code = cleanCode(typed);
  if (code.length < 8) return 'nocode';
  const s = await fs.getDoc(fs.doc(db, `invites/${code}`));
  if (!s.exists()) return 'nocode';
  const { home, expires } = s.data();
  if (expires.toMillis() < Date.now()) return 'expired';
  await joinHome(uid, home, code);
  // A code works once. Rules published before this change don't allow it; the code then
  // simply runs out after its week, as before.
  await fs.deleteDoc(fs.doc(db, `invites/${code}`)).catch(() => {});
  return home;
}

// Joining with a code already known to be for this household (a passphrase household that
// moved to sign-in leaves one behind for its other screens).
export async function joinHome(uid, home, code) {
  const { fs, db } = await firebase();
  // Members can't add people, but someone not in the household yet can add themselves
  // with a live invite. Already a member? The update simply changes nothing.
  await fs.updateDoc(fs.doc(db, `homes/${home}`), { [`members.${uid}`]: true, invite: code });
  await remember(uid, home);
}
