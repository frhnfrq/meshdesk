import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectSettings,cleanStyle,activeRules,applyStyleChanges,styleBrief,styleIsSet} from '../server/settings.mjs';
import {validateMessage} from '../server/validation.mjs';

test('rules, palette roles and the moodboard canvas are validated', () => {
  const style = cleanStyle({
    palette: [{name: 'Brick', color: '#CB4A07', role: 'accent'}, {color: '#12294a', role: 'nonsense'}],
    rules: [{text: ' No photo textures '}, {id: 'metal', text: 'Metal only on rails', on: false}],
    board: {items: [{kind: 'image', assetId: 'aaaaaaaaaaaa', x: 10.26, y: -4, w: 9999}, {kind: 'note', text: 'Chunky'}, {kind: 'swatch', color: '#FDC55B', name: 'Ochre'}, {kind: 'image', assetId: 'aaaaaaaaaaaa'}]},
  });
  assert.deepEqual(style.palette.map(c => c.role), ['accent', 'primary']);
  assert.deepEqual(style.rules, [{id: 'rule-1', text: 'No photo textures', on: true}, {id: 'metal', text: 'Metal only on rails', on: false}]);
  assert.deepEqual(style.board.items[0], {id: 'item-1', x: 10.3, y: -4, w: 2400, kind: 'image', assetId: 'aaaaaaaaaaaa'});
  assert.deepEqual(style.references, ['aaaaaaaaaaaa'], 'board images become the reference images, once each');
  assert.deepEqual(activeRules(style), ['No photo textures'], 'switched-off rules do not apply');
  assert.match(styleBrief({style}), /Style rules: No photo textures$/);
  assert.equal(styleIsSet(cleanStyle({board: {items: [{kind: 'note', text: 'x'}]}})), true);
  assert.throws(() => cleanStyle({rules: [{text: ' '}]}), /cannot be empty/);
  assert.throws(() => cleanStyle({board: {items: [{kind: 'image', assetId: 'nope'}]}}), /from the library/);
  assert.throws(() => cleanStyle({board: {items: [{kind: 'video'}]}}), /Unknown moodboard item/);
});

test('a guide not yet saved from the canvas page keeps using its free-text rules', () => {
  const legacy = cleanStyle({materialRules: 'Matte paint.', notes: 'Chunky shapes.'});
  assert.equal(legacy.rules, null);
  assert.deepEqual(activeRules(legacy), ['Matte paint.', 'Chunky shapes.']);
  const changed = applyStyleChanges(legacy, {addRules: ['Glow only on signs']});
  assert.deepEqual(changed.rules.map(r => r.text), ['Matte paint.', 'Chunky shapes.', 'Glow only on signs']);
  assert.equal(changed.materialRules + changed.notes, '', 'the free text moves into the rule list');
});

test('proposed style changes apply by name, hex, id or text and fail when they no longer fit', () => {
  const style = cleanStyle({palette: [{name: 'Brick', color: '#cb4a07'}], rules: [{id: 'rough', text: 'Roughness 0.7 to 0.9'}, {text: 'No chrome'}]});
  const next = applyStyleChanges(style, {addColors: [{name: 'Concrete', color: '#8C8479', role: 'neutral'}], editRules: [{from: 'rough', to: 'Roughness 0.7 to 0.95'}], removeRules: ['no chrome'], texelDensity: 512});
  assert.deepEqual(next.palette.at(-1), {name: 'Concrete', color: '#8c8479', role: 'neutral'});
  assert.deepEqual(next.rules, [{id: 'rough', text: 'Roughness 0.7 to 0.95', on: true}]);
  assert.equal(next.texelDensity, 512);
  assert.equal(style.rules.length, 2, 'the original guide is untouched');
  assert.deepEqual(applyStyleChanges(style, {removeColors: ['#CB4A07']}).palette, []);
  assert.throws(() => applyStyleChanges(style, {addColors: [{color: '#cb4a07'}]}), /already in the palette/);
  assert.throws(() => applyStyleChanges(style, {removeRules: ['Nothing like this']}), /No rule matches/);
  assert.throws(() => applyStyleChanges(style, {}), /changes nothing/);
  assert.throws(() => applyStyleChanges(style, {addRules: 'x'}), /must be an array/);
});

test('earlier versions of the style guide are kept and can be restored', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meshdesk-style-history-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const settings = new ProjectSettings(path.join(dir, 's.json'));
  await settings.init();
  await settings.update({style: {rules: [{text: 'One'}]}});
  assert.equal(settings.versions().length, 0, 'an empty guide is not worth keeping');
  await settings.update({style: {rules: [{text: 'Two'}]}});
  await settings.update({style: {rules: [{text: 'Three'}]}});
  assert.equal(settings.versions().length, 1, 'a run of your own edits is one version');
  await settings.update({style: {rules: [{text: 'Four'}]}}, {by: 'Codex'});
  assert.deepEqual(settings.versions().map(v => v.by), ['You', 'You'], 'the version an agent replaces is always kept');
  await settings.update({context: 'Runner'});
  assert.equal(settings.versions().length, 2, 'other settings do not add versions');
  const again = new ProjectSettings(path.join(dir, 's.json'));
  await again.init();
  assert.equal(again.versions().length, 2, 'versions survive a restart');
  const restored = await again.restore(again.versions().at(-1).at);
  assert.deepEqual(activeRules(restored.style), ['One']);
  assert.equal(again.versions()[0].by, 'Codex', 'the replaced version records who made it');
  await assert.rejects(() => again.restore('never'), /no longer kept/);
});

test('messages carry references into the style guide', () => {
  const base = {text: 'why?', requestId: 'abcdefgh-1234-5678'};
  assert.deepEqual(validateMessage(base).styleRefs, []);
  assert.deepEqual(validateMessage({...base, styleRefs: [{kind: 'guide'}, {kind: 'color', id: '#cb4a07'}, {kind: 'rule', id: 'rule-2'}, {kind: 'rule', id: 'rule-2'}]}).styleRefs, [{kind: 'guide', id: ''}, {kind: 'color', id: '#cb4a07'}, {kind: 'rule', id: 'rule-2'}]);
  assert.throws(() => validateMessage({...base, styleRefs: [{kind: 'rule'}]}), /Invalid style guide reference/);
  assert.throws(() => validateMessage({...base, styleRefs: [{kind: 'file', id: 'x'}]}), /Invalid style guide reference/);
  assert.throws(() => validateMessage({...base, styleRefs: Array(13).fill({kind: 'guide'})}), /up to 12/);
});
