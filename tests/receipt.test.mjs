// Run with: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { flatten, parseReceipt, receiptText } from '../receipt.js';

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
