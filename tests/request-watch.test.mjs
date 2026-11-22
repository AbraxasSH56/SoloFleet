// Offline tests for request watch: temporary directories and fake data only; nothing touches a real deployment.
// “等你定”登记兜底离线测试。运行：node --test tests/request-watch.test.mjs
// 台账用真实的 withLedger 在临时目录里跑，不 mock 锁；Discord 全是假的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAllowedUsers, extractRequest, createRequestWatch, registerRequestWatch, reconcileRequests, readRequestRows, CHAT_CHANNEL, GRACE_MS, AUTO_PREFIX, requestDir, RECONCILE_BUDGET_MS, CALL_TIMEOUT_MS, matchResponse, readResponseRows, responseRowFrom, isClickEvent } from '../plugins/personal-inbox/request-watch.mjs';
import { withLedger, registerItem, updateItem, OWNER_ID } from '../plugins/personal-inbox/pending-ledger.mjs';
import { registerPendingTools } from '../plugins/personal-inbox/pending-tools.mjs';
import { APPROVAL_CHANNEL_ID } from '../plugins/personal-inbox/approval-card.mjs';

// 安全栏（Fable 本文件里任何一处如果漏传数据根，也只会落到这个临时目录，绝不碰真实的“等你定”台账。
const SAFE_ROOT = mkdtempSync(join(tmpdir(), 'rw-safe-'));
process.env.OPENCLAW_DATA_ROOT = SAFE_ROOT;
test.after(() => { rmSync(SAFE_ROOT, { recursive: true, force: true }); });

const T0 = Date.parse('2026-11-22T03:00:00Z'); // 测试时区（UTC+5:30） 13:00
const btn = (users) => ({ type: 'button', label: '选 1', allowedUsers: users });
const sendEvt = (over = {}) => ({
  toolName: 'message',
  params: { action: 'send', target: 'channel:2001', message: '要你定：选哪个？\n1 …\n2 …', presentation: { blocks: [{ type: 'buttons', buttons: [btn([OWNER_ID])] }] }, ...over.params },
  result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, messageId: '9001', channelId: '2001' }) }] },
  ...over.rest,
});

test('认请示：按钮 allowedUsers 里有主人才算；位置不同（presentation／components／深层）都找得到', () => {
  assert.deepEqual(findAllowedUsers({ a: [{ b: { allowedUsers: ['1', '2'] } }], c: { allowedUsers: ['3'] } }), [['1', '2'], ['3']]);
  assert.equal(extractRequest(sendEvt(), { agentId: 'worker-e' }).messageId, '9001');
  const comp = sendEvt({ params: { presentation: undefined, components: [{ type: 1, components: [{ type: 2, custom_id: 'x', allowedUsers: [OWNER_ID] }] }] } });
  assert.ok(extractRequest(comp, { agentId: 'worker-e' }));
  const notOwner = sendEvt({ params: { presentation: { blocks: [{ buttons: [btn(['123'])] }] } } });
  assert.equal(extractRequest(notOwner, { agentId: 'worker-e' }), null);
  assert.equal(extractRequest(sendEvt({ params: { presentation: undefined } }), { agentId: 'worker-e' }), null, '没有按钮');
  assert.equal(extractRequest(sendEvt(), { agentId: 'system-auditor' }), null, '审计角色不记');
  assert.equal(extractRequest(sendEvt(), { agentId: 'task-auditor' }), null);
  assert.equal(extractRequest({ ...sendEvt(), error: 'boom' }, { agentId: 'worker-e' }), null, '发送失败不记');
  assert.equal(extractRequest({ ...sendEvt(), toolName: 'exec' }, { agentId: 'worker-e' }), null, '不是 message 工具');
  assert.equal(extractRequest({ ...sendEvt(), toolName: 'mcp__openclaw__message' }, { agentId: 'worker-e' }).messageId, '9001');
});

test('认请示：消息编号和频道编号从回执里取，取不到就退回用参数里的 target；取不到消息编号也留一行（核账时跳过）', () => {
  const r1 = extractRequest({ ...sendEvt(), result: { details: { message: { id: '9002' }, channel_id: '2002' } } }, { agentId: 'worker-e' });
  assert.equal(r1.messageId, '9002'); assert.equal(r1.channelId, '2002');
  const r2 = extractRequest({ ...sendEvt({ params: { target: 'channel:100000000000000115' } }), result: 'not json' }, { agentId: 'worker-e' });
  assert.equal(r2.messageId, null); assert.equal(r2.channelId, '100000000000000115');
  assert.equal(extractRequest(sendEvt({ params: { message: '【测试】测一下' } }), { agentId: 'worker-e' }).isTest, true);
  assert.equal(extractRequest(sendEvt({ params: { message: '测试环境要不要重启？' } }), { agentId: 'worker-e' }).isTest, false, '“测试环境…”开头的真请示不当测试件');
  assert.equal(extractRequest(sendEvt({ params: { message: '测试结果出来了，要你定' } }), { agentId: 'worker-e' }).isTest, false);
  assert.equal(extractRequest(sendEvt(), { agentId: 'worker-e' }).text, '要你定：选哪个？');
});

test('插件钩子：认出的写一行流水；没认出的什么都不写；写失败不抛错；抓形状开关只在旗标文件存在时才记样本', () => {
  const root = mkdtempSync(join(tmpdir(), 'rw-'));
  try {
    const w = createRequestWatch({ dataRoot: root, now: () => T0 });
    assert.ok(w.afterTool(sendEvt(), { agentId: 'worker-e' }));
    assert.equal(w.afterTool(sendEvt({ params: { presentation: undefined } }), { agentId: 'worker-e' }), null);
    const rows = readFileSync(join(requestDir(root), '2026-11-22.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1); assert.equal(rows[0].messageId, '9001'); assert.equal(rows[0].sentAt, T0); assert.equal(rows[0].agentId, 'worker-e');
    assert.ok(!existsSync(join(requestDir(root), '原始事件样本.jsonl')), '没有旗标不记样本');
    writeFileSync(join(requestDir(root), '抓形状.flag'), '关');
    w.afterTool(sendEvt(), { agentId: 'worker-e' });
    assert.ok(!existsSync(join(requestDir(root), '原始事件样本.jsonl')), '旗标内容是“关”：不记样本');
    writeFileSync(join(requestDir(root), '抓形状.flag'), '开\n');
    w.afterTool(sendEvt(), { agentId: 'worker-e' }); w.beforeTool(sendEvt());
    const samples = readFileSync(join(requestDir(root), '原始事件样本.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(samples.map((s) => s.phase), ['after_tool_call', 'before_tool_call']);
    assert.doesNotThrow(() => createRequestWatch({ dataRoot: '/不存在/也建不了', now: () => T0 }).afterTool(sendEvt(), { agentId: 'worker-e' }));
    assert.doesNotThrow(() => w.afterTool(null, null));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- 核账补登记 ----------
function world() {
  const root = mkdtempSync(join(tmpdir(), 'rw-'));
  const ledger = join(root, '审计', '等你定', '台账.json');
  const st = { clock: T0 + 3600 * 1000, info: {}, infoCalls: [], infoFail: new Set() };
  const discord = { channelInfo: async (id) => { st.infoCalls.push(id); if (st.infoFail.has(id)) throw new Error('读不到'); return st.info[id] ?? { type: 0, parentId: null }; } };
  const note = (row) => { mkdirSync(requestDir(root), { recursive: true }); const day = new Date((row.sentAt ?? T0) + 5.5 * 3600 * 1000).toISOString().slice(0, 10); writeFileSync(join(requestDir(root), `${day}.jsonl`), `${JSON.stringify({ agentId: 'worker-e', text: '要你定：选哪个？', isTest: false, ...row })}\n`, { flag: 'a' }); };
  const recon = (over = {}) => reconcileRequests({ dataRoot: root, ledgerPath: ledger, discord, now: () => st.clock, ...over });
  const items = () => (existsSync(ledger) ? JSON.parse(readFileSync(ledger, 'utf8')).items : []);
  return { root, ledger, st, note, recon, items };
}

test('补登记：发出超过 10 分钟、台账里没有 → 补一行，标题带（程序补登记），autoRegistered 真的存进台账 JSON', async () => {
  const w = world();
  try {
    w.note({ messageId: '9001', channelId: '2001', sentAt: T0 });
    const r = await w.recon();
    assert.equal(r.registered, 1);
    const it = w.items()[0];
    assert.equal(it.autoRegistered, true, '台账 JSON 里要真的有这个字段');
    assert.ok(it.title.startsWith(AUTO_PREFIX)); assert.match(it.title, /要你定：选哪个？/);
    assert.equal(it.requestMessageId, '9001'); assert.equal(it.requestChannelId, '2001'); assert.equal(it.threadId, null, '频道主区域：不填 threadId');
    assert.equal(it.requestLink, 'https://discord.com/channels/100000000000000002/2001/9001'); assert.equal(it.botId, 'worker-e'); assert.equal(it.status, '没回');
    const r2 = await w.recon();
    assert.equal(r2.registered, 0); assert.equal(w.items().length, 1, '再跑一遍不重复');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('补登记：bot 自己登记的行没有 autoRegistered；自己已经登记了的不补、记已核', async () => {
  const w = world();
  try {
    await withLedger(w.ledger, (L) => { registerItem(L, { title: 'bot 自己登记', suggestion: 's', blocks: 'b', requestMessageId: '9001', requestChannelId: '2001' }, T0); return {}; });
    assert.equal(w.items()[0].autoRegistered, false);
    w.note({ messageId: '9001', channelId: '2001', sentAt: T0 });
    const r = await w.recon();
    assert.equal(r.registered, 0); assert.equal(w.items().length, 1); assert.equal(w.items()[0].autoRegistered, false);
    assert.match(JSON.parse(readFileSync(join(requestDir(w.root), '已核.json'), 'utf8')).rows['9001'].result, /已经登记/);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('补登记：10 分钟内不补（让 bot 先登记）；到点才补', async () => {
  const w = world();
  try {
    w.note({ messageId: '9001', channelId: '2001', sentAt: w.st.clock - GRACE_MS + 60000 });
    let r = await w.recon(); assert.equal(r.registered, 0); assert.equal(r.waiting, 1); assert.equal(w.items().length, 0);
    w.st.clock += 120000;
    r = await w.recon(); assert.equal(r.registered, 1);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('补登记：请示发在线程里 → 填 threadId，requestChannelId 是父频道；线程的类型和父频道由 channel info 核出来', async () => {
  const w = world();
  try {
    w.st.info['3001'] = { type: 11, parentId: '2001' };
    w.note({ messageId: '9003', channelId: '3001', sentAt: T0 });
    await w.recon();
    const it = w.items()[0];
    assert.equal(it.threadId, '3001'); assert.equal(it.requestChannelId, '2001');
    assert.equal(it.requestLink, 'https://discord.com/channels/100000000000000002/3001/9003');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('补登记：闲聊茶会主频道、闲聊下的线程、审批频道、审批频道下的线程一律不补', async () => {
  const w = world();
  try {
    w.st.info['3001'] = { type: 11, parentId: CHAT_CHANNEL }; w.st.info['3002'] = { type: 11, parentId: APPROVAL_CHANNEL_ID };
    w.note({ messageId: '1', channelId: CHAT_CHANNEL, sentAt: T0 });
    w.note({ messageId: '2', channelId: '3001', sentAt: T0 });
    w.note({ messageId: '3', channelId: APPROVAL_CHANNEL_ID, sentAt: T0 });
    w.note({ messageId: '4', channelId: '3002', sentAt: T0 });
    const r = await w.recon();
    assert.equal(r.registered, 0); assert.equal(w.items().length, 0); assert.equal(r.skipped, 4);
    assert.ok(!w.st.infoCalls.includes(CHAT_CHANNEL) && !w.st.infoCalls.includes(APPROVAL_CHANNEL_ID), '主频道本身不用查 channel info');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('补登记：channel info 读不到 → 这一遍不补、不记已核；下一遍读到了再补（不猜）；线程却读不出父频道也不补', async () => {
  const w = world();
  try {
    w.note({ messageId: '9001', channelId: '2001', sentAt: T0 });
    w.st.infoFail.add('2001');
    let r = await w.recon(); assert.equal(r.registered, 0); assert.equal(r.waiting, 1); assert.equal(w.items().length, 0);
    w.st.infoFail.clear();
    r = await w.recon(); assert.equal(r.registered, 1);
    w.st.info['3001'] = { type: 11, parentId: null };
    w.note({ messageId: '9004', channelId: '3001', sentAt: T0 });
    r = await w.recon(); assert.equal(r.registered, 0); assert.equal(r.waiting, 1);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('补登记：台账被别人锁着（忙）→ 这一遍不补、不记已核；锁放了再补。没有消息编号的流水跳过。', async () => {
  const w = world();
  try {
    w.note({ messageId: '9001', channelId: '2001', sentAt: T0 });
    w.note({ messageId: null, channelId: '2001', sentAt: T0 });
    mkdirSync(join(w.ledger, '..'), { recursive: true });
    writeFileSync(`${w.ledger}.lock`, JSON.stringify({ at: Date.now(), pid: process.pid }));
    let real = Date.now(); // 假时钟：每次看都往前走 3 秒，几下就过了 5 秒的锁等待
    const r = await w.recon({ now: () => (real += 3000), watchDir: join(w.root, '看护') });
    assert.equal(r.registered, 0); assert.equal(r.waiting, 1); assert.equal(r.skipped, 1);
    assert.ok(!existsSync(join(requestDir(w.root), '已核.json')) || !JSON.parse(readFileSync(join(requestDir(w.root), '已核.json'), 'utf8')).rows['9001']);
    rmSync(`${w.ledger}.lock`);
    assert.equal((await w.recon()).registered, 1);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('补登记：跨零点——昨天 23:50 发的请示今天也扫得到；isTest 带进台账；太久的不再试', async () => {
  const w = world();
  try {
    const justBeforeMidnight = Date.parse('2026-11-22T13:50:00Z'); // 测试时区（UTC+5:30） 23:50
    w.st.clock = Date.parse('2026-11-22T14:30:00Z'); // 测试时区（UTC+5:30） 11-23 00:30
    w.note({ messageId: '9005', channelId: '2001', sentAt: justBeforeMidnight, isTest: true, text: '【测试】请示' });
    assert.equal(readRequestRows(w.root, w.st.clock).length, 1);
    assert.equal((await w.recon()).registered, 1);
    assert.equal(w.items()[0].isTest, true);
    const w2 = world();
    try {
      w2.st.clock = T0 + 3 * 86400000 + 3600000;
      mkdirSync(requestDir(w2.root), { recursive: true });
      w2.note({ messageId: '9006', channelId: '2001', sentAt: w2.st.clock - 3 * 86400000 + 30 * 60000 }); // 在 3 天前的文件里，但读取只扫今天和昨天
      assert.equal(readRequestRows(w2.root, w2.st.clock).length, 0);
    } finally { rmSync(w2.root, { recursive: true, force: true }); }
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('已核记在另一个文件，不改插件追加的流水文件', async () => {
  const w = world();
  try {
    w.note({ messageId: '9001', channelId: '2001', sentAt: T0 });
    const before = readFileSync(join(requestDir(w.root), '2026-11-22.jsonl'), 'utf8');
    await w.recon();
    assert.equal(readFileSync(join(requestDir(w.root), '2026-11-22.jsonl'), 'utf8'), before);
    assert.ok(existsSync(join(requestDir(w.root), '已核.json')));
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

// ---------- 台账字段 ----------
test('registerItem：autoRegistered 默认 false，传了就存', () => {
  const L = { items: [] };
  const a = registerItem(L, { title: 't', suggestion: 's', blocks: 'b', requestMessageId: '1' }, T0).item;
  const b = registerItem(L, { title: 't', suggestion: 's', blocks: 'b', requestMessageId: '2', autoRegistered: true }, T0).item;
  assert.equal(a.autoRegistered, false); assert.equal(b.autoRegistered, true);
});

// ---------- 等你定脚本 ----------
const NODE = process.execPath;
const SCRIPT = fileURLToPath(new URL('../scripts/automation/pending-decisions.mjs', import.meta.url));
test('等你定脚本：核账先于台账、注入的核账会被调用；核账崩了台账照常跑；不注入且带 --ledger（测试）时不核账。台账一律指到临时目录', async () => {
  const { main } = await import('../scripts/automation/pending-decisions.mjs');
  const root = mkdtempSync(join(tmpdir(), 'rw-'));
  try {
    const ledger = join(root, '台账.json'); // 每一次调用都显式带 --ledger 指到这里，不走默认路径
    const order = [];
    const discord = { search: async () => [], readReplies: async () => [], send: async () => ({ messageId: null }), edit: async () => {}, pin: async () => {} };
    const calls = [];
    const realLedger = join(SAFE_ROOT, '审计', '等你定', '台账.json');
    assert.equal(realLedger.startsWith(tmpdir()), true, '默认数据根必须是临时目录');
    await main(['--ledger', ledger], { discord, reconcile: async (a) => { order.push('核账(注入)'); calls.push(a.ledgerPath); return { registered: 2 }; } });
    assert.deepEqual(order, ['核账(注入)']); assert.deepEqual(calls, [ledger], '核账拿到的就是这份临时台账');
    const ok = await main(['--ledger', ledger], { discord, reconcile: async () => { throw new Error('核账崩了'); } });
    assert.equal(ok, 0, '核账崩了，台账照常跑完');
    await main(['--ledger', ledger], { discord });
    assert.deepEqual(order, ['核账(注入)'], '没注入且带 --ledger：不核账');
    assert.ok(!existsSync(realLedger), '默认路径下没有凭空多出台账');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('等你定脚本（命令行）：用假的 openclaw 跑一遍，真的从流水补登记，并且调了 channel info', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwcli-'));
  try {
    const bin = join(dir, 'stub.sh');
    writeFileSync(bin, `#!/bin/bash\necho "$@" >> "${dir}/calls.log"\ncase "$1 $2" in\n  "message channel"*) echo '{"payload":{"channel":{"id":"2001","type":0}}}';;\n  "message send"*) echo '{"payload":{"messageId":"100000000000000116"}}';;\n  "message read"*) echo '{"payload":{"messages":[]}}';;\n  "message pin"*) echo '{"payload":{}}';;\n  *) echo '{}';;\nesac\n`, { mode: 0o755 });
    const sent = Date.now() - 30 * 60000;
    const day = new Date(sent + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    mkdirSync(requestDir(dir), { recursive: true });
    writeFileSync(join(requestDir(dir), `${day}.jsonl`), `${JSON.stringify({ messageId: '100000000000000117', channelId: '2001', agentId: 'worker-e', text: '冒烟请示', isTest: true, sentAt: sent })}\n`);
    const r = spawnSync(NODE, [SCRIPT], { encoding: 'utf8', env: { ...process.env, OPENCLAW_BIN: bin, OPENCLAW_DATA_ROOT: dir } });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /NO_REPLY/);
    const items = JSON.parse(readFileSync(join(dir, '审计', '等你定', '台账.json'), 'utf8')).items;
    assert.equal(items.length, 1); assert.equal(items[0].autoRegistered, true); assert.match(items[0].title, /^（程序补登记）冒烟请示/);
    assert.match(readFileSync(join(dir, 'calls.log'), 'utf8'), /message channel info .*channel:2001/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 核账总预算、同频道只查一次、没变化不写已核.json ----------
test('核账总预算：到 90 秒就停，剩下的留给下一遍（不记已核）；同一个频道当轮只查一次；失败了当轮不重查', async () => {
  assert.equal(RECONCILE_BUDGET_MS, 90000); assert.equal(CALL_TIMEOUT_MS, 60000);
  const w = world();
  try {
    let clock = w.st.clock; const calls = [];
    const discord = { channelInfo: async (id) => { calls.push(id); clock += 40000; if (id === '5003') throw new Error('读不到'); return { type: 0, parentId: null }; } };
    // 同一个频道 2001 两条请示；5003 失败过一次；另有 4 个别的频道
    for (const [m, c] of [['1', '2001'], ['2', '2001'], ['3', '5003'], ['4', '5003'], ['5', '6001'], ['6', '6002'], ['7', '6003']]) w.note({ messageId: m, channelId: c, sentAt: T0 });
    const r = await w.recon({ discord, now: () => clock });
    assert.deepEqual(calls, ['2001', '5003', '6001'], '2001 只查一次；5003 失败后第二条不重查；第三次查完已过 90 秒，停');
    assert.equal(r.budgetStopped, true);
    assert.equal(w.items().length, 3, '2001 的两条和 6001 的一条登记了；失败的、没轮到的都没登记');
    const done = JSON.parse(readFileSync(join(requestDir(w.root), '已核.json'), 'utf8')).rows;
    assert.ok(done['1'] && done['2'] && done['5'] && !done['3'] && !done['4'] && !done['6'] && !done['7'], '没处理的不记已核');
    // 下一遍（预算重置）接着核
    const calls2 = []; let clock2 = w.st.clock + 60000;
    const discord2 = { channelInfo: async (id) => { calls2.push(id); clock2 += 1000; return { type: 0, parentId: null }; } };
    const r2 = await w.recon({ discord: discord2, now: () => clock2 });
    assert.equal(r2.registered, 4); assert.equal(w.items().length, 7); assert.ok(!r2.budgetStopped);
    assert.deepEqual(calls2.sort(), ['5003', '6002', '6003'], '第二轮：2001、6001 的结果上一轮落了盘（频道信息.json），不再重查；只查失败的和没轮到的');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('没有流水、没有变化时不写已核.json（不凭空建目录、不每半小时刷修改时间）；两天以上的已核记录会被清掉', async () => {
  const w = world();
  try {
    await w.recon();
    assert.ok(!existsSync(requestDir(w.root)), '没有流水：不建目录');
    w.note({ messageId: '9001', channelId: '2001', sentAt: T0 });
    await w.recon();
    const f = join(requestDir(w.root), '已核.json');
    const m1 = readFileSync(f, 'utf8');
    await w.recon(); // 第二遍：什么都没变
    assert.equal(readFileSync(f, 'utf8'), m1);
    w.st.clock += 4 * 24 * 3600 * 1000; // 4 天以后：已核记录过期被清
    await w.recon();
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')).rows, {});
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('核账把本轮还剩的预算传给 channelInfo（实际命令超时由调用方取它和 60 秒里小的）', async () => {
  const w = world();
  try {
    const got = []; let clock = w.st.clock;
    const discord = { channelInfo: async (id, remaining) => { got.push(remaining); clock += 10000; return { type: 0, parentId: null }; } };
    for (const [m, c] of [['1', '2001'], ['2', '3001'], ['3', '4001']]) w.note({ messageId: m, channelId: c, sentAt: T0 });
    await w.recon({ discord, now: () => clock });
    assert.deepEqual(got, [90000, 80000, 70000], '第一个查询时还剩 90 秒，之后依次减少');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

// ---------- B 组：他已经回应了就不补；补错了总控能撤销 ----------
const withReplies = (w, fn) => ({ channelInfo: async (id) => w.st.info[id] ?? { type: 0, parentId: null }, readReplies: async (q) => fn(q) });

test('B 组：线程里他在原请示之后说过话 → 不补登记，记已核（不再点名他）', async () => {
  const w = world();
  try {
    w.st.info['3001'] = { type: 11, parentId: '2001' };
    w.note({ messageId: '9001', channelId: '3001', sentAt: T0 });
    const seen = [];
    const r = await w.recon({ discord: withReplies(w, (q) => { seen.push(q); return [{ id: '9100', authorId: OWNER_ID, replyToId: null, channelId: '3001' }]; }) });
    assert.equal(r.registered, 0); assert.equal(w.items().length, 0);
    assert.match(JSON.parse(readFileSync(join(requestDir(w.root), '已核.json'), 'utf8')).rows['9001'].result, /已经.*回应/);
    assert.deepEqual(seen, [{ threadId: '3001', requestChannelId: '2001', requestMessageId: '9001' }]);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('B 组：频道主区域——他回复了这条请示才算回应；他在同频道说别的话不算；别人说话不算；读不到回应→这一遍不补', async () => {
  const w = world();
  try {
    w.note({ messageId: '9001', channelId: '2001', sentAt: T0 });
    w.note({ messageId: '9002', channelId: '2002', sentAt: T0 });
    w.note({ messageId: '9003', channelId: '2003', sentAt: T0 });
    w.note({ messageId: '9004', channelId: '2004', sentAt: T0 });
    const table = {
      9001: [{ id: 'a', authorId: OWNER_ID, replyToId: '9001', channelId: '2001' }], // 回复了：不补
      9002: [{ id: 'b', authorId: OWNER_ID, replyToId: null, channelId: '2002' }], // 同频道说别的：照补
      9003: [{ id: 'c', authorId: '12345', replyToId: '9003', channelId: '2003' }], // 别人回复：照补
    };
    const r = await w.recon({ discord: withReplies(w, (q) => { if (q.requestMessageId === '9004') throw new Error('读不到'); return table[q.requestMessageId] ?? []; }) });
    assert.equal(r.registered, 2); assert.deepEqual(w.items().map((i) => i.requestMessageId).sort(), ['9002', '9003']);
    assert.equal(r.waiting, 1, '9004 读不到回应：这一遍不补，留给下一遍');
    const done = JSON.parse(readFileSync(join(requestDir(w.root), '已核.json'), 'utf8')).rows;
    assert.ok(done['9001'] && done['9002'] && done['9003'] && !done['9004']);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('B 组安全阀：程序补登记的条目总控可以撤销（不要主人的消息，但必须写依据）；不能借此判已定／收到；普通条目规则不变', () => {
  const L = { items: [] };
  const auto = registerItem(L, { title: '（程序补登记）x', suggestion: 's', blocks: 'b', requestMessageId: '1', autoRegistered: true }, T0).item;
  const norm = registerItem(L, { title: '普通', suggestion: 's', blocks: 'b', requestMessageId: '2' }, T0).item;
  assert.match(updateItem(L, { id: auto.id, status: '撤销', source: '无' }, null, T0).error, /对应依据/);
  assert.match(updateItem(L, { id: auto.id, status: '已定', decision: 'x', source: '无', basis: '随便' }, null, T0).error, /没有读到/, '不能借阀门判已定');
  assert.match(updateItem(L, { id: auto.id, status: '收到', source: '无', basis: '随便' }, null, T0).error, /没有读到/);
  const ok = updateItem(L, { id: auto.id, status: '撤销', source: '无', basis: '他已经点了按钮，事情办完了' }, null, T0);
  assert.equal(ok.item.status, '撤销'); assert.match(ok.item.decisionSource, /误报/); assert.equal(ok.item.decisionBasis, '他已经点了按钮，事情办完了');
  assert.match(updateItem(L, { id: norm.id, status: '撤销', source: '无', basis: '想撤' }, null, T0).error, /没有读到/, '普通条目仍然要他本人的消息');
});

test('B 组安全阀（工具层）：pending_decision_update 对程序补登记的条目撤销时不去读 Discord 消息；对普通条目仍然读', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rw-'));
  try {
    const ledger = join(root, '台账.json'); let reads = 0;
    const tools = {}; registerPendingTools({ registerTool: (def) => { const t = def.create({ agentId: 'main' }); if (t) tools[t.name] = t; } }, { ledgerPath: ledger, readMessage: async () => { reads++; return null; }, now: () => Date.now() });
    await withLedger(ledger, (L) => { registerItem(L, { title: '（程序补登记）x', suggestion: 's', blocks: 'b', requestMessageId: '1', autoRegistered: true }, Date.now()); registerItem(L, { title: '普通', suggestion: 's', blocks: 'b', requestMessageId: '2' }, Date.now()); return {}; });
    const items = JSON.parse(readFileSync(ledger, 'utf8')).items;
    const r1 = await tools.pending_decision_update.execute('x', { id: items[0].id, status: '撤销', source: '无', basis: '他点过按钮了' });
    assert.equal(r1.details.ok, true); assert.equal(reads, 0);
    const r2 = await tools.pending_decision_update.execute('x', { id: items[1].id, status: '撤销', source: '123' });
    assert.equal(r2.details.ok, false); assert.equal(reads, 1, '普通条目仍然去读那条消息');
    assert.equal(JSON.parse(readFileSync(ledger, 'utf8')).items[0].status, '撤销');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('接线：index.mjs 引入并注册了 request-watch（有资料根才注册），且不碰台账', () => {
  const src = readFileSync(new URL('../plugins/personal-inbox/index.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ createRequestWatch, registerRequestWatch \} from '\.\/request-watch\.mjs'/);
  assert.match(src, /if \(dataRoot\) registerRequestWatch\(api, createRequestWatch\(\{ dataRoot,/);
  const mod = readFileSync(new URL('../plugins/personal-inbox/request-watch.mjs', import.meta.url), 'utf8');
  assert.ok(!/withLedger\(.*记流水|appendFileSync\(.*台账/.test(mod.split('// ---------- ② 核账补登记')[0]), '插件这一半只追加流水，不写台账');
  const api = { calls: [], on(name, fn, opt) { this.calls.push([name, opt.registrationId]); } };
  registerRequestWatch(api, createRequestWatch({ dataRoot: '/不存在' }));
  assert.deepEqual(api.calls.map((c) => c[0]), ['before_tool_call', 'after_tool_call', 'message_received']);
});

test('用 2026-11-22 抓到的真实事件（执行者E发的带按钮测试请示）验证：认得出、消息编号／频道编号取对、按钮在 components.blocks 里', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/button-request-after_tool_call.json', import.meta.url), 'utf8'));
  assert.equal(fx.toolName, 'message');
  assert.ok(findAllowedUsers(fx.params).some((l) => l.includes(OWNER_ID)));
  const r = extractRequest(fx, { agentId: 'worker-e' });
  assert.equal(r.messageId, '100000000000000118'); assert.equal(r.channelId, '100000000000000119');
  assert.equal(r.agentId, 'worker-e'); assert.equal(r.text, '【测试】请示：选 1 还是选 2？'); assert.equal(r.isTest, true);
  assert.equal(extractRequest(fx, { agentId: 'system-auditor' }), null);
});

test('“读他有没有回应”也套进单轮总预算——传剩余预算（最多 60 秒），到预算就停，总用时不超过 90 秒＋一条最长的', async () => {
  const w = world();
  try {
    let clock = w.st.clock; const infoCalls = [], replyCalls = [];
    const discord = {
      channelInfo: async (id) => { infoCalls.push(id); clock += 20000; return { type: 0, parentId: null }; },
      readReplies: async (q, remaining) => { replyCalls.push([q.requestMessageId, remaining]); clock += 30000; return []; },
    };
    for (const [m, c] of [['1', '2001'], ['2', '2002'], ['3', '2003'], ['4', '2004']]) w.note({ messageId: m, channelId: c, sentAt: T0 });
    const r = await w.recon({ discord, now: () => clock });
    // 每条：查频道 20 秒＋读回应 30 秒＝50 秒。第一条读回应时已过 20 秒、剩 70 秒→取 60 秒；第二条开始时已过 50 秒，查完频道 70 秒，读回应只剩 20 秒；做完是 100 秒＞90 秒→第三条不再开始
    assert.deepEqual(replyCalls, [['1', 60000], ['2', 20000]]);
    assert.equal(r.budgetStopped, true); assert.equal(w.items().length, 2, '处理了的登记，没轮到的不登记也不记已核');
    assert.ok(clock - w.st.clock <= 90000 + 50000, `总用时 ${clock - w.st.clock} 毫秒`);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('回执里没有 raw.channelId 时，频道编号退回回执顶层的 to／result.target.id', () => {
  const mk = (resultObj) => ({ toolName: 'message', params: { action: 'send', message: '【测试】x', components: { blocks: [{ buttons: [{ label: 'a', allowedUsers: [OWNER_ID] }] }] } }, result: { content: [{ type: 'text', text: JSON.stringify(resultObj) }] } });
  const a = extractRequest(mk({ to: 'channel:100000000000000119', result: { messageId: '100000000000000118' } }), { agentId: 'worker-e' });
  assert.equal(a.channelId, '100000000000000119'); assert.equal(a.messageId, '100000000000000118');
  const b = extractRequest(mk({ result: { target: { kind: 'channel', id: '100000000000000120' }, messageId: '100000000000000121' } }), { agentId: 'worker-e' });
  assert.equal(b.channelId, '100000000000000120');
});

// =====================================================================================================
// 补登记修改：回应记录（含按钮点击）、频道信息缓存、慢命令、隔离验证
// =====================================================================================================
const respNote = (root, row, day = '2026-11-22') => { mkdirSync(requestDir(root), { recursive: true }); writeFileSync(join(requestDir(root), `回应-${day}.jsonl`), `${JSON.stringify(row)}\n`, { flag: 'a' }); };
const THREAD_INFO = { type: 11, parentId: '2001' };
const spyDiscord = (w, { replies = () => [] } = {}) => { const calls = { info: [], replies: [], other: [] }; return { calls, discord: { channelInfo: async (id) => { calls.info.push(id); return w.st.info[id] ?? { type: 0, parentId: null }; }, readReplies: async (q) => { calls.replies.push(q.requestMessageId); return replies(q); }, send: async () => { calls.other.push('send'); }, edit: async () => { calls.other.push('edit'); }, pin: async () => { calls.other.push('pin'); } } }; };

test('①-2 匹配口径 matchResponse：线程请示只认同一线程、时间不早于请示；主区域只认 click 或回复了这条请示的；同频道别的聊天不算；子线程不串到主区域', () => {
  const T = T0 + 1000;
  const th = { threadId: '3001', requestChannelId: '2001', requestMessageId: '9001', sentAt: T };
  assert.equal(matchResponse([{ at: T + 5, threadId: '3001', channelId: '2001', kind: 'message' }], th), true, '线程：threadId 对');
  assert.equal(matchResponse([{ at: T + 5, threadId: null, channelId: '3001', kind: 'message' }], th), true, '线程：只有 channelId＝线程编号也认');
  assert.equal(matchResponse([{ at: T + 5, threadId: '3999', channelId: '2001', kind: 'click' }], th), false, '别的线程不算');
  assert.equal(matchResponse([{ at: T + 5, threadId: null, channelId: '2001', kind: 'click' }], th), false, '线程请示：父频道主区域里的点击不算');
  assert.equal(matchResponse([{ at: T - 1, threadId: '3001', channelId: '3001', kind: 'message' }], th), false, '早于请示的不算');
  const main = { threadId: null, requestChannelId: '2001', requestMessageId: '9001', sentAt: T };
  assert.equal(matchResponse([{ at: T + 5, channelId: '2001', threadId: null, kind: 'click' }], main), true, '主区域：点击算');
  assert.equal(matchResponse([{ at: T + 5, channelId: '2001', threadId: null, kind: 'message', replyToId: '9001' }], main), true, '主区域：回复了这条请示算');
  assert.equal(matchResponse([{ at: T + 5, channelId: '2001', threadId: null, kind: 'message', replyToId: '1234' }], main), false, '主区域：回复了别的消息不算');
  assert.equal(matchResponse([{ at: T + 5, channelId: '2001', threadId: null, kind: 'message' }], main), false, '主区域：他在同频道说别的话不算（第 326～335 行锁死的口径）');
  assert.equal(matchResponse([{ at: T + 5, channelId: '2001', threadId: '3001', kind: 'click' }], main), false, '子线程里的发言不能串算到主区域');
  assert.equal(matchResponse([{ at: T + 5, channelId: '2002', threadId: null, kind: 'click' }], main), false, '别的频道不算');
  assert.equal(matchResponse([{ at: T - 5, channelId: '2001', threadId: null, kind: 'click' }], main), false, '早于请示的不算');
  assert.equal(matchResponse([], main), false); assert.equal(matchResponse(null, main), false);
});

test('①-2 核账用回应记录：线程里有他的回应 → 不补登记、记已核、不再调 readReplies（省掉那次慢命令）；没有 → 照旧读线程再补', async () => {
  const w = world();
  try {
    w.st.info['3001'] = THREAD_INFO; w.st.info['3002'] = { type: 11, parentId: '2001' };
    w.note({ messageId: '9001', channelId: '3001', sentAt: T0 });
    w.note({ messageId: '9002', channelId: '3002', sentAt: T0 });
    respNote(w.root, { at: T0 + 60000, channelId: '3001', threadId: '3001', messageId: 'x1', replyToId: null, kind: 'click' });
    const spy = spyDiscord(w);
    const r = await w.recon({ discord: spy.discord });
    assert.deepEqual(spy.calls.replies, ['9002'], '9001 命中回应记录，没读线程；9002 没命中，照读');
    assert.equal(r.byResponseLog, 1); assert.equal(r.registered, 1); assert.deepEqual(w.items().map((i) => i.requestMessageId), ['9002']);
    assert.match(JSON.parse(readFileSync(join(requestDir(w.root), '已核.json'), 'utf8')).rows['9001'].result, /回应记录/);
    assert.deepEqual(spy.calls.other, [], '核账不发消息、不编辑、不置顶');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('①-2 主区域请示：click 命中跳过；普通聊天、子线程发言、早于请示的都不命中，照旧走读消息再补', async () => {
  const w = world();
  try {
    for (const [m, c] of [['9001', '2001'], ['9002', '2002'], ['9003', '2003'], ['9004', '2004']]) w.note({ messageId: m, channelId: c, sentAt: T0 + 100000 });
    respNote(w.root, { at: T0 + 200000, channelId: '2001', threadId: null, messageId: 'a', replyToId: null, kind: 'click' }); // 命中
    respNote(w.root, { at: T0 + 200000, channelId: '2002', threadId: null, messageId: 'b', replyToId: null, kind: 'message' }); // 同频道普通聊天：不算
    respNote(w.root, { at: T0 + 200000, channelId: '2003', threadId: '7777', messageId: 'c', replyToId: null, kind: 'click' }); // 子线程里的点击：不串到主区域
    respNote(w.root, { at: T0 + 50000, channelId: '2004', threadId: null, messageId: 'd', replyToId: null, kind: 'click' }); // 早于请示：不算
    const spy = spyDiscord(w);
    const r = await w.recon({ discord: spy.discord });
    assert.deepEqual(spy.calls.replies.sort(), ['9002', '9003', '9004']); assert.equal(r.byResponseLog, 1);
    assert.deepEqual(w.items().map((i) => i.requestMessageId).sort(), ['9002', '9003', '9004']);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('①-2 读回应记录只扫今天和昨天；坏行跳过；没有这个文件也不报错', () => {
  const w = world();
  try {
    assert.deepEqual(readResponseRows(w.root, w.st.clock), []);
    respNote(w.root, { at: 1, kind: 'click', channelId: '1' }, '2026-11-22'); respNote(w.root, { at: 2, kind: 'click', channelId: '2' }, '2026-11-21'); respNote(w.root, { at: 3, kind: 'click', channelId: '3' }, '2026-11-18');
    writeFileSync(join(requestDir(w.root), '回应-2026-11-22.jsonl'), '坏行\n', { flag: 'a' });
    assert.deepEqual(readResponseRows(w.root, T0).map((x) => x.channelId).sort(), ['1', '2']);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

// ---------- ①-4 钩子：只观察、只记主人的、不记正文、三处字段都认、开关 ----------
const inbound = (over = {}) => ({ content: '这是正文：绝密内容 12345', metadata: { senderId: OWNER_ID, channelId: '3001', threadId: '3001', messageId: '8001' }, ...over });
const readResp = (root) => { try { return readFileSync(join(requestDir(root), '回应-2026-11-22.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };

test('①-4 钩子 received：只记主人发的；编号在 event／event.metadata／ctx 任一处都认；不记正文；永远返回 undefined', () => {
  const root = mkdtempSync(join(tmpdir(), 'rw-'));
  try {
    const w = createRequestWatch({ dataRoot: root, now: () => T0 });
    assert.equal(w.received(inbound(), {}), undefined);
    assert.equal(w.received({ content: 'x', senderId: OWNER_ID, channelId: '2001', messageId: '8002' }, {}), undefined, 'event 顶层');
    assert.equal(w.received({ content: 'x' }, { senderId: `discord:${OWNER_ID}`, channelId: '2002', messageId: '8003' }), undefined, 'ctx，编号带前缀');
    assert.equal(w.received({ content: 'x', metadata: { from: { id: OWNER_ID }, conversationId: '2003', id: '8004' } }, {}), undefined, 'from 是对象、conversationId、id');
    w.received(inbound({ metadata: { senderId: '1111111', channelId: '3001', messageId: '8005' } }), {}); // 别人
    w.received({ content: 'x', metadata: { senderId: OWNER_ID } }, {}); // 认不出频道
    const rows = readResp(root);
    assert.deepEqual(rows.map((r) => r.messageId), ['8001', '8002', '8003', '8004']);
    assert.ok(rows.every((r) => r.at === T0 && ['click', 'message'].includes(r.kind)));
    assert.ok(!readFileSync(join(requestDir(root), '回应-2026-11-22.jsonl'), 'utf8').includes('绝密'), '不记正文');
    assert.deepEqual(Object.keys(rows[0]).sort(), ['at', 'channelId', 'kind', 'messageId', 'replyToId', 'threadId']);
    assert.equal(rows[0].threadId, '3001');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('①-4 钩子：同一条消息编号去重；回应记录.flag 写“关”不记（写别的、没有都照记）；出错吞掉不抛', () => {
  const root = mkdtempSync(join(tmpdir(), 'rw-'));
  try {
    const w = createRequestWatch({ dataRoot: root, now: () => T0 });
    w.received(inbound(), {}); w.received(inbound(), {}); w.received(inbound(), {});
    assert.equal(readResp(root).length, 1, '同一条 8001 只记一行（14 个账号可能各收一遍）');
    mkdirSync(requestDir(root), { recursive: true });
    writeFileSync(join(requestDir(root), '回应记录.flag'), '关\n');
    w.received(inbound({ metadata: { senderId: OWNER_ID, channelId: '3001', messageId: '8010' } }), {});
    assert.equal(readResp(root).length, 1, '“关”：不记');
    writeFileSync(join(requestDir(root), '回应记录.flag'), '开');
    w.received(inbound({ metadata: { senderId: OWNER_ID, channelId: '3001', messageId: '8011' } }), {});
    assert.equal(readResp(root).length, 2, '内容不是“关”照记');
    assert.doesNotThrow(() => createRequestWatch({ dataRoot: '/不存在/也建不了', now: () => T0 }).received(inbound(), {}));
    assert.equal(w.received(null, null), undefined); assert.doesNotThrow(() => w.received(undefined, undefined));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('①-4 认点击 isClickEvent：键名、type／kind 字段值、正文开头都能认；普通消息不当点击', () => {
  assert.equal(isClickEvent({ content: '你好' , metadata: {} }, {}), false);
  assert.equal(isClickEvent({ content: 'x', metadata: { interaction: { id: 1 } } }, {}), true);
  assert.equal(isClickEvent({ content: 'x', metadata: { type: 'component' } }, {}), true);
  assert.equal(isClickEvent({ content: 'x' }, { kind: 'button_click' }), true);
  assert.equal(isClickEvent({ content: 'Clicked “允许”' }, {}), true);
  assert.equal(isClickEvent({ content: '点击了允许' }, {}), true);
  assert.equal(responseRowFrom(inbound({ metadata: { senderId: OWNER_ID, channelId: '3001', custom_id: 'occomp:cid=btn_x' } }), {}, T0).kind, 'click');
  assert.equal(responseRowFrom(inbound(), {}, T0).kind, 'message');
});

test('①-4 形状样本：用单独的开关“回应抓形状.flag”（不再复用 抓形状.flag）；过滤前只记键名、编号有没有、正文长度；不记任何人的正文；测试线程名单里主人的才多记前 20 字', () => {
  const root = mkdtempSync(join(tmpdir(), 'rw-'));
  try {
    const w = createRequestWatch({ dataRoot: root, now: () => T0 });
    const sample = () => { try { return readFileSync(join(requestDir(root), '回应形状样本.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
    w.received(inbound(), {}); assert.deepEqual(sample(), [], '没有旗标：不记样本');
    mkdirSync(requestDir(root), { recursive: true });
    writeFileSync(join(requestDir(root), '抓形状.flag'), '开'); // 旧开关（工具调用那个）
    w.received(inbound(), {}); assert.deepEqual(sample(), [], '旧的 抓形状.flag 不触发新样本');
    writeFileSync(join(requestDir(root), '回应抓形状.flag'), '关'); w.received(inbound(), {}); assert.deepEqual(sample(), [], '“关”不记');
    writeFileSync(join(requestDir(root), '回应抓形状.flag'), '开\n');
    w.received(inbound({ metadata: { senderId: '1111111', channelId: '3001', messageId: '8101' }, content: '别人的私话：不许落盘' }), { agentId: 'worker-e', sessionKey: 's' }); // 过滤前采，别人的也采，但只记形状
    w.received(inbound({ metadata: { senderId: OWNER_ID, channelId: '3001', threadId: '3001', messageId: '8102' }, content: '主人的话：也不许落盘' }), {});
    let s = sample();
    assert.equal(s.length, 2); assert.equal(s[0].senderIsOwner, false); assert.equal(s[1].senderIsOwner, true);
    assert.deepEqual(s[0].has, { senderId: true, channelId: true, threadId: false, messageId: true, replyToId: false });
    assert.deepEqual(s[0].keys.event.sort(), ['content', 'metadata']); assert.ok(s[0].keys.metadata.includes('senderId')); assert.deepEqual(s[0].keys.ctx, ['agentId', 'sessionKey']);
    assert.equal(s[0].contentLen, '别人的私话：不许落盘'.length);
    const raw = readFileSync(join(requestDir(root), '回应形状样本.jsonl'), 'utf8');
    assert.ok(!raw.includes('私话') && !raw.includes('主人的话'), '正文一个字不落盘（没列进测试线程名单时）');
    assert.ok(s.every((x) => x.contentHead === undefined));
    writeFileSync(join(requestDir(root), '回应抓形状.线程.txt'), '3001\n9999\n');
    w.received(inbound({ metadata: { senderId: OWNER_ID, channelId: '3001', threadId: '3001', messageId: '8103' }, content: '一二三四五六七八九十一二三四五六七八九十多出来的' }), {});
    w.received(inbound({ metadata: { senderId: '1111111', channelId: '3001', threadId: '3001', messageId: '8104' }, content: '别人在名单线程里的私话' }), {});
    s = sample();
    assert.equal(s[2].contentHead, '一二三四五六七八九十一二三四五六七八九十', '主人在名单线程里：只记前 20 个字');
    assert.equal(s[3].contentHead, undefined, '别人即使在名单线程里也不记正文');
    assert.ok(!readFileSync(join(requestDir(root), '回应形状样本.jsonl'), 'utf8').includes('别人在名单线程里的私话'));
    // 旧的工具调用样本只受旧开关管：旧旗标写“关”，新旗标是“开”时，工具调用不记样本
    writeFileSync(join(requestDir(root), '抓形状.flag'), '关');
    w.afterTool(sendEvt(), { agentId: 'worker-e' });
    assert.ok(!existsSync(join(requestDir(root), '原始事件样本.jsonl')), '新旗标是“开”也不会让旧的工具调用样本开始记');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('①-4 形状样本文件超过 200 KB 不再写', () => {
  const root = mkdtempSync(join(tmpdir(), 'rw-'));
  try {
    const w = createRequestWatch({ dataRoot: root, now: () => T0 });
    mkdirSync(requestDir(root), { recursive: true }); writeFileSync(join(requestDir(root), '回应抓形状.flag'), '开');
    writeFileSync(join(requestDir(root), '回应形状样本.jsonl'), 'x'.repeat(200 * 1024 + 1));
    w.received(inbound(), {});
    assert.equal(readFileSync(join(requestDir(root), '回应形状样本.jsonl'), 'utf8').length, 200 * 1024 + 1, '超限后不再追加');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- ② 频道信息缓存 ----------
const readInfoFile = (root) => JSON.parse(readFileSync(join(requestDir(root), '频道信息.json'), 'utf8'));
test('②-2 缓存只存合法完整的：成功的落盘；报错的、线程拿不到父频道的不落盘；没变化不重写；权限 600', async () => {
  const w = world();
  try {
    w.st.info['3001'] = { type: 11, parentId: '2001' }; w.st.info['3002'] = { type: 11, parentId: null }; w.st.infoFail.add('2003');
    for (const [m, c] of [['1', '2001'], ['2', '3001'], ['3', '3002'], ['4', '2003']]) w.note({ messageId: m, channelId: c, sentAt: T0 });
    await w.recon();
    const f = readInfoFile(w.root);
    assert.deepEqual(Object.keys(f.channels).sort(), ['2001', '3001'], '失败的 2003、线程缺父频道的 3002 都没落盘');
    assert.deepEqual({ type: f.channels['3001'].type, parentId: f.channels['3001'].parentId }, { type: 11, parentId: '2001' });
    assert.equal((await import('node:fs')).statSync(join(requestDir(w.root), '频道信息.json')).mode & 0o777, 0o600);
    const before = readFileSync(join(requestDir(w.root), '频道信息.json'), 'utf8');
    w.st.infoFail.clear(); w.st.info['3002'] = { type: 11, parentId: '2001' }; w.st.info['2003'] = { type: 0, parentId: null };
    await w.recon(); // 这一轮补上失败的两个
    assert.deepEqual(Object.keys(readInfoFile(w.root).channels).sort(), ['2001', '2003', '3001', '3002']);
    const mid = readFileSync(join(requestDir(w.root), '频道信息.json'), 'utf8');
    await w.recon(); // 什么都没变
    assert.equal(readFileSync(join(requestDir(w.root), '频道信息.json'), 'utf8'), mid, '没有新增键不重写');
    assert.notEqual(before, mid);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('②-2 缓存命中不再调 channelInfo；预算中途停了，已查到的也落盘；30 天没用的键清掉；缓存里有损坏的键被丢掉', async () => {
  const w = world();
  try {
    mkdirSync(requestDir(w.root), { recursive: true });
    writeFileSync(join(requestDir(w.root), '频道信息.json'), JSON.stringify({ channels: {
      2001: { type: 0, parentId: null, at: w.st.clock - 1000 },
      4001: { type: 11, parentId: null, at: w.st.clock - 1000 }, // 线程却没有父频道：丢
      5001: { type: 0, parentId: null, at: w.st.clock - 31 * 86400000 }, // 31 天没用：丢
    } }));
    let clock = w.st.clock; const calls = [];
    const discord = { channelInfo: async (id) => { calls.push(id); clock += 60000; return { type: 0, parentId: null }; } };
    for (const [m, c] of [['1', '2001'], ['2', '4001'], ['3', '5001'], ['4', '6001']]) w.note({ messageId: m, channelId: c, sentAt: T0 });
    const r = await w.recon({ discord, now: () => clock });
    assert.deepEqual(calls, ['4001', '5001'], '2001 命中缓存不调；4001、5001 的缓存被丢掉重查；每次 60 秒，两次后 120 秒＞90 秒，6001 没轮到');
    assert.equal(r.budgetStopped, true);
    const f = readInfoFile(w.root).channels;
    assert.deepEqual(Object.keys(f).sort(), ['2001', '4001', '5001'], '预算停了也落盘：新查到的 4001、5001 在；6001 没轮到不在');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('②-1／②-3 慢命令：每条 30 秒时 90 秒预算够做完 1 条请示（查频道＋读回应），第 2 条查完频道后预算用完留到下一轮（频道信息已落盘，下一轮不重查）；慢命令记 request-call-slow 日志', async () => {
  const w = world();
  try {
    let clock = w.st.clock; const calls = []; const logs = [];
    const discord = { channelInfo: async (id) => { calls.push(['info', id]); clock += 30000; return { type: 0, parentId: null }; }, readReplies: async (q, remaining) => { calls.push(['replies', q.requestMessageId, remaining]); clock += 30000; return []; } };
    w.note({ messageId: '1', channelId: '2001', sentAt: T0 }); w.note({ messageId: '2', channelId: '2002', sentAt: T0 }); w.note({ messageId: '3', channelId: '2003', sentAt: T0 });
    const r = await w.recon({ discord, now: () => clock, log: (x) => logs.push(x) });
    assert.deepEqual(calls, [['info', '2001'], ['replies', '1', 60000], ['info', '2002']], '第 1 条做完（60 秒），第 2 条查完频道时已 90 秒，读回应前预算到，停');
    assert.equal(r.registered, 1); assert.equal(r.budgetStopped, true);
    assert.ok(logs.filter((x) => x.event === 'request-call-slow').length >= 3 && logs.every((x) => x.event !== 'request-call-slow' || (x.ms === 30000 && ['channelInfo', 'readReplies'].includes(x.what))));
    const calls2 = []; let clock2 = clock + 1800000;
    const r2 = await w.recon({ discord: { channelInfo: async (id) => { calls2.push(['info', id]); clock2 += 1000; return { type: 0, parentId: null }; }, readReplies: async (q) => { calls2.push(['replies', q.requestMessageId]); clock2 += 1000; return []; } }, now: () => clock2 });
    assert.deepEqual(calls2, [['replies', '2'], ['info', '2003'], ['replies', '3']], '第二轮：2002 的频道信息读缓存，只读回应；再做第 3 条');
    assert.equal(r2.registered, 2);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('②-1 命令失败也记一行耗时日志（request-call-failed-timing），仍按老办法不补、不记已核', async () => {
  const w = world();
  try {
    let clock = w.st.clock; const logs = [];
    const discord = { channelInfo: async () => { clock += 15000; throw new Error('spawnSync openclaw ETIMEDOUT'); } };
    w.note({ messageId: '1', channelId: '2001', sentAt: T0 });
    const r = await w.recon({ discord, now: () => clock, log: (x) => logs.push(x) });
    assert.equal(r.registered, 0); assert.equal(r.waiting, 1);
    assert.ok(logs.some((x) => x.event === 'request-call-failed-timing' && x.what === 'channelInfo' && x.ms === 15000));
    assert.ok(logs.some((x) => x.event === 'request-channel-info-failed'));
    assert.ok(!existsSync(join(requestDir(w.root), '已核.json')) && !existsSync(join(requestDir(w.root), '频道信息.json')), '失败的不记已核也不落盘缓存');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

// ---------- ①-1 隔离验证：只单独调 reconcileRequests，不碰真实目录、不发消息 ----------
test('①-1 隔离验证做法：临时数据根里只调 reconcileRequests、台账写临时台账；Discord 只有只读的 channelInfo／readReplies；默认数据根（真实目录的替身 SAFE_ROOT）一个文件都没多', async () => {
  const w = world();
  const before = readdirSync(SAFE_ROOT);
  try {
    w.note({ messageId: '9001', channelId: '2001', sentAt: T0 });
    const spy = spyDiscord(w);
    const readOnly = { channelInfo: spy.discord.channelInfo, readReplies: spy.discord.readReplies };
    const r = await w.recon({ discord: readOnly }); // 没有 send／edit／pin／search／wakeJudge：谁调就会 TypeError
    assert.equal(r.registered, 1); assert.deepEqual(spy.calls.other, []);
    assert.ok(w.ledger.startsWith(w.root), '台账在临时数据根里');
    assert.deepEqual(readdirSync(SAFE_ROOT), before, '默认数据根（SAFE_ROOT，真实目录的替身）没有任何新文件');
    assert.ok(existsSync(join(requestDir(w.root), '已核.json')), '已核记在临时数据根里');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});
