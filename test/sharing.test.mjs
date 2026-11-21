import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Sharing, broadcastAddresses, newCode} from '../server/sharing.mjs';
import {Generators} from '../server/generators.mjs';
import {LocalModels} from '../server/local-models.mjs';
import os from 'node:os';

const glb = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(40)]);
function png() {
  const bytes = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'latin1'); bytes.writeUInt32BE(64, 16); bytes.writeUInt32BE(64, 20);
  return bytes;
}
const hardware = {platform: 'win32', arch: 'x64', key: 'win32-x64', memoryGB: 32, gpu: {kind: 'nvidia', name: 'RTX 3070 Ti', vramGB: 8}, freeDiskGB: 200};
/** A stand-in for the model server a desktop would run, and the local models object that starts it. */
async function desktop() {
  const seen = [], bodies = [], server = http.createServer((req, res) => {
    const send = body => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body)); };
    if (req.url === '/send') { const chunks = []; req.on('data', chunk => chunks.push(chunk)); return req.on('end', () => { seen.push(1); bodies.push(JSON.parse(Buffer.concat(chunks))); send({uid: '11111111-2222-3333-4444-555555555555'}); }); }
    if (req.url.startsWith('/status/')) return send({status: 'completed', model_base64: glb.toString('base64')});
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  // The real queue, with model loading replaced by the stand-in server above.
  const models = new LocalModels({root: os.tmpdir(), hardware, pollMs: 5}), installed = models.installed;
  installed.add('triposg'); models.start = async () => url;
  return {seen, bodies, server, models, installed};
}
const port = () => 20000 + Math.floor(Math.random() * 20000);

test('pairing codes are eight unambiguous characters, and every network gets a discovery call', () => {
  assert.match(newCode(), /^[A-HJ-NP-Z2-9]{8}$/); assert.notEqual(newCode(), newCode());
  assert.deepEqual(broadcastAddresses({en0: [{family: 'IPv4', internal: false, address: '192.168.1.42', netmask: '255.255.255.0'}], lo0: [{family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0'}]}), ['255.255.255.255', '192.168.1.255']);
});

test('a laptop finds a sharing desktop, pairs with its code and generates on it', async () => {
  const pc = await desktop(), pcSettings = new Generators(null, {}); pcSettings.local = pc.models; pcSettings.identify();
  await pcSettings.update({providers: {local: {enabled: true, managed: 'triposg'}}, share: {name: 'Studio PC'}});
  const sharePort = port(), discoveryPort = port();
  const sharing = new Sharing({generators: pcSettings, localModels: pc.models, port: sharePort, discoveryPort, host: '127.0.0.1'});
  assert.equal((await sharing.public()).running, false, 'sharing is off until switched on');
  const shown = await sharing.update({enabled: true});
  assert.equal(shown.running, true); assert.equal(shown.name, 'Studio PC'); assert.match(shown.code, /^[A-Z0-9]{8}$/); assert.equal(shown.model, 'TripoSG');

  const laptopSettings = new Generators(null, {}); laptopSettings.identify();
  const laptop = new Sharing({generators: laptopSettings, localModels: {isInstalled: () => false, hardware: async () => hardware}, port: port(), discoveryPort});
  const found = await laptop.discover({wait: 400, addresses: ['127.0.0.1']});
  assert.equal(found.length, 1); assert.equal(found[0].name, 'Studio PC'); assert.equal(found[0].model, 'TripoSG'); assert.equal(found[0].ready, true); assert.match(found[0].gpu, /3070 Ti · 8 GB/);
  assert.equal(found[0].url, 'http://127.0.0.1:' + sharePort);
  assert.equal((await sharing.discover({wait: 300, addresses: ['127.0.0.1']})).length, 0, 'a computer does not list itself');

  await laptopSettings.update({providers: {local: {enabled: true, url: found[0].url, code: 'WRONGCODE'}}});
  await assert.rejects(laptopSettings.test('local'), /pairing code for Studio PC is wrong/);
  await assert.rejects(laptopSettings.generate({route: 'local', views: {front: {bytes: png(), extension: '.png'}}, wait: async () => {}}), /pairing code/);
  await laptopSettings.update({providers: {local: {code: shown.code.toLowerCase().replace(/(.{4})/, '$1-')}}});
  assert.match((await laptopSettings.test('local')).message, /Connected to Studio PC · TripoSG on RTX 3070 Ti/);
  assert.equal(JSON.stringify(laptopSettings.public()).includes(shown.code), false, 'the saved code is not sent back to the viewer');
  const made = await laptopSettings.generate({route: 'local', views: {front: {bytes: png(), extension: '.png'}}, wait: async () => {}});
  assert.equal(made.bytes.toString('latin1', 0, 4), 'glTF'); assert.equal(pc.seen.length, 1, 'the picture reached the desktop’s model once');

  // Paired properly, the desktop becomes a route of its own that sits beside this computer's own model.
  await assert.rejects(laptopSettings.pair({url: found[0].url, code: 'AAAAAAAA'}), /pairing code for Studio PC is wrong/);
  const paired = await laptopSettings.pair({url: found[0].url, code: shown.code});
  assert.match(paired.id, /^pc-[a-f0-9]{10}$/); assert.match(paired.message, /Connected to Studio PC/);
  await laptopSettings.pair({url: found[0].url, code: shown.code});
  const routes = laptopSettings.public().providers;
  assert.equal(routes.filter(p => p.kind === 'remote').length, 1, 'pairing twice with one address keeps one entry');
  const entry = routes.find(p => p.id === paired.id);
  assert.equal(entry.label, 'Studio PC'); assert.equal(entry.ready, true); assert.match(entry.about, /TripoSG on RTX 3070 Ti/);
  assert.equal(JSON.stringify(laptopSettings.public()).includes(shown.code), false);
  assert.throws(() => laptopSettings.choose(''), /Ask them which to use.*pc-/s, 'with two machines and no default the agent asks');
  assert.equal(laptopSettings.choose(paired.id), paired.id);
  await laptopSettings.update({route: paired.id});
  assert.equal(laptopSettings.choose(''), paired.id); assert.ok(laptopSettings.brief().routes.some(r => r.route === paired.id && r.name === 'Studio PC'));
  const remote = await laptopSettings.generate({route: paired.id, views: {front: {bytes: png(), extension: '.png'}}, wait: async () => {}});
  assert.equal(remote.route, paired.id); assert.equal(pc.seen.length, 2);
  assert.match((await laptopSettings.test(paired.id)).message, /Connected to Studio PC/);
  // The desktop says which models it has, and one can be named after the route.
  assert.deepEqual(entry.models, [{id: 'triposg', label: 'TripoSG', multiview: false}]);
  assert.equal(laptopSettings.choose(paired.id + ':triposg'), paired.id + ':triposg');
  assert.throws(() => laptopSettings.choose(paired.id + ':hunyuan-mv'), /not installed on Studio PC/);
  pc.installed.add('hunyuan-mv'); assert.equal(await laptopSettings.refresh(), true, 'a refresh picks up a model installed since pairing');
  assert.deepEqual(laptopSettings.public().providers.find(p => p.id === paired.id).models.map(m => [m.id, m.multiview]), [['triposg', false], ['hunyuan-mv', true]]);
  assert.equal(laptopSettings.label(paired.id + ':hunyuan-mv'), 'Studio PC · Hunyuan3D 2 multi-view');
  const before = pc.bodies.length;
  await laptopSettings.generate({route: paired.id + ':hunyuan-mv', views: {front: {bytes: png(), extension: '.png'}, back: {bytes: png(), extension: '.png'}}, wait: async () => {}});
  assert.equal(pc.bodies[before].model, 'hunyuan-mv'); assert.deepEqual(Object.keys(pc.bodies[before].views), ['back'], 'a multi-view model is sent the other views too');
  await laptopSettings.generate({route: paired.id + ':triposg', views: {front: {bytes: png(), extension: '.png'}, back: {bytes: png(), extension: '.png'}}, wait: async () => {}});
  assert.equal(pc.bodies.at(-1).views, undefined, 'a single-view model is sent the front only');
  await laptopSettings.update({textures: {[paired.id + ':hunyuan-mv']: 2048}});
  await laptopSettings.generate({route: paired.id + ':hunyuan-mv', views: {front: {bytes: png(), extension: '.png'}}, wait: async () => {}});
  assert.equal(pc.bodies.at(-1).texture_size, 2048, 'the chosen texture size travels with the request');
  await laptopSettings.generate({route: paired.id + ':triposg', views: {front: {bytes: png(), extension: '.png'}}, wait: async () => {}});
  assert.equal(pc.bodies.at(-1).texture_size, undefined, 'models without a chosen size are left to their default');
  // Cancelling on the laptop reaches the desktop: its queued copy is dropped and never sent to the model server.
  pc.models.start = () => new Promise(() => {});   // the desktop is stuck loading, so a second job has to wait
  const blocker = new AbortController(); void laptopSettings.generate({route: paired.id + ':triposg', views: {front: {bytes: png(), extension: '.png'}}, signal: blocker.signal, wait: (ms, signal) => new Promise((resolve, reject) => { const t = setTimeout(resolve, 5); signal?.addEventListener('abort', () => { clearTimeout(t); reject(Error('Operation cancelled.')); }); })}).catch(() => {});
  const stop = new AbortController(), sentBefore = pc.bodies.length;
  const queued = laptopSettings.generate({route: paired.id + ':triposg', views: {front: {bytes: png(), extension: '.png'}}, signal: stop.signal, wait: (ms, signal) => new Promise((resolve, reject) => { const t = setTimeout(resolve, 5); signal?.addEventListener('abort', () => { clearTimeout(t); reject(Error('Operation cancelled.')); }); })});
  for (let i = 0; i < 100 && pc.models.waiting.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(pc.models.waiting.length, 1, 'the second job waits on the desktop');
  stop.abort(); await assert.rejects(queued, /cancelled/i);
  for (let i = 0; i < 100 && pc.models.waiting.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(pc.models.waiting.length, 0, 'cancelling on the laptop removed it from the desktop queue'); assert.equal(pc.bodies.length, sentBefore);
  blocker.abort(); pc.models.running = null; pc.models.waiting = [];
  pc.installed.delete('hunyuan-mv');
  await laptopSettings.forget(paired.id);
  assert.equal(laptopSettings.public().route, 'ask', 'forgetting the default machine falls back to asking');
  await assert.rejects(laptopSettings.generate({route: paired.id, views: {front: {bytes: png(), extension: '.png'}}}), /Unknown route/);

  pc.installed.clear();
  await assert.rejects(laptopSettings.test('local'), /no local model installed/);
  await sharing.update({enabled: false});
  assert.equal((await laptop.discover({wait: 300, addresses: ['127.0.0.1']})).length, 0);
  await assert.rejects(laptopSettings.test('local'), /Nothing answered/);
  await sharing.shutdown(); pc.server.close();
});

test('a paired computer can list, install, cancel and remove models on the sharing one, and nothing without the code', async () => {
  const actions = [], models = {
    isInstalled: () => true, hardware: async () => hardware, start: async () => 'http://127.0.0.1:1',
    public: async () => ({hardware, models: [{id: 'triposg', installed: true}], installing: null}),
    install: async (id, {accept}) => { actions.push(['install', id, accept]); if (id === 'nope') throw Error('Unknown model.'); return {installing: {model: id, step: 'Starting', progress: 0}}; },
    cancelInstall: () => { actions.push(['cancel']); return {installing: null}; },
    remove: async id => { actions.push(['remove', id]); return {installing: null}; }
  };
  const pcSettings = new Generators(null, {}); pcSettings.local = models; pcSettings.identify(); await pcSettings.update({providers: {local: {enabled: true, managed: 'triposg'}}, share: {name: 'Studio PC'}});
  const sharePort = port(), sharing = new Sharing({generators: pcSettings, localModels: models, port: sharePort, discoveryPort: port(), host: '127.0.0.1'});
  const {code} = await sharing.update({enabled: true});
  const laptop = new Generators(null, {}); laptop.identify();
  const {id} = await laptop.pair({url: 'http://127.0.0.1:' + sharePort, code});
  const listed = await laptop.manage(id, 'list');
  assert.equal(listed.name, 'Studio PC'); assert.equal(listed.models[0].id, 'triposg');
  assert.equal((await laptop.manage(id, 'install', {id: 'hunyuan-mv', accept: true})).installing.model, 'hunyuan-mv');
  await laptop.manage(id, 'cancel'); await laptop.manage(id, 'remove', {id: 'trellis'});
  assert.deepEqual(actions, [['install', 'hunyuan-mv', true], ['cancel'], ['remove', 'trellis']]);
  await assert.rejects(laptop.manage(id, 'install', {id: 'nope'}), /Unknown model/);
  await assert.rejects(laptop.manage(id, 'reboot'), /Unknown action/);
  const intruder = await fetch('http://127.0.0.1:' + sharePort + '/manage/remove', {method: 'POST', body: JSON.stringify({id: 'triposg'}), headers: {Authorization: 'Bearer WRONGCOD'}});
  assert.equal(intruder.status, 401); assert.equal(actions.length, 4, 'nothing happened without the pairing code');
  await sharing.update({enabled: false});
  await assert.rejects(laptop.manage(id, 'list'), /did not answer/);
  await sharing.shutdown();
});

test('a default can name a model on a machine, and choosing one on this computer makes it its own default', async () => {
  const models = {isInstalled: id => ['triposg', 'hunyuan'].includes(id)};
  const settings = new Generators(null, {}); settings.local = models; await settings.update({providers: {local: {enabled: true, managed: 'triposg'}}});
  await settings.update({route: 'local:hunyuan'});
  assert.equal(settings.public().route, 'local:hunyuan'); assert.equal(settings.value.providers.local.managed, 'hunyuan'); assert.equal(settings.choose(''), 'local:hunyuan');
  await assert.rejects(settings.update({route: 'nowhere:triposg'}), /Choose a default/);
  await assert.rejects(settings.update({modelsDirectory: 'relative/folder'}), /full path/);
  await settings.update({textures: {'local:trellis2': 2048, 'pc-1a2b3c4d5e:trellis': '4096'}});
  assert.deepEqual(settings.public().textures, {'local:trellis2': 2048, 'pc-1a2b3c4d5e:trellis': 4096});
  await settings.update({textures: {'local:trellis2': null}}); assert.deepEqual(settings.public().textures, {'pc-1a2b3c4d5e:trellis': 4096}, 'clearing a size goes back to the model default');
  await assert.rejects(settings.update({textures: {'local:trellis2': 3000}}), /texture size/);
  await settings.update({modelsDirectory: '/Volumes/Models'}); assert.equal(settings.public().modelsDirectory, '/Volumes/Models');
});

test('ten wrong codes lock an address out, even with the right code afterwards', async () => {
  const pc = await desktop(), settings = new Generators(null, {}); settings.local = pc.models; settings.identify();
  await settings.update({providers: {local: {enabled: true, managed: 'triposg'}}});
  const sharePort = port(), sharing = new Sharing({generators: settings, localModels: pc.models, port: sharePort, discoveryPort: port(), host: '127.0.0.1'});
  const {code} = await sharing.update({enabled: true}), check = token => fetch('http://127.0.0.1:' + sharePort + '/check', {headers: {Authorization: 'Bearer ' + token}}).then(r => r.status);
  assert.equal(await check(code), 200);
  for (let i = 0; i < 10; i++) assert.equal(await check('AAAAAAAA'), 401);
  assert.equal(await check(code), 401, 'locked out after ten wrong codes');
  assert.equal((await fetch('http://127.0.0.1:' + sharePort + '/health').then(r => r.json())).name, settings.value.share.name, 'the public card still answers');
  const fresh = await sharing.update({newCode: true});
  assert.notEqual(fresh.code, code);
  await sharing.shutdown(); pc.server.close();
});
