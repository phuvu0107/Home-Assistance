// Shared household sync: the household's people, events, tasks, stars (and who earned them when), expenses, fridge items,
// thank-you notes, sticky notes, itinerary and Fitbit numbers stay the same on every device.
//
// A household signed in with Google keeps its data at homes/{home}/data/main in Firebase
// Firestore, and the database's rules (firestore.rules) let only its members read or change it.
// Older households were found and unlocked by a passphrase instead: their data is encrypted in
// the browser before it leaves the device, and the document's name is a hash of the passphrase.
// Those keep working until every screen has moved to sign-in.
//
// Each item carries an update time (`u`), and deletions leave a short note (`gone`), so two
// people editing at the same moment both keep their changes instead of one overwriting the other.

import { firebase, firebaseConfigured } from './firebase.js';

const ITER = 310000;
const SALT = new TextEncoder().encode('home-dashboard household sync v1');

export const syncAvailable = () => !!(firebaseConfigured() || window.HOME_SYNC_BACKEND);

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
// How a signed-in household's data is stored: as text, since Firestore can't hold every shape
// the app uses (lists inside lists, say). The rules keep it to the household's members.
const plainCodec = { seal: async (obj) => ({ v: 2, json: JSON.stringify(obj) }), open: async (box) => JSON.parse(box.json) };
const passCodec = (key) => ({ seal: (obj) => seal(key, obj), open: (box) => open(key, box) });
// Where a household's data lives: a passphrase household by its hash, a signed-in one by its id.
const passPath = (id) => `households/${id}`;
const homePath = (home) => `homes/${home}/data/main`;
// Itinerary pictures are too big for the household's one document, so each is a document of its
// own beside it: in a signed-in household under homes/{home}/data, which the rules already keep to
// its members; in a passphrase household named by a hash, like the household itself, and sealed
// with the same key.
async function photoPath(path, id) {
  if (!path.startsWith('households/')) return path.replace(/\/main$/, `/photo-${id}`);
  return passPath(await householdId(`${path}:photo:${id}`));
}

/* ---------- State <-> items ---------- */
const LISTS = { e: 'events', t: 'tasks', x: 'expenses', l: 'log', f: 'fridge', k: 'thanks', n: 'notes', b: 'bucket', p: 'members', i: 'itinerary', g: 'shopping' };
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
    const { fs, db } = await firebase();
    const ref = (path) => fs.doc(db, path);
    return {
      async read(path) { const s = await fs.getDoc(ref(path)); return s.exists() ? s.data() : null; },
      async update(path, fn) {
        return fs.runTransaction(db, async (tx) => {
          const s = await tx.get(ref(path));
          const next = await fn(s.exists() ? s.data() : null);
          tx.set(ref(path), next);
          return next;
        });
      },
      watch(path, cb, onErr) {
        return fs.onSnapshot(ref(path), (s) => { if (!s.metadata.hasPendingWrites) cb(s.exists() ? s.data() : null); }, onErr);
      },
      // Marks an old passphrase household as moved, leaving its data where it is.
      async mark(path, fields) { await fs.setDoc(ref(path), fields, { merge: true }); },
    };
  })();
  return backendP;
}

// Firestore refuses a document over 1 MiB. The sealed data is checked against a little less
// before writing, so a full household is reported as full rather than as a vague error.
export const SYNC_LIMIT = 1040000;
// Firestore's own refusals of an oversized document, in case one slips past that check.
const TOO_BIG = /exceeds the maximum allowed size|is longer than \d+ bytes|invalid nested entity/i;

/* ---------- Public API ---------- */
// status: off | connecting | new (no household yet for this passphrase) | ok | offline | badpass
//         | moved (this passphrase household moved to sign-in; extra: { home, invite }) | error
//         | full (the household's data has reached the 1 MiB cap and changes here can't be sent)
// ok also carries size: how many bytes the household's data took up at the last sync.
export function createSync({ getState, onRemote, onStatus, onBase = () => {} }) {
  let path = null; let codec = null; let key = null; let base = null; let unwatch = null;
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

  async function push(force = false) {
    if (!path || pushing) return;
    pushing = true; dirty = false;
    try {
      const mine = localDoc();
      // Nothing changed since the last sync (a tap that only opened a sheet, say).
      if (!force && base && sameDoc(mine, base)) return;
      const be = await backend();
      let merged = null; let size = 0;
      await be.update(path, async (remote) => {
        merged = remote ? merge(await codec.open(remote.box), mine) : mine;
        const box = await codec.seal(merged);
        size = JSON.stringify(box).length; // sealed data is plain ASCII, so characters are bytes
        if (size > SYNC_LIMIT) throw Object.assign(new Error('Household data is full'), { full: true });
        return { box, at: Date.now() };
      });
      base = merged; onBase(base);
      // Bring in anything the other device changed at the same moment.
      if (JSON.stringify(toItemsComparable(merged.items)) !== JSON.stringify(toItemsComparable(mine.items))) {
        onRemote((state) => applyItems(state, merged.items));
      }
      status('ok', { at: Date.now(), size });
    } catch (e) {
      dirty = true;
      const message = String(e?.message || e);
      // The whole household shares one database document, which can't grow past 1 MiB.
      status(navigator.onLine === false ? 'offline' : e?.full || TOO_BIG.test(message) ? 'full' : 'error', { message });
    } finally {
      pushing = false;
      if (dirty && navigator.onLine !== false) schedule(5000);
    }
  }

  function schedule(ms = 700) {
    if (!path) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(push, ms);
  }

  // A passphrase household that moved to sign-in says where to, sealed with the passphrase.
  async function movedTo(remote) {
    if (!remote?.moved || !key) return null;
    try { return await open(key, remote.moved); } catch { return {}; }
  }
  function stop() { unwatch?.(); unwatch = null; path = null; codec = null; clearTimeout(timer); }

  async function watch() {
    const be = await backend();
    unwatch?.();
    const watching = path;
    unwatch = be.watch(path, async (remote) => {
      if (!remote || pushing || dirty || path !== watching) return;
      const moved = await movedTo(remote);
      if (moved) { stop(); status('moved', moved); return; }
      try {
        const doc = await codec.open(remote.box);
        const local = base ? JSON.stringify(toItemsComparable(base.items)) : '';
        base = doc; onBase(base);
        if (JSON.stringify(toItemsComparable(doc.items)) !== local) onRemote((state) => applyItems(state, doc.items));
        status('ok', { at: Date.now(), size: JSON.stringify(remote.box).length });
      } catch { status(key ? 'badpass' : 'error'); }
    }, () => status('offline'));
  }

  // Joins the household at `where` if it exists; otherwise starts it from this device's data
  // when `create` is set, or reports 'new'.
  async function attach(where, how, { create = false } = {}) {
    status('connecting');
    try {
      path = where; codec = how;
      const be = await backend();
      const remote = await be.read(path);
      const moved = await movedTo(remote);
      if (moved) { stop(); status('moved', moved); return 'moved'; }
      if (!remote && !create && !base) { stop(); status('new'); return 'new'; }
      if (remote) {
        let doc;
        try { doc = await codec.open(remote.box); } catch { stop(); status(key ? 'badpass' : 'error'); return key ? 'badpass' : 'error'; }
        if (base) await push(); // this device synced before: merge in what changed here while away
        else { base = doc; onBase(base); onRemote((state) => applyItems(state, doc.items)); } // first join: take the household's data
      } else {
        await push(true); // a brand new household starts from this device's data, even if nothing changed here
      }
      await watch();
      if (!dirty) status('ok', { at: Date.now() });
      return 'ok';
    } catch (e) {
      status(navigator.onLine === false ? 'offline' : 'error', { message: String(e?.message || e) });
      return 'error';
    }
  }

  return {
    // Connect with a passphrase (households from before sign-in).
    async connect(pass, opts) {
      key = await householdKey(pass);
      return attach(passPath(await householdId(pass)), passCodec(key), opts);
    },
    // Connect to a signed-in household. A new household starts from this device's data.
    connectHome(home, { fresh = false, create = true } = {}) {
      key = null;
      if (fresh) { base = null; onBase(null); } // joining someone else's: take theirs, don't merge ours in
      return attach(homePath(home), plainCodec, { create });
    },
    // Switching to another household this person belongs to. Anything not yet sent to the one
    // being left goes first; then this device takes the other household's data. Never creates:
    // a household with no data yet must not be filled with the one being left.
    async switchHome(home) {
      if (!(await this.leave())) return 'offline'; // couldn't send it: stay put rather than lose it
      return this.connectHome(home, { fresh: true, create: false });
    },
    // Stops syncing once anything not yet sent has gone. False (still syncing) if it couldn't go.
    async leave() {
      // Let a sync under way land, then send what's left. A sync can bring in changes that the app
      // tidies and sends straight back, so this takes a few rounds at most.
      for (let i = 0; i < 4 && path && (pushing || dirty); i++) {
        while (pushing) await new Promise((r) => setTimeout(r, 100));
        if (dirty) { clearTimeout(timer); await push(); }
      }
      if (path && (pushing || dirty)) return false;
      this.disconnect();
      return true;
    },
    // Moving a passphrase household to sign-in: everything synced here goes to the new household,
    // and the old one is marked moved (its data stays where it is) so its other screens follow.
    async moveTo(home, invite) {
      if (!key || !path) throw new Error('Not on a passphrase household');
      const old = path; const oldKey = key;
      if (dirty) await push();
      const r = await this.connectHome(home);
      if (r !== 'ok') return r;
      // Only send the other screens over once the household's data is really there.
      const be = await backend();
      if (!(await be.read(homePath(home)))?.box) return 'error';
      await be.mark(old, { moved: await seal(oldKey, { home, invite }), movedAt: Date.now() });
      return 'ok';
    },
    // Pick up again on page load with the saved passphrase and the last synced copy.
    resume(pass, savedBase) {
      base = savedBase || null;
      return this.connect(pass);
    },
    resumeHome(home, savedBase) {
      base = savedBase || null;
      return this.connectHome(home);
    },
    // One itinerary picture. False when this device isn't syncing with a household right now.
    async putPhoto(id, data) {
      if (!path) return false;
      const be = await backend(); const at = path; const how = codec;
      const box = await how.seal({ photo: data });
      await be.update(await photoPath(at, id), async () => ({ box, at: Date.now() }));
      return true;
    },
    async getPhoto(id) {
      if (!path) return null;
      const be = await backend(); const how = codec;
      const doc = await be.read(await photoPath(path, id));
      return doc?.box ? (await how.open(doc.box)).photo || null : null;
    },
    // A passphrase household's documents can't be deleted, so a removed picture is emptied instead.
    async dropPhoto(id) {
      if (!path) return;
      const be = await backend();
      await be.update(await photoPath(path, id), async () => ({ gone: true, at: Date.now() }));
    },
    disconnect() { stop(); key = null; base = null; onBase(null); status('off'); },
    changed: () => schedule(),
    retry: () => { if (path && dirty) push(); },
    get connected() { return !!path; },
    get mode() { return !path ? null : key ? 'pass' : 'home'; },
  };
}
