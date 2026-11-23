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
function tableOf(file) {
  const src = readFileSync(join(ROOT, 'scripts/automation', file), 'utf8');
  const a = src.indexOf('const LX = (');
  const b = src.indexOf(')[LOCALE];', a);
  assert.ok(a >= 0 && b > a, `${file}: the LX table was not found`);
  return new Function(`return (${src.slice(a + 'const LX = ('.length, b)});`)();
}
const localeOfFile = (file) => (readFileSync(join(ROOT, 'scripts/automation', file), 'utf8').match(/^const LOCALE = "([^"]*)";/m) ?? [])[1];

for (const loc of ['zh-CN', 'en']) {
  const L = lexicon(loc);
  test(`command spot-check trigger table equals the lexicon (${loc})`, () => {
    const T = tableOf('command-spot-check-trigger.js')[loc];
    assert.equal(T.audit, L.layout.audit);
    assert.equal(T.daily, L.layout.auditDaily);
    assert.equal(T.cmdFile, L.layout.dailyFiles.commandCheck);
    assert.equal(T.reconFile, L.layout.dailyFiles.fileReconcile);
    assert.equal(T.bizDate, labelText(L.businessDateLabel, loc));
  });
  test(`deep-review trigger table equals the lexicon (${loc})`, () => {
    const T = tableOf('deep-review-trigger.js')[loc];
    assert.equal(T.audit, L.layout.audit);
    assert.equal(T.flags, L.layout.auditFlags);
    assert.equal(T.deep, L.layout.auditDeep);
  });
}

test('both tables have the same keys in zh-CN and en, and the shipped LOCALE is "en" or "zh-CN"', () => {
  for (const f of ['command-spot-check-trigger.js', 'deep-review-trigger.js']) {
    const t = tableOf(f);
    assert.deepEqual(Object.keys(t['zh-CN']).sort(), Object.keys(t.en).sort(), f);
    assert.ok(['en', 'zh-CN'].includes(localeOfFile(f)), f);
  }
});
