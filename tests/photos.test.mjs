// Run with: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitSize } from '../photos.js';

test('itinerary pictures shrink to 1280 pixels on their long side', () => {
  assert.deepEqual(fitSize(4032, 3024), { w: 1280, h: 960 });
  assert.deepEqual(fitSize(3024, 4032), { w: 960, h: 1280 });
});
test('small pictures are never enlarged, and nothing shrinks to zero', () => {
  assert.deepEqual(fitSize(800, 600), { w: 800, h: 600 });
  assert.deepEqual(fitSize(10000, 10, 1024), { w: 1024, h: 1 });
});

import { collageCells, collageGrid, collagePick } from '../photos.js';
test('the love points always sit in the middle of the collage', () => {
  const g = (n) => { const x = collageGrid(n); return `${x.cols}x${x.rows} mid ${x.mid.col},${x.mid.row} ${x.mid.cols}x${x.mid.rows}`; };
  assert.equal(g(2), '3x1 mid 1,0 1x1');
  assert.equal(g(8), '3x3 mid 1,1 1x1');
  assert.equal(g(10), '4x3 mid 1,1 2x1');
  assert.equal(g(12), '4x4 mid 1,1 2x2');
  assert.equal(g(24), '5x5 mid 2,2 1x1');
  for (let n = 1; n <= 32; n++) {
    const { cols, rows, mid } = collageGrid(n);
    assert.equal(mid.col * 2 + mid.cols, cols, `centred across for ${n}`);
    assert.equal(mid.row * 2 + mid.rows, rows, `centred down for ${n}`);
    assert.ok(cols - rows <= 2 && cols >= rows);
    const cells = collageCells(n);
    assert.equal(cells.filter((x) => x.kind === 'pic').length, n);
    assert.ok(cells.filter((x) => x.kind === 'spare').length <= Math.max(2, cols));
  }
});
test('a collage takes every check-in picture, first pictures first when there are too many', () => {
  const items = [{ text: 'A', photos: ['a1', 'a2', 'a3'] }, { text: 'B', photos: ['b1'] }, { text: 'C', photos: ['c1', 'c2'] }];
  assert.deepEqual(collagePick(items).map((p) => p.id), ['a1', 'b1', 'c1', 'a2', 'c2', 'a3']);
  assert.deepEqual(collagePick(items, 4).map((p) => p.id), ['a1', 'b1', 'c1', 'a2']);
  assert.deepEqual(collagePick(items).map((p) => p.text), ['A', 'B', 'C', '', '', '']);
});
