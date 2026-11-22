// Offline tests for completion notice: temporary directories and fake data only; nothing touches a real deployment.
// 结案成功后在项目频道主区域发一行完成记录。运行：node --test tests/completion-notice.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompletionNotice, completionText, roleNameFromTable, threadIdOfSession, toolSucceeded, GUILD_ID } from '../plugins/personal-inbox/completion-notice.mjs';
import { registerAuditGate, fingerprintPaths } from '../plugins/personal-inbox/audit-gate.mjs';
import { WORKSHOP_CHANNEL } from '../plugins/personal-inbox/pending-ledger.mjs';

const THREAD = '100000000000000100'; const PROJECT_CH = '100000000000000166';
const SK = `agent:worker-e:discord:channel:${THREAD}`;
const mkNotice = (extra = {}) => {
  const sent = []; const logs = [];
  const n = createCompletionNotice({ syncRoot: null, dataRoot: null, getCard: async () => ({ title: '测试卡' }), parentChannelOf: async () => PROJECT_CH, send: async (a) => { sent.push(a); return { ok: true }; }, roleName: (a) => ({ 'worker-e': '执行者E' }[a] ?? a), log: (r) => logs.push(r), ...extra });
  return { n, sent, logs };
};

test('文字：不点名任何人；带卡名、执行者、线程链接', () => {
  const t = completionText({ title: '长'.repeat(200), executor: '执行者E', threadLink: `https://discord.com/channels/${GUILD_ID}/${THREAD}` });
  assert.ok(!t.includes('<@')); assert.match(t, /^完成记录：《长{80}》，执行：执行者E，线程：https:\/\/discord\.com\/channels\/\d+\/\d+$/);
  assert.equal(threadIdOfSession(SK), THREAD); assert.equal(threadIdOfSession('agent:main:main'), null);
  assert.equal(toolSucceeded({ result: { ok: true } }), true); assert.equal(toolSucceeded({ error: '被挡' }), false); assert.equal(toolSucceeded({ result: { isError: true } }), false); assert.equal(toolSucceeded({ result: { details: { ok: false } } }), false);
});

test('登记过的结案调用，执行成功 → 发到项目频道主区域；失败／没登记 → 不发；同一个调用只发一次', async () => {
  const { n, sent } = mkNotice();
  n.arm('c1', { cardId: 'card-1', agentId: 'worker-e', sessionKey: SK });
  const r = await n.settle({ toolCallId: 'c1', result: { ok: true } });
  assert.equal(r.sent, true); assert.equal(sent.length, 1); assert.equal(sent[0].target, PROJECT_CH);
  assert.match(sent[0].message, /^完成记录：《测试卡》，执行：执行者E，线程：/);
  assert.equal((await n.settle({ toolCallId: 'c1', result: { ok: true } })).sent, false, '同一个调用只发一次');
  assert.equal((await n.settle({ toolCallId: 'never', result: { ok: true } })).sent, false, '没登记不发');
  n.arm('c2', { cardId: 'card-2', agentId: 'worker-e', sessionKey: SK });
  assert.equal((await n.settle({ toolCallId: 'c2', error: '没有批准，结案没有进行' })).sent, false, '被拒／过期／失败不发');
  assert.equal(sent.length, 1);
});

test('频道是茶会（写死兜底）或在排除列表里 → 不发只记日志；算不出频道 → 不发；发送失败不抛错', async () => {
  const tea = mkNotice({ parentChannelOf: async () => WORKSHOP_CHANNEL });
  tea.n.arm('c1', { cardId: 'card-1', agentId: 'worker-e', sessionKey: SK });
  const r = await tea.n.settle({ toolCallId: 'c1', result: {} });
  assert.equal(r.sent, false); assert.equal(r.why, '频道被排除'); assert.equal(tea.sent.length, 0); assert.ok(tea.logs.some((l) => l.原因?.includes('排除列表')));
  const root = mkdtempSync(join(tmpdir(), 'cn-')); mkdirSync(join(root, 'plugins', 'personal-inbox'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'personal-inbox', 'channel-exclusions.json'), JSON.stringify({ completionNotice: [PROJECT_CH] }));
  try {
    const ex = mkNotice({ syncRoot: root }); ex.n.arm('c1', { cardId: 'card-1', agentId: 'worker-e', sessionKey: SK });
    assert.equal((await ex.n.settle({ toolCallId: 'c1', result: {} })).why, '频道被排除');
  } finally { rmSync(root, { recursive: true, force: true }); }
  const unk = mkNotice({ parentChannelOf: async () => null }); unk.n.arm('c1', { cardId: 'card-1', agentId: 'worker-e', sessionKey: SK });
  assert.equal((await unk.n.settle({ toolCallId: 'c1', result: {} })).why, '算不出频道');
  const boom = mkNotice({ parentChannelOf: async () => { throw new Error('命令行超时'); } }); boom.n.arm('c1', { cardId: 'card-1', agentId: 'worker-e', sessionKey: SK });
  assert.equal((await boom.n.settle({ toolCallId: 'c1', result: {} })).sent, false);
  const bad = mkNotice({ send: async () => { throw new Error('发不出去'); } }); bad.n.arm('c1', { cardId: 'card-1', agentId: 'worker-e', sessionKey: SK });
  assert.equal((await bad.n.settle({ toolCallId: 'c1', result: {} })).sent, false); assert.ok(bad.logs.some((l) => l.结果 === '完成记录发送失败'));
  const nosend = mkNotice({ send: null }); nosend.n.arm('c1', { cardId: 'card-1', agentId: 'worker-e', sessionKey: SK });
  assert.equal((await nosend.n.settle({ toolCallId: 'c1', result: {} })).why, '没有发送函数');
  const nothread = mkNotice(); nothread.n.arm('c1', { cardId: 'card-1', agentId: 'worker-e', sessionKey: 'agent:main:main' });
  assert.equal((await nothread.n.settle({ toolCallId: 'c1', result: {} })).why, '没有线程编号');
});

test('执行者名字：读 bot 编号表；读不到就写角色编号', () => {
  const root = mkdtempSync(join(tmpdir(), 'cn-')); mkdirSync(join(root, '审计', '日审'), { recursive: true });
  writeFileSync(join(root, '审计', '日审', 'bot编号表.json'), JSON.stringify({ 人设bot: [{ 角色: 'worker-e', 显示名: '执行者E' }] }));
  try { assert.equal(roleNameFromTable(root, 'worker-e'), '执行者E'); assert.equal(roleNameFromTable(root, 'worker-zz'), 'worker-zz'); assert.equal(roleNameFromTable('/不存在', 'worker-e'), 'worker-e'); } finally { rmSync(root, { recursive: true, force: true }); }
});

// ───── 接进结案关口：程序放行和“点允许”后放行两条路都发；被挡／被拒的不发 ─────
function fakeApi() {
  const handlers = [];
  return { api: { on: (name, fn, o) => handlers.push({ name, fn, o }), logger: {} }, fire: async (name, event, ctx) => { let r; for (const h of handlers.filter((x) => x.name === name)) { r = (await h.fn(event, ctx)) ?? r; } return r; } };
}
async function gateWithCompletion({ extraGate = {} } = {}) {
  const { n, sent } = mkNotice();
  const { api, fire } = fakeApi();
  const gate = registerAuditGate(api, { getCard: async () => ({ id: 'card-d6', title: '测试卡', labels: ['审计:单审任务审计'], notes: '【审计级别】单审（任务审计）' }), completion: n, ...extraGate });
  return { gate, fire, sent };
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const CTX = { agentId: 'worker-e', sessionKey: SK };
const CLOSE = { toolName: 'workboard_complete', toolCallId: 'tc1', params: { id: 'card-d6' } };

test('关口接线：走“点允许”那条路——先出审批卡，允许后工具执行成功才发一条；拒绝／超时（工具带错误）不发', async () => {
  const { gate, fire, sent } = await gateWithCompletion();
  gate.ledger.recordSubmission({ cardId: 'card-d6', n: 1, threadId: 'TD6', paths: [], unverifiable: ['https://example.com/x'], fingerprintMap: {} });
  gate.ledger.recordReport({ threadId: 'TD6', author: 'task-auditor', verdict: '通过', partsTotal: 1 }); gate.ledger.markPartDelivered('TD6');
  const r = await fire('before_tool_call', CLOSE, CTX);
  assert.ok(r?.requireApproval, '要本人批'); assert.equal(sent.length, 0, '批准前不发');
  r.requireApproval.onResolution('allow-once');
  await fire('after_tool_call', { toolName: 'workboard_complete', toolCallId: 'tc1', params: CLOSE.params, result: { ok: true } }, CTX); await flush();
  assert.equal(sent.length, 1); assert.match(sent[0].message, /^完成记录：《测试卡》，执行：执行者E/);
  // 另一次：被拒（after_tool_call 带 error）不发
  const r2 = await fire('before_tool_call', { ...CLOSE, toolCallId: 'tc2' }, CTX);
  if (r2?.requireApproval) { r2.requireApproval.onResolution('deny'); }
  await fire('after_tool_call', { toolName: 'workboard_complete', toolCallId: 'tc2', params: CLOSE.params, error: '没有批准，结案没有进行' }, CTX); await flush();
  assert.equal(sent.length, 1, '拒绝不发');
});

test('关口接线：被关口挡下（没有送审记录）的调用不登记，之后即使 after_tool_call 带成功也不发；非结案工具不登记', async () => {
  const { fire, sent } = await gateWithCompletion();
  const r = await fire('before_tool_call', CLOSE, CTX);
  assert.equal(r?.block, true, '没有送审记录：挡');
  await fire('after_tool_call', { toolName: 'workboard_complete', toolCallId: 'tc1', params: CLOSE.params, result: { ok: true } }, CTX); await flush();
  await fire('after_tool_call', { toolName: 'workboard_list', toolCallId: 'tc9', params: {}, result: { ok: true } }, CTX); await flush();
  assert.equal(sent.length, 0);
});

test('关口接线：程序放行（有送审记录、审计通过、成果没被改）那条路——放行后工具执行成功才发一条', async () => {
  const { gate, fire, sent } = await gateWithCompletion();
  const dir = mkdtempSync(join(tmpdir(), 'cn-gate-')); const f = join(dir, 'a.md'); writeFileSync(f, 'x');
  try {
    gate.ledger.recordSubmission({ cardId: 'card-d6', n: 1, threadId: 'T1', paths: [f], fingerprintMap: fingerprintPaths([f]).map });
    gate.ledger.recordReport({ threadId: 'T1', author: 'task-auditor', verdict: '通过', partsTotal: 1 }); gate.ledger.markPartDelivered('T1');
    const r = await fire('before_tool_call', CLOSE, CTX);
    assert.equal(r, undefined, '程序放行');
    assert.equal(sent.length, 0, '放行那一下还不发');
    await fire('after_tool_call', { toolName: 'workboard_complete', toolCallId: 'tc1', params: CLOSE.params, result: { ok: true, details: { status: 'done' } } }, CTX); await flush();
    assert.equal(sent.length, 1); assert.equal(sent[0].target, PROJECT_CH);
    // 放行后工具执行失败：不发
    gate.ledger.recordSubmission({ cardId: 'card-d6', n: 2, threadId: 'T2', paths: [f], fingerprintMap: fingerprintPaths([f]).map });
    gate.ledger.recordReport({ threadId: 'T2', author: 'task-auditor', verdict: '通过', partsTotal: 1 }); gate.ledger.markPartDelivered('T2');
    await fire('before_tool_call', { ...CLOSE, toolCallId: 'tc2' }, CTX);
    await fire('after_tool_call', { toolName: 'workboard_complete', toolCallId: 'tc2', params: CLOSE.params, result: { ok: false } }, CTX); await flush();
    assert.equal(sent.length, 1, '工具失败不发');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('关口接线：完成记录不拖住结案工具这一轮——算频道很慢（假装 5 秒）时 after_tool_call 钩子立刻返回，发送在后台完成', async () => {
  let release; const gate1 = new Promise((r) => { release = r; });
  const { n, sent } = mkNotice({ parentChannelOf: async () => { await gate1; return PROJECT_CH; } });
  const { api, fire } = fakeApi();
  const gate = registerAuditGate(api, { getCard: async () => ({ id: 'card-d6', title: '测试卡', labels: ['审计:单审任务审计'], notes: '' }), completion: n });
  const dir = mkdtempSync(join(tmpdir(), 'cn-slow-')); const f = join(dir, 'a.md'); writeFileSync(f, 'x');
  try {
    gate.ledger.recordSubmission({ cardId: 'card-d6', n: 1, threadId: 'T1', paths: [f], fingerprintMap: fingerprintPaths([f]).map });
    gate.ledger.recordReport({ threadId: 'T1', author: 'task-auditor', verdict: '通过', partsTotal: 1 }); gate.ledger.markPartDelivered('T1');
    assert.equal(await fire('before_tool_call', CLOSE, CTX), undefined);
    const t0 = Date.now();
    await fire('after_tool_call', { toolName: 'workboard_complete', toolCallId: 'tc1', params: CLOSE.params, result: { ok: true } }, CTX);
    assert.ok(Date.now() - t0 < 500, '钩子立刻返回');
    assert.equal(sent.length, 0, '算频道还没完');
    release(); await flush(); await flush();
    assert.equal(sent.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('入口提醒：entryHint 有内容 → 行尾加"；提醒：…"；没内容 → 和原来一字不差', async () => {
  const withHint = mkNotice({ entryHint: async (ch) => (ch === PROJECT_CH ? '项目入口还没跟上（"当前成果"还没登记），请更新' : null) });
  withHint.n.arm('h1', { cardId: 'card-1', agentId: 'worker-e', sessionKey: SK });
  const r = await withHint.n.settle({ toolCallId: 'h1', result: { ok: true } });
  assert.equal(r.sent, true);
  assert.match(withHint.sent[0].message, /^完成记录：《测试卡》，执行：执行者E，线程：https:\/\/discord\.com\/channels\/\d+\/\d+；提醒：项目入口还没跟上/);
  assert.ok(!withHint.sent[0].message.includes('<@'), '提醒也不点名');
  const noHint = mkNotice({ entryHint: async () => null });
  noHint.n.arm('h2', { cardId: 'card-1', agentId: 'worker-e', sessionKey: SK });
  await noHint.n.settle({ toolCallId: 'h2', result: { ok: true } });
  const plain = mkNotice();
  plain.n.arm('h3', { cardId: 'card-1', agentId: 'worker-e', sessionKey: SK });
  await plain.n.settle({ toolCallId: 'h3', result: { ok: true } });
  assert.equal(noHint.sent[0].message, plain.sent[0].message, '入口已跟上时，行和没有这个功能时一字不差');
});
test('入口提醒：entryHint 抛错 → 照常发原来的行，只记日志；结案不受影响', async () => {
  const { n, sent, logs } = mkNotice({ entryHint: async () => { throw new Error('读索引失败'); } });
  n.arm('e1', { cardId: 'card-1', agentId: 'worker-e', sessionKey: SK });
  const r = await n.settle({ toolCallId: 'e1', result: { ok: true } });
  assert.equal(r.sent, true);
  assert.ok(!sent[0].message.includes('提醒'));
  assert.ok(logs.some((l) => /入口提醒没取到/.test(JSON.stringify(l))));
});
test('入口提醒：entryHint 同步抛错、返回非文字 → 都当没有', async () => {
  for (const bad of [() => { throw new Error('同步错'); }, () => 123, () => ({}), () => '   ']) {
    const { n, sent } = mkNotice({ entryHint: bad });
    n.arm('s1', { cardId: 'card-1', agentId: 'worker-e', sessionKey: SK });
    assert.equal((await n.settle({ toolCallId: 's1', result: { ok: true } })).sent, true);
    assert.ok(!sent[0].message.includes('提醒'));
  }
});
test('入口提醒：频道在排除列表（工坊）→ 根本不发完成记录，也就不取提醒', async () => {
  let called = 0;
  const { n, sent } = mkNotice({ parentChannelOf: async () => WORKSHOP_CHANNEL, entryHint: async () => { called += 1; return '不该出现'; } });
  n.arm('x1', { cardId: 'card-1', agentId: 'worker-e', sessionKey: SK });
  assert.equal((await n.settle({ toolCallId: 'x1', result: { ok: true } })).sent, false);
  assert.equal(sent.length, 0); assert.equal(called, 0);
});
