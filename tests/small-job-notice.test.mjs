// Offline tests for small job notice: temporary directories and fake data only; nothing touches a real deployment.
// 没建卡的小活，bot 没在主区域报时程序补一行。运行：node --test tests/small-job-notice.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSmallJobNotice, registerSmallJobNotice, smallJobText } from '../plugins/personal-inbox/small-job-notice.mjs';
import { createCompletionNotice } from '../plugins/personal-inbox/completion-notice.mjs';
import { OWNER_ID, WORKSHOP_CHANNEL } from '../plugins/personal-inbox/pending-ledger.mjs';

const THREAD = '100000000000000139'; const PROJECT_CH = '100000000000000100'; const BOT_ID = '100000000000000011';
const SK = `agent:worker-e:discord:channel:${THREAD}`;
const CTX = { runId: 'run1', agentId: 'worker-e', sessionKey: SK, trigger: 'user', senderId: OWNER_ID, channelId: THREAD };
const WRITE = (path) => ({ toolName: 'write', params: { file_path: path }, result: { ok: true } });
const mk = (extra = {}) => {
  const sent = []; const logs = [];
  const n = createSmallJobNotice({ syncRoot: null, dataRoot: null, parentChannelOf: async () => PROJECT_CH, send: async (a) => { sent.push(a); return { ok: true }; }, roleName: (a) => ({ 'worker-e': '执行者E' }[a] ?? a), log: (r) => logs.push(r), ...extra });
  return { n, sent, logs };
};

test('文字：不点名任何人；带执行者、线程链接、文件名（去掉目录、去重、最多列 6 个）', () => {
  const t = smallJobText({ executor: '执行者E', threadLink: 'https://x/y', files: ['/a/b/hy.txt', '/c/hy.txt', 'z.md'] });
  assert.equal(t, '完成记录（小活）：执行者E在线程 https://x/y 做完一件，改了：hy.txt、z.md');
  assert.ok(!t.includes('<@'));
  const many = smallJobText({ executor: 'x', threadLink: 'l', files: Array.from({ length: 9 }, (_, i) => `f${i}.md`) });
  assert.match(many, /f0\.md、f1\.md、f2\.md、f3\.md、f4\.md、f5\.md等 9 个$/);
});

test('主人本人在任务线程里叫的、写了文件、没在主区域报 → 补一行（总控账号发到上级频道主区域）', async () => {
  const { n, sent } = mk();
  n.noteTool(WRITE('/opt/solofleet-data/任务测试/hy-s7c.txt'), CTX);
  const r = await n.settle(CTX);
  assert.equal(r.sent, true); assert.equal(sent.length, 1); assert.equal(sent[0].target, PROJECT_CH);
  assert.match(sent[0].message, /^完成记录（小活）：执行者E在线程 https:\/\/discord\.com\/channels\/\d+\/100000000000000139 做完一件，改了：hy-s7c\.txt$/);
});

test('bot 叫的不补：发话人是别的 bot、没有发话人编号、不是用户触发（定时任务、心跳）都不补', async () => {
  for (const bad of [{ senderId: BOT_ID }, { senderId: undefined }, { trigger: 'cron' }, { trigger: 'heartbeat' }, { trigger: undefined }]) {
    const { n, sent, logs } = mk();
    n.noteTool(WRITE('/x/a.md'), CTX);
    const r = await n.settle({ ...CTX, ...bad });
    assert.equal(r.sent, false, JSON.stringify(bad)); assert.equal(sent.length, 0);
    assert.ok(logs.some((l) => l.event === 'small-job-skip' && /不是主人本人叫的/.test(l.why)), JSON.stringify(bad));
  }
});

test('已经在主区域说过的不补：这一轮用 message 工具往上级频道发过话；往线程里发、点表情、往别的频道发不算', async () => {
  const sendTo = (target, action = 'send') => ({ toolName: 'mcp__openclaw__message', params: { action, target, message: '做完了' }, result: { ok: true } });
  const { n, sent, logs } = mk();
  n.noteTool(WRITE('/x/a.md'), CTX); n.noteTool(sendTo(`channel:${PROJECT_CH}`), CTX);
  assert.equal((await n.settle(CTX)).sent, false); assert.ok(logs.some((l) => /已经往主区域发过话/.test(l.why))); assert.equal(sent.length, 0);
  for (const [target, action] of [[`channel:${THREAD}`, 'send'], [`channel:${PROJECT_CH}`, 'react'], ['channel:100000000000000133', 'send']]) {
    const t = mk(); t.n.noteTool(WRITE('/x/a.md'), CTX); t.n.noteTool(sendTo(target, action), CTX);
    assert.equal((await t.n.settle(CTX)).sent, true, `${target} ${action}`);
  }
  const failed = mk(); failed.n.noteTool(WRITE('/x/a.md'), CTX); failed.n.noteTool({ ...sendTo(`channel:${PROJECT_CH}`), result: { ok: false } }, CTX);
  assert.equal((await failed.n.settle(CTX)).sent, true, '往主区域发失败了：等于没说，照补');
});

test('没动文件的不补：只读工具、写文件失败、没有任何工具调用；且安静（不记日志）', async () => {
  const { n, sent, logs } = mk();
  n.noteTool({ toolName: 'read', params: { path: '/x/a.md' }, result: { ok: true } }, CTX);
  n.noteTool({ ...WRITE('/x/b.md'), error: '写不进去' }, CTX);
  n.noteTool({ toolName: 'write', params: { file_path: '/x/c.md' }, result: { isError: true } }, CTX);
  assert.deepEqual(await n.settle(CTX), { sent: false, why: '没动文件' }, '只读／失败的调用：没动文件');
  n.noteTool({ toolName: 'message', params: { action: 'send', target: 'channel:100000000000000133', message: 'x' }, result: { ok: true } }, { ...CTX, runId: 'run2' });
  assert.deepEqual(await n.settle({ ...CTX, runId: 'run2' }), { sent: false, why: '没动文件' }, '只发过话、没写文件');
  assert.deepEqual(await n.settle({ ...CTX, runId: 'never-seen' }), { sent: false, why: '没有这一轮的记录' });
  assert.equal(sent.length, 0); assert.ok(logs.every((l) => l.event === 'small-job-checked'), '安静：除了诊断行，没有 skip／出错日志');
});

test('茶会不补：在茶会里叫的（茶会不是线程）、线程的上级频道是茶会、排除列表里的频道（以后的闲聊区）都不补', async () => {
  const sk = `agent:main:discord:channel:${WORKSHOP_CHANNEL}`;
  const inTea = mk({ parentChannelOf: async (id) => id });
  inTea.n.noteTool(WRITE('/x/a.md'), { ...CTX, agentId: 'main', sessionKey: sk }); 
  assert.equal((await inTea.n.settle({ ...CTX, agentId: 'main', sessionKey: sk })).sent, false); assert.equal(inTea.sent.length, 0);
  assert.ok(inTea.logs.some((l) => /排除列表|不是在线程里/.test(l.why)));
  const underTea = mk({ parentChannelOf: async () => WORKSHOP_CHANNEL });
  underTea.n.noteTool(WRITE('/x/a.md'), CTX);
  assert.equal((await underTea.n.settle(CTX)).sent, false); assert.ok(underTea.logs.some((l) => /上级频道在排除列表里/.test(l.why)));
  const root = mkdtempSync(join(tmpdir(), 'sj-')); mkdirSync(join(root, 'plugins', 'personal-inbox'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'personal-inbox', 'channel-exclusions.json'), JSON.stringify({ completionNotice: ['100000000000000140'] }));
  try {
    const ex = mk({ syncRoot: root, parentChannelOf: async () => '100000000000000140' });
    ex.n.noteTool(WRITE('/x/a.md'), CTX);
    assert.equal((await ex.n.settle(CTX)).sent, false); assert.ok(ex.logs.some((l) => /上级频道在排除列表里/.test(l.why)));
    const ok = mk({ syncRoot: root }); ok.n.noteTool(WRITE('/x/a.md'), CTX);
    assert.equal((await ok.n.settle(CTX)).sent, true, '不在排除列表里的项目频道照补');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('这一轮程序已经发过完成记录（结案）→ 不再补；审计角色不补；每一轮只补一次', async () => {
  const a = mk(); a.n.noteTool(WRITE('/x/a.md'), CTX); a.n.noteCompletionSent('run1');
  assert.equal((await a.n.settle(CTX)).sent, false); assert.ok(a.logs.some((l) => /已经发过完成记录/.test(l.why)));
  for (const agentId of ['system-auditor', 'task-auditor']) { const b = mk(); b.n.noteTool(WRITE('/x/a.md'), { ...CTX, agentId }); assert.equal((await b.n.settle({ ...CTX, agentId })).sent, false, agentId); }
  const c = mk(); c.n.noteTool(WRITE('/x/a.md'), CTX);
  assert.equal((await c.n.settle(CTX)).sent, true); assert.equal((await c.n.settle(CTX)).sent, false); assert.equal(c.sent.length, 1);
});

test('各种出错都不抛、不补：算不出上级频道、算频道抛错、发送抛错、没有发送函数、读不出线程编号', async () => {
  const cases = [
    mk({ parentChannelOf: async () => null }), mk({ parentChannelOf: async () => { throw new Error('命令行超时'); } }), mk({ send: async () => { throw new Error('发不出去'); } }), mk({ send: null }),
  ];
  for (const c of cases) { c.n.noteTool(WRITE('/x/a.md'), CTX); const r = await c.n.settle(CTX); assert.equal(r.sent, false); }
  const noThread = mk(); noThread.n.noteTool(WRITE('/x/a.md'), { ...CTX, sessionKey: 'agent:main:main' });
  assert.equal((await noThread.n.settle({ ...CTX, sessionKey: 'agent:main:main' })).why, '会话里读不出线程编号');
});

test('接线：after_tool_call 记工具、agent_end 立刻返回（算频道很慢也不拖住）、后台补发；程序发过完成记录时通过 onSent 告知', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { n, sent } = mk({ parentChannelOf: async () => { await gate; return PROJECT_CH; } });
  const handlers = []; registerSmallJobNotice({ on: (name, fn, o) => handlers.push({ name, fn, o }) }, n);
  assert.deepEqual(handlers.map((h) => h.name).sort(), ['after_tool_call', 'agent_end']);
  const tool = handlers.find((h) => h.name === 'after_tool_call').fn; const end = handlers.find((h) => h.name === 'agent_end').fn;
  tool(WRITE('/x/a.md'), CTX);
  const t0 = Date.now(); assert.equal(end({}, CTX), undefined); assert.ok(Date.now() - t0 < 300);
  assert.equal(sent.length, 0); release(); for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  // 完成记录模块发成功后回调
  const calls = []; const cn = createCompletionNotice({ getCard: async () => ({ title: 't' }), parentChannelOf: async () => PROJECT_CH, send: async () => ({ ok: true }), roleName: () => '执行者E', onSent: (x) => calls.push(x) });
  cn.arm('tc1', { cardId: 'c1', agentId: 'worker-e', sessionKey: SK, runId: 'run9' });
  await cn.settle({ toolCallId: 'tc1', result: { ok: true } });
  assert.deepEqual(calls, [{ runId: 'run9', channelId: PROJECT_CH, cardId: 'c1' }]);
});

test('写过的文件另一个来源：执行记录的写入证据（getWrites）——after_tool_call 没看到写工具时也补；两边合并去重；getWrites 出错当没有', async () => {
  const a = mk({ getWrites: (id) => (id === 'run1' ? ['/opt/solofleet-data/任务测试/hy-s7c.txt'] : []) });
  const r = await a.n.settle(CTX); // 一个 noteTool 都没有，只有执行记录的证据
  assert.equal(r.sent, true); assert.match(a.sent[0].message, /改了：hy-s7c\.txt$/);
  const b = mk({ getWrites: () => ['/x/a.md'] }); b.n.noteTool(WRITE('/x/a.md'), CTX); b.n.noteTool(WRITE('/y/b.md'), CTX);
  assert.equal((await b.n.settle(CTX)).sent, true); assert.match(b.sent[0].message, /改了：a\.md、b\.md$/);
  const c = mk({ getWrites: () => { throw new Error('读不了'); } }); assert.equal((await c.n.settle(CTX)).sent, false);
  const d = mk({ getWrites: () => [] }); assert.deepEqual(await d.n.settle(CTX), { sent: false, why: '没有这一轮的记录' });
});

test('诊断日志：主人本人叫的每一轮都记一行 small-job-checked（写了几个文件、来源、有没有这一轮记录）；别人叫的不记', async () => {
  const a = mk({ getWrites: () => ['/x/a.md'] }); await a.n.settle(CTX);
  const row = a.logs.find((l) => l.event === 'small-job-checked'); assert.ok(row); assert.equal(row.viaRecord, 1); assert.equal(row.viaTools, 0); assert.equal(row.hasRun, false);
  const b = mk(); await b.n.settle({ ...CTX, senderId: BOT_ID }); assert.ok(!b.logs.some((l) => l.event === 'small-job-checked'));
  const c = mk(); await c.n.settle(CTX); assert.ok(c.logs.some((l) => l.event === 'small-job-checked' && l.viaRecord === 0));
});

test('只读的 exec 命令不补（小审①）：引号里的 > 的 jq／awk、cat、here-doc 正文、echo 到终端都不算写文件', async () => {
  const EXEC = (command) => ({ toolName: 'exec', params: { command }, result: { ok: true } });
  for (const command of [
    `jq '.items[] | select(.n > 3)' /x/a.json`,
    `awk '$1 > 100 {print}' /x/b.txt`,
    `cat /x/a.md | head -3`,
    `cat <<'EOF'\n> 注意：这是正文\nEOF`,
    `echo "a > b"`,
    `ls -la /x`,
  ]) {
    const { n, sent, logs } = mk();
    n.noteTool(EXEC(command), CTX);
    const r = await n.settle(CTX);
    assert.equal(r.sent, false, command); assert.equal(sent.length, 0, command);
    assert.ok(!logs.some((l) => l.event === 'small-job-sent'), command);
  }
});
