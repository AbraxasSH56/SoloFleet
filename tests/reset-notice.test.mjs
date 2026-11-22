// Offline tests for reset notice: temporary directories and fake data only; nothing touches a real deployment.
// reset-notice.mjs 离线测试（假的发送函数，全在临时目录）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_TRIES, TEXT_POST, TEXT_PRE, dueKind, main, paths, runOnce } from '../scripts/automation/reset-notice.mjs';
import { WORKSHOP_CHANNEL } from '../scripts/automation/gap-common.mjs';

const at = (iso) => Date.parse(iso); // 带 +05:30 的测试时区（UTC+5:30）时间
const tmp = () => mkdtempSync(join(tmpdir(), 'rn-'));
const okSend = () => { const calls = []; const f = async (text, ch) => { calls.push({ text, ch }); return { ok: true, id: `1573000000000000${String(calls.length).padStart(3, '0')}` }; }; f.calls = calls; return f; };

test('窗口：17:29 不发；17:30～17:59 发重置前；18:00～21:29 发重置后；21:30 起不发；17:00 不发', () => {
  const k = (t) => dueKind({ nowMs: at(`2026-11-23T${t}:00+05:30`), day: undefined });
  assert.equal(k('17:00'), null); assert.equal(k('17:29'), null);
  assert.equal(k('17:30'), 'pre'); assert.equal(k('17:59'), 'pre');
  assert.equal(k('18:00'), 'post'); assert.equal(k('21:29'), 'post');
  assert.equal(k('21:30'), null); assert.equal(k('08:00'), null);
});

test('周末也发（2026-11-22 是周日）', async () => {
  const dr = tmp(); const send = okSend();
  const r = await runOnce({ nowMs: at('2026-11-22T17:45:00+05:30'), dataRoot: dr, send });
  assert.equal(r.kind, 'pre'); assert.equal(r.ok, true); assert.equal(send.calls[0].text, TEXT_PRE); assert.equal(send.calls[0].ch, WORKSHOP_CHANNEL);
});

test('每个窗口只发一次：同一天重复跑不再发；第二天又发', async () => {
  const dr = tmp(); const send = okSend();
  await runOnce({ nowMs: at('2026-11-22T17:45:00+05:30'), dataRoot: dr, send });
  const r2 = await runOnce({ nowMs: at('2026-11-22T17:50:00+05:30'), dataRoot: dr, send });
  assert.equal(r2.kind, null); assert.equal(send.calls.length, 1);
  await runOnce({ nowMs: at('2026-11-22T18:00:00+05:30'), dataRoot: dr, send });
  assert.equal(send.calls[1].text, TEXT_POST);
  assert.equal((await runOnce({ nowMs: at('2026-11-22T18:15:00+05:30'), dataRoot: dr, send })).kind, null);
  const r3 = await runOnce({ nowMs: at('2026-11-23T17:45:00+05:30'), dataRoot: dr, send });
  assert.equal(r3.kind, 'pre'); assert.equal(send.calls.length, 3);
});

test('错过窗口：Mac 合盖到 18:20 才醒 → 只发重置后那条，重置前那条作废', async () => {
  const dr = tmp(); const send = okSend();
  const r = await runOnce({ nowMs: at('2026-11-22T18:20:00+05:30'), dataRoot: dr, send });
  assert.equal(r.kind, 'post'); assert.equal(send.calls.length, 1);
  assert.equal((await runOnce({ nowMs: at('2026-11-22T18:30:00+05:30'), dataRoot: dr, send })).kind, null);
});

test('发送失败（没拿到回执）不记已发，下一轮重发；同一条最多试 3 次', async () => {
  const dr = tmp(); let n = 0;
  const bad = async () => { n += 1; return { ok: false, error: '假失败' }; };
  for (const t of ['17:30', '17:31', '17:32', '17:33', '17:34']) await runOnce({ nowMs: at(`2026-11-22T${t}:00+05:30`), dataRoot: dr, send: bad });
  assert.equal(n, MAX_TRIES);
  const st = JSON.parse(readFileSync(paths(dr).state, 'utf8'));
  assert.equal(st.天['2026-11-22'].pre.状态, undefined); assert.equal(st.天['2026-11-22'].pre.错误, '假失败');
  // 失败一次后成功：记已发
  const dr2 = tmp(); let m = 0;
  const flaky = async () => { m += 1; return m === 1 ? { ok: false, error: 'x' } : { ok: true, id: '100000000000000127' }; };
  await runOnce({ nowMs: at('2026-11-22T17:30:00+05:30'), dataRoot: dr2, send: flaky });
  await runOnce({ nowMs: at('2026-11-22T17:45:00+05:30'), dataRoot: dr2, send: flaky });
  assert.equal(JSON.parse(readFileSync(paths(dr2).state, 'utf8')).天['2026-11-22'].pre.状态, '已发');
  assert.equal(m, 2);
});

test('状态文件权限 644、目录 755；只留最近 14 天', async () => {
  const dr = tmp(); const send = okSend();
  for (let d = 1; d <= 20; d += 1) await runOnce({ nowMs: at(`2026-11-${String(d).padStart(2, '0')}T17:45:00+05:30`), dataRoot: dr, send });
  const P = paths(dr);
  assert.equal((statSync(P.state).mode & 0o777).toString(8), '644');
  assert.equal((statSync(P.dir).mode & 0o777).toString(8), '755');
  assert.equal(Object.keys(JSON.parse(readFileSync(P.state, 'utf8')).天).length, 14);
});

test('干跑：说会发什么但不发不记；--now 不能单独用；测试发送不许发到工坊；--target 用另一个状态文件', async () => {
  const dr = tmp(); const send = okSend();
  const r = await runOnce({ nowMs: at('2026-11-22T17:45:00+05:30'), dataRoot: dr, send, dryRun: true });
  assert.equal(r.kind, 'pre'); assert.equal(send.calls.length, 0);
  assert.throws(() => readFileSync(paths(dr).state));
  const quiet = async (fn) => { const e = console.error; const l = console.log; console.error = () => {}; console.log = () => {}; try { return await fn(); } finally { console.error = e; console.log = l; } };
  assert.equal(await quiet(() => main(['--now', '2026-11-22T17:45:00+05:30', '--data-root', dr], { send })), 2);
  assert.equal(await quiet(() => main(['--target', WORKSHOP_CHANNEL, '--data-root', dr], { send })), 2);
  assert.equal(await quiet(() => main(['--target', '100000000000000171', '--now', '2026-11-22T17:45:00+05:30', '--data-root', dr], { send })), 0);
  assert.equal(send.calls[0].ch, '100000000000000171');
  assert.throws(() => readFileSync(paths(dr).state), '正式状态文件没被测试发送动过');
  assert.ok(readFileSync(paths(dr, true).state, 'utf8').includes('已发'));
});

test('并发：别的实例在跑（锁在）→ 这一轮不发', async () => {
  const dr = tmp(); const send = okSend();
  const { withLock } = await import('../scripts/automation/gap-common.mjs');
  const P = paths(dr);
  await withLock(P.lock, async () => {
    const r = await runOnce({ nowMs: at('2026-11-22T17:45:00+05:30'), dataRoot: dr, send });
    assert.equal(r.busy, true);
  });
  assert.equal(send.calls.length, 0);
});

test('重置前提醒有两次机会：17:30 那轮失败了，17:45 那轮还能发；两轮都成功只发一次', async () => {
  const dr = tmp(); let n = 0;
  const flaky = async () => { n += 1; return n === 1 ? { ok: false, error: '假失败' } : { ok: true, id: '100000000000000172' }; };
  await runOnce({ nowMs: at('2026-11-22T17:30:00+05:30'), dataRoot: dr, send: flaky });
  const r2 = await runOnce({ nowMs: at('2026-11-22T17:45:00+05:30'), dataRoot: dr, send: flaky });
  assert.equal(r2.kind, 'pre'); assert.equal(r2.ok, true);
  assert.equal((await runOnce({ nowMs: at('2026-11-22T17:50:00+05:30'), dataRoot: dr, send: flaky })).kind, null);
});

test('命令行参数缺值：报错退出码 2，不静默退回发工坊（--target、--now、--data-root 各漏一次）', async () => {
  const dr = tmp(); const send = okSend();
  const quiet = async (fn) => { const e = console.error; const l = console.log; console.error = () => {}; console.log = () => {}; try { return await fn(); } finally { console.error = e; console.log = l; } };
  for (const argv of [['--target'], ['--target', '--dry-run'], ['--dry-run', '--now'], ['--data-root'], ['--target', ' ']]) {
    assert.equal(await quiet(() => main(argv, { send })), 2, argv.join(' '));
  }
  assert.equal(send.calls.length, 0, '一次都没发');
});
