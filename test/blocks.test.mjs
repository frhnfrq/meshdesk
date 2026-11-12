import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Scenes, blockManifest, laneCentres, outsideBlock, cleanBlock} from '../server/scenes.mjs';
import {changelogText} from '../server/handoff.mjs';

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meshdesk-blocks-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const catalog = new Map([['aaaaaaaaaaaa', {id: 'aaaaaaaaaaaa', type: 'model', name: 'Barrier'}], ['bbbbbbbbbbbb', {id: 'bbbbbbbbbbbb', type: 'model', name: 'Coin'}]]);
  const scenes = new Scenes({file: path.join(dir, 'scenes.json'), catalog});
  await scenes.init();
  return {scenes, dir, catalog};
}

test('a block is a scene with a footprint and lanes, and stays a block', async t => {
  const {scenes, dir, catalog} = await setup(t);
  const block = await scenes.create({kind: 'block'});
  const scene = await scenes.create({});
  assert.equal(block.name, 'Block 1');
  assert.equal(scene.name, 'Scene 1', 'blocks and scenes are numbered separately');
  assert.deepEqual(block.block, {length: 100, width: 20, lanes: 3, laneWidth: 3, theme: '', difficulty: ''});
  assert.equal(scene.block, undefined);
  const edited = await scenes.replace(block.id, {...block, kind: 'scene', block: {length: 60, lanes: 5.4, difficulty: 'impossible', theme: ' village '}});
  assert.equal(edited.kind, 'block', 'the viewer cannot turn a block into a scene');
  assert.deepEqual(edited.block, {length: 60, width: 20, lanes: 5, laneWidth: 3, theme: 'village', difficulty: ''});
  await assert.rejects(() => scenes.apply(scene.id, [{op: 'block', length: 5}]), /not a block/);
  const again = new Scenes({file: path.join(dir, 'scenes.json'), catalog});
  await again.init();
  assert.equal(again.get(block.id).block.length, 60, 'the footprint survives a restart');
});

test('objects in a block carry a role, and the manifest gives the game what it needs to chain blocks', async t => {
  const {scenes} = await setup(t);
  const made = await scenes.create({kind: 'block', name: 'Village 1'});
  const block = await scenes.apply(made.id, [
    {op: 'block', length: 40, width: 12, lanes: 3, laneWidth: 3, difficulty: 'easy'},
    {op: 'add', assetId: 'aaaaaaaaaaaa', position: [10, 0, 2.8], role: 'obstacle'},
    {op: 'add', assetId: 'bbbbbbbbbbbb', position: [20, 1, -3], role: 'pickup'},
    {op: 'add', assetId: 'aaaaaaaaaaaa', name: 'Overhang', position: [45, 0, 0], role: 'nonsense'},
    {op: 'add', assetId: 'aaaaaaaaaaaa', name: 'Hidden', position: [5, 0, 0], visible: false},
  ]);
  assert.deepEqual(block.items.map(i => i.role), ['obstacle', 'pickup', undefined, undefined]);
  assert.deepEqual(laneCentres(block.block), [-3, 0, 3]);
  assert.deepEqual(outsideBlock(block), ['Overhang']);
  const manifest = blockManifest(block, item => 'Models/' + item.name);
  assert.deepEqual(manifest.footprint, {length: 40, width: 12});
  assert.deepEqual(manifest.exit.position, [40, 0, 0]);
  assert.deepEqual(manifest.lanes, [{index: 1, z: -3}, {index: 2, z: 0}, {index: 3, z: 3}]);
  assert.deepEqual(manifest.objects.map(o => [o.name, o.role, o.lane, o.model]), [['Barrier', 'obstacle', 3, 'Models/Barrier'], ['Coin', 'pickup', 1, 'Models/Coin'], ['Overhang', 'decoration', undefined, 'Models/Overhang']]);
  assert.equal(manifest.difficulty, 'easy');
  const cleared = await scenes.apply(block.id, [{op: 'update', itemId: block.items[0].id, role: ''}]);
  assert.equal(cleared.items[0].role, undefined, 'a role can be cleared');
  assert.deepEqual(cleanBlock({length: -5, width: 9999, lanes: 40, laneWidth: 0}), {length: 1, width: 500, lanes: 9, laneWidth: 0.5, theme: '', difficulty: ''});
});

test('the handoff changelog lists blocks with their size', () => {
  const text = changelogText({project: 'Runner', createdAt: '2026-11-12T00:00:00Z', changes: {added: [], updated: [], removed: [], unchanged: []}, blocks: [{name: 'Village 1', objects: 3, footprint: {length: 40, width: 12}, lanes: 3, outsideFootprint: ['Overhang']}], scenes: []});
  assert.match(text, /## Blocks \(1\)\n\n- Village 1 \(3 objects, 40 × 12 m, 3 lanes; outside the footprint: Overhang\)/);
});
