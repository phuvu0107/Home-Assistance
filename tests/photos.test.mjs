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
