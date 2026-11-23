// Safety net for the pending-decision ledger: notices owner-only button requests that were never registered and registers them afterwards.
// “等你定”登记的程序兜底。
// 背景：丙档请示要 bot 自己调 pending_decision_register 登记（共用规则第 46 行）；bot 不调就没有台账，主人的请示会漏进“没人记得”。
// 做法分两段，台账都只经 withLedger 写：
//   ① 插件里（after_tool_call）：bot 用 message 工具发出“带按钮、按钮只许主人点”的消息时，往 资料/运行记录/请示待核/<日期>.jsonl 追加一行流水。
//      只记原始事实（消息编号、频道编号、哪个 bot、正文第一行），不判断是不是线程、不碰台账、不调命令行（插件在 Gateway 进程里，同步调命令会堵住它）。
//   ② “等你定”脚本（pending-decisions.mjs，每 30 分钟，独立进程）：reconcileRequests 扫今天和昨天的流水，发出超过 10 分钟、台账里还没有同一条请示的，
//      先调 channel info 弄清是线程还是频道主区域、父频道是谁（闲聊茶会和审批频道一律排除），再补登记一行（标题前加“（程序补登记）”，autoRegistered: true）。
// “已核”记在另一个文件（已核.json）里，不去改插件正在追加的流水文件，免得并发丢行。
// Later revision:
//   ③ 插件里再加一个“收到消息”观察钩子（message_received）：只记“主人在哪个线程／频道有过回应”（回应-<日期>.jsonl，不记正文），
//      因为他点按钮不会在线程里留下消息，光读线程看不到；核账先查这份记录，命中就不补登记、也省掉一次慢命令。钩子只观察，永远返回 undefined，出错吞掉。
//   ④ 核账：命令单次上限 60 秒、整轮预算 90 秒；“线程还是频道”的结果落盘缓存（频道信息.json），几轮之后进度累积；慢命令记日志。
import { localDate } from './tz.mjs';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { withLedger, registerItem, OWNER_ID, WORKSHOP_CHANNEL } from './pending-ledger.mjs';
import { APPROVAL_CHANNEL_ID } from './approval-card.mjs';

import { crew } from './crew-config.mjs';
import { lexicon, escapeRe } from './lexicon.mjs';
const W = lexicon(); // words follow config "locale"
export const CHAT_CHANNEL = crew.channels.lounge; // 闲聊茶会：不参与任务卡和台账
export const GUILD_ID = crew.guildId;
export const SKIP_AGENTS = new Set(['system-auditor', 'task-auditor']); // 审计角色
export const GRACE_MS = 10 * 60 * 1000; // 发出后等 10 分钟，让 bot 自己先登记
export const GIVE_UP_MS = 2 * 24 * 3600 * 1000; // 两天还核不清的不再试
export const RECONCILE_BUDGET_MS = 90 * 1000; // 核账单轮总预算：到了就停，剩下的留给下一遍。原来 25 秒，机器忙时一条 openclaw 命令就要 20 秒以上，一条也跑不完（补登记修改·②）；90 秒配合 pending-decisions.mjs 的整轮总时限 180 秒，保证后面的 runTick 至少还有 90 秒
export const CALL_TIMEOUT_MS = 60 * 1000; // 核账里每条命令（channel info、message read）单次上限
export const SLOW_CALL_LOG_MS = 5 * 1000; // 命令超过这么久就记一行日志（看实际有多慢）
export const INFO_KEEP_MS = 30 * 24 * 3600 * 1000; // 频道信息缓存里 30 天没用到的键清掉
export const DONE_KEEP_MS = 3 * 24 * 3600 * 1000; // 已核记录只留 3 天（读流水只扫今天和昨天）
export const AUTO_PREFIX = W.autoRegisterPrefix;
const dayOf = (ms) => localDate(ms);
export const requestDir = (dataRoot) => join(dataRoot, '运行记录', '请示待核');

// ---------- ① 从工具调用里认出“带按钮、只许主人点”的请示 ----------
const normTool = (name) => String(name ?? '').replace(/^mcp__openclaw__/, '');
// 在参数里找所有 allowedUsers 数组（按钮的写法在不同载荷里位置不同，所以不押死某个字段名；施工时用真实样本核对）
export function findAllowedUsers(node, depth = 0, out = []) {
  if (!node || typeof node !== 'object' || depth > 8) return out;
  if (Array.isArray(node)) { node.forEach((x) => findAllowedUsers(x, depth + 1, out)); return out; }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'allowedUsers' && Array.isArray(v)) out.push(v.map(String));
    else findAllowedUsers(v, depth + 1, out);
  }
  return out;
}
export function unwrapResult(result) {
  let r = result;
  if (r && typeof r === 'object' && r.details && typeof r.details === 'object') r = r.details;
  if (r && typeof r === 'object' && Array.isArray(r.content) && typeof r.content[0]?.text === 'string') { try { r = JSON.parse(r.content[0].text); } catch { /* 不是 JSON */ } }
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { /* 不是 JSON */ } }
  return r;
}
const findKey = (node, keys, depth = 0) => {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  for (const k of keys) if (node[k] != null && (typeof node[k] === 'string' || typeof node[k] === 'number')) return String(node[k]);
  for (const v of Object.values(node)) { const f = findKey(v, keys, depth + 1); if (f) return f; }
  return null;
};
const idOfTarget = (t) => (/(\d{5,})$/.exec(String(t ?? '')) ?? [])[1] ?? null;
const textHead = (params) => {
  const raw = params?.message ?? params?.content ?? params?.presentation?.text ?? findKey(params?.presentation, ['text', 'title']) ?? '';
  return String(raw).split('\n').map((x) => x.trim()).find(Boolean)?.slice(0, 200) ?? '';
};
// 返回 null（不是要记的）或一行流水
export function extractRequest(event, ctx = {}) {
  if (normTool(event?.toolName) !== 'message' || event?.error) return null;
  const agentId = ctx?.agentId ?? (/^agent:([^:]+):/.exec(String(ctx?.sessionKey ?? ''))?.[1] ?? null);
  if (SKIP_AGENTS.has(agentId)) return null;
  const p = event?.params;
  if (!p || typeof p !== 'object') return null;
  const lists = findAllowedUsers(p);
  if (!lists.some((l) => l.includes(OWNER_ID))) return null; // 没有按钮，或按钮不是给主人的
  const res = unwrapResult(event?.result);
  const messageId = findKey(res, ['messageId', 'message_id']) ?? (res?.message?.id != null ? String(res.message.id) : null);
  const channelId = findKey(res, ['channelId', 'channel_id']) ?? idOfTarget(p.target ?? p.to ?? p.channelId ?? p.channel) ?? idOfTarget(res?.to) ?? (res?.result?.target?.id != null ? String(res.result.target.id) : null); // 回执深处的 raw.channelId 没有时，退回参数里的 target、回执顶层的 to、result.target.id
  const text = textHead(p);
  return { messageId: messageId ?? null, channelId: channelId ?? null, agentId, text, isTest: new RegExp(`^${escapeRe(W.testMarker)}`).test(text), sentAt: null };
}

// ---------- ③ “收到消息”观察钩子：记主人的回应（含按钮点击）----------
// 官方说按钮点击“当作一条普通入站消息送回 agent”，但线程里不会留下主人的消息，所以读线程看不见。
// 钩子的事件形状没见过真实样本（点击是否触发、字段在 event／event.metadata／ctx 哪一处），所以：编号类字段三处都查；先开“回应抓形状.flag”采形状，再定案。
const SOURCES = (event, ctx) => [event, event?.metadata, event?.message, ctx].filter((x) => x && typeof x === 'object');
const idFrom = (v) => { // 编号可能是数字、字符串、“discord:123”或 { id }
  if (v == null) return null;
  if (typeof v === 'object') return idFrom(v.id ?? v.userId ?? null);
  const m = /(\d+)\s*$/.exec(String(v)); // 纯数字或“前缀:数字”；真实 Discord 编号都是 18～19 位，测试里用短编号也认
  return m ? m[1] : null;
};
export function pickId(event, ctx, keys) {
  for (const s of SOURCES(event, ctx)) for (const k of keys) { const id = idFrom(s[k]); if (id) return id; }
  return null;
}
const SENDER_KEYS = ['senderId', 'authorId', 'userId', 'fromId', 'from'];
const CHANNEL_KEYS = ['channelId', 'conversationId', 'chatId'];
const THREAD_KEYS = ['threadId', 'messageThreadId'];
const MESSAGE_KEYS = ['messageId', 'id'];
const REPLY_KEYS = ['replyToId', 'replyToIdFull'];
const CLICK_KEY_RE = /interaction|component|button|custom_?id/i;
const CLICK_VAL_RE = /interaction|component|button|click/i;
const CLICK_TEXT_RE = /^\s*(clicked|click|button|selected|点击|点了|选择了?)/i;
// 认不认得出是按钮点击：看键名、type／kind／source／origin 这类字段的值、正文开头。认不出就返回 false（核账那边的主区域匹配只认 click，认不出＝回到现在的“多补一行”，不会更糟）
export function isClickEvent(event, ctx) {
  for (const s of SOURCES(event, ctx)) {
    for (const [k, v] of Object.entries(s)) {
      if (CLICK_KEY_RE.test(k)) return true;
      if (['type', 'kind', 'source', 'origin', 'provider', 'eventType'].includes(k) && typeof v === 'string' && CLICK_VAL_RE.test(v)) return true;
    }
  }
  return CLICK_TEXT_RE.test(String(event?.content ?? event?.text ?? ''));
}
// 一条入站事件 → 要记的一行（不是主人发的、或认不出任何频道／线程编号就返回 null）。不含正文。
export function responseRowFrom(event, ctx, atMs) {
  const sender = pickId(event, ctx, SENDER_KEYS);
  if (sender !== OWNER_ID) return null;
  const channelId = pickId(event, ctx, CHANNEL_KEYS);
  const threadId = pickId(event, ctx, THREAD_KEYS);
  if (!channelId && !threadId) return null;
  return { at: atMs, channelId: channelId ?? null, threadId: threadId ?? null, messageId: pickId(event, ctx, MESSAGE_KEYS), replyToId: pickId(event, ctx, REPLY_KEYS), kind: isClickEvent(event, ctx) ? 'click' : 'message' };
}
const keyNames = (o) => (o && typeof o === 'object' ? Object.keys(o).slice(0, 40) : null);
const SHAPE_FILE_MAX = 200 * 1024;

export function createRequestWatch({ dataRoot, now = () => Date.now(), log = () => {} } = {}) {
  const dir = dataRoot ? requestDir(dataRoot) : null;
  const diagFlag = dir ? join(dir, '抓形状.flag') : null;
  const seen = new Set(); // 同一条入站消息 14 个账号可能各收一遍：本进程内按消息编号去重
  const flagText = (name) => { try { return readFileSync(join(dir, name), 'utf8').trim(); } catch { return null; } };
  return {
    // “收到消息”观察钩子：只观察、永远返回 undefined、出错吞掉；不碰台账、不存正文。
    // 开关：回应记录.flag 写“关”＝不记回应（默认不存在＝记）；回应抓形状.flag 写“开”＝记形状样本（默认不记，抓完改“关”）。
    received(event, ctx) {
      try {
        if (!dir) return undefined;
        const t = now();
        const sender = pickId(event, ctx, SENDER_KEYS);
        if (flagText('回应抓形状.flag') === '开') this.shapeSample(event, ctx, t, sender);
        if (sender !== OWNER_ID) return undefined;
        if (flagText('回应记录.flag') === '关') return undefined;
        const row = responseRowFrom(event, ctx, t);
        if (!row) return undefined;
        const key = row.messageId ?? `${row.channelId}|${row.threadId}|${t}`;
        if (seen.has(key)) return undefined;
        if (seen.size > 1000) seen.clear();
        seen.add(key);
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, `回应-${dayOf(t)}.jsonl`), `${JSON.stringify(row)}\n`);
      } catch (e) { try { log({ event: 'request-watch-received-error', error: String(e?.message ?? e).slice(0, 200) }); } catch { /* 只是记录 */ } }
      return undefined;
    },
    // 形状样本（在过滤发送者之前采）：只记键名、编号有没有、是不是主人发的、正文长度、对点击的判断；绝不记别人的正文。
    // 只有“发送者是主人并且所在线程／频道编号写在 回应抓形状.线程.txt 里（一行一个，给测试线程用）”才多记正文前 20 个字。
    shapeSample(event, ctx, t, sender) {
      try {
        const file = join(dir, '回应形状样本.jsonl');
        try { if (statSync(file).size > SHAPE_FILE_MAX) return; } catch { /* 还没有 */ }
        const channelId = pickId(event, ctx, CHANNEL_KEYS); const threadId = pickId(event, ctx, THREAD_KEYS);
        const content = String(event?.content ?? event?.text ?? '');
        const row = {
          at: t,
          keys: { event: keyNames(event), metadata: keyNames(event?.metadata), ctx: keyNames(ctx) },
          has: { senderId: !!sender, channelId: !!channelId, threadId: !!threadId, messageId: !!pickId(event, ctx, MESSAGE_KEYS), replyToId: !!pickId(event, ctx, REPLY_KEYS) },
          senderIsOwner: sender === OWNER_ID, contentLen: content.length, kindGuess: isClickEvent(event, ctx) ? 'click' : 'message',
        };
        if (row.senderIsOwner) {
          const listed = new Set((flagText('回应抓形状.线程.txt') ?? '').split(/\s+/).filter(Boolean));
          if ((threadId && listed.has(threadId)) || (channelId && listed.has(channelId))) row.contentHead = content.slice(0, 20);
        }
        mkdirSync(dir, { recursive: true });
        appendFileSync(file, `${JSON.stringify(row).slice(0, 3000)}\n`);
      } catch { /* 只是诊断 */ }
    },
    // 抓形状开关：dir/抓形状.flag 存在、而且里面写的是“开”时，把 message 工具调用的原始形状（截断）记一份样本。文件不存在或内容不是“开”，什么也不记（抓完把内容改成“关”即可，不用删文件）。
    maybeDiag(phase, event, ctx = null) {
      try {
        if (!diagFlag || !existsSync(diagFlag) || normTool(event?.toolName) !== 'message') return;
        if (readFileSync(diagFlag, 'utf8').trim() !== '开') return; // 旗标文件里写“开”才记；抓完把内容改成“关”就停，不用删文件
        appendFileSync(join(dir, '原始事件样本.jsonl'), `${JSON.stringify({ phase, at: now(), agentId: ctx?.agentId ?? null, sessionKeyTail: String(ctx?.sessionKey ?? '').slice(-40) || null, toolName: event?.toolName, params: event?.params, result: event?.result, error: event?.error ? String(event.error).slice(0, 200) : null }).slice(0, 6000)}\n`);
      } catch { /* 只是诊断 */ }
    },
    afterTool(event, ctx) {
      try {
        this.maybeDiag('after_tool_call', event, ctx);
        if (!dir) return null;
        const row = extractRequest(event, ctx);
        if (!row) return null;
        row.sentAt = now();
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, `${dayOf(row.sentAt)}.jsonl`), `${JSON.stringify(row)}\n`);
        log({ event: 'request-noted', messageId: row.messageId, agentId: row.agentId, channelId: row.channelId });
        return row;
      } catch (e) { try { log({ event: 'request-watch-error', error: String(e?.message ?? e).slice(0, 200) }); } catch { /* 只是记录 */ } return null; }
    },
    beforeTool(event, ctx) { this.maybeDiag('before_tool_call', event, ctx); return undefined; },
  };
}
export function registerRequestWatch(api, watch) {
  if (!watch) return;
  api.on('before_tool_call', (event, ctx) => watch.beforeTool(event, ctx), { registrationId: 'request-watch-before' });
  api.on('after_tool_call', (event, ctx) => { watch.afterTool(event, ctx); return undefined; }, { registrationId: 'request-watch-after' });
  if (typeof watch.received === 'function') api.on('message_received', (event, ctx) => { watch.received(event, ctx); return undefined; }, { registrationId: 'request-watch-received' });
}

// ---------- ② 核账补登记（给 pending-decisions.mjs 调） ----------
const jread = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fb; } };
function jwrite(p, obj) { mkdirSync(join(p, '..'), { recursive: true }); const t = `${p}.tmp-${process.pid}`; writeFileSync(t, JSON.stringify(obj, null, 1), { mode: 0o600 }); renameSync(t, p); }
export function readRequestRows(dataRoot, nowMs) {
  const rows = [];
  for (const d of new Set([dayOf(nowMs), dayOf(nowMs - 86400000)])) {
    let text = '';
    try { text = readFileSync(join(requestDir(dataRoot), `${d}.jsonl`), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch { /* 坏行跳过 */ } }
  }
  return rows;
}
const excluded = (id) => [CHAT_CHANNEL, APPROVAL_CHANNEL_ID].includes(String(id));
const isThreadType = (type) => [10, 11, 12].includes(Number(type));
// 频道信息缓存只收合法完整的：type 是数字；线程类型的必须有父频道。报错、拿不到父频道的一律不落盘。
const validInfo = (info) => Number.isFinite(Number(info?.type)) && info?.type !== null && info?.type !== '' && (!isThreadType(info.type) || !!info.parentId);

// ③ 的读取端：今天和昨天的 回应-<日期>.jsonl（只有主人发的、不含正文）
export function readResponseRows(dataRoot, nowMs) {
  const rows = [];
  for (const d of new Set([dayOf(nowMs), dayOf(nowMs - 86400000)])) {
    let text = '';
    try { text = readFileSync(join(requestDir(dataRoot), `回应-${d}.jsonl`), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch { /* 坏行跳过 */ } }
  }
  return rows;
}
// 一条请示有没有“主人已经回应”的记录。口径：
//  · 请示在线程里：只认同一个线程里、时间不早于请示的记录（和 readReplies 的“线程里他说过话就算”一样）；
//  · 请示在频道主区域：只认同一频道主区域（不含子线程）、时间不早于请示、并且是按钮点击或回复了这条请示的记录；同频道别的聊天不算。
export function matchResponse(rows, { threadId, requestChannelId, requestMessageId, sentAt }) {
  const since = Number(sentAt ?? 0);
  return (rows ?? []).some((e) => {
    if (!(Number(e?.at) >= since)) return false;
    if (threadId) return String(e.threadId ?? e.channelId ?? '') === String(threadId);
    const inMain = String(e.channelId ?? '') === String(requestChannelId) && (!e.threadId || String(e.threadId) === String(requestChannelId));
    return inMain && (e.kind === 'click' || (e.replyToId != null && String(e.replyToId) === String(requestMessageId)));
  });
}

// discord.channelInfo(id, 本轮还剩的毫秒) → { type, parentId } ；读不到抛错
export async function reconcileRequests({ dataRoot, ledgerPath, discord, now = () => Date.now(), watchDir = null, log = () => {}, budgetMs = RECONCILE_BUDGET_MS }) {
  const t = now();
  const t0 = now();
  const infoCache = new Map(); // 同一个频道当轮只查一次；失败了当轮不重查
  const infoPath = join(requestDir(dataRoot), '频道信息.json'); // 落盘缓存：频道类型和父频道不会变，几轮之后进度累积（补登记修改·②-2）
  const infoStore = jread(infoPath, { channels: {} }); if (!infoStore.channels || typeof infoStore.channels !== 'object') infoStore.channels = {};
  let infoDirty = false;
  for (const [k, v] of Object.entries(infoStore.channels)) if (!validInfo(v) || (v?.at ?? 0) < t - INFO_KEEP_MS) { delete infoStore.channels[k]; infoDirty = true; }
  let responses = null; // 回应记录：用到时才读一次
  const timed = async (what, id, fn) => { // 记慢命令：超过 5 秒、或失败，记一行（带毫秒数）
    const s = now();
    try { const r = await fn(); const ms = now() - s; if (ms >= SLOW_CALL_LOG_MS) log({ event: 'request-call-slow', what, messageId: id, ms }); return r; }
    catch (e) { log({ event: 'request-call-failed-timing', what, messageId: id, ms: now() - s }); throw e; }
  };
  let dirty = false;
  const donePath = join(requestDir(dataRoot), '已核.json');
  const done = jread(donePath, { rows: {} });
  const mark = (id, result) => { done.rows[id] = { at: t, result }; dirty = true; };
  for (const [k, v] of Object.entries(done.rows)) if ((v?.at ?? 0) < t - DONE_KEEP_MS) { delete done.rows[k]; dirty = true; }
  const out = { registered: 0, skipped: 0, waiting: 0, details: [] };
  for (const r of readRequestRows(dataRoot, t)) {
    const id = r.messageId ? String(r.messageId) : null;
    if (!id) { out.skipped++; continue; }
    if (done.rows[id]) continue;
    const age = t - (r.sentAt ?? t);
    if (age < GRACE_MS) { out.waiting++; continue; }
    if (age > GIVE_UP_MS) { mark(id, '太久没核清，不再试'); out.skipped++; continue; }
    if (!r.channelId) { mark(id, '流水里没有频道编号，不补'); out.skipped++; continue; }
    if (excluded(r.channelId)) { mark(id, '闲聊茶会或审批频道，不补'); out.skipped++; continue; }
    const ch = String(r.channelId);
    let cached = infoCache.get(ch);
    if (!cached && infoStore.channels[ch]) { cached = { info: { type: infoStore.channels[ch].type, parentId: infoStore.channels[ch].parentId ?? null } }; infoCache.set(ch, cached); infoStore.channels[ch].at = t; } // 落盘缓存命中：不再起命令（at 只在内存里刷新，不为这个单独写盘）
    if (!cached) {
      if (now() - t0 >= budgetMs) { out.budgetStopped = true; break; } // 到预算就停，没处理的留给下一遍（不记已核）
      try { cached = { info: await timed('channelInfo', id, () => discord.channelInfo(ch, Math.max(1000, budgetMs - (now() - t0)))) }; } // 第二个参数：本轮还剩多少毫秒预算；实际命令超时由调用方取它和 60 秒里小的（pending-decisions.mjs）
       catch (e) { cached = { err: String(e?.message ?? e).slice(0, 120) }; log({ event: 'request-channel-info-failed', messageId: id, error: cached.err }); }
      infoCache.set(ch, cached);
      if (cached.info && validInfo(cached.info)) { infoStore.channels[ch] = { type: Number(cached.info.type), parentId: cached.info.parentId ? String(cached.info.parentId) : null, at: t }; infoDirty = true; }
    }
    if (cached.err) { out.waiting++; continue; }
    const info = cached.info;
    const isThread = [10, 11, 12].includes(Number(info?.type));
    const parent = isThread ? (info?.parentId ? String(info.parentId) : null) : String(r.channelId);
    if (isThread && !parent) { out.waiting++; continue; } // 线程但父频道读不出来：不猜，下一遍再试
    if (excluded(parent)) { mark(id, '闲聊茶会或审批频道下的线程，不补'); out.skipped++; continue; }
    const requestChannelId = parent;
    const threadId = isThread ? String(r.channelId) : null;
    // 先查“回应记录”（插件的 message_received 钩子记的，含按钮点击；点按钮在线程里不留消息，读线程看不到）：命中就不补、记已核，还省掉下面一次慢命令。
    responses ??= readResponseRows(dataRoot, t);
    if (matchResponse(responses, { threadId, requestChannelId, requestMessageId: id, sentAt: r.sentAt ?? t })) { mark(id, '回应记录里有他的回应（按钮或消息），不补'); out.skipped++; out.byResponseLog = (out.byResponseLog ?? 0) + 1; continue; }
    // B 组：补登记前先看他是不是已经回应了——用和 runTick 认回应一样的口径：线程里他在原请示之后说过话，或频道里他回复了这条请示。
    // 回应已经有了，这件事不用再进“等你定”（再点名他只会打扰）。读不到就这一遍不补，下一遍再试。
    if (typeof discord.readReplies === 'function') {
      if (now() - t0 >= budgetMs) { out.budgetStopped = true; break; }
      let msgs;
      try { msgs = await timed('readReplies', id, () => discord.readReplies({ threadId, requestChannelId, requestMessageId: id }, Math.min(CALL_TIMEOUT_MS, Math.max(1000, budgetMs - (now() - t0))))); } // 第二个参数：本轮还剩的预算，命令超时取它和 60 秒里小的
      catch (e) { out.waiting++; log({ event: 'request-read-replies-failed', messageId: id, error: String(e?.message ?? e).slice(0, 120) }); continue; }
      const answered = (msgs ?? []).some((m) => String(m.authorId) === OWNER_ID && ((m.replyToId && String(m.replyToId) === id) || (threadId && String(m.channelId) === threadId)));
      if (answered) { mark(id, '他已经在原请示之后回应了，不补'); out.skipped++; continue; }
    }
    const link = `https://discord.com/channels/${GUILD_ID}/${r.channelId}/${id}`;
    const res = await withLedger(ledgerPath, (L) => {
      const reg = registerItem(L, {
        title: `${AUTO_PREFIX}${String(r.text || W.autoRegisterTexts.title).slice(0, 180)}`,
        suggestion: W.autoRegisterTexts.suggestion,
        blocks: W.autoRegisterTexts.blocks,
        deadline: W.noDeadline, requestMessageId: id, requestChannelId, requestLink: link, threadId, botId: r.agentId ?? null, isTest: !!r.isTest, autoRegistered: true,
      }, t);
      if (reg.error) return { noWrite: true, error: reg.error };
      if (reg.existing) return { noWrite: true, existing: true };
      return { id: reg.item.id };
    }, { now, watchDir });
    if (res.busy) { out.waiting++; continue; }
    if (res.error) { out.skipped++; log({ event: 'request-register-error', messageId: id, error: res.error }); continue; }
    if (res.existing) { mark(id, 'bot 自己已经登记'); out.skipped++; continue; }
    mark(id, `程序补登记 ${res.id}`); out.registered++; out.details.push({ messageId: id, ledgerId: res.id, threadId });
  }
  if (out.budgetStopped) log({ event: 'request-reconcile-budget', note: `核账用了 ${now() - t0} 毫秒，到预算停了，剩下的下一遍接着核` });
  if (dirty) try { jwrite(donePath, done); } catch (e) { log({ event: 'request-done-write-failed', error: String(e?.message ?? e).slice(0, 120) }); }
  if (infoDirty) try { jwrite(infoPath, infoStore); } catch (e) { log({ event: 'request-info-write-failed', error: String(e?.message ?? e).slice(0, 120) }); } // 预算中途停了也走到这里，已查到的照样落盘
  return out;
}
export { WORKSHOP_CHANNEL };
