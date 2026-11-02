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

import { collageGrid, collagePick } from '../photos.js';
test('a month collage grid stays close to square', () => {
  assert.deepEqual(collageGrid(1), { cols: 1, rows: 1 });
  assert.deepEqual(collageGrid(4), { cols: 2, rows: 2 });
  assert.deepEqual(collageGrid(5), { cols: 3, rows: 2 });
  assert.deepEqual(collageGrid(10), { cols: 4, rows: 3 });
  assert.deepEqual(collageGrid(36), { cols: 6, rows: 6 });
});
test('a collage takes every check-in picture, first pictures first when there are too many', () => {
  const items = [{ text: 'A', photos: ['a1', 'a2', 'a3'] }, { text: 'B', photos: ['b1'] }, { text: 'C', photos: ['c1', 'c2'] }];
  assert.deepEqual(collagePick(items).map((p) => p.id), ['a1', 'b1', 'c1', 'a2', 'c2', 'a3']);
  assert.deepEqual(collagePick(items, 4).map((p) => p.id), ['a1', 'b1', 'c1', 'a2']);
  assert.deepEqual(collagePick(items).map((p) => p.text), ['A', 'B', 'C', '', '', '']);
});
