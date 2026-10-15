// Run with: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { flatten, parseExpense, parseReceipt, receiptText } from '../receipt.js';

// Tesseract's text for a Thien Thanh Market receipt photo (8 foods, 4 of them sold by weight),
// after the glare is evened out and the edge marks are dropped.
const THIEN_THANH = `THIEN THANH MARKET
1080 S. 10TH ST
SAN JOSE, CA 95112
(408) 295-1043
(408) 295-1741
THANK YOU FOR SHOPPING!!!
SHRIMP 21/25 $4.15
TOMATO ROMA /LB
1.43 1b @  $1.69/ 1b $2.42
SALMON WHOLE $7.90
BEAN SPROUT SM16ZC0S $1.39
CAI NGOT/YUCHOY
1.60 1b @  $1.99/ 1b $2.18
ONION YELW/HANH VANG
2.76 1b @  $0.79/ 1b $2.18
BAC HA /LB
0.68 1h @  $4.99/ 1b $3.39
OCTOPUS BABY 2# $9.99
BAG CHARGE $0.15
J sus TOTAL $34.75
BALANCE DUE $34.75
Master Card $34.75
EXP. DATE: xx/xxxx
Auth Code = 172167
Entry Method: Cntctie
= APPROVED
AUTH CODE: 172167`;

// The same photo without glare correction: the whole price column is lost.
const NO_PRICES = `THIEN THANH M
1080 S. 10TH ST
SAN JOSE, CA 95112
(408) 295-1043
(408) 295-1741
THANK YOU FOR SHOPPING! TE
SHRIMP 21/25
TOMATO ROMA /LB
1.43 1b @  $1.69/ 1p
SALMON WHOLE
BEAN SPROUT SM162C0S 4
CAT NGOT/YUCHOY
1.60 1b @  $1.99/ 1b $
ONION YEL W/HANH VANG
2.76 1b @  $0.79/ 1b
BAC HA /LB
0.68 1b @  $4.99/ 1p $
OCTOPUS RABY 2#
BAG CHARGE
SUB TOTAL
BALANCE DUE
Auth Code = 172167`;

test('reads every food on the Thien Thanh receipt, including ones sold by weight', () => {
  assert.deepEqual(parseReceipt(THIEN_THANH), [
    { name: 'Shrimp', qty: 1, cat: 'meat' },
    { name: 'Tomato Roma', qty: 1, cat: 'produce' },
    { name: 'Salmon Whole', qty: 1, cat: 'meat' },
    { name: 'Bean Sprout', qty: 1, cat: 'produce' },
    { name: 'Cai Ngot Yuchoy', qty: 1, cat: 'produce' },
    { name: 'Onion Yelw Hanh Vang', qty: 1, cat: 'produce' },
    { name: 'Bac Ha', qty: 1, cat: 'produce' },
    { name: 'Octopus Baby', qty: 1, cat: 'meat' },
  ]);
});

test('still lists the foods when the price column is lost', () => {
  assert.equal(parseReceipt(NO_PRICES).length, 8);
});

test('weight items count without a header or totals', () => {
  assert.deepEqual(parseReceipt('BANANAS /LB\n2.10 lb @ $0.59/lb 1.24\nWHOLE MILK 4.99').map((i) => i.name),
    ['Bananas', 'Whole Milk']);
});

test('drops marks at the photo edge and stray letters where a price should be', () => {
  const W = 1350;
  const word = (text, x0, x1) => ({ text, bbox: { x0, x1 } });
  const data = { lines: [
    { words: [word('FE', 2, 17), word('3', 61, 65), word('BEAN', 203, 300), word('SPROUT', 329, 474), word('$1.39', 936, 1063)] },
    { words: [word('SHRIMP', 214, 359), word('21/25', 388, 508), word('LE', 911, 953)] },
    { words: [word('2', 30, 50), word('BANANAS', 80, 300), word('1.18', 936, 1040)] },
  ] };
  assert.equal(receiptText(data, W), 'BEAN SPROUT $1.39\nSHRIMP 21/25\n2 BANANAS 1.18');
});

// Tesseract's text for a LION supermarket receipt photographed on a granite counter, after the
// counter's marks are dropped. Under each item is a line of garbled characters (the printer's
// try at the Chinese name), and weighed items have their weight on the line above.
const LION = `LION %i Fiz
39055 Cedar Blvd
NEWARK, CA i
(910) 742-8179 é
#008-005 10/14/2026 18:31:34 LINH THUAN
Invi:00236570 Trs#:237376
TT TT TT TT Te ee ee emma mgs
Tare: 0.01 1b] 0.82 1b @ $3.99/1b
CELERY CHINESE $3.27 F
ARE-0d
GARLIC PEELED $2.07 F
20 2/ $1.60
ONION GREEN 1.60 F
wor
0.60 1b @ $2.99/1p
CHIVE GREEN $1.79 F
i4u
GROUND PORK $3.61 F
EL O
RIB EVE STEAK $16.10 F
2H Avi
EYE ROUND $14.90 F
nel
BEAN SPROUT [MUNG BEAN] 1 LB $1.69 F
Recycle bag $0.15
Net Sales $45.03
ioen Sales $0.15
TOTAL SALES $45.18
sus ToTAL $45.18
Debit card $45.18`;

test('reads the LION receipt without the garbled name lines or the cashier line', () => {
  assert.deepEqual(parseReceipt(LION).map((i) => i.name), [
    'Celery Chinese', 'Garlic Peeled', 'Onion Green', 'Chive Green', 'Ground Pork', 'Rib Eve Steak', 'Eye Round',
    'Bean Sprout Mung Bean',
  ]);
  assert.deepEqual(parseExpense(LION, new Date(2026, 9, 15)).amount, 45.18);
});

test('drops marks read off the counter on both sides of the receipt', () => {
  const W = 1350;
  const word = (text, x0, x1, confidence = 95) => ({ text, bbox: { x0, x1 }, confidence });
  const data = { lines: [
    { words: [word('39055', 546, 639), word('Cedar', 661, 754), word('Blvd', 776, 852)] },
    { words: [word('Rr', 52, 193, 34), word('CELERY', 325, 420), word('CHINESE', 441, 558), word('$3.27', 834, 922), word('F', 940, 958), word('49', 1165, 1251, 62), word('|', 1344, 1349, 52)] },
    { words: [word('@', 281, 295, 0), word('GARLIC', 323, 423), word('PEELED', 442, 542), word('$2.07', 830, 914), word('F', 932, 949), word('Pp)', 1020, 1037, 22)] },
    { words: [word('ALGAE', 14, 394, 20), word('be', 1139, 1302, 43)] },
    { words: [word('1.43', 212, 305, 65), word('1b', 339, 379, 43), word('@', 407, 430, 43), word('$1.69/', 532, 681, 55)] },
    { words: [word('THUAN', 920, 1012), word('Net', 314, 363), word('Sales', 384, 467), word('$45.03', 809, 909)] },
  ] };
  assert.deepEqual(receiptText(data, W).split('\n'), [
    '39055 Cedar Blvd', 'CELERY CHINESE $3.27 F', 'GARLIC PEELED $2.07 F', '', '1.43 1b @ $1.69/', 'THUAN Net Sales $45.03',
  ]);
});

test('evens out a shadow so paper is white and print stays dark on both sides', () => {
  const w = 200, h = 50;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const paper = 240 - x; // bright on the left, in shadow on the right
    const ink = y === 25 && (x === 20 || x === 180);
    const v = ink ? paper * 0.3 : paper;
    px.set([v, v, v, 255], (y * w + x) * 4);
  }
  flatten(px, w, h);
  const at = (x, y) => px[(y * w + x) * 4];
  assert.ok(at(20, 10) > 200 && at(180, 10) > 200, 'paper is white in light and shadow');
  assert.ok(at(20, 25) < 60 && at(180, 25) < 60, 'print is dark in light and shadow');
});

test('reads the store, total and day for a Money expense', () => {
  const today = new Date(2026, 9, 14);
  assert.deepEqual(parseExpense(`${THIEN_THANH}\n10/12/2026 18:42`, today), { store: 'Thien Thanh Market', amount: 34.75, date: '2026-10-12' });
});

test('falls back to the card line when the total is lost, and skips misread dates', () => {
  const text = 'TRADER JOES\n123 MAIN ST\nBANANA 0.29\nSUBTOTAL 51.20\nTAX 1.10\nVISA $52.30\n13/45/2026\n01/02/2031';
  assert.deepEqual(parseExpense(text, new Date(2026, 9, 14)), { store: 'Trader Joes', amount: 52.3, date: '' });
});

test('takes the total over the subtotal and savings', () => {
  const text = 'COSTCO WHOLESALE\nSUBTOTAL 120.00\nTOTAL SAVINGS 15.00\nTAX 4.20\n**** TOTAL 124.20\n2026-10-03';
  assert.deepEqual(parseExpense(text, new Date(2026, 9, 14)), { store: 'Costco Wholesale', amount: 124.2, date: '2026-10-03' });
});

test('an unreadable photo gives an empty expense', () => {
  assert.deepEqual(parseExpense('', new Date(2026, 9, 14)), { store: '', amount: null, date: '' });
});
