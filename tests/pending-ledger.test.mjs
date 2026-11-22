// Offline tests for pending ledger: temporary directories and fake data only; nothing touches a real deployment.
// “等你定”台账和提醒逻辑离线测试。运行：node --test tests/pending-ledger.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER_ID, WORKSHOP_CHANNEL, MERGE_INTERVAL_MS, withLedger, registerItem, updateItem, runTick, readLedgerFile, buildTable, emptyLedger,
} from '../plugins/personal-inbox/pending-ledger.mjs';

const DAY = 86400000;
const T0 = Date.parse('2026-11-12T00:00:00Z');

function mk() {
  const dir = mkdtempSync(join(tmpdir(), 'pend-'));
  const path = join(dir, '台账.json');
  const sent = []; const edits = []; const pins = []; let n = 100; let readMode = 'ok'; let replies = {}; let loseId = false; let searchResult = []; const wakes = []; let wakeFail = false;
  const discord = {
    async send(a) { sent.push(a); return loseId ? { messageId: null } : { messageId: String(++n) }; },
    async edit(a) { edits.push(a); },
    async pin(a) { pins.push(a); },
    async readReplies(item) { if (readMode === 'fail') throw new Error('读不到'); return replies[item.id] ?? []; },
    async search() { return searchResult; },
    async wakeJudge(a) { if (wakeFail) throw new Error('建任务失败'); wakes.push(a); return { jobId: `job${wakes.length}` }; },
  };
  const reg = (extra = {}, at = T0) => withLedger(path, (L) => ({ r: registerItem(L, { title: '要不要A', suggestion: '建议A', blocks: '卡住X', requestMessageId: `rq${Math.random()}`, requestLink: 'L', botId: '99', ...extra }, at) }), { now: () => at });
  return { dir, path, sent, edits, pins, discord, reg, wakes, setWakeFail: (v) => { wakeFail = v; },
    setRead: (m) => { readMode = m; }, setReplies: (r) => { replies = r; }, loseId: (v) => { loseId = v; }, setSearch: (r) => { searchResult = r; },
    tick: (at) => runTick({ path, now: () => at, discord, watchDir: join(dir, 'watch') }),
    ledger: () => readLedgerFile(path), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('登记：同一原请示消息编号重复登记只有一行；缺项被拒', async () => {
  const t = mk();
  const a = await t.reg({ requestMessageId: 'M1' }); const b = await t.reg({ requestMessageId: 'M1' });
  assert.equal(b.r.existing, true);
  assert.equal(t.ledger().items.length, 1);
  const bad = await withLedger(t.path, (L) => ({ r: registerItem(L, { title: 'x' }, T0) }));
  assert.ok(bad.r.error);
  t.cleanup();
});

test('首点名：每件只点一次；置顶总表第一次发出并置顶；内容没变不再改', async () => {
  const t = mk(); await t.reg({ requestMessageId: 'M1' });
  const r1 = await t.tick(T0);
  assert.equal(t.pins.length, 1);
  assert.equal(t.sent.filter((s) => s.text.includes('新的一件等你定')).length, 1);
  assert.ok(t.sent.every((s) => s.target === WORKSHOP_CHANNEL));
  await t.tick(T0 + 1800000);
  assert.equal(t.sent.filter((s) => s.text.includes('新的一件等你定')).length, 1, '不再首点');
  assert.equal(t.edits.length, 0, '总表没变不改');
  t.cleanup();
});

test('搭建期首批几件合成一条首点名，台账里仍逐件一行', async () => {
  const t = mk();
  for (let k = 0; k < 4; k++) await t.reg({ requestMessageId: `B${k}`, batch: '搭建期首批', title: `搭建期${k}` });
  await t.tick(T0);
  const notices = t.sent.filter((s) => s.text.includes('搭建期遗留'));
  assert.equal(notices.length, 1);
  assert.equal(t.ledger().items.length, 4);
  assert.ok(t.ledger().items.every((i) => i.firstAskedAt));
  t.cleanup();
});

test('全表 3 天只发一次合并提醒、最多 3 件、最久没提醒的先（造 7 件跑 9 天每件都轮到）', async () => {
  const t = mk();
  for (let k = 0; k < 7; k++) await t.reg({ requestMessageId: `Q${k}`, title: `事${k}` }, T0 + k);
  await t.tick(T0 + 10); // 首点名（逐件各一条）
  const sentAfterFirst = t.sent.length;
  // 第 1～2 天：不发
  for (let h = 1; h <= 48; h += 6) await t.tick(T0 + h * 3600000);
  assert.equal(t.sent.filter((s) => s.text.includes('合并提醒')).length, 0, '不满 3 天不发');
  const remindedTitles = new Set();
  for (let d = 3; d <= 12; d++) {
    for (const hh of [0, 12]) await t.tick(T0 + d * DAY + hh * 3600000 + 10);
  }
  const merged = t.sent.filter((s) => s.text.includes('合并提醒'));
  assert.ok(merged.length >= 3 && merged.length <= 4, `9 天内约 3 条合并提醒，实际 ${merged.length}`);
  for (const m of merged) { const cnt = (m.text.match(/^\d\. /gm) ?? []).length; assert.ok(cnt <= 3, '每次最多 3 件'); m.text.split('\n').filter((l) => /^\d\. /.test(l)).forEach((l) => remindedTitles.add(l.replace(/^\d\. /, '').split('（')[0])); }
  assert.equal(remindedTitles.size, 7, '每件都轮到过');
  t.cleanup();
});

test('不满 3 天，哪怕有别的件到了 3 天也不发；满 3 天才发', async () => {
  const t = mk(); await t.reg({ requestMessageId: 'A1' });
  await t.tick(T0);
  await t.tick(T0 + 2 * DAY + 3600000);
  assert.equal(t.sent.filter((s) => s.text.includes('合并提醒')).length, 0);
  await t.tick(T0 + 3 * DAY + 60000);
  assert.equal(t.sent.filter((s) => s.text.includes('合并提醒')).length, 1);
  t.cleanup();
});

test('回复关联 → 待判，并建一次性任务叫醒总控去判（不靠发消息点名）；同一条旧回应再看到不改回待判', async () => {
  const t = mk(); const { r } = await t.reg({ requestMessageId: 'RQ1', requestChannelId: 'CH1' });
  await t.tick(T0);
  t.setReplies({ [r.item.id]: [{ id: 'RE1', authorId: OWNER_ID, replyToId: 'RQ1', channelId: 'CH1', content: '周末再看' }] });
  await t.tick(T0 + 1800000);
  assert.equal(t.ledger().items[0].status, '待判');
  assert.equal(t.wakes.length, 1, '建了一次叫醒任务'); assert.equal(t.wakes[0].replyId, 'RE1');
  assert.equal(t.ledger().items[0].judgeCall.state, '已叫起');
  assert.ok(!t.sent.some((s) => s.target === 'CH1'), '不再发“请判”消息');
  // 判定（update）后，同一条回应再被看到：不改回待判
  await withLedger(t.path, (L) => ({ u: updateItem(L, { id: r.item.id, status: '收到', recheckDate: '2026-11-20', source: 'RE1' }, { id: 'RE1', authorId: OWNER_ID, replyToId: 'RQ1', channelId: 'CH1', content: '周末再看' }, T0) }), { now: () => T0 });
  assert.equal(t.ledger().items[0].status, '收到');
  await t.tick(T0 + 3600000);
  assert.equal(t.ledger().items[0].status, '收到', '旧回应不再把状态改回待判');
  t.cleanup();
});

test('同频道没关联的话：不改状态，只标“可能有回话”，提醒时带一句', async () => {
  const t = mk(); const { r } = await t.reg({ requestMessageId: 'RQ2', requestChannelId: 'CH2' });
  await t.tick(T0);
  t.setReplies({ [r.item.id]: [{ id: 'X1', authorId: OWNER_ID, replyToId: null, channelId: 'CH2', content: '随便一句' }] });
  await t.tick(T0 + 1800000);
  const it = t.ledger().items[0];
  assert.equal(it.status, '没回'); assert.equal(it.possibleReply.messageId, 'X1');
  await t.tick(T0 + 3 * DAY + 60000);
  assert.ok(t.sent.some((s) => s.text.includes('你可能回过')));
  t.cleanup();
});

test('待判满 24 小时没人判 → 回到没回，提醒里带“你回过，bot 没判出”', async () => {
  const t = mk(); const { r } = await t.reg({ requestMessageId: 'RQ3', requestChannelId: 'CH3' });
  await t.tick(T0);
  t.setReplies({ [r.item.id]: [{ id: 'RE3', authorId: OWNER_ID, replyToId: 'RQ3', channelId: 'CH3', content: '嗯' }] });
  await t.tick(T0 + 1800000);
  assert.equal(t.ledger().items[0].status, '待判');
  // 回应一直读得到
  await t.tick(T0 + 1800000 + 25 * 3600000);
  assert.equal(t.ledger().items[0].status, '没回', '超时后不再变回待判');
  assert.match(JSON.stringify(t.ledger().items[0].possibleReply), /bot 没判出/);
  assert.ok(t.ledger().items[0].handledReplies.includes('RE3'), '那条回应记成已超时处理');
  assert.equal(t.wakes.length, 1, '没有再叫一次');
  await t.tick(T0 + 1800000 + 26 * 3600000);
  assert.equal(t.ledger().items[0].status, '没回'); assert.equal(t.wakes.length, 1);
  t.cleanup();
});

test('读 Discord 失败：状态不变、记“未知”；连续 3 次在合并提醒里写一句', async () => {
  const t = mk(); await t.reg({ requestMessageId: 'RQ4', requestChannelId: 'CH4' });
  await t.tick(T0);
  t.setRead('fail');
  for (let k = 1; k <= 3; k++) await t.tick(T0 + k * 1800000);
  const it = t.ledger().items[0];
  assert.equal(it.status, '没回'); assert.match(it.responseUnknown, /读取失败/);
  await t.tick(T0 + 3 * DAY + 60000);
  assert.ok(t.sent.some((s) => s.text.includes('读不到 Discord')));
  t.cleanup();
});

test('update：没关联也没填依据 → 拒绝；填了依据 → 改成并存依据；依据不在原话里 → 拒绝；作者不是主人 → 拒绝；同一条回应不重复处理', async () => {
  const t = mk(); const { r } = await t.reg({ requestMessageId: 'RQ5', requestChannelId: 'CH5' });
  const id = r.item.id;
  const upd = async (input, msg) => (await withLedger(t.path, (L) => ({ u: updateItem(L, { id, status: '已定', decision: '同意', ...input }, msg, T0) }), { now: () => T0 })).u;
  const msg = { id: 'E1', authorId: OWNER_ID, replyToId: null, channelId: 'OTHER', content: '那个A的事就按你建议办' };
  assert.ok((await upd({}, msg)).error, '没关联没依据');
  assert.ok((await upd({ basis: '不存在的话' }, msg)).error, '依据不在原话里');
  assert.ok((await upd({ basis: 'A的事' }, { ...msg, authorId: '777' })).error, '作者不对');
  const ok = await upd({ basis: 'A的事' }, msg);
  assert.equal(ok.item.status, '已定'); assert.equal(ok.item.decisionBasis, 'A的事');
  assert.ok((await upd({ basis: 'A的事' }, msg)).error, '同一条回应不重复处理');
  t.cleanup();
});

test('“收到”没约定日期 → 默认 7 天后回到候选并在表里标明', async () => {
  const t = mk(); const { r } = await t.reg({ requestMessageId: 'RQ6', requestChannelId: 'CH6' });
  await withLedger(t.path, (L) => ({ u: updateItem(L, { id: r.item.id, status: '收到' }, { id: 'R6', authorId: OWNER_ID, replyToId: 'RQ6', channelId: 'CH6', content: '收到' }, T0) }), { now: () => T0 });
  const it = t.ledger().items[0];
  assert.equal(it.recheckDate, '2026-11-19'); assert.equal(it.recheckDefault, true);
  assert.match(buildTable(t.ledger(), T0), /默认/);
  t.cleanup();
});

test('有截止时间的：截止前 24 小时额外点一次，每件一次', async () => {
  const t = mk(); await t.reg({ requestMessageId: 'D1', deadline: '2026-11-13T06:00:00Z' });
  await t.tick(T0);
  const before = t.sent.length;
  await t.tick(T0 + 3600000);
  assert.equal(t.sent.length, before, '离截止还有 29 小时，不提前点');
  await t.tick(T0 + 7 * 3600000);
  assert.equal(t.sent.length, before + 1, '进入 24 小时窗口发一次');
  assert.match(t.sent.at(-1).text, /快到截止/);
  await t.tick(T0 + 8 * 3600000);
  assert.equal(t.sent.length, before + 1, '不重复');
  t.cleanup();
});

test('点名发出后没拿到消息编号：记发送待核，下次按文字指纹找，找到补记、找不到记未送达，都不重发', async () => {
  const t = mk(); await t.reg({ requestMessageId: 'S1' });
  t.loseId(true);
  await t.tick(T0);
  assert.equal(t.ledger().items[0].notice.state, '发送待核');
  const n = t.sent.length;
  t.loseId(false);
  const token = t.ledger().items[0].notice.token;
  t.setSearch([{ id: 'FOUND', content: `xx ${token}` }]);
  await t.tick(T0 + 1800000);
  assert.equal(t.ledger().items[0].notice.state, '已发');
  assert.equal(t.sent.filter((s) => s.text.includes('新的一件')).length, 1, '没有重发');
  // 找不到的情形
  const t2 = mk(); await t2.reg({ requestMessageId: 'S2' });
  t2.loseId(true); await t2.tick(T0); t2.loseId(false); t2.setSearch([]);
  await t2.tick(T0 + 1800000);
  assert.equal(t2.ledger().items[0].notice.state, '未送达');
  assert.equal(t2.sent.filter((s) => s.text.includes('新的一件')).length, 1);
  t.cleanup(); t2.cleanup();
});

test('测试件不进总表、不被点名、不进合并提醒', async () => {
  const t = mk(); await t.reg({ requestMessageId: 'T1', isTest: true, title: '【测试】x' });
  await t.tick(T0);
  assert.equal(t.sent.filter((s) => s.text.includes('【测试】x')).length, 0);
  assert.ok(!buildTable(t.ledger(), T0).includes('【测试】x'));
  t.cleanup();
});

test('两个写入方同时写：都写进、版本号连续、不丢；锁在就等，等不到返回“台账忙”；锁太老不抢不删', async () => {
  const t = mk();
  const w = (k) => withLedger(t.path, (L) => ({ r: registerItem(L, { title: `并发${k}`, suggestion: 's', blocks: 'b', requestMessageId: `P${k}` }, T0) }));
  const rs = await Promise.all([w(1), w(2), w(3), w(4)]);
  assert.ok(rs.every((x) => !x.busy));
  const L = t.ledger();
  assert.equal(L.items.length, 4); assert.equal(L.version, 4);
  // 锁在、不老 → 等不到
  writeFileSync(`${t.path}.lock`, JSON.stringify({ at: T0 }));
  let clock = T0; const sleep = async (ms) => { clock += ms; };
  const busy = await withLedger(t.path, () => ({}), { now: () => clock, sleep });
  assert.equal(busy.busy, true); assert.match(busy.message, /台账忙/);
  assert.ok(existsSync(`${t.path}.lock`), '没有抢锁');
  // 锁比 10 分钟老 → 不抢不删，记待核
  clock = T0 + 11 * 60000;
  const stale = await withLedger(t.path, () => ({}), { now: () => clock, sleep, watchDir: join(t.dir, 'watch') });
  assert.equal(stale.stale, true); assert.ok(existsSync(`${t.path}.lock`));
  assert.match(readFileSync(join(t.dir, 'watch', '台账锁待核.log'), 'utf8'), /台账锁待核/);
  t.cleanup();
});

// ----- 两个工具 -----
import { registerPendingTools } from '../plugins/personal-inbox/pending-tools.mjs';
function toolHarness(t, readMessage, agentId = 'main') {
  const tools = {};
  const api = { registerTool: (spec, { name }) => { tools[name] = spec; } };
  registerPendingTools(api, { ledgerPath: t.path, readMessage, now: () => T0 });
  const get = (name) => tools[name].create({ agentId });
  return { reg: (p) => get('pending_decision_register').execute('x', p), upd: (p) => get('pending_decision_update')?.execute('x', p), getUpd: () => get('pending_decision_update') };
}

test('工具：登记写台账、重复登记返回已有；update 只给 main；update 读消息核对后才改，读不到不改', async () => {
  const t = mk();
  const msgs = { E1: { id: 'E1', authorId: OWNER_ID, replyToId: 'RQ9', channelId: 'CH9', content: '周末再看' } };
  const h = toolHarness(t, async (_item, id) => msgs[id] ?? null);
  const r1 = await h.reg({ title: '测试事项', suggestion: 's', blocks: 'b', requestMessageId: 'RQ9', requestChannelId: 'CH9' });
  const d1 = r1.details; assert.equal(d1.ok, true);
  const r2 = await h.reg({ title: '测试事项', suggestion: 's', blocks: 'b', requestMessageId: 'RQ9' });
  assert.equal(r2.details.existing, true);
  assert.equal(toolHarness(t, async () => null, 'worker-e').getUpd(), null, 'update 不给执行者');
  const bad = await h.upd({ id: d1.id, status: '收到', source: 'NOPE' });
  assert.equal(bad.details.ok, false);
  const good = await h.upd({ id: d1.id, status: '收到', source: 'E1', recheckDate: '2026-11-20' });
  assert.equal(good.details.ok, true); assert.equal(good.details.status, '收到');
  const again = await h.upd({ id: d1.id, status: '已定', decision: 'x', source: 'E1' });
  assert.equal(again.details.ok, false, '同一条回应不重复处理');
  const failing = toolHarness(t, async () => { throw new Error('网络'); });
  const r3 = await failing.reg({ title: '另一件', suggestion: 's', blocks: 'b', requestMessageId: 'RQ10' });
  const fail = await failing.upd({ id: r3.details.id, status: '收到', source: 'E2' });
  assert.equal(fail.details.ok, false); assert.match(fail.details.message, /读不到/);
  t.cleanup();
});

// ---------- 暴露的两处：总表超过 2000 字被拆成几条；置顶权限不够后下一轮又发一张新表 ----------
test('总表不超过 1900 字：件数多、字句长时靠后的件缩成一行，不拆成几条消息', async () => {
  const t = mk();
  const long = '很长的说明'.repeat(60);
  for (let k = 0; k < 8; k++) await t.reg({ requestMessageId: `L${k}`, title: `事项${k}${long}`, suggestion: long, blocks: long, requestLink: `https://discord.com/channels/1/2/${k}` });
  await t.tick(T0);
  const table = t.sent.find((s) => s.text.includes('等你定的事（总表）'));
  assert.ok(table, '总表发出了');
  assert.ok(table.text.length <= 1900, `总表 ${table.text.length} 字`);
  assert.equal(t.sent.filter((s) => s.text.includes('等你定的事（总表）')).length, 1, '只有一条总表消息');
  const small = buildTable(emptyLedger(), T0);
  assert.ok(small.length < 200 && small.includes('（现在没有）'));
  t.cleanup();
});

test('置顶失败（机器人缺“置顶消息”权限）：记下失败、记住总表编号，下一轮只改不重发；点名照常发', async () => {
  const t = mk(); await t.reg({ requestMessageId: 'M1' });
  t.discord.pin = async () => { throw new Error('Missing Permissions'); };
  const r1 = await t.tick(T0);
  const L = t.ledger();
  assert.match(L.pinError ?? '', /置顶失败.*Missing Permissions/);
  assert.ok(L.pinnedMessageId, '编号记下了');
  assert.equal(t.sent.filter((s) => s.text.includes('等你定的事（总表）')).length, 1);
  assert.equal(t.sent.filter((s) => s.text.includes('新的一件等你定')).length, 1, '首点名没有被置顶失败拦住');
  await t.tick(T0 + 1800000);
  assert.equal(t.sent.filter((s) => s.text.includes('等你定的事（总表）')).length, 1, '下一轮不再发新总表');
  t.cleanup();
});

test('总表每条消息不超过 16 行（官方 Discord 默认每条最多 17 行，超了会被拆开）：4 件真实长度的、12 件的都放得进一条', async () => {
  const t = mk();
  for (let k = 0; k < 4; k++) await t.reg({ requestMessageId: `R${k}`, title: `搭建期事项${k}：怎么收那几张测试卡和残留`, suggestion: '选 1：残留进项目垃圾桶、测试卡撤销', blocks: '不卡别的工作，但看板和巡查每天都会带到', requestLink: `https://discord.com/channels/100000000000000002/100000000000000003/100000000000000113${k}` });
  const a = buildTable(t.ledger(), T0);
  assert.ok(a.split('\n').length <= 16 && a.length <= 1900, `${a.split('\n').length} 行 ${a.length} 字`);
  assert.ok(a.includes('建议：选 1'), '4 件时仍是详细的');
  for (let k = 4; k < 12; k++) await t.reg({ requestMessageId: `R${k}`, title: `事项${k}`, suggestion: '建议', blocks: '卡住', requestLink: `https://discord.com/channels/1/2/${k}` });
  const b = buildTable(t.ledger(), T0);
  assert.ok(b.split('\n').length <= 16 && b.length <= 1900, `${b.split('\n').length} 行 ${b.length} 字`);
  assert.ok(b.includes('12.'), '12 件都在表里');
  t.cleanup();
});

test('叫醒任务建不出来：状态不变、记“叫起失败”、下一轮再试；不发任何消息', async () => {
  const t = mk(); const { r } = await t.reg({ requestMessageId: 'RQ9', requestChannelId: 'CH9' });
  await t.tick(T0);
  t.setReplies({ [r.item.id]: [{ id: 'RE9', authorId: OWNER_ID, replyToId: 'RQ9', channelId: 'CH9', content: '好' }] });
  t.setWakeFail(true);
  await t.tick(T0 + 1800000);
  let it = t.ledger().items[0];
  assert.equal(it.status, '没回'); assert.equal(it.judgeCall.state, '叫起失败');
  assert.ok(!t.sent.some((s) => s.target === 'CH9'));
  t.setWakeFail(false);
  await t.tick(T0 + 3600000);
  it = t.ledger().items[0];
  assert.equal(it.status, '待判'); assert.equal(t.wakes.length, 1);
  t.cleanup();
});

// ======================================================================
// 锁超时且持锁进程已不存在才回收；其余照旧不抢。
// ======================================================================
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pidState, LOCK_STALE_MS } from '../plugins/personal-inbox/pending-ledger.mjs';

// 造一个已结束的子进程号（一定不存在，除非被系统复用，测试期间可忽略）。
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
const reg1 = (k) => (L) => ({ r: registerItem(L, { title: `回收${k}`, suggestion: 's', blocks: 'b', requestMessageId: `RC${k}` }, T0) });
const lockText = (o) => JSON.stringify(o);

test('D8-1 老锁＋死 pid → 回收、登记成功、日志有“回收”；锁和互斥文件都不留', async () => {
  const t = mk(); const watch = join(t.dir, 'watch');
  const pid = deadPid(); assert.equal(pidState(pid), 'dead');
  writeFileSync(`${t.path}.lock`, lockText({ at: T0, pid }));
  const clock = T0 + 11 * 60000;
  const r = await withLedger(t.path, reg1(1), { now: () => clock, sleep: async () => {}, watchDir: watch });
  assert.equal(r.busy, false); assert.equal(t.ledger().items.length, 1); assert.equal(t.ledger().version, 1);
  assert.ok(!existsSync(`${t.path}.lock`)); assert.ok(!existsSync(`${t.path}.lock.reclaim`));
  const log = readFileSync(join(watch, '台账锁待核.log'), 'utf8');
  assert.match(log, /台账锁回收（旧锁 pid \d+ 已不在，已存在 11 分钟/);
  assert.equal((log.match(/台账锁回收/g) ?? []).length, 1);
  t.cleanup();
});

test('D8-2 老锁＋活 pid（本进程）→ 不抢、返回 stale、锁还在、日志写待核', async () => {
  const t = mk(); const watch = join(t.dir, 'watch');
  const body = lockText({ at: T0, pid: process.pid });
  writeFileSync(`${t.path}.lock`, body);
  const r = await withLedger(t.path, reg1(2), { now: () => T0 + 11 * 60000, sleep: async () => {}, watchDir: watch });
  assert.equal(r.stale, true); assert.equal(r.busy, true);
  assert.equal(readFileSync(`${t.path}.lock`, 'utf8'), body); assert.equal(t.ledger().items.length, 0);
  assert.match(readFileSync(join(watch, '台账锁待核.log'), 'utf8'), /台账锁待核.*还在，不抢/);
  t.cleanup();
});

test('D8-3 老锁＋无 pid／坏 JSON／pid 不是正整数 → 不抢', async () => {
  for (const body of [lockText({ at: T0 }), '坏的{', lockText({ at: T0, pid: 'abc' }), lockText({ at: T0, pid: -5 }), lockText({ at: T0, pid: 0 }), lockText({ at: T0, pid: 1.5 })]) {
    const t = mk();
    writeFileSync(`${t.path}.lock`, body);
    let clock = T0 + 11 * 60000; // 坏 JSON 按“年龄 0”照常等，所以时钟要随 sleep 往前走，否则永远等不到“台账忙”
    const r = await withLedger(t.path, reg1(3), { now: () => clock, sleep: async (ms) => { clock += ms; }, watchDir: join(t.dir, 'watch') });
    // 坏 JSON 时年龄读不出按 0 算，走正常“忙”；其余走 stale。两种都不抢、锁都还在。
    assert.equal(r.busy, true, body); assert.equal(readFileSync(`${t.path}.lock`, 'utf8'), body, body); assert.equal(t.ledger().items.length, 0);
    t.cleanup();
  }
});

test('D8-4 没超时的锁（含死 pid）→ 照旧等、不回收', async () => {
  const t = mk();
  const pid = deadPid();
  writeFileSync(`${t.path}.lock`, lockText({ at: T0, pid }));
  let clock = T0 + 2 * 60000; const sleep = async (ms) => { clock += ms; };
  const r = await withLedger(t.path, reg1(4), { now: () => clock, sleep, watchDir: join(t.dir, 'watch') });
  assert.equal(r.busy, true); assert.match(r.message, /台账忙/); assert.ok(!r.stale);
  assert.ok(existsSync(`${t.path}.lock`)); assert.ok(!existsSync(`${t.path}.lock.reclaim`));
  t.cleanup();
});

test('D8-5 EPERM（pid 1，有这个进程但无权限）当作活着；pidState 各类输入', () => {
  assert.equal(pidState(process.pid), 'alive');
  assert.equal(pidState(1), 'alive');
  assert.equal(pidState(deadPid()), 'dead');
  for (const v of [undefined, null, 'x', 0, -1, 2.5, NaN]) assert.equal(pidState(v), 'unknown', String(v));
});

test('D8-6a 已有“回收中”互斥文件且里面 pid 还在 → 不回收，照常等，到时返回台账忙', async () => {
  const t = mk();
  const pid = deadPid();
  const body = lockText({ at: T0, pid });
  writeFileSync(`${t.path}.lock`, body);
  writeFileSync(`${t.path}.lock.reclaim`, lockText({ at: T0, pid: process.pid }));
  let clock = T0 + 11 * 60000; const sleep = async (ms) => { clock += ms; };
  const r = await withLedger(t.path, reg1(6), { now: () => clock, sleep, watchDir: join(t.dir, 'watch') });
  assert.equal(r.busy, true); assert.match(r.message, /台账忙/);
  assert.equal(readFileSync(`${t.path}.lock`, 'utf8'), body, '旧锁没动'); assert.ok(existsSync(`${t.path}.lock.reclaim`), '别人的互斥没动');
  t.cleanup();
});

test('D8-6b “回收中”互斥文件自己遗留（里面 pid 已不在）→ 不自动删、写待核日志、按忙返回', async () => {
  const t = mk(); const watch = join(t.dir, 'watch');
  const pid = deadPid(); const mpid = deadPid();
  const body = lockText({ at: T0, pid });
  writeFileSync(`${t.path}.lock`, body);
  const mbody = lockText({ at: T0 + 1000, pid: mpid });
  writeFileSync(`${t.path}.lock.reclaim`, mbody);
  const r = await withLedger(t.path, reg1(7), { now: () => T0 + 11 * 60000, sleep: async () => {}, watchDir: watch });
  assert.equal(r.busy, true); assert.equal(r.stale, true);
  assert.equal(readFileSync(`${t.path}.lock`, 'utf8'), body); assert.equal(readFileSync(`${t.path}.lock.reclaim`, 'utf8'), mbody);
  assert.match(readFileSync(join(watch, '台账锁待核.log'), 'utf8'), /“回收中”文件遗留，不自动删.*已不在/);
  t.cleanup();
});

test('D8-6c 拿到互斥后锁内容变了（被别人换成新锁）→ 不删、返回忙；互斥放掉；日志没有“回收”', async () => {
  const t = mk(); const watch = join(t.dir, 'watch');
  const pid = deadPid();
  writeFileSync(`${t.path}.lock`, lockText({ at: T0, pid }));
  const fresh = lockText({ at: T0 + 11 * 60000, pid: process.pid });
  const r = await withLedger(t.path, reg1(8), { now: () => T0 + 11 * 60000, sleep: async () => {}, watchDir: watch,
    hooks: { afterReclaimMutex: () => writeFileSync(`${t.path}.lock`, fresh) } });
  assert.equal(r.busy, true); assert.equal(t.ledger().items.length, 0);
  assert.equal(readFileSync(`${t.path}.lock`, 'utf8'), fresh, '别人的新锁没被删');
  assert.ok(!existsSync(`${t.path}.lock.reclaim`), '互斥已放掉');
  assert.ok(!existsSync(join(watch, '台账锁待核.log')) || !/台账锁回收/.test(readFileSync(join(watch, '台账锁待核.log'), 'utf8')));
  t.cleanup();
});

test('D8-7 真并发：6 个子进程同时写“老锁＋死 pid”的台账 → 版本号正好 +6、条目一条不少、日志只有一行“回收”', async () => {
  const t = mk(); const watch = join(t.dir, 'watch');
  const pid = deadPid();
  writeFileSync(`${t.path}.lock`, lockText({ at: Date.now() - 20 * 60000, pid }));
  const modUrl = new URL('../plugins/personal-inbox/pending-ledger.mjs', import.meta.url).href;
  const child = (k) => new Promise((resolve) => {
    const code = `import { withLedger, registerItem } from ${JSON.stringify(modUrl)};
      const r = await withLedger(${JSON.stringify(t.path)}, (L) => ({ r: registerItem(L, { title: 'P${k}', suggestion: 's', blocks: 'b', requestMessageId: 'CP${k}' }, Date.now()) }), { watchDir: ${JSON.stringify(watch)} });
      console.log(JSON.stringify({ busy: r.busy, stale: r.stale ?? false, message: r.message ?? null }));`;
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', () => resolve(out.trim()));
  });
  const outs = await Promise.all([1, 2, 3, 4, 5, 6].map(child));
  const L = t.ledger();
  assert.equal(L.items.length, 6, outs.join('\n')); assert.equal(L.version, 6);
  assert.ok(outs.every((o) => JSON.parse(o).busy === false), outs.join('\n'));
  const log = readFileSync(join(watch, '台账锁待核.log'), 'utf8');
  assert.equal((log.match(/台账锁回收/g) ?? []).length, 1, log);
  assert.ok(!existsSync(`${t.path}.lock`)); assert.ok(!existsSync(`${t.path}.lock.reclaim`));
  assert.equal(LOCK_STALE_MS, 10 * 60 * 1000);
  t.cleanup();
});

import { APPROVAL_CHANNEL_ID } from '../plugins/personal-inbox/approval-card.mjs';
import {
  registerApprovalExpiry, closeApprovalExpiryOnReissue, recordApprovalExpiry, recordApprovalReissue, runApprovalExpiryTick, isApprovalExpiry,
  APPROVAL_EXPIRY_MS, APPROVAL_EXPIRY_LEAD_MS, APPROVAL_EXPIRED_THREAD_TEXT, activeForTable,
} from '../plugins/personal-inbox/pending-ledger.mjs';

const H = 3600000;
const THREAD = '100000000000000114';
const expiredInfo = (extra = {}) => ({ kind: '桌面角色六类操作', what: '提交表单:在 Safari 的 test-page.html 里点“提交”', cardId: 'card-9', threadId: THREAD, link: `https://discord.com/channels/1/${THREAD}`, expiredAt: T0, ...extra });

test('登记：截止＝现在＋24 小时、提前量 2 小时、合成编号、来源标记；同一张卡登记两次只一条；不设 firstAskedAt', async () => {
  const t = mk();
  const a = await recordApprovalExpiry(t.path, expiredInfo(), { now: () => T0 });
  assert.equal(a.busy, false);
  const items = t.ledger().items; assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.source, '审批过期'); assert.equal(it.kind, '桌面角色六类操作'); assert.equal(it.deadlineAt, T0 + APPROVAL_EXPIRY_MS); assert.equal(it.leadMs, APPROVAL_EXPIRY_LEAD_MS);
  assert.equal(it.requestMessageId, `审批:桌面角色:card-9:${T0}`); assert.equal(it.firstAskedAt, null); assert.equal(it.status, '没回'); assert.equal(it.threadId, THREAD);
  await recordApprovalExpiry(t.path, expiredInfo(), { now: () => T0 + 1000 });
  assert.equal(t.ledger().items.length, 1, '同一张卡（同卡号同过期时刻）只一条');
  const c = await recordApprovalExpiry(t.path, expiredInfo({ kind: '结案确认', cardId: 'card-7', what: '结案', expiredAt: T0 + 5 }), { now: () => T0 });
  assert.equal(t.ledger().items.at(-1).requestMessageId, `审批:结案:card-7:${T0 + 5}`);
  t.cleanup();
});

test('整个定时任务跑一遍逐条清单：刚登记／截止前 3 小时／截止前 1 小时／截止后——茶会里没有任何点名，审批频道提醒总共 1 条，原线程“过期了”总共 1 条', async () => {
  const t = mk();
  await t.reg({ requestMessageId: 'NORMAL1' }); // 另放一条普通条目，让总表和合并提醒有东西可发
  await recordApprovalExpiry(t.path, expiredInfo(), { now: () => T0 });
  const log = [];
  const run = async (label, at) => { const before = t.sent.length; await t.tick(at); log.push([label, t.sent.slice(before).map((s) => `${s.target}|${s.text.slice(0, 40)}`)]); };
  await run('刚登记', T0 + 60000);
  await run('同一遍再跑一次', T0 + 120000);
  await run('截止前 3 小时', T0 + APPROVAL_EXPIRY_MS - 3 * H);
  await run('截止前 1 小时', T0 + APPROVAL_EXPIRY_MS - 1 * H);
  await run('截止前 1 小时再跑', T0 + APPROVAL_EXPIRY_MS - 1 * H + 1800000);
  await run('截止后', T0 + APPROVAL_EXPIRY_MS + 60000);
  await run('截止后再跑', T0 + APPROVAL_EXPIRY_MS + 1800000);
  const tea = t.sent.filter((s) => s.target === WORKSHOP_CHANNEL);
  assert.ok(tea.every((s) => !s.text.includes('审批过期') && !s.text.includes('快到 24 小时')), `茶会里没有审批过期相关内容：${JSON.stringify(tea.map((s) => s.text.slice(0, 50)))}`);
  const reminders = t.sent.filter((s) => s.target === APPROVAL_CHANNEL_ID);
  assert.equal(reminders.length, 1, JSON.stringify(log)); assert.ok(reminders[0].text.startsWith(`<@${OWNER_ID}>`)); assert.match(reminders[0].text, /快到 24 小时/);
  const threadSays = t.sent.filter((s) => s.target === THREAD);
  assert.equal(threadSays.length, 1); assert.equal(threadSays[0].text, APPROVAL_EXPIRED_THREAD_TEXT);
  assert.equal(t.sent.length, tea.length + 2, '除了茶会里普通条目的消息，总共只多 2 条：审批频道 1、原线程 1');
  const it = t.ledger().items.find(isApprovalExpiry); assert.equal(it.status, '撤销'); assert.equal(it.firstAskedAt, null);
  t.cleanup();
});

test('提前量之前不提醒；截止已过却从没提醒过：只撤销、不补发提醒；发提醒失败下一轮再试', async () => {
  const t = mk(); await recordApprovalExpiry(t.path, expiredInfo(), { now: () => T0 });
  await t.tick(T0 + APPROVAL_EXPIRY_MS - 5 * H);
  assert.equal(t.sent.filter((s) => s.target === APPROVAL_CHANNEL_ID).length, 0);
  let fail = true; const orig = t.discord.send;
  t.discord.send = async (a) => { if (fail && a.target === APPROVAL_CHANNEL_ID) throw new Error('发不出去'); return orig(a); };
  await t.tick(T0 + APPROVAL_EXPIRY_MS - 1 * H);
  assert.equal(t.ledger().items[0].reminded, null, '发失败不记已提醒');
  fail = false; await t.tick(T0 + APPROVAL_EXPIRY_MS - 1 * H + 1800000);
  assert.equal(t.sent.filter((s) => s.target === APPROVAL_CHANNEL_ID).length, 1);
  const t2 = mk(); await recordApprovalExpiry(t2.path, expiredInfo(), { now: () => T0 });
  await t2.tick(T0 + APPROVAL_EXPIRY_MS + 3 * H);
  assert.equal(t2.sent.filter((s) => s.target === APPROVAL_CHANNEL_ID).length, 0, '过了截止不补发提醒');
  assert.equal(t2.ledger().items[0].status, '撤销');
  t.cleanup(); t2.cleanup();
});

test('到期那句只发一次，记在台账文件里：发送抛错（命令超时但消息可能已发出）也算用掉了，下一轮不重发；条目照样撤销', async () => {
  const t = mk(); await recordApprovalExpiry(t.path, expiredInfo(), { now: () => T0 });
  let threadCalls = 0; const orig = t.discord.send; t.discord.send = async (a) => { if (a.target === THREAD) { threadCalls += 1; throw new Error('命令超时'); } return orig(a); };
  const at = T0 + APPROVAL_EXPIRY_MS + 60000;
  await t.tick(at);
  const it = t.ledger().items[0];
  assert.equal(it.status, '撤销'); assert.equal(it.expirySay.state, '结果不明'); assert.match(it.expirySay.why, /命令超时/); assert.equal(threadCalls, 1);
  await t.tick(at + 1800000); await t.tick(at + 3600000);
  assert.equal(threadCalls, 1, '之后任何一轮都不重发');
  t.cleanup();
});

test('到期那句：发成功记消息编号；没拿到编号记结果不明；没有线程就不说话；中途已有“发送中”记录（上一轮进程挂了）也不重发', async () => {
  const ok = mk(); await recordApprovalExpiry(ok.path, expiredInfo(), { now: () => T0 });
  await ok.tick(T0 + APPROVAL_EXPIRY_MS + 60000);
  assert.equal(ok.ledger().items[0].expirySay.state, '已发'); assert.ok(ok.ledger().items[0].expirySay.messageId);
  assert.equal(ok.sent.filter((s) => s.target === THREAD).length, 1);
  const lost = mk(); await recordApprovalExpiry(lost.path, expiredInfo(), { now: () => T0 }); lost.loseId(true);
  await lost.tick(T0 + APPROVAL_EXPIRY_MS + 60000);
  assert.equal(lost.ledger().items[0].expirySay.state, '结果不明');
  const noThread = mk(); await recordApprovalExpiry(noThread.path, expiredInfo({ threadId: null }), { now: () => T0 });
  await noThread.tick(T0 + APPROVAL_EXPIRY_MS + 60000);
  assert.equal(noThread.ledger().items[0].status, '撤销'); assert.equal(noThread.ledger().items[0].expirySay, null);
  const crashed = mk(); await recordApprovalExpiry(crashed.path, expiredInfo(), { now: () => T0 });
  await withLedger(crashed.path, (L) => { L.items[0].expirySay = { state: '发送中', at: T0 }; }, { now: () => T0 });
  await crashed.tick(T0 + APPROVAL_EXPIRY_MS + 60000);
  assert.equal(crashed.sent.filter((s) => s.target === THREAD).length, 0, '有“发送中”记录：不重发'); assert.equal(crashed.ledger().items[0].status, '撤销');
  for (const x of [ok, lost, noThread, crashed]) x.cleanup();
});

test('同一件事又出了新的审批卡 → 条目自动已定，之后不提醒也不撤销；别的卡的不受影响', async () => {
  const t = mk();
  await recordApprovalExpiry(t.path, expiredInfo(), { now: () => T0 });
  await recordApprovalExpiry(t.path, expiredInfo({ cardId: 'card-other', expiredAt: T0 + 7 }), { now: () => T0 });
  const r = await recordApprovalReissue(t.path, { kind: '桌面角色六类操作', cardId: 'card-9' }, { now: () => T0 + H });
  assert.equal(r.closed, 1);
  const [a, b] = t.ledger().items;
  assert.equal(a.status, '已定'); assert.match(a.decision, /重新申请/); assert.equal(b.status, '没回');
  await t.tick(T0 + APPROVAL_EXPIRY_MS + 60000);
  assert.equal(t.sent.filter((s) => s.target === THREAD).length, 1, '只有没处理的那条被撤销并说话（card-other 同线程）');
  assert.equal((await recordApprovalReissue(t.path, { kind: '结案确认', cardId: 'nope' }, { now: () => T0 })).closed, 0);
  assert.equal(closeApprovalExpiryOnReissue({ items: [] }, { kind: '桌面角色六类操作', cardId: 'x' }, T0), 0);
  t.cleanup();
});

test('3 天合并提醒里没有“审批过期”条目；firstAskedAt 仍为空；不进总表', async () => {
  const t = mk();
  await t.reg({ requestMessageId: 'N1', title: '普通一件' });
  await t.tick(T0); // 首点名普通条目，开始计 3 天
  await recordApprovalExpiry(t.path, expiredInfo({ expiredAt: T0 + H }), { now: () => T0 + H });
  await t.tick(T0 + MERGE_INTERVAL_MS + 3 * H);
  const merged = t.sent.filter((s) => s.text.includes('合并提醒'));
  assert.equal(merged.length, 1); assert.ok(!merged[0].text.includes('审批过期'));
  const ae = t.ledger().items.find(isApprovalExpiry); assert.equal(ae.firstAskedAt, null);
  assert.ok(activeForTable(t.ledger(), T0).every((it) => !isApprovalExpiry(it)));
  const table = buildTable(t.ledger(), T0); assert.ok(!table.includes('审批过期'));
  t.cleanup();
});

test('测试条目（probe）手动走同一条路；registerApprovalExpiry 可指定短期限和提前量', async () => {
  const t = mk();
  await withLedger(t.path, (L) => registerApprovalExpiry(L, expiredInfo(), T0, { probe: true, deadlineAt: T0 + 30 * 60000, leadMs: 25 * 60000 }));
  const it = t.ledger().items[0]; assert.equal(it.probe, true);
  await t.tick(T0 + 4 * 60000);
  assert.equal(t.sent.filter((s) => s.target === APPROVAL_CHANNEL_ID).length, 0, '提前量之前不提醒');
  await t.tick(T0 + 10 * 60000);
  assert.equal(t.sent.filter((s) => s.target === APPROVAL_CHANNEL_ID).length, 1, '到提前量提醒');
  await t.tick(T0 + 31 * 60000);
  assert.equal(t.ledger().items[0].status, '撤销');
  t.cleanup();
});

// ───── 新发送代码没明确传发送函数就不发，只记一行 ─────
test('台账适配器没有 send 函数 → 不发提醒、不撤销、不抛错，记一行 approval-expiry-no-send；换成有 send 的下一遍照常', async () => {
  const t = mk(); await recordApprovalExpiry(t.path, expiredInfo(), { now: () => T0 });
  const noSend = { async edit() {}, async pin() {}, async readReplies() { return []; }, async search() { return []; }, async wakeJudge() { return { jobId: 'j' }; } };
  // 普通 runTick 的其余步骤会用到 send（总表）；这里只验证新函数本身
  const actions = [];
  await withLedger(t.path, async (L) => { await runApprovalExpiryTick(L, T0 + APPROVAL_EXPIRY_MS + 60000, noSend, actions); }, { now: () => T0 });
  assert.ok(actions.some((a) => a.type === 'approval-expiry-no-send')); assert.equal(t.ledger().items[0].status, '没回', '没有发送函数：不撤销');
  const r = await runApprovalExpiryTick({ items: [] }, T0, undefined, []); assert.equal(r, undefined);
  await t.tick(T0 + APPROVAL_EXPIRY_MS + 60000);
  assert.equal(t.ledger().items[0].status, '撤销', '有发送函数的下一遍照常');
  t.cleanup();
});
