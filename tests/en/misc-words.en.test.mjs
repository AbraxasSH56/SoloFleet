// English (locale en) tests of the small word users: quota-resume wake text, ledger backlog view and commit message,
// ledger section check, "Controller" display name (roster and lead-free), and the "dataroot/" alias of the changed-files list.
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/misc-words.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { locale } from '../../plugins/personal-inbox/lexicon.mjs';
import { MARK, WAKE_TEXT } from '../../scripts/automation/quota-resume.mjs';
import { renderView, commitMessage, LEDGER_FILE, paths } from '../../scripts/automation/ledger-watch.mjs';
import { verifyLedger } from '../../scripts/automation/ledger-verify.mjs';
import { accountByDisplayName, stripParen } from '../../scripts/automation/lead-free.mjs';
import { buildRoster } from '../../scripts/automation/bot-roster.mjs';
import { listLiteral } from '../../plugins/personal-inbox/execution-record.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const HAN = /[㐀-鿿＀-￯　-〿]/;

test('quota resume: the program-sent mark and the English wake text', () => {
  assert.equal(MARK, '[Quota restored · sent by program]');
  assert.ok(WAKE_TEXT.startsWith(`${MARK} You were interrupted last turn because the quota ran out.`));
  assert.ok(WAKE_TEXT.includes('"continue"') && WAKE_TEXT.includes('just say "done"'));
  assert.ok(!HAN.test(WAKE_TEXT));
});

test('ledger backlog view and the ledger commit message are English; the file is decision-ledger.md', () => {
  assert.equal(LEDGER_FILE, 'decision-ledger.md');
  assert.ok(paths('/data').ledger.endsWith('/data/decision-ledger.md'));
  const data = { 条目: [{ 编号: 3, 状态: '待补', 标题: 'No more A', 日期: '2026-11-22', 原话: 'drop A', 行号: 'L12', 添加时间: '2026-11-22T10:00:00+05:30', 测试: true }, { 编号: 2, 状态: '已入账', 标题: 'Old', 账本编号: 'D-052', 完成时间: 'x' }] };
  const view = renderView(data, Date.parse('2026-11-22T10:00:00Z'));
  assert.ok(view.startsWith('# Ledger backlog\n'));
  assert.ok(view.includes('## Pending (write each into `dataroot/decision-ledger.md`'));
  assert.ok(view.includes('### Pending 3 [test]: No more A'));
  assert.ok(view.includes("- Owner's words: drop A") && view.includes('- Date: 2026-11-22') && view.includes('- Record position: L12'));
  assert.ok(view.includes('## Booked (last 20)'));
  assert.ok(!HAN.test(view.replace(/\n/g, ' ')), view);
  const deps = { now: () => Date.parse('2026-11-22T10:00:00Z') };
  assert.equal(commitMessage(deps, [3, 4]), 'Decision ledger: automatic commit (written up by the Controller, 2026-11-22, backlog IDs 3, 4)');
  assert.equal(commitMessage(deps, null), 'Decision ledger: automatic commit (2026-11-22, scheduled fallback)');
});

test('ledger section check reads the English section title', () => {
  const block = '### D-035 x\nDate: 11-01\nQuote: "q"\n';
  const listText = `\n<<<BEGIN>>>\n${block}\n<<<END>>>\n`;
  const ok = verifyLedger({ listText, ledgerText: `## 1. Active decisions\n\n${block}\n## 2. Superseded decisions\n`, recordText: '', baselineText: '', firstNo: 35 });
  assert.ok(!ok.some((p) => p.includes('后面去了')), JSON.stringify(ok));
  const bad = verifyLedger({ listText, ledgerText: `## 2. Superseded decisions\n\n${block}\n`, recordText: '', baselineText: '', firstNo: 35 });
  assert.ok(bad.some((p) => p.includes('2. Superseded decisions')), JSON.stringify(bad));
});

test('the main role is called "Controller": lead-free reads it, the roster writes it', () => {
  const slice = { accounts: { 'worker-a': { name: 'Worker A', enabled: true } } };
  assert.equal(accountByDisplayName(slice, 'Controller'), 'default');
  assert.equal(accountByDisplayName(slice, 'Controller (acting; decide when the project channel is built)'), 'default');
  assert.equal(accountByDisplayName(slice, 'Worker A'), 'worker-a');
  assert.equal(accountByDisplayName(slice, '总控'), null, 'the Chinese name is not read in en');
  assert.equal(stripParen('Controller (acting)'), 'Controller');
  const cfg = { channels: { discord: { defaultAccount: 'default', applicationId: '100000000000000011', accounts: { default: {} } } }, bindings: [{ agentId: 'main', match: { channel: 'discord', accountId: 'default' } }], agents: { entries: { main: {} } } };
  const r = buildRoster(cfg);
  assert.equal(r.人设bot.find((b) => b.角色 === 'main').显示名, 'Controller');
});

test('the data-root alias in the changed-files list is "dataroot/" in en', () => {
  assert.equal(listLiteral('dataroot/projects/DemoProject/draft.txt', '/ws', '/zl'), '/zl/projects/DemoProject/draft.txt');
  assert.equal(listLiteral('dataroot', '/ws', '/zl'), resolve('/zl'));
  assert.equal(listLiteral('dataroot/', '/ws', '/zl'), resolve('/zl'));
  assert.equal(listLiteral('dataroot/a/../b.md', '/ws', '/zl'), '/zl/b.md');
  assert.equal(listLiteral('dataroot/x', '/ws', null), null);
  assert.equal(listLiteral('资料/项目/a.md', '/ws', '/zl'), '/ws/资料/项目/a.md', 'the Chinese alias is an ordinary workspace path in en');
  assert.equal(listLiteral('dataroots/x', '/ws', '/zl'), '/ws/dataroots/x');
  assert.equal(listLiteral('/abs//x.md', '/ws', '/zl'), '/abs/x.md');
});
