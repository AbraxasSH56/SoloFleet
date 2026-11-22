// Offline tests for execution record fable fragments: temporary directories and fake data only; nothing touches a real deployment.
// 附卡三项离线测试：认 Fable、Fable 窗口穿过缓存和跨实例传递、额度行新格式、标记在发送前按 runId 处理。
// 运行：node --test tests/execution-record-fable-fragments.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createExecutionRecord, executionModelLabel, selectClaudeCliQuota, createCliQuotaSource, publishCliQuota, parseChangeMarker } from '../plugins/personal-inbox/execution-record.mjs';

// 代码区域识别：用最小替身（``` 围起来的算代码区域），不依赖官方 SDK 的具体版本。
const findCodeRegions = (text) => {
  const regions = []; const re = /```[\s\S]*?(?:```|$)/g; let m;
  while ((m = re.exec(text))) regions.push({ start: m.index, end: m.index + m[0].length });
  return regions;
};
const REGISTRIES = ['assistantSeen', 'changeLists', 'runMarkers', 'fragments'];
const reset = () => { for (const k of REGISTRIES) globalThis[Symbol.for(`personal-inbox.execution-record.${k}`)]?.clear(); delete globalThis[Symbol.for('personal-inbox.execution-record.runs.v1')]; };
const MK = (files) => `[[oc_changes ${JSON.stringify({ files })}]]`;
const FOOTER = 'Sonnet/Cli · high';
const usage = { resolvedRef: 'claude-cli/claude-sonnet-5-5', reasoningEffort: 'high' };
const NOW = Date.parse('2026-11-11T00:00:00Z');

function bench(opts = {}) {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'erf-ws-'))); const zl = realpathSync(mkdtempSync(join(tmpdir(), 'erf-zl-')));
  for (const f of ['a.md', 'b.md', 'c.md']) writeFileSync(join(ws, f), f);
  reset();
  const r = createExecutionRecord({ now: () => NOW, readQuota: async () => opts.quota ?? { status: 'unknown' }, workspaceFor: () => ws, ziliaoRoot: zl, findCodeRegions, ...opts.record });
  return r;
}
const start = (r, runId) => r.observe({ runId, stream: 'lifecycle', data: { phase: 'start' } });
const say = (r, runId, text) => r.observe({ runId, stream: 'assistant', data: { itemId: `cli-assistant:${runId}`, text } });
const finalPayload = (r, runId, text, extra = {}) => r.payload({ kind: 'final', channel: 'discord', runId, usageState: usage, payload: { text, ...extra } }, { accountId: 'default', conversationId: 'channel:1', channelId: 'discord' });
const midPayload = (r, runId, text, over = {}) => r.payload({ kind: 'block', channel: 'discord', runId, usageState: usage, payload: { text }, ...over }, { accountId: 'default', conversationId: 'channel:1', channelId: 'discord' });
const cardOf = (x) => x?.payload?.channelData?.discord?.embeds?.at(-1)?.description?.split('\n');

test('认 Fable：模型标签、入口', () => {
  assert.equal(executionModelLabel('claude-cli/claude-fable-5-2'), 'Fable/Cli');
  assert.equal(executionModelLabel('anthropic/claude-fable-5-2'), 'Fable/api');
  assert.equal(executionModelLabel('claude-cli/claude-opus-5-5'), 'Opus/Cli');
  assert.equal(executionModelLabel('claude-cli/claude-sonnet-5-5'), 'Sonnet/Cli');
  assert.equal(executionModelLabel('claude-cli/claude-unknownfamily-5'), '模型未识别');
  assert.equal(executionModelLabel('nope'), '模型未知');
});

const reading = (extra = {}, fableUsed = 14) => [{ provider: 'claude', usage: {
  updatedAt: '2026-11-10T23:55:00Z',
  primary: { usedPercent: 32, windowMinutes: 300, resetsAt: '2026-11-11T03:00:00Z' },
  secondary: { usedPercent: 58, windowMinutes: 10080, resetsAt: '2026-11-14T15:59:00Z' },
  extraRateWindows: [{ id: 'claude-weekly-scoped-fable', window: { usedPercent: fableUsed, windowMinutes: 10080, resetsAt: '2026-11-14T15:59:00Z', resetDescription: 'x' }, title: 'Fable only' }], ...extra } }];

test('额度读数：Fable 窗口取 extraRateWindows 里 id 含 fable 的那项；缺这一项就是 null', () => {
  const q = selectClaudeCliQuota(reading(), { now: NOW });
  assert.equal(q.status, 'cached'); assert.equal(q.week.remainingPercent, 42); assert.equal(q.fable.remainingPercent, 86); assert.equal(q.fable.windowMinutes, 10080);
  assert.equal(selectClaudeCliQuota(reading({ extraRateWindows: [] }), { now: NOW }).fable, null);
  assert.equal(selectClaudeCliQuota(reading({ extraRateWindows: undefined }), { now: NOW }).fable, null, '旧格式：没有这一项');
  assert.equal(selectClaudeCliQuota(reading({ extraRateWindows: [{ id: 'other', window: { usedPercent: 1, windowMinutes: 10080 } }] }), { now: NOW }).fable, null);
  assert.equal(selectClaudeCliQuota(reading({ extraRateWindows: [{ id: 'claude-weekly-scoped-fable', window: { usedPercent: 14, windowMinutes: 300 } }] }), { now: NOW }).fable, null, '窗口分钟数不对不认');
  assert.equal(selectClaudeCliQuota(reading({ extraRateWindows: [{ id: 'claude-weekly-scoped-fable', window: { usedPercent: 140, windowMinutes: 10080 } }] }), { now: NOW }).fable, null, '百分比超范围不认');
});

function fakeSpawn(outputs) {
  let i = 0;
  return () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.pid = 99999999;
    const out = outputs[Math.min(i, outputs.length - 1)]; i += 1;
    setImmediate(() => { if (out === null) { child.emit('close', 1); return; } child.stdout.emit('data', Buffer.from(JSON.stringify(out))); child.emit('close', 0); });
    return child;
  };
}

test('刷新成功 → Fable 值更新；刷新失败 → Fable 也保留旧值并带“刷新失败，保留旧值”', async () => {
  let now = NOW;
  const source = createCliQuotaSource({ credentialProfilePath: '/x/.claude', spawnProcess: fakeSpawn([reading({}, 14), reading({}, 20), null]), now: () => now, cooldownMs: 0, killProcess: () => {} });
  let v = await source.refresh();
  assert.equal(v.fable.remainingPercent, 86);
  now += 1000; v = await source.refresh();
  assert.equal(v.fable.remainingPercent, 80, '刷新成功 → 更新');
  now += 1000; v = await source.refresh();
  assert.equal(v.refreshFailed, true); assert.equal(v.fable.remainingPercent, 80, '刷新失败 → 保留旧的 Fable 值');
  assert.equal(source.read().fable.remainingPercent, 80);
});

test('旧格式缓存（没有 Fable 那项）→ Fable 显示未知，不报错', async () => {
  const source = createCliQuotaSource({ credentialProfilePath: '/x/.claude', spawnProcess: fakeSpawn([reading({ extraRateWindows: undefined })]), now: () => NOW, cooldownMs: 0, killProcess: () => {} });
  const v = await source.refresh();
  assert.equal(v.status, 'cached'); assert.equal(v.fable, null);
});

test('跨实例传递：发布到共享存储的读数里带着 Fable；旧格式读出来是未知', async () => {
  const stored = new Map();
  const store = { observe: async (k) => ({ value: stored.get(k), comparison: 'c' }), compareAndApply: async (k, _c, op) => { stored.set(k, op.value); return { status: 'applied' }; } };
  const value = selectClaudeCliQuota(reading(), { now: NOW });
  assert.equal(await publishCliQuota(store, 'k', value), true);
  const shared = selectClaudeCliQuota(stored.get('k').rows, { now: NOW });
  assert.equal(shared.status, 'cached'); assert.equal(shared.fable.remainingPercent, 86); assert.equal(shared.week.remainingPercent, 42);
  const noFable = selectClaudeCliQuota(reading({ extraRateWindows: undefined }), { now: NOW });
  const store2 = new Map();
  await publishCliQuota({ observe: async () => ({ value: undefined, comparison: 'c' }), compareAndApply: async (k, _c, op) => { store2.set(k, op.value); return { status: 'applied' }; } }, 'k', noFable);
  assert.equal(selectClaudeCliQuota(store2.get('k').rows, { now: NOW }).fable, null);
  // 新旧比较：同样新的读数不重复发布
  assert.equal(await publishCliQuota(store, 'k', value), true);
});

test('额度行新格式：5h 余 x% · 周限额（总量/fable）：余 y%/余 z%；Fable 缺失写“余 y%/未知”', async () => {
  const cached = (fable) => ({ ...selectClaudeCliQuota(reading(fable === null ? { extraRateWindows: [] } : {}), { now: NOW }), ageSeconds: 300 });
  for (const [quota, expectLine] of [[cached(14), '额度：5h 余 68% · 周限额（总量/fable）：余 42%/余 86%'], [cached(null), '额度：5h 余 68% · 周限额（总量/fable）：余 42%/未知']]) {
    const r = bench({ quota }); start(r, 'run1'); say(r, 'run1', `好了\n${MK([])}`);
    const x = await finalPayload(r, 'run1', `好了\n${MK([])}\n${FOOTER}`);
    const lines = cardOf(x);
    assert.equal(lines[0], 'Sonnet/Cli · high'); assert.equal(lines[1], expectLine);
    assert.match(lines[2], /^（CodexBar 命令行采样 .*距今 5 分钟）$/);
  }
  const stale = { ...selectClaudeCliQuota(reading(), { now: Date.parse('2026-11-20T00:00:00Z') }), refreshFailed: true, ageSeconds: 600 };
  const r = bench({ quota: stale }); start(r, 'run1');
  const x = await finalPayload(r, 'run1', '好了');
  assert.match(cardOf(x)[1], /^额度：5h 已到重置点，待新读数 · 周限额（总量\/fable）：已到重置点，待新读数\/已到重置点，待新读数$/);
  assert.match(cardOf(x)[2], /刷新失败，保留旧值/);
});

test('标记发送前处理①：最终文字带回复指令（宿主已删）、官方页脚在末行 → 页脚搬走、标记去掉、卡里列出修改', async () => {
  const r = bench(); start(r, 'run1');
  say(r, 'run1', `[[reply_to_current]]好了，改了两处\n${MK(['a.md', 'b.md'])}`);
  const x = await finalPayload(r, 'run1', `好了，改了两处\n${MK(['a.md', 'b.md'])}\n${FOOTER}`);
  assert.equal(x.payload.text, '好了，改了两处');
  assert.equal(cardOf(x).at(-1), '修改：a.md、b.md');
  const y = bench(); start(y, 'run2');
  say(y, 'run2', `[[ reply_to: 123456 ]]收到\n${MK([])}`);
  const z = await finalPayload(y, 'run2', `收到\n${MK([])}\n${FOOTER}`);
  assert.equal(z.payload.text, '收到'); assert.equal(cardOf(z).at(-1), '修改：无');
});

test('标记发送前处理②：一轮中途插话造成两份载荷 → 两份都去标记，只有最终那份挂卡，两份的修改并在一起', async () => {
  const r = bench(); start(r, 'run1');
  const mid = await midPayload(r, 'run1', `第一件办好了\n${MK(['a.md'])}`);
  assert.deepEqual(mid, { payload: { text: '第一件办好了' } }, '中途那份：去标记，没有卡');
  say(r, 'run1', `第一件办好了\n${MK(['a.md'])}\n第二件也办好了\n${MK(['b.md'])}`);
  const fin = await finalPayload(r, 'run1', `第二件也办好了\n${MK(['b.md'])}\n${FOOTER}`);
  assert.equal(fin.payload.text, '第二件也办好了');
  assert.equal(cardOf(fin).at(-1), '修改：a.md、b.md');
  assert.equal(fin.payload.channelData.discord.embeds.length, 1);
  assert.deepEqual(r.fragments('run1').map((f) => f.final), [false, true]);
});

test('标记发送前处理③：最后一次回复本身有多段 → 只去掉末行标记，段落原样', async () => {
  const r = bench(); start(r, 'run1');
  const body = '第一段\n\n第二段，含 `代码`\n\n第三段';
  say(r, 'run1', `${body}\n${MK(['c.md'])}`);
  const x = await finalPayload(r, 'run1', `${body}\n${MK(['c.md'])}\n${FOOTER}`);
  assert.equal(x.payload.text, body); assert.equal(cardOf(x).at(-1), '修改：c.md');
});

test('标记发送前处理④：正文过长要被拆条 → 登记补发的尾框用删完标记的整段正文', async () => {
  let armed;
  const r = bench({ record: { trailing: { maxChars: 50, arm: (_id, a) => { armed = a; return true; } } } }); start(r, 'run1');
  const long = Array.from({ length: 30 }, (_, i) => `第${i + 1}行：填充文字`).join('\n');
  const x = await finalPayload(r, 'run1', `${long}\n${MK([])}`);
  assert.equal(armed.body, long); assert.equal(x.payload.text, long); assert.doesNotMatch(armed.body, /oc_changes/);
});

test('标记发送前处理⑤：中途那份发送失败 → 片段表记“failed”，最终附卡照常挂、修改栏照常并；不补发', async () => {
  const r = bench(); start(r, 'run1');
  const mid = await midPayload(r, 'run1', `先办了一件\n${MK(['a.md'])}`);
  const sent = r.sent({ content: mid.payload.text, success: false, messageId: 'm1' }, {});
  assert.equal(sent.sent, 'failed');
  const fin = await finalPayload(r, 'run1', `再办一件\n${MK(['b.md'])}\n${FOOTER}`);
  assert.equal(cardOf(fin).at(-1), '修改：a.md、b.md');
  assert.deepEqual(r.fragments('run1').map((f) => f.sent), ['failed', 'pending']);
  const ok = r.sent({ content: fin.payload.text, success: true, messageId: 'm2' }, {});
  assert.equal(ok.sent, 'sent'); assert.equal(ok.messageId, 'm2');
  assert.equal(r.sent({ content: '没登记过的话', success: true }, {}), undefined);
});

test('标记发送前处理⑥：两轮运行出现相同正文，各归各的轮，不串', async () => {
  const r = bench(); start(r, 'runA'); start(r, 'runB');
  const text = `同样的话\n${MK(['a.md'])}`;
  const a = await midPayload(r, 'runA', text);
  const b = await midPayload(r, 'runB', `同样的话\n${MK(['b.md'])}`);
  assert.equal(a.payload.text, '同样的话'); assert.equal(b.payload.text, '同样的话');
  const fa = await finalPayload(r, 'runA', `结尾A\n${MK([])}\n${FOOTER}`);
  const fb = await finalPayload(r, 'runB', `结尾B\n${MK([])}\n${FOOTER}`);
  assert.equal(cardOf(fa).at(-1), '修改：a.md'); assert.equal(cardOf(fb).at(-1), '修改：b.md');
  // 发送结果按正文配对时同样各归各的轮（带 runId 的事件只配这一轮）
  assert.equal(r.sent({ content: '同样的话', success: true, runId: 'runB' }, {}).sent, 'sent');
  assert.equal(r.fragments('runA')[0].sent, 'pending'); assert.equal(r.fragments('runB')[0].sent, 'sent');
});

test('保守：没有 runId、不是 Claude 命令行、标记在代码区域里、标记不在末行、识别函数没加载 → 一律不删', async () => {
  const r = bench(); start(r, 'run1');
  assert.equal(await r.payload({ kind: 'final', channel: 'discord', payload: { text: `好\n${MK(['a.md'])}` }, usageState: usage }, {}), undefined, '没有 runId');
  // API 路径（anthropic、anthropic-api）改为照样清，只有不认识的提供商（如 openai）才保守不动
  assert.equal(await midPayload(r, 'run1', `好\n${MK(['a.md'])}`, { usageState: { resolvedRef: 'openai/gpt-6.1-sol' } }), undefined, '中途那份：不是 Claude 命令行、也不是 API 路径');
  const api = await r.payload({ kind: 'final', channel: 'discord', runId: 'run1', usageState: { resolvedRef: 'openai/gpt-6.1-sol', reasoningEffort: 'high' }, payload: { text: `好\n${MK(['a.md'])}` } }, { accountId: 'default', conversationId: 'channel:1', channelId: 'discord' });
  assert.equal(api.payload.text, `好\n${MK(['a.md'])}`, '最终那份：不认识的提供商，不删');
  assert.equal(cardOf(api).at(-1), '修改：未列');
  assert.equal(await midPayload(r, 'run1', `示例：\n\`\`\`\n${MK(['a.md'])}`), undefined, '代码区域里');
  assert.equal(await midPayload(r, 'run1', `${MK(['a.md'])}\n后面还有话`), undefined, '不在末行');
  const noFn = bench({ record: { findCodeRegions: null } }); start(noFn, 'run9');
  assert.equal(await midPayload(noFn, 'run9', `好\n${MK(['a.md'])}`), undefined, '识别函数没加载');
  assert.equal(parseChangeMarker(`好\n${MK(['a.md'])}`, null).status, 'none');
});

test('中途那份只剩标记 → 取消这一条（不发空消息）；带附件的不取消', async () => {
  const r = bench(); start(r, 'run1');
  assert.deepEqual(await midPayload(r, 'run1', MK([])), { cancel: true, reason: 'execution-record: change-list marker only' });
  const x = await r.payload({ kind: 'block', channel: 'discord', runId: 'run1', usageState: usage, payload: { text: MK([]), mediaUrl: '/tmp/x.png' } }, {});
  assert.deepEqual(x, { payload: { text: '', mediaUrl: '/tmp/x.png' } });
});

test('标记内容不合格式 → 也去掉，卡写“未列”，不报漏列', async () => {
  const r = bench(); start(r, 'run1');
  const mid = await midPayload(r, 'run1', '先说一句\n[[oc_changes {"files":["a.md",]}]]');
  assert.equal(mid.payload.text, '先说一句');
  const fin = await finalPayload(r, 'run1', `再说一句\n${MK(['b.md'])}\n${FOOTER}`);
  assert.match(cardOf(fin).at(-1), /^修改：未列/);
});

// ======================================================================
// 附卡标记容错——标记后面只许跟最多 2 行型号样式的行（或官方页脚），其余仍不认。
// ======================================================================
test('D7-① 标记＋一行型号行（bot 自己多写的）→ 标记和型号行一起删，卡列出修改', async () => {
  const r = bench(); start(r, 'run1');
  say(r, 'run1', `好了，改了一处\n${MK(['a.md'])}\nOpus/Cli · medium`);
  const x = await finalPayload(r, 'run1', `好了，改了一处\n${MK(['a.md'])}\nOpus/Cli · medium`);
  assert.equal(x.payload.text, '好了，改了一处');
  assert.equal(cardOf(x).at(-1), '修改：a.md');
  const y = bench(); start(y, 'run2');
  say(y, 'run2', `没改东西\n${MK([])}\nSonnet/Cli · high`);
  const z = await finalPayload(y, 'run2', `没改东西\n${MK([])}\nSonnet/Cli · high`);
  assert.equal(z.payload.text, '没改东西'); assert.equal(cardOf(z).at(-1), '修改：无');
});

test('D7-② 标记＋型号行＋官方页脚 → 页脚搬走、标记和型号行删净', async () => {
  const r = bench(); start(r, 'run1');
  say(r, 'run1', `好了\n${MK(['b.md'])}\n${FOOTER}`);
  const x = await finalPayload(r, 'run1', `好了\n${MK(['b.md'])}\n${FOOTER}\n${FOOTER}`);
  assert.equal(x.payload.text, '好了');
  assert.equal(cardOf(x).at(-1), '修改：b.md');
});

test('D7-③ 标记后面是普通文字 → 仍不认、不删、卡写未列', async () => {
  for (const tail of ['我已经改好了', '好的。', 'Sonnet/Cli · high 我改好了']) {
    const r = bench(); start(r, 'run1');
    say(r, 'run1', `好了\n${MK(['a.md'])}\n${tail}`);
    const x = await finalPayload(r, 'run1', `好了\n${MK(['a.md'])}\n${tail}`);
    assert.ok(x.payload.text.includes(MK(['a.md'])), `${tail}：标记留着`);
    assert.match(cardOf(x).at(-1), /^修改：未列/);
  }
  assert.equal(parseChangeMarker(`好\n${MK(['a.md'])}\n后面还有话`, findCodeRegions).status, 'none');
});

test('D7-④ 标记在最后一行（规矩写法）→ 与改前相同，并带 markerStart／trailingModelLines', async () => {
  const text = `好了\n${MK(['a.md'])}`;
  const p = parseChangeMarker(text, findCodeRegions);
  assert.equal(p.status, 'valid'); assert.deepEqual(p.files, ['a.md']);
  assert.equal(p.trailingModelLines, 0); assert.equal(p.markerStart, '好了\n'.length);
  const r = bench(); start(r, 'run1'); say(r, 'run1', text);
  const x = await finalPayload(r, 'run1', `${text}\n${FOOTER}`);
  assert.equal(x.payload.text, '好了'); assert.equal(cardOf(x).at(-1), '修改：a.md');
  assert.equal(parseChangeMarker(`好\n${MK([])}\nOpus/Cli · medium`, findCodeRegions).trailingModelLines, 1);
});

test('D7-⑤ 标记后面跟 3 行型号行 → 不认（上限 2 行）；2 行认', () => {
  const m = MK(['a.md']);
  assert.equal(parseChangeMarker(`好\n${m}\nOpus/Cli · medium\nOpus/Cli · medium\nOpus/Cli · medium`, findCodeRegions).status, 'none');
  const two = parseChangeMarker(`好\n${m}\nOpus/Cli · medium\nSonnet/Cli · high`, findCodeRegions);
  assert.equal(two.status, 'valid'); assert.equal(two.trailingModelLines, 2);
});

test('D7-⑥ 型号样式但不在白名单（GPT/Cli · high、Opus/Web · high、大写档位）→ 不认', () => {
  for (const line of ['GPT/Cli · high', 'Opus/Web · high', 'Opus/Cli · High', 'Opus/Cli · high1', 'Opus/Cli · 高']) {
    assert.equal(parseChangeMarker(`好\n${MK([])}\n${line}`, findCodeRegions).status, 'none', line);
  }
});

test('D7-⑦ 标记在代码块里、后面跟型号行 → 仍按代码区域不认', async () => {
  const text = `示例：\n\`\`\`\n${MK(['a.md'])}\nOpus/Cli · medium`;
  assert.equal(parseChangeMarker(text, findCodeRegions).status, 'none');
  const r = bench(); start(r, 'run1');
  assert.equal(await midPayload(r, 'run1', text), undefined);
});

test('D7-⑧ 中途载荷：标记＋型号行同样能删；只剩标记＋型号行 → 取消这一条', async () => {
  const r = bench(); start(r, 'run1');
  const mid = await midPayload(r, 'run1', `第一件办好了\n${MK(['a.md'])}\nOpus/Cli · medium`);
  assert.equal(mid.payload.text, '第一件办好了');
  assert.deepEqual(await midPayload(r, 'run1', `${MK([])}\nOpus/Cli · medium`), { cancel: true, reason: 'execution-record: change-list marker only' });
  const fin = await finalPayload(r, 'run1', `全部办好\n${MK(['b.md'])}\n${FOOTER}`);
  assert.equal(cardOf(fin).at(-1), '修改：a.md、b.md');
});

test('D7-⑨ 型号前缀紧跟中文正文不删：Sonnet/Cli · high我已经改好了文件、Opus/api · 已完成，请查看', async () => {
  for (const tail of ['Sonnet/Cli · high我已经改好了文件', 'Opus/api · 已完成，请查看']) {
    assert.equal(parseChangeMarker(`好\n${MK(['a.md'])}\n${tail}`, findCodeRegions).status, 'none', tail);
    const r = bench(); start(r, 'run1');
    assert.equal(await midPayload(r, 'run1', `好\n${MK(['a.md'])}\n${tail}`), undefined);
  }
});

test('D7-⑩ 标记、空行、型号行 → 整段删净，标记不留（按位置截，不按行数删）', async () => {
  const r = bench(); start(r, 'run1');
  const mid = await midPayload(r, 'run1', `正文\n${MK(['a.md'])}\n\nSonnet/Cli · high`);
  assert.equal(mid.payload.text, '正文');
  const p = parseChangeMarker(`正文\n${MK([])}\n\n\nOpus/Cli · medium\n\nSonnet/Cli · high\n\n`, findCodeRegions);
  assert.equal(p.status, 'valid'); assert.equal(p.trailingModelLines, 2); assert.equal(p.markerStart, '正文\n'.length);
});

test('D7-⑪ 没拿到用量状态的最终载荷（标记＋型号行）→ 原样不动、卡写未列（锁住 claude-cli 条件，本批不放宽）', async () => {
  const r = bench(); start(r, 'run1');
  say(r, 'run1', `好了\n${MK(['a.md'])}\nOpus/Cli · medium`);
  const x = await r.payload({ kind: 'final', channel: 'discord', runId: 'run1', payload: { text: `好了\n${MK(['a.md'])}\nOpus/Cli · medium` } }, { accountId: 'default', conversationId: 'channel:1', channelId: 'discord' });
  assert.ok(x.payload.text.includes(MK(['a.md'])) && x.payload.text.includes('Opus/Cli · medium'));
  assert.match(cardOf(x).at(-1), /^修改：未列/);
});

test('D7-⑫ parseChangeMarker 的 footerText：整行等于官方页脚的行也算型号行；回复换行是 \\r\\n 时不误吞', () => {
  assert.equal(parseChangeMarker(`好\n${MK([])}\n奇怪的页脚 x`, findCodeRegions).status, 'none');
  assert.equal(parseChangeMarker(`好\n${MK([])}\n奇怪的页脚 x`, findCodeRegions, '奇怪的页脚 x').status, 'valid');
  assert.equal(parseChangeMarker(`好\r\n${MK([])}\r\nOpus/Cli · medium\r\n`, findCodeRegions).status, 'valid');
});
