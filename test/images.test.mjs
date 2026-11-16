import test from 'node:test';
import assert from 'node:assert/strict';
import {imageInfo, downloadImage, searchImages} from '../server/web-images.mjs';
import {cleanStyle, addBoardItems, applyStyleChanges} from '../server/settings.mjs';
import {executeEditTool, editTools} from '../server/edit-tools.mjs';

function png(width, height) {
  const bytes = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'latin1'); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}
function jpeg(width, height) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03]);
  head.writeUInt16BE(height, 13); head.writeUInt16BE(width, 15);
  return Buffer.concat([head, Buffer.alloc(24)]);
}
const reply = (bytes, type, status = 200, headers = {}) => new Response(bytes, {status, headers: {'content-type': type, ...headers}});
const publicLookup = async () => [{address: '93.184.216.34'}];

test('reads picture sizes from PNG and JPEG headers', () => {
  assert.deepEqual(imageInfo(png(640, 480)), {extension: '.png', width: 640, height: 480});
  assert.deepEqual(imageInfo(jpeg(1200, 800)), {extension: '.jpg', width: 1200, height: 800});
  assert.equal(imageInfo(Buffer.from('<html>not a picture, just a page</html>')), null);
});

test('downloads refuse this computer and the local network', async () => {
  const fetcher = async () => { throw Error('must not fetch'); };
  for (const url of ['http://127.0.0.1:8790/api/bootstrap', 'http://192.168.1.10/a.png', 'http://[::1]/a.png', 'file:///etc/passwd'])
    await assert.rejects(downloadImage(url, {fetcher, lookup: publicLookup}), /local network|Only http/);
  await assert.rejects(downloadImage('https://looks-public.example/a.png', {fetcher, lookup: async () => [{address: '10.0.0.5'}]}), /local network/);
});

test('a redirect to a private address is refused, and a page link follows its main picture', async () => {
  const hop = async () => reply('', 'text/plain', 302, {location: 'http://169.254.169.254/latest'});
  await assert.rejects(downloadImage('https://example.com/a.png', {fetcher: hop, lookup: async host => [{address: host === 'example.com' ? '93.184.216.34' : '169.254.169.254'}]}), /local network/);
  const seen = [];
  const fetcher = async url => { seen.push(String(url)); return String(url).endsWith('/post') ? reply('<html><head><meta property="og:image" content="/img/cover.png?a=1&amp;b=2"></head></html>', 'text/html; charset=utf-8') : reply(png(800, 600), 'image/png'); };
  const got = await downloadImage('https://example.com/post', {fetcher, lookup: publicLookup});
  assert.deepEqual(seen, ['https://example.com/post', 'https://example.com/img/cover.png?a=1&b=2']);
  assert.equal(got.extension, '.png'); assert.equal(got.width, 800);
  await assert.rejects(downloadImage('https://example.com/x', {fetcher: async () => reply('plain words, no picture here at all', 'text/plain'), lookup: publicLookup}), /not a PNG/);
});

test('search mixes both services and survives one of them failing', async () => {
  const fetcher = async url => String(url).includes('openverse') ? Response.json({results: [{title: 'Tram', url: 'https://a.example/1.jpg', thumbnail: 'https://a.example/t1.jpg', width: 10, height: 5, source: 'flickr'}]}) : new Response('no', {status: 500});
  const results = await searchImages('tram', {fetcher});
  assert.equal(results.length, 1); assert.equal(results[0].url, 'https://a.example/1.jpg');
  await assert.rejects(searchImages('tram', {fetcher: async () => new Response('no', {status: 500})}), /could not be reached/);
});

test('new moodboard items land to the right of the existing ones without overlapping', () => {
  const style = cleanStyle({board: {items: [{id: 'a', kind: 'image', assetId: 'aaaaaaaaaaaa', x: 0, y: 40, w: 300}, {id: 'n', kind: 'note', text: 'hi', x: 100, y: 500, w: 200}]}});
  const {style: next, added} = addBoardItems(style, [{kind: 'image', assetId: 'bbbbbbbbbbbb'}, {kind: 'image', assetId: 'cccccccccccc'}, {kind: 'note', text: 'Warm light'}, {kind: 'swatch', color: '#AA3300', name: 'Brick'}, {kind: 'image', assetId: 'dddddddddddd'}], {bbbbbbbbbbbb: [100, 200], cccccccccccc: [400, 100]});
  assert.equal(next.board.items.length, 7); assert.equal(added.length, 5);
  assert.ok(added.every(item => item.x >= 300 + 48), 'placed to the right');
  assert.equal(Math.min(...added.map(i => i.y)), 40);
  const tall = {bbbbbbbbbbbb: 560, cccccccccccc: 70, dddddddddddd: 280};
  const boxes = added.map(i => ({x: i.x, y: i.y, w: i.kind === 'swatch' ? 140 : i.w, h: i.assetId ? tall[i.assetId] : 40}));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'no overlap'); }
  assert.equal(added[3].color, '#aa3300');
  assert.ok(next.references.includes('bbbbbbbbbbbb'));
  assert.equal(addBoardItems(style, [{kind: 'note', text: 'x', x: 5, y: 6, w: 100}]).added[0].x, 5);
});

test('a guide from before the canvas keeps its references when an agent adds to the board', () => {
  const legacy = cleanStyle({references: ['aaaaaaaaaaaa']});
  const {style} = addBoardItems(legacy, [{kind: 'image', assetId: 'bbbbbbbbbbbb'}]);
  assert.deepEqual(style.board.items.map(i => i.assetId), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  assert.throws(() => addBoardItems(legacy, []), /at least one/);
});

test('proposals can remove and move moodboard items', () => {
  const style = cleanStyle({board: {items: [{id: 'a', kind: 'image', assetId: 'aaaaaaaaaaaa', x: 0, y: 0, w: 300}, {id: 'n', kind: 'note', text: 'hi', x: 100, y: 500, w: 200}]}});
  const next = applyStyleChanges(style, {removeBoardItems: ['Street'], moveBoardItems: [{item: 'n', x: 10, w: 320}], boardNames: {aaaaaaaaaaaa: 'Street'}});
  assert.deepEqual(next.board.items, [{id: 'n', x: 10, y: 500, w: 320, kind: 'note', text: 'hi'}]);
  assert.deepEqual(next.references, []);
  assert.throws(() => applyStyleChanges(style, {removeBoardItems: ['nope']}), /No moodboard item/);
});

function harness() {
  const assets = new Map([['aaaaaaaaaaaa', {id: 'aaaaaaaaaaaa', type: 'reference', name: 'Street'}], ['bbbbbbbbbbbb', {id: 'bbbbbbbbbbbb', type: 'model', name: 'Cart'}]]);
  const library = {catalog: assets, require(id) { const asset = assets.get(id); if (!asset) throw Error('Asset not found.'); return asset; }, file: asset => '/lib/' + asset.id};
  const imported = [], shown = [], boards = [];
  const extras = {
    generated: [{bytes: png(64, 64), extension: '.png'}], renders: [jpeg(100, 100), png(200, 100)],
    importImage: async (name, bytes, options) => { const id = String(imported.length + 1).padStart(12, 'c'); assets.set(id, {id, type: 'reference', name: name.replace(/\.[a-z]+$/, '')}); imported.push({id, name, bytes, ...options}); return {id}; },
    showImage: async picture => { shown.push(picture); },
    board: {add: async items => { boards.push(items); return items.map((item, i) => ({id: 'item-' + (i + 1), x: 0, y: 0, w: 280, ...item})); }},
    web: {download: async url => { if (/bad/.test(url)) throw Error('The site answered 404 for example.com.'); return {bytes: png(800, 600), extension: '.png', width: 800, height: 600, url}; }, search: async () => [{title: 'One', url: 'https://example.com/1.png', thumbnail: 'https://example.com/t1.png', width: 800, height: 600, source: 'flickr'}, {title: 'Two', url: 'https://example.com/2.png', thumbnail: 'https://example.com/bad.png', source: 'wikimedia'}]}
  };
  const run = (tool, args) => executeEditTool(library, tool, args, null, () => {}, extras);
  return {run, imported, shown, boards, extras};
}

test('the agent has the picture tools', () => {
  for (const name of ['image_search', 'image_save', 'image_generate', 'chat_show_image', 'board_add']) assert.ok(editTools.some(t => t.name === name), name);
});

test('board_add saves web and generated pictures as references and reuses library ones', async () => {
  const {run, imported, boards} = harness();
  const result = await run('board_add', {items: JSON.stringify([{kind: 'image', source: 'https://example.com/tram.png', name: 'Tram at dusk'}, {kind: 'image', source: 'generated', name: 'Concept'}, {kind: 'image', source: 'aaaaaaaaaaaa'}, {kind: 'note', text: 'Warm light'}, {kind: 'swatch', color: '#aa3300', name: 'Brick'}])});
  assert.equal(imported.length, 2);
  assert.equal(imported[0].name, 'Tram at dusk.png'); assert.equal(imported[0].sourceUrl, 'https://example.com/tram.png'); assert.equal(imported[1].sourceUrl, undefined);
  assert.deepEqual(boards[0].map(i => i.kind === 'image' ? i.assetId : i.kind), [imported[0].id, imported[1].id, 'aaaaaaaaaaaa', 'note', 'swatch']);
  assert.equal(result.added.length, 5); assert.equal(result.added[2].name, 'Street');
  await assert.rejects(run('board_add', {items: JSON.stringify([{kind: 'image', source: 'bbbbbbbbbbbb'}])}), /texture or reference/);
  await assert.rejects(run('board_add', {items: 'not json'}), /JSON array/);
  await assert.rejects(run('board_add', {items: JSON.stringify([{kind: 'image', source: 'https://example.com/bad.png'}])}), /404/);
});

test('chat_show_image shows renders directly and keeps other pictures in the library', async () => {
  const {run, shown, imported} = harness();
  await run('chat_show_image', {source: 'render', caption: 'After'});
  await run('chat_show_image', {source: 'render:2', caption: ''});
  await run('chat_show_image', {source: 'aaaaaaaaaaaa', caption: ''});
  await run('chat_show_image', {source: 'https://example.com/found.png', caption: 'Found online'});
  assert.equal(shown[0].extension, '.png'); assert.equal(shown[0].label, 'After');
  assert.equal(shown[1].extension, '.jpg'); assert.equal(shown[1].label, 'Render');
  assert.deepEqual(shown[2], {assetId: 'aaaaaaaaaaaa', label: 'Street'});
  assert.equal(shown[3].assetId, imported[0].id);
  await assert.rejects(run('chat_show_image', {source: 'render:9', caption: ''}), /only 2 renders/);
  await assert.rejects(run('chat_show_image', {source: 'whatever', caption: ''}), /source must be/);
});

test('image_search returns numbered results with the previews that loaded', async () => {
  const {run} = harness();
  const result = await run('image_search', {query: 'tram', count: ''});
  assert.equal(result.results.length, 2); assert.equal(result.images.length, 1);
  assert.equal(result.results[0].preview, 'image 1'); assert.equal(result.results[1].preview, 'not available');
});

test('web access settings are validated and default to off', async () => {
  const {cleanSettings, SETTING_DEFAULTS} = await import('../server/settings.mjs');
  assert.equal(SETTING_DEFAULTS.webAccess, 'off'); assert.equal(SETTING_DEFAULTS.browserWindow, 'visible');
  const next = cleanSettings({webAccess: 'browser', browserWindow: 'background'});
  assert.equal(next.webAccess, 'browser'); assert.equal(next.browserWindow, 'background');
  assert.throws(() => cleanSettings({webAccess: 'everything'}), /Web access/);
  assert.throws(() => cleanSettings({browserWindow: 'tiny'}), /browser window/);
});

test('browser tools need browsing switched on and pass the conversation through', async () => {
  const calls = [];
  const library = {catalog: new Map(), require() { throw Error('Asset not found.'); }};
  const browser = {open: async (key, address) => { calls.push(['open', key, address]); return {url: address, image: png(10, 10)}; }, scroll: async (key, screens) => { calls.push(['scroll', key, screens]); return {}; }, picture: async (key, n) => { calls.push(['picture', key, n]); return {bytes: png(300, 200), extension: '.png', sourceUrl: 'https://example.com/a.png'}; }};
  const imported = [];
  const extras = mode => ({browser, conversationId: 'conv-1', settings: () => ({webAccess: mode}), importImage: async (name, bytes, options) => { imported.push({name, ...options}); library.catalog.set('cccccccccccc', {id: 'cccccccccccc', type: 'reference', name}); library.require = id => library.catalog.get(id); return {id: 'cccccccccccc'}; }, board: {add: async items => items.map((item, i) => ({id: 'item-' + i, ...item}))}});
  await assert.rejects(executeEditTool(library, 'browser_open', {address: 'https://example.com'}, null, () => {}, extras('search')), /switched off/);
  const opened = await executeEditTool(library, 'browser_open', {address: 'https://example.com'}, null, () => {}, extras('browser'));
  assert.equal(opened.url, 'https://example.com');
  await executeEditTool(library, 'browser_scroll', {screens: '2'}, null, () => {}, extras('browser'));
  assert.deepEqual(calls, [['open', 'conv-1', 'https://example.com'], ['scroll', 'conv-1', '2']]);
  const added = await executeEditTool(library, 'board_add', {items: JSON.stringify([{kind: 'image', source: 'page:3', name: 'Found'}])}, null, () => {}, extras('browser'));
  assert.deepEqual(calls[2], ['picture', 'conv-1', 3]);
  assert.equal(imported[0].sourceUrl, 'https://example.com/a.png'); assert.equal(added.added[0].assetId, 'cccccccccccc');
});

test('the browser opens pages, lists pictures and refuses local addresses', async () => {
  const {AgentBrowser} = await import('../server/browser.mjs');
  const os = await import('node:os'), path = await import('node:path'), fsp = await import('node:fs/promises');
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'meshdesk-browser-'));
  const browser = new AgentBrowser({profile, mode: () => 'background'});
  try {
    await assert.rejects(browser.open('t', 'http://127.0.0.1:8790/'), /local network/);
    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const view = await browser.run('t', async tab => { await tab.page.setContent('<title>Refs</title><img alt="Big" src="' + pixel + '" style="width:400px;height:300px"><img alt="tiny" src="' + pixel + '#2" style="width:20px;height:20px"><button onclick="document.title=\'Clicked\'">Press me</button>'); return browser.view(tab); });
    assert.equal(view.title, 'Refs'); assert.equal(view.pictures.length, 1); assert.equal(view.pictures[0].alt, 'Big');
    assert.equal(view.image[0], 0xff, 'screenshot is a JPEG');
    assert.equal((await browser.click('t', 'Press me')).title, 'Clicked');
    const picture = await browser.picture('t', 1);
    assert.equal(picture.extension, '.png'); assert.ok(picture.bytes.length > 100);
    await assert.rejects(browser.picture('t', 5), /choose 1 to 1/);
  } finally { await browser.close(); await fsp.rm(profile, {recursive: true, force: true}).catch(() => {}); }
});
