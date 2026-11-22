// Offline tests for api quota gate: temporary directories and fake data only; nothing touches a real deployment.
// 全部用假的官方命令、假的时钟、临时目录；不碰真实任务、不发真消息。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_NAMES, classifyFailure, cmdInit, cmdPause, cmdResume, main, paths, runTick, statusText } from '../scripts/automation/api-quota-gate.mjs';
import { parseJsonLoose } from '../scripts/automation/gap-common.mjs';

const T = (s) => Date.parse(s);
const WARN = '(node:1) [DEP_PLUGIN_SDK] DeprecationWarning: something deprecated {not json}\n(Use `node --trace-deprecation ...` to show where the warning was created)\n';
const MONEY = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';

function mk({ now = '2031-03-05T09:00:00+05:30', model = 'anthropic-api/claude-sonnet-5-5' } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'gate-'));
  const st = { clock: T(now), calls: [], sent: [], sendOk: true, failEdit: new Set(), needAgent: new Set(), listFails: false, probe: { code: 0, body: { ok: true, provider: 'anthropic-api', model: 'x', outputs: [{ text: '好' }] } }, runs: {}, out: [], warns: [] };
  const agents = { 日审: 'system-auditor', 巡查: 'main', 异常深审: 'system-auditor', 周审: 'system-auditor' };
  st.jobs = TASK_NAMES.map((n) => ({ id: `id-${n}`, name: n, enabled: true, agentId: agents[n], payload: { kind: 'agentTurn', model: n === '日审' ? model : 'anthropic-api/claude-opus-5-5' }, state: { lastRunStatus: 'ok' } }));
  const wrap = (obj) => ({ code: 0, stdout: WARN + JSON.stringify(obj, null, 1) + '\n', stderr: '' });
  const deps = {
    dataRoot, now: () => st.clock,
    run(args) {
      st.calls.push(args.join(' '));
      const [a, b] = args;
      if (a === 'cron' && b === 'list') return st.listFails ? { code: 1, stdout: '', stderr: 'boom' } : wrap({ jobs: st.jobs });
      if (a === 'cron' && b === 'get') { const j = st.jobs.find((x) => x.id === args[2]); return j ? wrap(j) : { code: 1, stdout: '', stderr: 'no' }; }
      if (a === 'cron' && b === 'edit') {
        const id = args[2]; const j = st.jobs.find((x) => x.id === id);
        if (!j || st.failEdit.has(id)) return { code: 1, stdout: '', stderr: 'denied' };
        if (st.needAgent.has(id) && !args.includes('--agent')) return { code: 1, stdout: '', stderr: 'agent required' };
        j.enabled = args.includes('--enable'); return wrap({ id, enabled: j.enabled });
      }
      if (a === 'cron' && b === 'runs') return wrap({ entries: st.runs[args[2]] ?? [] });
      if (a === 'infer') return st.probe.code === 0 ? wrap(st.probe.body) : { code: st.probe.code, stdout: WARN + JSON.stringify(st.probe.body), stderr: st.probe.stderr ?? '' };
      throw new Error(`没料到的命令：${args.join(' ')}`);
    },
    async send(text) { st.sent.push(text); return st.sendOk ? { ok: true, id: String(st.sent.length) } : { ok: false, error: '假失败' }; },
    warn: (m) => st.warns.push(m), out: (m) => st.out.push(m),
  };
  const state = () => JSON.parse(readFileSync(paths(dataRoot).state, 'utf8'));
  const enabled = () => Object.fromEntries(st.jobs.map((j) => [j.name, j.enabled]));
  const tick = () => runTick(deps);
  const at = (s) => { st.clock = T(s); };
  const infers = () => st.calls.filter((c) => c.startsWith('infer')).length;
  return { st, deps, state, enabled, tick, at, dataRoot, infers };
}
async function ready(opts = {}, expiry = '2031-03-06') { const e = mk(opts); assert.equal(await cmdInit(e.deps, expiry), 0); return e; }

test('classifyFailure：钱用完的说法认，临时故障不认', () => {
  assert.equal(classifyFailure(MONEY), '用完');
  assert.equal(classifyFailure('Insufficient credits. 余额不足'), '用完');
  assert.equal(classifyFailure('429 rate limit exceeded, see billing'), '其他');
  assert.equal(classifyFailure('API overloaded (529)'), '其他');
  assert.equal(classifyFailure('请求太快了'), '其他');
  assert.equal(classifyFailure('ECONNRESET network error'), '其他');
  assert.equal(classifyFailure(''), '其他');
});

test('解析：JSON 前面夹警告行（里面还带花括号）也能解析', () => {
  assert.deepEqual(parseJsonLoose(`${WARN}{"a": 1}\n`), { a: 1 });
  assert.deepEqual(parseJsonLoose('{"a":2}'), { a: 2 });
  assert.throws(() => parseJsonLoose('只有警告'));
});

test('--init：按名字查任务编号；名字对不上就不建', async () => {
  const e = mk();
  assert.equal(await cmdInit(e.deps, '2031-03-06'), 0);
  const s = e.state();
  assert.equal(s.当期到期, '2031-03-06T07:00:00+05:30');
  assert.equal(s.任务编号.日审, 'id-日审');
  assert.equal(await cmdInit(e.deps, '2031-03-06'), 1, '已有不覆盖');
  const e2 = mk(); e2.st.jobs.push({ ...e2.st.jobs[0], id: 'dup' });
  assert.equal(await cmdInit(e2.deps, '2031-03-06'), 1, '重名不建');
  assert.equal(existsSync(paths(e2.dataRoot).state), false);
  assert.equal(await cmdInit(mk().deps, '12月6日'), 2, '日期格式不对');
});

test('到期前不暂停；刚过 07:00 暂停四个、记区间、发一条；再跑不重复', async () => {
  const e = await ready({ now: '2031-03-06T06:30:00+05:30' });
  await e.tick();
  assert.deepEqual(Object.values(e.enabled()), [true, true, true, true]);
  assert.equal(e.st.sent.length, 0);
  e.at('2031-03-06T07:01:00+05:30'); await e.tick();
  assert.deepEqual(Object.values(e.enabled()), [false, false, false, false]);
  const s = e.state();
  assert.equal(s.状态, '已暂停'); assert.equal(s.暂停原因, '到期'); assert.equal(s.暂停区间.length, 1); assert.equal(s.暂停区间[0].结束, null);
  assert.equal(e.st.sent.length, 1); assert.match(e.st.sent[0], /已暂停日审、巡查、异常深审、周审/); assert.match(e.st.sent[0], /命令抽查和文件对账也会一起停/);
  e.at('2031-03-06T07:31:00+05:30'); await e.tick();
  assert.equal(e.st.sent.length, 1, '不重复发');
});

test('只停成功一部分：先不记已暂停；“没停成”只提示一次；下一轮补齐；连 3 轮不行提示请人看', async () => {
  const e = await ready({ now: '2031-03-06T07:01:00+05:30' });
  e.st.failEdit.add('id-周审');
  await e.tick();
  let s = e.state();
  assert.equal(s.状态, '正常'); assert.equal(s.待补动作, '停用');
  assert.equal(e.st.sent.length, 1); assert.match(e.st.sent[0], /周审 1 个没停成/);
  e.at('2031-03-06T07:31:00+05:30'); await e.tick();
  assert.equal(e.st.sent.length, 1, '第 2 轮不再发“没停成”');
  e.at('2031-03-06T08:01:00+05:30'); await e.tick();
  assert.equal(e.st.sent.length, 2); assert.match(e.st.sent[1], /请人看/);
  e.at('2031-03-06T08:31:00+05:30'); await e.tick();
  assert.equal(e.st.sent.length, 2, '“请人看”只发一次');
  e.st.failEdit.clear();
  e.at('2031-03-06T09:01:00+05:30'); await e.tick();
  s = e.state();
  assert.equal(s.状态, '已暂停'); assert.equal(s.待补动作, null); assert.deepEqual(Object.values(e.enabled()), [false, false, false, false]);
  assert.equal(e.st.sent.length, 3); assert.match(e.st.sent[2], /已暂停日审/);
});

test('官方命令要求带 --agent 时，第二次带上 agent 重试并读回确认', async () => {
  const e = await ready({ now: '2031-03-06T07:01:00+05:30' });
  e.st.needAgent.add('id-日审');
  await e.tick();
  assert.equal(e.state().状态, '已暂停');
  assert.ok(e.st.calls.some((c) => c.includes('edit id-日审 --disable --agent system-auditor')));
});

test('钱用完的报错 → 暂停（原因＝用完）并记原文；限流／过载 → 不暂停', async () => {
  const e = await ready({ now: '2031-03-05T12:00:00+05:30' });
  e.st.jobs[0].state.lastRunStatus = 'error';
  e.st.runs['id-日审'] = [{ action: 'finished', status: 'error', error: '529 overloaded, rate limit', ts: T('2031-03-05T11:00:00+05:30') }];
  await e.tick();
  assert.equal(e.state().状态, '正常', '临时故障不暂停');
  e.st.runs['id-日审'] = [{ action: 'finished', status: 'error', error: MONEY, ts: T('2031-03-05T11:00:00+05:30') }];
  e.at('2031-03-05T12:30:00+05:30'); await e.tick();
  const s = e.state();
  assert.equal(s.状态, '已暂停'); assert.equal(s.暂停原因, '用完'); assert.match(s.暂停原文, /credit balance/);
  assert.match(e.st.sent[0], /用完了/);
});

test('恢复后 30 分钟内不被旧失败误停（只认晚于上次恢复时间的失败）', async () => {
  const e = await ready({ now: '2031-03-05T12:00:00+05:30' });
  await cmdPause(e.deps);
  e.st.out.length = 0;
  e.st.jobs[0].state.lastRunStatus = 'error';
  e.st.runs['id-日审'] = [{ action: 'finished', status: 'error', error: MONEY, ts: T('2031-03-05T11:00:00+05:30') }];
  e.at('2031-03-05T12:20:00+05:30');
  assert.equal(await cmdResume(e.deps, '2031-04-06'), 0);
  e.at('2031-03-05T12:50:00+05:30'); await e.tick();
  assert.equal(e.state().状态, '正常', '旧失败不再触发');
  assert.deepEqual(Object.values(e.enabled()), [true, true, true, true]);
  // 恢复之后的新失败仍然认
  e.st.runs['id-日审'] = [{ action: 'finished', status: 'error', error: MONEY, ts: T('2031-03-05T12:40:00+05:30') }];
  e.at('2031-03-05T13:20:00+05:30'); await e.tick();
  assert.equal(e.state().状态, '已暂停');
});

test('试探：正常状态 17:30 前不试；失败（非钱）隔 30 分钟再试一次，之后当天不再试；成功后当天不再试', async () => {
  const e = await ready({ now: '2031-03-05T17:00:00+05:30' });
  await e.tick(); assert.equal(e.infers(), 0);
  e.st.probe = { code: 1, body: { ok: false, error: { type: 'cli_error', message: 'Unknown model: x' } } };
  e.at('2031-03-05T17:35:00+05:30'); await e.tick(); assert.equal(e.infers(), 1);
  e.at('2031-03-05T17:50:00+05:30'); await e.tick(); assert.equal(e.infers(), 1, '没满 30 分钟');
  e.at('2031-03-05T18:06:00+05:30'); await e.tick(); assert.equal(e.infers(), 2);
  e.at('2031-03-05T19:00:00+05:30'); await e.tick(); assert.equal(e.infers(), 2, '当天最多 2 次');
  assert.equal(e.state().状态, '正常', '非钱的失败不暂停');
  assert.match(e.state().试探记录.上次原文, /Unknown model/);
  const f = await ready({ now: '2031-03-05T17:35:00+05:30' });
  await f.tick(); f.at('2031-03-05T18:07:00+05:30'); await f.tick();
  assert.equal(f.infers(), 1, '成功后当天不再试');
});

test('试探被拒且是“钱用完” → 暂停；试探用的型号从任务现行设置读，换了就跟着换', async () => {
  const e = await ready({ now: '2031-03-05T17:35:00+05:30', model: 'anthropic-api/claude-sonnet-9-9' });
  e.st.probe = { code: 1, body: { ok: false, error: { type: 'cli_error', message: MONEY } } };
  await e.tick();
  assert.ok(e.st.calls.some((c) => c.includes('--model anthropic-api/claude-sonnet-9-9')), '用了现行型号');
  assert.equal(e.state().状态, '已暂停'); assert.equal(e.state().暂停原因, '用完');
  const src = readFileSync(fileURLToPath(new URL('../scripts/automation/api-quota-gate.mjs', import.meta.url)), 'utf8');
  assert.equal(/claude-(sonnet|opus|haiku|fable)-\d/.test(src), false, '代码里不能写死模型版本号');
});

test('已暂停：每 3 小时试一次、每天最多 8 次；成功且走 anthropic-api → 自动恢复四个任务', async () => {
  const e = await ready({ now: '2031-03-06T07:01:00+05:30' });
  await e.tick(); assert.equal(e.state().状态, '已暂停');
  e.st.probe = { code: 1, body: { ok: false, error: { message: MONEY } } };
  e.at('2031-03-06T08:00:00+05:30'); await e.tick(); assert.equal(e.infers(), 0, '暂停不到 3 小时不试');
  e.at('2031-03-06T10:05:00+05:30'); await e.tick(); assert.equal(e.infers(), 1);
  e.at('2031-03-06T11:00:00+05:30'); await e.tick(); assert.equal(e.infers(), 1);
  e.at('2031-03-06T13:07:00+05:30'); await e.tick(); assert.equal(e.infers(), 2);
  assert.equal(e.state().状态, '已暂停');
  e.st.probe = { code: 0, body: { ok: true, provider: 'anthropic-api', outputs: [{ text: '好' }] } };
  e.at('2031-03-06T16:15:00+05:30'); await e.tick();
  const s = e.state();
  assert.equal(s.状态, '正常'); assert.equal(s.当期到期, null); assert.ok(s.上次恢复时间); assert.ok(s.暂停区间[0].结束);
  assert.deepEqual(Object.values(e.enabled()), [true, true, true, true]);
  assert.equal(s.简史.length, 2);
  assert.match(e.st.sent.at(-1), /额度回来了/); assert.match(e.st.sent.at(-1), /新一期的到期日/);
});

test('试探成功但提供商不是 anthropic-api（走了订阅）→ 不算数，不恢复', async () => {
  const e = await ready({ now: '2031-03-06T07:01:00+05:30' });
  await e.tick();
  e.st.probe = { code: 0, body: { ok: true, provider: 'anthropic', outputs: [{ text: '好' }] } };
  e.at('2031-03-06T10:05:00+05:30'); await e.tick();
  assert.equal(e.state().状态, '已暂停'); assert.equal(e.state().试探记录.上次结果, '通道不对');
  e.st.probe = { code: 0, body: { ok: true, outputs: [{ text: '好' }] } }; // 没有 provider 字段也不算
  e.at('2031-03-06T13:07:00+05:30'); await e.tick();
  assert.equal(e.state().状态, '已暂停');
});

test('每天最多试探 8 次（暂停状态）', async () => {
  const e = await ready({ now: '2031-03-06T07:01:00+05:30' });
  await e.tick();
  e.st.probe = { code: 1, body: { ok: false, error: { message: 'boom' } } };
  // 10:01 暂停后，每 3 小时一次，当天只剩 13:05、16:10、19:15、22:20 这几个点，造一个满额的状态再验上限
  const s = e.state(); s.试探记录.今天 = { 日期: '2031-03-06', 次数: 8, 成功: false }; s.试探记录.上次时间 = '2031-03-06T03:00:00+05:30';
  writeFileSync(paths(e.dataRoot).state, JSON.stringify(s));
  e.at('2031-03-06T19:30:00+05:30'); await e.tick();
  assert.equal(e.infers(), 0);
});

test('发消息：回执失败不记已发，下一轮重发；成功后不再重复；连失败 5 次放弃', async () => {
  const e = await ready({ now: '2031-03-06T07:01:00+05:30' });
  e.st.sendOk = false;
  await e.tick();
  assert.equal(e.state().待发通知.length, 1); assert.equal(e.state().状态, '已暂停');
  e.st.sendOk = true; e.at('2031-03-06T07:31:00+05:30'); await e.tick();
  assert.equal(e.state().待发通知.length, 0);
  const count = e.st.sent.length;
  e.at('2031-03-06T08:01:00+05:30'); await e.tick();
  assert.equal(e.st.sent.length, count, '成功后不重复');
  const f = await ready({ now: '2031-03-06T07:01:00+05:30' });
  f.st.sendOk = false;
  for (let i = 0; i < 6; i++) { await f.tick(); f.at(new Date(f.st.clock + 30 * 60000).toISOString()); }
  assert.equal(f.state().待发通知.length, 0, '连失败 5 次后放弃');
  assert.ok(f.st.warns.some((w) => /放弃/.test(w)));
});

test('状态文件缺／坏／缺任务编号；官方命令（cron list）失败 → 不乱停任务，只报一句', async () => {
  const e = mk({ now: '2031-03-06T07:01:00+05:30' });
  await e.tick(); assert.deepEqual(Object.values(e.enabled()), [true, true, true, true]); assert.ok(e.st.warns.some((w) => /没预置/.test(w)));
  mkdirSync(paths(e.dataRoot).dir, { recursive: true });
  writeFileSync(paths(e.dataRoot).state, JSON.stringify({ 状态: '正常', 当期到期: '2031-03-06T07:00:00+05:30', 任务编号: { 日审: 'x' } }));
  await e.tick(); assert.deepEqual(Object.values(e.enabled()), [true, true, true, true]); assert.ok(e.st.warns.some((w) => /任务编号里缺/.test(w)));
  const f = await ready({ now: '2031-03-06T07:01:00+05:30' });
  f.st.listFails = true; await f.tick();
  assert.deepEqual(Object.values(f.enabled()), [true, true, true, true]); assert.equal(f.state().状态, '正常');
  assert.ok(f.st.warns.some((w) => /cron list 失败/.test(w)));
});

test('--resume：日期格式不对／已过去 → 拒绝；暂停中恢复→启用四个、改到期日；不带日期＝到期日未知；暂停前就被人停着的不替人打开', async () => {
  const e = await ready({ now: '2031-03-06T07:01:00+05:30' });
  assert.equal(await cmdResume(e.deps, '12月6日'), 2);
  assert.equal(await cmdResume(e.deps, '2026-02-30'), 2);
  assert.equal(await cmdResume(e.deps, '2031-03-01'), 2, '过去的日期拒绝');
  e.st.jobs.find((j) => j.name === '周审').enabled = false; // 人手停的
  await e.tick(); // 到期暂停（周审本来就停着）
  assert.deepEqual(e.state().暂停前已停用, ['周审']);
  assert.equal(await cmdResume(e.deps, '2031-04-06'), 0);
  const s = e.state();
  assert.equal(s.状态, '正常'); assert.equal(s.当期到期, '2031-04-06T07:00:00+05:30');
  assert.deepEqual(e.enabled(), { 日审: true, 巡查: true, 异常深审: true, 周审: false });
  assert.equal(await cmdPause(e.deps), 0); assert.equal(await cmdResume(e.deps, undefined), 0);
  assert.equal(e.state().当期到期, null);
});

test('--resume：正常运行时只改到期日；有任务没启用成 → 记下待补，定时任务接着补', async () => {
  const e = await ready({ now: '2031-03-01T07:00:00+05:30' });
  assert.equal(await cmdResume(e.deps, '2031-03-20'), 0);
  assert.equal(e.state().当期到期, '2031-03-20T07:00:00+05:30'); assert.equal(e.st.sent.length, 0);
  assert.equal(await cmdPause(e.deps), 0);
  e.st.failEdit.add('id-巡查');
  assert.equal(await cmdResume(e.deps, '2031-04-06'), 1);
  assert.equal(e.state().待补动作, '启用');
  e.st.failEdit.clear(); e.at('2031-03-01T07:30:00+05:30'); await e.tick();
  assert.equal(e.state().待补动作, null); assert.equal(e.state().状态, '正常');
  assert.deepEqual(Object.values(e.enabled()), [true, true, true, true]);
});

test('加锁：锁在时本轮跳过；--status 只读不改', async () => {
  const e = await ready({ now: '2031-03-06T07:01:00+05:30' });
  const lock = join(paths(e.dataRoot).dir, '.额度闸.lock'); writeFileSync(lock, 'x'); utimesSync(lock, e.st.clock / 1000, e.st.clock / 1000); // 假时钟下让锁文件看起来是刚建的
  await e.tick(); assert.equal(e.state().状态, '正常'); assert.ok(e.st.warns.some((w) => /锁/.test(w)));
  const before = readFileSync(paths(e.dataRoot).state, 'utf8');
  e.st.out.length = 0; await main(['--status', '--data-root', e.dataRoot], e.deps);
  assert.match(e.st.out.join('\n'), /状态：正常/); assert.equal(readFileSync(paths(e.dataRoot).state, 'utf8'), before);
  assert.match(statusText(null, 0), /还没建/);
});

test('定时入口输出 NO_REPLY；除 NO_REPLY 外不往标准输出写别的', async () => {
  const e = await ready({ now: '2031-03-06T07:01:00+05:30' });
  e.st.out.length = 0; assert.equal(await main(['--data-root', e.dataRoot], e.deps), 0);
  assert.deepEqual(e.st.out, ['NO_REPLY']);
});

test('暂停那一轮中途被杀（任务停了但状态没写完），下一轮不会把“刚停的”当成“人停的”，恢复后四个都打开', async () => {
  const e = await ready({ now: '2031-03-06T07:01:00+05:30' });
  // 第一轮：停用动作开始后进程被杀——让第 3 个任务停用时抛错，且这一轮的最终写盘不会发生
  const realRun = e.deps.run; let boom = false;
  e.deps.run = (args) => { if (args[0] === 'cron' && args[1] === 'edit' && args[2] === 'id-异常深审') { boom = true; throw new Error('被杀'); } return realRun(args); };
  try { await e.tick(); } catch { /* 被杀 */ }
  // 模拟“被杀”：状态文件只剩 persist 那一次（停用前的记录）；真实被杀时 runTick 最后的写盘不会发生
  assert.ok(boom);
  const mid = e.state();
  assert.equal(mid.待补动作, '停用'); assert.equal(mid.暂停前已记, true); assert.deepEqual(mid.暂停前已停用, [], '被杀前已记下：暂停前没人停过任何任务');
  e.deps.run = realRun;
  e.at('2031-03-06T07:31:00+05:30'); await e.tick();
  assert.equal(e.state().状态, '已暂停'); assert.deepEqual(e.state().暂停前已停用, []);
  e.st.probe = { code: 0, body: { ok: true, provider: 'anthropic-api', outputs: [{ text: '好' }] } };
  e.at('2031-03-06T11:00:00+05:30'); await e.tick();
  assert.equal(e.state().状态, '正常'); assert.deepEqual(Object.values(e.enabled()), [true, true, true, true]);
});

test('手动 --pause 不被试探自动恢复，也不清空到期日；--resume 才能恢复', async () => {
  const e = await ready({ now: '2031-03-01T09:00:00+05:30' });
  assert.equal(await cmdPause(e.deps), 0);
  assert.equal(e.state().状态, '已暂停'); assert.equal(e.state().暂停原因, '手动');
  const exp = e.state().当期到期;
  for (const t of ['2031-03-01T13:00:00+05:30', '2031-03-01T17:00:00+05:30', '2031-03-02T09:00:00+05:30']) { e.at(t); await e.tick(); }
  assert.equal(e.infers(), 0, '手动暂停不试探');
  assert.equal(e.state().状态, '已暂停'); assert.equal(e.state().当期到期, exp);
  assert.deepEqual(Object.values(e.enabled()), [false, false, false, false]);
  assert.equal(await cmdResume(e.deps, '2031-03-20'), 0); await e.tick();
  assert.equal(e.state().状态, '正常'); assert.deepEqual(Object.values(e.enabled()), [true, true, true, true]);
});
