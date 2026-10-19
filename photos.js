// Pictures on itinerary activities, bucket list check-ins and money receipts. A picture is far too big for the household document (which
// holds everything else and tops out at 1 MiB), so each one is shrunk on this device, kept here in
// IndexedDB, and sent to the household as its own document. Activities only carry the picture ids.

const DB = 'home-dashboard-photos';
const MAX_SIDE = 1280; // pixels on the longest side
const MAX_CHARS = 450000; // about 330 KB of JPEG, well inside a document even once encrypted

// The size a w×h picture is drawn at so its longest side is at most `max`.
export function fitSize(w, h, max = MAX_SIDE) {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

// A photo from the camera or the gallery, as a small JPEG data URL. Receipts ask for a bigger
// `side` so the small print stays readable; the size cap still holds.
export async function shrink(file, maxSide = MAX_SIDE) {
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!img) throw new Error("That file isn't a picture this screen can read");
  let side = maxSide; let q = 0.72; let out = '';
  for (let i = 0; i < 6; i++) {
    const { w, h } = fitSize(img.width, img.height, side);
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    out = c.toDataURL('image/jpeg', q);
    if (out.length <= MAX_CHARS) break;
    side = Math.round(side * 0.8); q = Math.max(0.5, q - 0.06);
  }
  img.close?.();
  return out;
}

/* ---------- This device's copy ---------- */
let dbP = null;
function db() {
  dbP ||= new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('p');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
  return dbP;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((ok, fail) => {
    const t = d.transaction('p', mode);
    const req = fn(t.objectStore('p'));
    t.oncomplete = () => ok(req?.result);
    t.onerror = () => fail(t.error);
  });
}
const local = {
  get: (id) => tx('readonly', (s) => s.get(id)).catch(() => null),
  put: (id, v) => tx('readwrite', (s) => s.put(v, id)).catch(() => null),
  del: (id) => tx('readwrite', (s) => s.delete(id)).catch(() => null),
  all: () => tx('readonly', (s) => s.getAllKeys()).catch(() => []),
};

/* ---------- Shared with the household ---------- */
// `sync` is the household sync (sync.js); pictures go wherever its household lives.
export function createPhotos(sync) {
  const mem = new Map(); // id -> data URL, for pictures already shown
  const loading = new Map();
  let unsent = true; // pictures from an earlier visit may still be waiting to go

  async function send(id, data) {
    try { if (await sync.putPhoto(id, data)) { await local.put(id, { data }); return true; } } catch { /* try again later */ }
    await local.put(id, { data, pending: true });
    unsent = true;
    return false;
  }
  return {
    // Keeps a new picture here and sends it to the household (later, if offline).
    async add(id, data) { mem.set(id, data); await local.put(id, { data, pending: true }); await send(id, data); },
    // A picture taken off an activity, or one whose activity was deleted.
    async drop(id) {
      mem.delete(id); await local.del(id);
      try { await sync.dropPhoto(id); } catch { /* the document just stays */ }
    },
    // The picture's data URL: from memory, this device, or the household. Null if it can't be found.
    get(id) {
      if (mem.has(id)) return Promise.resolve(mem.get(id));
      if (!loading.has(id)) {
        loading.set(id, (async () => {
          let data = (await local.get(id))?.data || null;
          if (!data) {
            try { data = await sync.getPhoto(id); } catch { data = null; }
            if (data) await local.put(id, { data });
          }
          if (data) mem.set(id, data);
          loading.delete(id);
          return data;
        })());
      }
      return loading.get(id);
    },
    peek: (id) => mem.get(id) || '',
    // Sends pictures added while offline or before this device joined a household.
    async flush() {
      if (!sync.connected || !unsent) return;
      unsent = false;
      for (const id of await local.all()) {
        const v = await local.get(id);
        if (v?.pending && !(await send(id, v.data))) return;
      }
    },
  };
}
