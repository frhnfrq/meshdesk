import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Generators, Generations} from '../server/generators.mjs';
import {executeEditTool, editTools} from '../server/edit-tools.mjs';

const glb = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(40)]);
function png() {
  const bytes = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'latin1'); bytes.writeUInt32BE(64, 16); bytes.writeUInt32BE(64, 20);
  return bytes;
}
const picture = () => ({bytes: png(), extension: '.png'});
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
const noWait = async (ms, signal) => { if (signal?.aborted) throw Error('Operation cancelled.'); };
async function ready(change) { const generators = new Generators(null, {}); await generators.update(change); return generators; }
/** A fetch stand-in that records each call and answers from a list of [url test, reply] pairs. */
function fake(routes) {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    calls.push({url: String(url), method: options.method || 'GET', headers: options.headers || {}, body});
    for (const [match, answer] of routes) if (String(url).includes(match)) return typeof answer === 'function' ? answer(calls) : answer.clone();
    throw Error('unexpected request ' + url);
  };
  return {calls, fetcher};
}

test('routes are off until switched on, and keys never appear in what the app is sent', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'meshdesk-gen-')), file = path.join(folder, 'generators.json');
  const generators = new Generators(file, {}); await generators.init();
  assert.equal(generators.public().providers.some(p => p.ready), false);
  assert.throws(() => generators.choose(''), /not set up/);
  const shown = await generators.update({providers: {tripo: {enabled: true, apiKey: 'tsk_secret_1234'}}});
  const tripo = shown.providers.find(p => p.id === 'tripo');
  assert.equal(tripo.ready, true); assert.equal(tripo.keyHint, '1234');
  assert.equal(JSON.stringify(shown).includes('tsk_secret'), false);
  const again = new Generators(file, {}); await again.init();
  assert.equal(again.ready('tripo'), true, 'the key survives a restart');
  assert.equal((await fs.stat(file)).mode & 0o077, 0, 'the key file is private to the user');
  await again.update({providers: {tripo: {enabled: true}}});
  assert.equal(again.ready('tripo'), true, 'saving without a new key keeps the old one');
  await fs.rm(folder, {recursive: true, force: true});
});

test('the default route is used, and with several routes and no default the agent is told to ask', async () => {
  const generators = await ready({providers: {tripo: {enabled: true, apiKey: 'a'}, meshy: {enabled: true, apiKey: 'b'}}});
  assert.throws(() => generators.choose(''), /Ask them which to use.*tripo.*meshy/s);
  assert.equal(generators.choose('meshy'), 'meshy');
  assert.throws(() => generators.choose('local'), /not switched on/);
  await generators.update({route: 'tripo'});
  assert.equal(generators.choose(''), 'tripo');
  await generators.update({providers: {tripo: {enabled: false}}});
  assert.equal(generators.public().route, 'ask', 'a default that is switched off falls back to asking');
  assert.equal(generators.choose(''), 'meshy', 'the only route left is used without asking');
  assert.deepEqual(generators.brief().routes.map(r => r.route), ['meshy']);
  await assert.rejects(generators.update({providers: {local: {url: 'ftp://nope'}}}), /http/);
});

test('Tripo: uploads each view to its own slot, polls, and downloads the model', async () => {
  const generators = await ready({providers: {tripo: {enabled: true, apiKey: 'key', texture: 'detailed'}}});
  let polls = 0;
  const {calls, fetcher} = fake([
    ['/v3/files', () => json({code: 0, data: {file_token: 'file_' + polls++}})],
    ['/v3/generation/multiview-to-model', json({code: 0, data: {task_id: 'task1'}})],
    ['/v3/tasks/task1', all => all.filter(c => c.url.includes('/tasks/')).length < 2 ? json({code: 0, data: {status: 'running', progress: 40}}) : json({code: 0, data: {status: 'success', progress: 100, credits_consumed: 40, output: {model_url: 'https://cdn.example/model.glb'}}})],
    ['cdn.example', new Response(glb)]
  ]);
  const steps = [];
  const made = await generators.generate({route: 'tripo', views: {front: picture(), back: picture()}, faceLimit: 20000, progress: (step, percent) => steps.push([step, percent]), fetcher, wait: noWait});
  assert.equal(made.bytes.toString('latin1', 0, 4), 'glTF'); assert.equal(made.credits, 40);
  const create = calls.find(c => c.url.endsWith('/multiview-to-model'));
  assert.deepEqual(create.body.inputs, [{front: 'file_0'}, {back: 'file_1'}]);
  assert.equal(create.body.texture_quality, 'detailed'); assert.equal(create.body.face_limit, 20000); assert.equal(create.body.pbr, true);
  assert.equal(create.headers.Authorization, 'Bearer key');
  assert.ok(steps.some(([step, percent]) => step === 'Generating' && percent > 8 && percent < 96));
});

test('Tripo: one view uses the single-image endpoint, shape only switches texture and PBR off', async () => {
  const generators = await ready({providers: {tripo: {enabled: true, apiKey: 'key'}}});
  const {calls, fetcher} = fake([
    ['/v3/files', json({code: 0, data: {file_token: 'file_a'}})],
    ['/v3/generation/image-to-model', json({code: 0, data: {task_id: 't'}})],
    ['/v3/tasks/t', json({code: 0, data: {status: 'success', output: {model_url: 'https://cdn.example/m.glb'}}})],
    ['cdn.example', new Response(glb)]
  ]);
  await generators.generate({route: 'tripo', views: {front: picture()}, texture: false, fetcher, wait: noWait});
  const create = calls.find(c => c.url.endsWith('/image-to-model'));
  assert.equal(create.body.input, 'file_a'); assert.equal(create.body.texture, false); assert.equal(create.body.pbr, false); assert.equal('face_limit' in create.body, false);
});

test('Tripo: no credits, a bad key and a failed task are reported in plain words', async () => {
  const generators = await ready({providers: {tripo: {enabled: true, apiKey: 'key'}}});
  const broke = fake([['/v3/files', json({code: 2010, message: 'not enough credit'}, 403)]]);
  await assert.rejects(generators.generate({route: 'tripo', views: {front: picture()}, fetcher: broke.fetcher, wait: noWait}), /no credits left/);
  await assert.rejects(generators.test('tripo', fake([['/account/balance', json({code: 2}, 401)]]).fetcher), /rejected the API key/);
  const failing = fake([['/v3/files', json({data: {file_token: 'f'}})], ['/image-to-model', json({data: {task_id: 't'}})], ['/tasks/t', json({data: {status: 'failed', error_message: 'image unclear'}})]]);
  await assert.rejects(generators.generate({route: 'tripo', views: {front: picture()}, fetcher: failing.fetcher, wait: noWait}), /image unclear.*Nothing was charged/);
  assert.match((await generators.test('tripo', fake([['/account/balance', json({code: 0, data: {balance: 1234}})]]).fetcher)).message, /1,234 credits \(\$12\.34\)/);
});

test('Meshy: sends pictures as data links with the front first and reads the GLB link', async () => {
  const generators = await ready({providers: {meshy: {enabled: true, apiKey: 'msy_key'}}});
  const {calls, fetcher} = fake([
    ['/multi-image-to-3d/job', json({status: 'SUCCEEDED', progress: 100, consumed_credits: 30, model_urls: {glb: 'https://assets.example/model.glb'}})],
    ['/multi-image-to-3d', json({result: 'job'}, 202)],
    ['assets.example', new Response(glb)]
  ]);
  const made = await generators.generate({route: 'meshy', views: {right: picture(), front: {bytes: png(), extension: '.jpg'}}, faceLimit: 5000, fetcher, wait: noWait});
  assert.equal(made.credits, 30);
  const create = calls.find(c => c.method === 'POST');
  assert.equal(create.body.image_urls.length, 2); assert.match(create.body.image_urls[0], /^data:image\/jpeg;base64,/);
  assert.equal(create.body.should_texture, true); assert.equal(create.body.enable_pbr, true); assert.deepEqual(create.body.target_formats, ['glb']);
  assert.equal(create.body.should_remesh, true); assert.equal(create.body.target_polycount, 5000);
  const free = fake([['/image-to-3d', json({message: 'Creating a task requires a paid plan'}, 402)]]);
  await assert.rejects(generators.generate({route: 'meshy', views: {front: picture()}, fetcher: free.fetcher, wait: noWait}), /paid plan/);
});

test('Local: speaks the Hunyuan3D server protocol and refuses a reply that is not a model', async () => {
  const generators = await ready({providers: {local: {enabled: true, url: 'http://127.0.0.1:8080/'}}});
  const {calls, fetcher} = fake([
    ['/send', json({uid: 'u1'})],
    ['/status/u1', all => all.filter(c => c.url.includes('/status/')).length < 2 ? json({status: 'processing'}) : json({status: 'completed', model_base64: glb.toString('base64')})]
  ]);
  const made = await generators.generate({route: 'local', views: {front: picture(), back: picture()}, fetcher, wait: noWait});
  assert.equal(made.route, 'local');
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/send'); assert.equal(calls[0].body.image, png().toString('base64')); assert.equal(calls[0].body.texture, false);
  const wrong = fake([['/send', json({uid: 'u'})], ['/status/u', json({status: 'completed', model_base64: Buffer.from('<html>').toString('base64')})]]);
  await assert.rejects(generators.generate({route: 'local', views: {front: picture()}, fetcher: wrong.fetcher, wait: noWait}), /not a GLB/);
  await assert.rejects(generators.test('local', async () => { throw Error('ECONNREFUSED'); }), /Nothing answered/);
});

test('a generation started from the app runs in the background, reports progress and lands in the library', async () => {
  const generators = await ready({route: 'local', providers: {local: {enabled: true}}}), events = [], imported = [];
  generators.generate = async ({progress}) => { progress('Generating', 50); return {bytes: glb, route: 'local'}; };
  const jobs = new Generations({generators, broadcast: event => events.push(event), budget: () => 9000, readImage: async () => png(), importModel: async (name, bytes) => { imported.push([name, bytes.length]); return {id: 'abcdef012345'}; }});
  await assert.rejects(jobs.start({name: 'Ace', views: {}}), /front view/);
  await assert.rejects(jobs.start({name: 'Ace', views: {front: 'data:text/html;base64,AAAA'}}), /PNG, JPG or WebP/);
  const job = await jobs.start({name: 'Ace: hero/1', views: {front: 'data:image/png;base64,' + png().toString('base64'), back: 'aaaaaaaaaaaa'}});
  assert.equal(job.status, 'running'); assert.equal(job.providerLabel, 'Local model');
  await new Promise(resolve => setTimeout(resolve, 20));
  const done = jobs.list()[0];
  assert.equal(done.status, 'done'); assert.equal(done.assetId, 'abcdef012345'); assert.equal(done.progress, 100);
  assert.deepEqual(imported, [['Ace_ hero_1.glb', glb.length]]);
  assert.ok(events.some(e => e.type === 'generations' && e.generations[0].step === 'Generating'));
  assert.throws(() => jobs.cancel(job.id), /no longer running/);
  jobs.dismiss(job.id); assert.equal(jobs.list().length, 0);
});

test('cancelling a running generation stops it and marks it cancelled', async () => {
  const generators = await ready({route: 'local', providers: {local: {enabled: true}}});
  generators.generate = ({signal}) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('Operation cancelled.'))));
  const jobs = new Generations({generators, readImage: async () => png(), importModel: async () => ({id: 'x'})});
  const job = await jobs.start({name: 'Ace', views: {front: 'data:image/png;base64,' + png().toString('base64')}});
  assert.throws(() => jobs.dismiss(job.id), /Cancel/);
  jobs.cancel(job.id); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(jobs.list()[0].status, 'cancelled');
});

test('a generation that was running when Meshdesk stopped is shown as interrupted after the restart', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'meshdesk-jobs-')), file = path.join(folder, 'generations.json');
  const generators = await ready({route: 'local', providers: {local: {enabled: true}}});
  generators.generate = ({signal}) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('Operation cancelled.'))));
  const jobs = new Generations({generators, file, readImage: async () => png(), importModel: async () => ({id: 'x'})}); await jobs.init();
  await jobs.start({name: 'Mr Bean', views: {front: 'data:image/png;base64,' + png().toString('base64')}});
  await new Promise(resolve => setTimeout(resolve, 20));
  const after = new Generations({generators, file, readImage: async () => png(), importModel: async () => ({id: 'x'})}); await after.init();
  assert.equal(after.list().length, 1); assert.equal(after.list()[0].name, 'Mr Bean'); assert.equal(after.list()[0].status, 'failed'); assert.match(after.list()[0].error, /Interrupted when Meshdesk stopped/);
  after.dismiss(after.list()[0].id); jobs.shutdown(); await new Promise(resolve => setTimeout(resolve, 20));
  await fs.rm(folder, {recursive: true, force: true});
});

test('the agent tool resolves the pictures, picks the route and returns the new model with a render', async () => {
  assert.ok(editTools.some(t => t.name === 'model_from_image'));
  const generators = await ready({providers: {tripo: {enabled: true, apiKey: 'a'}, meshy: {enabled: true, apiKey: 'b'}}}), seen = [];
  generators.generate = async input => { seen.push(input); return {bytes: glb, route: input.route, credits: 30}; };
  const jobs = new Generations({generators, readImage: async () => png(), importModel: async () => ({id: 'abcdef012345'})});
  const library = {require: id => ({id, name: 'Ace', type: 'model'}), inspect: async () => ({stats: {triangles: 1200}, issues: [], image: Buffer.from('img')})};
  const extras = {generations: jobs, generated: [{bytes: png(), extension: '.png'}], settings: () => ({})}, steps = [];
  await assert.rejects(executeEditTool(library, 'model_from_image', {name: 'Ace', front: 'generated', left: '', back: '', right: '', route: '', texture: 'true'}, null, () => {}, extras), /Ask them which to use/);
  await assert.rejects(executeEditTool(library, 'model_from_image', {name: 'Ace', front: '', left: '', back: 'generated', right: '', route: 'tripo', texture: 'true'}, null, () => {}, extras), /front is required/);
  const result = await executeEditTool(library, 'model_from_image', {name: 'Ace', front: 'generated', left: '', back: 'generated', right: '', route: 'meshy', texture: 'false'}, null, step => steps.push(step), extras);
  assert.equal(result.assetId, 'abcdef012345'); assert.equal(result.route, 'meshy'); assert.equal(result.creditsUsed, 30); assert.deepEqual(result.viewsUsed, ['front', 'back']);
  assert.equal(seen[0].texture, false); assert.deepEqual(Object.keys(seen[0].views), ['front', 'back']);
  assert.ok(result.image);
});
