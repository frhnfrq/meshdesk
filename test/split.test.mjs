import test from 'node:test';
import assert from 'node:assert/strict';
import {findFigures, runs, SHEET_ORDER} from '../src/split.js';

/** A plain grey sheet with dark figures drawn as rectangles, and optional full-width guide lines and captions. */
function sheet(width, height, figures, {lines = [], captions = []} = {}) {
  const px = new Uint8ClampedArray(width * height * 4).fill(200);
  const paint = (x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * width + x) * 4; px[i] = px[i + 1] = px[i + 2] = 30; px[i + 3] = 255; } };
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  for (const [x, y, w, h] of figures) paint(x, y, w, h);
  for (const y of lines) for (let x = 0; x < width; x += 8) paint(x, y, 4, 2);
  for (const [x, y, w, h] of captions) paint(x, y, w, h);
  return px;
}

test('runs merges short gaps and drops short runs', () => {
  assert.deepEqual(runs([0, 1, 1, 0, 1, 1, 0, 0, 0, 1], 2, 2), [[1, 6]]);
  assert.deepEqual(runs([1, 0, 0, 0, 1, 1, 1], 2, 2), [[4, 7]]);
});

test('finds each figure on a sheet, ignoring guide lines across it and captions below', () => {
  const figures = [[40, 20, 120, 400], [260, 20, 70, 400], [430, 20, 70, 400], [600, 20, 120, 400]];
  const px = sheet(760, 480, figures, {lines: [18, 120, 300, 422], captions: [[60, 440, 80, 25], [250, 440, 90, 25], [420, 440, 90, 25], [620, 440, 80, 25]]});
  const found = findFigures(px, 760, 480);
  assert.equal(found.length, 4);
  for (const [i, [x, y, w, h]] of figures.entries()) {
    assert.ok(Math.abs(found[i].x - x) <= 2 && Math.abs(found[i].w - w) <= 3, 'figure ' + i + ' spans its own columns');
    assert.ok(found[i].y <= y + 2 && found[i].y + found[i].h >= y + h - 2, 'figure ' + i + ' keeps its full height');
    assert.ok(found[i].y + found[i].h < 440, 'figure ' + i + ' leaves out its caption');
  }
  assert.deepEqual(SHEET_ORDER[4], ['front', 'right', 'left', 'back']);
});

test('a picture of a single figure is not a sheet', () => {
  assert.deepEqual(findFigures(sheet(400, 500, [[120, 30, 160, 440]]), 400, 500), []);
  assert.deepEqual(findFigures(sheet(400, 500, []), 400, 500), []);
});
