// Offline tests for quota catchup: temporary directories and fake data only; nothing touches a real deployment.
// 额度补跑脚本离线测试：假的官方命令输出、假时钟。运行：node --test tests/quota-catchup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCatchup, parseRunId, windowResetAt, roundDone, TASKS } from '../scripts/automation/quota-catchup.mjs';

const BR = (s) => Date.parse(`${s}+05:30`);
const JOB = '00000000-0000-4000-8000-000000000001';
const OWN = 'aaaaaaaa-0000-0000-0000-000000000001';
const SCHEDULE = { kind: 'cron', expr: '5 18 * * *', tz: 'Asia/Kolkata', staggerMs: 0 };
const QUOTA = (reset = '11pm') => `You've hit your 5-hour limit · resets ${reset} (Asia/Kolkata)`;
const runIdFor = (jobId, ms) => `cron:${jobId}:${ms}:slot`;

function world({ name = '日审', schedule = SCHEDULE, start = '2026-11-10T18:30:00', failAt = '2026-11-10T18:05:00', error = QUOTA(), archive = true } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'catchup-'));
  const w = {
    dataRoot, t: BR(start), calls: [], codex: null, launchBehavior: 'ok',
    jobs: [{ id: JOB, name, enabled: true, schedule, payload: { model: 'sonnet' }, state: { nextRunAtMs: BR('2026-11-11T18:05:00'), runningAtMs: null } }, { id: OWN, name: '额度补跑', enabled: true, schedule: { kind: 'every', everyMs: 600000 }, state: {} }],
    runs: { [JOB]: [], [OWN]: [] },
    done: () => rmSync(dataRoot, { recursive: true, force: true }),
  };
  w.deps = {
    now: () => w.t,
    listJobs: () => w.jobs,
    listRuns: (id) => w.runs[id] ?? [],
    runJob: (id) => {
      w.calls.push({ id, at: w.t });
      if (w.launchBehavior === 'throw') throw new Error('连接失败');
      if (w.launchBehavior === 'noid') return '{"ok":true}';
      const runId = runIdFor(id, w.t);
      w.lastLaunched = runId;
      if (w.launchBehavior === 'queued') return JSON.stringify({ enqueued: true, runId });
      return JSON.stringify({ ok: true, runId });
    },
    codexbar: () => w.codex,
  };
  const failMs = BR(failAt);
  w.failure = { ts: failMs + 60000, jobId: JOB, action: 'finished', status: 'error', error, runId: runIdFor(JOB, failMs), runAtMs: failMs, durationMs: 60000, errorReason: 'rate_limit', model: 'claude-sonnet-5-5' };
  w.runs[JOB].push(w.failure);
  if (archive) {
    mkdirSync(join(dataRoot, '运行记录', '额度', '计划存档'), { recursive: true });
    writeFileSync(join(dataRoot, '运行记录', '额度', '计划存档', `${JOB}-${failMs}.json`), JSON.stringify({ 任务编号: JOB, 任务名: name, 开始时间毫秒: failMs, 计划: schedule }));
  }
  w.check = () => runCatchup({ dataRoot, deps: w.deps });
  w.account = (date = '2026-11-10', task = name) => JSON.parse(readFileSync(join(dataRoot, '运行记录', '补跑', `${task}-${date}.json`), 'utf8'));
  w.finishLaunched = (over = {}) => {
    const runId = w.lastLaunched;
    const ms = Number(runId.split(':')[2]);
    w.runs[JOB].push({ ts: ms + 120000, jobId: JOB, action: 'finished', status: 'ok', runId, runAtMs: ms, durationMs: 120000, model: 'claude-sonnet-5-5', ...over });
  };
  w.markRoundDone = (task = name, date = '2026-11-10', credential = false) => {
    const d = join(dataRoot, '审计', TASKS[task].目录); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${date}.json`), JSON.stringify({ 任务: task, 业务日期: date, 执行: '完成' }));
    if (credential) {
      const c = join(dataRoot, '审计', '发布', '凭据'); mkdirSync(c, { recursive: true });
      writeFileSync(join(c, `${task}-${date}.json`), JSON.stringify({ 任务: task, 业务日期: date, 账号: 'default', 频道: 'discord', 目标: 'channel:100000000000000003', 状态: '已送达', 消息编号: '100000000000000102' }));
      writeFileSync(join(c, `${task}-${date}.回执.txt`), 'ok');
    }
  };
  return w;
}

test('到恢复时间之前不发起；到点直接试一次，先记账再发起（只发一个请求）', () => {
  const w = world({ start: '2026-11-10T22:00:00' });
  try {
    assert.deepEqual(w.check(), []);
    assert.equal(w.calls.length, 0);
    assert.equal(existsSync(join(w.dataRoot, '运行记录', '补跑', '日审-2026-11-10.json')), false, '没到点不建账');
    w.t = BR('2026-11-10T23:01:00');
    assert.deepEqual(w.check(), []);
    assert.equal(w.calls.length, 1);
    const acc = w.account();
    assert.equal(acc.状态, '已发起（第 1 次）');
    assert.equal(acc.尝试[0].运行编号, runIdFor(JOB, w.t));
    assert.deepEqual(acc.原计划快照, SCHEDULE);
    // 同一轮再检查：不再发起
    w.t += 600000;
    w.check();
    assert.equal(w.calls.length, 1);
  } finally { w.done(); }
});

test('连续运行一：补跑成功写完本轮记录 → 下一次先收账、通知一次，不因本轮已完成提前跳过；不重复通知', () => {
  const w = world({ start: '2026-11-10T23:01:00' });
  try {
    w.check();
    w.finishLaunched();
    w.markRoundDone();
    w.t += 600000;
    const out = w.check();
    assert.deepEqual(out, ['已补跑：日审（2026-11-10）']);
    assert.equal(w.account().状态, '已补跑');
    assert.equal(w.account().通知.状态, '已交出待核');
    w.t += 600000;
    assert.deepEqual(w.check(), [], '不重复通知');
    // 核投递：我们自己这个任务的运行记录里有送达状态
    w.runs[OWN].push({ ts: w.t - 300000, action: 'finished', status: 'ok', runAtMs: w.t - 400000, durationMs: 1000, delivered: true, deliveryStatus: 'delivered', runId: 'own-1' });
    w.t += 600000;
    w.check();
    assert.equal(w.account().通知.状态, '已送达');
    assert.equal(w.calls.length, 1);
  } finally { w.done(); }
});

test('通知没送达 → 记“未送达”，不重发；投递状态查不到 → 过 30 分钟记待核', () => {
  const w = world({ start: '2026-11-10T23:01:00' });
  try {
    w.check(); w.finishLaunched(); w.markRoundDone();
    w.t += 600000; w.check();
    w.runs[OWN].push({ ts: w.t + 1000, action: 'finished', status: 'ok', runAtMs: w.t - 1000, durationMs: 2000, delivered: false, deliveryStatus: 'not-delivered', runId: 'own-1' });
    w.t += 600000;
    assert.deepEqual(w.check(), []);
    assert.equal(w.account().通知.状态, '未送达');
  } finally { w.done(); }
  const w2 = world({ start: '2026-11-10T23:01:00' });
  try {
    w2.check(); w2.finishLaunched(); w2.markRoundDone();
    w2.t += 600000; w2.check();
    w2.t += 2400000;
    assert.deepEqual(w2.check(), []);
    assert.equal(w2.account().通知.状态, '待核');
  } finally { w2.done(); }
});

test('额度未恢复：第 1 次被拒 → 记“额度未恢复（第 1 次）”不通知，30 分钟内不再试，之后试第 2 次；第 2 次也被拒 → 补跑失败、通知一次、不再试', () => {
  const w = world({ start: '2026-11-10T23:01:00' });
  try {
    w.check();
    w.finishLaunched({ status: 'error', error: QUOTA('11:50pm') });
    w.t += 600000;
    assert.deepEqual(w.check(), []);
    assert.equal(w.account().状态, '额度未恢复（第 1 次）');
    assert.equal(w.calls.length, 1);
    w.t += 600000; // 离第 1 次发起 20 分钟
    w.check();
    assert.equal(w.calls.length, 1, '间隔不到 30 分钟不再试');
    w.t = BR('2026-11-10T23:51:00');
    w.check();
    assert.equal(w.calls.length, 2, '新恢复时间 23:50 已过且隔了 30 分钟');
    assert.equal(w.account().状态, '已发起（第 2 次）');
    w.finishLaunched({ status: 'error', error: QUOTA('2am') });
    w.t += 600000;
    assert.deepEqual(w.check(), ['补跑失败：日审（2026-11-10）额度两次未恢复，不再试']);
    assert.equal(w.account().状态, '补跑失败（额度两次未恢复）');
    for (let i = 0; i < 5; i += 1) { w.t += 1800000; w.check(); }
    assert.equal(w.calls.length, 2, '同一轮最多两次');
  } finally { w.done(); }
});

test('第 2 次要等：新恢复时间和“第 1 次发起＋30 分钟”取较晚者', () => {
  const w = world({ start: '2026-11-10T23:01:00' });
  try {
    w.check();
    w.finishLaunched({ status: 'error', error: QUOTA('2am') });
    w.t = BR('2026-11-11T00:30:00'); w.check();
    w.t = BR('2026-11-11T01:59:00'); w.check();
    assert.equal(w.calls.length, 1, '新恢复时间 02:00 还没到');
    w.t = BR('2026-11-11T02:01:00'); w.check();
    assert.equal(w.calls.length, 2);
  } finally { w.done(); }
});

test('第一次还在排队或没结果：不拿第二次名额重发；排队太久查不到 → 补跑结果待核', () => {
  const w = world({ start: '2026-11-10T23:01:00' });
  try {
    w.launchBehavior = 'queued';
    w.check();
    for (let i = 0; i < 6; i += 1) { w.t += 600000; w.check(); }
    assert.equal(w.calls.length, 1);
    assert.equal(w.account().状态, '已发起（第 1 次）');
    w.t += 7 * 3600000;
    const out = w.check();
    assert.equal(w.account().状态, '补跑结果待核');
    assert.equal(out.length, 1);
    w.t += 7 * 3600000; w.check();
    assert.equal(w.calls.length, 1);
  } finally { w.done(); }
});

test('失败登记缺计划存档、存档对上两份 → “计划未知”，不自动补', () => {
  const w = world({ start: '2026-11-10T23:01:00', archive: false });
  try {
    assert.deepEqual(w.check(), []);
    assert.equal(w.calls.length, 0);
    assert.match(w.account().状态, /不再补跑（原计划未知）/);
  } finally { w.done(); }
  const w2 = world({ start: '2026-11-10T23:01:00' });
  try {
    const failMs = BR('2026-11-10T18:05:00');
    writeFileSync(join(w2.dataRoot, '运行记录', '额度', '计划存档', `${JOB}-${failMs + 500}.json`), JSON.stringify({ 任务编号: JOB, 开始时间毫秒: failMs + 500, 计划: SCHEDULE }));
    w2.check();
    assert.equal(w2.calls.length, 0);
    assert.match(w2.account().状态, /原计划未知/);
  } finally { w2.done(); }
});

test('连续运行二：失败后改了原任务计划 → 以开始事件存档为准，判“改过计划”，不得发起', () => {
  const w = world({ start: '2026-11-10T23:01:00' });
  try {
    w.jobs[0].schedule = { ...SCHEDULE, expr: '5 19 * * *' };
    w.jobs[0].state.nextRunAtMs = BR('2026-11-11T19:05:00');
    w.check();
    assert.equal(w.calls.length, 0);
    assert.match(w.account().状态, /不再补跑（改过计划）/);
  } finally { w.done(); }
});

test('任务停用、本轮已人工补完 → 不发起', () => {
  const w = world({ start: '2026-11-10T23:01:00' });
  try {
    w.jobs[0].enabled = false;
    w.check();
    assert.equal(w.calls.length, 0);
    assert.match(w.account().状态, /任务已停用/);
  } finally { w.done(); }
  const w2 = world({ start: '2026-11-10T23:01:00' });
  try {
    w2.markRoundDone();
    w2.check();
    assert.equal(w2.calls.length, 0);
    assert.equal(existsSync(join(w2.dataRoot, '运行记录', '补跑', '日审-2026-11-10.json')), false, '本轮完成就不建账');
  } finally { w2.done(); }
});

test('离下一轮太近 → 已跳过并通知；正好 6 小时仍可补；周审 24 小时', () => {
  const w = world({ start: '2026-11-11T12:06:00' });
  try {
    w.failure.error = QUOTA('12pm');
    const out = w.check();
    assert.equal(w.calls.length, 0);
    assert.deepEqual(out, ['已跳过：日审（2026-11-10）离下一轮太近，不补了']);
    assert.match(w.account().状态, /已跳过/);
  } finally { w.done(); }
  const w2 = world({ start: '2026-11-11T12:05:00' });
  try {
    w2.failure.error = QUOTA('12pm');
    w2.check();
    assert.equal(w2.calls.length, 1, '正好等于仍可补');
  } finally { w2.done(); }
  const weekly = { kind: 'cron', expr: '0 11 * * 0', tz: 'Asia/Kolkata', staggerMs: 0 };
  const w3 = world({ name: '周审', schedule: weekly, start: '2026-11-21T20:00:00', failAt: '2026-11-15T11:00:00', error: QUOTA('9pm') });
  try {
    w3.jobs[0].state.nextRunAtMs = BR('2026-11-22T11:00:00');
    w3.t = BR('2026-11-21T22:00:00');
    w3.check();
    assert.equal(w3.calls.length, 0, '离下一轮不到 24 小时');
    assert.match(w3.account('2026-11-15', '周审').状态, /已跳过/);
  } finally { w3.done(); }
});

test('官方重试还没完：正在跑／下次运行时间没回到下一轮／最后一次运行结束不满 10 分钟 → 等', () => {
  const w = world({ start: '2026-11-10T23:01:00' });
  try {
    w.jobs[0].state.runningAtMs = BR('2026-11-10T23:00:00');
    w.check(); assert.equal(w.calls.length, 0);
    w.jobs[0].state.runningAtMs = null;
    w.jobs[0].state.nextRunAtMs = BR('2026-11-10T18:10:00');
    w.check(); assert.equal(w.calls.length, 0);
    w.jobs[0].state.nextRunAtMs = BR('2026-11-11T18:05:00');
    w.failure.runAtMs = BR('2026-11-10T22:55:00'); w.failure.ts = BR('2026-11-10T22:56:00'); w.failure.error = QUOTA('11pm');
    w.runs[JOB] = [w.failure];
    mkdirSync(join(w.dataRoot, '运行记录', '额度', '计划存档'), { recursive: true });
    writeFileSync(join(w.dataRoot, '运行记录', '额度', '计划存档', `${JOB}-${w.failure.runAtMs}.json`), JSON.stringify({ 任务编号: JOB, 开始时间毫秒: w.failure.runAtMs, 计划: SCHEDULE }));
    w.t = BR('2026-11-10T23:01:00'); w.failure.error = QUOTA('11pm');
    w.t = BR('2026-11-10T23:05:00');
    w.check(); assert.equal(w.calls.length, 0, '最后一次运行才结束 9 分钟');
    w.t = BR('2026-11-10T23:07:00');
    w.check(); assert.equal(w.calls.length, 1);
  } finally { w.done(); }
});

test('官方接收了但返回丢了（准备发起＋运行记录里有一条）→ 补记编号、不重发；发起后脚本中断（没有）→ 10 分钟后待核、不重发；出现多条 → 待核', () => {
  const w = world({ start: '2026-11-10T23:01:00' });
  try {
    w.launchBehavior = 'noid';
    w.check();
    assert.equal(w.account().状态, '准备发起（第 1 次）');
    w.runs[JOB].push({ ts: w.t + 100000, action: 'finished', status: 'ok', runId: runIdFor(JOB, w.t + 5000), runAtMs: w.t + 5000, durationMs: 90000 });
    w.t += 600000;
    w.check();
    assert.equal(w.account().状态, '已发起（第 1 次）');
    assert.equal(w.account().尝试[0].运行编号, runIdFor(JOB, BR('2026-11-10T23:01:00') + 5000));
    assert.equal(w.calls.length, 1);
  } finally { w.done(); }
  const w2 = world({ start: '2026-11-10T23:01:00' });
  try {
    w2.launchBehavior = 'throw';
    w2.check();
    assert.equal(w2.account().状态, '准备发起（第 1 次）');
    w2.t += 300000; assert.deepEqual(w2.check(), []);
    assert.equal(w2.account().状态, '准备发起（第 1 次）');
    w2.t += 400000;
    const out = w2.check();
    assert.match(w2.account().状态, /待核/);
    assert.match(out[0], /没找到发起记录，不再自动发起/);
    w2.t += 4 * 3600000; w2.check();
    assert.equal(w2.calls.length, 1, '不重发');
  } finally { w2.done(); }
  const w3 = world({ start: '2026-11-10T23:01:00' });
  try {
    w3.launchBehavior = 'noid';
    w3.check();
    for (const d of [5000, 9000]) w3.runs[JOB].push({ ts: w3.t + 100000, action: 'finished', status: 'ok', runId: runIdFor(JOB, w3.t + d), runAtMs: w3.t + d, durationMs: 1000 });
    w3.t += 600000; w3.check();
    assert.match(w3.account().状态, /待核/);
    assert.equal(w3.calls.length, 1);
  } finally { w3.done(); }
});

test('两次检查撞在一起（锁已存在）→ 第二次直接结束；锁比两倍时限还老 → 不抢，每天最多一句“待核”', () => {
  const w = world({ start: '2026-11-10T23:01:00' });
  try {
    mkdirSync(join(w.dataRoot, '运行记录', '补跑'), { recursive: true });
    const lock = join(w.dataRoot, '运行记录', '补跑', '.lock');
    writeFileSync(lock, '{}');
    assert.deepEqual(w.check(), []);
    assert.equal(w.calls.length, 0);
    const old = new Date(w.t - 3600000);
    utimesSync(lock, old, old);
    assert.deepEqual(w.check(), ['补跑检查卡住，待核（锁文件比时限的两倍还老，没有抢锁）']);
    assert.deepEqual(w.check(), [], '同一天不重复说');
    assert.equal(existsSync(lock), true, '没删别人的锁');
    assert.equal(w.calls.length, 0);
  } finally { w.done(); }
});

test('正常结束删锁；中途出错也删锁', () => {
  const w = world({ start: '2026-11-10T22:00:00' });
  try {
    w.check();
    assert.equal(existsSync(join(w.dataRoot, '运行记录', '补跑', '.lock')), false);
    w.deps.listJobs = () => { throw new Error('官方命令挂了'); };
    assert.throws(() => w.check(), /官方命令挂了/);
    assert.equal(existsSync(join(w.dataRoot, '运行记录', '补跑', '.lock')), false);
  } finally { w.done(); }
});

test('补跑自己被额度拒绝不当新的一轮失败；别的原因（余额、会话过多、网络）不认作额度未恢复，按别的原因失败、不再试', () => {
  for (const [label, entry, expectReason] of [
    ['余额不足', { status: 'error', error: 'billing_error: balance too low', errorReason: 'billing' }, /billing_error: balance too low|billing/],
    ['会话过多', { status: 'error', error: 'too many CLI sessions', errorReason: 'rate_limit' }, /too many CLI sessions|rate_limit/],
    ['网络', { status: 'error', error: 'ECONNRESET', errorReason: 'network' }, /ECONNRESET|network/],
  ]) {
    const w = world({ start: '2026-11-10T23:01:00' });
    try {
      w.check();
      w.finishLaunched(entry);
      w.t += 600000;
      const out = w.check();
      assert.match(w.account().状态, /^补跑失败（/, label);
      assert.match(w.account().状态, expectReason, label);
      assert.equal(out.length, 1, label);
      for (let i = 0; i < 4; i += 1) { w.t += 1800000; w.check(); }
      assert.equal(w.calls.length, 1, `${label}：不再试`);
    } finally { w.done(); }
  }
  // 一开始的失败不是额度句（只是 rate_limit 候选）→ 根本不补
  const w = world({ start: '2026-11-10T23:01:00', error: 'too many requests' });
  try { w.check(); assert.equal(w.calls.length, 0); } finally { w.done(); }
});

test('排队跨过下一轮：不把下一轮的成果记成旧轮补跑成功，查不清归属记“补跑结果待核”', () => {
  const w = world({ start: '2026-11-10T23:01:00' });
  try {
    w.launchBehavior = 'queued';
    w.check();
    // 补跑请求排到第二天 18:05 之后才真正开始
    const late = BR('2026-11-11T18:05:10');
    w.runs[JOB].push({ ts: late + 100000, action: 'finished', status: 'ok', runId: w.lastLaunched, runAtMs: late, durationMs: 100000 });
    w.markRoundDone();
    w.t = BR('2026-11-11T18:20:00');
    const out = w.check();
    assert.match(w.account().状态, /补跑结果待核/);
    assert.match(out[0], /查不清这条运行属于哪一轮/);
    assert.equal(w.calls.length, 1);
  } finally { w.done(); }
});

test('跨业务日期：旧日期的“已发起”账在新日期的检查里照样被核、收尾、通知一次', () => {
  const w = world({ start: '2026-11-10T23:01:00' });
  try {
    w.check();
    w.finishLaunched();
    w.markRoundDone();
    w.t = BR('2026-11-11T09:00:00');
    assert.deepEqual(w.check(), ['已补跑：日审（2026-11-10）']);
  } finally { w.done(); }
});

test('已补跑要本轮记录和发送凭据都核过：巡查缺发送凭据 → 补跑结果待核', () => {
  const w = world({ name: '巡查', schedule: { ...SCHEDULE, expr: '30 18 * * *' }, start: '2026-11-10T23:01:00', failAt: '2026-11-10T18:30:00' });
  try {
    w.jobs[0].state.nextRunAtMs = BR('2026-11-11T18:30:00');
    w.check();
    w.finishLaunched();
    w.markRoundDone('巡查', '2026-11-10', false);
    w.t += 600000;
    const out = w.check();
    assert.match(w.account('2026-11-10', '巡查').状态, /补跑结果待核/);
    assert.match(out[0], /本轮记录或发送凭据没核过/);
    assert.equal(roundDone({ round: (t, d) => join(w.dataRoot, '审计', TASKS[t].目录, `${d}.json`), credential: (t, d) => join(w.dataRoot, '审计', '发布', '凭据', `${t}-${d}.json`), receipt: (t, d) => join(w.dataRoot, '审计', '发布', '凭据', `${t}-${d}.回执.txt`) }, '巡查', '2026-11-10'), false);
    w.markRoundDone('巡查', '2026-11-10', true);
    assert.equal(roundDone({ round: (t, d) => join(w.dataRoot, '审计', TASKS[t].目录, `${d}.json`), credential: (t, d) => join(w.dataRoot, '审计', '发布', '凭据', `${t}-${d}.json`), receipt: (t, d) => join(w.dataRoot, '审计', '发布', '凭据', `${t}-${d}.回执.txt`) }, '巡查', '2026-11-10'), true);
  } finally { w.done(); }
});

test('只补那四个任务：别的任务（Dreaming 等）额度失败不补；名字重复不发起', () => {
  const w = world({ name: 'Memory Dreaming Promotion', start: '2026-11-10T23:01:00' });
  try { w.check(); assert.equal(w.calls.length, 0); } finally { w.done(); }
  const w2 = world({ start: '2026-11-10T23:01:00' });
  try {
    w2.jobs.push({ ...w2.jobs[0], id: 'dup-id' });
    w2.check();
    assert.equal(w2.calls.length, 0);
  } finally { w2.done(); }
  assert.deepEqual(Object.keys(TASKS), ['日审', '巡查', '异常深审', '周审']);
});

test('CodexBar 只当推迟的参考：新鲜、用光、重置在将来 → 推迟且不算一次试；读不到、过旧、没用光、缺字段 → 不影响发起', () => {
  const reading = (over = {}, extra = {}) => [{ usage: { updatedAt: new Date(BR('2026-11-10T23:00:00')).toISOString(), primary: { usedPercent: 100, windowMinutes: 300, resetsAt: new Date(BR('2026-11-11T00:30:00')).toISOString() }, secondary: { usedPercent: 40, resetsAt: new Date(BR('2026-11-15T00:00:00')).toISOString() }, extraRateWindows: [{ id: 'claude-weekly-scoped-fable', window: { usedPercent: 100, resetsAt: new Date(BR('2026-11-15T00:00:00')).toISOString() } }], ...over }, ...extra }];
  const w = world({ start: '2026-11-10T23:05:00' });
  try {
    w.codex = reading();
    w.check();
    assert.equal(w.calls.length, 0, '参考读数显示 5 小时窗口用光 → 推迟');
    assert.equal(existsSync(join(w.dataRoot, '运行记录', '补跑', '日审-2026-11-10.json')), false, '不算一次试');
    w.codex = reading({ primary: { usedPercent: 60, resetsAt: new Date(BR('2026-11-11T00:30:00')).toISOString() } });
    w.check(); assert.equal(w.calls.length, 1, '没用光不影响');
  } finally { w.done(); }
  const now = () => BR('2026-11-10T23:05:00');
  assert.equal(windowResetAt(null, 'sonnet', '', now), null);
  assert.equal(windowResetAt(reading({ updatedAt: new Date(BR('2026-11-10T22:00:00')).toISOString() }), 'sonnet', '', now), null, '超过 10 分钟');
  assert.equal(windowResetAt(reading({ updatedAt: new Date(BR('2026-11-10T23:30:00')).toISOString() }), 'sonnet', '', now), null, '比现在超前太多');
  assert.equal(windowResetAt(reading({ updatedAt: undefined }), 'sonnet', '', now), null);
  assert.equal(windowResetAt(reading({ extraRateWindows: [] }), 'claude-fable-5-2', '', now), null, '缺 Fable 窗口字段');
  assert.equal(windowResetAt(reading(), 'claude-fable-5-2', '', now), BR('2026-11-15T00:00:00'), 'Fable 窗口');
  assert.equal(windowResetAt(reading(), 'sonnet', "You've hit your weekly limit", now), null, '周窗口没用光');
  assert.equal(windowResetAt(reading({ primary: { usedPercent: 100, resetsAt: new Date(BR('2026-11-10T22:00:00')).toISOString() } }), 'sonnet', '', now), null, '重置已过');
});

test('没有任何恢复时间信息 → 失败时间＋5 小时；CodexBar 的重置时间排在它前面', () => {
  const w = world({ start: '2026-11-10T23:01:00', error: "You've hit your 5-hour limit" });
  try {
    w.check(); assert.equal(w.calls.length, 0, '18:06＋5 小时＝23:06 才到');
    w.t = BR('2026-11-10T23:07:00'); w.check(); assert.equal(w.calls.length, 1);
  } finally { w.done(); }
});

test('通知文字限四种：已补跑／已跳过／补跑失败／待核（含补跑结果待核）', () => {
  const w = world({ start: '2026-11-10T23:01:00' });
  try {
    w.check(); w.finishLaunched(); w.markRoundDone(); w.t += 600000;
    for (const line of w.check()) assert.match(line, /^(已补跑|已跳过|补跑失败|补跑待核|补跑结果待核)：/);
  } finally { w.done(); }
});

test('parseRunId：JSON、文字里的编号、没有', () => {
  assert.equal(parseRunId(JSON.stringify({ ok: true, run: { id: `cron:${JOB}:123:slot-x` } }), JOB), `cron:${JOB}:123:slot-x`);
  assert.equal(parseRunId(`queued cron:${JOB}:456:abc.def done`, JOB), `cron:${JOB}:456:abc.def`);
  assert.equal(parseRunId(JSON.stringify({ runId: 'other' }), JOB), 'other');
  assert.equal(parseRunId('accepted', JOB), null);
  assert.equal(parseRunId('', JOB), null);
  assert.equal(parseRunId(`cron:other-job:1:x`, JOB), null);
});

test('测试台开关：把指定运行当成额度失败（只验证记账流程，不证明真实拒绝的花费）', () => {
  const w = world({ start: '2026-11-10T23:01:00', error: 'ok-looking' });
  try {
    w.failure.status = 'ok'; // 真实情况：这次运行其实正常跑完了，测试台开关把它当成额度失败
    const bench = { 把运行当额度失败: [w.failure.runId], 假报错: QUOTA('11pm'), 间隔毫秒: 1000, 测试任务名: { 日审: '日审' } };
    w.runs[JOB] = [{ ...w.failure }];
    runCatchup({ dataRoot: w.dataRoot, deps: w.deps, bench });
    assert.equal(w.calls.length, 1);
    assert.equal(readdirSync(join(w.dataRoot, '运行记录', '补跑')).filter((n) => n.endsWith('.json')).length, 1);
  } finally { w.done(); }
});

test('第二段清理：测试台模式只处理映射过的测试任务，没映射的不按真名去查真实任务', () => {
  const w = world({ start: '2026-11-10T23:01:00', error: 'ok-looking' });
  try {
    w.failure.status = 'ok';
    w.runs[JOB] = [{ ...w.failure }];
    const logs = [];
    // 测试台里一个任务都没映射：真实的“日审”不能被查、更不能被发起
    runCatchup({ dataRoot: w.dataRoot, deps: w.deps, bench: { 把运行当额度失败: [w.failure.runId], 假报错: QUOTA('11pm'), 间隔毫秒: 1000, 测试任务名: {} }, log: (m) => logs.push(m) });
    assert.equal(w.calls.length, 0);
    assert.ok(logs.some((m) => /没有映射这个任务，跳过/.test(m)));
    // 完全没写“测试任务名”同样不处理任何真实任务
    runCatchup({ dataRoot: w.dataRoot, deps: w.deps, bench: { 间隔毫秒: 1000 } });
    assert.equal(w.calls.length, 0);
  } finally { w.done(); }
});

test('每次补跑运行的实际用量照实记：看到用量记数字，没有 usage 记“看不到用量”（不写成零）', () => {
  const w = world({ start: '2026-11-10T23:01:00' });
  try {
    w.check();
    w.finishLaunched({ status: 'error', error: QUOTA('11:50pm'), usage: { total_tokens: 1234 } });
    w.t += 600000; w.check();
    assert.deepEqual(w.account().尝试[0].实际用量, { 看到用量: true, 用量: { total_tokens: 1234 } });
    w.t = BR('2026-11-10T23:51:00'); w.check();
    w.finishLaunched();
    w.markRoundDone(); w.t += 600000; w.check();
    const u = w.account().尝试[1].实际用量;
    assert.equal(u.看到用量, false); assert.match(u.说明, /不等于零/);
  } finally { w.done(); }
});
