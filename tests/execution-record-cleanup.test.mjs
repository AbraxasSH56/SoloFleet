// Offline tests for execution record cleanup: temporary directories and fake data only; nothing touches a real deployment.
// 发出消息清理乙（去末尾 NO_REPLY，含乙＋）、甲（删开头纯英文过程话）、丙（两句系统英文换中文）、丁（只有型号行的状态通知）。
// 运行：node --test tests/execution-record-cleanup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { crew } from '../plugins/personal-inbox/crew-config.mjs';
import { mkdtempSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createExecutionRecord, writeEnglishArchive, isEnglishProcessParagraph, isModelLinesOnly, stripLeadingEnglish, stripTrailingNoReply, stripEnglishBeforeNoReply, translateSystemEnglish,
} from '../plugins/personal-inbox/execution-record.mjs';

const findCodeRegions = (text) => { const regions = []; const re = /```[\s\S]*?(?:```|$)/g; let m; while ((m = re.exec(text))) regions.push({ start: m.index, end: m.index + m[0].length }); return regions; };
const REGISTRIES = ['assistantSeen', 'changeLists', 'runMarkers', 'fragments'];
const reset = () => { for (const k of REGISTRIES) globalThis[Symbol.for(`personal-inbox.execution-record.${k}`)]?.clear(); delete globalThis[Symbol.for('personal-inbox.execution-record.runs.v1')]; };
const MK = (files) => `[[oc_changes ${JSON.stringify({ files })}]]`;
const FOOTER = 'Opus/Cli · medium';
const usage = { resolvedRef: 'claude-cli/claude-opus-5-5', reasoningEffort: 'medium' };
const NOW = Date.parse('2026-11-17T04:30:00Z');
const CTX = { accountId: 'default', conversationId: 'channel:1', channelId: 'discord' };

function bench(opts = {}) {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'erc-ws-'))); const zl = realpathSync(mkdtempSync(join(tmpdir(), 'erc-zl-')));
  for (const f of ['a.md', 'b.md']) writeFileSync(join(ws, f), f);
  reset();
  const logs = [];
  const r = createExecutionRecord({ now: () => NOW, readQuota: async () => ({ status: 'unknown' }), workspaceFor: () => ws, ziliaoRoot: zl, findCodeRegions, logger: row => logs.push(row), ...opts });
  return { r, logs };
}
const start = (r, runId) => r.observe({ runId, stream: 'lifecycle', data: { phase: 'start' } });
const say = (r, runId, text) => r.observe({ runId, stream: 'assistant', data: { itemId: `cli-assistant:${runId}`, text } });
const useTool = (r, runId) => { r.observe({ runId, stream: 'tool', data: { phase: 'start', toolCallId: `t-${runId}`, name: 'read', args: { path: '/x' } } }); };
const fin = (r, runId, text, extra = {}, u = usage) => r.payload({ kind: 'final', channel: 'discord', runId, usageState: u, payload: { text, ...extra } }, CTX);
const mid = (r, runId, text, u = usage) => r.payload({ kind: 'block', channel: 'discord', runId, usageState: u, payload: { text } }, CTX);
const notice = (r, runId, text = FOOTER, extra = {}, u = usage) => r.payload({ kind: 'final', channel: 'discord', runId, usageState: u, payload: { text, isStatusNotice: true, ...extra } }, CTX);
const card = (x) => x?.payload?.channelData?.discord?.embeds?.at(-1)?.description?.split('\n');

// ───── 纯函数 ─────
test('乙：stripTrailingNoReply——末尾独立词才去；前面是行首／空白／星号；反引号包着的不去；中间的、别的词的一部分不动', () => {
  const ok = (t, want) => assert.deepEqual(stripTrailingNoReply(t), { text: want, removed: true }, t);
  ok('正文\nNO_REPLY', '正文'); ok('正文  NO_REPLY.', '正文'); ok('正文 *NO_REPLY*', '正文'); ok('正文 **NO_REPLY**。', '正文');
  ok('no_reply', ''); ok('NO_REPLY', ''); ok('正文\n\nNo_Reply！', '正文'); ok('目标文件还不存在,可以直接写。  NO_REPLY', '目标文件还不存在,可以直接写。');
  for (const t of ['NO_REPLY 然后还有话', '这是 NO_REPLYING', '`NO_REPLY`', '写成 `NO_REPLY`。', 'XNO_REPLY', '正文NO_REPLY']) assert.equal(stripTrailingNoReply(t).removed, false, t);
});

test('isEnglishProcessParagraph：过程话符合条件才算；反例（报错原文、代码、引用、列表、超长、中文、无句末标点）都不算', () => {
  for (const t of ['Verify.', 'Reference count 22. Now open the thread.', 'Now project folder, task record, and INDEX row.', 'Update task record status.', "The file doesn't exist yet, so I'm creating it.", 'Now register the pending decision.']) assert.equal(isEnglishProcessParagraph(t), true, t);
  const no = ['Error: file not found.', 'No such file or directory.', 'Failed to open the document.', 'Operation not permitted.', 'Connection refused.', '`ls` first.', 'See http://x.y.', '> quoted.', '# Title.', '- item.', '1. item.', '| a | b |', '    indented.', 'Sonnet 5.5', 'Now let me check the file', 'OK 好.', '', 'x'.repeat(161) + '.', '<@123> hi.', '中文。', 'Cannot continue.', "Can't do it.", 'Request timed out.'];
  for (const t of no) assert.equal(isEnglishProcessParagraph(t), false, t);
});

test('isModelLinesOnly：最多 2 行型号样式行或官方页脚；有别的字、3 行、不在白名单都不算', () => {
  assert.equal(isModelLinesOnly('Opus/Cli · medium'), true); assert.equal(isModelLinesOnly(' \n Opus/Cli · medium\nSonnet/api · high \n'), true);
  assert.equal(isModelLinesOnly('x', 'x'), true);
  for (const t of ['', '好的。\nOpus/Cli · medium', 'Opus/Cli · medium 是什么意思', 'GPT/Cli · high', 'Opus/Cli · medium\nOpus/Cli · medium\nOpus/Cli · medium']) assert.equal(isModelLinesOnly(t), false, t);
});

test('丙：两整句换成中文；’ 和 \' 两种写法、⚠️ 带不带变体符、有无前缀都认；相近但不同的不动', () => {
  const E1 = 'The AI service returned an empty reply. Please try again.';
  const C1 = '⚠️ 这一轮我没有生成可发的内容，请再叫我一次。';
  for (const t of [E1, `⚠️ ${E1}`, `⚠ ${E1}`, `⚠️ ${E1}`, `  ${E1}\n`]) assert.equal(translateSystemEnglish(t), C1, JSON.stringify(t));
  const E2 = "I couldn't confirm whether my previous reply reached this chat, so I won't resend it automatically. Please ask for any missing remainder.";
  const C2 = '上一条回复我没法确认是否送到，不会自动重发，缺什么请再问我。';
  assert.equal(translateSystemEnglish(E2), C2); assert.equal(translateSystemEnglish(E2.replace(/'/g, '’')), C2);
  for (const t of [`${E1} 多一句`, 'The AI service returned an empty reply.', 'I could not confirm whether my previous reply reached this chat.', '', null]) assert.equal(translateSystemEnglish(t), null, String(t));
});

test('甲（纯函数）：stripLeadingEnglish——删开头最多 8 段；整条无中文不动；删完不足 2 个中文字符不动；超过 8 段英文、超 800 字不动', () => {
  const r1 = stripLeadingEnglish('Update task record status.\n\n已更新任务记录。');
  assert.deepEqual(r1.removed, ['Update task record status.']); assert.equal(r1.body, '已更新任务记录。');
  assert.equal(stripLeadingEnglish('First step.\n\nSecond step.\n\n完成了。').removed.length, 2);
  assert.equal(stripLeadingEnglish('One.\n\nTwo.\n\nThree.\n\n完成了。').removed.length, 3, '连续 3 段英文现在删（茶会那条三段英文）');
  assert.equal(stripLeadingEnglish(Array.from({ length: 9 }, (_, i) => `Step ${i + 1} done.`).join('\n\n') + '\n\n完成了。').removed.length, 0, '超过 8 段不动，不留下半截');
  assert.equal(stripLeadingEnglish(Array.from({ length: 8 }, (_, i) => `Step ${i + 1} done.`).join('\n\n') + '\n\n完成了。').removed.length, 8, '正好 8 段删');
  assert.equal(stripLeadingEnglish('Just english here.\n\nMore english.').removed.length, 0, '整条没有中文');
  assert.equal(stripLeadingEnglish('Doing it.\n\n好').removed.length, 0, '删完不足 2 个中文字符');
  assert.equal(stripLeadingEnglish(`${'a'.repeat(150)}.\n\n${'b'.repeat(150)}.\n\n完成了。`).removed.length, 2, '两段合计 300 出头：起不超 800 就删');
  assert.equal(stripLeadingEnglish(`${Array.from({ length: 6 }, () => `${'a'.repeat(150)}.`).join('\n\n')}\n\n完成了。`).removed.length, 0, '合计超 800：保守起见都不删（不留下半截）');
  assert.equal(stripLeadingEnglish('中文开头。\n\nVerify.\n\n中文').removed.length, 0, '开头是中文，中间的英文不管');
});

// ───── 乙：走完整载荷 ─────
test('乙：正文＋NO_REPLY（各种写法）→ 只去 NO_REPLY，中文保留；NO_REPLY 在中间或别的词里不动；反引号包着不动', async () => {
  for (const [raw, want] of [['好了\nNO_REPLY', '好了'], ['好了  NO_REPLY.', '好了'], ['好了 *NO_REPLY*', '好了'], ['目标文件还不存在,可以直接写。  NO_REPLY', '目标文件还不存在,可以直接写。'], ['好了\nno_reply', '好了']]) {
    const { r } = bench(); start(r, 'run1'); say(r, 'run1', raw);
    const x = await fin(r, 'run1', raw);
    assert.equal(x.payload.text, want, raw);
  }
  for (const raw of ['讨论 NO_REPLY 这个词怎么用', '写成 `NO_REPLY` 就行', '这是 NO_REPLYING']) {
    const { r } = bench(); start(r, 'run1'); say(r, 'run1', raw);
    assert.equal((await fin(r, 'run1', raw)).payload.text, raw, raw);
  }
});

test('乙：标记＋NO_REPLY（同行或分行）→ 标记和 NO_REPLY 都去净；有正文时卡列出修改', async () => {
  for (const raw of [`好了\n${MK(['a.md'])}\nNO_REPLY`, `好了\nNO_REPLY\n${MK(['a.md'])}`]) {
    const { r } = bench(); start(r, 'run1'); say(r, 'run1', raw);
    const x = await fin(r, 'run1', raw);
    assert.ok(!x.payload.text.includes('NO_REPLY') && !x.payload.text.includes('oc_changes'), JSON.stringify(x.payload.text));
    assert.equal(x.payload.text, '好了'); assert.equal(card(x).at(-1), '修改：a.md');
  }
});

test('乙／去完 NO_REPLY 变空——这一轮之前没发出过片段 → 取消（什么都不发、不出卡）；之前发过正文 → 只出一张附卡（修改栏合并 bot 自己列的名单）', async () => {
  const raw = `${MK(['a.md'])}\nNO_REPLY`;
  const a = bench(); start(a.r, 'run1'); say(a.r, 'run1', raw);
  assert.deepEqual(await fin(a.r, 'run1', raw), { cancel: true, reason: 'execution-record: silent turn (NO_REPLY only)' });
  const b = bench(); start(b.r, 'run1');
  assert.equal(await mid(b.r, 'run1', '先说一句'), undefined);   // 中途发出一份正文（不改字，原样放行），登记了一个片段
  assert.equal(b.r.fragments('run1').length, 1);
  say(b.r, 'run1', raw);
  const x = await fin(b.r, 'run1', raw);
  assert.equal(x.payload.text, ''); assert.equal(x.payload.isStatusNotice, undefined); assert.equal(card(x).at(-1), '修改：a.md');
  // 只有 NO_REPLY（无标记）也是一样：没发过 → 取消
  const c = bench(); start(c.r, 'run1'); say(c.r, 'run1', 'NO_REPLY');
  assert.equal((await fin(c.r, 'run1', 'NO_REPLY'))?.cancel, true);
  // 带附件的不取消
  const d = bench(); start(d.r, 'run1'); say(d.r, 'run1', 'NO_REPLY');
  const y = await fin(d.r, 'run1', 'NO_REPLY', { mediaUrl: '/tmp/x.png' });
  assert.ok(y && !y.cancel);
});

test('乙／earlier 必须在这一份载荷自己 addFragment 之前算——纯静默轮次（只有 NO_REPLY）第一份最终载荷必须被取消（算晚了 earlier 永远为真，这条会失败）', async () => {
  const { r } = bench(); start(r, 'run9'); say(r, 'run9', `${MK([])}\nNO_REPLY`);
  const x = await fin(r, 'run9', `${MK([])}\nNO_REPLY`);
  assert.equal(x?.cancel, true, '没发过任何片段，应整条取消，而不是出一张空附卡');
  assert.equal(r.fragments('run9').length, 0, '取消的载荷没有登记片段');
});

test('乙＋：用过工具 → 去完 NO_REPLY 后紧挨的纯英文段也去掉（Verify.／执行者E那句／桌面角色结尾句）；中间夹的英文句不动；没用过工具不去', async () => {
  const cases = [
    ['Verify.  NO_REPLY', null],
    ["The file doesn't exist yet, so I'm creating it.  NO_REPLY", null],
    ['进行中：已建好文件。\n\n目标看过了。\n\nSave panel may not have rendered yet; re-screenshot.\n\n还剩一步。\n\nNow register the pending decision. NO_REPLY', '进行中：已建好文件。\n\n目标看过了。\n\nSave panel may not have rendered yet; re-screenshot.\n\n还剩一步。'],
    ['目标文件还不存在,可以直接写。  NO_REPLY', '目标文件还不存在,可以直接写。'],
  ];
  for (const [raw, want] of cases) {
    const a = bench(); start(a.r, 'run1'); useTool(a.r, 'run1'); say(a.r, 'run1', raw);
    const x = await fin(a.r, 'run1', raw);
    if (want === null) assert.equal(x?.cancel, true, raw); else assert.equal(x.payload.text, want, raw);
    if (want === null) assert.ok(a.logs.some(l => l.action === 'drop-english-before-NO_REPLY'), '被删原文写进日志');
  }
  const b = bench(); start(b.r, 'run1'); say(b.r, 'run1', '好了。\n\nVerify. NO_REPLY');
  const y = await fin(b.r, 'run1', '好了。\n\nVerify. NO_REPLY');
  assert.equal(y.payload.text, '好了。\n\nVerify.', '没用过工具：只去 NO_REPLY，英文段不动');
});

test('乙：NO_REPLY 后面留着型号行 → 去掉 NO_REPLY 后只剩型号行 → 整条算空，按"之前有没有发过"分流；还有正文就把型号行原样接回', async () => {
  const raw = `NO_REPLY\n${FOOTER}`;
  const a = bench(); start(a.r, 'run1'); say(a.r, 'run1', 'NO_REPLY');
  assert.equal((await fin(a.r, 'run1', raw, {}, { resolvedRef: 'claude-cli/claude-opus-5-5', reasoningEffort: 'medium' }))?.cancel, true);
  const b = bench(); start(b.r, 'run1'); say(b.r, 'run1', '好了\nNO_REPLY');
  const y = await fin(b.r, 'run1', `好了\nNO_REPLY\n${FOOTER}`, {}, { resolvedRef: 'claude-cli/claude-opus-5-5', reasoningEffort: 'medium' });
  assert.ok(!y.payload.text.includes('NO_REPLY'));
});

test('乙＋／甲：不认识的提供商（不是 claude-cli、也不是 API 路径）一律不动', async () => {
  const other = { resolvedRef: 'openai/gpt-6.1-sol', reasoningEffort: 'high' };
  const { r } = bench(); start(r, 'run1'); useTool(r, 'run1'); say(r, 'run1', 'Verify.\n\n好了。\nNO_REPLY');
  const x = await fin(r, 'run1', 'Verify.\n\n好了。\nNO_REPLY', {}, other);
  assert.equal(x.payload.text, 'Verify.\n\n好了。\nNO_REPLY');
});

// Found in live testing: 真实 API 路径上，官方页脚没配别名，模板直接写出原样型号引用
// （如 `anthropic/claude-fable-5-2 · high`），而且原生运行方式不发命令行那种"最终正文"事件。标记照样要清、页脚要搬进卡、名单要列。
test('备用 bot 批 L6 现场补：API 路径官方页脚是原样型号引用时，标记清掉、页脚搬走、名单进卡；没有标记也搬页脚', async () => {
  for (const provider of ['anthropic', 'anthropic-api', 'anthropic-standby-a', 'anthropic-standby-b']) {
    const ref = `${provider}/claude-fable-5-2`, api = { resolvedRef: ref, reasoningEffort: 'high' }, raw = `${ref} · high`;
    const a = bench(); start(a.r, 'run1'); useTool(a.r, 'run1');
    const x = await fin(a.r, 'run1', `好了。\n${MK(['a.md'])}\n${raw}`, {}, api);
    assert.equal(x.payload.text, '好了。', provider);
    assert.equal(card(x)[0], 'Fable/api · high', provider);
    assert.equal(card(x).at(-1), '修改：a.md', provider);
    const b = bench(); start(b.r, 'run1'); useTool(b.r, 'run1');
    const y = await fin(b.r, 'run1', `好了。\n${MK([])}\n${raw}`, {}, api);
    assert.equal(y.payload.text, '好了。', provider); assert.equal(card(y).at(-1), '修改：无', provider);
    const c = bench(); start(c.r, 'run1');
    const z = await fin(c.r, 'run1', `好了。\n${raw}`, {}, api);
    assert.equal(z.payload.text, '好了。', `${provider} 没有标记：页脚也要搬走`);
    assert.equal(card(z)[0], 'Fable/api · high', provider);
    // 末行不是预期页脚（bot 自己写的别的型号样式）→ 不乱删
    const d = bench(); start(d.r, 'run1'); useTool(d.r, 'run1');
    const w = await fin(d.r, 'run1', `好了。\n${MK(['a.md'])}\nopenai/gpt-6.1-sol · high`, {}, api);
    assert.ok(w.payload.text.includes('好了。'), provider);
  }
});

// 备用 bot 批 L6（甲）：API 路径（标准 anthropic、定时任务专用 anthropic-api）与 claude-cli 一样清理
test('API 路径上最终回复、中途消息、只有页脚的通知三种都照样清（标记／末尾 NO_REPLY／开头英文过程话）', async () => {
  for (const provider of ['anthropic', 'anthropic-api', 'anthropic-standby-a', 'anthropic-standby-b']) {
    const api = { resolvedRef: `${provider}/claude-opus-5-5`, reasoningEffort: 'high' };
    const apiFooter = 'Opus/api · high';
    // ①最终回复：开头英文过程话＋末尾 NO_REPLY＋改动名单标记
    const a = bench(); start(a.r, 'run1'); useTool(a.r, 'run1'); say(a.r, 'run1', `Verify.\n\n好了。\n${MK(['a.md'])}\nNO_REPLY`);
    const x = await fin(a.r, 'run1', `Verify.\n\n好了。\n${MK(['a.md'])}\nNO_REPLY`, {}, api);
    assert.ok(!/NO_REPLY|oc_changes|Verify\./.test(x.payload.text), `${provider} 最终回复没清干净：${x.payload.text}`);
    assert.ok(x.payload.text.includes('好了。'), provider);
    assert.equal(card(x).at(-1), '修改：a.md', provider);
    assert.equal(card(x)[0], 'Opus/api · high', provider);
    // ②中途消息：标记照样去掉，不挂卡
    const b = bench(); start(b.r, 'run1');
    const m = await mid(b.r, 'run1', `进行中。\n${MK(['a.md'])}`, api);
    assert.equal(m?.payload?.text, '进行中。', provider);
    assert.equal(card(m), undefined, provider);
    // ③只有页脚的状态通知：这一轮之前没发过任何片段 → 取消（不发也不出卡）
    const c = bench(); start(c.r, 'run1');
    assert.equal((await notice(c.r, 'run1', apiFooter, {}, api))?.cancel, true, provider);
  }
  // 反面：不认识的提供商，页脚通知原样放行
  const d = bench(); start(d.r, 'run1');
  assert.equal(await notice(d.r, 'run1', 'Opus/api · high', {}, { resolvedRef: 'openai/gpt-6.1-sol', reasoningEffort: 'high' }), undefined);
});

// ───── 甲：走完整载荷 ─────
test('甲：S9 真实样本（用过工具的轮次）开头英文段被删，日志里有原文；中文正文和附卡不受影响', async () => {
  const samples = [['Reference count 22. Now open the thread.\n\n进行中：已打开线程。', '进行中：已打开线程。'], ['Now project folder, task record, and INDEX row.\n\n已写进项目文件夹。', '已写进项目文件夹。'], ['Update task record status.\n\n任务记录状态已更新。', '任务记录状态已更新。']];
  for (const [raw, want] of samples) {
    const { r, logs } = bench(); start(r, 'run1'); useTool(r, 'run1'); say(r, 'run1', `${raw}\n${MK(['a.md'])}`);
    const x = await fin(r, 'run1', `${raw}\n${MK(['a.md'])}\n${FOOTER}`);
    assert.equal(x.payload.text, want, raw); assert.equal(card(x).at(-1), '修改：a.md');
    const l = logs.find(e => e.action === 'drop-leading-english'); assert.ok(l && raw.startsWith(l.text.split(' ¶ ')[0]), JSON.stringify(logs));
    assert.equal(l.usedTools, true);
  }
});

test('甲：桌面角色型（开头是中文，中间夹英文）整条不动；反例都不删（报错原文、代码块、引用、列表、超长、超过 8 段、纯英文、无句号等）', async () => {
  const keep = [
    '进行中：保存。\n\nSave panel may not have rendered yet; re-screenshot.\n\n还剩一步。',
    'Error: file not found.\n\n没找到文件。', 'No such file or directory.\n\n路径不对。', 'Failed to open the document.\n\n打不开文档。',
    'Operation not permitted.\n\n权限不够。', 'Connection refused.\n\n连不上。', '`ls` first.\n\n先列目录。', '```\ncode.\n```\n\n代码如上。', '> Quoted line.\n\n引用如上。',
    '- Item one.\n\n列表如上。', `${'x'.repeat(170)}.\n\n超长英文在前。`, `${Array.from({ length: 9 }, (_, i) => `Step ${i + 1} done.`).join('\n\n')}\n\n完成了。`, 'Pure english reply only.', 'Sonnet 5.5\n\n版本说明。',
    'Now let me check the file\n\n检查中。', '<@123> Thanks.\n\n收到。', 'Verify.\n\n好', 'Verify.',
  ];
  for (const raw of keep) {
    const { r } = bench(); start(r, 'run1'); useTool(r, 'run1'); say(r, 'run1', raw);
    assert.equal((await fin(r, 'run1', raw)).payload.text, raw, raw);
  }
});

test('甲：同样的输入在"这一轮没用过工具"时一律不删（翻译、写信的主要防线）；日志记"没用过工具"；r.tools 拿不到记录也不删', async () => {
  const raw = 'Update task record status.\n\n任务记录状态已更新。';
  const { r, logs } = bench(); start(r, 'run1'); say(r, 'run1', raw);
  assert.equal((await fin(r, 'run1', raw)).payload.text, raw);
  assert.ok(logs.some(e => e.action === 'keep-leading-english' && e.why === '这一轮没用过工具' && e.usedTools === false));
  const { r: r2 } = bench();   // 没有 lifecycle 事件、没有工具记录：touch(create:false) 拿不到
  assert.equal((await fin(r2, 'run2', raw)).payload.text, raw);
});

test('甲：用过工具的轮次里，英文回信／翻译开头的短英文答案后面跟中文，会被删掉英文那段、日志里有原文（design decision: delete, do not mark it on the card）', async () => {
  for (const [raw, want, logPart] of [
    ['Thanks for your email. I will get back to you by Friday.\n\n这样回就行，语气比较正式。', '这样回就行，语气比较正式。', 'Thanks for your email'],
    ['Could you send me the invoice again?\n\n这是"能再发一次发票吗"的说法。', '这是"能再发一次发票吗"的说法。', 'Could you send me the invoice again'],
  ]) {
    const { r, logs } = bench(); start(r, 'run1'); useTool(r, 'run1'); say(r, 'run1', raw);
    const x = await fin(r, 'run1', raw);
    assert.equal(x.payload.text, want);
    assert.ok(logs.some(e => e.action === 'drop-leading-english' && e.text.includes(logPart)), '日志里有被删原文');
    assert.ok(!JSON.stringify(card(x)).includes('英文'), '附卡上不标');
  }
  // 没用过工具时不删
  const raw = 'Thanks for your email. I will get back to you by Friday.\n\n这样回就行。';
  const { r } = bench(); start(r, 'run1'); say(r, 'run1', raw);
  assert.equal((await fin(r, 'run1', raw)).payload.text, raw);
});

test('甲／乙＋：中途载荷（无附件）同样处理——开头英文删、末尾 NO_REPLY 去、只剩 NO_REPLY 取消', async () => {
  const raw = 'Update task record status.\n\n已更新。';
  const { r } = bench(); start(r, 'run1'); useTool(r, 'run1');
  assert.equal((await mid(r, 'run1', raw)).payload.text, '已更新。');
  assert.equal((await mid(r, 'run1', '先做这个。\nNO_REPLY')).payload.text, '先做这个。');
  assert.equal(await mid(r, 'run1', 'NO_REPLY').then(v => v?.cancel), true);
});

test('审计带附件的载荷，甲和乙＋都不动（最终载荷和中途载荷）；去末尾 NO_REPLY 照做；日志记"跳过"', async () => {
  const raw = 'Update task record status.\n\n已更新。';
  // 最终载荷带附件：开头英文不删
  const a = bench(); start(a.r, 'run1'); useTool(a.r, 'run1'); say(a.r, 'run1', raw);
  const z = await fin(a.r, 'run1', raw, { mediaUrl: '/tmp/x.png' });
  assert.equal(z.payload.text, raw, '带附件：开头英文不删');
  assert.ok(a.logs.some(l => l.action === 'skip-english-cleanup'));
  // 最终载荷带附件、末尾有 NO_REPLY＋紧挨的纯英文：NO_REPLY 照去，紧挨的英文段（乙＋）不删
  const b = bench(); start(b.r, 'run2'); useTool(b.r, 'run2'); say(b.r, 'run2', '已更新。\n\nVerify. NO_REPLY');
  const y = await fin(b.r, 'run2', '已更新。\n\nVerify. NO_REPLY', { mediaUrl: '/tmp/x.png' });
  assert.equal(y.payload.text, '已更新。\n\nVerify.', '带附件：NO_REPLY 去掉，英文段（乙＋）不动');
  // 中途载荷带附件：不动（既没删英文也没有别的改动 → 原样放行）
  const c = bench(); start(c.r, 'run3'); useTool(c.r, 'run3');
  assert.equal(await c.r.payload({ kind: 'block', channel: 'discord', runId: 'run3', usageState: usage, payload: { text: raw, mediaUrl: '/tmp/x.png' } }, CTX), undefined);
  // 中途载荷带附件＋结尾英文＋NO_REPLY：只去 NO_REPLY，英文段（乙＋）不动（）
  const e = bench(); start(e.r, 'run5'); useTool(e.r, 'run5');
  const m = await e.r.payload({ kind: 'block', channel: 'discord', runId: 'run5', usageState: usage, payload: { text: '已更新。\n\nVerify. NO_REPLY', mediaUrl: '/tmp/x.png' } }, CTX);
  assert.equal(m.payload.text, '已更新。\n\nVerify.');
  assert.equal(m.payload.mediaUrl, '/tmp/x.png', '附件还在');
  // 对照：同一份载荷去掉附件就会删
  const d = bench(); start(d.r, 'run4'); useTool(d.r, 'run4'); say(d.r, 'run4', raw);
  assert.equal((await fin(d.r, 'run4', raw)).payload.text, '已更新。');
});

test('审计带按钮（components）、presentation、互动的载荷不动（payload() 直接放行，不处理文字）', async () => {
  const raw = 'Update task record status.\n\n已更新。';
  for (const extra of [{ channelData: { discord: { components: [{ type: 1 }] } } }, { presentation: { blocks: [] } }, { interactive: { x: 1 } }]) {
    const { r } = bench(); start(r, 'run1'); useTool(r, 'run1'); say(r, 'run1', raw);
    assert.equal(await fin(r, 'run1', raw, extra), undefined, JSON.stringify(extra));
    const { r: q } = bench(); start(q, 'run2'); useTool(q, 'run2');
    assert.equal(await q.payload({ kind: 'block', channel: 'discord', runId: 'run2', usageState: usage, payload: { text: raw, ...extra } }, CTX), undefined, `中途 ${JSON.stringify(extra)}`);
  }
});

test('审计开头是缩进 4 个空格（或制表符）的代码段不删；只去开头的空行', async () => {
  assert.equal(stripLeadingEnglish('    npm install first.\n\n先装依赖再跑。').removed.length, 0);
  assert.equal(stripLeadingEnglish('\tnpm install first.\n\n先装依赖再跑。').removed.length, 0);
  assert.equal(stripLeadingEnglish('\n\nUpdate task record status.\n\n已更新。').removed.length, 1, '开头的空行不影响，照删');
  const { r } = bench(); start(r, 'run1'); useTool(r, 'run1'); say(r, 'run1', '    npm install first.\n\n先装依赖再跑。');
  assert.equal((await fin(r, 'run1', '    npm install first.\n\n先装依赖再跑。')).payload.text, '    npm install first.\n\n先装依赖再跑。');
});

test('审计②-5（6g 离线核）：用 message 工具在原处回复，只在 afterTool 里留工具记录，不会在片段表里留片段；随后只输出 NO_REPLY 的最终载荷按"没发过片段"取消', async () => {
  const { r } = bench(); start(r, 'run1');
  r.afterTool({ toolName: 'message', params: { action: 'send', target: 'channel:1', message: '回复', final: true }, result: { ok: true, details: { channel: 'discord', to: 'channel:1' } } }, { runId: 'run1', toolCallId: 'm1' });
  assert.equal(r.fragments('run1').length, 0, 'message 工具发送不会进片段表（片段只在 reply_payload_sending 里登记）');
  say(r, 'run1', 'NO_REPLY');
  assert.equal((await fin(r, 'run1', 'NO_REPLY'))?.cancel, true, '纯静默：取消，不出空附卡');
});

test('位置：开头英文＋超长正文时，尾框登记（arm）的正文等于最终发出的正文（甲在 addFragment／arm 之前）；发出后 sent 能按哈希配上', async () => {
  let armed;
  const trailing = { maxChars: 50, arm: (_runId, a) => { armed = a; return true; } };
  const { r } = bench({ trailing }); start(r, 'run1'); useTool(r, 'run1');
  const long = Array.from({ length: 30 }, (_, i) => `第${i + 1}行：填充文字`).join('\n');
  const raw = `Update task record status.\n\n${long}\n${MK(['a.md'])}`;
  say(r, 'run1', raw);
  const x = await fin(r, 'run1', raw);
  assert.equal(x.payload.text, long); assert.equal(armed.body, long);
  assert.equal(r.fragments('run1').at(-1).final, true);
  r.sent({ runId: 'run1', success: true, content: long, messageId: 'M1' });
  assert.equal(r.fragments('run1').at(-1).sent, 'sent');
});

// ───── 丙：message_sending 钩子 ─────
test('丙：message_sending 钩子——两句系统英文换成中文；没有 runId／isError 也换；其他文字、非 Discord 不动', () => {
  const { r } = bench();
  const E1 = 'The AI service returned an empty reply. Please try again.';
  assert.deepEqual(r.messageSending({ to: 'channel:1', content: `⚠️ ${E1}`, metadata: { channel: 'discord' } }, { channelId: 'discord' }), { content: '⚠️ 这一轮我没有生成可发的内容，请再叫我一次。' });
  const E2 = "I couldn’t confirm whether my previous reply reached this chat, so I won’t resend it automatically. Please ask for any missing remainder.";
  assert.deepEqual(r.messageSending({ content: E2 }, { channelId: 'discord' }), { content: '上一条回复我没法确认是否送到，不会自动重发，缺什么请再问我。' });
  assert.equal(r.messageSending({ content: `${E1} 补一句` }, { channelId: 'discord' }), undefined);
  assert.equal(r.messageSending({ content: E1 }, { channelId: 'slack' }), undefined);
  assert.equal(r.messageSending({ content: 123 }, { channelId: 'discord' }), undefined);
});

// ───── 丁 ─────
test('丁：纯静默轮次——官方造的"只有页脚行"状态通知：这一轮之前没发出过片段 → cancel（既不发也不出卡）；型号样式行（1～2 行、前后空白）同样', async () => {
  for (const text of [FOOTER, `  ${FOOTER}\n`, 'Sonnet/api · high', `${FOOTER}\nSonnet/Cli · high`]) {
    const { r, logs } = bench(); start(r, 'run1');
    const x = await notice(r, 'run1', text);
    assert.deepEqual(x, { cancel: true, reason: 'execution-record: footer-only status notice' }, text);
    assert.ok(logs.some(l => l.action === 'cancel-footer-only-status'), '被拦下写一行日志');
  }
});

test('丁／这一轮之前已发过正文、只是最终这份没字 → 只出一条"空文字＋附卡"，修改栏合并 bot 自己列的名单（不写"未列"）；已出过卡的仍是 cancel', async () => {
  const { r } = bench(); start(r, 'run1');
  assert.ok(await mid(r, 'run1', `第一件办好了\n${MK(['a.md'])}`));
  const x = await notice(r, 'run1');
  assert.equal(x.payload.text, ''); assert.equal(x.payload.isStatusNotice, undefined);
  assert.equal(card(x).at(-1), '修改：a.md'); assert.equal(card(x)[0], FOOTER);
  assert.equal((await notice(r, 'run1'))?.cancel, true, '同一轮只一张卡，第二条状态通知取消');
});

test('丁：正文里有任何别的字、型号样式但不在白名单、3 行 → 不动（原样放行）；不是 claude-cli → 不动', async () => {
  for (const text of [`好的。\n${FOOTER}`, `${FOOTER} 是什么意思`, 'GPT/Cli · high', `${FOOTER}\n${FOOTER}\n${FOOTER}`]) {
    const { r } = bench(); start(r, 'run1');
    assert.equal(await notice(r, 'run1', text), undefined, text);
  }
  const { r } = bench(); start(r, 'run1');
  // 原来这里用 anthropic（API 路径）当"非命令行"例子，现在 API 路径也照样清，改用不认识的提供商
  assert.equal(await notice(r, 'run1', FOOTER, {}, { resolvedRef: 'openai/gpt-6.1-sol', reasoningEffort: 'medium' }), undefined);
});

test('丁：带附件的状态通知（footerOnly 老路径）行为与改前相同；这一轮用 message 工具发过带附件消息（哪怕目的地对不上）也走老路径', async () => {
  const { r } = bench(); start(r, 'run1');
  r.afterTool({ toolName: 'message', params: { action: 'send', target: 'channel:777', media: '/x/a.txt' }, result: { ok: false } }, { runId: 'run1', toolCallId: 'm1' });
  assert.equal(await notice(r, 'run1'), undefined, '发过带附件的消息、目的地没对上：老路径原样放行');
  const { r: q } = bench(); start(q, 'run2');
  const media = await q.payload({ kind: 'final', channel: 'discord', runId: 'run2', usageState: usage, payload: { text: '', mediaUrls: ['/x/a.txt'], mediaUrl: '/x/a.txt' } }, CTX);
  assert.equal(media, undefined);
  const x = await notice(q, 'run2');
  assert.equal(x.payload.text, ''); assert.equal(card(x)[0], FOOTER);
});

test('丁／没有 runId 或不是 final 的状态通知到不了 payload()——由 message_sending 兜底：整条只剩型号行 → cancel；带附件或有别的字 → 不动', () => {
  const { r, logs } = bench();
  assert.deepEqual(r.messageSending({ content: FOOTER, metadata: { channel: 'discord' } }, { channelId: 'discord' }), { cancel: true });
  assert.deepEqual(r.messageSending({ content: `${FOOTER}\nSonnet/Cli · high` }, { channelId: 'discord' }), { cancel: true });
  assert.equal(r.messageSending({ content: FOOTER, metadata: { mediaUrls: ['/x/a.png'] } }, { channelId: 'discord' }), undefined);
  assert.equal(r.messageSending({ content: `好的。\n${FOOTER}` }, { channelId: 'discord' }), undefined);
  assert.equal(r.messageSending({ content: '' }, { channelId: 'discord' }), undefined, '空文字＋附卡的消息不动');
  assert.ok(logs.some(l => l.action === 'cancel-model-only-message'));
});

// A-3 只对桌面角色：一段里中文字 ≤4 个也算；原文存档）─────
const startAs = (r, runId, agentId) => r.observe({ runId, agentId, stream: 'lifecycle', data: { phase: 'start' } });

test('茶会型——用过工具，开头连着三段英文，后面是中文结果 → 三段都删（原来 3 段以上一段都不删）', async () => {
  const raw = 'Checking the thread list first.\n\nNow reading the task card.\n\nUpdating the record.\n\n已经更新任务记录，没有发现问题。';
  const { r } = bench(); start(r, 'run1'); useTool(r, 'run1'); say(r, 'run1', raw);
  assert.equal((await fin(r, 'run1', raw)).payload.text, '已经更新任务记录，没有发现问题。');
});

test('桌面角色型——英文句里夹一两个中文按钮名：桌面角色的轮次删，别的 bot 的轮次不动；中文字超过 4 个不删；保护词照旧不删', async () => {
  const raw = 'Save sheet is up for my own unsaved doc. Clicking 删除 (discard), not 保存.\n\n已放弃保存，窗口已关闭。';
  const wolf = bench(); startAs(wolf.r, 'run1', 'desktop'); useTool(wolf.r, 'run1'); say(wolf.r, 'run1', raw);
  assert.equal((await fin(wolf.r, 'run1', raw)).payload.text, '已放弃保存，窗口已关闭。', '桌面角色：删');
  const other = bench(); startAs(other.r, 'run1', 'worker-a'); useTool(other.r, 'run1'); say(other.r, 'run1', raw);
  assert.equal((await fin(other.r, 'run1', raw)).payload.text, raw, '别的 bot：夹中文的英文句不动');
  const many = 'Clicking 删除 and 保存 and 取消 buttons now.\n\n已处理完。';
  const w2 = bench(); startAs(w2.r, 'run1', 'desktop'); useTool(w2.r, 'run1'); say(w2.r, 'run1', many);
  assert.equal((await fin(w2.r, 'run1', many)).payload.text, many, '中文字超过 4 个不删');
  const prot = 'Clicking 删除 failed.\n\n没有关掉。';
  const w3 = bench(); startAs(w3.r, 'run1', 'desktop'); useTool(w3.r, 'run1'); say(w3.r, 'run1', prot);
  assert.equal((await fin(w3.r, 'run1', prot)).payload.text, prot, '含保护词不删');
  const nouse = bench(); startAs(nouse.r, 'run1', 'desktop'); say(nouse.r, 'run1', raw);
  assert.equal((await fin(nouse.r, 'run1', raw)).payload.text, raw, '没用过工具不删');
});

test('存档——删和没删都追加一行，带原文（前 300 字符）、角色、运行编号、动作、原因；存档函数抛错不影响发消息；不传存档函数照常', async () => {
  const rows = [];
  const raw1 = 'Update task record status.\n\n任务记录状态已更新。';
  const { r } = bench({ archive: row => rows.push(row) }); startAs(r, 'run1', 'worker-b'); useTool(r, 'run1'); say(r, 'run1', raw1);
  assert.equal((await fin(r, 'run1', raw1)).payload.text, '任务记录状态已更新。');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'drop-leading-english'); assert.match(rows[0].text, /Update task record status/); assert.equal(rows[0].agent, 'worker-b'); assert.equal(rows[0].runId, 'run1'); assert.ok(rows[0].at);
  const raw2 = 'Error: file not found.\n\n没找到文件。';
  const b2 = bench({ archive: row => rows.push(row) }); startAs(b2.r, 'run2', 'worker-b'); useTool(b2.r, 'run2'); say(b2.r, 'run2', raw2);
  assert.equal((await fin(b2.r, 'run2', raw2)).payload.text, raw2);
  const keepRow = rows.at(-1); assert.equal(keepRow.action, 'keep-leading-english'); assert.equal(keepRow.why, '含保护词'); assert.match(keepRow.text, /Error: file not found/);
  const long = `${'Word. '.repeat(100)}\n\n结果。`; // 超长段不会进存档判断之外，但没删的行原文要截到 300
  const b3 = bench({ archive: row => rows.push(row) }); startAs(b3.r, 'run3', 'worker-b'); useTool(b3.r, 'run3'); say(b3.r, 'run3', long);
  await fin(b3.r, 'run3', long); assert.ok(rows.at(-1).text.length <= 300);
  const b4 = bench({ archive: () => { throw new Error('磁盘满了'); } }); startAs(b4.r, 'run4', 'worker-b'); useTool(b4.r, 'run4'); say(b4.r, 'run4', raw1);
  assert.equal((await fin(b4.r, 'run4', raw1)).payload.text, '任务记录状态已更新。', '存档失败不影响发消息');
});

test('writeEnglishArchive——按测试时区（UTC+5:30）日期追加到 资料/运行记录/英文清理原文/日期.jsonl，一行一条；已有内容不动', () => {
  const zl = realpathSync(mkdtempSync(join(tmpdir(), 'erc-arch-')));
  const t0 = Date.parse('2026-11-18T19:30:00Z'); // 测试时区（UTC+5:30）已是 11-19 01:00
  writeEnglishArchive(zl, { action: 'drop-leading-english', text: '甲' }, t0);
  writeEnglishArchive(zl, { action: 'keep-leading-english', text: '乙' }, t0);
  const f = join(zl, '运行记录', '英文清理原文', '2026-11-19.jsonl');
  const lines = readFileSync(f, 'utf8').trim().split('\n').map(x => JSON.parse(x));
  assert.deepEqual(lines.map(x => x.text), ['甲', '乙']);
});

test('message 工具文字字段里整行的标记被去掉并返回改后的参数；无标记不动；别的工具不动；代码块里的不动；其他参数保持', () => {
  const { r } = bench();
  const withMk = `已经改好了。\n${MK(['a.md'])}`;
  const out = r.stripToolMarker({ toolName: 'message', params: { action: 'send', target: 'channel:1', message: withMk, final: true } }, { runId: 'run1' });
  assert.deepEqual(out, { params: { action: 'send', target: 'channel:1', message: '已经改好了。', final: true } });
  const out2 = r.stripToolMarker({ toolName: 'mcp__openclaw__message', params: { content: withMk, text: 'ok' } }, {});
  assert.equal(out2.params.content, '已经改好了。'); assert.equal(out2.params.text, 'ok', '没有运行编号也去掉（只是不记）');
  assert.equal(r.stripToolMarker({ toolName: 'message', params: { message: '没有标记。' } }, { runId: 'run1' }), undefined);
  assert.equal(r.stripToolMarker({ toolName: 'exec', params: { message: withMk } }, { runId: 'run1' }), undefined, '别的工具不动');
  assert.equal(r.stripToolMarker({ toolName: 'message', params: null }, {}), undefined);
  const inCode = '例子：\n```\n' + MK(['a.md']) + '\n```\n结束。';
  assert.equal(r.stripToolMarker({ toolName: 'message', params: { message: inCode } }, { runId: 'run1' }), undefined, '代码块里的示范标记不动');
});

const E_UNCONFIRMED = "I couldn't confirm whether my previous reply reached this chat, so I won't resend it automatically. Please ask for any missing remainder.";
const E_EMPTY = 'The AI service returned an empty reply. Please try again.';

test('上一条其实发成功了（15 分钟内）→ 取消“没法确认”那句；发失败／没记录／超过 15 分钟 → 照旧发中文；换会话不串', () => {
  let t = NOW;
  const { r } = bench({ now: () => t });
  const ctx = { channelId: 'discord', sessionKey: 'agent:worker-a:discord:channel:1' };
  assert.deepEqual(r.messageSending({ content: E_UNCONFIRMED }, ctx), { content: '上一条回复我没法确认是否送到，不会自动重发，缺什么请再问我。' }, '没有送达记录：照旧发中文');
  r.sent({ success: true, content: '上一条回复', messageId: 'm1' }, ctx);
  assert.deepEqual(r.messageSending({ content: E_UNCONFIRMED }, ctx), { cancel: true }, '上一条发成功：取消');
  assert.deepEqual(r.messageSending({ content: E_UNCONFIRMED }, { channelId: 'discord', sessionKey: 'agent:worker-b:discord:channel:2' }), { content: '上一条回复我没法确认是否送到，不会自动重发，缺什么请再问我。' }, '别的会话不串');
  r.sent({ success: false, content: '又一条' }, ctx);
  assert.deepEqual(r.messageSending({ content: E_UNCONFIRMED }, ctx), { content: '上一条回复我没法确认是否送到，不会自动重发，缺什么请再问我。' }, '最近一条发失败：发中文');
  r.sent({ success: true, content: '再一条' }, ctx); t += 16 * 60 * 1000;
  assert.deepEqual(r.messageSending({ content: E_UNCONFIRMED }, ctx), { content: '上一条回复我没法确认是否送到，不会自动重发，缺什么请再问我。' }, '超过 15 分钟的记录不算');
  assert.equal(r.messageSending({ content: E_UNCONFIRMED }, { channelId: 'slack', sessionKey: 'agent:worker-a:discord:channel:1' }), undefined, '非 Discord 不动');
});

test('这一轮最终文字只有 NO_REPLY（故意不说话）→ “空回复”提示取消；这一轮有正文或没记录 → 照旧发中文', () => {
  const { r, logs } = bench(); const ctx = { channelId: 'discord' };
  start(r, 'run-silent'); say(r, 'run-silent', 'NO_REPLY');
  assert.deepEqual(r.messageSending({ content: E_EMPTY }, { ...ctx, runId: 'run-silent' }), { cancel: true });
  assert.ok(logs.some(e => e.action === 'cancel-empty-reply-notice'));
  start(r, 'run-text'); say(r, 'run-text', '正文一句话。');
  assert.deepEqual(r.messageSending({ content: E_EMPTY }, { ...ctx, runId: 'run-text' }), { content: '⚠️ 这一轮我没有生成可发的内容，请再叫我一次。' }, '有正文：照旧');
  assert.deepEqual(r.messageSending({ content: E_EMPTY }, { ...ctx, runId: 'run-unknown' }), { content: '⚠️ 这一轮我没有生成可发的内容，请再叫我一次。' }, '没记录：照旧');
  assert.deepEqual(r.messageSending({ content: E_EMPTY }, ctx), { content: '⚠️ 这一轮我没有生成可发的内容，请再叫我一次。' }, '没有 runId：照旧');
  start(r, 'run-nr2'); say(r, 'run-nr2', '好的。\n\nNO_REPLY');
  assert.deepEqual(r.messageSending({ content: E_EMPTY }, { ...ctx, runId: 'run-nr2' }), { content: '⚠️ 这一轮我没有生成可发的内容，请再叫我一次。' }, '有正文再加 NO_REPLY：不是纯沉默，照旧');
});

test('日志：去掉标记时记一行 strip-tool-marker（只记字段名）', () => {
  const { r, logs } = bench();
  r.stripToolMarker({ toolName: 'message', params: { message: `好了。\n${MK(['a.md'])}`, text: 'ok' } }, { runId: 'run1' });
  const row = logs.find((e) => e.action === 'strip-tool-marker'); assert.ok(row); assert.deepEqual(row.fields, ['message']); assert.equal(row.runId, 'run1');
  assert.ok(!JSON.stringify(row).includes('a.md'));
});

test('writesOf：这一轮成功写成功的文件（绝对路径）；失败的、读的、别的轮次的不算', () => {
  const { r } = bench(); start(r, 'runW');
  r.afterTool({ toolName: 'Write', params: { file_path: '/opt/solofleet-data/任务测试/a.txt' }, result: { ok: true } }, { runId: 'runW', toolCallId: 'w1' });
  r.afterTool({ toolName: 'Write', params: { file_path: '/x/failed.txt' }, error: '写不进去' }, { runId: 'runW', toolCallId: 'w2' });
  r.afterTool({ toolName: 'read', params: { path: '/x/read.txt' }, result: { ok: true } }, { runId: 'runW', toolCallId: 'w3' });
  assert.deepEqual(r.writesOf('runW'), ['/opt/solofleet-data/任务测试/a.txt']); assert.deepEqual(r.writesOf('other'), []);
});

test('locale en: the leading-English cleanup is off, so English process paragraphs are kept', async () => {
  const before = crew.locale;
  crew.locale = 'en';
  try {
    const raw = 'Checking the thread list first.\n\nNow reading the task card.\n\nUpdating the record.\n\n已经更新任务记录，没有发现问题。';
    const { r } = bench(); start(r, 'run-en'); useTool(r, 'run-en'); say(r, 'run-en', raw);
    assert.equal((await fin(r, 'run-en', raw)).payload.text, raw);
  } finally { crew.locale = before; }
});
