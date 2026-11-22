// Offline tests for trailing card: temporary directories and fake data only; nothing touches a real deployment.
// 路线 a（段尾补发）的离线测试：单元（登记／归属／容量／过期／发送结果／自触发）、与 createExecutionRecord 的衔接、
// 完整接线回调（假插件 API 调真实 registerExecutionRecord，再按官方事件形状触发 reply_payload_sending → message_sent）、
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrailingCard } from '../plugins/personal-inbox/trailing-card.mjs';
import { createExecutionRecord, registerExecutionRecord } from '../plugins/personal-inbox/execution-record.mjs';

const T0 = Date.parse('2026-11-06T10:00:00Z');
const owner = { platform: 'discord', accountId: 'default', destination: '123' };
const ctxOk = { channelId: 'discord', accountId: 'default', conversationId: 'channel:123', runId: 'r1' };
const body = Array.from({ length: 40 }, (_, i) => `第${i + 1}行`).join('\n');
const card = { description: '型号\n额度\n修改', color: 1 };
function make(over = {}) {
  let t = T0; const sent = [], logs = [];
  const send = over.send ?? (async p => { sent.push(p); return { status: 'sent' }; });
  const c = createTrailingCard({ loadSend: over.loadSend ?? (async () => send), getCfg: () => ({ channels: {} }), now: () => t, log: m => logs.push(m), ...over.opts });
  return { c, sent, logs, tick: ms => { t += ms; } };
}
const ready = async o => { const m = make(o); await m.c.init(); return m; };
const arm = (c, id = 'r1', extra = {}) => c.arm(id, { body, card, owner, ...extra });

test('启动默认没就绪：不登记（钩子侧据此保留 E 的框）；导入失败＝disabled＋日志、不循环重试；导出不是函数同样 disabled', async () => {
  const m = make(); assert.equal(m.c.isReady(), false); assert.equal(arm(m.c), false);
  let n = 0; const bad = make({ loadSend: async () => { n++; throw new Error('Cannot find module openclaw/plugin-sdk/channel-outbound'); } });
  await bad.c.init(); await bad.c.init(); await bad.c.init();
  assert.equal(n, 1); assert.equal(bad.c.state().status, 'disabled'); assert.match(bad.logs[0], /disabled/); assert.equal(arm(bad.c), false);
  const notFn = make({ loadSend: async () => ({}) }); await notFn.c.init(); assert.equal(notFn.c.state().status, 'disabled');
});

test('登记带归属；归属不全、重复登记都不登记；满 64 条后拒绝新的、不挤掉旧的；过期清理；停用清空', async () => {
  const m = await ready();
  assert.equal(arm(m.c, 'a', { owner: { platform: 'discord', accountId: '', destination: '123' } }), false);
  assert.equal(arm(m.c, 'b', { owner: { platform: 'discord', accountId: 'default', destination: '' } }), false);
  assert.equal(arm(m.c, 'r1'), true); assert.equal(arm(m.c, 'r1'), false, '重复登记');
  for (let i = 0; i < 63; i++) assert.equal(arm(m.c, `x${i}`), true);
  assert.equal(m.c.pendingCount(), 64); assert.equal(arm(m.c, 'overflow'), false); assert.equal(m.c.pendingCount(), 64);
  assert.equal(m.c.outcome('overflow').status, 'rejected-full');
  // 前 64 条各自的正确事件仍补卡
  assert.equal(await m.c.onSent({ runId: 'r1', to: 'channel:123', content: body, success: true }, ctxOk), 'card-sent'); assert.equal(m.sent.length, 1);
  m.tick(11 * 60 * 1000); assert.equal(arm(m.c, 'fresh'), true); assert.equal(m.c.pendingCount(), 1, '过期的都清了，只剩新登记');
  m.c.disable('test'); assert.equal(m.c.pendingCount(), 0); assert.equal(m.c.isReady(), false); assert.equal(arm(m.c, 'after'), false);
});

test('message_sent 回调：账号／目的地／平台缺失或不一致＝不补、不消费登记；内容不同＝同轮别的载荷，不动；成功才补；补发内容是空文字＋嵌入', async () => {
  const m = await ready(); arm(m.c);
  const ev = { runId: 'r1', to: 'channel:123', content: body, success: true };
  for (const [e, c, why] of [[ev, { ...ctxOk, accountId: undefined }, '缺账号'], [ev, { ...ctxOk, accountId: 'desktop' }, '别的账号'], [{ ...ev, to: 'channel:999' }, { ...ctxOk, conversationId: 'channel:999' }, '别的目的地'], [ev, { ...ctxOk, channelId: 'slack' }, '别的平台'], [{ ...ev, to: undefined }, { ...ctxOk, conversationId: undefined }, '缺目的地']]) {
    assert.equal(await m.c.onSent(e, c), 'ownership-mismatch', why); assert.equal(m.c.pendingCount(), 1, `${why}：登记还在`);
  }
  assert.equal(await m.c.onSent({ ...ev, content: '别的块' }, ctxOk), 'other-payload'); assert.equal(m.c.pendingCount(), 1);
  assert.equal(await m.c.onSent({ ...ev, content: `${body}\n` }, ctxOk), 'card-sent', '首尾空白不算不同');
  assert.equal(m.sent.length, 1);
  const p = m.sent[0]; assert.equal(p.channel, 'discord'); assert.equal(p.to, 'channel:123'); assert.equal(p.accountId, 'default'); assert.deepEqual(p.cfg, { channels: {} });
  assert.deepEqual(p.payloads, [{ text: '', channelData: { discord: { embeds: [card] } } }]);
  assert.equal(m.c.pendingCount(), 0);
});

test('正文没发成功（success≠true）：不补卡、清登记；补发结果 sent／suppressed／partial_failed／failed／缺状态／抛异常各自处理，不把失败当成功，不重试', async () => {
  const failed = await ready(); arm(failed.c);
  assert.equal(await failed.c.onSent({ runId: 'r1', to: 'channel:123', content: body, success: false }, ctxOk), 'delivery-failed-no-card'); assert.equal(failed.sent.length, 0); assert.equal(failed.c.pendingCount(), 0);
  for (const [res, verdict] of [[{ status: 'sent' }, 'card-sent'], [{ status: 'suppressed' }, 'card-suppressed'], [{ status: 'partial_failed' }, 'card-partial'], [{ status: 'failed' }, 'card-failed'], [{}, 'card-unknown-result'], [undefined, 'card-unknown-result']]) {
    let calls = 0; const m = await ready({ send: async () => { calls++; return res; } }); arm(m.c);
    assert.equal(await m.c.onSent({ runId: 'r1', to: 'channel:123', content: body, success: true }, ctxOk), verdict); assert.equal(calls, 1);
    assert.equal(await m.c.onSent({ runId: 'r1', to: 'channel:123', content: body, success: true }, ctxOk), 'ignored', '同一轮不会再补');
  }
  let calls = 0; const thrown = await ready({ send: async () => { calls++; throw new Error('boom'); } }); arm(thrown.c);
  assert.equal(await thrown.c.onSent({ runId: 'r1', to: 'channel:123', content: body, success: true }, ctxOk), 'card-send-failed'); assert.equal(calls, 1);
  assert.equal(await thrown.c.onSent({ runId: 'r1', to: 'channel:123', content: body, success: true }, ctxOk), 'ignored', '抛异常也不重试');
});

test('补发那条自己触发的 message_sent：没有登记、内容为空、没有运行编号＝什么都不做、不再生成卡；两轮交错各补各的；重复事件只补一次', async () => {
  const m = await ready(); arm(m.c, 'a'); arm(m.c, 'b', { body: `${body}b` });
  assert.equal(await m.c.onSent({ to: 'channel:123', content: '', success: true }, { ...ctxOk, runId: undefined }), 'ignored');
  assert.equal(await m.c.onSent({ runId: 'zzz', to: 'channel:123', content: '', success: true }, { ...ctxOk, runId: 'zzz' }), 'ignored');
  assert.equal(await m.c.onSent({ runId: 'b', to: 'channel:123', content: `${body}b`, success: true }, { ...ctxOk, runId: 'b' }), 'card-sent');
  assert.equal(await m.c.onSent({ runId: 'a', to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: 'a' }), 'card-sent');
  assert.equal(m.sent.length, 2);
  assert.equal(await m.c.onSent({ runId: 'a', to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: 'a' }), 'ignored');
  assert.equal(m.sent.length, 2);
});

const final = (text, extra = {}) => ({ kind: 'final', channel: 'discord', runId: 'r1', usageState: { resolvedRef: 'claude-cli/claude-opus-5-5', reasoningEffort: 'medium' }, payload: { text }, ...extra });
const ctxD = { channelId: 'discord', accountId: 'default', conversationId: 'channel:123' };
const mkRec = card => createExecutionRecord({ now: () => T0, readQuota: async () => ({ status: 'unknown' }), workspaceFor: () => '/task', trailing: () => card.isReady() ? { arm: (id, a) => card.arm(id, a) } : null });

test('钩子衔接：就绪后长回复不挂框并登记；短回复、只发附件、登记失败、没就绪都保留 E 的框；登记发生在正文投递前', async () => {
  const m = await ready(); const r = mkRec(m.c);
  const long = await r.payload(final(body), ctxD); assert.equal(long.payload.channelData, undefined, '长回复正文上没有框'); assert.equal(long.payload.text, body); assert.equal(m.c.pendingCount(), 1);
  const short = await mkRec(m.c).payload(final('收到', { runId: 'r2' }), ctxD); assert.equal(short.payload.channelData.discord.embeds.length, 1); assert.equal(m.c.pendingCount(), 1);
  const notice = await mkRec(m.c).payload({ ...final('Opus/Cli · medium', { runId: 'r3' }), payload: { text: 'Opus/Cli · medium', isStatusNotice: true } }, { ...ctxD });
  // D9（桌面角色排队直接接续小批）：没有附件、之前没发过片段的纯页脚状态通知不再单独发出（原为原样放行）；只发附件走 E 的独立框，不走 a
  assert.deepEqual(notice, { cancel: true, reason: 'execution-record: footer-only status notice' }, '没有附件的页脚通知被取消');
  // 登记失败（重复）→ 保留框
  const dup = await mkRec(m.c).payload(final(body), ctxD); assert.equal(dup.payload.channelData.discord.embeds.length, 1);
  // 没就绪 → E
  const cold = make(); const e = await mkRec(cold.c).payload(final(body, { runId: 'r9' }), ctxD); assert.equal(e.payload.channelData.discord.embeds.length, 1);
  // 归属不全（没有账号）→ 登记失败 → 保留框
  const noAcct = await mkRec(m.c).payload(final(body, { runId: 'r8' }), { channelId: 'discord', conversationId: 'channel:123' }); assert.equal(noAcct.payload.channelData.discord.embeds.length, 1);
});

function fakeApi(over = {}, tag = 'a') {
  const hooks = {}, services = [];
  return { hooks, services, api: { pluginConfig: { executionRecord: { enabled: true, quotaSource: 'cache', snapshotPath: `/nonexistent-${tag}-test`, credentialProfilePath: '/test/.claude/.credentials.json' } }, config: { channels: { discord: {} }, agents: { entries: {} } }, logger: { warn() {}, info() {} }, on: (n, f) => { hooks[n] = f; }, registerService: s => services.push(s), runtime: { events: { onAgentEvent: () => () => {} } }, ...over } };
}

test('完整接线回调：真实 registerExecutionRecord 注册 message_sent；就绪→长回复先 reply_payload_sending（登记、不挂框）再 message_sent（补卡）；导入失败→E 保留框、不补', async () => {
  const sent = []; const ok = createTrailingCard({ loadSend: async () => async p => { sent.push(p); return { status: 'sent' }; }, getCfg: () => ({ marker: 1 }) });
  const f = fakeApi(); registerExecutionRecord(f.api, { trailingCard: ok });
  assert.equal(typeof f.hooks.message_sent, 'function'); assert.equal(typeof f.hooks.reply_payload_sending, 'function'); assert.equal(typeof f.hooks.after_tool_call, 'function');
  await ok.init();
  const out = await f.hooks.reply_payload_sending(final(body, { runId: 'wire1' }), { ...ctxD, runId: 'wire1' });
  assert.equal(out.payload.channelData, undefined); assert.equal(ok.pendingCount(), 1);
  assert.equal(await f.hooks.message_sent({ to: 'channel:123', content: body, success: true }, ctxD), 'card-sent', '官方正常路径的事件没有 runId');
  assert.equal(sent.length, 1); assert.equal(sent[0].payloads[0].channelData.discord.embeds[0].description.split('\n')[0], 'Opus/Cli · medium'); assert.deepEqual(sent[0].cfg, { marker: 1 });
  // 导入失败
  const badCard = createTrailingCard({ loadSend: async () => { throw new Error('no module'); } });
  const g = fakeApi({}, 'bad'); registerExecutionRecord(g.api, { trailingCard: badCard }); await badCard.init();
  const out2 = await g.hooks.reply_payload_sending(final(body, { runId: 'wire2' }), { ...ctxD, runId: 'wire2' });
  assert.equal(out2.payload.channelData.discord.embeds.length, 1); assert.equal(await g.hooks.message_sent({ runId: 'wire2', to: 'channel:123', content: body, success: true }, { ...ctxD, runId: 'wire2' }), 'ignored');
});

test('服务停用：清空登记、之后回到 E；重新注册再试一次导入', async () => {
  let loads = 0; const c = createTrailingCard({ loadSend: async () => { loads++; return async () => ({ status: 'sent' }); } });
  const f = fakeApi({}, 'stop'); registerExecutionRecord(f.api, { trailingCard: c }); await c.init(); assert.equal(c.isReady(), true); assert.equal(loads, 1);
  arm(c, 'live'); assert.equal(c.pendingCount(), 1);
  await f.services[0].start(); await f.services[0].stop(); assert.equal(c.isReady(), false); assert.equal(c.pendingCount(), 0);
  registerExecutionRecord(fakeApi({}, 'stop2').api, { trailingCard: c }); await c.init(); assert.equal(c.isReady(), true); assert.equal(loads, 2);
});

test('队列恢复形状（官方 delivery-queue-recovery：补投的事件由 createMessageSentEmitter 发出，运行编号可能缺失，进程重启后登记已丢）：没有登记／没有 runId／重复的重放事件都什么都不做，不重复补卡；重启后丢登记＝该轮缺卡（②类边界，不保证）', async () => {
  const m = await ready(); arm(m.c, 'q1');
  // 1) 没有 runId、正文为空（补发那条自己触发的）→ 忽略，登记保留
  assert.equal(await m.c.onSent({ to: 'channel:123', content: '', success: true }, { ...ctxOk, runId: undefined }), 'ignored'); assert.equal(m.c.pendingCount(), 1);
  // 2) 正常那一次：官方正常路径的事件没有 runId（上机实测），按同归属＋同正文配对 → 补卡
  assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: undefined }), 'card-sent');
  // 3) 恢复又重放同一轮（带或不带 runId）→ 不再补
  assert.equal(await m.c.onSent({ runId: 'q1', to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: 'q1' }), 'ignored'); assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: undefined }), 'ignored'); assert.equal(m.sent.length, 1);
  // 4) 重启（新实例，登记没了）后恢复的旧轮次 → 忽略，不补（单次缺卡，已记为②类边界）
  const fresh = await ready(); assert.equal(await fresh.c.onSent({ runId: 'q1', to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: 'q1' }), 'ignored'); assert.equal(fresh.sent.length, 0);
  // 5) 恢复事件 success:false（补投仍失败）→ 清登记、不补
  arm(m.c, 'q2'); assert.equal(await m.c.onSent({ runId: 'q2', to: 'channel:123', content: body, success: false, error: 'x' }, { ...ctxOk, runId: 'q2' }), 'delivery-failed-no-card'); assert.equal(m.c.pendingCount(), 0);
});

test('没有 runId 的 message_sent（上机实测的官方正常路径）：按同平台＋同账号＋同目的地＋逐字相同正文配对，取登记最早的一条；归属不同、正文不同、内容为空都配不上', async () => {
  const m = await ready(); arm(m.c, 'old'); arm(m.c, 'new');   // 两轮正文相同（极端情况）
  assert.equal(await m.c.onSent({ to: 'channel:123', content: 'x', success: true }, { ...ctxOk, runId: undefined }), 'ignored', '正文不同');
  assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: undefined, accountId: 'desktop' }), 'ignored', '别的账号');
  assert.equal(await m.c.onSent({ to: 'channel:999', content: body, success: true }, { ...ctxOk, runId: undefined, conversationId: 'channel:999' }), 'ignored', '别的目的地');
  assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: undefined, channelId: 'slack' }), 'ignored', '别的平台');
  assert.equal(m.c.pendingCount(), 2, '以上都没消费登记');
  assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: undefined }), 'card-sent'); assert.equal(m.c.pendingCount(), 1);
  assert.equal(m.c.outcome('old').status, 'sent', '先到的事件消费最早的登记');
  assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: undefined }), 'card-sent'); assert.equal(m.c.pendingCount(), 0); assert.equal(m.sent.length, 2);
  // 没有 runId 且 success:false → 清掉配对到的登记、不补
  arm(m.c, 'f'); assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: false }, { ...ctxOk, runId: undefined }), 'delivery-failed-no-card'); assert.equal(m.c.pendingCount(), 0);
});

test('同目的地两轮正文逐字相同：按登记先后各配各的卡；一轮还没补卡、下一轮相同正文已登记／已到时的行为；记下已知局限', async () => {
  const cardA = { description: '型号\n额度\n修改：A.md', color: 1 }, cardB = { description: '型号\n额度\n修改：B.md', color: 1 };
  const m = await ready();
  arm(m.c, 'A', { card: cardA }); arm(m.c, 'B', { card: cardB });     // 同目的地、正文相同的两轮；A 先登记
  // 事件按投递顺序到（无 runId）：第一条配最早登记 A，第二条配 B——每张卡各自的"修改"栏不串
  assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: undefined }), 'card-sent');
  assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: undefined }), 'card-sent');
  assert.equal(m.sent[0].payloads[0].channelData.discord.embeds[0].description.endsWith('A.md'), true, '先到的事件拿到先登记的 A 的卡');
  assert.equal(m.sent[1].payloads[0].channelData.discord.embeds[0].description.endsWith('B.md'), true);
  // 带 runId 的事件永远按 runId，不受顺序影响
  arm(m.c, 'C', { card: cardA }); arm(m.c, 'D', { card: cardB });
  assert.equal(await m.c.onSent({ runId: 'D', to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: 'D' }), 'card-sent');
  assert.equal(m.sent[2].payloads[0].channelData.discord.embeds[0].description.endsWith('B.md'), true, '带 runId 的 D 拿 D 的卡，即使 C 登记在前');
  // 一轮还没补卡、下一轮相同正文又登记：两条登记并存（不因正文相同就拒绝），各自等各自的事件
  assert.equal(m.c.pendingCount(), 1); assert.equal(arm(m.c, 'E', { card: cardB }), true); assert.equal(m.c.pendingCount(), 2);
  // 已知局限（写进边界，不假装解决）：没有 runId 时，两轮正文逐字相同、且投递完成的先后和登记的先后相反，两张卡会对调——卡仍各出一张，不丢卡、不重复，但"修改"栏会挂到另一轮；
  // 并发不是必要条件：旧登记残留（上一轮完成回调正文没对上而留着）被下一轮相同正文取走，同样会串。
  assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: undefined }), 'card-sent');
  assert.equal(m.sent[3].payloads[0].channelData.discord.embeds[0].description.endsWith('A.md'), true, '没有 runId 时先到的事件拿最早的登记 C（它的卡是 A.md），即使实际属于 E 的那轮：这就是已知局限');
});

test('小保护①：同一个 messageId 只处理一次——重复回调不消耗任何登记，不抢下一轮；没有 messageId 的事件照常配对（认不出重复）', async () => {
  const m = await ready(); arm(m.c, 'A');
  const evA = { messageId: 'M1', to: 'channel:123', content: body, success: true };
  assert.equal(await m.c.onSent(evA, { ...ctxOk, runId: undefined }), 'card-sent'); assert.equal(m.sent.length, 1);
  arm(m.c, 'B');                                                      // 下一轮相同正文已登记，还没完成
  assert.equal(await m.c.onSent(evA, { ...ctxOk, runId: undefined }), 'duplicate', 'A 的重复回调（同 messageId）不能消耗 B 的登记');
  assert.equal(m.c.pendingCount(), 1); assert.equal(m.sent.length, 1, '没有因重放多出卡');
  assert.equal(await m.c.onSent({ ...evA, messageId: 'M2' }, { ...ctxOk, runId: undefined }), 'card-sent', 'B 自己的完成事件（新 messageId）照常补 B 的卡'); assert.equal(m.sent.length, 2);
  assert.equal(await m.c.onSent({ ...evA, messageId: 'M2' }, { ...ctxOk, runId: undefined }), 'duplicate');
  // 带 runId 的重复回调同理；ctx 里的 messageId 也算
  arm(m.c, 'C'); assert.equal(await m.c.onSent({ runId: 'C', to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: 'C', messageId: 'M3' }), 'card-sent');
  arm(m.c, 'D'); assert.equal(await m.c.onSent({ runId: 'C', to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: 'C', messageId: 'M3' }), 'duplicate'); assert.equal(m.c.pendingCount(), 1);
  // 事件没带 messageId：照常配对（无从判断是否重复）
  assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: undefined }), 'card-sent');
  // 失败的正文也记为已处理，之后同 messageId 的回调不再碰登记
  arm(m.c, 'E'); assert.equal(await m.c.onSent({ messageId: 'M5', to: 'channel:123', content: body, success: false }, { ...ctxOk, runId: undefined }), 'delivery-failed-no-card');
  arm(m.c, 'F'); assert.equal(await m.c.onSent({ messageId: 'M5', to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: undefined }), 'duplicate'); assert.equal(m.c.pendingCount(), 1);
});

test('小保护②：回调的 sessionKey 和登记的不同＝不配对、不消费；回调没带 sessionKey 或登记没存＝不因此拒绝，照常补；大小写空白不影响', async () => {
  const withSession = k => ({ owner: { ...owner, sessionKey: k } });
  const m = await ready(); arm(m.c, 'A', withSession('agent:main:discord:channel:123'));
  // 不同会话（无 runId）：配不上
  assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true, sessionKey: 'agent:other:discord:channel:123' }, { ...ctxOk, runId: undefined }), 'ignored'); assert.equal(m.c.pendingCount(), 1);
  assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: undefined, sessionKey: 'agent:other:x' }), 'ignored', 'ctx 里的 sessionKey 同样核');
  // 带 runId、会话不同：ownership-mismatch、不消费
  assert.equal(await m.c.onSent({ runId: 'A', to: 'channel:123', content: body, success: true, sessionKey: 'agent:other:x' }, { ...ctxOk, runId: 'A' }), 'ownership-mismatch'); assert.equal(m.c.pendingCount(), 1);
  // 同会话（大小写／空白不同）→ 补
  assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true, sessionKey: '  AGENT:main:discord:channel:123 ' }, { ...ctxOk, runId: undefined }), 'card-sent'); assert.equal(m.sent.length, 1);
  // 回调没带 sessionKey → 不因此拒绝
  arm(m.c, 'B', withSession('agent:main:discord:channel:123')); assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true }, { ...ctxOk, runId: undefined }), 'card-sent');
  // 登记没存 sessionKey → 不因此拒绝
  arm(m.c, 'C'); assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true, sessionKey: 'agent:main:whatever' }, { ...ctxOk, runId: undefined }), 'card-sent'); assert.equal(m.sent.length, 3);
  // 不同会话、同目的地、同正文两轮：各配各的会话，不串
  arm(m.c, 'X', withSession('s-x')); arm(m.c, 'Y', withSession('s-y'));
  assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true, sessionKey: 's-y' }, { ...ctxOk, runId: undefined }), 'card-sent');
  assert.equal(m.c.outcome('Y').status, 'sent'); assert.equal(m.c.pendingCount(), 1, '只消费了 Y，X 还在');
});

test('正常长回复照常补（两处小保护不影响主路径）：无 runId、无 messageId、无 sessionKey 的事件仍按归属＋正文配对补卡', async () => {
  const m = await ready(); arm(m.c, 'R', { owner: { ...owner, sessionKey: 'agent:main:discord:channel:123' } });
  assert.equal(await m.c.onSent({ to: 'channel:123', content: body, success: true }, { channelId: 'discord', accountId: 'default', conversationId: 'channel:123' }), 'card-sent'); assert.equal(m.sent.length, 1);
});
