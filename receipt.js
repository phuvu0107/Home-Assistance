// Fridge helpers: categories, and turning a photo of a grocery receipt into fridge items.
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
  produce: 'apple banana berry berries strawberry blueberry raspberry grape lemon lime orange mandarin avocado tomato potato onion garlic ginger carrot celery lettuce romaine spinach arugula kale cabbage broccoli cauliflower cucumber pepper zucchini squash mushroom herb cilantro basil parsley scallion mango pear peach plum cherry melon watermelon pineapple kiwi corn bean sprout bok choy yuchoy cai bac salad fruit veg produce rau hanh',
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
const TOTAL = /\b(sub ?total|total|balance due)\b/i;
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
// often hides the price column. Totals and payment lines are skipped. The person checks the
// list before anything is added.
export function parseReceipt(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const end = lines.findIndex((l) => TOTAL.test(l));
  let start = -1;
  for (let i = 0; i < end; i++) if (HEADER.test(lines[i])) start = i;
  const inBlock = (i) => start >= 0 && i > start && i < end;

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

// Phone photos are huge; a smaller grey copy reads faster and just as well. Glare and shadow
// across the paper are evened out by dividing by a blurred copy, which keeps the price column
// readable when the light falls on one side of the receipt.
async function prepare(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const canvas = (filter, src) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.filter = filter;
    g.drawImage(src, 0, 0, w, h);
    return c;
  };
  const grey = canvas('grayscale(1)', img);
  const light = canvas('blur(20px) invert(1)', grey);
  const g = grey.getContext('2d');
  g.globalCompositeOperation = 'color-dodge'; // grey / (1 - inverted blur) = grey / blur
  g.drawImage(light, 0, 0);
  return canvas('contrast(1.3)', grey);
}

// Marks read from the table beside the receipt sit in a thin strip at the photo's left edge,
// well apart from the text, and when the price column is lost to glare a stray letter or two is
// read far out on the right instead. Both are dropped before parsing; real prices are kept.
export function receiptText(data, width) {
  if (!data.lines?.length || !width) return data.text;
  return data.lines.map((line) => {
    let words = line.words;
    const k = words.findIndex((w) => w.bbox.x0 > width * 0.1);
    if (k > 0 && words[k - 1].bbox.x1 < width * 0.1 && words[k].bbox.x0 - words[k - 1].bbox.x1 > width * 0.05) words = words.slice(k);
    while (words.length > 1) {
      const [a, b] = words.slice(-2);
      if (/\d[.,]\d{2}/.test(b.text) || b.bbox.x0 - a.bbox.x1 < width * 0.15) break;
      words = words.slice(0, -1);
    }
    return words.map((w) => w.text).join(' ');
  }).join('\n');
}

export async function readReceipt(file, onProgress = () => {}) {
  const T = await loadTesseract();
  const image = await prepare(file).catch(() => file);
  const { data } = await T.recognize(image, 'eng', {
    logger: (m) => { if (m.status === 'recognizing text') onProgress(m.progress); },
  });
  return parseReceipt(receiptText(data, image.width));
}
