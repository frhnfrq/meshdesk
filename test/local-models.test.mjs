import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalModels, MODELS, detectHardware, suitability, torchPackages, diskNeeded, weightSets} from '../server/local-models.mjs';
import {Generators} from '../server/generators.mjs';

const mac = {platform: 'darwin', arch: 'arm64', key: 'darwin-arm64', memoryGB: 24, gpu: {kind: 'apple', name: 'Apple M2', vramGB: 24}, freeDiskGB: 150};
const pc = {platform: 'win32', arch: 'x64', key: 'win32-x64', memoryGB: 32, gpu: {kind: 'nvidia', name: 'RTX 3070 Ti', vramGB: 8}, freeDiskGB: 200};
const folder = () => fs.mkdtemp(path.join(os.tmpdir(), 'meshdesk-local-'));

test('hardware is read from nvidia-smi or the Mac chip, and a machine without either is reported plainly', async () => {
  const nvidia = await detectHardware({platform: 'win32', arch: 'x64', memory: 32 * 2 ** 30, exec: async file => file === 'nvidia-smi' ? 'NVIDIA GeForce RTX 3070 Ti, 8192' : ''});
  assert.deepEqual(nvidia.gpu, {kind: 'nvidia', name: 'NVIDIA GeForce RTX 3070 Ti', vramGB: 8}); assert.equal(nvidia.key, 'win32-x64');
  const apple = await detectHardware({platform: 'darwin', arch: 'arm64', memory: 24 * 2 ** 30, exec: async file => file === 'sysctl' ? 'Apple M2' : ''});
  assert.equal(apple.gpu.kind, 'apple'); assert.equal(apple.gpu.name, 'Apple M2'); assert.equal(apple.memoryGB, 24);
  const none = await detectHardware({platform: 'linux', arch: 'x64', exec: async () => ''});
  assert.equal(none.gpu.kind, 'none');
});

test('each model says whether it suits the machine, and is only called tested where it has been run', () => {
  assert.equal(suitability('hunyuan', mac).tested, true);
  assert.match(suitability('hunyuan', mac).note, /11 minutes/);
  assert.equal(suitability('hunyuan', pc).ok, true, 'Hunyuan3D 2.1 has a low-memory mode that fits 8 GB');
  const small = suitability('hunyuan', {...pc, gpu: {...pc.gpu, vramGB: 6}});
  assert.equal(small.ok, false, 'a model that needs more video memory than the card has is refused'); assert.match(small.reason, /Needs 8 GB of video memory; this card has 6 GB/);
  assert.equal(suitability('triposg', pc).ok, true); assert.equal(suitability('hunyuan-mv', pc).ok, true);
  assert.equal(diskNeeded('triposg', pc), 15, 'an NVIDIA machine needs room for the larger PyTorch'); assert.equal(diskNeeded('triposg', mac), 10);
  assert.match(suitability('triposg', {...pc, freeDiskGB: 18}).reason, /about 15 GB of disk space/);
  assert.match(suitability('triposg', {...mac, memoryGB: 8}).reason, /16 GB of memory/);
  assert.match(suitability('triposg', {...mac, freeDiskGB: 5}).reason, /disk space/);
  assert.match(suitability('hunyuan', {platform: 'darwin', arch: 'x64', key: 'darwin-x64', memoryGB: 32, gpu: {kind: 'none'}, freeDiskGB: 100}).reason, /Apple Silicon/);
  assert.match(suitability('hunyuan', {platform: 'linux', arch: 'x64', key: 'linux-x64', memoryGB: 32, gpu: {kind: 'none'}, freeDiskGB: 100}).reason, /NVIDIA/);
});

test('every recipe pins its code and weights to exact versions', () => {
  for (const [id, model] of Object.entries(MODELS)) {
    for (const source of model.sources) assert.match(source.commit, /^[a-f0-9]{40}$/);
    for (const set of weightSets(id)) assert.match(set.revision, /^[a-f0-9]{40}$/);
    assert.ok(model.packages.length > 5);
    for (const wheel of model.wheels || []) assert.match(wheel, /^(whl\/|https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/[a-f0-9]{40}\/)[\w.+\/-]+\.whl$/, 'prebuilt binaries come from a pinned commit, by exact file name');
    assert.ok(model.licence.url.startsWith('https://'));
  }
  assert.ok(MODELS.hunyuan.licence.accept, 'the restricted licence must be accepted');
  assert.equal(MODELS.triposg.licence.accept, undefined);
});

test('a Mac gets the exact PyTorch the recipes were tested with, an NVIDIA machine the newest its driver supports', () => {
  assert.deepEqual(torchPackages(mac), ['torch==2.15.0', 'torchvision==0.29.2']);
  assert.deepEqual(torchPackages(pc), ['torch>=2.6', 'torchvision>=0.21']);
});

test('installing is refused without the licence, on unsuitable hardware, and for an unknown model', async () => {
  const root = await folder(), models = new LocalModels({root, hardware: mac}); await models.init();
  await assert.rejects(models.install('hunyuan'), /Accept the Tencent/);
  await assert.rejects(models.install('nope'), /Unknown model/);
  const weak = new LocalModels({root, hardware: {...mac, memoryGB: 8}});
  await assert.rejects(weak.install('triposg'), /16 GB of memory/);
  await assert.rejects(models.start('triposg'), /not installed/);
  const shown = await models.public();
  assert.deepEqual(shown.models.map(m => [m.id, m.installed, m.ok]), [['hunyuan', false, true], ['triposg', false, true], ['hunyuan-mv', false, true], ['trellis', false, false], ['trellis2', false, false]]);
  assert.match(shown.models[3].reason, /Windows with an NVIDIA card only/); assert.equal(shown.models[3].textured, true);
  assert.equal(suitability('trellis', pc).ok, true); assert.equal(suitability('trellis2', pc).ok, true); assert.match(suitability('trellis2', {...pc, memoryGB: 16}).reason, /Needs 24 GB of memory; this computer has 16 GB/); assert.ok(MODELS.trellis.licence.accept, 'installing community-built binaries must be agreed to');
  assert.equal(shown.server.state, 'stopped');
  await fs.rm(root, {recursive: true, force: true});
});

test('a download resumes from where it stopped and is skipped when the file is already complete', async () => {
  const root = await folder(), target = path.join(root, 'weights', 'model.bin'), full = Buffer.from('0123456789abcdefghij'), requests = [];
  const models = new LocalModels({root, hardware: mac, fetcher: async (url, options) => {
    const range = options.headers?.Range; requests.push(range || 'whole');
    if (range) return new Response(full.subarray(Number(range.match(/\d+/)[0])), {status: 206});
    return new Response(full);
  }});
  await fs.mkdir(path.dirname(target), {recursive: true}); await fs.writeFile(target + '.part', full.subarray(0, 8));
  const seen = [];
  await models.download('https://example.test/model.bin', target, null, bytes => seen.push(bytes), full.length);
  assert.deepEqual(requests, ['bytes=0-0', 'bytes=8-']); assert.equal((await fs.readFile(target)).toString(), full.toString()); assert.equal(seen.at(-1), full.length);
  await models.download('https://example.test/model.bin', target, null, () => {}, full.length);
  assert.equal(requests.length, 2, 'a finished file is not fetched again');
  const missing = new LocalModels({root, hardware: mac, fetcher: async () => new Response('', {status: 404})});
  await assert.rejects(missing.download('https://example.test/gone.bin', path.join(root, 'gone.bin'), null), /failed \(404\)/);
  await fs.rm(root, {recursive: true, force: true});
});

test('a large file comes down in pieces, resumes each piece, and sends the Hugging Face token only to Hugging Face', async () => {
  const root = await folder(), full = Buffer.alloc(100 * 2 ** 20); for (let i = 0; i < full.length; i += 4096) full.writeUInt32LE(i, i);
  const calls = [];
  const serve = async (url, options) => {
    const [, from, to] = options.headers.Range.match(/bytes=(\d+)-(\d*)/); calls.push({url, range: options.headers.Range, auth: options.headers.Authorization});
    const end = to === '' ? full.length - 1 : Number(to);
    return new Response(full.subarray(Number(from), end + 1), {status: 206, headers: {'content-range': 'bytes ' + from + '-' + end + '/' + full.length}});
  };
  const models = new LocalModels({root, hardware: mac, fetcher: serve}); models.token = () => 'hf_secret';
  const target = path.join(root, 'big.bin'), piece = Math.ceil(full.length / 4);
  await fs.writeFile(target + '.piece1', full.subarray(piece, piece + 1000));
  let last = 0;
  await models.download('https://huggingface.co/org/model/resolve/abc/big.bin', target, null, bytes => { last = bytes; });
  assert.ok((await fs.readFile(target)).equals(full), 'the joined file is identical'); assert.equal(last, full.length);
  assert.equal(calls.filter(c => c.range !== 'bytes=0-0').length, 4, 'four pieces of about 32 MB');
  assert.ok(calls.some(c => c.range === 'bytes=' + (piece + 1000) + '-' + (2 * piece - 1)), 'a piece that was part done resumes from where it stopped');
  assert.ok(calls.every(c => c.auth === 'Bearer hf_secret'));
  assert.deepEqual((await fs.readdir(root)).sort(), ['big.bin'], 'no pieces are left behind');
  calls.length = 0; await models.download('https://example.test/other.bin', path.join(root, 'other.bin'), null);
  assert.ok(calls.every(c => c.auth === undefined), 'the token is not sent to other hosts');
  const gated = new LocalModels({root, hardware: mac, fetcher: async () => new Response('', {status: 401})});
  await assert.rejects(gated.download('https://huggingface.co/org/gated/resolve/abc/w.bin', path.join(root, 'w.bin'), null), /needs a Hugging Face token/);
  await fs.rm(root, {recursive: true, force: true});
});

test('after the models folder is moved, models installed in the old one still work and new ones go to the new one', async () => {
  const old = await folder(), fresh = await folder(); await fs.mkdir(path.join(old, 'triposg'), {recursive: true}); await fs.writeFile(path.join(old, 'triposg', 'installed.json'), '{}');
  await fs.mkdir(path.join(fresh, 'trellis2'), {recursive: true}); await fs.writeFile(path.join(fresh, 'trellis2', 'installed.json'), '{}');
  const models = new LocalModels({root: fresh, olderRoots: [old, fresh], hardware: pc}); await models.init();
  assert.equal(models.isInstalled('triposg'), true); assert.equal(models.isInstalled('trellis2'), true);
  assert.equal(models.base('triposg'), old); assert.equal(models.base('trellis2'), fresh); assert.equal(models.base('hunyuan-mv'), fresh, 'a model not yet installed will go to the new folder');
  await models.remove('triposg');
  assert.deepEqual(await fs.readdir(old), [], 'removing a model deletes it from the folder it was in');
  await fs.rm(old, {recursive: true, force: true}); await fs.rm(fresh, {recursive: true, force: true});
});

test('generations wait their turn, the right model is loaded for each, and a stalled caller does not hold up the queue', async () => {
  const http = await import('node:http'), order = [];
  let release; const gate = new Promise(resolve => { release = resolve; });
  const server = http.createServer(async (req, res) => {
    const send = body => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body)); };
    if (req.url === '/send') { let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); order.push(body.tag); return send({uid: 'u-' + body.tag}); }
    if (req.url === '/status/u-first') { await gate; return send({status: 'completed', model_base64: 'Zmlyc3Q='}); }
    if (req.url.startsWith('/status/')) return send({status: 'completed', model_base64: 'c2Vjb25k'});
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port, loads = [];
  const models = new LocalModels({root: os.tmpdir(), hardware: pc, pollMs: 5}); models.installed.add('trellis2'); models.installed.add('triposg');
  models.start = async id => { loads.push(id); models.server = {model: id, state: 'running'}; return url; };
  const first = models.submit('trellis2', {tag: 'first'}), second = models.submit('triposg', {tag: 'second'});
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(order, ['first'], 'the second waits for the first');
  assert.match(models.status(second.uid).message, /Waiting for another generation/);
  assert.equal(models.status(second.uid).queued, 1);
  assert.equal((await models.public()).queue.waiting, 1);
  assert.throws(() => models.submit('hunyuan', {}), /not installed/);
  release();   // nobody asks about the first; the queue still moves on
  for (let i = 0; i < 100 && models.running; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(order, ['first', 'second']); assert.deepEqual(loads, ['trellis2', 'triposg'], 'each job loads its own model, in turn');
  assert.equal(models.status(first.uid).model_base64, 'Zmlyc3Q=', 'a result waits to be collected');
  assert.match(models.status(first.uid).message, /no longer known/, 'and is given out once');
  assert.equal(models.status(second.uid).status, 'completed');
  server.close();
});

test('cancelling takes a waiting generation out of the queue and stops a running one on the model server', async () => {
  const http = await import('node:http'), cancels = [];
  const server = http.createServer(async (req, res) => {
    const send = body => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body)); };
    if (req.url === '/send') { for await (const chunk of req) void chunk; return send({uid: 'serve-1'}); }
    if (req.url.startsWith('/cancel/')) { cancels.push(req.url); return send({ok: true}); }
    if (req.url === '/status/serve-1') return send(cancels.length ? {status: 'error', message: 'Cancelled.', cancelled: true} : {status: 'processing', message: 'Generating', progress: 40});
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const models = new LocalModels({root: os.tmpdir(), hardware: pc, pollMs: 5}); models.installed.add('triposg'); models.start = async () => url;
  const running = models.submit('triposg', {}), waiting = models.submit('triposg', {});
  for (let i = 0; i < 100 && models.status(running.uid).message !== 'Generating'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  models.cancel(waiting.uid);
  assert.equal(models.status(waiting.uid).cancelled, true, 'the waiting one is cancelled at once');
  assert.equal(models.waiting.length, 0);
  models.cancel(running.uid);
  for (let i = 0; i < 100 && models.running; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(cancels, ['/cancel/serve-1'], 'the model server is told to stop');
  const result = models.status(running.uid); assert.equal(result.cancelled, true); assert.equal(models.running, null, 'the machine is free again');
  server.close();
});

test('a connection that goes quiet is dropped and the download carries on from what was saved', async () => {
  const root = await folder(), full = Buffer.alloc(70 * 2 ** 20, 7), ranges = [];
  let stalls = 0;
  const serve = async (url, options) => {
    const [, from, to] = options.headers.Range.match(/bytes=(\d+)-(\d*)/), start = Number(from), end = to === '' ? full.length - 1 : Number(to); ranges.push(options.headers.Range);
    const headers = {'content-range': 'bytes ' + start + '-' + end + '/' + full.length};
    if (start === 0 && end > 0 && stalls++ === 0) return new Response(new ReadableStream({start(controller) { controller.enqueue(full.subarray(0, 2 ** 20 + 5)); }}), {status: 206, headers});   // sends a little, then goes silent
    return new Response(full.subarray(start, end + 1), {status: 206, headers});
  };
  const models = new LocalModels({root, hardware: mac, fetcher: serve}); models.stallMs = 150;
  const target = path.join(root, 'big.bin');
  await models.download('https://example.test/big.bin', target, null);
  assert.ok((await fs.readFile(target)).equals(full));
  assert.ok(ranges.some(r => r.startsWith('bytes=' + (2 ** 20 + 5) + '-')), 'the stalled piece resumed after the bytes it had');
  await fs.rm(root, {recursive: true, force: true});
});

test('an installed model is found again after a restart, makes the local route ready, and can be removed', async () => {
  const root = await folder(); await fs.mkdir(path.join(root, 'triposg'), {recursive: true}); await fs.writeFile(path.join(root, 'triposg', 'installed.json'), '{}');
  const models = new LocalModels({root, hardware: mac}); await models.init();
  assert.equal(models.isInstalled('triposg'), true);
  const generators = new Generators(null, {}); generators.local = models;
  await generators.update({providers: {local: {enabled: true, managed: 'hunyuan'}}});
  assert.equal(generators.ready('local'), true); assert.equal(generators.defaultModel('local'), 'triposg', 'when the chosen model is gone, an installed one is used');
  await generators.update({providers: {local: {managed: 'triposg'}}});
  assert.deepEqual(generators.models('local'), [{id: 'triposg', label: 'TripoSG', multiview: false}]);
  assert.equal(generators.choose('local:triposg'), 'local:triposg');
  assert.throws(() => generators.choose('local:hunyuan-mv'), /not installed on This computer.*Installed there: triposg/);
  assert.equal(generators.ready('local'), true); assert.equal(generators.label('local'), 'This computer (TripoSG)'); assert.equal(generators.choose(''), 'local');
  await assert.rejects(generators.update({providers: {local: {managed: 'other'}}}), /from the list/);
  let removed; models.onRemoved = id => { removed = id; };
  await models.remove('triposg');
  assert.equal(removed, 'triposg'); assert.equal(models.isInstalled('triposg'), false); assert.equal(generators.ready('local'), false);
  await fs.rm(root, {recursive: true, force: true});
});
