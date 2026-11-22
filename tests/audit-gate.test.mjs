// Offline tests for audit gate: temporary directories and fake data only; nothing touches a real deployment.
// 结案关口离线测试。运行：node --test tests/audit-gate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  judgeToolParams, judgeCommandText, parseSubmission, parseVerdict, ClosingLedger, decideClosing, readAuditLabel,
  fingerprintPaths, registerAuditGate,
} from '../plugins/personal-inbox/audit-gate.mjs';

const blocked = (v, msg) => assert.equal(v.kind, 'block', `应被挡：${msg}`);
const passes = (v, msg) => assert.equal(v.kind, 'pass', `应照常：${msg} ${JSON.stringify(v)}`);
const closing = (v, msg) => assert.equal(v.kind, 'closing', `应走结案核：${msg}`);

test('工具：建卡带完成状态被拒，普通建卡照常（含标题里带 done 的）', () => {
  blocked(judgeToolParams('workboard_create', { title: 'x', status: 'done' }), 'status done');
  blocked(judgeToolParams('workboard_create', { title: 'x', status: 'Done ' }), '大小写、空白');
  blocked(judgeToolParams('workboard_create', { title: 'x', completedAt: 1700000000000 }), 'completedAt');
  blocked(judgeToolParams('workboard_create', { title: 'x', execution: { status: 'done' } }), 'execution.status');
  passes(judgeToolParams('workboard_create', { title: 'x' }), '普通');
  passes(judgeToolParams('workboard_create', { title: 'x', status: 'ready' }), '别的状态');
  passes(judgeToolParams('workboard_create', { title: 'fix done status', notes: 'status: done' }), '标题和备注里带 done');
});

test('工具：拆分必须明确 completeParent:false；子卡带完成状态被拒', () => {
  blocked(judgeToolParams('workboard_decompose', { id: 'c', children: [{ title: 'a' }] }), '省略');
  blocked(judgeToolParams('workboard_decompose', { id: 'c', completeParent: true, children: [{ title: 'a' }] }), 'true');
  blocked(judgeToolParams('workboard_decompose', { id: 'c', completeParent: false, children: [{ title: 'a', status: 'done' }] }), '子卡 done');
  passes(judgeToolParams('workboard_decompose', { id: 'c', completeParent: false, children: [{ title: 'a' }] }), 'false');
});

test('工具：complete、release／move／reassign／reclaim 带完成 → 走结案核；不带完成照常', () => {
  closing(judgeToolParams('workboard_complete', { id: 'c' }), 'complete');
  for (const t of ['workboard_release', 'workboard_move', 'workboard_reassign', 'workboard_reclaim']) {
    closing(judgeToolParams(t, { id: 'c', status: 'done' }), `${t} done`);
    passes(judgeToolParams(t, { id: 'c', status: 'review' }), `${t} review`);
    passes(judgeToolParams(t, { id: 'c' }), `${t} 无状态`);
  }
  passes(judgeToolParams('workboard_block', { id: 'c' }), 'block');
  passes(judgeToolParams('workboard_comment', { id: 'c' }), 'comment');
});

test('工具：worker 运行被挡时回话自带出路（不要重试、workboard_block、送审由主会话做）', () => {
  const v = judgeToolParams('workboard_create', { title: 'x', status: 'done' }, { workerRun: true });
  assert.match(v.reason, /不要重试/);
  assert.match(v.reason, /workboard_block/);
});

test('命令行：create／move 的 --status done 与 --status=done 都挡；别的状态、list 照常', () => {
  blocked(judgeCommandText('openclaw workboard create "t" --status done'), 'create --status done');
  blocked(judgeCommandText('openclaw workboard create "t" --status=done'), 'create --status=done');
  blocked(judgeCommandText('openclaw workboard move abc123 --status done'), 'move');
  blocked(judgeCommandText('openclaw workboard move abc123 --status="done"'), 'move 带引号');
  blocked(judgeCommandText('/home/x/bin/node /opt/oc/openclaw.mjs workboard move abc --status done'), '全路径 node 调用，按文字匹配');
  passes(judgeCommandText('openclaw workboard create "t" --status ready'), 'ready');
  passes(judgeCommandText('openclaw workboard create "fix done status"'), '标题里带 done');
  passes(judgeCommandText('openclaw workboard list --json'), 'list');
  passes(judgeCommandText('openclaw workboard show abc'), 'show');
  passes(judgeCommandText('ls /tmp'), '无关命令');
});

test('gateway call：complete 一律挡；release／reassign／reclaim／move 带 done 挡', () => {
  blocked(judgeCommandText("openclaw gateway call workboard.cards.complete --params '{\"id\":\"c\"}'"), 'complete');
  for (const m of ['release', 'reassign', 'reclaim', 'move']) {
    blocked(judgeCommandText(`openclaw gateway call workboard.cards.${m} --params '{"id":"c","status":"done"}'`), `${m} done`);
    passes(judgeCommandText(`openclaw gateway call workboard.cards.${m} --params '{"id":"c","status":"review"}'`), `${m} review`);
  }
  blocked(judgeCommandText("openclaw gateway call workboard.cards.move.owner --params '{\"id\":\"c\",\"status\":\"done\",\"expectedOwnerId\":\"o\"}'"), 'move.owner');
  blocked(judgeCommandText("openclaw gateway call workboard.cards.create.owner --params '{\"title\":\"t\",\"status\":\"done\",\"expectedOwnerId\":\"o\"}'"), 'create.owner');
});

test('gateway call：update／bulk 的 patch.status 与顶层 status 都查', () => {
  blocked(judgeCommandText("openclaw gateway call workboard.cards.update --params '{\"id\":\"c\",\"patch\":{\"status\":\"done\"}}'"), 'update patch.status');
  blocked(judgeCommandText("openclaw gateway call workboard.cards.update --params '{\"id\":\"c\",\"status\":\"done\"}'"), 'update 顶层 status');
  blocked(judgeCommandText("openclaw gateway call workboard.cards.bulk --params '{\"ids\":[\"a\",\"b\"],\"patch\":{\"status\":\"done\"}}'"), 'bulk patch');
  blocked(judgeCommandText("openclaw gateway call workboard.cards.bulk --params '{\"ids\":[\"a\"],\"status\":\"done\"}'"), 'bulk 顶层');
  passes(judgeCommandText("openclaw gateway call workboard.cards.update --params '{\"id\":\"c\",\"patch\":{\"status\":\"review\"}}'"), 'update review');
  passes(judgeCommandText("openclaw gateway call workboard.cards.update --params '{\"id\":\"c\",\"patch\":{\"title\":\"done list\"}}'"), 'update 改标题（带 done 字样）');
  passes(judgeCommandText("openclaw gateway call workboard.cards.update --params '{\"id\":\"c\",\"completedAt\":123}'"), 'update 只给 completedAt 做不出完成（官方会删）');
});

test('gateway call：create／captureSession／decompose 的 completedAt、execution.status、子卡', () => {
  blocked(judgeCommandText("openclaw gateway call workboard.cards.create --params '{\"title\":\"t\",\"completedAt\":1}'"), 'create completedAt');
  blocked(judgeCommandText("openclaw gateway call workboard.cards.create --params '{\"title\":\"t\",\"execution\":{\"status\":\"done\"}}'"), 'create execution.status');
  blocked(judgeCommandText("openclaw gateway call workboard.cards.captureSession --params '{\"sessionKey\":\"k\",\"status\":\"done\"}'"), 'captureSession done');
  passes(judgeCommandText("openclaw gateway call workboard.cards.captureSession --params '{\"sessionKey\":\"k\"}'"), 'captureSession 普通');
  passes(judgeCommandText("openclaw gateway call workboard.cards.create --params '{\"title\":\"t\"}'"), 'create 普通');
  blocked(judgeCommandText("openclaw gateway call workboard.cards.decompose --params '{\"id\":\"c\",\"children\":[{\"title\":\"a\"}]}'"), 'decompose 省略');
  blocked(judgeCommandText("openclaw gateway call workboard.cards.decompose --params '{\"id\":\"c\",\"completeParent\":false,\"children\":[{\"title\":\"a\",\"status\":\"done\"}]}'"), 'decompose 子卡 done');
  passes(judgeCommandText("openclaw gateway call workboard.cards.decompose --params '{\"id\":\"c\",\"completeParent\":false,\"children\":[{\"title\":\"a\"}]}'"), 'decompose false');
});

test('gateway call：参数解析不了、从文件或标准输入读 → 挡；查看类照常', () => {
  blocked(judgeCommandText('openclaw gateway call workboard.cards.move --params @/tmp/p.json'), '从文件');
  blocked(judgeCommandText('openclaw gateway call workboard.cards.move --params -'), '标准输入');
  blocked(judgeCommandText("openclaw gateway call workboard.cards.move --params '{bad json'"), '非法 JSON');
  blocked(judgeCommandText('openclaw gateway call workboard.cards.update --params "$(cat /tmp/p)"'), '命令替换');
  passes(judgeCommandText('openclaw gateway call workboard.cards.list'), 'list');
  passes(judgeCommandText("openclaw gateway call workboard.cards.dispatch --params '{}'"), 'dispatch 不产生完成');
});

const TEMPLATE = (n, card, paths) => `任务审计 <@100000000000000013> 请审：测试任务（第 ${n} 次）
任务卡：${card}　审计级别：单审（任务审计）
主人原话：见卡片正文【原话】一节
验收标准：1. 有文件
成果位置：
${paths.join('\n')}
任务类型：其他
执行者：执行者E <@100000000000000138>`;

test('送审单：按现行真实模板（首行点名请审、第二行任务卡）识别，成果位置一行一个路径', () => {
  const s = parseSubmission(TEMPLATE(2, 'card-1', ['/a/b.md', '/a/c']));
  assert.deepEqual({ cardId: s.cardId, n: s.n, paths: s.paths }, { cardId: 'card-1', n: 2, paths: ['/a/b.md', '/a/c'] });
  assert.equal(parseSubmission('随便一句话'), null);
  assert.equal(parseSubmission('任务审计 <@1> 请审：x（第 1 次）\n任务卡：c'), null);
  const nonFile = parseSubmission(TEMPLATE(1, 'c', ['https://discord.com/channels/1/2/3']));
  assert.deepEqual(nonFile.paths, []);
  assert.equal(nonFile.unverifiable.length, 1);
});

test('报告第一行结论', () => {
  assert.equal(parseVerdict('我得：通过\n其余'), '通过');
  assert.equal(parseVerdict('\n我得：不通过'), '不通过');
  assert.equal(parseVerdict('我得：审不了（这类内容审不了）'), '审不了');
  assert.equal(parseVerdict('通过'), null);
});

// ----- 结案判断 -----
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const f = join(dir, '成果.md');
  writeFileSync(f, '版本一');
  const card = { id: 'card-1', labels: ['审计:单审任务审计'], notes: '审计级别：单审（任务审计）' };
  const ledger = new ClosingLedger();
  const submit = (n = 1, thread = 'T1', paths = [f]) => {
    const fp = fingerprintPaths(paths);
    return ledger.recordSubmission({ cardId: 'card-1', n, threadId: thread, paths, fingerprintMap: fp.map });
  };
  const report = (thread, verdict, total = 1, delivered = total) => { ledger.recordReport({ threadId: thread, author: 'task-auditor', verdict, partsTotal: total }); for (let i = 0; i < delivered; i++) ledger.markPartDelivered(thread); };
  const decide = (extra = {}) => decideClosing({ ledger, cardId: 'card-1', card, ...extra });
  return { dir, f, card, ledger, submit, report, decide, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('结案：无标签挡；标签不认识挡；标签和正文矛盾挡', () => {
  const t = setup(); t.submit(); t.report('T1', '通过');
  assert.equal(decideClosing({ ledger: t.ledger, cardId: 'card-1', card: { labels: [] } }).allow, false);
  assert.equal(decideClosing({ ledger: t.ledger, cardId: 'card-1', card: { labels: ['审计:免审'] } }).allow, false);
  assert.equal(decideClosing({ ledger: t.ledger, cardId: 'card-1', card: { labels: ['审计:串联'], notes: '审计级别：单审（任务审计）' } }).allow, false);
  assert.equal(readAuditLabel({ labels: ['审计:单审任务审计'] }).ok, true);
  assert.equal(readAuditLabel({ labels: ['审计:单审独立'], notes: '【审计级别】单审（独立审计） ｜ 主人确认于 02-14' }).ok, true, '模板里的独立审计写法');
  assert.equal(readAuditLabel({ labels: ['审计:单审独立'], notes: '审计级别：单审（任务审计）' }).ok, false);
  assert.equal(readAuditLabel({ labels: ['审计:单审独立'], notes: '【审计级别】单审（任务审计） ｜ 主人确认于 02-14' }).ok, false, '模板写法的矛盾也能认出');
  t.cleanup();
});

test('结案：没送审挡；送审后任务审计通过 → 放行；记“十一.7 临时安排”', () => {
  const t = setup();
  const d0 = t.decide(); assert.equal(d0.allow, false); assert.match(d0.reason, /送审/);
  t.submit(); assert.equal(t.decide().allow, false); // 还没有报告
  t.report('T1', '通过');
  const d = t.decide(); assert.equal(d.allow, true); assert.match(d.via, /十一\.7/);
  t.cleanup();
});

test('结案：送审后改成果挡；报告只送达一半挡', () => {
  const t = setup(); t.submit(); t.report('T1', '通过');
  writeFileSync(t.f, '版本二');
  const d = t.decide(); assert.equal(d.allow, false); assert.match(d.reason, /改过/);
  const t2 = setup(); t2.submit(); t2.report('T1', '通过', 3, 2);
  assert.equal(t2.decide().allow, false);
  t.cleanup(); t2.cleanup();
});

test('结案：旧送审的通过不算；总控贴的补审不算；只看最近一次送审', () => {
  const t = setup(); t.submit(1, 'T1'); t.report('T1', '通过');
  t.submit(2, 'T2');
  assert.equal(t.decide().allow, false, '第二次送审还没报告，第一次的通过不算');
  // 只有绑定的 Opus 补审才算：总控贴回线程的不记报告
  assert.equal(t.decide().allow, false);
  t.report('T2', '通过'); assert.equal(t.decide().allow, true);
  t.cleanup();
});

test('结案：有已送达的“不通过” → 挡，不出本人批准（即使属于本人批准那三种情况）', () => {
  const t = setup(); t.ledger.recordSubmission({ cardId: 'card-1', n: 1, threadId: 'T1', paths: [], unverifiable: ['https://x'], fingerprintMap: {} });
  t.report('T1', '不通过');
  const d = t.decide(); assert.equal(d.allow, false); assert.equal(d.approval, undefined); assert.match(d.reason, /不通过/);
  t.cleanup();
});

test('结案：审不了转 Opus 补审（绑定本次送审）通过 → 放行；补审不通过、补审也审不了、补审属于旧送审 → 挡', () => {
  const mk = (verdict, nForOpus = 1) => {
    const t = setup(); t.submit(1, 'T1'); t.report('T1', '审不了');
    t.ledger.bindOpus({ cardId: 'card-1', n: nForOpus, runId: 'R1', childSessionKey: 'S1' });
    t.ledger.recordOpusReport({ runId: 'R1', childSessionKey: 'S1', agentId: 'task-auditor', modelId: 'anthropic/claude-opus-5-5', text: `我得：${verdict}` });
    return t;
  };
  assert.equal(mk('通过').decide().allow, true);
  assert.equal(mk('不通过').decide().allow, false);
  assert.equal(mk('审不了').decide().allow, false);
  const t = setup(); t.submit(1, 'T1'); t.report('T1', '审不了'); t.submit(2, 'T2');
  t.ledger.bindOpus({ cardId: 'card-1', n: 1, runId: 'R1', childSessionKey: 'S1' });
  t.ledger.recordOpusReport({ runId: 'R1', childSessionKey: 'S1', agentId: 'task-auditor', modelId: 'opus', text: '我得：通过' });
  assert.equal(t.decide().allow, false, '补审属于第 1 次，满足不了第 2 次');
});

test('结案：Opus 补审只认绑定的运行编号、会话、角色 task-auditor、型号 Opus', () => {
  const t = setup(); t.submit(); t.report('T1', '审不了');
  t.ledger.bindOpus({ cardId: 'card-1', n: 1, runId: 'R1', childSessionKey: 'S1' });
  const bad = (o) => t.ledger.recordOpusReport({ runId: 'R1', childSessionKey: 'S1', agentId: 'task-auditor', modelId: 'opus', text: '我得：通过', ...o });
  assert.equal(bad({ runId: 'R2' }), null);
  assert.equal(bad({ childSessionKey: 'S2' }), null);
  assert.equal(bad({ agentId: 'main' }), null);
  assert.equal(bad({ modelId: 'fable' }), null);
  assert.equal(t.decide().allow, false);
  assert.ok(bad({}));
  assert.equal(t.decide().allow, true);
  t.cleanup();
});

test('结案：补审回执缺运行编号 → 绑定核不了 → 走主人批准；同一卡两次送审，第一轮补审晚到满足不了第二轮', () => {
  const t = setup(); t.submit(); t.report('T1', '审不了');
  t.ledger.bindOpus({ cardId: 'card-1', n: 1, runId: undefined, childSessionKey: 'S1' });
  const d = t.decide(); assert.equal(d.approval, true); assert.match(d.reason, /绑定核不了/);
  t.ledger.grantApproval('card-1', d.submissionKey);
  assert.equal(t.decide().allow, true);
  t.cleanup();
});

test('结案：成果无法核对／送审重复 → 要主人批准，批准只对这一次送审有效', () => {
  const t = setup();
  t.ledger.recordSubmission({ cardId: 'card-1', n: 1, threadId: 'T1', paths: [], unverifiable: ['https://x'], fingerprintMap: {} });
  t.report('T1', '通过');
  const d = t.decide(); assert.equal(d.approval, true); assert.match(d.reason, /无法核对/);
  t.ledger.grantApproval('card-1', d.submissionKey);
  assert.equal(t.decide().allow, true);
  t.ledger.recordSubmission({ cardId: 'card-1', n: 2, threadId: 'T2', paths: [], unverifiable: ['https://y'], fingerprintMap: {} });
  t.report('T2', '通过');
  assert.equal(t.decide().approval, true, '第二次送审要重新批');
  const t2 = setup(); t2.submit(1, 'T1'); t2.submit(1, 'T1b'); t2.report('T1b', '通过');
  assert.equal(t2.decide().approval, true, '送审重复');
  t.cleanup(); t2.cleanup();
});

test('结案：worker 运行被挡时回话自带出路', () => {
  const t = setup(); t.submit();
  const d = t.decide({ workerRun: true });
  assert.equal(d.allow, false); assert.match(d.reason, /不要重试/); assert.match(d.reason, /workboard_block/);
  t.cleanup();
});

test('钩子：exec 命令文字被挡并记一行；workboard_complete 无通过报告被挡，有则放行', async () => {
  const handlers = [];
  const api = { on: (name, fn) => handlers.push({ name, fn }) };
  const logs = [];
  const gate = registerAuditGate(api, { log: (r) => logs.push(r), getCard: () => ({ labels: ['审计:单审任务审计'], notes: '' }) });
  const h = handlers.find((x) => x.name === 'before_tool_call').fn;
  const r1 = await h({ toolName: 'exec', params: { command: 'openclaw workboard move c --status done' } }, { agentId: 'worker-e' });
  assert.equal(r1.block, true);
  const r2 = await h({ toolName: 'workboard_complete', params: { id: 'card-1' } }, { agentId: 'worker-e' });
  assert.equal(r2.block, true);
  const dir = mkdtempSync(join(tmpdir(), 'gate-')); const f = join(dir, 'a.md'); writeFileSync(f, 'x');
  gate.ledger.recordSubmission({ cardId: 'card-1', n: 1, threadId: 'T1', paths: [f], fingerprintMap: fingerprintPaths([f]).map });
  gate.ledger.recordReport({ threadId: 'T1', author: 'task-auditor', verdict: '通过', partsTotal: 1 }); gate.ledger.markPartDelivered('T1');
  const r3 = await h({ toolName: 'workboard_complete', params: { id: 'card-1' } }, { agentId: 'worker-e' });
  assert.equal(r3, undefined);
  assert.ok(logs.some((l) => l.结果 === '放行'));
  assert.ok(logs.filter((l) => l.结果 === '挡').every((l) => l.卡 !== undefined || l.内容));
  const r4 = await h({ toolName: 'workboard_create', params: { title: 't', status: 'done' } }, { agentId: 'main' });
  assert.equal(r4.block, true);
  rmSync(dir, { recursive: true, force: true });
});

// ----- 记账钩子（假的插件接口，走现行真实送审模板）-----
function fakeApi() {
  const hs = {};
  return { api: { on: (name, fn) => { (hs[name] ??= []).push(fn); } }, fire: async (name, ...a) => { let first; for (const fn of hs[name] ?? []) { const r = await fn(...a); if (first === undefined) first = r; } return first; } };
}

test('钩子：main 发出的送审单被记下（含成果指纹）；非 main 发的不记；发出后补线程编号', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-')); const f = join(dir, 'a.md'); writeFileSync(f, 'x');
  const { api, fire } = fakeApi(); const gate = registerAuditGate(api, {});
  const content = TEMPLATE(1, 'card-9', [f]);
  await fire('message_sending', { to: 'channel:11111', content }, { sessionKey: 'agent:worker-e:discord:x' });
  assert.equal(gate.ledger.latestSubmission('card-9'), null, '执行者发的不算送审');
  await fire('message_sending', { to: 'channel:11111', content }, { sessionKey: 'agent:main:discord:x' });
  const sub = gate.ledger.latestSubmission('card-9');
  assert.equal(sub.n, 1); assert.deepEqual(sub.paths, [f]); assert.ok(sub.fingerprintMap[f]);
  assert.equal(sub.threadId, '11111');
  await fire('message_sent', { content, success: true, messageId: '222' });
  assert.equal(gate.ledger.latestSubmission('card-9').messageId, '222');
  rmSync(dir, { recursive: true, force: true });
});

test('钩子：任务审计在审计线程的报告，拆条全部送达后才算已送达；只送达一部分不算', async () => {
  const { api, fire } = fakeApi(); const gate = registerAuditGate(api, {});
  const ctx = { sessionKey: 'agent:task-auditor:discord:y', runId: 'RUN1' };
  await fire('message_sending', { to: 'channel:T9', threadId: 'T9', content: '我得：通过\n第一段' }, ctx);
  await fire('message_sending', { to: 'channel:T9', threadId: 'T9', content: '第二段' }, ctx);
  await fire('message_sent', { content: '我得：通过\n第一段', success: true, messageId: '1' });
  assert.equal(gate.ledger.reportFor('T9').delivered, false, '第二段还没送达');
  await fire('message_sent', { content: '第二段', success: true, messageId: '2' });
  assert.equal(gate.ledger.reportFor('T9').delivered, true);
  assert.equal(gate.ledger.reportFor('T9').verdict, '通过');
});

test('钩子：发送失败的片段不算送达', async () => {
  const { api, fire } = fakeApi(); const gate = registerAuditGate(api, {});
  await fire('message_sending', { to: 'channel:T8', threadId: 'T8', content: '我得：通过' }, { sessionKey: 'agent:task-auditor:d', runId: 'R' });
  await fire('message_sent', { content: '我得：通过', success: false });
  assert.equal(gate.ledger.reportFor('T8').delivered, false);
});

test('钩子：Opus 补审——派活消息前两行对上送审才绑定；回执缺运行编号则绑定核不了；agent_end 按运行编号收结论', async () => {
  const { api, fire } = fakeApi(); const gate = registerAuditGate(api, {});
  gate.ledger.recordSubmission({ cardId: 'card-5', n: 1, threadId: 'T5', paths: ['/x'], fingerprintMap: { '/x': 'a' } });
  const msg = TEMPLATE(1, 'card-5', ['/x']);
  await fire('before_tool_call', { toolName: 'sessions_spawn', toolCallId: 'tc1', params: { agentId: 'task-auditor', model: 'opus', message: msg } }, { sessionKey: 'agent:main:d' });
  await fire('after_tool_call', { toolName: 'sessions_spawn', toolCallId: 'tc1', result: { details: { status: 'accepted', runId: 'RO1', childSessionKey: 'agent:task-auditor:subagent:abc' } } });
  assert.equal(gate.ledger.opusFor('card-5', 1)[0].bound, true);
  await fire('agent_end', { runId: 'RO1', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: '我得：通过\n依据' }] }] }, { agentId: 'task-auditor', sessionKey: 'agent:task-auditor:subagent:abc', modelId: 'claude-opus-5-5' });
  assert.equal(gate.ledger.opusFor('card-5', 1)[0].verdict, '通过');
  // 回执缺 runId
  gate.ledger.recordSubmission({ cardId: 'card-6', n: 1, threadId: 'T6', paths: ['/x'], fingerprintMap: {} });
  await fire('before_tool_call', { toolName: 'sessions_spawn', toolCallId: 'tc2', params: { message: TEMPLATE(1, 'card-6', ['/x']) } }, { sessionKey: 'agent:main:d' });
  await fire('after_tool_call', { toolName: 'sessions_spawn', toolCallId: 'tc2', result: { details: { status: 'accepted' } } });
  assert.equal(gate.ledger.opusFor('card-6', 1)[0].bound, false);
  // 派活消息对不上任何送审
  await fire('before_tool_call', { toolName: 'sessions_spawn', toolCallId: 'tc3', params: { message: TEMPLATE(1, 'card-none', ['/x']) } }, { sessionKey: 'agent:main:d' });
  await fire('after_tool_call', { toolName: 'sessions_spawn', toolCallId: 'tc3', result: { details: { runId: 'RX', childSessionKey: 'K' } } });
  assert.equal(gate.ledger.opusFor('card-none', 1)[0].bound, false);
});

test('钩子：工具名带 mcp__openclaw__ 前缀也照样判（exec、workboard_*）', async () => {
  const { api, fire } = fakeApi(); registerAuditGate(api, {});
  const r1 = await fire('before_tool_call', { toolName: 'mcp__openclaw__exec', params: { command: 'openclaw workboard move c --status done' } }, { agentId: 'worker-e' });
  assert.equal(r1.block, true);
  const r2 = await fire('before_tool_call', { toolName: 'mcp__openclaw__workboard_create', params: { title: 'x', status: 'done' } }, { agentId: 'worker-e' });
  assert.equal(r2.block, true);
  const r3 = await fire('before_tool_call', { toolName: 'Bash', params: { command: 'openclaw gateway call workboard.cards.complete --params \'{"id":"c"}\'' } }, { agentId: 'worker-e' });
  assert.equal(r3.block, true);
  assert.equal(await fire('before_tool_call', { toolName: 'mcp__openclaw__exec', params: { command: 'ls /tmp' } }, { agentId: 'worker-e' }), undefined);
});

test('钩子：总控用 message 工具 thread-create 开审计线程——前两行对上、回执里有线程编号才记送审（the first post of a thread does not go through message_sending）', async () => {
  const { api, fire } = fakeApi(); const gate = registerAuditGate(api, {});
  const msg = TEMPLATE(1, 'card-tc', ['/x']);
  await fire('before_tool_call', { toolName: 'mcp__openclaw__message', toolCallId: 'm1', params: { action: 'thread-create', channelId: 'C', threadName: '审计：x（第 1 次）', message: msg } }, { sessionKey: 'agent:main:d' });
  await fire('after_tool_call', { toolName: 'mcp__openclaw__message', toolCallId: 'm1', result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, thread: { id: 'T-TC' }, initialMessageDelivery: { deliveredMessageIds: ['MSG-TC'] } }) }] } });
  const s = gate.ledger.latestSubmission?.('card-tc') ?? gate.ledger.data.submissions['card-tc']?.at(-1);
  assert.ok(s, '记上了送审');
  assert.equal(s.n, 1); assert.equal(s.threadId, 'T-TC'); assert.equal(s.messageId, 'MSG-TC');
  // 结果直接是对象、或在 details 里，同样认
  await fire('before_tool_call', { toolName: 'message', toolCallId: 'm2', params: { action: 'thread-create', message: TEMPLATE(1, 'card-tc2', ['/x']) } }, { sessionKey: 'agent:main:d' });
  await fire('after_tool_call', { toolName: 'message', toolCallId: 'm2', result: { details: { thread: { id: 'T-TC2' } } } });
  assert.equal(gate.ledger.data.submissions['card-tc2'].at(-1).threadId, 'T-TC2');
  // 不是总控、不是 thread-create、前两行对不上、回执没有线程编号 → 都不记
  await fire('before_tool_call', { toolName: 'message', toolCallId: 'm3', params: { action: 'thread-create', message: TEMPLATE(1, 'card-x1', ['/x']) } }, { sessionKey: 'agent:worker-e:d' });
  await fire('after_tool_call', { toolName: 'message', toolCallId: 'm3', result: { thread: { id: 'T3' } } });
  await fire('before_tool_call', { toolName: 'message', toolCallId: 'm4', params: { action: 'send', message: TEMPLATE(1, 'card-x2', ['/x']) } }, { sessionKey: 'agent:main:d' });
  await fire('after_tool_call', { toolName: 'message', toolCallId: 'm4', result: { thread: { id: 'T4' } } });
  await fire('before_tool_call', { toolName: 'message', toolCallId: 'm5', params: { action: 'thread-create', message: '随便一句话' } }, { sessionKey: 'agent:main:d' });
  await fire('after_tool_call', { toolName: 'message', toolCallId: 'm5', result: { thread: { id: 'T5' } } });
  await fire('before_tool_call', { toolName: 'message', toolCallId: 'm6', params: { action: 'thread-create', message: TEMPLATE(1, 'card-x3', ['/x']) } }, { sessionKey: 'agent:main:d' });
  await fire('after_tool_call', { toolName: 'message', toolCallId: 'm6', result: { ok: false } });
  for (const c of ['card-x1', 'card-x2', 'card-x3']) assert.equal(gate.ledger.data.submissions[c], undefined, c);
});

test('命令文字：bot 不能用命令行批审批（approvals resolve／exec-approvals resolve／gateway call plugin.approval.resolve／exec.approval.resolve，含选拒绝）；只列出的照常', () => {
  for (const c of [
    'openclaw approvals resolve plugin:abc allow-once',
    'openclaw approvals resolve plugin:abc deny',
    '/home/x/bin/openclaw exec-approvals resolve abc allow-once',
    'openclaw gateway call plugin.approval.resolve --params \'{"id":"plugin:abc","decision":"allow-once"}\'',
    'openclaw gateway call exec.approval.resolve --params "{\\"id\\":\\"x\\",\\"decision\\":\\"deny\\"}"',
    'node /x/openclaw.mjs approvals resolve a b',
    'cd /tmp && OPENCLAW_X=1 openclaw approvals resolve a b',
    'echo hi; openclaw approvals approve a',
  ]) blocked(judgeCommandText(c), c);
  for (const c of ['openclaw approvals pending', 'openclaw approvals list --json', 'ls approvals', 'echo 我们的 approvals resolved 流程', 'openclaw gateway call plugin.approval.list']) {
    // 注意：最后三条里“approvals resolved”不是 resolve 动作
    if (/approvals resolved/.test(c)) continue;
    passes(judgeCommandText(c), c);
  }
});

test('本人批准：审批卡说明写清哪个 bot、哪张卡、原线程链接；点“允许一次”后也记一条放行记录（看护事后核账不再误报）', async () => {
  const { api, fire } = fakeApi();
  const gate = registerAuditGate(api, { getCard: async () => ({ id: 'card-ap', title: '测试卡', labels: ['审计:单审任务审计'], notes: '【审计级别】单审（任务审计）' }) });
  // 送审标“成果无法核对”（成果位置写的是消息链接，不是文件路径）→ 要走本人批准
  gate.ledger.recordSubmission({ cardId: 'card-ap', n: 1, threadId: 'TAP', paths: [], unverifiable: ['https://example.com/x'], fingerprintMap: {} });
  gate.ledger.recordReport({ threadId: 'TAP', author: 'task-auditor', verdict: '通过', partsTotal: 1 }); gate.ledger.markPartDelivered('TAP');
  const r = await fire('before_tool_call', { toolName: 'workboard_complete', toolCallId: 'c1', params: { id: 'card-ap' } }, { agentId: 'worker-e', sessionKey: 'agent:worker-e:discord:channel:100000000000000100' });
  assert.ok(r?.requireApproval, '要本人批准');
  const desc = r.requireApproval.description;
  assert.match(desc, /worker-e/); assert.match(desc, /card-ap/); assert.match(desc, /测试卡/);
  assert.match(desc, /https:\/\/discord\.com\/channels\/100000000000000002\/100000000000000100/);
  assert.equal(gate.ledger.data.releases.length, 0, '批准前没有放行记录');
  r.requireApproval.onResolution('deny');
  assert.equal(gate.ledger.data.releases.length, 0, '拒绝不记放行');
  r.requireApproval.onResolution('allow-once');
  assert.equal(gate.ledger.data.releases.length, 1);
  assert.match(gate.ledger.data.releases[0].via, /本人批准/);
});

test('bot 不能替主人在聊天里发“/approve …”：message 工具和 exec 里的 message send 都挡；普通消息照常', async () => {
  const { api, fire } = fakeApi(); registerAuditGate(api, {});
  const ctx = { agentId: 'worker-e', sessionKey: 'agent:worker-e:d' };
  for (const text of ['/approve plugin:abc allow-once', '  /approve plugin:abc deny', '请你批一下 /approve plugin:abc allow-once']) {
    const r = await fire('before_tool_call', { toolName: 'mcp__openclaw__message', toolCallId: 'a1', params: { action: 'send', message: text } }, ctx);
    assert.equal(r?.block, true, text);
  }
  const ok = await fire('before_tool_call', { toolName: 'message', toolCallId: 'a2', params: { action: 'send', message: '审批在审批频道，等主人点' } }, ctx);
  assert.equal(ok?.block, undefined);
  blocked(judgeCommandText('openclaw message send --channel discord --target channel:1 --message "/approve plugin:abc allow-once"'), 'exec message send');
  passes(judgeCommandText('openclaw message send --channel discord --target channel:1 --message "收到"'), '普通 message send');
});

test('命令文字：比对前去掉引号和反斜杠——加引号、加转义的写法也被挡；普通用法照常', () => {
  for (const c of [
    "openclaw 'approvals' 'resolve' plugin:abc deny",
    'openclaw "approvals" "resolve" plugin:abc allow-once',
    "openclaw appro\\vals res\\olve a b",
    "openclaw 'exec-approvals' resolve a b",
    "openclaw gateway call 'plugin.approval.resolve' --params '{\"id\":\"x\"}'",
    "openclaw 'workboard' 'move' c1 --status 'done'",
    "openclaw gateway call 'workboard.cards.complete' --params '{\"id\":\"c\"}'",
    "openclaw workboard \"create\" t --status=\"done\"",
  ]) blocked(judgeCommandText(c), c);
  for (const c of ["openclaw 'workboard' 'list' --json", "openclaw workboard show c1 --json", "echo 'approvals pending'", "openclaw 'approvals' 'pending'"]) passes(judgeCommandText(c), c);
});

// ======================================================================
// 结案关口卡说明截断；出卡时另发点名（假发送函数）
// ======================================================================
import { sanitizedLength, cpLength, resetApprovalNoticeState } from '../plugins/personal-inbox/approval-card.mjs';

async function closingCard({ title, extra = {}, send }) {
  const { api, fire } = fakeApi();
  const gate = registerAuditGate(api, { getCard: async () => ({ id: 'card-d6', title, labels: ['审计:单审任务审计'], notes: '【审计级别】单审（任务审计）' }), sendApprovalNotice: send, ...extra });
  gate.ledger.recordSubmission({ cardId: 'card-d6', n: 1, threadId: 'TD6', paths: [], unverifiable: ['https://example.com/x'], fingerprintMap: {} });
  gate.ledger.recordReport({ threadId: 'TD6', author: 'task-auditor', verdict: '通过', partsTotal: 1 }); gate.ledger.markPartDelivered('TD6');
  return fire('before_tool_call', { toolName: 'workboard_complete', toolCallId: 'c1', params: { id: 'card-d6' } }, { agentId: 'worker-e', sessionKey: 'agent:worker-e:discord:channel:100000000000000100' });
}

test('D6 结案卡：卡名很长（带全角空格、制表符）→ 说明清理后 ≤512、栏目（申请的 bot、任务卡号、原线程、批准只放行…）都在，title ≤80', async () => {
  resetApprovalNoticeState();
  const r = await closingCard({ title: ('长　卡\t名').repeat(80), send: async () => ({ ok: true }) });
  const d = r.requireApproval.description;
  assert.ok(sanitizedLength(d) <= 512 && cpLength(d) <= 480, `${sanitizedLength(d)}`);
  for (const must of ['申请的 bot：worker-e', '任务卡：card-d6', '原线程：https://discord.com/channels/100000000000000002/100000000000000100', '批准只放行这一张卡这一次结案']) assert.ok(d.includes(must), must);
  assert.ok(cpLength(r.requireApproval.title) <= 80);
});

test('D6 结案卡：短说明一个字不动（栏目顺序与改前相同）', async () => {
  resetApprovalNoticeState();
  const r = await closingCard({ title: '测试卡', send: async () => ({ ok: true }) });
  assert.match(r.requireApproval.description, /^卡 card-d6、送审第 1 次：.*需要主人本人批准才能完成。批准只对这一张卡这一次结案有效。\n——申请的 bot：worker-e；任务卡：card-d6《测试卡》；原线程：https:\/\/discord\.com\/channels\/\d+\/100000000000000100。批准只放行这一张卡这一次结案。$/);
});

test('D6 结案卡：出卡时另发一次点名（账号 default、审批频道、点名主人、带卡号）；发送失败卡照出；同一张卡不重复发', async () => {
  resetApprovalNoticeState();
  const sent = [];
  const r = await closingCard({ title: '测试卡', send: async (a) => { sent.push(a); return { ok: true }; } });
  await new Promise((x) => setImmediate(x));
  assert.ok(r.requireApproval);
  assert.equal(sent.length, 1); assert.equal(sent[0].account, 'default'); assert.equal(sent[0].target, '100000000000000004');
  assert.match(sent[0].message, /^<@100000000000000001> 审批频道有一张新审批卡：结案确认（任务卡 card-d6）/);
  resetApprovalNoticeState();
  const r2 = await closingCard({ title: '测试卡', send: async () => { throw new Error('发不出'); } });
  assert.ok(r2.requireApproval, '另发失败，卡照出');
  const r3 = await closingCard({ title: '测试卡', send: async (a) => { sent.push(a); return { ok: true }; } });
  await new Promise((x) => setImmediate(x));
  assert.ok(r3.requireApproval); assert.equal(sent.length, 1, '同一张卡（同卡号同送审次）10 分钟内不重复');
});

// 结案关口的命令文字检查管所有 bot，是总控、桌面角色等“不能用命令行批审批卡”的唯一拦截，不能改成“只在开头才挡”。
// 下面四种绕过写法必须一直被挡；同时把“system-auditor 用 grep 搜这几个字也会被挡”记成已知边界（量小，不放）。
test('回归：四种绕过写法照样挡；grep 搜这几个字也挡（已知边界，不放）', () => {
  for (const c of [
    'cd x; openclaw approvals resolve plugin:abc allow-once',
    'true && openclaw approvals resolve plugin:abc allow-once',
    '/opt/tools/bin/openclaw approvals resolve plugin:abc allow-once',
    "sh -c 'openclaw approvals resolve plugin:abc allow-once'",
    'bash -c "cd /tmp; openclaw approvals approve plugin:abc"',
  ]) blocked(judgeCommandText(c), c);
  blocked(judgeCommandText('grep -E "approvals resolve|approve" /tmp/log'), '已知边界：搜这几个字也挡');
});

// 出新卡时通知“已重新申请”；登记失败不影响结案关口 ─────
test('结案卡：超时和取消登记（kind 结案确认、卡号、原线程）；拒绝不登记；允许照旧放行；发出新卡时通知重新申请', async () => {
  resetApprovalNoticeState();
  const calls = [];
  const approvalLedger = { expired: async (x) => { calls.push(['expired', x]); }, reissued: async (x) => { calls.push(['reissued', x]); } };
  const r = await closingCard({ title: '测试卡', send: async () => ({ ok: true }), extra: { approvalLedger } });
  assert.ok(r.requireApproval);
  assert.ok(calls.some(([k, x]) => k === 'reissued' && x.kind === '结案确认' && x.cardId === 'card-d6'), '出新卡时通知重新申请');
  r.requireApproval.onResolution('deny');
  assert.equal(calls.filter(([k]) => k === 'expired').length, 0, '拒绝不登记');
  r.requireApproval.onResolution('timeout');
  r.requireApproval.onResolution({ decision: 'cancelled' });
  await new Promise((x) => setImmediate(x));
  const ex = calls.filter(([k]) => k === 'expired');
  assert.equal(ex.length, 2);
  assert.equal(ex[0][1].kind, '结案确认'); assert.equal(ex[0][1].cardId, 'card-d6'); assert.equal(ex[0][1].threadId, '100000000000000100');
  assert.match(ex[0][1].link, /100000000000000100/); assert.ok(ex[0][1].expiredAt);
});

test('结案卡：登记函数抛错（同步或异步）不影响结案关口和允许放行', async () => {
  resetApprovalNoticeState();
  const logs = [];
  const bad = { expired: () => { throw new Error('同步坏了'); }, reissued: () => { throw new Error('通知坏了'); } };
  const r = await closingCard({ title: '测试卡', send: async () => ({ ok: true }), extra: { approvalLedger: bad, log: (row) => logs.push(row) } });
  assert.ok(r.requireApproval, '卡照出');
  assert.doesNotThrow(() => r.requireApproval.onResolution('timeout'));
  const bad2 = { expired: async () => { throw new Error('异步坏了'); } };
  resetApprovalNoticeState();
  const r2 = await closingCard({ title: '测试卡', send: async () => ({ ok: true }), extra: { approvalLedger: bad2, log: (row) => logs.push(row) } });
  r2.requireApproval.onResolution('timeout'); await new Promise((x) => setImmediate(x));
  assert.ok(logs.some((l) => l.结果 === '审批过期登记失败'), '失败只记日志');
  r2.requireApproval.onResolution('allow-once');
});
