// Fridge helpers: categories, and turning a photo of a grocery receipt into fridge items or,
// for Money, into an expense.
// Text recognition runs in the browser with Tesseract.js, so the photo never leaves the device.

// Days an item usually keeps, used for the suggested use-by date. Blank means no suggestion.
export const FRIDGE_CATS = [
  { id: 'produce', label: 'Fruit & veg', icon: 'leaf', days: 7 },
  { id: 'dairy', label: 'Dairy & eggs', icon: 'egg', days: 10 },
  { id: 'meat', label: 'Meat & fish', icon: 'drumstick', days: 3 },
  { id: 'leftovers', label: 'Leftovers', icon: 'bowl', days: 4 },
  { id: 'drinks', label: 'Drinks', icon: 'cup', days: 0 },
  { id: 'other', label: 'Other', icon: 'box', days: 0 },
];

const CAT_WORDS = {
  produce: 'apple banana berry berries strawberry blueberry raspberry grape lemon lime orange mandarin avocado tomato potato onion garlic ginger carrot celery lettuce romaine spinach arugula kale cabbage broccoli cauliflower cucumber pepper chive zucchini squash mushroom herb cilantro basil parsley scallion mango pear peach plum cherry melon watermelon pineapple kiwi corn bean sprout bok choy yuchoy cai bac salad fruit veg produce rau hanh',
  dairy: 'milk egg eggs cheese yogurt yoghurt butter cream creamer kefir mozzarella cheddar parmesan sour half tofu',
  meat: 'chicken beef pork lamb turkey steak bacon sausage ham salmon tuna shrimp fish prawn squid crab ground thigh breast wing rib meat seafood muc octopus',
  leftovers: 'deli rotisserie soup dumpling sushi meal kit pizza pasta',
  drinks: 'juice water soda sparkling coke pepsi beer wine kombucha tea coffee drink lemonade',
};
export function guessCat(name) {
  // Plurals count too: strawberries -> strawberry, eggs -> egg.
  const words = name.toLowerCase().split(/[^a-z]+/).flatMap((w) => [w, w.replace(/ies$/, 'y'), w.replace(/e?s$/, '')]);
  for (const [cat, list] of Object.entries(CAT_WORDS)) {
    const set = list.split(' ');
    if (words.some((w) => w && set.some((k) => w === k || (k.length > 3 && w.startsWith(k))))) return cat;
  }
  return 'other';
}

// Short forms that grocery receipts use.
const SHORT = {
  org: 'Organic', ks: 'Kirkland', grn: 'Green', chkn: 'Chicken', chk: 'Chicken', bnls: 'Boneless', sknls: 'Skinless',
  brst: 'Breast', mlk: 'Milk', whl: 'Whole', yog: 'Yogurt', ygrt: 'Yogurt', strwbry: 'Strawberry', strawb: 'Strawberries',
  bnna: 'Banana', bana: 'Banana', tom: 'Tomato', pot: 'Potato', grnd: 'Ground', bf: 'Beef', lg: 'Large', sm: 'Small',
  btr: 'Butter', chs: 'Cheese', ckn: 'Chicken', veg: 'Veg', frz: 'Frozen', avo: 'Avocado', avoc: 'Avocado', lttc: 'Lettuce',
};

// Lines that are never groceries: totals, payment, store details.
const NOT_ITEM = /\b(sub ?total|total|tax|balance|change|cash|visa|master ?card|amex|discover|debit|credit|card|tender|payment|paid|approved|auth|member|savings?|you saved|discount|coupon|instant|receipt|thank|store|phone|tel|www|cashier|items? sold|refund|account|chip|pin|tip|date|time|survey|rewards?|points|deposit|crv|bag fee|bags?|qty|price|amount|due|ref|trans|terminal|merchant|aid|seq|invoice|order|welcome)\b|\.com|@|\/lb|\/ ?kg/i;
const PRICE_END = /[-$]?\s*(\d{1,4}[.,]\d{2})\s*-?\s*[A-Z*]{0,2}\s*$/;

// Weight lines like "1.43 lb @ $1.69/lb 2.42" belong to the name on the line above.
// OCR often reads "lb" as "1b" or "1h" and "@" as "®".
const WEIGHT = /\d+[.,]\d+\s*\S{0,3}\s*[@®]\s*\$?\s*\d/;
const TOTAL = /\b(sub ?total|total|balance due|net sales)\b/i;
// The store's own lines: phone numbers, the city line with a ZIP, the greeting.
const HEADER = /\bthank|\bwelcome|\(?\d{3}\)?[-. ]?\d{3}-\d{4}|\b[A-Z]{2},? \d{5}\b/i;

const tidy = (s) => s.toLowerCase().split(/\s+/).filter(Boolean)
  .map((w) => SHORT[w] || w[0].toUpperCase() + w.slice(1)).join(' ');

// The item name in a receipt line, with its quantity, or null when the line isn't an item.
function itemName(line) {
  let name = line;
  let qty = 1;
  const q = name.match(/^(\d{1,2})\s*(?:@|x|ea)\s+/i) || name.match(/\s(\d{1,2})\s*(?:@|x)\s*[\d.,]*\s*$/i);
  if (q) { qty = Number(q[1]); name = name.replace(q[0], ' '); }
  name = name
    .replace(/\s*\/\s*(lb|kg)\b/gi, ' ') // "TOMATO ROMA /LB": sold by weight
    .replace(/^[A-Z]\s+(?=\d)/, '') // a tax flag before the item number
    .replace(/^\W*\d{3,}\s+/, '') // item numbers at the start
    .replace(/^\S\s+(?=[A-Za-z]{2})/, '') // a stray mark from the paper's edge
    .replace(/\b\d{5,}\b/g, ' ') // barcodes
    .replace(/\b(?=[A-Z]*\d)(?=\d*[A-Z])[A-Z\d]{5,}\b/gi, ' ') // product codes like SM16ZC0S
    .replace(/\b\d+(\.\d+)?\s*(lb|lbs|oz|kg|g|ct|pk|gal|l|ml)\b/gi, ' ') // sizes
    .replace(/[^A-Za-zÀ-ỹ&' ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if ((name.match(/[A-Za-zÀ-ỹ]/g) || []).length < 3) return null;
  return { name: tidy(name), qty };
}

// Receipt text in, a list of { name, qty, cat } out. A line counts when it ends in a price, or
// when it names an item sold by weight (the weight line below carries the price). Between the
// store's header and the subtotal a line also counts without a price, since glare on a photo
// often hides the price column; but when prices were read, a line without one is noise, like
// the garbled line some stores print under each item for its Chinese name. Totals and payment
// lines are skipped. The person checks the list before anything is added.
export function parseReceipt(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const end = lines.findIndex((l) => TOTAL.test(l));
  let start = -1;
  for (let i = 0; i < end; i++) if (HEADER.test(lines[i])) start = i;
  const priced = lines.slice(0, end < 0 ? lines.length : end)
    .filter((l) => !WEIGHT.test(l) && !NOT_ITEM.test(l) && PRICE_END.test(l)).length;
  const inBlock = (i) => priced < 3 && start >= 0 && i > start && i < end;

  const out = [];
  const add = (it) => {
    const prev = out.find((o) => o.name === it.name);
    if (prev) prev.qty += it.qty;
    else out.push({ ...it, cat: guessCat(it.name) });
  };
  let pending = null;
  lines.forEach((line, i) => {
    if (end >= 0 && i >= end) return;
    const price = line.match(PRICE_END);
    if (WEIGHT.test(line)) {
      if (pending && price) add(pending);
      pending = null;
      return;
    }
    pending = null;
    if (NOT_ITEM.test(line.replace(/\s*\/\s*(lb|kg)\b/gi, ''))) return;
    const it = itemName(price ? line.slice(0, price.index) : line);
    if (!it) return;
    if (price || inBlock(i)) add(it);
    else pending = it;
  });
  return out;
}

const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let loading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT; s.async = true;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => { loading = null; reject(new Error('Could not load the receipt reader. Check the connection.')); };
    document.head.append(s);
  });
  return loading;
}

// Evens out glare and shadow on a photo of a receipt, in place, and makes it grey: each pixel is
// divided by the average brightness around it, so paper turns white and print stays dark however
// the light falls. Plain pixel math rather than canvas filters, which Safari on iPhone ignores.
export function flatten(px, w, h) {
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  // Running sums make each neighbourhood average a few lookups.
  const W = w + 1;
  const sum = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += lum[y * w + x];
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row;
    }
  }
  const r = Math.max(8, Math.round(Math.max(w, h) / 40));
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const bg = (sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0]) / ((y1 - y0) * (x1 - x0));
      const v = (lum[y * w + x] / Math.max(bg, 1) - 0.45) / 0.5; // print near 0, paper at 1
      const i = (y * w + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = Math.max(0, Math.min(255, v * 255));
    }
  }
  return px;
}

// Phone photos are huge; a smaller copy reads faster and just as well.
async function prepare(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, c.width, c.height);
  const data = g.getImageData(0, 0, c.width, c.height);
  flatten(data.data, c.width, c.height);
  g.putImageData(data, 0, 0);
  return c;
}

// Marks read from the table beside the receipt sit in a thin strip at the photo's left edge,
// well apart from the text, and when the price column is lost to glare a stray letter or two is
// read far out on the right instead. Both are dropped before parsing; real prices are kept.
// A receipt photographed on a patterned counter also gets marks read on both sides of the paper,
// so when enough words are read with confidence, words well outside the span they cover are
// dropped too (prices are always kept).
const PRICE_WORD = /\d[.,]\d{2}/;
function column(lines, width) {
  const sure = lines.flatMap((l) => l.words).filter((w) => w.confidence >= 85 && /[A-Za-z\d]{3}/.test(w.text));
  if (sure.length < 8) return null;
  const pad = width * 0.03;
  return [Math.min(...sure.map((w) => w.bbox.x0)) - pad, Math.max(...sure.map((w) => w.bbox.x1)) + pad];
}

export function receiptText(data, width) {
  if (!data.lines?.length || !width) return data.text;
  const span = column(data.lines, width);
  return data.lines.map((line) => {
    let words = line.words;
    if (span) {
      words = words.filter((w) => PRICE_WORD.test(w.text) || ((w.bbox.x0 + w.bbox.x1) / 2 > span[0] && (w.bbox.x0 + w.bbox.x1) / 2 < span[1]));
      // Unsure marks before a name, and after the price, are creases.
      while (words.length > 1 && words[0].confidence < 50 && !/[A-Za-z\d]/.test(words[0].text)) words = words.slice(1);
      const p = words.findLastIndex((w) => PRICE_WORD.test(w.text));
      if (p >= 0) words = words.filter((w, i) => i <= p || w.confidence >= 50);
      if (!words.length) return '';
    }
    const k = words.findIndex((w) => w.bbox.x0 > width * 0.1);
    if (k > 0 && words[k - 1].bbox.x1 < width * 0.1 && words[k].bbox.x0 - words[k - 1].bbox.x1 > width * 0.05) words = words.slice(k);
    while (words.length > 1) {
      const [a, b] = words.slice(-2);
      if (PRICE_WORD.test(b.text) || b.bbox.x0 - a.bbox.x1 < width * 0.15) break;
      words = words.slice(0, -1);
    }
    return words.map((w) => w.text).join(' ');
  }).join('\n');
}

async function scanText(file, onProgress) {
  const T = await loadTesseract();
  const image = await prepare(file).catch(() => file);
  const { data } = await T.recognize(image, 'eng', {
    logger: (m) => { if (m.status === 'recognizing text') onProgress(m.progress); },
  });
  return receiptText(data, image.width);
}

export async function readReceipt(file, onProgress = () => {}) {
  return parseReceipt(await scanText(file, onProgress));
}

// For Money: the store, what was paid and the day, from a receipt's text. Any of them can be
// missing; the person checks them in the expense form before saving.
const PAID = /\b(total|balance due|amount due|grand total)\b/i;
const NOT_PAID = /\b(sub ?total|tax|sav(ed|ings?)|discount|items?|change|tip)\b/i;
const CARD = /\b(visa|master ?card|amex|discover|debit|credit|amount|charged|paid)\b/i;
const money = (line) => { const m = line.match(/\$?\s*(\d{1,5}[.,]\d{2})\b(?!.*\d[.,]\d{2})/); return m ? Number(m[1].replace(',', '.')) : null; };
export function parseExpense(text, today = new Date()) {
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const most = (test) => Math.max(0, ...lines.filter(test).map(money).filter((n) => n !== null));
  const amount = most((l) => PAID.test(l) && !NOT_PAID.test(l)) || most((l) => CARD.test(l)) || null;

  // The first line that reads as a name, before any address, phone or item.
  const top = lines.slice(0, 4).find((l) => /^[^\d]*[A-Za-z]{3}/.test(l) && !HEADER.test(l) && !NOT_ITEM.test(l) && !PRICE_END.test(l));
  const store = top ? tidy(top.replace(/[^A-Za-z&' ]+/g, ' ').trim()) : '';

  // Dates like 10/12/2026, 10-12-26 or 2026-10-12; one in the future or over a year old is a misread.
  let date = '';
  for (const l of lines) {
    const m = l.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})\b/) || l.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (!m) continue;
    const [y, mo, d] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3].length === 2 ? `20${m[3]}` : m[3], m[1], m[2]];
    const when = new Date(Number(y), Number(mo) - 1, Number(d));
    if (when.getMonth() !== Number(mo) - 1 || when > today || today - when > 366 * 864e5) continue;
    date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    break;
  }
  return { store, amount, date };
}

export async function readExpense(file, onProgress = () => {}) {
  return parseExpense(await scanText(file, onProgress));
}
