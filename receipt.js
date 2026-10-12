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
  produce: 'apple banana berry berries strawberry blueberry raspberry grape lemon lime orange mandarin avocado tomato potato onion garlic ginger carrot celery lettuce romaine spinach arugula kale cabbage broccoli cauliflower cucumber pepper zucchini squash mushroom herb cilantro basil parsley scallion mango pear peach plum cherry melon watermelon pineapple kiwi corn bean sprout bok choy salad fruit veg produce rau hanh',
  dairy: 'milk egg eggs cheese yogurt yoghurt butter cream creamer kefir mozzarella cheddar parmesan sour half tofu',
  meat: 'chicken beef pork lamb turkey steak bacon sausage ham salmon tuna shrimp fish prawn squid crab ground thigh breast wing rib meat seafood muc',
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

const tidy = (s) => s.toLowerCase().split(/\s+/).filter(Boolean)
  .map((w) => SHORT[w] || w[0].toUpperCase() + w.slice(1)).join(' ');

// Receipt text in, a list of { name, qty, cat } out. Lines without a price at the end are skipped,
// as are totals and payment lines. The person checks the list before anything is added.
export function parseReceipt(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    const price = line.match(PRICE_END);
    if (!price || NOT_ITEM.test(line)) continue;
    let name = line.slice(0, price.index);
    let qty = 1;
    const q = name.match(/^(\d{1,2})\s*(?:@|x|ea)\s+/i) || name.match(/\s(\d{1,2})\s*(?:@|x)\s*[\d.,]*\s*$/i);
    if (q) { qty = Number(q[1]); name = name.replace(q[0], ' '); }
    name = name
      .replace(/^[A-Z]\s+(?=\d)/, '') // a tax flag before the item number
      .replace(/^\W*\d{3,}\s+/, '') // item numbers at the start
      .replace(/\b\d{5,}\b/g, ' ') // barcodes
      .replace(/\b\d+(\.\d+)?\s*(lb|lbs|oz|kg|g|ct|pk|gal|l|ml)\b/gi, ' ') // sizes
      .replace(/[^A-Za-zÀ-ỹ&' ]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if ((name.match(/[A-Za-zÀ-ỹ]/g) || []).length < 3) continue;
    name = tidy(name);
    const prev = out.find((it) => it.name === name);
    if (prev) { prev.qty += qty; continue; }
    out.push({ name, qty, cat: guessCat(name) });
  }
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

// Phone photos are huge; a smaller grey copy reads faster and just as well.
async function prepare(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  const g = c.getContext('2d');
  g.filter = 'grayscale(1) contrast(1.3)';
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export async function readReceipt(file, onProgress = () => {}) {
  const T = await loadTesseract();
  const image = await prepare(file).catch(() => file);
  const { data } = await T.recognize(image, 'eng', {
    logger: (m) => { if (m.status === 'recognizing text') onProgress(m.progress); },
  });
  return parseReceipt(data.text);
}
