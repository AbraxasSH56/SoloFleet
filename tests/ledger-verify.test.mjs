// Offline tests for ledger verify: temporary directories and fake data only; nothing touches a real deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyLedger, extractBlock } from '../scripts/automation/ledger-verify.mjs';

const BASE = '# 决定账本\n\n### D-020 旧条\n- 取代关系：取代 S-1。\n\n### D-034 旧条二\n- 原话：转述。\n\n---\n\n## 二、已被取代的决定\n\n### S-4 旧条三\n- 日期：10-30 ｜ 被 D-027 取代 ｜ 原话：转述。\n';
const BLOCK = '### D-035 新条一\n- 原话：「这是一句原话 带空格」（转录）\n- 取代关系：无。\n\n### D-036 新条二\n- 原话：「第二句话」（转录）\n- 取代关系：无。';
const FIX1 = '（11-22 订正：甲。）'; const FIX2 = '（11-22 订正：乙。）'; const FIX3 = '（11-22 订正：丙。）';
const LIST = `说明\n\n<<<BEGIN>>>\n${BLOCK}\n<<<END>>>\n\n1. 说明\n\`${FIX1}\`\n2. 说明\n\`${FIX2}\`\n3. 说明\n\`${FIX3}\`\n`;
const RECORD = '……这是一句原话 带空格……第二句话……';
function good() {
  return `# 决定账本\n\n### D-020 旧条\n- 取代关系：取代 S-1。${FIX1}\n\n### D-034 旧条二\n- 原话：转述。${FIX2}\n\n${BLOCK}\n\n---\n\n## 二、已被取代的决定\n\n### S-4 旧条三\n- 日期：10-30 ｜ 被 D-027 取代 ｜ 原话：转述。${FIX3}\n`;
}
const run = (over = {}) => verifyLedger({ listText: LIST, ledgerText: good(), recordText: RECORD, baselineText: BASE, firstNo: 35, ...over });

test('抄对了：通过', () => { assert.deepEqual(run(), []); assert.ok(extractBlock(LIST).startsWith('### D-035')); });

test('故意改错一个字：必须报错', () => {
  const bad = good().replace('这是一句原话 带空格', '这是一句原话 带空个');
  const p = run({ ledgerText: bad });
  assert.ok(p.some((x) => /新增段/.test(x)), p.join('；'));
});

test('清单里的原话和原始记录对不上（清单本身写错）：报错', () => {
  const p = run({ recordText: '……这是一句原话 带空个……第二句话……' });
  assert.ok(p.some((x) => /逐字不符/.test(x)));
});

test('编号跳号、重复、漏抄一条：报错', () => {
  const gapList = LIST.replace('D-036', 'D-037');
  const p = run({ listText: gapList, ledgerText: good().replace('D-036', 'D-037') });
  assert.ok(p.some((x) => /编号不连续/.test(x)));
  const p2 = run({ ledgerText: good().replace(`\n\n### D-036 新条二\n- 原话：「第二句话」（转录）\n- 取代关系：无。`, '') });
  assert.ok(p2.some((x) => /新增段/.test(x)));
});

test('版本号、邮箱：报错', () => {
  for (const [bad, re] of [['Opus 5.5', /版本号/], ['opus5', /版本号/], ['a@example.com', /邮箱/]]) {
    const block = BLOCK.replace('新条二', `新条二 ${bad}`);
    const p = verifyLedger({ listText: LIST.replace(BLOCK, block), ledgerText: good().replace(BLOCK, block), recordText: RECORD, baselineText: BASE, firstNo: 35 });
    assert.ok(p.some((x) => re.test(x)), `${bad} → ${p.join('；')}`);
  }
});

test('订正句缺了、重复了：报错；旧内容被删改：报错；新增段放到“二”后面：报错', () => {
  assert.ok(run({ ledgerText: good().replace(FIX3, '') }).some((x) => /订正句/.test(x)));
  assert.ok(run({ ledgerText: good().replace(FIX1, FIX1 + FIX1) }).some((x) => /订正句/.test(x)));
  assert.ok(run({ ledgerText: good().replace('- 日期：10-30 ｜ 被 D-027', '- 日期：10-31 ｜ 被 D-027') }).some((x) => /被改动或删除/.test(x)));
  const moved = good().replace(`\n\n${BLOCK}\n\n---`, '\n\n---').replace('### S-4 旧条三', `${BLOCK}\n\n### S-4 旧条三`);
  assert.ok(run({ ledgerText: moved }).some((x) => /二、已被取代/.test(x)));
});

test('清单没有标记：报错，不崩', () => { assert.deepEqual(verifyLedger({ listText: '没有', ledgerText: '', recordText: '' }), ['清单里找不到 <<<BEGIN>>> ／ <<<END>>> 标记']); });
