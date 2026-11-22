// T16（恢复点）在独立副本里另做。只用临时目录和虚构文件名；"像私密"的名字全是虚构、内容无意义。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createExecutionRecord, classifyTool, parseChangeMarker, listLiteral } from '../plugins/personal-inbox/execution-record.mjs';
import { scanRoots, diffSnapshots, describeChanges } from '../plugins/personal-inbox/change-scan.mjs';

// findCodeRegions: the real OpenClaw SDK function when OPENCLAW_SDK_TEXT_CHUNKING is set, else a small stand-in
const SDK_FILE = process.env.OPENCLAW_SDK_TEXT_CHUNKING || '';
let sdk = null;
if (SDK_FILE) { try { sdk = await import(pathToFileURL(SDK_FILE).href); } catch { sdk = null; } }
const { findCodeRegions } = sdk?.findCodeRegions ? sdk : await import('./fixtures/code-regions.mjs');

const REG = Symbol.for('personal-inbox.execution-record.runs.v1');
const reset = () => {
  delete globalThis[REG];
  for (const k of ['assistantSeen', 'changeLists', 'runMarkers', 'fragments']) globalThis[Symbol.for(`personal-inbox.execution-record.${k}`)]?.clear();
};
const dirs = () => ({ ws: realpathSync(mkdtempSync(join(tmpdir(), 'erc-ws-'))), zl: realpathSync(mkdtempSync(join(tmpdir(), 'erc-zl-'))) });
let clock = Date.now();
const mk = ({ ws, zl }, opts = {}) => createExecutionRecord({ now: () => clock, readQuota: async () => ({ status: 'unknown' }), workspaceFor: () => ws, ziliaoRoot: zl, ...opts });
const hook = (r, runId, id, name, args, result, error) => r.afterTool({ toolName: name, params: args, result, ...(error ? { error } : {}) }, { runId, toolCallId: id });
const sStart = (r, runId, id, name, args) => r.observe({ runId, stream: 'tool', data: { phase: 'start', toolCallId: id, name, args } });
const sEnd = (r, runId, id, name, result, { args, isError } = {}) => r.observe({ runId, stream: 'tool', data: { phase: 'result', toolCallId: id, name, result, ...(args ? { args } : {}), ...(isError ? { isError: true } : {}) } });

test('O1 分类表：名称＋动作，各落到固定类别', () => {
  const c = (n, a) => classifyTool(n, a).cls;
  assert.equal(c('webfetch'), 'U'); assert.equal(c('web_fetch'), 'R');
  // 名字按官方钩子同一套规范化：Claude 命令行的 WebSearch 在钩子里就叫 web_search；Bash 叫 exec
  assert.equal(c('WebSearch'), 'R'); assert.equal(c('Bash'), 'X'); assert.equal(c('cron', { action: 'list' }), 'R');
  assert.equal(c('ToolSearch'), 'R'); assert.equal(c('memory_search'), 'R'); assert.equal(c('Read'), 'R'); assert.equal(c('Grep'), 'R');
  assert.equal(c('mcp__openclaw__sessions_history'), 'R'); assert.equal(c('personal_inbox_lookup'), 'R'); assert.equal(c('personal_inbox_sync_verify'), 'R');
  assert.equal(c('Write'), 'W'); assert.equal(c('Edit'), 'W'); assert.equal(c('MultiEdit'), 'W'); assert.equal(c('NotebookEdit'), 'W');
  assert.equal(c('multi_edit'), 'W'); assert.equal(c('notebook_edit'), 'W'); assert.equal(c('multiedit'), 'W'); assert.equal(c('notebookedit'), 'W');
  assert.equal(c('apply_patch'), 'W?'); assert.equal(c('mcp__openclaw__exec'), 'X'); assert.equal(c('Bash'), 'X');
  assert.equal(c('personal_inbox_sync_apply'), 'S'); assert.equal(c('personal_inbox_capture'), 'I'); assert.equal(c('personal_inbox_link_card'), 'I'); assert.equal(c('personal_inbox_sync_register'), 'I');
  assert.deepEqual(classifyTool('message', { action: 'sendAttachment' }), { cls: 'M', action: 'sendattachment' });
  assert.deepEqual(classifyTool('message', { action: 'download-file' }), { cls: 'DL', action: 'download_file' });
  assert.deepEqual(classifyTool('message', { action: 'list-pins' }), { cls: 'R', action: 'list_pins' });
  assert.equal(c('message', { action: 'send' }), 'M'); assert.equal(c('message', { action: 'thread reply' }), 'M'); assert.equal(c('message', { action: 'edit' }), 'M');
  assert.equal(c('message', { action: 'kick' }), 'U'); assert.equal(c('message', { action: 'read' }), 'R');
  assert.equal(c('session_status', {}), 'R'); assert.equal(c('session_status', { model: 'opus' }), 'U');
  assert.equal(c('process', { action: 'list' }), 'R'); assert.equal(c('process', { action: 'log' }), 'R'); assert.equal(c('process', { action: 'kill' }), 'U');
  assert.equal(c('subagents', {}), 'R'); assert.equal(c('subagents', { action: 'list' }), 'R'); assert.equal(c('subagents', { action: 'kill' }), 'U');
  assert.equal(c('automations', { action: 'list' }), 'R'); assert.equal(c('cron', { action: 'runs' }), 'R'); assert.equal(c('automations', { action: 'add' }), 'T'); assert.equal(c('automations', { action: 'frobnicate' }), 'U');
  assert.equal(c('computer', { action: 'screenshot' }), 'R'); assert.equal(c('computer', { action: 'browser_dialog', dialogAction: 'inspect' }), 'R');
  assert.equal(c('computer', { action: 'left_click' }), 'C'); assert.equal(c('computer', { action: 'browser_dialog', dialogAction: 'accept' }), 'C');
  assert.equal(c('sessions_spawn'), 'U'); assert.equal(c('some_unknown_tool'), 'U');
  // 要靠参数分类而参数缺失：先 U，等补齐
  assert.deepEqual(classifyTool('message', undefined), { cls: 'U', needsArgs: true });
  // 动作枚举：按动作分类而没给动作 → missing；给了但不认识 → other
  assert.deepEqual(classifyTool('message', {}), { cls: 'U', action: 'missing' }); assert.deepEqual(classifyTool('message', { action: 'kick' }), { cls: 'U', action: 'other' });
  assert.equal(classifyTool('computer', {}).action, 'missing'); assert.equal(classifyTool('subagents', {}).action, 'missing');
});


// ───────── bot 自列 ─────────
const MK = files => `[[oc_changes ${JSON.stringify({ files })}]]`;
// 最终助手事件（正常 CLI 路径上就是整轮全文）＋载荷；默认载荷正文＝事件文字（可信载荷）
const say = (r, runId, text) => r.observe({ runId, stream: 'assistant', data: { itemId: `cli-assistant:${runId}`, text } });
const send = async (r, runId, text, { payloadText = text, ref = 'claude-cli/claude-opus-5-5', extra = {}, ctx = {} } = {}) =>
  r.payload({ kind: 'final', channel: 'discord', runId, usageState: { resolvedRef: ref, reasoningEffort: 'high' }, payload: { text: payloadText, ...extra } }, ctx);
const lastLine = x => x.payload.channelData.discord.embeds.at(-1).description.split('\n').at(-1);
const turn = async (r, runId, text, opts) => { if (!opts?.noEvent) say(r, runId, text); const x = await send(r, runId, text, opts); return { x, card: x?.payload?.channelData ? lastLine(x) : undefined, body: x?.payload?.text }; };
const w = (r, runId, id, file, extra = {}) => hook(r, runId, id, 'Write', { file_path: file }, { content: [] }, extra.error);
const mkd = (d, opts = {}) => mk(d, { findCodeRegions, ...opts });
const startRun = (r, runId = 'run1') => r.observe({ runId, stream: 'lifecycle', data: { phase: 'start' } });

test('T1 正常自列：列 A、B → 卡列 A、B，正文去掉标记；空数组 → 无；命令行写了自列 → 不加长话；命令行写了却报空 → 无', async () => {
  reset(); const d = dirs();
  writeFileSync(join(d.ws, 'A.md'), 'a'); writeFileSync(join(d.ws, 'B.md'), 'b');
  let r = mkd(d); startRun(r);
  let t = await turn(r, 'run1', `好了\n${MK(['A.md', 'B.md'])}`);
  assert.equal(t.card, '修改：A.md、B.md'); assert.equal(t.body, '好了');
  reset(); r = mkd(d); startRun(r);
  t = await turn(r, 'run1', `收到\n${MK([])}`); assert.equal(t.card, '修改：无'); assert.equal(t.body, '收到');
  reset(); r = mkd(d); startRun(r); hook(r, 'run1', 'x', 'exec', { command: 'opaque' }, { content: [] });
  t = await turn(r, 'run1', `建好了\n${MK(['B.md'])}`); assert.equal(t.card, '修改：B.md');
  reset(); r = mkd(d); startRun(r); hook(r, 'run1', 'x', 'exec', { command: 'opaque' }, { content: [] });
  t = await turn(r, 'run1', `没改\n${MK([])}`); assert.equal(t.card, '修改：无');   // 主人接受的取舍
});

test('T2a 可信原文里确认是协议行、但 JSON 错 → 未列、不报漏列、这一行被消费；里面的私密名不出现', async () => {
  reset(); const d = dirs(); const r = mkd(d); startRun(r);
  w(r, 'run1', 'w1', join(d.ws, 'c.md'));
  const t = await turn(r, 'run1', '好了\n[[oc_changes {"files":["测试.env",]}]]');
  assert.match(t.card, /^修改：未列/); assert.doesNotMatch(t.card, /漏列|测试\.env/);
  assert.equal(t.body, '好了'); assert.doesNotMatch(JSON.stringify(t.x), /测试\.env/);
});

test('T2b 缺标记、不在最后一行、在代码块、在引用、标记在 MEDIA 行之前 → 未列，正文一字不删', async () => {
  reset(); const d = dirs();
  const cases = [
    '只有正文',
    `${MK(['a.md'])}\n后面还有一句`,
    `示例：\n\`\`\`\n${MK(['a.md'])}`,
    `> ${MK(['a.md'])}`,
  ];
  for (const text of cases) {
    reset(); const r = mkd(d); startRun(r);
    const t = await turn(r, 'run1', text);
    assert.equal(t.card, '修改：未列', text); assert.equal(t.body, text, text);
  }
  reset(); const r = mkd(d); startRun(r);
  say(r, 'run1', `附件见下\n${MK(['a.md'])}\nMEDIA:/tmp/x.png`);
  const x = await send(r, 'run1', null, { payloadText: `附件见下\n${MK(['a.md'])}`, extra: { mediaUrls: ['/tmp/x.png'] } });
  assert.equal(lastLine(x), '修改：a.md'); assert.equal(x.payload.text, '附件见下');
});

test('T3 超限：51 项（第 51 项恰好有明确写入证据）、超过 8 KB → 未列，不报漏列、不给数量，标记行被消费', async () => {
  reset(); const d = dirs(); let r = mkd(d); startRun(r);
  const files = Array.from({ length: 51 }, (_, i) => `f${i}.md`);
  w(r, 'run1', 'w51', join(d.ws, 'f50.md'));
  let t = await turn(r, 'run1', `好了\n${MK(files)}`);
  assert.equal(t.card, '修改：未列（工具记录：f50.md）'); assert.doesNotMatch(t.card, /漏列|51/); assert.equal(t.body, '好了');
  reset(); r = mkd(d); startRun(r);
  t = await turn(r, 'run1', `好了\n${MK(['x'.repeat(9000)])}`);
  assert.equal(t.card, '修改：未列'); assert.equal(t.body, '好了');
});

test('T4 明确漏列：写 C、D 只列 C → 正好提醒 D 一次；重复写 D 不增数；失败、没结束、结果不明、冲突、相对目标都不冒充', async () => {
  reset(); const d = dirs(); const C = join(d.ws, 'C.md'), D = join(d.ws, 'D.md');
  writeFileSync(C, 'c'); writeFileSync(D, 'd');
  let r = mkd(d); startRun(r);
  w(r, 'run1', 'w1', C); w(r, 'run1', 'w2', D); w(r, 'run1', 'w3', D);
  let t = await turn(r, 'run1', `好了\n${MK(['C.md'])}`);
  assert.equal(t.card, '修改：C.md（另有 1 个漏列：D.md）');
  reset(); r = mkd(d); startRun(r);
  hook(r, 'run1', 'f', 'Write', { file_path: join(d.ws, 'fail.md') }, undefined, 'EACCES');          // 失败
  hook(r, 'run1', 'u', 'Write', { file_path: join(d.ws, 'unknown.md') }, undefined);               // 结果不明
  sStart(r, 'run1', 'p', 'Write', { file_path: join(d.ws, 'pending.md') });                          // 没结束
  hook(r, 'run1', 'rel', 'Write', { file_path: 'relative.md' }, { content: [] });                     // 相对目标
  sStart(r, 'run1', 'k', 'Write', { file_path: join(d.ws, 'k1.md') }); hook(r, 'run1', 'k', 'Write', { file_path: join(d.ws, 'k2.md') }, { content: [] });   // 目标冲突
  t = await turn(r, 'run1', `好了\n${MK([])}`);
  assert.equal(t.card, '修改：无');
});

test('T5 同步：written:true 列了不提醒、没列才提醒；written:false 不算；双入口不重复', async () => {
  reset(); const d = dirs(); const S = join(d.ws, 'S1.txt'); writeFileSync(S, 'S1');
  const card = details => ({ content: [{ type: 'text', text: '{}' }], details });
  const sync = (r, details) => { sStart(r, 'run1', 'toolu_s', 'mcp__openclaw__personal_inbox_sync_apply', {}); sEnd(r, 'run1', 'toolu_s', 'mcp__openclaw__personal_inbox_sync_apply', []); hook(r, 'run1', 'mcp-s', 'personal_inbox_sync_apply', {}, card(details)); };
  let r = mkd(d); startRun(r); sync(r, { written: true, target: S });
  assert.equal((await turn(r, 'run1', `好了\n${MK(['S1.txt'])}`)).card, '修改：S1.txt');
  reset(); r = mkd(d); startRun(r); sync(r, { written: true, target: S });
  assert.equal((await turn(r, 'run1', `好了\n${MK([])}`)).card, '修改：无（另有 1 个漏列：S1.txt）');
  reset(); r = mkd(d); startRun(r); sync(r, { written: false, target: S });
  assert.equal((await turn(r, 'run1', `好了\n${MK([])}`)).card, '修改：无');
});

test('T6 身份：绝对、相对、资料/ 互相对得上；工作区/资料/a.md 与全局资料/a.md 不混；同名不同目录不混；第 9 个已列不被提醒；逗号顿号转义不拆坏', async () => {
  reset(); const d = dirs();
  mkdirSync(join(d.ws, '资料')); writeFileSync(join(d.ws, '资料', 'a.md'), 'ws'); writeFileSync(join(d.zl, 'a.md'), 'zl');
  mkdirSync(join(d.ws, 'p')); mkdirSync(join(d.ws, 'q')); writeFileSync(join(d.ws, 'p', 'same.md'), 'p'); writeFileSync(join(d.ws, 'q', 'same.md'), 'q');
  const odd = '报告,第一版、终稿"引号".md'; writeFileSync(join(d.ws, odd), 'o');
  let r = mkd(d); startRun(r);
  w(r, 'run1', 'w1', join(d.zl, 'a.md'));            // 写的是全局资料
  w(r, 'run1', 'w2', join(d.ws, 'p', 'same.md'));
  w(r, 'run1', 'w3', join(d.ws, odd));
  let t = await turn(r, 'run1', `好了\n${MK(['资料/a.md', 'p/same.md', odd])}`);
  assert.equal(t.card, `修改：a.md、p/same.md、${odd}`);   // 资料/a.md 指全局资料，和证据对上
  reset(); r = mkd(d); startRun(r);
  w(r, 'run1', 'w1', join(d.ws, '资料', 'a.md'));      // 写的是工作区里的"资料/a.md"
  w(r, 'run1', 'w2', join(d.ws, 'q', 'same.md'));
  t = await turn(r, 'run1', `好了\n${MK(['资料/a.md', 'p/same.md'])}`);
  assert.equal(t.card, '修改：a.md、p/same.md（另有 2 个漏列：资料/a.md、q/same.md）');
  // 第 9 个已列文件不因显示截断被提醒
  reset(); r = mkd(d); startRun(r);
  const nine = Array.from({ length: 9 }, (_, i) => `n${i}.md`); nine.forEach(f => writeFileSync(join(d.ws, f), f));
  w(r, 'run1', 'w9', join(d.ws, 'n8.md'));
  t = await turn(r, 'run1', `好了\n${MK(nine)}`);
  assert.equal(t.card, '修改：n0.md、n1.md、n2.md、n3.md、n4.md、n5.md、n6.md、n7.md 等 9 个');
});

test('T7 核不清不报：①证据成功、名单侧别名查询超时；②两边都失败；③证据有真实键、名单侧文件和上级都不存在且字面不同 → 不报漏列，也不显示该名字', async () => {
  reset(); const d = dirs();
  mkdirSync(join(d.ws, 'real')); writeFileSync(join(d.ws, 'real', 'a.md'), 'a'); symlinkSync(join(d.ws, 'real'), join(d.ws, 'alias'));
  const slowFor = needle => p => String(p).includes(needle) ? new Promise(() => {}) : realpath(p);
  let r = mkd(d, { realpathFn: slowFor('alias'), finalScanWaitMs: 100 }); startRun(r);
  w(r, 'run1', 'w1', join(d.ws, 'real', 'a.md'));
  let t = await turn(r, 'run1', `好了\n${MK(['alias/a.md'])}`);
  assert.equal(t.card, '修改：1 个名称隐藏'); assert.doesNotMatch(t.card, /漏列/);
  reset(); r = mkd(d, { realpathFn: () => new Promise(() => {}), finalScanWaitMs: 100 }); startRun(r);
  w(r, 'run1', 'w1', join(d.ws, 'real', 'a.md'));
  t = await turn(r, 'run1', `好了\n${MK(['别的.md'])}`);
  assert.doesNotMatch(t.card, /漏列/);
  reset(); r = mkd(d); startRun(r);
  w(r, 'run1', 'w1', join(d.ws, 'real', 'a.md'));
  t = await turn(r, 'run1', `好了\n${MK(['gone-dir/gone.md'])}`);
  assert.equal(t.card, '修改：1 个名称隐藏');   // 上级也不在：没有真实键＝没核清，不报漏列、不显示
});

test('T8 隐私和范围：私密名任一级、链接目标私密、字面在工作区真实在外、确认不了 → 只计数；漏列私密只计数；卡和正文都不出现', async () => {
  reset(); const d = dirs(); const outside = realpathSync(mkdtempSync(join(tmpdir(), 'erc-out-')));
  mkdirSync(join(d.ws, 'secret')); writeFileSync(join(d.ws, 'secret', '普通.md'), 'x'); writeFileSync(join(d.ws, '测试.env'), '测');
  writeFileSync(join(outside, 'o.md'), 'o'); symlinkSync(join(outside, 'o.md'), join(d.ws, '外链.md'));
  mkdirSync(join(d.ws, 'token-dir')); writeFileSync(join(d.ws, 'token-dir', 't.md'), 't'); symlinkSync(join(d.ws, 'token-dir', 't.md'), join(d.ws, 'ok-link.md'));
  writeFileSync(join(d.ws, 'fine.md'), 'f');
  let r = mkd(d); startRun(r);
  w(r, 'run1', 'w1', join(d.ws, 'secret', 'leak-secret.md'));
  const t = await turn(r, 'run1', `好了\n${MK(['fine.md', '测试.env', 'secret/普通.md', '外链.md', 'ok-link.md'])}`);
  assert.equal(t.card, '修改：fine.md（另有 3 个名称隐藏、1 个范围外文件；另有 1 个漏列，名称隐藏）');
  for (const n of ['测试.env', 'secret', '普通', '外链', 'ok-link', 'token', 'leak-secret', outside]) { assert.ok(!t.card.includes(n), n); assert.ok(!t.body.includes(n), n); }
  // 全部隐藏
  reset(); r = mkd(d); startRun(r);
  assert.equal((await turn(r, 'run1', `好了\n${MK(['测试.env'])}`)).card, '修改：1 个名称隐藏');
});

test('T9 正文不丢：普通末行"修改：…"原样保留；~~~ 没闭合、四个反引号围栏里套三个反引号，两种示例标记都不删', async () => {
  reset(); const d = dirs(); writeFileSync(join(d.ws, 'a.md'), 'a');
  let r = mkd(d); startRun(r);
  let t = await turn(r, 'run1', `完成\n修改：报告.md\n${MK(['a.md'])}`);
  assert.equal(t.body, '完成\n修改：报告.md'); assert.equal(t.card, '修改：a.md');
  for (const text of [`格式示例：\n~~~text\n说明\n${MK(['a.md'])}`, `格式示例：\n\`\`\`\`\n\`\`\`\n${MK(['a.md'])}`]) {
    reset(); r = mkd(d); startRun(r);
    t = await turn(r, 'run1', text);
    assert.equal(t.body, text); assert.equal(t.card, '修改：未列');
  }
});

test('T10 没有可信全文 → 不删任何行、未列、不报漏列：多载荷（事件是全文、载荷只是一段）、非 Claude 命令行、没有事件、事件被增量作废、函数没加载', async () => {
  reset(); const d = dirs(); writeFileSync(join(d.ws, 'a.md'), 'a');
  // ①事件是两段拼起来的全文；第二个载荷只是"示例结尾＋标记"一段：对不上，不删
  let r = mkd(d); startRun(r);
  const part1 = '格式示例如下：\n~~~text', part2 = `示例里写\n${MK(['a.md'])}`;
  say(r, 'run1', `${part1}\n${part2}`);
  let x = await send(r, 'run1', null, { payloadText: part1 });
  assert.equal(lastLine(x), '修改：未列'); assert.equal(x.payload.text, part1);
  x = await send(r, 'run1', null, { payloadText: part2 });
// 不再靠“事件全文和载荷逐字配对”，改成发送前按载荷处理；这一段末行是完整标记行，照样去掉（已出过卡，不再出第二张）
  assert.deepEqual(x, { payload: { text: '示例里写' } });
  // ②不是 Claude 命令行后端、也不是 API 路径（anthropic、anthropic-api 现在和命令行一样清标记，见下面 ②b）
  reset(); r = mkd(d); startRun(r);
  let t = await turn(r, 'run1', `好了\n${MK(['a.md'])}`, { ref: 'openai/gpt-6.1-sol' });
  assert.equal(t.card, '修改：未列'); assert.equal(t.body, `好了\n${MK(['a.md'])}`);
  // ②b（备用 bot 批 L6 改）：API 路径（标准 anthropic、定时任务专用 anthropic-api）照样清标记、列进修改栏
  for (const ref of ['anthropic/claude-opus-5-5', 'anthropic-api/claude-opus-5-5', 'anthropic-standby-a/claude-fable-5-2', 'anthropic-standby-b/claude-opus-5-5']) {
    reset(); r = mkd(d); startRun(r);
    t = await turn(r, 'run1', `好了\n${MK(['a.md'])}`, { ref });
    assert.equal(t.card, '修改：a.md', ref); assert.equal(t.body, '好了', ref);
  }
  // ③没有最终助手事件：3.6 起不再依赖它，标记照样在发送前去掉、列进修改栏
  reset(); r = mkd(d); startRun(r);
  t = await turn(r, 'run1', `好了\n${MK(['a.md'])}`, { noEvent: true });
  assert.equal(t.card, '修改：a.md'); assert.equal(t.body, '好了');
  // ④最终之后又来增量：同样不影响发送前处理
  reset(); r = mkd(d); startRun(r); say(r, 'run1', `好了\n${MK(['a.md'])}`);
  r.observe({ runId: 'run1', stream: 'assistant', data: { itemId: 'cli-assistant:run1', text: '好', delta: '好' } });
  x = await send(r, 'run1', `好了\n${MK(['a.md'])}`);
  assert.equal(lastLine(x), '修改：a.md'); assert.equal(x.payload.text, '好了');
  // ⑤公开函数没加载好
  reset(); delete globalThis[Symbol.for('personal-inbox.execution-record.findCodeRegions')];
  r = mk(d); startRun(r);
  t = await turn(r, 'run1', `好了\n${MK(['a.md'])}`);
  assert.equal(t.card, '修改：未列'); assert.equal(t.body, `好了\n${MK(['a.md'])}`);
});

test('T11 多段与尾框：单载荷长回复登记删完标记的正文；只有名单 → 空文字＋框；已出卡后的可信载荷只剩标记 → cancel；页脚没确认 → 不删', async () => {
  reset(); const d = dirs();
  // 单载荷长回复：尾框登记用删完标记的正文
  let armed; const trailing = { maxChars: 50, arm: (_runId, a) => { armed = a; return true; } };
  let r = mkd(d, { trailing }); startRun(r);
  const long = Array.from({ length: 30 }, (_, i) => `第${i + 1}行：填充文字`).join('\n');
  let t = await turn(r, 'run1', `${long}\n${MK([])}`, { ctx: { accountId: 'default', conversationId: 'channel:1', channelId: 'discord' } });
  assert.equal(t.body, long); assert.equal(armed.body, long); assert.equal(t.x.payload.channelData, undefined);
  assert.match(armed.card.description, /修改：无$/);
  // 只有名单：首卡发"空文字＋框"
  reset(); r = mkd(d); startRun(r);
  t = await turn(r, 'run1', MK([]));
  assert.equal(t.body, ''); assert.equal(t.card, '修改：无'); assert.equal(t.x.payload.isStatusNotice, undefined);
  // 已经出过卡，后一个载荷是可信载荷且删完为空、没有附件 → cancel
  reset(); r = mkd(d); startRun(r); say(r, 'run1', MK([]));
  await send(r, 'run1', null, { payloadText: '前一个载荷' });
  assert.deepEqual(await send(r, 'run1', MK([])), { cancel: true, reason: 'execution-record: change-list marker only' });
  // 标记＋型号行：型号行本身就是可信的删除对象，哪怕页脚没确认搬走也删（桌面角色排队直接接续小批 D7，旧断言按新行为改）
  reset(); r = mkd(d); startRun(r); say(r, 'run1', `原文\n${MK([])}`);
  const x = await send(r, 'run1', null, { payloadText: `被改过的原文\n${MK([])}\nOpus/Cli · high` });
  assert.equal(x.payload.text, '被改过的原文'); assert.equal(lastLine(x), '修改：无');
  // 页脚没确认且标记后面是普通文字 → 不是型号行，仍不认、不删（保留原意）
  reset(); r = mkd(d); startRun(r); say(r, 'run1', `原文\n${MK([])}`);
  const y = await send(r, 'run1', null, { payloadText: `被改过的原文\n${MK([])}\n后面是普通文字` });
  assert.equal(lastLine(y), '修改：未列'); assert.ok(y.payload.text.includes(MK([])));
});

test('T12 不串轮：另一轮的写入不进本轮漏列；到点后才回来的解析不改已出的卡', async () => {
  reset(); const d = dirs(); writeFileSync(join(d.ws, 'other.md'), 'o'); writeFileSync(join(d.ws, 'mine.md'), 'm');
  let r = mkd(d); startRun(r, 'A'); startRun(r, 'B');
  w(r, 'A', 'wa', join(d.ws, 'other.md')); w(r, 'B', 'wb', join(d.ws, 'mine.md'));
  assert.equal((await turn(r, 'B', `好了\n${MK(['mine.md'])}`)).card, '修改：mine.md');
  // 慢解析：卡按预算出，结果晚到不改
  reset(); let release; const gate = new Promise(res => { release = res; });
  r = mkd(d, { realpathFn: async p => { await gate; return realpath(p); }, finalScanWaitMs: 50 }); startRun(r);
  w(r, 'run1', 'w', join(d.ws, 'mine.md'));
  const t0 = Date.now(); const t = await turn(r, 'run1', `好了\n${MK(['mine.md'])}`);
  assert.ok(Date.now() - t0 < 400); assert.equal(t.card, '修改：1 个名称隐藏');
  release(); await new Promise(res => setTimeout(res, 50));
  assert.equal(r.peek('run1').lastChange.line, '修改：1 个名称隐藏');
});

test('T13 资源：扫描调用次数为 0；路径全卡住连续多轮、跨两个实例，未完成调用到上限后不增长、不排队，卡片按预算结束；恢复后正常', async () => {
  reset(); const d = dirs(); writeFileSync(join(d.ws, 'z.md'), 'z');
  const scan = () => { throw Error('扫描不应被调用'); };
  let blocked = true, submitted = 0; const parked = [];
  const realpathFn = p => { submitted++; if (!blocked) return realpath(p); return new Promise((res, rej) => parked.push(() => realpath(p).then(res, rej))); };
  const a = mkd(d, { scan, realpathFn }), b = mkd(d, { scan, realpathFn });
  const reg = globalThis[REG], max = reg.fsInflight.max;
  for (let i = 0; i < 8; i++) {
    const r = i % 2 ? b : a, id = `blk${i}`; startRun(r, id);
    w(r, id, 'w', join(d.ws, 'z.md'));
    const t0 = Date.now(); const t = await turn(r, id, `好了\n${MK(['z.md'])}`); const waited = Date.now() - t0;
    assert.ok(waited < 900, `第 ${i} 轮出卡多等了 ${waited} ms`);
    assert.equal(t.card, '修改：1 个名称隐藏');
    assert.ok(reg.fsInflight.active <= max); assert.ok(submitted <= max, `已发起 ${submitted}`);
  }
  const atCap = submitted; startRun(a, 'more'); w(a, 'more', 'w', join(d.ws, 'z.md')); await turn(a, 'more', `好了\n${MK(['z.md'])}`);
  assert.equal(submitted, atCap, '到上限后不再发起、不排队');
  // 纯聊天、没有写入证据：不发起路径查询
  startRun(a, 'chat'); const before = submitted; await turn(a, 'chat', `收到\n${MK([])}`); assert.equal(submitted, before);
  blocked = false; parked.splice(0).forEach(f => f());
  for (let i = 0; i < 100 && reg.fsInflight.active > 0; i++) await new Promise(res => setTimeout(res, 10));
  assert.equal(reg.fsInflight.active, 0);
  startRun(b, 'ok'); w(b, 'ok', 'w', join(d.ws, 'z.md'));
  assert.equal((await turn(b, 'ok', `好了\n${MK(['z.md'])}`)).card, '修改：z.md');
});

test('T14 宿主不改写标记：官方投递清理、显示清理函数处理后，标记（含转义文件名）原样保留', { skip: !sdk }, async () => {
  const line = MK(['报告,第一版、"引号".md', 'a\\b.md']);
  const text = `正文\n${line}`;
  for (const fn of ['stripInlineDirectiveTagsForDelivery', 'stripInlineDirectiveTagsForDisplay', 'sanitizeAssistantVisibleText']) {
    if (typeof sdk[fn] !== 'function') continue;
    const out = sdk[fn](text);
    const s = typeof out === 'string' ? out : out?.text ?? JSON.stringify(out);
    assert.ok(s.includes(line), `${fn} 改写了标记：${s}`);
  }
});

test('T-解析单元：parseChangeMarker、listLiteral', () => {
  assert.deepEqual(parseChangeMarker(`x\n${MK(['a'])}`, findCodeRegions).status, 'valid');
  assert.equal(parseChangeMarker(`x\n${MK(['a'])}`, null).status, 'none');
  assert.equal(parseChangeMarker('x\n[[oc_changes {"files":["a"],"x":1}]]', findCodeRegions).status, 'invalid');
  assert.equal(parseChangeMarker('x\n[[oc_changes {"files":[""]}]]', findCodeRegions).status, 'invalid');
  assert.equal(listLiteral('资料/项目/a.md', '/ws', '/zl'), '/zl/项目/a.md');
  assert.equal(listLiteral('a/../b.md', '/ws', '/zl'), '/ws/b.md');
  assert.equal(listLiteral('/abs//x.md', '/ws', '/zl'), '/abs/x.md');
  assert.equal(listLiteral('~/x.md', '/ws', '/zl'), null); assert.equal(listLiteral('', '/ws', '/zl'), null);
});

test('change-scan 单元：diff 认新增、删除、属性变化；sinceMs 补候选；不读文件内容', async () => {
  const d = dirs(); writeFileSync(join(d.ws, 'keep.txt'), 'a'); writeFileSync(join(d.ws, 'gone.txt'), 'a');
  const before = (await scanRoots([{ id: 'workspace', path: d.ws }])).entries;
  writeFileSync(join(d.ws, 'keep.txt'), 'ab'); writeFileSync(join(d.ws, 'new.txt'), 'a');
  const { rmSync } = await import('node:fs'); rmSync(join(d.ws, 'gone.txt'));
  const after = (await scanRoots([{ id: 'workspace', path: d.ws }])).entries;
  const changed = diffSnapshots(before, after);
  assert.deepEqual([...changed.keys()].map(k => k.slice(d.ws.length + 1)).sort(), ['gone.txt', 'keep.txt', 'new.txt']);
  const described = await describeChanges(changed, [{ id: 'workspace', path: d.ws }]);
  assert.equal(described.candidates.length, 3);
});
