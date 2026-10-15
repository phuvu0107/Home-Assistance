// One Firebase app for the whole page: the household database (sync.js) and sign-in (account.js).
// The SDK loads on first use, so a screen that never syncs never downloads it.
import FIREBASE_CONFIG from './sync-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

export const firebaseConfigured = () => !!FIREBASE_CONFIG;

let fbP = null;
export function firebase() {
  fbP ||= (async () => {
    const [{ initializeApp }, fs, auth] = await Promise.all([
      import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-firestore.js`), import(`${SDK}/firebase-auth.js`)]);
    const app = initializeApp(FIREBASE_CONFIG);
    const db = fs.getFirestore(app);
    const au = auth.getAuth(app);
    // Local testing against the Firebase emulators (see tests/rules.emulator.mjs).
    if (window.HOME_FIREBASE_EMULATOR) {
      fs.connectFirestoreEmulator(db, '127.0.0.1', 8080);
      auth.connectAuthEmulator(au, 'http://127.0.0.1:9099', { disableWarnings: true });
    }
    return { app, fs, db, auth, au };
  })();
  return fbP;
}
