import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {ConversationStore} from '../server/store.mjs';
import {Conversations} from '../server/conversations.mjs';
import {cleanStyle} from '../server/settings.mjs';

class FakeBridge extends EventEmitter {
  generation = 1; calls = [];
  async connect() {}
  async request(method, params) {
    this.calls.push({method, params});
    if (method === 'thread/start') return {thread: {id: 'thread-1'}};
    if (method === 'turn/start') return {turn: {id: 'turn-1'}};
    return {};
  }
}
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await delay(10); } throw Error('Timed out'); }
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meshdesk-style-chat-'));
  const store = new ConversationStore(root); await store.init();
  const image = {id: 'aaaaaaaaaaaa', type: 'reference', name: 'Street render', path: 'Images/street.png'};
  const settings = {style: cleanStyle({
    palette: [{name: 'Brick', color: '#cb4a07'}],
    rules: [{id: 'rough', text: 'Roughness 0.7 to 0.9'}],
    board: {items: [{id: 'pic', kind: 'image', assetId: image.id}, {id: 'memo', kind: 'note', text: 'Chunky shapes'}]},
  })};
  const bridge = new FakeBridge();
  const library = {root: path.join(root, 'library'), file: asset => '/library/' + asset.path};
  const conversations = new Conversations({bridge, store, library, catalog: new Map([[image.id, image]]), assetRoot: '/tmp/library', broadcast() {}, settings: () => settings});
  conversations.applyStyle = async (style, by) => { settings.style = style; settings.appliedBy = by; };
  t.after(async () => { await conversations.shutdown(); await fs.rm(root, {recursive: true, force: true}); });
  return {store, bridge, conversations, settings};
}

test('a message that points at parts of the style guide tells the agent what they say', async t => {
  const x = await setup(t);
  const made = await x.conversations.submit('new', {text: 'Is this too strict?', requestId: 'style-request-123456', styleRefs: [{kind: 'rule', id: 'rough'}, {kind: 'color', id: '#cb4a07'}, {kind: 'item', id: 'pic'}, {kind: 'item', id: 'memo'}]});
  const session = x.store.get(made.id);
  assert.deepEqual(session.messages[0].styleRefs.map(r => r.label), ['Roughness 0.7 to 0.9', 'Brick', 'Street render', 'Note']);
  await until(() => x.bridge.calls.some(c => c.method === 'turn/start'));
  const input = x.bridge.calls.find(c => c.method === 'turn/start').params.input;
  assert.match(input[0].text, /STYLE REFERENCES[\s\S]*"text": "Roughness 0.7 to 0.9"[\s\S]*"color": "#cb4a07"[\s\S]*"text": "Chunky shapes"/);
  assert.ok(input.some(part => part.type === 'localImage' && part.path === '/library/Images/street.png'), 'a referenced board image is attached');
  await assert.rejects(() => x.conversations.submit('new', {text: 'And this?', requestId: 'style-request-654321', styleRefs: [{kind: 'rule', id: 'gone'}]}), /no longer exists/);
});

test('an agent proposes a style change and nothing changes until it is applied', async t => {
  const x = await setup(t);
  const made = await x.conversations.submit('new', {text: 'Loosen the roughness rule.', requestId: 'style-request-777777'});
  const session = x.store.get(made.id);
  await until(() => session.turnId);
  const call = changes => x.conversations.toolCall({threadId: session.threadId, turnId: session.turnId, tool: 'style_propose', arguments: {summary: 'Allow slightly rougher surfaces.', changes: JSON.stringify(changes)}});
  assert.equal((await call({editRules: [{from: 'no such rule', to: 'x'}]})).success, false, 'a change that does not fit is refused');
  const result = await call({editRules: [{from: 'rough', to: 'Roughness 0.7 to 0.95'}], addColors: [{name: 'Concrete', color: '#8c8479', role: 'neutral'}]});
  assert.equal(result.success, true);
  assert.match(result.contentItems[0].text, /PROPOSED/);
  const proposal = session.messages[1].proposals[0];
  assert.equal(proposal.status, 'pending');
  assert.equal(x.settings.style.rules[0].text, 'Roughness 0.7 to 0.9', 'the guide is unchanged while the proposal waits');
  await assert.rejects(() => x.conversations.decide(session.id, 'missing', 'apply'), /no longer in this conversation/);
  await x.conversations.decide(session.id, proposal.id, 'apply');
  assert.equal(x.settings.style.rules[0].text, 'Roughness 0.7 to 0.95');
  assert.equal(x.settings.style.palette.at(-1).name, 'Concrete');
  assert.equal(x.settings.appliedBy, 'Codex');
  assert.equal(proposal.status, 'applied');
  await assert.rejects(() => x.conversations.decide(session.id, proposal.id, 'discard'), /already applied/);
});
