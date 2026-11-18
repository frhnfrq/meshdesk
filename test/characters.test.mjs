import test from 'node:test';
import assert from 'node:assert/strict';
import {executeEditTool, editTools} from '../server/edit-tools.mjs';

const png = (() => { const b = Buffer.alloc(40); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(800, 16); b.writeUInt32BE(1200, 20); return b; })();

/** Just enough of a library for the character tools: one image, and edits and renders that record what they were given. */
function fakeLibrary() {
  const assets = new Map([['aaaaaaaaaaaa', {id: 'aaaaaaaaaaaa', name: 'Sheet', type: 'reference', path: 'Images/aaaaaaaaaaaa/Sheet.png'}]]), log = [];
  return {log, root: '/tmp/meshdesk-test-' + process.pid, catalog: assets,
    require(id) { const a = assets.get(id); if (!a) throw Error('Unknown asset.'); return a; },
    file: () => new URL('./characters.sheet.png', import.meta.url).pathname,
    version: () => ({preview: new URL('./characters.sheet.png', import.meta.url).pathname, metrics: {dimensions: [.6, .3, 1.65]}}),
    async edit(id, options) { log.push(['edit', id, options]); return {id, name: assets.get(id).name, label: options.label, currentVersion: 'v2', metrics: {}, image: Buffer.from('review')}; },
    async inspect(id, options) { log.push(['inspect', id, options]); return {stats: {triangles: 18000}, issues: [], image: Buffer.from('views')}; },
    async script(options) { log.push(['script', options.script]); return {files: [Buffer.from(png), Buffer.from(png)]}; }};
}

test('image_crop cuts each box and saves the pieces as reference images', async t => {
  const fs = await import('node:fs/promises'), sheet = new URL('./characters.sheet.png', import.meta.url).pathname;
  await fs.writeFile(sheet, png); t.after(() => fs.rm(sheet, {force: true}));
  const library = fakeLibrary(), saved = []; t.after(() => fs.rm(library.root, {recursive: true, force: true}));
  const extras = {importImage: async (name, bytes) => { const id = 'c'.repeat(11) + saved.length; saved.push(name); library.catalog.set(id, {id, name: name.replace(/\.png$/, ''), type: 'reference', dimensions: [200, 600]}); return {id}; }};
  const result = await executeEditTool(library, 'image_crop', {source: 'aaaaaaaaaaaa', crops: '[{"name":"Front","box":[0,0,0.27,1]},{"name":"Side","box":[0.27,0,0.5,1]}]'}, null, () => {}, extras);
  assert.deepEqual(saved, ['Front.png', 'Side.png']); assert.equal(result.crops.length, 2); assert.equal(result.images.length, 2);
  assert.match(library.log.find(e => e[0] === 'script')[1], /md\.crop_image\(".*characters\.sheet\.png", \[0,0,0\.27,1\], out \/ "crop0\.png"\)/);
  await assert.rejects(executeEditTool(library, 'image_crop', {source: 'aaaaaaaaaaaa', crops: '[{"name":"Bad","box":[0,0,2,1]}]'}, null, () => {}, extras), /fractions from 0 to 1/);
});

test('the character tools are offered and no outside generation service is', () => {
  const names = editTools.map(t => t.name);
  assert.ok(names.includes('image_crop'));
  for (const gone of ['model_generate', 'model_rig', 'model_animate', 'animation_search']) assert.ok(!names.includes(gone), gone);
  const render = editTools.find(t => t.name === 'blender_render').inputSchema.properties;
  assert.ok(render.band && render.overlay);
  assert.match(editTools.find(t => t.name === 'blender_api').description, /"character"/);
});

test('an overlay must name a picture for each view', async () => {
  const library = fakeLibrary();
  await assert.rejects(executeEditTool(library, 'blender_render', {assetId: 'aaaaaaaaaaaa', views: '', focus: '', style: '', script: '', band: '', reference: '', overlay: 'front'}, null, () => {}, {}), /JSON object/);
});

test('the character toolkit is in the Blender helper library', async () => {
  const fs = await import('node:fs/promises'), source = await fs.readFile(new URL('../server/blender/md.py', import.meta.url), 'utf8');
  for (const name of ['def body(', 'def sculpt(', 'def deform(', 'def shell(', 'def fuse(', 'def quads(', 'def trim_hidden(', 'class Painter', 'def rig(', 'def rigid(', 'def animate_run(', 'def animate_idle(', 'CHARACTER_GUIDE']) assert.ok(source.includes(name), name);
  const listed = source.match(/CHARACTER_TOOLS = \[([^\]]+)\]/)[1].split(',').map(s => s.trim().replace(/'/g, ''));
  for (const name of listed) assert.ok(source.includes('def ' + name + '('), 'documented helper exists: ' + name);
});
