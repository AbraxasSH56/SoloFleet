// Offline tests for day watch: temporary directories and fake data only; nothing touches a real deployment.
// 白天看护离线测试。运行：node --test tests/day-watch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blindspotsDue, startBlindspots, BLINDSPOTS_SCRIPT, formatCheckDue, startFormatCheck, settleFormatCheck, FORMAT_CHECK_SCRIPT, main, collectAnomalies, writeClosingBaseline, STALE_MS, handleAnomaly, localDay, lastFinishedStatus } from '../scripts/automation/day-watch.mjs';

const T0 = Date.parse('2026-11-12T05:30:00Z');
const H = 3600000;

function mk({ cards = [], jobs = [], runs = {}, addFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dw-'));
  const st = { cards, jobs, runs, calls: [], clock: T0, addFails, lostIds: false };
  const d = {
    now: () => st.clock, watchDir: join(dir, '看护'), dataRoot: dir,
    listCards: () => st.cards, listJobs: () => st.jobs, listRuns: (id) => st.runs[id] ?? [],
    addJob: (message, name) => {
      st.calls.push({ message, name });
      if (st.addFails) throw new Error('建任务失败');
      const id = `job${st.calls.length}`;
      if (st.lostIds) { st.jobs.push({ id, payload: { message } }); return {}; } // 建成了但没返回编号
      st.jobs.push({ id, payload: { message } });
      return { id };
    },
    deskWaitingCard: () => null,
    pendingLedgerPath: join(dir, '台账.json'), closingBaselinePath: join(dir, '看护', '结案基线.json'), closingLedgerPath: join(dir, '结案', '账.json'),
  };
  return { st, d, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const stale = (over = {}) => ({ id: 'c1', title: '卡一', status: 'running', labels: [], notes: '', updatedAt: T0 - 3 * H, ...over });

test('没异常：不叫、不记账、不出声', async () => {
  const t = mk({ cards: [stale({ updatedAt: T0 - 10 * 60000 })] });
  const o = await main(t.d);
  assert.equal(t.st.calls.length, 0);
  assert.deepEqual(o.results, []);
  t.cleanup();
});

test('任务卡运行中很久没动：叫起一次；同一张卡下一次检查不再叫（先记账）', async () => {
  const t = mk({ cards: [stale()] });
  await main(t.d);
  assert.equal(t.st.calls.length, 1);
  assert.match(t.st.calls[0].message, /〔看护·/);
  t.st.clock += 30 * 60000;
  await main(t.d);
  assert.equal(t.st.calls.length, 1, '一次性任务还没结束，不再叫');
  t.cleanup();
});

test('排除：等确认、已取消、已完成、桌面角色锁是等确认的那张卡', async () => {
  const t = mk({ cards: [stale({ id: 'a', labels: ['等确认'] }), stale({ id: 'b', notes: '等主人确认' }), stale({ id: 'c', status: 'done' }), stale({ id: 'd', labels: ['已取消'] }), stale({ id: 'e' })] });
  t.d.deskWaitingCard = () => 'e';
  assert.deepEqual(collectAnomalies(t.d), []);
  t.cleanup();
});

test('建任务命令没返回编号：下一次先按指纹找原请求，找到补记、不重建', async () => {
  const t = mk({ cards: [stale()] });
  t.st.lostIds = true;
  await main(t.d);
  assert.equal(t.st.calls.length, 1);
  t.st.clock += 30 * 60000; t.st.lostIds = false;
  await main(t.d);
  assert.equal(t.st.calls.length, 1, '没重建');
  const acct = readdirSync(t.d.watchDir).filter((f) => f.endsWith('.json') && f !== '结案基线.json');
  assert.equal(JSON.parse(readFileSync(join(t.d.watchDir, acct[0]), 'utf8')).state, '已叫起');
  t.cleanup();
});

test('建任务失败且找不到原请求：过 10 分钟改“叫起待核”，不重新建', async () => {
  const t = mk({ cards: [stale()], addFails: true });
  await main(t.d);
  t.st.clock += 15 * 60000;
  await main(t.d);
  const f = readdirSync(t.d.watchDir).filter((x) => x.endsWith('.json') && x !== '结案基线.json');
  assert.equal(JSON.parse(readFileSync(join(t.d.watchDir, f[0]), 'utf8')).state, '叫起待核');
  t.st.addFails = false; t.st.clock += 30 * 60000;
  await main(t.d);
  assert.equal(t.st.calls.length, 1, '不重新建');
  t.cleanup();
});

test('同一张卡恢复后再次卡住（开始时刻不同）算新的一件', async () => {
  const t = mk({ cards: [stale()] });
  await main(t.d);
  t.st.jobs.length = 0; t.st.runs.job1 = [{ action: 'finished', status: 'ok' }];
  t.st.cards = [stale({ updatedAt: T0 + 6 * H })];
  t.st.clock = T0 + 10 * H;
  await main(t.d);
  assert.equal(t.st.calls.length, 2);
  t.cleanup();
});

test('已叫起且一次性任务已结束但异常还在：一天最多再叫一次；连续 3 天每天都还在 → 不再叫，登记台账交主人', async () => {
  const t = mk({ cards: [stale()] });
  const day = 86400000;
  await main(t.d); // 第 1 天叫
  const finish = () => { t.st.jobs.length = 0; t.st.runs.job1 = [{ action: 'finished', status: 'ok' }]; t.st.runs[`job${t.st.calls.length}`] = [{ action: 'finished', status: 'ok' }]; };
  finish();
  t.st.clock += 6 * H; await main(t.d);
  assert.equal(t.st.calls.length, 1, '同一天不再叫');
  t.st.clock = T0 + day; finish(); await main(t.d);
  assert.equal(t.st.calls.length, 2, '第 2 天再叫一次');
  finish();
  t.st.clock = T0 + 2 * day; await main(t.d);
  assert.equal(t.st.calls.length, 3, '第 3 天再叫一次');
  finish();
  t.st.clock = T0 + 3 * day; await main(t.d);
  assert.equal(t.st.calls.length, 3, '连续 3 天后不再叫');
  assert.ok(existsSync(t.d.pendingLedgerPath), '登记进台账交主人');
  assert.match(readFileSync(t.d.pendingLedgerPath, 'utf8'), /停用这项看护或人工处理/);
  t.cleanup();
});

test('到点任务：时间过了没有运行记录／运行不是 ok／运行 ok 但卡没完成 → 异常；已完成不报', () => {
  const due = new Date(T0 - 2 * H).toISOString();
  const card = (n) => ({ id: n, title: n, status: 'todo', labels: [], notes: `定时任务编号：J-${n}\n到点时间：${due}`, updatedAt: T0 });
  const t = mk({ cards: [card('x1'), card('x2'), card('x3'), { ...card('x4'), status: 'done' }], runs: { 'J-x2': [{ status: 'error', runAtMs: T0 - H }], 'J-x3': [{ status: 'ok', runAtMs: T0 - H }], 'J-x4': [{ status: 'ok' }] } });
  const types = collectAnomalies(t.d).map((a) => `${a.object}:${a.type}`).sort();
  assert.deepEqual(types, ['x1:oneshot-missed', 'x2:oneshot-failed', 'x3:oneshot-ok-not-done']);
  t.cleanup();
});

test('事后核账：启用时已完成的卡不算；启用后新完成且没有放行记录的报一次；有放行记录不报', async () => {
  const t = mk({ cards: [stale({ id: 'old', status: 'done', completedAt: T0 - 5 * H })] });
  writeClosingBaseline(t.d);
  t.st.cards = [...t.st.cards, stale({ id: 'new1', status: 'done', completedAt: T0 + H, updatedAt: T0 + H }), stale({ id: 'new2', status: 'done', completedAt: T0 + H, updatedAt: T0 + H })];
  writeFileSync(join(t.dir, '结案账占位'), '');
  // 放行记录文件
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(t.dir, '结案'), { recursive: true });
  writeFileSync(t.d.closingLedgerPath, JSON.stringify({ releases: [{ cardId: 'new2' }] }));
  t.st.clock = T0 + 2 * H;
  const an = collectAnomalies(t.d).filter((a) => a.type === 'closing-unlogged');
  assert.deepEqual(an.map((a) => a.object), ['new1']);
  t.cleanup();
});

test('看护锁在：这一遍跳过；锁太老不抢，记看护锁待核', async () => {
  const t = mk({ cards: [stale()] });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(t.d.watchDir, { recursive: true });
  writeFileSync(join(t.d.watchDir, '看护.lock'), JSON.stringify({ at: T0 - 20 * 60000 }));
  const o = await main(t.d);
  assert.equal(o.skipped, true); assert.equal(t.st.calls.length, 0);
  assert.ok(existsSync(join(t.d.watchDir, '看护锁待核.log')));
  assert.ok(existsSync(join(t.d.watchDir, '看护.lock')), '没有删别人的锁');
  t.cleanup();
});

test('常量：2 小时没动算可疑（正式不设环境变量）', () => { assert.equal(STALE_MS, 2 * H); });

// ----- 命令行冒烟（假的 openclaw 命令，资料根指向临时目录，不碰真实系统）-----
function stubBin(dir, handlers) {
  const f = join(dir, 'stub-openclaw.sh');
  writeFileSync(f, `#!/bin/bash\necho "$@" >> "${dir}/calls.log"\ncase "$1 $2" in\n${Object.entries(handlers).map(([k, v]) => `  "${k}"*) echo '${v}';;`).join('\n')}\n  *) echo '{}';;\nesac\n`, { mode: 0o755 });
  return f;
}
const SCRIPT = (n) => fileURLToPath(new URL(`../scripts/automation/${n}`, import.meta.url));
const NODE = process.execPath;

test('命令行：白天看护被直接运行时真的跑（没异常输出 NO_REPLY、只写临时资料根）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwcli-'));
  const bin = stubBin(dir, { 'workboard list': '{"cards":[]}', 'automations list': '{"jobs":[]}' });
  const r = spawnSync(NODE, [SCRIPT('day-watch.mjs')], { encoding: 'utf8', env: { ...process.env, OPENCLAW_BIN: bin, OPENCLAW_DATA_ROOT: dir } });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /NO_REPLY/);
  assert.ok(existsSync(join(dir, '运行记录', '看护', '结案基线.json')), '启用时记了结案基线');
  assert.match(readFileSync(join(dir, 'calls.log'), 'utf8'), /workboard list/);
  rmSync(dir, { recursive: true, force: true });
});

test('命令行：等你定被直接运行时真的跑（发总表、置顶、首点名；输出 NO_REPLY）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdcli-'));
  const bin = stubBin(dir, { 'message send': '{"payload":{"messageId":"100000000000000116"}}', 'message read': '{"payload":{"messages":[]}}', 'message pin': '{"payload":{}}' });
  const { withLedger, registerItem } = await import('../plugins/personal-inbox/pending-ledger.mjs');
  const ledger = join(dir, '审计', '等你定', '台账.json');
  await withLedger(ledger, (L) => ({ r: registerItem(L, { title: '冒烟事项', suggestion: 's', blocks: 'b', requestMessageId: '100000000000000102', requestChannelId: '100000000000000100' }, Date.now()) }));
  const r = spawnSync(NODE, [SCRIPT('pending-decisions.mjs'), '--ledger', ledger], { encoding: 'utf8', env: { ...process.env, OPENCLAW_BIN: bin, OPENCLAW_DATA_ROOT: dir } });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /NO_REPLY/);
  const calls = readFileSync(join(dir, 'calls.log'), 'utf8');
  assert.match(calls, /message pin/); assert.match(calls, /新的一件等你定/);
  assert.equal(JSON.parse(readFileSync(ledger, 'utf8')).items[0].notice.state, '已发');
  rmSync(dir, { recursive: true, force: true });
});

// ---------- 看护要真读到 3.5 的待核、卡住的锁、没接住的撞额度和两个待核日志 ----------
import { collectCatchupFlags } from '../scripts/automation/day-watch.mjs';
import { mkdirSync as mkd, utimesSync } from 'node:fs';

test('collectCatchupFlags：补跑账待核／补跑结果待核／通知未送达、补跑卡住、没接住的撞额度、两个待核日志都读得到；补跑那四个任务的撞额度和过期的不报', () => {
  const root = mkdtempSync(join(tmpdir(), 'dw-flags-'));
  const NOW = Date.parse('2026-11-12T07:30:00Z');
  const put = (rel, obj) => { const f = join(root, rel); mkd(join(f, '..'), { recursive: true }); writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
  put('运行记录/补跑/日审-2026-11-11.json', { 状态: '待核（没找到发起记录）', 更新时间毫秒: NOW - 1000 });
  put('运行记录/补跑/巡查-2026-11-11.json', { 状态: '补跑结果待核', 更新时间毫秒: NOW - 1000 });
  put('运行记录/补跑/周审-2026-11-08.json', { 状态: '已补跑', 通知: { 状态: '未送达' }, 更新时间毫秒: NOW - 1000 });
  put('运行记录/补跑/异常深审-2026-11-11.json', { 状态: '已补跑', 通知: { 状态: '已送达' } });
  put('运行记录/补跑/.stuck-notified', { 日期: '2026-11-12' });
  put('运行记录/额度/q1.json', { 运行编号: 'q1', 角色: 'task-auditor', 是定时任务: false, 失败时间毫秒: NOW - 3600000, 终态已确认: true, 报错前200字: "You've hit your 5-hour limit", 恢复时间: '2026-11-12T09:30:00Z' });
  put('运行记录/额度/q2.json', { 运行编号: 'q2', 角色: 'system-auditor', 是定时任务: true, 任务编号: '00000000-0000-4000-8000-000000000001', 失败时间毫秒: NOW - 3600000, 终态已确认: true });
  put('运行记录/额度/q3.json', { 运行编号: 'q3', 角色: 'main', 是定时任务: false, 失败时间毫秒: NOW - 5 * 86400000, 终态已确认: true });
  put('运行记录/额度/q4.json', { 运行编号: 'q4', 角色: 'main', 是定时任务: true, 任务编号: '别的任务', 失败时间毫秒: NOW - 3600000, 终态已确认: true });
  const f1 = put('运行记录/看护/台账锁待核.log', '台账锁待核\n'); utimesSync(f1, new Date(NOW - 3600000), new Date(NOW - 3600000));
  const f2 = put('运行记录/看护/看护锁待核.log', '旧的\n'); utimesSync(f2, new Date(NOW - 10 * 86400000), new Date(NOW - 10 * 86400000));
  const out = collectCatchupFlags(root, NOW);
  const objs = out.map((x) => x.object).sort();
  assert.deepEqual(objs, ['q1', 'q4', '台账锁待核.log', '补跑检查卡住', '补跑账:周审-2026-11-08.json:通知未送达', '补跑账:巡查-2026-11-11.json:补跑结果待核', '补跑账:日审-2026-11-11.json:待核'].sort());
  assert.ok(out.find((x) => x.object === 'q1').text.includes('不是补跑管的那四个任务'));
  rmSync(root, { recursive: true, force: true });
});

test('collectAnomalies：看护的收集函数接上后，撞额度会进异常清单（不再永远是空）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dw-flags2-'));
  const NOW = Date.parse('2026-11-12T07:30:00Z');
  mkd(join(root, '运行记录/额度'), { recursive: true });
  writeFileSync(join(root, '运行记录/额度/q9.json'), JSON.stringify({ 运行编号: 'q9', 角色: 'main', 是定时任务: false, 失败时间毫秒: NOW - 60000, 终态已确认: true }));
  const out = collectAnomalies({ now: () => NOW, listCards: () => [], listJobs: () => [], listRuns: () => [], collectCatchupFlags: () => collectCatchupFlags(root, NOW) });
  assert.ok(out.some((x) => x.type === 'quota-hit' && x.object === 'q9'));
  rmSync(root, { recursive: true, force: true });
});

test('已归档的卡（状态还是运行中）不当“久没动”；到点任务那一路也跳过已归档的卡', () => {
  const NOW = Date.parse('2026-11-12T07:30:00Z');
  const old = NOW - 5 * 3600000;
  const base = { now: () => NOW, listJobs: () => [], listRuns: () => [] };
  const live = { id: 'live', title: '活卡', status: 'running', updatedAt: old, labels: [], notes: '' };
  const arch = { id: 'arch', title: '归档的运行中卡', status: 'running', updatedAt: old, metadata: { archivedAt: NOW - 3600000 }, labels: [], notes: '定时任务编号：abc\n到点时间：2026-11-11T04:30:00Z' }; // 真实输出的样子：归档时间在 metadata.archivedAt
  const archTop = { id: 'archTop', title: '顶层写归档的', status: 'running', updatedAt: old, archivedAt: NOW - 1000, labels: [], notes: '' };
  const out = collectAnomalies({ ...base, listCards: () => [live, arch, archTop] });
  assert.deepEqual(out.filter((x) => x.type === 'card-stale').map((x) => x.object), ['live']);
  assert.ok(!out.some((x) => x.object === 'arch'), '归档卡的到点任务也不报');
});

// ----- 撞额度只叫一次（叫起的那次跑完且 ok），"一天"按测试时区（UTC+5:30）天 -----
const QANOM = { object: '163f5208-test', type: 'quota-hit', startedAt: Date.parse('2026-11-11T21:00:00Z') - 5 * H, text: '任务审计在对话里撞了 5 小时额度（测试）' };
const CANOM = { object: 'c1', type: 'card-stale', startedAt: T0 - 3 * H, text: '卡一久没动（测试）' };
const DAY = 86400000;
const finishJob = (t, id, status, extra = {}) => { t.st.jobs.length = 0; t.st.runs[id] = [{ action: 'finished', status, ...extra }]; };

test('撞额度：叫起的那次任务结束且 status 是 ok，第二天异常还在 → 不再叫（noop）；之后连续几天也不叫、不升级', async () => {
  const t = mk();
  assert.equal((await handleAnomaly(t.d, QANOM)).action, 'called');
  finishJob(t, 'job1', 'ok');
  for (let i = 1; i <= 4; i++) {
    t.st.clock = T0 + i * DAY;
    const r = await handleAnomaly(t.d, QANOM);
    assert.equal(r.action, 'noop', `第 ${i + 1} 天应 noop，实际 ${r.action}`);
  }
  assert.equal(t.st.calls.length, 1, '只叫过一次');
  assert.ok(!existsSync(t.d.pendingLedgerPath), '没有升级交主人');
  t.cleanup();
});

test("撞额度：叫起的那次任务结束但 status 是 error（或被打断）→ 第二天照样再叫一次，同一天不叫第二次", async () => {
  for (const status of ['error', 'skipped', undefined]) {
    const t = mk();
    await handleAnomaly(t.d, QANOM);
    finishJob(t, 'job1', status);
    t.st.clock = T0 + 6 * H;
    assert.equal((await handleAnomaly(t.d, QANOM)).action, 'already-today');
    t.st.clock = T0 + DAY;
    assert.equal((await handleAnomaly(t.d, QANOM)).action, 'called', `status=${status} 第二天应再叫`);
    assert.equal(t.st.calls.length, 2);
    t.cleanup();
  }
});

test('撞额度：叫起的任务已被删（--delete-after-run）、只剩运行记录，看最后一次结束记录的 status', async () => {
  const t = mk();
  await handleAnomaly(t.d, QANOM);
  t.st.jobs.length = 0; t.st.runs.job1 = [{ action: 'finished', status: 'ok', ts: 2000 }, { action: 'finished', status: 'error', ts: 1000 }]; // 新→旧
  t.st.clock = T0 + DAY;
  assert.equal((await handleAnomaly(t.d, QANOM)).action, 'noop', '最新一次是 ok');
  const t2 = mk();
  await handleAnomaly(t2.d, QANOM);
  t2.st.jobs.length = 0; t2.st.runs.job1 = [{ action: 'finished', status: 'error', ts: 3000 }, { action: 'finished', status: 'ok', ts: 1000 }];
  t2.st.clock = T0 + DAY;
  assert.equal((await handleAnomaly(t2.d, QANOM)).action, 'called', '最新一次是 error');
  t.cleanup(); t2.cleanup();
});

test('撞额度：叫起的任务还没结束 → 照旧 busy', async () => {
  const t = mk();
  await handleAnomaly(t.d, QANOM);
  t.st.clock = T0 + DAY; // job1 还在 jobs 里、没有结束记录
  assert.equal((await handleAnomaly(t.d, QANOM)).action, 'busy');
  t.cleanup();
});

test('卡久没动（card-stale）：叫起的任务结束且 ok、第二天还在 → 照样再叫一次（行为不变）', async () => {
  const t = mk();
  await handleAnomaly(t.d, CANOM);
  finishJob(t, 'job1', 'ok');
  t.st.clock = T0 + DAY;
  assert.equal((await handleAnomaly(t.d, CANOM)).action, 'called');
  assert.equal(t.st.calls.length, 2);
  t.cleanup();
});

test('"一天"按测试时区（UTC+5:30）天算：测试时区（UTC+5:30）同一天的 08:00 和 10:00（UTC 跨日）两遍 → 第二遍 already-today', async () => {
  const t = mk();
  t.st.clock = Date.parse('2026-11-12T02:30:00Z'); // 测试时区（UTC+5:30） 11-12 08:00
  assert.equal((await handleAnomaly(t.d, CANOM)).action, 'called');
  finishJob(t, 'job1', 'ok');
  t.st.clock = Date.parse('2026-11-12T04:30:00Z'); // 测试时区（UTC+5:30） 11-12 10:00，UTC 已是 11-12
  assert.equal((await handleAnomaly(t.d, CANOM)).action, 'already-today');
  t.st.clock = Date.parse('2026-11-12T18:29:00Z'); // 测试时区（UTC+5:30） 11-12 23:59
  assert.equal((await handleAnomaly(t.d, CANOM)).action, 'already-today');
  t.st.clock = Date.parse('2026-11-12T18:30:00Z'); // 测试时区（UTC+5:30） 11-13 00:00
  assert.equal((await handleAnomaly(t.d, CANOM)).action, 'called');
  assert.equal(t.st.calls.length, 2);
  t.cleanup();
});

test('card-stale 连续 3 个测试时区（UTC+5:30）天每天都叫过后升级交主人（逻辑不变）', async () => {
  const t = mk();
  const at = (iso) => { t.st.clock = Date.parse(iso); };
  at('2026-11-12T02:30:00Z'); await handleAnomaly(t.d, CANOM);          // 11-12 08:00
  finishJob(t, 'job1', 'ok'); at('2026-11-13T02:30:00Z'); assert.equal((await handleAnomaly(t.d, CANOM)).action, 'called');   // 11-13 08:00
  finishJob(t, 'job2', 'ok'); at('2026-11-14T02:30:00Z'); assert.equal((await handleAnomaly(t.d, CANOM)).action, 'called');   // 11-14 08:00
  finishJob(t, 'job3', 'ok'); at('2026-11-15T02:30:00Z');
  assert.equal((await handleAnomaly(t.d, CANOM)).action, 'escalate');   // 11-15 08:00：连续 3 天都叫过
  assert.equal((await handleAnomaly(t.d, CANOM)).action, 'noop');
  assert.equal(t.st.calls.length, 3);
  t.cleanup();
});

test('localDay、lastFinishedStatus 小函数', () => {
  assert.equal(localDay(Date.parse('2026-11-11T18:29:59Z')), localDay(Date.parse('2026-11-11T04:30:00Z')));
  assert.equal(localDay(Date.parse('2026-11-11T18:30:00Z')), localDay(Date.parse('2026-11-11T04:30:00Z')) + 1);
  assert.equal(lastFinishedStatus([]), undefined);
  assert.equal(lastFinishedStatus([{ action: 'started' }]), undefined);
  assert.equal(lastFinishedStatus([{ action: 'finished', status: 'ok' }]), 'ok');
  assert.equal(lastFinishedStatus([{ action: 'finished', status: 'ok' }, { action: 'finished', status: 'error' }]), 'error', '没有时间戳又有多条，取保守');
  assert.equal(lastFinishedStatus([{ action: 'finished', status: 'ok', runAtMs: 5 }, { action: 'finished', status: 'error', ts: 4 }]), 'ok');
});

import { collectDiscordHealthFlags, HEARTBEAT_TIMEOUT_ALERT } from '../scripts/automation/day-watch.mjs';
import { mkdtempSync as _mk, writeFileSync as _wf2, rmSync as _rm2 } from 'node:fs';
import { tmpdir as _td } from 'node:os';
import { join as _jn } from 'node:path';
{
  const NOWMS = Date.parse('2026-11-18T07:30:00Z'); // 测试时区（UTC+5:30） 13:00
  const line = (iso, msg) => JSON.stringify({ 1: msg, _meta: { date: iso }, message: msg });
  const reconnect = (iso, resume) => line(iso, `discord gateway: Gateway reconnect scheduled in 2000ms (reconnect-opcode, resume=${resume})`);
  const hb = (iso) => line(iso, 'discord gateway error: Error: Gateway heartbeat ACK timeout');
  test('只有 resume=true 的重连（再多也不算异常）→ 没有告警', () => {
    const dir = _mk(_jn(_td(), 'gwlog-'));
    try {
      _wf2(_jn(dir, 'openclaw-2026-11-18.log'), Array.from({ length: 50 }, (_, i) => reconnect(new Date(NOWMS - i * 60000).toISOString(), true)).join('\n') + '\n');
      assert.deepEqual(collectDiscordHealthFlags(dir, NOWMS), []);
    } finally { _rm2(dir, { recursive: true, force: true }); }
  });
  test('最近 1 小时有 resume=false → 告警一条；1 小时以前的不算；读不到日志当没有', () => {
    const dir = _mk(_jn(_td(), 'gwlog-'));
    try {
      _wf2(_jn(dir, 'openclaw-2026-11-18.log'), [reconnect(new Date(NOWMS - 10 * 60000).toISOString(), false), reconnect(new Date(NOWMS - 5 * 3600000).toISOString(), false)].join('\n') + '\n');
      const r = collectDiscordHealthFlags(dir, NOWMS);
      assert.equal(r.length, 1); assert.equal(r[0].type, 'discord-resume-failed'); assert.match(r[0].text, /1 次重连没能续上/);
      assert.deepEqual(collectDiscordHealthFlags(_jn(dir, '不存在'), NOWMS), []);
    } finally { _rm2(dir, { recursive: true, force: true }); }
  });
  test('一小时里心跳没回达到阈值才告警；1 次不告警', () => {
    const dir = _mk(_jn(_td(), 'gwlog-'));
    try {
      _wf2(_jn(dir, 'openclaw-2026-11-18.log'), hb(new Date(NOWMS - 600000).toISOString()) + '\n');
      assert.deepEqual(collectDiscordHealthFlags(dir, NOWMS), []);
      _wf2(_jn(dir, 'openclaw-2026-11-18.log'), Array.from({ length: HEARTBEAT_TIMEOUT_ALERT }, (_, i) => hb(new Date(NOWMS - i * 60000).toISOString())).join('\n') + '\n');
      const r = collectDiscordHealthFlags(dir, NOWMS);
      assert.equal(r.length, 1); assert.equal(r[0].type, 'discord-heartbeat-timeout');
    } finally { _rm2(dir, { recursive: true, force: true }); }
  });
}

// ----- 日审格式抽查的启动：只在测试时区（UTC+5:30） 17:30～18:04、当天文件还没写完整时启动；看护不等它 -----
const localParts = (hhmm, day = '2026-11-22') => Date.parse(`${day}T${hhmm}:00+05:30`);
test('格式抽查什么时候该跑：17:30～18:04 且当天文件没有“状态：完整”才跑', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwf-'));
  try {
    assert.equal(formatCheckDue(localParts('17:29'), dir), false);
    assert.equal(formatCheckDue(localParts('17:30'), dir), true);
    assert.equal(formatCheckDue(localParts('18:04'), dir), true);
    assert.equal(formatCheckDue(localParts('18:05'), dir), false);
    assert.equal(formatCheckDue(localParts('08:00'), dir), false);
    const d = join(dir, '审计', '日审'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '2026-11-22-格式抽查.md'), '# x\n\n状态：未完成（超时保护，下一遍会再试）\n');
    assert.equal(formatCheckDue(localParts('18:00'), dir), true, '没写完整：下一遍再试');
    writeFileSync(join(d, '2026-11-22-格式抽查.md'), '# x\n\n状态：完整\n');
    assert.equal(formatCheckDue(localParts('18:00'), dir), false, '写完整了：不再跑');
    assert.equal(formatCheckDue(localParts('17:40', '2026-11-23'), dir), true, '第二天是新的一天');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('startFormatCheck：到点才起子进程，用脱钩的方式（detached、stdio 忽略、unref）；没到点不起；起不来不抛错', () => {
  const calls = [];
  const fake = (cmd, args, opt) => { calls.push({ cmd, args, opt }); return { on() {}, unref() { calls.at(-1).unref = true; } }; };
  const dir = mkdtempSync(join(tmpdir(), 'dwf-'));
  try {
    assert.deepEqual(startFormatCheck({ nowMs: localParts('12:00'), dataRoot: dir, spawnFn: fake }), { started: false });
    assert.equal(calls.length, 0);
    assert.equal(startFormatCheck({ nowMs: localParts('17:35'), dataRoot: dir, spawnFn: fake }).started, true);
    assert.equal(calls[0].cmd, process.execPath); assert.deepEqual(calls[0].args, [FORMAT_CHECK_SCRIPT]);
    assert.equal(calls[0].opt.detached, true); assert.equal(calls[0].opt.stdio, 'ignore'); assert.equal(calls[0].unref, true);
    const logs = [];
    const r = startFormatCheck({ nowMs: localParts('17:35'), dataRoot: dir, spawnFn: () => { throw new Error('起不来'); }, log: (t) => logs.push(t) });
    assert.deepEqual(r, { started: false, error: true }); assert.match(logs[0], /没起来：起不来/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('看护退出不等格式抽查：子进程睡 30 秒，看护这边 3 秒内就退出，标准输出仍然只有 NO_REPLY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwf-'));
  try {
    const slow = join(dir, 'slow.mjs');
    writeFileSync(slow, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid)); setTimeout(() => {}, 30000);`);
    const runner = join(dir, 'runner.mjs');
    writeFileSync(runner, `import { startFormatCheck } from ${JSON.stringify(new URL('../scripts/automation/day-watch.mjs', import.meta.url).href)};
process.stdout.write('NO_REPLY\\n');
startFormatCheck({ nowMs: ${localParts('17:40')}, dataRoot: ${JSON.stringify(dir)}, script: ${JSON.stringify(slow)} });
process.exit(0);`);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 10000, env: { ...process.env, OPENCLAW_DATA_ROOT: dir } });
    const took = Date.now() - t0;
    assert.equal(r.status, 0); assert.equal(r.stdout, 'NO_REPLY\n'); assert.ok(took < 3000, `看护用了 ${took} 毫秒`);
    // 子进程确实起来了、而且还活着（脱钩）
    const deadline = Date.now() + 3000; let pid = null;
    while (Date.now() < deadline && !pid) { try { pid = Number(readFileSync(join(dir, 'pid'), 'utf8')); } catch { spawnSync('sleep', ['0.1']); } }
    assert.ok(pid > 0, '子进程没起来');
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    assert.ok(alive, '看护退出后子进程应还在跑');
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已结束 */ }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('格式抽查子进程崩了（脚本不存在或抛错）：不影响看护的输出和退出码', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwf-'));
  try {
    const bad = join(dir, 'bad.mjs'); writeFileSync(bad, 'throw new Error("崩了");');
    for (const script of [bad, join(dir, '不存在.mjs')]) {
      const runner = join(dir, 'runner.mjs');
      writeFileSync(runner, `import { startFormatCheck } from ${JSON.stringify(new URL('../scripts/automation/day-watch.mjs', import.meta.url).href)};
process.stdout.write('NO_REPLY\\n');
startFormatCheck({ nowMs: ${localParts('17:40')}, dataRoot: ${JSON.stringify(dir)}, script: ${JSON.stringify(script)} });
process.exit(0);`);
      const r = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 10000, env: { ...process.env, OPENCLAW_DATA_ROOT: dir } });
      assert.equal(r.status, 0); assert.equal(r.stdout, 'NO_REPLY\n');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('起格式抽查出错的日志写在传进来的数据根下（不碰全局看护目录）；起不来的异步错误退出前能记下来', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwf-'));
  try {
    const r = startFormatCheck({ nowMs: localParts('17:40'), dataRoot: dir, spawnFn: () => { throw new Error('同步起不来'); } });
    assert.deepEqual(r, { started: false, error: true });
    assert.match(readFileSync(join(dir, '运行记录', '看护', '格式抽查启动.log'), 'utf8'), /没起来：同步起不来/);
    // 异步错误：可执行文件不存在 → child 的 error 事件；settle 等一下再退，日志要在
    const r2 = startFormatCheck({ nowMs: localParts('17:41'), dataRoot: dir, execPath: join(dir, '不存在的node') });
    assert.equal(r2.started, true);
    await settleFormatCheck(r2);
    assert.match(readFileSync(join(dir, '运行记录', '看护', '格式抽查启动.log'), 'utf8'), /没起来：.*ENOENT/);
    // 正常起来：settle 一收到 spawn 事件就返回（远小于 500 毫秒的上限之外也不会等子进程跑完）
    const ok = join(dir, 'ok.mjs'); writeFileSync(ok, 'setTimeout(() => {}, 5000);');
    const t0 = Date.now(); const r3 = startFormatCheck({ nowMs: localParts('17:42'), dataRoot: dir, script: ok });
    await settleFormatCheck(r3); assert.ok(Date.now() - t0 < 450, `等了 ${Date.now() - t0} 毫秒`);
    try { process.kill(r3.child.pid, 'SIGKILL'); } catch { /* 已结束 */ }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('blindspotsDue：17:30 以后、当天文件没写完整才该跑；前一天的不算；写完整了不再跑', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-bs-'));
  try {
    const localParts = (hhmm, day = '2026-11-22') => Date.parse(`${day}T${hhmm}:00+05:30`);
    assert.equal(blindspotsDue(localParts('17:29'), dir), false);
    assert.equal(blindspotsDue(localParts('17:30'), dir), true);
    assert.equal(blindspotsDue(localParts('20:45'), dir), true, '白天看护的最后几遍也补跑');
    assert.equal(blindspotsDue(localParts('08:00'), dir), false);
    mkdirSync(join(dir, '审计', '日审'), { recursive: true });
    writeFileSync(join(dir, '审计', '日审', '2026-11-22-盲区抽查.md'), '# x\n没写完\n');
    assert.equal(blindspotsDue(localParts('18:00'), dir), true, '没写完整：下一遍再试');
    writeFileSync(join(dir, '审计', '日审', '2026-11-22-盲区抽查.md'), '# x\n状态：完整\n');
    assert.equal(blindspotsDue(localParts('18:00'), dir), false);
    assert.equal(blindspotsDue(localParts('17:40', '2026-11-23'), dir), true, '第二天是新的一天');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('startBlindspots：到点才起，用脱钩的方式；起不来不抛错；脚本文件存在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-bs2-'));
  try {
    const localParts = (hhmm) => Date.parse(`2026-11-22T${hhmm}:00+05:30`);
    const calls = [];
    const fake = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() { calls.at(-1).unref = true; } }; };
    assert.deepEqual(startBlindspots({ nowMs: localParts('12:00'), dataRoot: dir, spawnFn: fake }), { started: false });
    assert.equal(calls.length, 0);
    assert.equal(startBlindspots({ nowMs: localParts('17:35'), dataRoot: dir, spawnFn: fake }).started, true);
    assert.equal(calls[0].opts.detached, true); assert.equal(calls[0].opts.stdio, 'ignore'); assert.equal(calls[0].unref, true); assert.ok(calls[0].args[0].endsWith('audit-blindspots.mjs'));
    assert.ok(existsSync(BLINDSPOTS_SCRIPT));
    const logs = [];
    const r = startBlindspots({ nowMs: localParts('17:35'), dataRoot: dir, spawnFn: () => { throw new Error('起不来'); }, log: (t) => logs.push(t) });
    assert.equal(r.started, false); assert.match(logs[0], /盲区抽查没起来：起不来/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('看护让路：归额度接续管的撞限登记——账里有且状态不需要人看→不叫；接续没成功／结果待核／读不出→叫；账里没有且不到 30 分钟→不叫，超过→叫', () => {
  const root = mkdtempSync(join(tmpdir(), 'dw-resume-'));
  const NOW = Date.parse('2026-11-22T15:00:00+05:30');
  const KEY = 'agent:worker-e:discord:channel:100000000000000104';
  const put = (rel, obj) => { const f = join(root, rel); mkd(join(f, '..'), { recursive: true }); writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  const reg = (id, ageMin, extra = {}) => put(`运行记录/额度/${id}.json`, { 运行编号: id, 会话键: KEY, 角色: 'worker-e', 是定时任务: false, 失败时间毫秒: NOW - ageMin * 60000, 终态已确认: true, ...extra });
  const touchLedger = () => { const f = join(root, '运行记录/额度/接续/账.json'); utimesSync(f, new Date(NOW - 60000), new Date(NOW - 60000)); };
  const ledger = (runs) => { put('运行记录/额度/接续/账.json', { 链: Object.fromEntries(Object.entries(runs).map(([r, st]) => [`c-${r}`, { id: `c-${r}`, 状态: st }])), 运行: Object.fromEntries(Object.keys(runs).map((r) => [r, `c-${r}`])) }); touchLedger(); };
  reg('w-wait', 120); reg('w-launched', 120); reg('w-joined', 120); reg('w-nocont', 120); reg('w-unknown', 120); reg('w-unread', 120); reg('w-chat', 120);
  reg('n-fresh', 10); reg('n-old', 45);
  ledger({ 'w-wait': '待发起', 'w-launched': '已发起', 'w-joined': '已接上', 'w-nocont': '接续没成功', 'w-unknown': '结果待核', 'w-unread': '读不出', 'w-chat': '不接续：闲聊' });
  const objs = collectCatchupFlags(root, NOW).filter((x) => x.type === 'quota-hit').map((x) => x.object).sort();
  assert.deepEqual(objs, ['n-old', 'w-nocont', 'w-unknown', 'w-unread']);
  rmSync(root, { recursive: true, force: true });
});
test('看护让路：不归接续管的（一次性定时任务、桌面角色、备用A、备用B）照老路叫，哪怕账里"有记录"、也不等宽限', () => {
  const root = mkdtempSync(join(tmpdir(), 'dw-resume2-'));
  const NOW = Date.parse('2026-11-22T15:00:00+05:30');
  const put = (rel, obj) => { const f = join(root, rel); mkd(join(f, '..'), { recursive: true }); writeFileSync(f, JSON.stringify(obj)); };
  const base = { 是定时任务: false, 失败时间毫秒: NOW - 60000, 终态已确认: true };
  put('运行记录/额度/cron1.json', { ...base, 运行编号: 'cron1', 角色: 'main', 是定时任务: true, 任务编号: '别的任务', 会话键: 'agent:main:cron:x:run:y' });
  put('运行记录/额度/dsk1.json', { ...base, 运行编号: 'dsk1', 角色: 'desktop', 会话键: 'agent:desktop:discord:channel:100000000000000104' });
  put('运行记录/额度/sbA1.json', { ...base, 运行编号: 'sbA1', 角色: 'standby-a', 会话键: 'agent:standby-a:discord:channel:100000000000000104' });
  put('运行记录/额度/sbB1.json', { ...base, 运行编号: 'sbB1', 角色: 'standby-b', 会话键: 'agent:standby-b:discord:channel:100000000000000104' });
  put('运行记录/额度/接续/账.json', { 链: { c: { id: 'c', 状态: '已接上' } }, 运行: { cron1: 'c', dsk1: 'c', sbA1: 'c', sbB1: 'c' } });
  utimesSync(join(root, '运行记录/额度/接续/账.json'), new Date(NOW - 60000), new Date(NOW - 60000));
  const objs = collectCatchupFlags(root, NOW).filter((x) => x.type === 'quota-hit').map((x) => x.object).sort();
  assert.deepEqual(objs, ['cron1', 'dsk1', 'sbA1', 'sbB1']);
  rmSync(root, { recursive: true, force: true });
});
test('看护让路：同一会话键以前有旧链（已接上），又来一条新运行编号 → 按"账里还没有"走宽限，超时照旧叫；账文件损坏 → 照旧叫、不等宽限', () => {
  const root = mkdtempSync(join(tmpdir(), 'dw-resume3-'));
  const NOW = Date.parse('2026-11-22T15:00:00+05:30');
  const KEY = 'agent:worker-e:discord:channel:100000000000000104';
  const put = (rel, obj) => { const f = join(root, rel); mkd(join(f, '..'), { recursive: true }); writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  const reg = (id, ageMin) => put(`运行记录/额度/${id}.json`, { 运行编号: id, 会话键: KEY, 角色: 'worker-e', 是定时任务: false, 失败时间毫秒: NOW - ageMin * 60000, 终态已确认: true });
  reg('old-run', 600); reg('new-fresh', 10);
  put('运行记录/额度/接续/账.json', { 链: { c1: { id: 'c1', 会话键: KEY, 状态: '已接上' } }, 运行: { 'old-run': 'c1' } });
  utimesSync(join(root, '运行记录/额度/接续/账.json'), new Date(NOW - 60000), new Date(NOW - 60000));
  let objs = collectCatchupFlags(root, NOW).filter((x) => x.type === 'quota-hit').map((x) => x.object);
  assert.deepEqual(objs, [], '旧链已接上不叫；新运行编号才 10 分钟还在宽限里');
  reg('new-late', 45);
  objs = collectCatchupFlags(root, NOW).filter((x) => x.type === 'quota-hit').map((x) => x.object);
  assert.deepEqual(objs, ['new-late'], '新运行编号超过 30 分钟账里还没有 → 照旧叫醒兜底，不被旧链状态误导');
  put('运行记录/额度/接续/账.json', '{这不是JSON');
  utimesSync(join(root, '运行记录/额度/接续/账.json'), new Date(NOW - 60000), new Date(NOW - 60000));
  objs = collectCatchupFlags(root, NOW).filter((x) => x.type === 'quota-hit').map((x) => x.object).sort();
  assert.deepEqual(objs, ['new-fresh', 'new-late', 'old-run'], '账文件损坏：全部照旧，不让路、不等宽限');
  rmSync(root, { recursive: true, force: true });
});

test('看护让路：账文件超过 45 分钟没更新（额度接续停用或连续出错）→ 看护照旧叫，不让路、不等宽限', () => {
  const root = mkdtempSync(join(tmpdir(), 'dw-resume4-'));
  const NOW = Date.parse('2026-11-22T15:00:00+05:30');
  const KEY = 'agent:worker-e:discord:channel:100000000000000104';
  const put = (rel, obj) => { const f = join(root, rel); mkd(join(f, '..'), { recursive: true }); writeFileSync(f, JSON.stringify(obj)); };
  put('运行记录/额度/w1.json', { 运行编号: 'w1', 会话键: KEY, 角色: 'worker-e', 是定时任务: false, 失败时间毫秒: NOW - 5 * 60000, 终态已确认: true });
  put('运行记录/额度/接续/账.json', { 链: { c: { id: 'c', 状态: '待发起' } }, 运行: { w1: 'c' } });
  const f = join(root, '运行记录/额度/接续/账.json');
  utimesSync(f, new Date(NOW - 10 * 60000), new Date(NOW - 10 * 60000));
  assert.deepEqual(collectCatchupFlags(root, NOW).filter((x) => x.type === 'quota-hit'), [], '账 10 分钟前才更新过：额度接续还活着，让路');
  utimesSync(f, new Date(NOW - 60 * 60000), new Date(NOW - 60 * 60000));
  assert.deepEqual(collectCatchupFlags(root, NOW).filter((x) => x.type === 'quota-hit').map((x) => x.object), ['w1'], '账 60 分钟没更新：额度接续不干活了，看护兜底');
  rmSync(root, { recursive: true, force: true });
});
