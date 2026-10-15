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

// Tesseract's text for real receipt photos from public test sets (card and member numbers left out).
// A Safeway receipt: tax flags read as §, 5, 8 or ° after the price, "2 QTY" before the name,
// Regular Price and Card Savings lines (often misspelled), section headings, and BALANCE for the total.
const SAFEWAY = `SAFEWAY
2111 Mission Street
Santa Cruz CA 95060
GROCERY
SIG CHESE BL BARRL 5.00 S
CRMY RNCH DP 15 0Z. 3.50 S
Regular Price 3.99
Card Savinas 0.49-
2 QTY KEWPIE MAY 8.98 S
REFRIG/FROZEN
LUCERNE CHEESE MD . 6.99 §
Resular Price 7.99
Card Savinss 1.00-
1 ary
OUI BY YOPLAIT 1.50 S
GEN MERCHANDISE
CLIF BAR CHOC CHIP 1.258
LASAGNE ROAST PAN . 8.99 7
PRODUCE
LRG HASS AVOCADOS . 3.52 S
CLEMENTINE 3LB BAG 5.96
STRAUS MILK RF 2% 3.815
DEPOSIT MLK 2.00
TRAX 0.83
*xx% BALANCE 42.06
SNAP BAL DUE 32.24
SNAP Purchase 02/05/19 17:45
SNAP BALANCE 683.20
CASH BALANCE 0.00
CHANGE 0.00`;

test('reads a Safeway receipt with tax flags, quantities and savings lines', () => {
  assert.deepEqual(parseReceipt(SAFEWAY).map((i) => [i.name, i.qty]), [
    ['Sig Chese Bl Barrl', 1], ['Crmy Rnch Dp', 1], ['Kewpie May', 2], ['Lucerne Cheese Md', 1], ['Oui By Yoplait', 1],
    ['Clif Bar Choc Chip', 1], ['Lasagne Roast Pan', 1], ['Lrg Hass Avocados', 1], ['Clementine Bag', 1], ['Straus Milk Rf', 1],
  ]);
  assert.equal(parseExpense(SAFEWAY, new Date(2019, 1, 6)).amount, 42.06);
});

test('a Costco item count above the items does not end the list early', () => {
  const text = 'Santa Cruz #149\n220 Sylvania Ave\n(831) 469-0961\nTOTAL NUMBER OF ITEMS SOLD = 6\n919652 SUNDRI PESTO 9.59\n'
    + '26584 BEST FD MAYO 6.99\nE 0000210159 / 26584 2.00-\n47500 KS TRKY BRST 13.69\n4521 CA REDEMP VA 0.60\nSUBTOTAL 59.94\nTAX 2.10\n**** TOTAL 62.09';
  assert.deepEqual(parseReceipt(text).map((i) => i.name), ['Sundri Pesto', 'Best Fd Mayo', 'Kirkland Trky Breast']);
  assert.equal(parseExpense(text).amount, 62.09);
});

test('the paid amount leaves out cash back, and one misread total is outvoted', () => {
  const tj = 'TRADER JOE\'S\nOPEN 8:00AM TO 9:00PM DAILY\nCHICKEN BURRITOS 2.69\nPOTATO TOTS 2.49\nSUBTOTAL $9.07\n'
    + 'TOTAL $9.15\nDEBIT $29.15\nCHANGE $20.00\nPurchase: $9.15\nCashback: $20.00\nTotal: USD$ 29.15';
  assert.deepEqual(parseReceipt(tj).map((i) => i.name), ['Chicken Burritos', 'Potato Tots']);
  assert.equal(parseExpense(tj).amount, 9.15);
  const outlet = 'GROCERY OUTLET\nCHOC CHIP CKIE \' 1.98 F\nDIP SPREAD VEGAN 1.00 F\n3@3 FOR 1.00\nBALANCE DUE z1.17\n'
    + 'SUB TOTAL 21.17\nTOTAL TAX 0.00\nTOTAL 21.17\nFOOD STAMPS TOTAL $21.17\nPurchase Amount $ 21.17\nEBT Food Balance $ 308.84';
  assert.deepEqual(parseReceipt(outlet).map((i) => i.name), ['Choc Chip Ckie', 'Dip Spread Vegan']);
  assert.equal(parseExpense(outlet).amount, 21.17);
});

test('reads a German receipt: SUMME, Pfand and comma prices', () => {
  const text = 'real SB-Warenhaus GmbH\n40217 Dusseldorf-Bilk\nTel 02111334130\nPR PFANDGUTSCHL0158073 5,25-v\n'
    + 'TIP BALKANKAESE 0,79 E\nTIP EDELSALAMT 150 1.29 E\nSUMME EUR 9.31\nBar EUR 10,01\nROCKGELD EUR 0,70';
  assert.deepEqual(parseReceipt(text).map((i) => i.name), ['Tip Balkankaese', 'Tip Edelsalamt']);
  assert.equal(parseExpense(text).amount, 9.31);
});

test('foods that start like totals, savings or tax lines are kept', () => {
  assert.deepEqual(parseReceipt('SAFEWAY\n(831) 420-0781\nTEN GRAIN BREAD 3.99\nSAVOY CABBAGE 2.10\nREGULAR COFFEE 4.99\nEYE OF RND STK 9.12\nTRAX 0.46\nTOTAL 20.66')
    .map((i) => i.name), ['Ten Grain Bread', 'Savoy Cabbage', 'Regular Coffee', 'Eye Of Rnd Stk']);
});

test('reads totals with thousands separators', () => {
  assert.equal(parseExpense('BERG BUILDERS\nSubtotal $5,280.00\nBalance Due $5,280.00').amount, 5280);
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
