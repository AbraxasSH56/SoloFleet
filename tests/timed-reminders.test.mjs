// Offline tests for timed reminders: temporary directories and fake data only; nothing touches a real deployment.
// 假时钟、假的 claude auth status、假的发消息；全部在临时目录，不碰真实文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dueReminders, main, paths, runTick, cmdInitLogin, DEFAULT_CONFIG } from '../scripts/automation/timed-reminders.mjs';

const T = (s) => Date.parse(s);
const LOGIN_EXP = '2031-03-10T11:13:49Z'; // 测试时区（UTC+5:30） 03-10 16:43

function mk({ now = '2031-02-27T09:00:00+05:30', gate = { 状态: '正常', 当期到期: '2031-03-06T07:00:00+05:30', 暂停区间: [] }, status = { ok: true, loggedIn: true, expiresAt: T(LOGIN_EXP) }, seedLogin = true, loginSeed = LOGIN_EXP } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'rem-'));
  const st = { clock: T(now), sent: [], sendOk: true, status, warns: [], out: [] };
  const p = paths(dataRoot);
  mkdirSync(dirname(p.config), { recursive: true }); writeFileSync(p.config, JSON.stringify({ 复议日期: '2031-03-20' })); // the review date is optional config; tests use this one
  if (gate) { mkdirSync(join(dataRoot, '运行记录', 'API额度'), { recursive: true }); writeFileSync(p.gate, JSON.stringify(gate)); }
  const deps = {
    dataRoot, now: () => st.clock, claudeStatus: () => st.status,
    async send(text) { st.sent.push(text); return st.sendOk ? { ok: true, id: `m${st.sent.length}` } : { ok: false, error: '假失败' }; },
    warn: (m) => st.warns.push(m), out: (m) => st.out.push(m),
  };
  const state = () => JSON.parse(readFileSync(p.state, 'utf8'));
  const at = (s) => { st.clock = T(s); };
  const tick = () => runTick(deps);
  const ready = async () => { if (seedLogin) { await cmdInitLogin(deps, loginSeed); st.out.length = 0; } return { st, deps, state, at, tick, dataRoot, p }; };
  return ready();
}
const keys = (st) => st.sent.map((t) => t.slice(0, 40));

test('API 到期前 7 天：02-27 08:59 不发，09:00 发；同一天再跑不重发；第二天不补', async () => {
  const e = await mk({ now: '2031-02-27T08:59:00+05:30' });
  await e.tick(); assert.equal(e.st.sent.length, 0, '早一分钟不发');
  e.at('2031-02-27T09:00:00+05:30'); await e.tick();
  assert.equal(e.st.sent.length, 1); assert.match(e.st.sent[0], /3 月 6 日 07:00 到期，还剩 7 天/); assert.match(e.st.sent[0], /<@100000000000000001>/);
  assert.ok(e.state().已发['到期前7天@2031-03-06'].消息编号);
  e.at('2031-02-27T09:30:00+05:30'); await e.tick(); assert.equal(e.st.sent.length, 1, '发过不重发');
  e.at('2031-02-28T09:00:00+05:30'); await e.tick(); assert.equal(e.st.sent.length, 1, '过了当天作废');
});

test('错过点（合盖睡着）：醒来当天内补发', async () => {
  const e = await mk({ now: '2031-02-27T15:20:00+05:30' });
  await e.tick(); assert.equal(e.st.sent.length, 1); assert.match(e.st.sent[0], /还剩 7 天/);
});

test('03-05：API 到期前 1 天＋登录前 5 天各一条；文案里有叫备用 bot 用掉的话', async () => {
  const e = await mk({ now: '2031-03-05T09:00:00+05:30' });
  await e.tick();
  assert.equal(e.st.sent.length, 2);
  const api = e.st.sent.find((t) => /API 额度提醒/.test(t)); const login = e.st.sent.find((t) => /Claude 登录快到期/.test(t));
  assert.match(api, /明天（3 月 6 日 07:00）/); assert.match(api, /备用A、备用B用掉/);
  assert.match(login, /3 月 10 日 16:43/); assert.match(login, /还剩 5 天/); assert.match(login, /所有走 Claude 订阅的 bot 会同时不能回话/); assert.match(login, /auth login/);
  assert.ok(Object.keys(e.state().已发).some((k) => k.startsWith('登录前5天@2031-03-10T11:13:49Z')));
});

test('额度已用完、闸门已暂停时，03-05 的文案不叫备用A、备用B用掉', async () => {
  const e = await mk({ now: '2031-03-05T09:00:00+05:30', gate: { 状态: '已暂停', 暂停原因: '用完', 暂停时间: '2031-03-04T07:00:00+05:30', 当期到期: '2031-03-06T07:00:00+05:30', 暂停区间: [{ 开始: '2031-03-04T07:00:00+05:30', 结束: null }] } });
  await e.tick();
  const api = e.st.sent.find((t) => /API 额度提醒/.test(t));
  assert.ok(api); assert.doesNotMatch(api, /备用A/); assert.match(api, /额度已经用完/);
});

test('登录：03-08 前 2 天；到期当天仍没登发“已过期”；之后不再发', async () => {
  const e = await mk({ now: '2031-03-08T08:59:00+05:30', gate: null });
  await e.tick(); assert.equal(e.st.sent.length, 0);
  e.at('2031-03-08T09:00:00+05:30'); await e.tick();
  assert.equal(e.st.sent.length, 1); assert.match(e.st.sent[0], /还剩 2 天/);
  e.at('2031-03-10T16:44:00+05:30'); await e.tick();
  assert.equal(e.st.sent.length, 2); assert.match(e.st.sent[1], /登录已过期/);
  e.at('2031-03-10T17:30:00+05:30'); await e.tick(); assert.equal(e.st.sent.length, 2, '已过期只发一次');
});

test('登录：5 天那条当天睡着也在当天内补发；过了当天作废（和 API 提醒同一规矩）', async () => {
  const e = await mk({ now: '2031-03-05T15:00:00+05:30', gate: null });
  await e.tick(); assert.equal(e.st.sent.length, 1); assert.match(e.st.sent[0], /还剩 5 天/);
  const f = await mk({ now: '2031-03-06T07:00:00+05:30', gate: null });
  await f.tick(); assert.equal(f.st.sent.length, 0, '03-06 不再补 03-05 的');
});

test('登录：预置过上次到期日时首轮不发“已更新”；新到期日出现 → 旧提醒作废、发一条已更新、新日期重新算', async () => {
  const e = await mk({ now: '2031-03-02T07:00:00+05:30', gate: null });
  await e.tick(); assert.equal(e.st.sent.length, 0, '预置后首轮无事');
  e.st.status = { ok: true, loggedIn: true, expiresAt: T('2031-04-10T11:13:49Z') };
  e.at('2031-03-02T07:30:00+05:30'); await e.tick();
  assert.equal(e.st.sent.length, 1); assert.match(e.st.sent[0], /登录已更新，新的到期日是 4 月 10 日 16:43/);
  e.at('2031-03-05T09:00:00+05:30'); await e.tick(); assert.equal(e.st.sent.length, 1, '旧到期日的提醒不再发');
  e.at('2031-04-05T09:00:00+05:30'); await e.tick(); assert.equal(e.st.sent.length, 2); assert.match(e.st.sent[1], /4 月 10 日 16:43/);
});

test('登录：没预置过时首次看到到期日是静默记下，不发“已更新”', async () => {
  const e = await mk({ now: '2031-03-02T07:00:00+05:30', gate: null, seedLogin: false });
  await e.tick(); assert.equal(e.st.sent.length, 0);
  assert.equal(e.state().登录.上次看到到期, LOGIN_EXP);
});

test('登录：claude auth status 报错 → 用记录的到期日，消息里写明没能核实；未退出登录时不乱报', async () => {
  const e = await mk({ now: '2031-03-05T09:00:00+05:30', gate: null, status: { ok: false, error: '退出码 1' } });
  await e.tick();
  assert.equal(e.st.sent.length, 1); assert.match(e.st.sent[0], /没能向 Claude 核实/); assert.match(e.st.sent[0], /3 月 10 日 16:43/);
  assert.ok(e.st.warns.some((w) => /没成/.test(w)));
});

test('登录：loggedIn=false → 当天提醒一次“已退出登录”', async () => {
  const e = await mk({ now: '2031-03-02T07:00:00+05:30', gate: null, status: { ok: true, loggedIn: false, expiresAt: null } });
  await e.tick(); assert.equal(e.st.sent.length, 1); assert.match(e.st.sent[0], /已经退出登录/);
  e.at('2031-03-02T07:30:00+05:30'); await e.tick(); assert.equal(e.st.sent.length, 1);
});

test('停满 7 天（03-13）：每次暂停只发一次；恢复后再停是新的一次', async () => {
  const gate = { 状态: '已暂停', 暂停原因: '到期', 暂停时间: '2031-03-06T07:01:00+05:30', 当期到期: '2031-03-06T07:00:00+05:30', 暂停区间: [{ 开始: '2031-03-06T07:01:00+05:30', 结束: null, 原因: '到期' }] };
  const e = await mk({ now: '2031-03-12T09:00:00+05:30', gate, status: { ok: true, loggedIn: true, expiresAt: T('2031-05-30T04:30:00Z') }, loginSeed: '2031-05-30T04:30:00Z' });
  await e.tick(); assert.equal(e.st.sent.length, 0);
  e.at('2031-03-13T09:00:00+05:30'); await e.tick();
  assert.equal(e.st.sent.length, 1); assert.match(e.st.sent[0], /已经停了 7 天/);
  e.at('2031-03-13T12:00:00+05:30'); await e.tick(); assert.equal(e.st.sent.length, 1);
  assert.ok(e.state().已发['停满7天@2031-03-06']);
});

test('复议（03-20，日期可在配置里改）：带上暂停简史；读不到额度闸状态时不带', async () => {
  const gate = { 状态: '正常', 当期到期: '2031-04-06T07:00:00+05:30', 暂停区间: [{ 开始: '2031-03-06T07:01:00+05:30', 结束: '2031-03-11T07:01:00+05:30' }] };
  const e = await mk({ now: '2031-03-20T08:59:00+05:30', gate, status: { ok: true, loggedIn: true, expiresAt: T('2031-05-30T04:30:00Z') }, loginSeed: '2031-05-30T04:30:00Z' });
  await e.tick(); assert.equal(e.st.sent.length, 0);
  e.at('2031-03-20T09:00:00+05:30'); await e.tick();
  assert.equal(e.st.sent.length, 1); assert.match(e.st.sent[0], /继续“用完即停”/); assert.match(e.st.sent[0], /停过 1 次，约 5 天/);
  const f = await mk({ now: '2031-03-18T09:00:00+05:30', gate, status: { ok: true, loggedIn: true, expiresAt: T('2031-05-30T04:30:00Z') }, loginSeed: '2031-05-30T04:30:00Z' });
  writeFileSync(f.p.config, JSON.stringify({ 复议日期: '2031-03-18' }));
  await f.tick(); assert.equal(f.st.sent.length, 1); assert.match(f.st.sent[0], /复议/);
});

test('跨周期去重：月初@2031-03 不挡 月初@2031-04；到期日改了旧键不挡新键；文案不出现“本月 6 日”', async () => {
  const gate = { 状态: '正常', 当期到期: null, 暂停区间: [] };
  const e = await mk({ now: '2031-03-01T09:00:00+05:30', gate, status: { ok: true, loggedIn: true, expiresAt: T('2031-05-30T04:30:00Z') }, loginSeed: '2031-05-30T04:30:00Z' });
  await e.tick(); assert.equal(e.st.sent.length, 1); assert.ok(e.state().已发['月初@2031-03']);
  e.at('2031-04-01T09:00:00+05:30'); await e.tick();
  assert.equal(e.st.sent.length, 2); assert.ok(e.state().已发['月初@2031-04']);
  for (const t of e.st.sent) assert.doesNotMatch(t, /本月 6 日/);
  e.at('2031-04-01T09:30:00+05:30'); await e.tick(); assert.equal(e.st.sent.length, 2);
  // 到期日换成下一期：新键
  writeFileSync(e.p.gate, JSON.stringify({ 状态: '正常', 当期到期: '2031-05-07T07:00:00+05:30', 暂停区间: [] }));
  e.at('2031-04-30T09:00:00+05:30'); await e.tick();
  assert.equal(e.st.sent.length, 3); assert.match(e.st.sent[2], /5 月 7 日 07:00 到期，还剩 7 天/);
  assert.ok(e.state().已发['到期前7天@2031-05-07']);
});

test('当期到期没记着、没到月初：不发 API 提醒', async () => {
  const e = await mk({ now: '2031-03-15T09:00:00+05:30', gate: { 状态: '正常', 当期到期: null, 暂停区间: [] }, status: { ok: true, loggedIn: true, expiresAt: T('2031-05-30T04:30:00Z') }, loginSeed: '2031-05-30T04:30:00Z' });
  await e.tick(); assert.equal(e.st.sent.length, 0);
});

test('发消息回执失败：不记已发，下一轮重发；同一条当天最多试 12 次；一轮最多发 3 条', async () => {
  const e = await mk({ now: '2031-03-05T09:00:00+05:30' });
  e.st.sendOk = false; await e.tick();
  assert.deepEqual(e.state().已发, {}); assert.equal(e.st.sent.length, 2);
  e.st.sendOk = true; e.at('2031-03-05T09:30:00+05:30'); await e.tick();
  assert.equal(Object.keys(e.state().已发).length, 2); assert.equal(e.st.sent.length, 4);
  const f = await mk({ now: '2031-03-05T09:00:00+05:30' });
  f.st.sendOk = false;
  for (let i = 0; i < 14; i++) { await f.tick(); f.at(new Date(f.st.clock + 30 * 60000).toISOString()); }
  assert.equal(f.st.sent.length, 24, '两条各试 12 次就停（原来 3 次约一个半小时就放弃，Discord 连不上半天会丢提醒）');
  assert.ok(f.st.warns.some((w) => /不再试/.test(w)));
});

test('无事可发 → 输出 NO_REPLY；干跑不发不记、--now 只能配干跑', async () => {
  const e = await mk({ now: '2031-03-02T07:00:00+05:30' });
  assert.equal(await main(['--data-root', e.dataRoot], e.deps), 0); assert.deepEqual(e.st.out, ['NO_REPLY']);
  e.st.out.length = 0;
  assert.equal(await main(['--now', '2031-03-05T09:00:00+05:30', '--data-root', e.dataRoot], e.deps), 2); assert.match(e.st.out[0], /只能和 --dry-run/);
  e.st.out.length = 0;
  const before = readFileSync(e.p.state, 'utf8');
  assert.equal(await main(['--dry-run', '--now', '2031-03-05T09:00:00+05:30', '--data-root', e.dataRoot], e.deps), 0);
  assert.match(e.st.out[0], /【会发】/); assert.equal(e.st.sent.length, 0); assert.equal(readFileSync(e.p.state, 'utf8'), before);
});

test('--init-login：格式不对拒绝；已发记录文件读不懂时本轮不发（免得重复）', async () => {
  const e = await mk({ now: '2031-03-05T09:00:00+05:30', seedLogin: false });
  assert.equal(await cmdInitLogin(e.deps, '12月10日'), 2);
  mkdirSync(e.p.dir, { recursive: true }); writeFileSync(e.p.state, '{坏了');
  await e.tick(); assert.equal(e.st.sent.length, 0); assert.ok(e.st.warns.some((w) => /已发记录读不了/.test(w)));
});

test('dueReminders 是纯函数：同样输入同样输出，不改入参', () => {
  const gate = { 状态: '正常', 当期到期: '2031-03-06T07:00:00+05:30', 暂停区间: [] };
  const a = dueReminders({ nowMs: T('2031-02-27T09:00:00+05:30'), gate, login: {}, status: { ok: true, loggedIn: true, expiresAt: T(LOGIN_EXP) }, cfg: DEFAULT_CONFIG });
  const b = dueReminders({ nowMs: T('2031-02-27T09:00:00+05:30'), gate, login: {}, status: { ok: true, loggedIn: true, expiresAt: T(LOGIN_EXP) }, cfg: DEFAULT_CONFIG });
  assert.deepEqual(a, b); assert.equal(a.length, 1);
});

test('官方返回的登录到期日带毫秒（带小数的毫秒）：和预置的整秒值相比不算“已更新”', async () => {
  const e = await mk({ now: '2031-03-02T07:00:00+05:30', gate: null, status: { ok: true, loggedIn: true, expiresAt: T('2031-03-10T11:13:49.118Z') } });
  await e.tick(); assert.equal(e.st.sent.length, 0, '同一个到期日，不发“已更新”');
  e.at('2031-03-05T09:00:00+05:30'); await e.tick();
  assert.equal(e.st.sent.length, 1); assert.match(e.st.sent[0], /还剩 5 天/);
  assert.ok(e.state().已发['登录前5天@2031-03-10T11:13:49Z'], '去重键按整秒，不受毫秒影响');
});

test('审计登录提醒不跨过半夜补发（次日 08:xx 不补前一天的）；提前一周以上用完额度时 7 天提醒也不叫备用 bot 用掉', async () => {
  const e = await mk({ now: '2031-03-06T08:30:00+05:30', gate: null });
  await e.tick(); assert.equal(e.st.sent.length, 0, '03-05 睡过去了，03-06 早上不补');
  const gate = { 状态: '已暂停', 暂停原因: '用完', 暂停时间: '2031-02-18T07:00:00+05:30', 当期到期: '2031-03-06T07:00:00+05:30', 暂停区间: [{ 开始: '2031-02-18T07:00:00+05:30', 结束: null }] };
  const f = await mk({ now: '2031-02-27T09:00:00+05:30', gate });
  await f.tick(); const api = f.st.sent.find((t) => /API 额度提醒/.test(t));
  assert.ok(api); assert.doesNotMatch(api, /备用A/); assert.match(api, /额度已经用完/);
});

test('额度闸状态读不到（gate=null）时，03-20 复议提醒照发，并说明读不到', async () => {
  const e = await mk({ now: '2031-03-20T09:00:00+05:30', gate: null, status: { ok: true, loggedIn: true, expiresAt: T('2031-05-30T04:30:00Z') }, loginSeed: '2031-05-30T04:30:00Z' });
  await e.tick();
  assert.equal(e.st.sent.length, 1); assert.match(e.st.sent[0], /复议/); assert.match(e.st.sent[0], /读不到/); assert.match(e.st.sent[0], /继续“用完即停”/);
  assert.ok(e.state().已发['复议@2031-03-20']);
  const none = dueReminders({ nowMs: T('2031-03-20T08:59:00+05:30'), gate: null, login: {}, status: { ok: false }, cfg: DEFAULT_CONFIG });
  assert.equal(none.filter((r) => /^复议/.test(r.key)).length, 0, '没到点不发');
});
