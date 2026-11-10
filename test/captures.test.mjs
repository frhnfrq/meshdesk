import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {captureHandler} from '../server/captures.mjs';

test('serves saved captures from .data while rejecting other paths', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-captures-'));
  t.after(() => fs.rm(directory, {recursive:true, force:true}));
  const dataRoot = path.join(directory, '.data');
  const captures = path.join(dataRoot, 'captures');
  await fs.mkdir(captures, {recursive:true});
  const bytes = Buffer.from([255,216,255,224,0,16,255,217]);
  const name = '9647d525-b60f-4e3f-a969-2c66d9c48b52.jpg';
  await fs.writeFile(path.join(captures, name), bytes);
  await fs.writeFile(path.join(dataRoot, 'private.json'), '{}');
  const app = express();
  app.get('/captures/:name', captureHandler(dataRoot));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/captures/`;
  const response = await fetch(base + name);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^image\/jpeg/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  for (const invalid of ['private.json', '.hidden.jpg', '..%2Fprivate.json', '9647d525-b60f-4e3f-a969-2c66d9c48b53.jpg']) {
    assert.equal((await fetch(base + invalid)).status, 404);
  }
});
