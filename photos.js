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
    // Forgets every picture kept on this device (after deleting an account).
    async clearHere() { mem.clear(); for (const id of await local.all()) await local.del(id); },
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

/* ---------- Month collage ---------- */
// One picture made of a month's bucket list check-ins, each cropped square and laid out in a grid
// around the month's love points, which always sit in the middle. It is drawn on this screen
// whenever it's opened, so nothing new is stored or synced.
export const COLLAGE_MAX = 32; // pictures; a busy month keeps each check-in's first picture first

// The grid for n pictures plus the love points square in the middle. On a side with an even
// number of squares there is no single middle one, so the love points take the two middle squares
// on that side (a 2×2 block when both are even). Picks the grid with the fewest spare squares,
// then the most square one, never more than two apart.
export function collageGrid(n) {
  let best = null;
  for (let rows = 1; rows <= 9; rows++) {
    for (let cols = rows; cols <= rows + 2; cols++) {
      const span = { cols: cols % 2 ? 1 : 2, rows: rows % 2 ? 1 : 2 };
      if (span.cols > cols || span.rows > rows) continue;
      const spare = cols * rows - span.cols * span.rows - n;
      if (spare < 0) continue;
      const score = spare * 10 + (cols - rows);
      if (!best || score < best.score) best = { cols, rows, span, score };
    }
  }
  const { cols, rows, span } = best;
  return { cols, rows, mid: { col: (cols - span.cols) / 2, row: (rows - span.rows) / 2, ...span } };
}
// Every square of the grid in reading order, as 'pic' or 'spare', leaving out the middle block.
export function collageCells(n) {
  const { cols, rows, mid } = collageGrid(n);
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r >= mid.row && r < mid.row + mid.rows && c >= mid.col && c < mid.col + mid.cols) continue;
      out.push({ col: c, row: r, kind: out.filter((x) => x.kind === 'pic').length < n ? 'pic' : 'spare' });
    }
  }
  return out;
}

// Which pictures go in: every picture of every check-in when they fit, otherwise the first of
// each check-in, then the rest in turn, up to COLLAGE_MAX. Items are [{ text, photos: [ids] }].
export function collagePick(items, max = COLLAGE_MAX) {
  const out = [];
  for (let round = 0; out.length < max; round++) {
    const more = items.filter((it) => it.photos[round]);
    if (!more.length) break;
    for (const it of more) if (out.length < max) out.push({ id: it.photos[round], text: round ? '' : it.text });
  }
  return out;
}

// Draws the collage. `tiles` are [{ data (data URL or null), text }]; `head` is the title, `love`
// goes in the middle, and `colors` come from the page so the picture matches the palette.
export async function drawCollage(tiles, { head, love = 0, colors, size = 1080 }) {
  const { cols, rows, mid } = collageGrid(tiles.length);
  const pad = 18; const gap = 8; const band = 108;
  const cell = Math.floor((size - pad * 2 - gap * (cols - 1)) / cols);
  const h = band + rows * cell + (rows - 1) * gap + pad;
  const c = Object.assign(document.createElement('canvas'), { width: size, height: h });
  const g = c.getContext('2d');
  const font = (w, px) => `${w} ${px}px Archivo, "Segoe UI", system-ui, sans-serif`;
  const at = (col, row) => [pad + col * (cell + gap), band + row * (cell + gap)];
  const box = (x, y, w, hh, r = 14) => { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, hh, r) : g.rect(x, y, w, hh); };
  g.fillStyle = colors.bg; g.fillRect(0, 0, size, h);
  g.fillStyle = colors.ink; g.font = font(600, 52); g.textBaseline = 'alphabetic';
  g.fillText(head, pad + 4, 76);

  // The love points in the middle.
  {
    const [x, y] = at(mid.col, mid.row);
    const w = mid.cols * cell + (mid.cols - 1) * gap; const hh = mid.rows * cell + (mid.rows - 1) * gap;
    const s = Math.min(w, hh); const cx = x + w / 2; const top = y + (hh - s) / 2;
    g.fillStyle = colors.sub; box(x, y, w, hh); g.fill();
    g.fillStyle = colors.on; g.textAlign = 'center';
    g.font = font(600, Math.round(s / 4)); g.fillText('♥', cx, top + s * 0.44);
    g.font = font(600, Math.round(s / 5.2)); g.fillText(String(love), cx, top + s * 0.7);
    g.font = font(500, Math.round(s / 12)); g.fillText('love points', cx, top + s * 0.84);
    g.textAlign = 'left';
  }

  const imgs = await Promise.all(tiles.map(async (t) => (t.data ? createImageBitmap(await (await fetch(t.data)).blob()).catch(() => null) : null)));
  let i = 0;
  for (const sq of collageCells(tiles.length)) {
    const [x, y] = at(sq.col, sq.row);
    g.save(); box(x, y, cell, cell); g.clip();
    const img = sq.kind === 'pic' ? imgs[i] : null; const t = sq.kind === 'pic' ? tiles[i++] : null;
    if (img) {
      const s = Math.min(img.width, img.height); // centre crop to a square
      g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, x, y, cell, cell);
    } else { // a spare square, or a picture that couldn't be read: a soft square with a faint heart
      g.fillStyle = colors.soft; g.fillRect(x, y, cell, cell);
      g.fillStyle = colors.sub; g.globalAlpha = 0.3; g.textAlign = 'center';
      g.font = font(600, Math.round(cell / 5)); g.fillText('♥', x + cell / 2, y + cell * 0.6);
      g.globalAlpha = 1; g.textAlign = 'left';
    }
    if (img && t.text) { // the item's name on its first picture, on a soft shade so it reads on anything
      const fs = Math.max(16, Math.round(cell / 11));
      const grad = g.createLinearGradient(0, y + cell * 0.55, 0, y + cell);
      grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,.62)');
      g.fillStyle = grad; g.fillRect(x, y + cell * 0.55, cell, cell * 0.45);
      g.fillStyle = '#fff'; g.font = font(600, fs);
      let label = t.text;
      while (label.length > 1 && g.measureText(label).width > cell - fs * 1.4) label = label.slice(0, -1);
      if (label !== t.text) label = `${label.trimEnd()}…`;
      g.fillText(label, x + fs * 0.7, y + cell - fs * 0.8);
    }
    g.restore();
    img?.close?.();
  }
  return c.toDataURL('image/jpeg', 0.86);
}
