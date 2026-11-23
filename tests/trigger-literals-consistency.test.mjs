// The two sandbox trigger scripts cannot import lexicon.mjs, so each carries a small table of the words it needs.
// This test reads those tables out of the script text and compares them with lexicon.mjs for both locales.
// 两个沙箱触发脚本不能 import 词表，各自带一张小表；这条测试把小表读出来，和 lexicon.mjs 逐项比。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lexicon, labelText } from '../plugins/personal-inbox/lexicon.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function tableOf(file, dir = 'scripts/automation') {
  const src = readFileSync(join(ROOT, dir, file), 'utf8');
  const a = src.indexOf('const LX = (');
  const b = src.indexOf(')[LOCALE];', a);
  assert.ok(a >= 0 && b > a, `${file}: the LX table was not found`);
  return new Function(`return (${src.slice(a + 'const LX = ('.length, b)});`)();
}
const localeOfFile = (file, dir = 'scripts/automation') => (readFileSync(join(ROOT, dir, file), 'utf8').match(/^const LOCALE = "([^"]*)";/m) ?? [])[1];

for (const loc of ['zh-CN', 'en']) {
  const L = lexicon(loc);
  test(`command spot-check trigger table equals the lexicon (${loc})`, () => {
    const T = tableOf('command-spot-check-trigger.js')[loc];
    assert.equal(T.audit, L.layout.audit);
    assert.equal(T.daily, L.layout.auditDaily);
    assert.equal(T.cmdFile, L.layout.dailyFiles.commandCheck);
    assert.equal(T.reconFile, L.layout.dailyFiles.fileReconcile);
    assert.equal(T.bizDate, labelText(L.businessDateLabel, loc));
    assert.equal(T.execKey, L.auditRecordKeys.execution);
    assert.equal(T.doneVal, L.auditRecordValues.done);
    assert.equal(T.cutoffKey, L.auditRecordKeys.cutoff);
  });
  test(`deep-review trigger table equals the lexicon (${loc})`, () => {
    const T = tableOf('deep-review-trigger.js')[loc];
    assert.equal(T.audit, L.layout.audit);
    assert.equal(T.flags, L.layout.auditFlags);
    assert.equal(T.deep, L.layout.auditDeep);
    assert.equal(T.kStatus, L.flagKeys.status);
    assert.equal(T.kFound, L.flagKeys.foundAt);
    assert.equal(T.sToReview, L.flagStates.toReview);
    assert.equal(T.sReviewing, L.flagStates.reviewing);
    assert.equal(T.sReviewed, L.flagStates.reviewed);
    assert.equal(T.kExec, L.auditRecordKeys.execution);
    assert.equal(T.vDone, L.auditRecordValues.done);
    const D = L.deepTrigger;
    assert.deepEqual([T.bizEq, T.cutEq, T.toReviewEq, T.toContinueEq, T.none, T.finishOnly, T.continueReview, T.cannotTell], [D.businessDate, D.cutoff, D.toReview, D.toContinue, D.none, D.finishOnly, D.continueReview, D.cannotTell]);
  });
}

test('both tables have the same keys in zh-CN and en, and the shipped LOCALE is "en" or "zh-CN"', () => {
  for (const [f, dir] of [['command-spot-check-trigger.js'], ['deep-review-trigger.js'], ['followups-trigger.js', 'scripts']]) {
    const t = tableOf(f, dir);
    assert.deepEqual(Object.keys(t['zh-CN']).sort(), Object.keys(t.en).sort(), f);
    assert.ok(['en', 'zh-CN'].includes(localeOfFile(f, dir)), f);
  }
});

test('follow-ups trigger: the zh-CN sentence is the old one, the en sentence has no Chinese', () => {
  const t = tableOf('followups-trigger.js', 'scripts');
  assert.equal(t['zh-CN'].due(2, '2026-11-22', 'UTC', ['F-1', 'F-2']), 'FOLLOWUPS.md 到期候选 2 项（2026-11-22 UTC）：F-1、F-2。请回读清单并判断提醒价值。');
  assert.equal(t.en.due(2, '2026-11-22', 'UTC', ['F-1', 'F-2']), 'FOLLOWUPS.md due candidates: 2 (2026-11-22 UTC): F-1, F-2. Please re-read the list and judge whether a reminder is worthwhile.');
});
