// Offline tests for quota resume: temporary directories and fake data only; nothing touches a real deployment.
// quota-resume.mjs 离线测试（假依赖，全在临时目录，不连 Discord、不花额度）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPROVAL_CHANNEL, CALL_STATES, CHAT_CHANNEL, GAP_MS, MARK, MIN, OWNER_ID, WAKE_TEXT, expireAt, launchDetached, ledgerLookup, managedByResume, paths,
  quotaLike, readyAt, summaryText, tick,
} from '../scripts/automation/quota-resume.mjs';

const T0 = Date.parse('2026-11-22T12:00:00+05:30');
const H = 3600000;
const CH1 = '100000000000000104';
const CH2 = '100000000000000105';
const CH3 = '100000000000000106';
const BOT_E = '100000000000000107'; // 执行者E
const BOT_C = '100000000000000108';

const slice = {
  defaultAccount: 'default', applicationId: '100000000000000011',
  accounts: { default: {}, 'worker-e': { name: '执行者E', enabled: true, applicationId: BOT_E }, 'task-worker-c': { name: '执行者D', enabled: true, applicationId: BOT_C } },
  bindings: [{ agentId: 'main', channel: 'discord', accountId: 'default' }, { agentId: 'worker-e', channel: 'discord', accountId: 'worker-e' }, { agentId: 'worker-c', channel: 'discord', accountId: 'task-worker-c' }],
};
function setup() {
  const dr = mkdtempSync(join(tmpdir(), 'qr-'));
  const P = paths(dr); mkdirSync(P.quotaDir, { recursive: true });
  const st = { now: T0, threads: {}, info: {}, msgs: {}, sent: [], launches: [], sendOk: true, launchResult: { ok: true }, codexbar: null, unreadable: new Set(), infoFail: new Set(), readCalls: 0 };
  const deps = {
    now: () => st.now,
    slice: () => slice,
    channelInfo: async (id) => { st.infoCalls = (st.infoCalls ?? 0) + 1; if (st.infoFail.has(id)) throw new Error('查不出'); return st.info[id] ?? { type: 11, parentId: '100000000000000109' }; },
    readMessages: async (id) => { st.readCalls += 1; if (st.unreadable.has(id)) throw new Error('读不出'); return st.msgs[id] ?? []; },
    send: async (text, ch) => { st.sent.push({ text, ch }); return st.sendOk ? { ok: true, id: '100000000000000110' } : { ok: false, error: '假失败' }; },
    launch: async (spec) => { st.launches.push({ spec, ledgerAtLaunch: existsSync(P.ledger) ? JSON.parse(readFileSync(P.ledger, 'utf8')) : null }); return st.launchResult; },
    codexbar: () => { st.cbarCalls = (st.cbarCalls ?? 0) + 1; return st.codexbar; },
  };
  return { dr, P, st, deps, run: (extra = {}) => tick({ dataRoot: dr, deps, notifyChannel: '100000000000000111', ...extra }), ledger: () => JSON.parse(readFileSync(P.ledger, 'utf8')) };
}
let seq = 0;
function reg(s, o = {}) {
  seq += 1;
  const runId = o.runId ?? `run-${seq}`;
  const fail = o.fail ?? T0 - 2 * H;
  const rec = {
    运行编号: runId, 会话键: o.key ?? `agent:worker-e:discord:channel:${CH1}`, 角色: o.role ?? 'worker-e', 是定时任务: o.cron ?? false, 任务编号: null,
    型号: o.model ?? 'anthropic/claude-opus-5', 失败时间毫秒: fail, 报错前200字: o.err ?? "You've hit your 5-hour limit · resets 2:30am (Asia/Kolkata)",
    恢复时间毫秒: o.reset === undefined ? fail + 1 * H : o.reset, 终态已确认: o.settled ?? true,
  };
  writeFileSync(join(s.P.quotaDir, `${runId}.json`), JSON.stringify(rec));
  return rec;
}
const msg = (authorId, ts, content = '好的') => ({ id: String(ts), authorId, ts, content });

test('managedByResume：定时任务、桌面角色、备用A、备用B、非频道会话键、终态未确认都不归我管', () => {
  const good = { 是定时任务: false, 角色: 'worker-e', 会话键: `agent:worker-e:discord:channel:${CH1}`, 终态已确认: true, 失败时间毫秒: 1 };
  assert.equal(managedByResume(good), true);
  assert.equal(managedByResume({ ...good, 是定时任务: true }), false);
  for (const role of ['desktop', 'standby-a', 'standby-b']) assert.equal(managedByResume({ ...good, 角色: role, 会话键: `agent:${role}:discord:channel:${CH1}` }), false);
  assert.equal(managedByResume({ ...good, 会话键: 'agent:worker-e:main' }), false);
  assert.equal(managedByResume({ ...good, 会话键: `agent:worker-f:discord:channel:${CH1}` }), false, '会话键里的角色和登记里的不一致');
  assert.equal(managedByResume({ ...good, 终态已确认: false }), false);
  assert.equal(managedByResume(null), false);
});

test('quotaLike：只认官方额度报错的样子；bot 回话里提到"上次因额度中断"不算', () => {
  assert.equal(quotaLike("You've hit your session limit · resets 3pm"), true);
  assert.equal(quotaLike("You've hit your 5-hour limit · resets 2:30am (Asia/Kolkata)"), true);
  assert.equal(quotaLike("You've hit your weekly limit · resets Nov 12, 3pm (Asia/Kolkata)"), true);
  assert.equal(quotaLike('已完成到第二步，接着做第三步'), false);
  assert.equal(quotaLike('上次因额度中断了，我读了任务记录，已完成到第二步，现在接着做第三步'), false);
  assert.equal(quotaLike('额度用完了，稍后再试'), false);
  assert.equal(quotaLike('上限和 limit 这些词我在说明里提到过，resets 也是'), false);
});

test('到点和过期：五小时限额与周限额同一口径；没有恢复时间走失败＋5 小时', () => {
  const c = { 最新失败时间毫秒: T0, 恢复时间毫秒: T0 + H };
  assert.equal(readyAt(c), T0 + H + 2 * MIN); assert.equal(expireAt(c), T0 + H + 24 * H);
  const u = { 最新失败时间毫秒: T0, 恢复时间毫秒: null };
  assert.equal(readyAt(u), T0 + 5 * H + 2 * MIN); assert.equal(expireAt(u), T0 + 29 * H);
  const weekly = { 最新失败时间毫秒: T0, 恢复时间毫秒: T0 + 3 * 24 * H };
  assert.equal(expireAt(weekly), T0 + 4 * 24 * H, '周限额按恢复时间＋24 小时，不是失败时间＋24 小时');
});

test('不归我管的登记不进账；账里没有它们', async () => {
  const s = setup(); s.st.now = T0;
  reg(s, { cron: true, runId: 'cron1' });
  reg(s, { role: 'desktop', key: `agent:desktop:discord:channel:${CH1}`, runId: 'dsk1' });
  reg(s, { role: 'standby-a', key: `agent:standby-a:discord:channel:${CH1}`, runId: 'sbA1' });
  reg(s, { key: 'agent:worker-e:main', runId: 'main1' });
  const r = await s.run();
  assert.equal(Object.keys(s.ledger().运行).length, 0); assert.equal(s.st.launches.length, 0); assert.equal(r.launched.length, 0);
});

test('还没到点：只查一次频道信息，不读线程消息、不发起', async () => {
  const s = setup(); s.st.now = T0 - 1.5 * H; // 恢复时间 = 失败+1h = T0-1h；现在比它早
  reg(s, { runId: 'a1' });
  await s.run();
  assert.equal(s.st.readCalls, 0); assert.equal(s.st.launches.length, 0);
  const L = s.ledger(); assert.equal(Object.values(L.链)[0].状态, '待发起'); assert.ok(Object.values(L.链)[0].频道检查);
  assert.equal(ledgerLookup(L, 'a1').state, '待发起');
});

test('到点：发起一次；先记账再发起；参数用对账号和线程；账文件 644；日志目录在账旁', async () => {
  const s = setup(); s.st.now = T0;
  reg(s, { runId: 'a1', role: 'worker-c', key: `agent:worker-c:discord:channel:${CH2}` });
  const r = await s.run();
  assert.equal(r.launched.length, 1);
  const { spec, ledgerAtLaunch } = s.st.launches[0];
  const a = spec.args;
  assert.deepEqual(a.slice(0, 5), ['agent', '--agent', 'worker-c', '--session-key', `agent:worker-c:discord:channel:${CH2}`]);
  assert.equal(a[a.indexOf('--reply-account') + 1], 'task-worker-c', 'worker-c 的账号是 task-worker-c');
  assert.equal(a[a.indexOf('--reply-to') + 1], `channel:${CH2}`);
  assert.ok(a.includes('--deliver'));
  assert.ok(a[a.indexOf('--message') + 1].startsWith(MARK));
  assert.ok(!JSON.stringify(a).match(/token/i));
  assert.equal(Object.values(ledgerAtLaunch.链)[0].状态, '已发起', '发起之前账里已经记了');
  assert.match(spec.日志, /a1-第1次\.log$/); assert.match(spec.退出码文件, /a1-第1次\.退出码$/);
  assert.equal((statSync(s.P.ledger).mode & 0o777).toString(8), '644');
});

test('防重复：连跑几次只叫一次；进程在"已发起"后被杀，下一轮只核对不重发', async () => {
  const s = setup(); s.st.now = T0;
  reg(s, { runId: 'a1' });
  await s.run(); await s.run(); s.st.now += 5 * MIN; await s.run();
  assert.equal(s.st.launches.length, 1);
});

test('一轮最多发起 1 个，最早失败的先来', async () => {
  const s = setup(); s.st.now = T0;
  reg(s, { runId: 'late', key: `agent:worker-e:discord:channel:${CH2}`, fail: T0 - 1.5 * H, reset: T0 - 0.5 * H });
  reg(s, { runId: 'early', key: `agent:worker-e:discord:channel:${CH1}`, fail: T0 - 3 * H, reset: T0 - 2 * H });
  await s.run();
  assert.equal(s.st.launches.length, 1); assert.match(s.st.launches[0].spec.args.join(' '), new RegExp(CH1));
  s.st.now += 10 * MIN; await s.run();
  assert.equal(s.st.launches.length, 2); assert.match(s.st.launches[1].spec.args.join(' '), new RegExp(CH2));
});

test('闲聊茶会、闲聊下的线程、审批频道不接续；线程缺上级频道编号／查不出：本轮不动，超 6 小时记读不出', async () => {
  const s = setup(); s.st.now = T0;
  reg(s, { runId: 'chat', key: `agent:worker-e:discord:channel:${CHAT_CHANNEL}` });
  reg(s, { runId: 'chatth', key: `agent:worker-e:discord:channel:${CH1}` }); s.st.info[CH1] = { type: 11, parentId: CHAT_CHANNEL };
  reg(s, { runId: 'appr', key: `agent:worker-e:discord:channel:${APPROVAL_CHANNEL}` });
  reg(s, { runId: 'nop', key: `agent:worker-e:discord:channel:${CH2}` }); s.st.info[CH2] = { type: 11, parentId: null };
  reg(s, { runId: 'fail', key: `agent:worker-e:discord:channel:${CH3}` }); s.st.infoFail.add(CH3);
  await s.run();
  const L = s.ledger();
  assert.equal(ledgerLookup(L, 'chat').state, '不接续：闲聊'); assert.equal(ledgerLookup(L, 'chatth').state, '不接续：闲聊'); assert.equal(ledgerLookup(L, 'appr').state, '不接续：审批');
  assert.equal(ledgerLookup(L, 'nop').state, '待发起'); assert.equal(ledgerLookup(L, 'fail').state, '待发起');
  assert.equal(s.st.launches.length, 0);
  s.st.now += 7 * H; // 过了 6 小时仍查不出（注意：登记也快过期了，用较晚的失败时间以免被过期抢先）
  const s2 = setup(); s2.st.now = T0; reg(s2, { runId: 'f2', key: `agent:worker-e:discord:channel:${CH3}`, fail: T0 - 1 * H, reset: T0 + 20 * H }); s2.st.infoFail.add(CH3);
  await s2.run(); s2.st.now += 6.5 * H; await s2.run();
  assert.equal(ledgerLookup(s2.ledger(), 'f2').state, '读不出');
  assert.ok(CALL_STATES.includes('读不出'));
});

test('已有人接上就不叫：主人的话、这个 bot 自己的新话；像额度句、失败之前的、别人的话不算；读不出不叫', async () => {
  const mk = async (msgs, unreadable = false) => {
    const s = setup(); s.st.now = T0; reg(s, { runId: 'a1', fail: T0 - 2 * H, reset: T0 - 1 * H });
    s.st.msgs[CH1] = msgs; if (unreadable) s.st.unreadable.add(CH1);
    await s.run(); return s;
  };
  let s = await mk([msg(OWNER_ID, T0 - 1 * H)]); assert.equal(ledgerLookup(s.ledger(), 'a1').state, '已接上'); assert.equal(s.st.launches.length, 0);
  s = await mk([msg(BOT_E, T0 - 30 * MIN, '已完成到第二步，接着做')]); assert.equal(ledgerLookup(s.ledger(), 'a1').state, '已接上');
  s = await mk([msg(BOT_E, T0 - 2 * H + 3000, "You've hit your 5-hour limit")]); assert.equal(s.st.launches.length, 1, '官方额度句不算接上');
  s = await mk([msg(BOT_E, T0 - 1 * H, "You've hit your session limit · resets 3pm (Asia/Kolkata)")]); assert.equal(s.st.launches.length, 1, '任何时间点的官方额度报错都不算接上（含 10 分钟后）');
  s = await mk([msg(BOT_E, T0 - 30 * MIN, '上次因额度中断了，我读了任务记录，已完成到第二步，接着做')]); assert.equal(ledgerLookup(s.ledger(), 'a1').state, '已接上', 'bot 回话里提到额度中断，照样算接上');
  s = await mk([msg(OWNER_ID, T0 - 3 * H)]); assert.equal(s.st.launches.length, 1, '失败之前的话不算');
  s = await mk([msg('100000000000000112', T0 - 1 * H)]); assert.equal(s.st.launches.length, 1, '别人的话不算');
  s = await mk([], true); assert.equal(s.st.launches.length, 0, '读不出来不叫'); assert.equal(ledgerLookup(s.ledger(), 'a1').state, '待发起');
});

test('串链：叫醒后又撞限，新登记并进同一条链，失败时间和恢复时间更新；第 2 次发起；叫满 2 次后不再叫', async () => {
  const s = setup(); s.st.now = T0;
  reg(s, { runId: 'r1', fail: T0 - 2 * H, reset: T0 - 1 * H });
  await s.run(); assert.equal(s.st.launches.length, 1);
  // 叫醒那次又撞限：新运行编号，失败时间在第一次发起之后
  s.st.now = T0 + 10 * MIN; reg(s, { runId: 'r2', fail: T0 + 5 * MIN, reset: T0 + 3 * H });
  await s.run();
  let L = s.ledger(); const chain = Object.values(L.链)[0];
  assert.equal(Object.keys(L.链).length, 1, '并进同一条链'); assert.deepEqual(chain.运行编号, ['r1', 'r2']);
  assert.equal(chain.最新失败时间毫秒, T0 + 5 * MIN); assert.equal(chain.恢复时间毫秒, T0 + 3 * H); assert.equal(chain.状态, '待发起');
  assert.equal(ledgerLookup(L, 'r2').found, true);
  assert.equal(s.st.launches.length, 1, '新的恢复时间没到，不叫');
  // 线程里有那句新的官方额度句，不能算接上
  s.st.msgs[CH1] = [msg(BOT_E, T0 + 5 * MIN + 2000, "You've hit your session limit")];
  s.st.now = T0 + 3 * H + 5 * MIN; await s.run();
  assert.equal(s.st.launches.length, 2);
  assert.match(s.st.launches[1].spec.日志, /r2-第2次\.log$/); assert.notEqual(s.st.launches[0].spec.退出码文件, s.st.launches[1].spec.退出码文件);
  // 第二次也又撞限 → 并入后仍是同一条链，叫满 2 次，不再叫，改请人
  s.st.now += 10 * MIN; reg(s, { runId: 'r3', fail: s.st.now - 5 * MIN, reset: s.st.now + 1 * H });
  await s.run(); s.st.now += 1 * H + 5 * MIN; await s.run();
  assert.equal(s.st.launches.length, 2);
  L = s.ledger(); assert.equal(Object.values(L.链)[0].状态, '接续没成功'); assert.ok(CALL_STATES.includes('接续没成功'));
  assert.ok(s.st.sent.some((x) => /请你在这些线程里说/.test(x.text)));
  // "已接上"才清零：之后再撞限算新链
});

test('已接上后清零：之后同一会话键再撞限，是新的一条链', async () => {
  const s = setup(); s.st.now = T0;
  reg(s, { runId: 'r1', fail: T0 - 2 * H, reset: T0 - 1 * H });
  await s.run();
  s.st.msgs[CH1] = [msg(BOT_E, T0 + 20 * MIN, '已完成到第二步')]; s.st.now = T0 + 40 * MIN; await s.run();
  assert.equal(ledgerLookup(s.ledger(), 'r1').state, '已接上');
  s.st.now = T0 + 2 * H; reg(s, { runId: 'r9', fail: T0 + 1.5 * H, reset: T0 + 1.8 * H });
  await s.run();
  const L = s.ledger(); assert.equal(Object.keys(L.链).length, 2);
  assert.equal(ledgerLookup(L, 'r9').found, true); assert.notEqual(L.运行.r9, L.运行.r1);
});

test('发起失败（退出码非 0）：第一次标待重试并不算看护要兜底的状态；≥30 分钟后第 2 次用另一套文件；第 2 次也失败 → 接续没成功', async () => {
  const s = setup(); s.st.now = T0;
  reg(s, { runId: 'r1', fail: T0 - 2 * H, reset: T0 - 1 * H });
  s.st.launchResult = { ok: false, error: '起不来', code: 127 };
  await s.run(); // 发起，记 127 退出码
  assert.equal(s.st.launches.length, 1);
  s.st.now += 10 * MIN; await s.run();
  assert.equal(ledgerLookup(s.ledger(), 'r1').state, '发起失败待重试'); assert.ok(!CALL_STATES.includes('发起失败待重试'));
  assert.equal(s.st.launches.length, 1, '间隔不到 30 分钟不重试');
  s.st.now += GAP_MS; await s.run();
  assert.equal(s.st.launches.length, 2); assert.match(s.st.launches[1].spec.退出码文件, /第2次/);
  s.st.now += 10 * MIN; await s.run();
  assert.equal(ledgerLookup(s.ledger(), 'r1').state, '接续没成功');
});

test('退出码文件按次分开：第 2 次还没写退出码时，不会读到第 1 次的非 0', async () => {
  const s = setup(); s.st.now = T0;
  reg(s, { runId: 'r1', fail: T0 - 2 * H, reset: T0 - 1 * H });
  s.st.launchResult = { ok: false, code: 3 };
  await s.run(); s.st.now += 40 * MIN; await s.run(); // 第 1 次失败 → 待重试
  s.st.launchResult = { ok: true }; // 第 2 次起来了，但还没写退出码
  s.st.now += 1 * MIN; await s.run();
  assert.equal(s.st.launches.length, 2);
  s.st.now += 5 * MIN; await s.run();
  assert.equal(ledgerLookup(s.ledger(), 'r1').state, '已发起', '第 2 次还在跑，不被第 1 次的退出码误判为失败');
});

test('发起后 30 分钟没有新消息也没有失败退出码 → 结果待核，不自动重发', async () => {
  const s = setup(); s.st.now = T0;
  reg(s, { runId: 'r1', fail: T0 - 2 * H, reset: T0 - 1 * H });
  await s.run();
  s.st.now += 31 * MIN; await s.run(); s.st.now += 2 * H; await s.run();
  assert.equal(ledgerLookup(s.ledger(), 'r1').state, '结果待核'); assert.equal(s.st.launches.length, 1);
  assert.ok(CALL_STATES.includes('结果待核'));
});

test('发起后线程里 bot 说了正常的话 → 已接上，链清零', async () => {
  const s = setup(); s.st.now = T0;
  reg(s, { runId: 'r1', fail: T0 - 2 * H, reset: T0 - 1 * H });
  await s.run();
  s.st.msgs[CH1] = [msg(BOT_E, T0 + 2 * MIN, '已完成到第二步，接着做第三步')]; s.st.now += 5 * MIN; await s.run();
  assert.equal(ledgerLookup(s.ledger(), 'r1').state, '已接上');
});

test('过期的登记不接续；CodexBar 说同一个窗口还满着就再等', async () => {
  const s = setup(); s.st.now = T0;
  reg(s, { runId: 'old', fail: T0 - 40 * H, reset: T0 - 39 * H });
  await s.run(); assert.equal(ledgerLookup(s.ledger(), 'old').state, '不接续：过期'); assert.equal(s.st.launches.length, 0);
  const s2 = setup(); s2.st.now = T0; reg(s2, { runId: 'a', fail: T0 - 2 * H, reset: T0 - 1 * H, model: 'anthropic/claude-opus-5' });
  s2.st.codexbar = [{ usage: { updatedAt: new Date(T0 - MIN).toISOString(), primary: { usedPercent: 100, resetsAt: new Date(T0 + 1 * H).toISOString() } } }];
  await s2.run(); assert.equal(s2.st.launches.length, 0);
  s2.st.codexbar = null; await s2.run(); assert.equal(s2.st.launches.length, 1);
});

test('汇总通知：这一批没有待发起的了才发；发工坊（测试里是指定频道）；没拿到回执下一轮重发；拿到后不再发', async () => {
  const s = setup(); s.st.now = T0;
  reg(s, { runId: 'a', key: `agent:worker-e:discord:channel:${CH1}`, fail: T0 - 2 * H, reset: T0 - 1 * H });
  reg(s, { runId: 'b', key: `agent:worker-e:discord:channel:${CH2}`, fail: T0 - 1.5 * H, reset: T0 - 0.5 * H });
  await s.run();
  assert.equal(s.st.sent.length, 0, '还有一件待发起，先不发汇总');
  s.st.now += 10 * MIN; s.st.sendOk = false; await s.run();
  assert.equal(s.st.sent.length, 1); assert.equal(s.st.sent[0].ch, '100000000000000111');
  assert.match(s.st.sent[0].text, /已让 2 件停在半路的活接着做/);
  s.st.now += 10 * MIN; s.st.sendOk = true; await s.run();
  assert.equal(s.st.sent.length, 2, '没拿到回执，下一轮重发');
  s.st.now += 10 * MIN; await s.run(); assert.equal(s.st.sent.length, 2, '拿到回执后不再发');
});

test('锁：别的实例在跑就这一轮什么都不做', async () => {
  const s = setup(); s.st.now = T0; reg(s, { runId: 'a', fail: T0 - 2 * H, reset: T0 - 1 * H });
  const { withLock } = await import('../scripts/automation/gap-common.mjs');
  await withLock(s.P.lock, async () => { const r = await s.run(); assert.equal(r.busy, true); });
  assert.equal(s.st.launches.length, 0);
});

test('干跑：不发起、不写账', async () => {
  const s = setup(); s.st.now = T0; reg(s, { runId: 'a', fail: T0 - 2 * H, reset: T0 - 1 * H });
  await s.run({ dryRun: true });
  assert.equal(s.st.launches.length, 0); assert.equal(existsSync(s.P.ledger), false);
});

test('汇总文字：叫醒的和没接上的分开写，带线程链接', () => {
  const t = summaryText([{ 类型: '已叫醒', 线程: CH1 }, { 类型: '没接上', 线程: CH2 }, { 类型: '读不出', 线程: CH3 }]);
  assert.match(t, new RegExp(`discord.com/channels/100000000000000002/${CH1}`)); assert.match(t, /说“继续”/); assert.match(t, new RegExp(CH3));
  assert.match(WAKE_TEXT, /不要重做已经完成的步骤/);
});

// ---------- 真实的脱离子进程：用假 openclaw 脚本走一遍 launchDetached → launchChild ----------
async function waitFor(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; }
function fakeAgent(dir, exitCode) {
  const p = join(dir, 'fake-agent'); writeFileSync(p, `#!/usr/bin/env node\nconsole.log('ARGS ' + JSON.stringify(process.argv.slice(2)));\nprocess.exit(${exitCode});\n`); chmodSync(p, 0o755); return p;
}
test('脱离子进程：日志和退出码写进按次编号的文件，权限 644，主脚本不等它', async () => {
  for (const code of [0, 3]) {
    const dir = mkdtempSync(join(tmpdir(), 'qrl-'));
    const spec = { args: ['agent', '--agent', 'worker-e', '--message', '你好'], 日志: join(dir, '日志', `r1-第1次.log`), 退出码文件: join(dir, '日志', `r1-第1次.退出码`) };
    const r = await launchDetached(spec, { ...process.env, OPENCLAW_BIN: fakeAgent(dir, code) });
    assert.equal(r.ok, true);
    assert.ok(await waitFor(() => existsSync(spec.退出码文件)), '退出码文件应出现');
    assert.equal(readFileSync(spec.退出码文件, 'utf8').trim(), String(code));
    assert.match(readFileSync(spec.日志, 'utf8'), /ARGS .*worker-e/);
    assert.equal((statSync(spec.退出码文件).mode & 0o777).toString(8), '644'); assert.equal((statSync(spec.日志).mode & 0o777).toString(8), '644');
  }
});
test('脱离子进程：官方命令起不来 → 退出码 127，日志里有原因', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qrl-'));
  const spec = { args: ['agent'], 日志: join(dir, 'x-第1次.log'), 退出码文件: join(dir, 'x-第1次.退出码') };
  await launchDetached(spec, { ...process.env, OPENCLAW_BIN: join(dir, '不存在的命令') });
  assert.ok(await waitFor(() => existsSync(spec.退出码文件)));
  assert.equal(readFileSync(spec.退出码文件, 'utf8').trim(), '127');
});


// ---------- additional cases----------
test('死链：频道信息永远查不出（比如测试频道被删）→ 到过期时间自动收掉，之后不再查，14 天后清出账', async () => {
  const s = setup(); s.st.now = T0;
  reg(s, { runId: 'dead', fail: T0 - 1 * H, reset: T0 + 1 * H }); s.st.infoFail.add(CH1);
  await s.run(); assert.equal(ledgerLookup(s.ledger(), 'dead').state, '待发起');
  const callsBefore = s.st.infoCalls;
  s.st.now = T0 + 26 * H; await s.run(); // 恢复时间＋24 小时 ＝ T0+25h 已过
  assert.equal(ledgerLookup(s.ledger(), 'dead').state, '不接续：过期');
  assert.ok(s.st.sent.some((x) => /说“继续”/.test(x.text)) || true);
  const callsAfterExpire = s.st.infoCalls;
  s.st.now += 1 * H; await s.run(); await s.run();
  assert.equal(s.st.infoCalls, callsAfterExpire, '过期以后不再查频道信息');
  s.st.now = T0 + 26 * H + 15 * 24 * H; await s.run();
  assert.equal(ledgerLookup(s.ledger(), 'dead').found, false, '14 天后清出账');
  assert.ok(callsAfterExpire >= callsBefore);
});
test('已发起之后线程一直读不出：有非 0 退出码照样按发起失败处理；没有退出码则 6 小时后转"读不出"并通知，交看护兜底', async () => {
  let s = setup(); s.st.now = T0; reg(s, { runId: 'r1', fail: T0 - 2 * H, reset: T0 - 1 * H });
  await s.run(); s.st.unreadable.add(CH1);
  s.st.now += 7 * H; await s.run();
  assert.equal(ledgerLookup(s.ledger(), 'r1').state, '读不出'); assert.ok(CALL_STATES.includes('读不出'));
  assert.ok(s.st.sent.some((x) => /没接上或没法确认/.test(x.text)), '发了通知');
  // 有非 0 退出码：读不出也要按发起失败处理
  s = setup(); s.st.now = T0; reg(s, { runId: 'r2', fail: T0 - 2 * H, reset: T0 - 1 * H });
  s.st.launchResult = { ok: false, code: 9 }; await s.run(); s.st.unreadable.add(CH1);
  s.st.now += 5 * MIN; await s.run();
  assert.equal(ledgerLookup(s.ledger(), 'r2').state, '发起失败待重试');
});
test('结果待核不再永远不关：后来有人接上就关成已接上；一直没人接，到过期收掉并通知一次；20 天后再撞限是新链', async () => {
  const s = setup(); s.st.now = T0; reg(s, { runId: 'r1', fail: T0 - 2 * H, reset: T0 - 1 * H });
  await s.run(); s.st.now += 40 * MIN; await s.run();
  assert.equal(ledgerLookup(s.ledger(), 'r1').state, '结果待核');
  s.st.msgs[CH1] = [msg(OWNER_ID, s.st.now + 1000)]; s.st.now += 5 * MIN; await s.run();
  assert.equal(ledgerLookup(s.ledger(), 'r1').state, '已接上');
  const s2 = setup(); s2.st.now = T0; reg(s2, { runId: 'q1', fail: T0 - 2 * H, reset: T0 - 1 * H });
  await s2.run(); s2.st.now += 40 * MIN; await s2.run();
  s2.st.now = T0 + 30 * H; await s2.run();
  assert.equal(ledgerLookup(s2.ledger(), 'q1').state, '不接续：过期');
  assert.ok(s2.st.sent.some((x) => /没接上或没法确认/.test(x.text)), '过期不再不声不响');
  s2.st.now = T0 + 20 * 24 * H; reg(s2, { runId: 'q2', fail: s2.st.now - 5 * MIN, reset: s2.st.now + 10 * MIN });
  await s2.run();
  const L = s2.ledger(); assert.notEqual(L.运行.q2, L.运行.q1); assert.equal(ledgerLookup(L, 'q2').state, '待发起');
});
test('登记乱序：较晚的先进账、较早的后进来，仍是同一条链，不开第二条；链的最新时间不被冲回去', async () => {
  const s = setup(); s.st.now = T0 - 1 * H;
  reg(s, { runId: 'late', fail: T0 - 3 * H, reset: T0 + 2 * H });
  await s.run();
  reg(s, { runId: 'early', fail: T0 - 5 * H, reset: T0 - 4 * H });
  await s.run();
  const L = s.ledger(); assert.equal(Object.keys(L.链).length, 1); const c = Object.values(L.链)[0];
  assert.deepEqual(c.运行编号.sort(), ['early', 'late']); assert.equal(c.最新失败时间毫秒, T0 - 3 * H); assert.equal(c.最新运行编号, 'late');
  assert.equal(ledgerLookup(L, 'early').found, true);
});
test('刚进来就已经过期的老登记：收进账标过期，但不发通知吵人；新链编号不重号', async () => {
  const s = setup(); s.st.now = T0; reg(s, { runId: 'ancient', fail: T0 - 40 * H, reset: T0 - 39 * H });
  await s.run();
  assert.equal(ledgerLookup(s.ledger(), 'ancient').state, '不接续：过期'); assert.equal(s.st.sent.length, 0);
  s.st.now += 15 * 24 * H; await s.run(); // 旧链被清掉
  reg(s, { runId: 'again', fail: s.st.now - 2 * H, reset: s.st.now - 1 * H });
  await s.run();
  const ids = Object.keys(s.ledger().链); assert.equal(ids.length, 1); assert.match(ids[0], /#1$/);
});
test('干跑会列出将发起的；CodexBar 每轮最多查一次；远未到点的链不拖住别的汇总', async () => {
  const s = setup(); s.st.now = T0; reg(s, { runId: 'a', fail: T0 - 2 * H, reset: T0 - 1 * H }); reg(s, { runId: 'b', key: `agent:worker-e:discord:channel:${CH2}`, fail: T0 - 90 * MIN, reset: T0 - 30 * MIN });
  const r = await s.run({ dryRun: true });
  assert.equal(r.launched.length, 2); assert.ok(r.launched.every((x) => x.干跑)); assert.equal(s.st.cbarCalls, 1, 'CodexBar 两条链只查了一次');
  const s2 = setup(); s2.st.now = T0;
  reg(s2, { runId: 'near', fail: T0 - 2 * H, reset: T0 - 1 * H });
  reg(s2, { runId: 'weekly', key: `agent:worker-e:discord:channel:${CH2}`, fail: T0 - 1 * H, reset: T0 + 3 * 24 * H });
  await s2.run();
  assert.equal(s2.st.sent.length, 1, '周限额那条几天后才到点，不拖住"已叫醒"的汇总');
});

test('命令行参数缺值：--data-root／--notify-target 漏写值 → 报错退出码 2，不静默退回正式资料根／工坊', async () => {
  const { main: m } = await import('../scripts/automation/quota-resume.mjs');
  const quiet = async (fn) => { const e = console.error; const l = console.log; console.error = () => {}; console.log = () => {}; try { return await fn(); } finally { console.error = e; console.log = l; } };
  const deps = { now: () => T0, slice: () => slice, channelInfo: async () => ({ type: 11, parentId: '1' }), readMessages: async () => [], send: async () => ({ ok: true, id: '1' }), launch: async () => ({ ok: true }), codexbar: () => null };
  for (const argv of [['--data-root'], ['--notify-target'], ['--data-root', '--dry-run'], ['--notify-target', ' ']]) assert.equal(await quiet(() => m(argv, { deps })), 2, argv.join(' '));
});
