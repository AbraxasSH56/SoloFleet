// Offline tests for card thread map: temporary directories and fake data only; nothing touches a real deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCardThreadLinks, recordLink, recordThread, readLinks, cardsForThread, mapPath, threadIdOfSession, extractCardIds, unwrapResult } from '../plugins/personal-inbox/card-thread-map.mjs';

const C1 = 'aaaaaaaa-1111-4222-8333-444444444444';
const C2 = 'bbbbbbbb-1111-4222-8333-444444444444';
const TH = '100000000000000141';
const TH2 = '100000000000000142';

function fakeApi() {
  const hooks = {};
  return { hooks, on: (name, fn) => { (hooks[name] ??= []).push(fn); }, fire: async (name, ev, ctx) => { for (const f of hooks[name] ?? []) await f(ev, ctx); } };
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ctm-'));
  const api = fakeApi();
  const logs = [];
  registerCardThreadLinks(api, { dataRoot: root, log: (r) => logs.push(r), now: () => 1794419322965 });
  return { root, api, logs, path: mapPath(root), done: () => rmSync(root, { recursive: true, force: true }) };
}
const sk = (tid, agent = 'worker-e') => `agent:${agent}:discord:channel:${tid}`;

test('会话键 → 线程编号；官方子任务会话键不带 Discord 编号；文字里的卡号只认完整格式并去重', () => {
  assert.equal(threadIdOfSession(sk(TH)), TH);
  assert.equal(threadIdOfSession(`agent:worker-e:discord:channel:${TH}:thread:1234`), TH);
  assert.equal(threadIdOfSession('agent:worker-e:subagent:workboard-default-00000000-0000-4000-8000-000000000005'), null);
  assert.equal(threadIdOfSession(undefined), null);
  assert.deepEqual(extractCardIds(`卡 ${C1} 和 ${C1} 还有 ${C2}，短号 449e9a37 不算`), [C1, C2]);
  assert.deepEqual(unwrapResult({ details: { card: { id: C1 } } }), { card: { id: C1 } });
  assert.deepEqual(unwrapResult({ content: [{ type: 'text', text: JSON.stringify({ card: { id: C1 } }) }] }), { card: { id: C1 } });
  assert.deepEqual(unwrapResult(JSON.stringify({ thread: { id: TH } })), { thread: { id: TH } });
});

test('recordLink：同线程同卡只留一行并累计次数和来源；坏编号不记；原子写', () => {
  const { path, done } = setup();
  try {
    assert.equal(recordLink({ path, threadId: 'abc', cardId: C1, via: 'x' }), null);
    assert.equal(recordLink({ path, threadId: TH, cardId: '449e9a37', via: 'x' }), null);
    assert.equal(existsSync(path), false, '没记成就不写文件');
    recordLink({ path, threadId: TH, cardId: C1, via: 'claim', agent: 'worker-e', now: 1000 });
    const r = recordLink({ path, threadId: TH, cardId: C1, via: 'comment', agent: 'worker-e', now: 2000 });
    assert.equal(r.n, 2);
    assert.deepEqual(r.via, ['claim', 'comment']);
    recordLink({ path, threadId: TH, cardId: C2, via: 'claim' });
    assert.equal(readLinks(path).links.length, 2);
    assert.equal(cardsForThread(path, TH).length, 2);
    assert.equal(cardsForThread(path, TH2).length, 0);
    assert.equal(readLinks(path).version, 1);
  } finally { done(); }
});

test('读坏了的文件当空，下一次记会重写', () => {
  const { path, done } = setup();
  try {
    recordLink({ path, threadId: TH, cardId: C1, via: 'claim' });
    writeFileSync(path, '坏{');
    assert.deepEqual(readLinks(path).links, []);
    recordLink({ path, threadId: TH, cardId: C2, via: 'claim' });
    assert.equal(readLinks(path).links.length, 1);
  } finally { done(); }
});

test('① 线程里的会话调用任务板工具（参数里有卡号）→ 记；只读类工具、没有 Discord 编号的会话、报错的调用、短卡号都不记', async () => {
  const { api, path, logs, done } = setup();
  try {
    await api.fire('after_tool_call', { toolName: 'workboard_claim', params: { id: C1 }, result: {} }, { sessionKey: sk(TH), agentId: 'worker-e' });
    await api.fire('after_tool_call', { toolName: 'mcp__openclaw__workboard_comment', params: { id: C1, body: 'x' }, result: {} }, { sessionKey: sk(TH), agentId: 'worker-e' });
    assert.deepEqual(cardsForThread(path, TH).map((l) => [l.cardId, l.n, l.via]), [[C1, 2, ['claim', 'comment']]]);
    await api.fire('after_tool_call', { toolName: 'workboard_read', params: { id: C2 } }, { sessionKey: sk(TH) });
    await api.fire('after_tool_call', { toolName: 'workboard_list', params: {} }, { sessionKey: sk(TH) });
    await api.fire('after_tool_call', { toolName: 'workboard_claim', params: { id: C2 } }, { sessionKey: 'agent:worker-e:subagent:workboard-default-x' });
    await api.fire('after_tool_call', { toolName: 'workboard_claim', params: { id: C2 }, error: '失败' }, { sessionKey: sk(TH) });
    await api.fire('after_tool_call', { toolName: 'workboard_claim', params: { id: '449e9a37' } }, { sessionKey: sk(TH) });
    assert.deepEqual(cardsForThread(path, TH).map((l) => l.cardId), [C1]);
    assert.ok(logs.some((l) => l.结果 === '记卡线程对应' && l.线程 === TH && l.卡 === C1 && l.依据 === 'claim'));
  } finally { done(); }
});

test('① 线程里的会话建卡 → 从回执里取卡号记', async () => {
  const { api, path, done } = setup();
  try {
    await api.fire('after_tool_call', { toolName: 'workboard_create', params: { title: 't' }, result: { details: { card: { id: C1, title: 't' } } } }, { sessionKey: sk(TH, 'main'), agentId: 'main', runId: 'r1' });
    assert.deepEqual(cardsForThread(path, TH).map((l) => [l.cardId, l.via]), [[C1, ['建卡']]]);
  } finally { done(); }
});

test('② 开线程：首帖里恰好一个卡号 → 记（线程编号取自回执）；首帖有两个卡号 → 不记', async () => {
  const { api, path, done } = setup();
  try {
    const ctx = { sessionKey: sk('100000000000000143', 'main'), agentId: 'main', runId: 'r1' };
    await api.fire('before_tool_call', { toolName: 'message', toolCallId: 't1', params: { action: 'thread-create', message: `任务卡 ${C1}：做测试页` } }, ctx);
    await api.fire('after_tool_call', { toolName: 'message', toolCallId: 't1', params: {}, result: { details: { thread: { id: TH } } } }, ctx);
    assert.deepEqual(cardsForThread(path, TH).map((l) => [l.cardId, l.via]), [[C1, ['开线程首帖']]]);
    assert.ok(readLinks(path).threads[TH], '开出来的线程编号记进已知线程');
    await api.fire('before_tool_call', { toolName: 'message', toolCallId: 't2', params: { action: 'thread-create', message: `卡 ${C1} 和 ${C2}` } }, ctx);
    await api.fire('after_tool_call', { toolName: 'message', toolCallId: 't2', params: {}, result: { details: { thread: { id: TH2 } } } }, ctx);
    assert.equal(cardsForThread(path, TH2).length, 0);
    assert.ok(readLinks(path).threads[TH2], '首帖有两个卡号不记对应，但线程仍记为已知线程');
  } finally { done(); }
});

test('recordThread：只记 17～20 位数字编号；同一个只记一次；记线程不动对应行', () => {
  const { path, done } = setup();
  try {
    assert.equal(recordThread({ path, threadId: 'x' }), null);
    recordLink({ path, threadId: TH, cardId: C1, via: 'claim' });
    const a = recordThread({ path, threadId: TH, agent: 'main', now: 1000 });
    const b = recordThread({ path, threadId: TH, agent: 'other', now: 2000 });
    assert.deepEqual(a, b);
    assert.equal(readLinks(path).links.length, 1);
  } finally { done(); }
});

test('③ 同一轮先建卡再开线程（首帖没写卡号）→ 记那张；同一轮建了两张 → 不记；别的轮建的不算', async () => {
  const { api, path, done } = setup();
  try {
    const main = (runId) => ({ sessionKey: sk('100000000000000143', 'main'), agentId: 'main', runId });
    await api.fire('after_tool_call', { toolName: 'workboard_create', params: {}, result: { details: { card: { id: C1 } } } }, main('r1'));
    await api.fire('before_tool_call', { toolName: 'message', toolCallId: 't1', params: { action: 'thread-create', message: '请做测试页' } }, main('r1'));
    await api.fire('after_tool_call', { toolName: 'message', toolCallId: 't1', params: {}, result: JSON.stringify({ thread: { id: TH } }) }, main('r1'));
    assert.deepEqual(cardsForThread(path, TH).map((l) => [l.cardId, l.via]), [['aaaaaaaa-1111-4222-8333-444444444444', ['同一轮建卡再开线程']]]);
    // 同一轮建两张
    await api.fire('after_tool_call', { toolName: 'workboard_create', params: {}, result: { details: { card: { id: C1 } } } }, main('r2'));
    await api.fire('after_tool_call', { toolName: 'workboard_create', params: {}, result: { details: { card: { id: C2 } } } }, main('r2'));
    await api.fire('before_tool_call', { toolName: 'message', toolCallId: 't2', params: { action: 'thread-create', message: '请做测试页' } }, main('r2'));
    await api.fire('after_tool_call', { toolName: 'message', toolCallId: 't2', params: {}, result: { details: { thread: { id: TH2 } } } }, main('r2'));
    assert.equal(cardsForThread(path, TH2).length, 0);
    // 别的轮建的不算
    await api.fire('before_tool_call', { toolName: 'message', toolCallId: 't3', params: { action: 'thread-create', message: '请做测试页' } }, main('r3'));
    await api.fire('after_tool_call', { toolName: 'message', toolCallId: 't3', params: {}, result: { details: { thread: { id: '100000000000000144' } } } }, main('r3'));
    assert.equal(cardsForThread(path, '100000000000000144').length, 0);
  } finally { done(); }
});

test('开线程回执里没有线程编号、或不是 thread-create → 什么都不记，不抛错', async () => {
  const { api, path, done } = setup();
  try {
    const ctx = { sessionKey: sk('100000000000000143', 'main'), runId: 'r1' };
    await api.fire('before_tool_call', { toolName: 'message', toolCallId: 't1', params: { action: 'thread-create', message: C1 } }, ctx);
    await api.fire('after_tool_call', { toolName: 'message', toolCallId: 't1', params: {}, result: { details: {} } }, ctx);
    await api.fire('before_tool_call', { toolName: 'message', toolCallId: 't2', params: { action: 'send', message: C1 } }, ctx);
    await api.fire('after_tool_call', { toolName: 'message', toolCallId: 't2', params: {}, result: { details: { thread: { id: TH } } } }, ctx);
    assert.equal(existsSync(path), false);
  } finally { done(); }
});

test('没有资料根目录时注册什么都不做', () => {
  const api = fakeApi();
  registerCardThreadLinks(api, {});
  assert.deepEqual(api.hooks, {});
});
