// Shared household sync: events, tasks, stars (and who earned them when), expenses, fridge items,
// thank-you notes, sticky notes and Fitbit numbers stay the same on every device.
//
// Everything is encrypted in the browser with the household passphrase before it leaves
// the device, so the database (Firebase Firestore) only ever holds scrambled data. The
// document's name is a hash of the passphrase, so nobody can find it without the passphrase.
//
// Each item carries an update time (`u`), and deletions leave a short note (`gone`), so two
// people editing at the same moment both keep their changes instead of one overwriting the other.

import FIREBASE_CONFIG from './sync-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const ITER = 310000;
const SALT = new TextEncoder().encode('home-dashboard household sync v1');

export const syncAvailable = () => !!(FIREBASE_CONFIG || window.HOME_SYNC_BACKEND);

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (v) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));

async function householdId(pass) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`home-dashboard:${pass}`));
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function householdKey(pass) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: SALT, iterations: ITER },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { v: 1, iv: b64(iv), data: b64(data) };
}
async function open(key, box) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

/* ---------- State <-> items ---------- */
const LISTS = { e: 'events', t: 'tasks', x: 'expenses', l: 'log', f: 'fridge', k: 'thanks', n: 'notes' };
const strip = ({ u, ...rest }) => rest;
// Items this version of the app reads and writes. Anything else in the household doc came from a
// newer version (a screen that hasn't reloaded since an update is still on the old one), so it is
// passed along untouched instead of being treated as deleted.
const managed = (k) => k === 'stars' || k.startsWith('h:') || (k.split(':')[0] in LISTS && k.includes(':'));
const same = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));

function toItems(state) {
  const items = {};
  for (const [p, list] of Object.entries(LISTS)) (state[list] || []).forEach((it) => { items[`${p}:${it.id}`] = it; });
  items.stars = { id: 'stars', value: state.stars || {} };
  // Each person's Fitbit numbers are their own item, so two people updating at once both stick.
  for (const [who, h] of Object.entries(state.health || {})) items[`h:${who}`] = { id: who, ...h };
  return items;
}
function applyItems(state, items) {
  for (const [p, list] of Object.entries(LISTS)) {
    // Keep the order items were added in.
    state[list] = Object.entries(items).filter(([k]) => k.startsWith(`${p}:`)).map(([, v]) => strip(v))
      .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  }
  state.stars = { ...(items.stars?.value || {}) };
  state.health = Object.fromEntries(Object.entries(items).filter(([k]) => k.startsWith('h:')).map(([, { id, ...h }]) => [id, strip(h)]));
}
function merge(a, b) {
  const gone = { ...a.gone };
  for (const [k, t] of Object.entries(b.gone || {})) gone[k] = Math.max(gone[k] || 0, t);
  const items = {};
  for (const k of new Set([...Object.keys(a.items || {}), ...Object.keys(b.items || {})])) {
    const x = a.items?.[k]; const y = b.items?.[k];
    const pick = !x ? y : !y ? x : (y.u || 0) > (x.u || 0) ? y : x;
    if (!(gone[k] >= (pick.u || 0))) items[k] = pick;
  }
  // Forget deletion notes after 60 days.
  const cutoff = Date.now() - 60 * 864e5;
  for (const k of Object.keys(gone)) if (gone[k] < cutoff) delete gone[k];
  return { items, gone };
}

const toItemsComparable = (items) => Object.keys(items).sort().map((k) => [k, strip(items[k])]);
const sameDoc = (a, b) => JSON.stringify(toItemsComparable(a.items)) === JSON.stringify(toItemsComparable(b.items))
  && JSON.stringify(Object.keys(a.gone || {}).sort()) === JSON.stringify(Object.keys(b.gone || {}).sort());

/* ---------- Backend (Firestore, or a stand-in for tests) ---------- */
let backendP = null;
function backend() {
  if (window.HOME_SYNC_BACKEND) return Promise.resolve(window.HOME_SYNC_BACKEND);
  backendP ||= (async () => {
    const [{ initializeApp }, fs] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-firestore.js`)]);
    const db = fs.getFirestore(initializeApp(FIREBASE_CONFIG));
    const ref = (id) => fs.doc(db, 'households', id);
    return {
      async read(id) { const s = await fs.getDoc(ref(id)); return s.exists() ? s.data() : null; },
      async update(id, fn) {
        return fs.runTransaction(db, async (tx) => {
          const s = await tx.get(ref(id));
          const next = await fn(s.exists() ? s.data() : null);
          tx.set(ref(id), next);
          return next;
        });
      },
      watch(id, cb, onErr) {
        return fs.onSnapshot(ref(id), (s) => { if (!s.metadata.hasPendingWrites) cb(s.exists() ? s.data() : null); }, onErr);
      },
    };
  })();
  return backendP;
}

/* ---------- Public API ---------- */
// status: off | connecting | new (no household yet for this passphrase) | ok | offline | badpass | error
export function createSync({ getState, onRemote, onStatus, onBase = () => {} }) {
  let id = null; let key = null; let base = null; let unwatch = null;
  let dirty = false; let pushing = false; let timer = null;
  const status = (s, extra = {}) => onStatus({ state: s, ...extra });

  // Work out what changed locally since the last sync: new or edited items get a fresh
  // time, and items that disappeared get a deletion note. Only items this version knows about
  // can be deleted, so an older app can never wipe out data it doesn't understand.
  function localDoc() {
    const now = Date.now();
    const items = toItems(getState());
    const gone = { ...(base?.gone || {}) };
    for (const [k, it] of Object.entries(items)) {
      const was = base?.items?.[k];
      items[k] = { ...it, u: was && same(was, it) ? was.u : now };
    }
    for (const [k, it] of Object.entries(base?.items || {})) {
      if (items[k]) continue;
      if (managed(k)) gone[k] = now;
      else items[k] = it; // kept as is, with its own update time
    }
    return { items, gone };
  }

  async function push() {
    if (!id || pushing) return;
    pushing = true; dirty = false;
    try {
      const mine = localDoc();
      // Nothing changed since the last sync (a tap that only opened a sheet, say).
      if (base && sameDoc(mine, base)) return;
      const be = await backend();
      let merged = null;
      await be.update(id, async (remote) => {
        merged = remote ? merge(await open(key, remote.box), mine) : mine;
        return { box: await seal(key, merged), at: Date.now() };
      });
      base = merged; onBase(base);
      // Bring in anything the other device changed at the same moment.
      if (JSON.stringify(toItemsComparable(merged.items)) !== JSON.stringify(toItemsComparable(mine.items))) {
        onRemote((state) => applyItems(state, merged.items));
      }
      status('ok', { at: Date.now() });
    } catch (e) {
      dirty = true;
      status(navigator.onLine === false ? 'offline' : 'error', { message: String(e?.message || e) });
    } finally {
      pushing = false;
      if (dirty && navigator.onLine !== false) schedule(5000);
    }
  }

  function schedule(ms = 700) {
    if (!id) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(push, ms);
  }

  async function watch() {
    const be = await backend();
    unwatch?.();
    unwatch = be.watch(id, async (remote) => {
      if (!remote || pushing || dirty) return;
      try {
        const doc = await open(key, remote.box);
        const local = base ? JSON.stringify(toItemsComparable(base.items)) : '';
        base = doc; onBase(base);
        if (JSON.stringify(toItemsComparable(doc.items)) !== local) onRemote((state) => applyItems(state, doc.items));
        status('ok', { at: Date.now() });
      } catch { status('badpass'); }
    }, () => status('offline'));
  }

  return {
    // Connect with a passphrase. Joins the household if it exists; otherwise reports 'new'.
    async connect(pass, { create = false } = {}) {
      status('connecting');
      try {
        id = await householdId(pass);
        key = await householdKey(pass);
        const be = await backend();
        const remote = await be.read(id);
        if (!remote && !create && !base) { id = null; status('new'); return 'new'; }
        if (remote) {
          let doc;
          try { doc = await open(key, remote.box); } catch { id = null; status('badpass'); return 'badpass'; }
          if (base) await push(); // this device synced before: merge in what changed here while away
          else { base = doc; onBase(base); onRemote((state) => applyItems(state, doc.items)); } // first join: take the household's data
        } else {
          await push(); // a brand new household starts from this device's data
        }
        await watch();
        if (!dirty) status('ok', { at: Date.now() });
        return 'ok';
      } catch (e) {
        status(navigator.onLine === false ? 'offline' : 'error', { message: String(e?.message || e) });
        return 'error';
      }
    },
    // Pick up again on page load with the saved passphrase and the last synced copy.
    resume(pass, savedBase) {
      base = savedBase || null;
      return this.connect(pass);
    },
    disconnect() { unwatch?.(); unwatch = null; id = null; key = null; base = null; onBase(null); clearTimeout(timer); status('off'); },
    changed: () => schedule(),
    retry: () => { if (id && dirty) push(); },
    get connected() { return !!id; },
  };
}
