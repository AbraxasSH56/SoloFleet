// The two word sets must have exactly the same keys, and the English set must hold no Chinese.
// Run with the English test config: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/lexicon-parity.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { locale, lexicon, labelText, labelRe, tagText, tagCloseRe, cardText } from '../../plugins/personal-inbox/lexicon.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');

const HAN = /[㐀-鿿＀-￯　-〿]/;
const LEAF_MAPS = new Set(['auditBodyToLabel']); // maps keyed by the words themselves: the two sets have different numbers of accepted forms
const flat = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) && !LEAF_MAPS.has(k) ? flat(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]));
const keysOf = (o) => flat(o).map(([k]) => k).sort();

test('both word sets define exactly the same keys', () => {
  assert.deepEqual(keysOf(lexicon('en')), keysOf(lexicon('zh-CN')));
});

test('arrays have the same length in both sets', () => {
  const zh = new Map(flat(lexicon('zh-CN')));
  for (const [k, v] of flat(lexicon('en'))) if (Array.isArray(v)) assert.equal(v.length, zh.get(k).length, k);
});

test('the English word set holds no Han character or full-width punctuation', () => {
  for (const [k, v] of flat(lexicon('en'))) for (const s of (LEAF_MAPS.has(k.split('.').pop()) ? [...Object.keys(v), ...Object.values(v)] : [].concat(v))) assert.ok(!HAN.test(s), `${k}: ${s}`);
});

test('inside one group the English words are all different', () => {
  const groups = ['progressOpeners', 'statusHeads', 'auditLabelValues', 'authorizationLines', 'queueSkipReasons', 'placeholderCells', 'waitingLabels', 'ledgerSections'];
  for (const g of groups) { const a = lexicon('en')[g]; assert.equal(new Set(a).size, a.length, g); }
  for (const g of ['ledgerStatus', 'ledgerKinds', 'reportVerdictWord', 'jobNames', 'auditBodyValues']) { const a = Object.values(lexicon('en')[g]); assert.equal(new Set(a).size, a.length, g); }
  const lay = flat(lexicon('en').layout).filter(([k]) => /^(projects|tasks|outputs|history|templates|trash|audit|auditDaily|auditWeekly|auditPatrol|auditDeep|auditFlags|auditAwaiting|auditChecksums|auditQuota|auditPublish|auditReceipts|runLogs|scratch|diaryProject)$/.test(k)).map(([, v]) => v);
  assert.equal(new Set(lay).size, lay.length, 'folder names under one parent are not repeated');
  const runLog = Object.values(lexicon('en').layout.runLogDirs);
  assert.equal(new Set(runLog).size, runLog.length, 'run-log folders');
});

test('card text sets keep the same keys too', () => {
  assert.deepEqual(Object.keys(cardText('en')).sort(), Object.keys(cardText('zh-CN')).sort());
});

test('labelText / labelRe: zh-CN writes the full-width colon and reads both colons; en writes "word: " and reads the half-width colon with optional spaces', () => {
  assert.equal(labelText('状态', 'zh-CN'), '状态：');
  assert.equal(labelText('Status', 'en'), 'Status: ');
  const zh = new RegExp(`^${labelRe('状态', '\\s*', 'zh-CN')}(.*)$`);
  assert.equal(zh.exec('状态：完成')[1], '完成');
  assert.equal(zh.exec('状态:完成')[1], '完成');
  assert.equal(zh.exec('状态： 完成')[1], '完成');
  const en = new RegExp(`^${labelRe('Task card', '\\s*', 'en')}(\\S+)`);
  assert.equal(en.exec('Task card: C-1')[1], 'C-1');
  assert.equal(en.exec('Task card:C-1')[1], 'C-1');
  assert.equal(en.exec('Task card：C-1'), null, 'en does not read the full-width colon');
  assert.equal(labelRe('a.b', '', 'en'), 'a\\.b:');
});

test('tagText / tagCloseRe', () => {
  assert.equal(tagText('授权范围', 'zh-CN'), '【授权范围】');
  assert.equal(tagText('Authorization scope', 'en'), '[Authorization scope]');
  assert.ok(new RegExp(`Audit level${tagCloseRe('en')}`).test('[Audit level] x'));
  assert.ok(new RegExp(`Audit level${tagCloseRe('en')}`).test('Audit level: x'));
  assert.ok(new RegExp(`审计级别${tagCloseRe('zh-CN')}`).test('【审计级别】x'));
  assert.ok(new RegExp(`审计级别${tagCloseRe('zh-CN')}`).test('审计级别:x'));
});

test('zh-CN body-value map accepts the same forms the old pattern accepted (brackets or not)', () => {
  const z = lexicon('zh-CN');
  for (const [form, label] of Object.entries({ '单审任务审计': '单审任务审计', '单审（任务审计）': '单审任务审计', '单审独立审计': '单审独立', '单审（独立审计）': '单审独立', '串联': '串联' })) assert.equal(z.auditBodyToLabel[form], label);
  assert.deepEqual(Object.values(z.auditBodyToLabel).filter((v, i, a) => a.indexOf(v) === i).sort(), [...z.auditLabelValues].sort());
  const e = lexicon('en');
  assert.deepEqual(Object.values(e.auditBodyToLabel).sort(), [...e.auditLabelValues].sort());
});
