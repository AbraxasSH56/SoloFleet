// Regression for the anomaly deep-review trigger script (zh-CN): folders, messages and the fire / no-fire decision.
// The script cannot import the config, so the test hands it the test config's locale.
// 异常深审触发脚本（zh-CN）的回归：目录、触发消息、叫不叫醒。运行：node --test tests/deep-review-trigger.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locale } from '../plugins/personal-inbox/lexicon.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const NOW = '2026-11-12T12:35:00Z';
const SRC = readFileSync(join(ROOT, 'scripts/automation/deep-review-trigger.js'), 'utf8')
  .replace(/const TIMEZONE = "[^"]*";/, 'const TIMEZONE = "Asia/Kolkata";').replace(/const LOCALE = "[^"]*";/, `const LOCALE = ${JSON.stringify(locale())};`);
async function run(exec) {
  let result; const calls = [];
  await new AsyncFunction('exec', 'json', 'FAKE_NOW', SRC)(async (a) => { calls.push(a.command); return exec(a); }, (o) => { result = o; return o; }, NOW);
  return { result, calls };
}

test('没有待审标记：不叫醒；读的是 审计/异常标记', async () => {
  const r = await run(() => ({ isError: false, aggregated: 'TOTAL=0\nNONDONE=0\n=====END\n' }));
  assert.deepEqual(r.result, { fire: false });
  assert.ok(r.calls[0].includes('/opt/solofleet-data/审计/异常标记'), r.calls[0]);
});

test('有“深审中”标记：读那一天的本轮记录（审计/异常深审），消息带业务日期、截止点、待审、待接', async () => {
  const r = await run(({ command }) => ({ isError: false, aggregated: command.includes('=====REC') ? '=====REC 2026-11-10\n{"执行":"完成"}\n=====END\n' : 'TOTAL=1\nNONDONE=1\n=====FILE a.json\n{"状态":"深审中 2026-11-10"}\n\n=====END\n' }));
  assert.equal(r.result.fire, true);
  assert.equal(r.calls.length, 2);
  assert.ok(r.calls[1].includes('/opt/solofleet-data/审计/异常深审/2026-11-10.json'), r.calls[1]);
  assert.match(r.result.message, /^业务日期=2026-11-11；截止点=2026-11-11T19:00:00\+05:30；待审=无；待接=a\.json（只补收尾（本轮已完成，不重审内容））$/);
});

test('读不全：叫醒并说读取不完整', async () => {
  const r = await run(() => ({ isError: false, aggregated: 'TOTAL=1\nNONDONE=1\n' }));
  assert.equal(r.result.fire, true);
  assert.match(r.result.message, /^条件检查读取不完整：输出被截断（没有读到结尾标记）；业务日期=2026-11-11；/);
});
