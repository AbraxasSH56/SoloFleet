// Offline tests for quota recovery: temporary directories and fake data only; nothing touches a real deployment.
// 额度失败登记模块离线测试。
// 运行：node --test tests/quota-recovery.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resetAt, isQuotaSentence, previousOccurrence, nextOccurrence, zonedTimeToUtc, createQuotaRegistry, modelFromConfig, registerQuotaRecovery,
} from '../plugins/personal-inbox/quota-recovery.mjs';

const BR = (s) => Date.parse(`${s}+05:30`); // 测试时区（UTC+5:30）时间 → 毫秒
const iso = (ms) => (ms === null ? null : new Date(ms + 5.5 * 3600000).toISOString().slice(0, 16).replace('T', ' '));
const tmp = () => mkdtempSync(join(tmpdir(), 'quota-'));

test('resets 解析：旧句、5-hour、带分钟、整点、当天已过则次日', () => {
  const ended = BR('2026-11-10T12:00:00');
  assert.equal(iso(resetAt("You've hit your session limit · resets 3:10pm (Asia/Kolkata)", ended)), '2026-11-10 15:10');
  assert.equal(iso(resetAt("You've hit your 5-hour limit · resets 3:10pm (Asia/Kolkata)", ended)), '2026-11-10 15:10');
  assert.equal(iso(resetAt("You've hit your 5-hour limit · resets 3pm (Asia/Kolkata)", ended)), '2026-11-10 15:00', '整点');
  assert.equal(iso(resetAt("You've hit your 5-hour limit · resets 11am (Asia/Kolkata)", BR('2026-11-10T12:30:00'))), '2026-11-11 11:00', '当天已过→次日');
  assert.equal(iso(resetAt("You’ve hit your 5-hour limit · resets 12am (Asia/Kolkata) · progress saved", BR('2026-11-10T23:00:00'))), '2026-11-11 00:00', '12am 是午夜，弯引号和后缀');
  assert.equal(iso(resetAt("You've hit your 5-hour limit · resets 12pm (Asia/Kolkata)", BR('2026-11-10T09:00:00'))), '2026-11-10 12:00', '12pm 是中午');
});

test('resets 解析：超过 24 小时的带日期写法，含跨年；Opus／Sonnet／Fable 限额也认', () => {
  const ended = BR('2026-11-10T12:00:00');
  assert.equal(iso(resetAt("You've hit your weekly limit · resets Nov 12, 3pm (Asia/Kolkata)", ended)), '2026-11-12 15:00');
  assert.equal(iso(resetAt("You've hit your weekly limit · resets Nov 12 at 3:10pm (Asia/Kolkata)", ended)), '2026-11-12 15:10');
  assert.equal(iso(resetAt("You've hit your weekly limit · resets Nov 15 at 1:59am (Asia/Kolkata)", ended)), '2026-11-15 01:59');
  assert.equal(iso(resetAt("You've hit your Fable limit · resets Nov 15 at 1:59am (Asia/Kolkata)", ended)), '2026-11-15 01:59');
  assert.equal(iso(resetAt("You've hit your Opus limit · resets Nov 12, 3pm (Asia/Kolkata)", ended)), '2026-11-12 15:00');
  assert.equal(iso(resetAt("You've hit your Sonnet limit · resets Nov 12, 3pm (Asia/Kolkata)", ended)), '2026-11-12 15:00');
  assert.equal(iso(resetAt("You've hit your weekly limit · resets Jan 2, 3pm (Asia/Kolkata)", BR('2026-12-30T12:00:00'))), '2027-01-02 15:00', '跨年');
});

test('resets 解析：认不出一律返回 null（登记写“未知”）', () => {
  const ended = BR('2026-11-10T12:00:00');
  for (const e of [
    "You've hit your 5-hour limit",
    "You've hit your 5-hour limit · resets soon",
    "You've hit your 5-hour limit · resets 13pm (Asia/Kolkata)",
    "You've hit your 5-hour limit · resets 0pm (Asia/Kolkata)",
    "You've hit your 5-hour limit · resets 3:75pm (Asia/Kolkata)",
    "You've hit your 5-hour limit · resets 3pm (Mars/Olympus)",
    "You've hit your 5-hour limit · resets 3pm",
    "You've hit your weekly limit · resets Feb 30, 3pm (Asia/Kolkata)",
    "You've hit your weekly limit · resets Nov 40, 3pm (Asia/Kolkata)",
    "You've hit your weekly limit · resets Nov 9, 3pm (Asia/Kolkata)",
    "You've hit your weekly limit · resets Dec 31, 3pm (Asia/Kolkata)",
    "Rate limited · resets 3pm (Asia/Kolkata)",
    "You've hit your usage credit limit · resets 3pm (Asia/Kolkata)",
    '',
  ]) assert.equal(resetAt(e, ended), null, e);
  assert.equal(resetAt("You've hit your 5-hour limit · resets 3pm (Asia/Kolkata)", NaN), null);
});

test('resets 解析：别的时区（夏令时）也按括号里的名字换算', () => {
  const ended = Date.parse('2026-07-01T00:00:00Z');
  const at = resetAt("You've hit your 5-hour limit · resets 3pm (America/New_York)", ended);
  assert.equal(new Date(at).toISOString(), '2026-07-01T19:00:00.000Z');
  const winter = resetAt("You've hit your 5-hour limit · resets 3pm (America/New_York)", Date.parse('2026-12-01T00:00:00Z'));
  assert.equal(new Date(winter).toISOString(), '2026-12-01T20:00:00.000Z');
  assert.equal(zonedTimeToUtc('America/New_York', 2026, 2, 8, 2, 30), null, '夏令时空档的时刻不存在');
});

test('额度句判断：订阅额度才算，别的限流不算', () => {
  for (const s of ["You've hit your session limit", "You've hit your 5-hour limit", "You've hit your weekly limit", "You've hit your Fable limit"]) assert.equal(isQuotaSentence(s), true, s);
  for (const s of ['Too many requests', 'rate_limit_error', "You've hit your usage credit limit", 'billing_error: balance too low', 'too many CLI sessions']) assert.equal(isQuotaSentence(s), false, s);
});

test('原定轮次：每天、每周日、周边界；下一个原定时间', () => {
  const daily = { kind: 'cron', expr: '5 18 * * *', tz: 'Asia/Kolkata' };
  assert.deepEqual(previousOccurrence(daily, BR('2026-11-10T18:07:00')), { atMs: BR('2026-11-10T18:05:00'), businessDate: '2026-11-10' });
  assert.deepEqual(previousOccurrence(daily, BR('2026-11-11T09:00:00')), { atMs: BR('2026-11-10T18:05:00'), businessDate: '2026-11-10' }, '第二天早上手动重跑仍算前一天');
  assert.equal(nextOccurrence(daily, BR('2026-11-10T18:05:00')).atMs, BR('2026-11-11T18:05:00'), '严格晚于');
  const weekly = { kind: 'cron', expr: '0 11 * * 0', tz: 'Asia/Kolkata' };
  assert.equal(previousOccurrence(weekly, BR('2026-11-15T11:00:00')).businessDate, '2026-11-15');
  assert.equal(previousOccurrence(weekly, BR('2026-11-17T09:00:00')).businessDate, '2026-11-15');
  assert.equal(nextOccurrence(weekly, BR('2026-11-15T11:00:00')).businessDate, '2026-11-22');
  for (const bad of [null, undefined, { kind: 'every', everyMs: 1000 }, { kind: 'cron', expr: '*/5 * * * *' }, { kind: 'cron', expr: '5 18 1 * *' }, { kind: 'cron', expr: 'x', tz: 'Asia/Kolkata' }, { kind: 'cron', expr: '5 18 * * *', tz: 'Mars/X' }]) {
    assert.equal(previousOccurrence(bad, Date.now()), null);
    assert.equal(nextOccurrence(bad, Date.now()), null);
  }
});

function fixture() {
  const dataRoot = tmp();
  const models = { 'system-auditor': 'anthropic/claude-sonnet-5-5', main: 'anthropic/claude-opus-5-5', gpt: 'openai/gpt-x' };
  let t = BR('2026-11-10T18:10:00');
  const registry = createQuotaRegistry({ dataRoot, modelFor: (id) => models[id], now: () => t });
  return { dataRoot, registry, clock: (v) => { t = v; }, done: () => rmSync(dataRoot, { recursive: true, force: true }) };
}
const lifecycle = (over = {}) => ({
  runId: 'run-1', agentId: 'system-auditor', stream: 'lifecycle', sessionKey: 'agent:system-auditor:cron:00000000-0000-4000-8000-000000000001:run:abc', ts: BR('2026-11-10T18:06:00'),
  data: { phase: 'error', error: "You've hit your 5-hour limit · resets 11pm (Asia/Kolkata)", startedAt: BR('2026-11-10T18:05:00'), endedAt: BR('2026-11-10T18:06:00'), executionSettled: true }, ...over,
});

test('登记：定时任务因额度句结束 → 一份登记，字段齐全；没登记别的', () => {
  const f = fixture();
  try {
    const rec = f.registry.observe(lifecycle());
    assert.equal(rec.运行编号, 'run-1');
    assert.equal(rec.角色, 'system-auditor');
    assert.equal(rec.是定时任务, true);
    assert.equal(rec.任务编号, '00000000-0000-4000-8000-000000000001');
    assert.equal(rec.型号, 'anthropic/claude-sonnet-5-5');
    assert.equal(rec.开始时间毫秒, BR('2026-11-10T18:05:00'));
    assert.equal(rec.失败时间毫秒, BR('2026-11-10T18:06:00'));
    assert.equal(rec.恢复时间毫秒, BR('2026-11-10T23:00:00'));
    assert.match(rec.报错前200字, /5-hour limit/);
    const onDisk = JSON.parse(readFileSync(join(f.dataRoot, '运行记录', '额度', 'run-1.json'), 'utf8'));
    assert.deepEqual(onDisk, rec);
    const chat = f.registry.observe(lifecycle({ runId: 'run-2', agentId: 'main', sessionKey: 'agent:main:discord:channel:1' }));
    assert.equal(chat.是定时任务, false); assert.equal(chat.任务编号, null);
    const unknown = f.registry.observe(lifecycle({ runId: 'run-3', data: { ...lifecycle().data, error: "You've hit your 5-hour limit" } }));
    assert.equal(unknown.恢复时间, '未知'); assert.equal(unknown.恢复时间毫秒, null);
    assert.equal(f.registry.observe(lifecycle({ runId: 'run-4', agentId: 'gpt' })), null);
    assert.equal(f.registry.observe(lifecycle({ runId: 'run-5', data: { ...lifecycle().data, error: 'network down' } })), null);
    assert.equal(f.registry.observe(lifecycle({ runId: 'run-6', data: { ...lifecycle().data, phase: 'start' } })), null);
    assert.notEqual(f.registry.observe({ runId: 'run-7', agentId: 'system-auditor', stream: 'lifecycle', data: { phase: 'error', error: "You've hit your 5-hour limit" } }), null);
    assert.deepEqual(readdirSync(join(f.dataRoot, '运行记录', '额度')).filter((n) => n.endsWith('.json')).sort(), ['run-1.json', 'run-2.json', 'run-3.json', 'run-7.json']);
  } finally { f.done(); }
});

test('登记：同名已存在不重写；先未确认终态、后确认，只补这一处', () => {
  const f = fixture();
  try {
    f.registry.observe(lifecycle());
    f.clock(BR('2026-11-10T19:00:00'));
    f.registry.observe(lifecycle({ data: { ...lifecycle().data, error: "You've hit your 5-hour limit · resets 9pm (Asia/Kolkata)" } }));
    const p = join(f.dataRoot, '运行记录', '额度', 'run-1.json');
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).恢复时间毫秒, BR('2026-11-10T23:00:00'), '已存在，不重写');
  } finally { f.done(); }
  const f2 = fixture();
  try {
    f2.registry.observe(lifecycle({ data: { ...lifecycle().data, executionSettled: false } }));
    const p2 = join(f2.dataRoot, '运行记录', '额度', 'run-1.json');
    assert.equal(JSON.parse(readFileSync(p2, 'utf8')).终态已确认, false);
    f2.clock(BR('2026-11-10T18:30:00'));
    f2.registry.observe(lifecycle());
    const after = JSON.parse(readFileSync(p2, 'utf8'));
    assert.equal(after.终态已确认, true);
    assert.equal(after.登记时间毫秒, BR('2026-11-10T18:10:00'), '登记时间保留第一次的');
  } finally { f2.done(); }
});

test('登记：把中途的工具动作带上', () => {
  const f = fixture();
  try {
    f.registry.observe({ runId: 'run-1', agentId: 'system-auditor', stream: 'tool', seq: 1, data: { phase: 'start', name: 'exec', toolCallId: 'c1' } });
    const rec = f.registry.observe(lifecycle());
    assert.equal(rec.已做的工具动作.length, 1);
    assert.equal(rec.已做的工具动作[0].name, 'exec');
  } finally { f.done(); }
});

const started = (over = {}) => ({
  jobId: '00000000-0000-4000-8000-000000000001', action: 'started', runAtMs: BR('2026-11-10T18:05:00.013'),
  job: { id: '00000000-0000-4000-8000-000000000001', name: '日审', enabled: true, schedule: { kind: 'cron', expr: '5 18 * * *', tz: 'Asia/Kolkata', staggerMs: 0 }, state: { nextRunAtMs: BR('2026-11-10T18:05:00'), runningAtMs: null } }, ...over,
});

test('计划存档：四个审计任务每次开始都存一份，带事件自带的完整计划和原定轮次', () => {
  const f = fixture();
  try {
    const rec = f.registry.cronChanged(started());
    const p = join(f.dataRoot, '运行记录', '额度', '计划存档', `00000000-0000-4000-8000-000000000001-${BR('2026-11-10T18:05:00.013')}.json`);
    const disk = JSON.parse(readFileSync(p, 'utf8'));
    assert.deepEqual(disk, rec);
    assert.deepEqual(disk.计划, { kind: 'cron', expr: '5 18 * * *', tz: 'Asia/Kolkata', staggerMs: 0 });
    assert.equal(disk.原定轮次.业务日期, '2026-11-10');
    assert.equal(disk.原定轮次.距原定时间秒, 0);
    assert.equal(disk.任务名, '日审');
  } finally { f.done(); }
});

test('计划存档：官方重试各存一份、不覆盖原定那轮；同一次开始重复送达不覆盖', () => {
  const f = fixture();
  try {
    f.registry.cronChanged(started());
    f.registry.cronChanged(started({ runAtMs: BR('2026-11-10T18:05:30'), job: { ...started().job, schedule: { kind: 'cron', expr: '5 19 * * *', tz: 'Asia/Kolkata' } } }));
    f.registry.cronChanged(started({ runAtMs: BR('2026-11-10T18:10:00') }));
    const dir = join(f.dataRoot, '运行记录', '额度', '计划存档');
    assert.equal(readdirSync(dir).filter((n) => n.endsWith('.json')).length, 3);
    f.registry.cronChanged(started({ job: { ...started().job, schedule: { kind: 'cron', expr: '0 0 * * *', tz: 'UTC' } } }));
    const p = join(dir, `00000000-0000-4000-8000-000000000001-${BR('2026-11-10T18:05:00.013')}.json`);
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).计划.expr, '5 18 * * *');
    assert.equal(readdirSync(dir).filter((n) => n.endsWith('.json')).length, 3);
    assert.equal(readdirSync(dir).filter((n) => n.includes('.tmp-')).length, 0, '没有残留的临时文件');
  } finally { f.done(); }
});

test('计划存档：只存四个审计任务；别的任务、别的动作、没有开始时间的都不存；计划缺失写“未知”', () => {
  const f = fixture();
  try {
    assert.equal(f.registry.cronChanged(started({ job: { ...started().job, name: 'Memory Dreaming Promotion' } })), null);
    assert.equal(f.registry.cronChanged(started({ action: 'finished' })), null);
    assert.equal(f.registry.cronChanged(started({ runAtMs: undefined })), null);
    assert.equal(f.registry.cronChanged(started({ job: undefined })), null);
    assert.equal(existsSync(join(f.dataRoot, '运行记录', '额度', '计划存档')), false);
    const unknown = f.registry.cronChanged(started({ job: { ...started().job, schedule: undefined } }));
    assert.equal(unknown.原定轮次, '未知');
    for (const name of ['巡查', '异常深审', '周审']) assert.ok(f.registry.cronChanged(started({ runAtMs: BR('2026-11-10T20:00:00') + name.length, job: { ...started().job, name } })), name);
  } finally { f.done(); }
});

test('模型别名按配置还原', () => {
  const cfg = { agents: { defaults: { models: { 'anthropic/claude-sonnet-5-5': { alias: 'sonnet' }, 'anthropic/claude-opus-5-5': { alias: 'opus' } } }, entries: { a: { model: 'sonnet' }, b: { model: { primary: 'anthropic/opus' } }, c: { model: 'anthropic/claude-opus-5-5' }, d: {} } } };
  assert.equal(modelFromConfig(cfg, 'a'), 'anthropic/claude-sonnet-5-5');
  assert.equal(modelFromConfig(cfg, 'b'), 'anthropic/claude-opus-5-5');
  assert.equal(modelFromConfig(cfg, 'c'), 'anthropic/claude-opus-5-5');
  assert.equal(modelFromConfig(cfg, 'd'), undefined);
});

test('接线：登记 cron_changed 钩子和服务；不再改任何定时任务；源码里没有写死的任务编号和型号', async () => {
  const dataRoot = tmp();
  try {
    const hooks = []; const services = []; const listeners = [];
    const api = { on: (name, fn, opt) => hooks.push({ name, fn, opt }), registerService: (s) => services.push(s), logger: { warn() {} }, runtime: { events: { onAgentEvent: (fn) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); } } } };
    registerQuotaRecovery(api, '/x/项目', { dataRoot });
    assert.equal(hooks.length, 1); assert.equal(hooks[0].name, 'cron_changed');
    assert.equal(services.length, 1);
    const ctx = { config: { agents: { entries: { 'system-auditor': { model: 'anthropic/claude-sonnet-5-5' } } } }, logger: { warn() {} }, getCron: () => { throw new Error('不该碰定时任务'); } };
    await services[0].start(ctx);
    listeners[0](lifecycle());
    hooks[0].fn(started());
    assert.ok(existsSync(join(dataRoot, '运行记录', '额度', 'run-1.json')));
    assert.equal(readdirSync(join(dataRoot, '运行记录', '额度', '计划存档')).length, 1);
    await services[0].stop();
    assert.equal(listeners.length, 0);
    hooks[0].fn(started({ runAtMs: 5 }));
    assert.equal(readdirSync(join(dataRoot, '运行记录', '额度', '计划存档')).length, 1, '停了以后事件不再落盘');
    const src = readFileSync(fileURLToPath(new URL('../plugins/personal-inbox/quota-recovery.mjs', import.meta.url)), 'utf8');
    for (const word of ['a4d6435a', '828ef7f0', '829aa46d', 'claude-opus-5-5', 'cron.update', 'claude-account-window-resume-job']) assert.equal(src.includes(word), false, word);
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test('第二段清理：不再读“测试台.json”分流——就算文件在，测试任务也不存档，正式资料根只存四个审计任务', async () => {
  const f = fixture();
  const bench = tmp();
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(f.dataRoot, '运行记录', '额度'), { recursive: true });
    writeFileSync(join(f.dataRoot, '运行记录', '额度', '测试台.json'), JSON.stringify({ 任务名: ['额度补跑测试'], 存档根: bench }));
    assert.equal(f.registry.cronChanged(started({ job: { ...started().job, name: '额度补跑测试' } })), null, '文件在也不存');
    assert.equal(existsSync(join(bench, '运行记录')), false, '测试台目录里没有被写东西');
    assert.equal(f.registry.cronChanged(started({ job: { ...started().job, name: '别的任务' } })), null);
    assert.ok(f.registry.cronChanged(started()), '四个审计任务照常存档');
  } finally { f.done(); rmSync(bench, { recursive: true, force: true }); }
});
