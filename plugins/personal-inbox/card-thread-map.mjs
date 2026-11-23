// Records which Discord thread belongs to which task card (record only, never edits a card).
// 卡↔线程对应：程序在“同时拿得到卡号和线程编号”的时刻自动记一条，只记、不改任何卡。
// 用处：桌面角色的六类审批卡要写“来自哪张任务卡”，先查这份对应，查不到再查任务记录，再不到才写“没查到关联任务卡”。
//
// 同时拿得到两样东西的时刻有三个（只读调查，见 证据/第二段返工.md 第七节）：
//  ① 工具调用时：官方任务板工具（workboard_claim／comment／proof／block…）的参数里有卡号 `id`，调用所在会话的会话键里有 Discord 线程编号
//     （线程里的会话键是 agent:<角色>:discord:channel:<线程编号>）；workboard_create 的卡号在回执里。——最稳，两样都是官方给的字段。
//  ② 开线程时：message 工具 thread-create 的首帖正文里写了卡号（恰好一个），回执里有新线程编号。
//  ③ 同一轮里先 workboard_create 建卡、再 thread-create 开线程：卡号取同一会话同一轮里建出来的那张（恰好一张）。
// 漏的情形见证据：bot 在线程里从不碰任务板、首帖也不写卡号；用户手动开的线程（不是 thread-create 开的）认不出是线程，不用。
// 会话键里线程和项目频道长得一样，所以查的时候只认“已知是 thread-create 开出来的线程”；同一线程对着多张还没结束的卡一律不挑，写“对应多张”。

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lexicon } from './lexicon.mjs';
const W = lexicon(); // folder names follow config "locale" (zh-CN: the names this file always used)

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const UUID_1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_LINKS = 3000;

// 参数里带卡号 `id`、且是“在这张卡上干活”的官方任务板工具（读、列表、统计、通知、看板类不算）
export const LINK_TOOLS = new Set([
  'workboard_claim', 'workboard_heartbeat', 'workboard_comment', 'workboard_proof', 'workboard_block', 'workboard_unblock',
  'workboard_specify', 'workboard_worker_log', 'workboard_attachment_add', 'workboard_release', 'workboard_complete', 'workboard_move',
]);

export const mapPath = (dataRoot) => join(dataRoot, W.layout.runLogs, W.layout.runLogDirs.cardThreads, '对应.json');
export const normTool = (name) => String(name ?? '').replace(/^mcp__openclaw__/, '');

// 会话键 → Discord 线程（或频道）编号。官方线程会话也写成 discord:channel:<编号>，所以拿到的可能是频道编号，查的时候靠“多张就不挑”兜底。
export function threadIdOfSession(sessionKey) {
  const m = /:discord:(?:channel|thread):(\d{17,20})(?::|$)/.exec(String(sessionKey ?? ''));
  return m ? m[1] : null;
}
export const extractCardIds = (text) => [...new Set(String(text ?? '').match(UUID_G) ?? [])];

export function readLinks(path) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    if (j && Array.isArray(j.links)) return { ...j, threads: j.threads && typeof j.threads === 'object' ? j.threads : {} };
  } catch { /* 没有或坏了就当空 */ }
  return { version: 1, links: [], threads: {} };
}

const saveDoc = (path, doc) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, path);
};

// 记下“这个编号确实是 thread-create 开出来的线程”。会话键里线程和频道长得一样（都是 discord:channel:<编号>），
// 项目频道主区域的会话也会碰任务板，记到的是频道编号；查的时候只认“已知是线程”的编号（见 desktop-lock.mjs 的 findCardByThread），免得把频道挂到某张卡上。
export function recordThread({ path, threadId, agent = null, now = Date.now() }) {
  const tid = String(threadId ?? '');
  if (!/^\d{17,20}$/.test(tid)) return null;
  const doc = readLinks(path);
  if (doc.threads[tid]) return doc.threads[tid];
  doc.threads[tid] = { at: new Date(now).toISOString(), by: agent };
  const keys = Object.keys(doc.threads);
  if (keys.length > MAX_LINKS) for (const k of keys.slice(0, keys.length - MAX_LINKS)) delete doc.threads[k];
  saveDoc(path, doc);
  return doc.threads[tid];
}

// 记一条（同一线程＋同一卡号只留一行，累计次数和来源）；先写临时文件再改名，读的人不会读到半截
export function recordLink({ path, threadId, cardId, via, agent = null, now = Date.now() }) {
  const tid = String(threadId ?? '');
  const cid = String(cardId ?? '');
  if (!/^\d{17,20}$/.test(tid) || !UUID_1.test(cid)) return null;
  const doc = readLinks(path);
  const at = new Date(now).toISOString();
  let row = doc.links.find((l) => l.threadId === tid && l.cardId === cid);
  if (row) {
    row.lastAt = at;
    row.n = (row.n ?? 1) + 1;
    if (via && !row.via.includes(via)) row.via.push(via);
    if (agent) row.agent = agent;
  } else {
    row = { threadId: tid, cardId: cid, via: via ? [via] : [], agent, firstAt: at, lastAt: at, n: 1 };
    doc.links.push(row);
  }
  if (doc.links.length > MAX_LINKS) doc.links = doc.links.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, MAX_LINKS);
  saveDoc(path, doc);
  return row;
}

export const cardsForThread = (path, threadId) => readLinks(path).links.filter((l) => l.threadId === String(threadId));

// 解开官方回执：可能是字符串、{details}、或 {content:[{text}]}
export function unwrapResult(result) {
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  let r = typeof result === 'string' ? parse(result) : (result?.details ?? result);
  const text = r?.content?.[0]?.text;
  if (r && typeof text === 'string' && !r.card && !r.thread) r = parse(text) ?? r;
  return r;
}

const isThreadCreate = (action) => /^thread[-_ ]?create$/i.test(String(action ?? '').trim());

export function registerCardThreadLinks(api, { dataRoot, log = () => {}, now = () => Date.now() } = {}) {
  if (!dataRoot) return;
  const path = mapPath(dataRoot);
  const pendingThread = new Map(); // toolCallId → { text, runKey }
  const runCards = new Map(); // `${会话键}|${运行编号}` → Set(本轮建出来的卡号)
  const keep = (map, max) => { while (map.size > max) map.delete(map.keys().next().value); };
  const runKeyOf = (event, ctx) => `${ctx?.sessionKey ?? ''}|${event?.runId ?? ctx?.runId ?? ''}`;
  const link = (threadId, cardId, via, ctx) => {
    const row = recordLink({ path, threadId, cardId, via, agent: ctx?.agentId ?? null, now: now() });
    if (row) log({ 结果: '记卡线程对应', 线程: threadId, 卡: cardId, 依据: via, 角色: ctx?.agentId ?? null, 次数: row.n });
    return row;
  };

  api.on('before_tool_call', async (event, ctx) => {
    try {
      if (normTool(event?.toolName) !== 'message' || !isThreadCreate(event?.params?.action) || !event?.toolCallId) return undefined;
      pendingThread.set(event.toolCallId, { text: String(event.params?.message ?? event.params?.content ?? ''), runKey: runKeyOf(event, ctx) });
      keep(pendingThread, 200);
    } catch { /* 记账失败不影响正常调用 */ }
    return undefined;
  }, { registrationId: 'card-thread-link-before' });

  api.on('after_tool_call', async (event, ctx) => {
    try {
      const tool = normTool(event?.toolName);
      if (event?.error) return;
      // ① 任务板工具：卡号在参数或回执里，线程编号在会话键里
      if (tool.startsWith('workboard_')) {
        const tid = threadIdOfSession(ctx?.sessionKey);
        if (tool === 'workboard_create') {
          const id = unwrapResult(event?.result)?.card?.id;
          if (typeof id === 'string' && UUID_1.test(id)) {
            const k = runKeyOf(event, ctx);
            if (!runCards.has(k)) runCards.set(k, new Set());
            runCards.get(k).add(id);
            keep(runCards, 200);
            if (tid) link(tid, id, '建卡', ctx);
          }
          return;
        }
        if (!LINK_TOOLS.has(tool) || !tid) return;
        const id = event?.params?.id;
        if (typeof id === 'string' && UUID_1.test(id)) link(tid, id, tool.replace('workboard_', ''), ctx);
        return;
      }
      // ② ③ 开线程：首帖里恰好一个卡号，否则取同一会话同一轮里刚建出来的那张（恰好一张）
      if (tool === 'message' && event?.toolCallId && pendingThread.has(event.toolCallId)) {
        const pend = pendingThread.get(event.toolCallId);
        pendingThread.delete(event.toolCallId);
        const r = unwrapResult(event?.result);
        const threadId = String(r?.thread?.id ?? r?.threadId ?? '');
        if (!threadId) return;
        recordThread({ path, threadId, agent: ctx?.agentId ?? null, now: now() });
        const inText = extractCardIds(pend.text);
        if (inText.length === 1) { link(threadId, inText[0], '开线程首帖', ctx); return; }
        if (inText.length === 0) {
          const made = [...(runCards.get(pend.runKey) ?? [])];
          if (made.length === 1) link(threadId, made[0], '同一轮建卡再开线程', ctx);
        }
      }
    } catch (e) { log({ 结果: '记卡线程对应失败', 原因: String(e?.message ?? e) }); }
  }, { registrationId: 'card-thread-link-after' });
}
