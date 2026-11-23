// Pending-decision ledger ("waiting for you") and its reminder logic. The program writes the ledger; the model only writes the request text.
// “等你定的事”台账和提醒逻辑。
// 台账由程序记，模型只写请示正文；所有写台账的（两个工具、“等你定”脚本）都走 withLedger 这一个写入函数。
// 时间、条数放在下面常量，注明谁定的。
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, openSync, closeSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { APPROVAL_CHANNEL_ID } from './approval-card.mjs';

import { crew } from './crew-config.mjs';
import { lexicon, escapeRe } from './lexicon.mjs';
const W = lexicon(); // words follow config "locale" (zh-CN: the literals this file always used)
const N = W.notices.ledger; // fixed sentences for the owner follow config "locale"
const S = W.ledgerStatus;
export const OWNER_ID = crew.owner.userId;
// 审批卡（官方上限 10 分钟）过期不算拒绝，登记进本台账留 24 小时；到点前 2 小时在审批频道点名提醒一次；24 小时到了还没批，算没批、原线程说一句。
// 这类条目 source='审批过期'，由 runApprovalExpiryTick 单独处理；runTick 的其余各步（读回应、首次点名、3 天合并提醒、截止前 24 小时提醒、总表）一律跳过它，工坊里不会为它多发任何点名。
export const APPROVAL_EXPIRED_SOURCE = W.ledgerSources.approvalExpired;
export const APPROVAL_EXPIRY_MS = 24 * 3600 * 1000; // 主人 07:15 定“24 小时、到点前提醒”
export const APPROVAL_EXPIRY_LEAD_MS = 2 * 3600 * 1000;
export const isApprovalExpiry = (it) => it?.source === APPROVAL_EXPIRED_SOURCE;
export const WORKSHOP_CHANNEL = crew.channels.workshop; // workshop channel: only the owner and the controller talk there
export const MERGE_INTERVAL_MS = 3 * 24 * 3600 * 1000; // 全表合并提醒间隔：设计决定
export const MERGE_MAX_ITEMS = 3; // 每次最多几件：设计决定
export const DEADLINE_LEAD_MS = 24 * 3600 * 1000; // 截止前提醒：起草定，可改
export const JUDGE_TIMEOUT_MS = 24 * 3600 * 1000; // 待判限时：起草定，可改
export const DEFAULT_RECHECK_DAYS = 7; // “收到”没约定日期的默认复查：起草定，可改
export const LOCK_WAIT_MS = 5000; // 锁等待：起草定
export const LOCK_STALE_MS = 10 * 60 * 1000;
export const READ_FAIL_NOTICE = 3; // 连续读不到 Discord 几次后在提醒里写一句

export const sha8 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function emptyLedger() {
  return { version: 0, pinnedMessageId: null, pinnedTextHash: null, lastMergedReminderAt: null, readFailures: 0, items: [] };
}

export function readLedgerFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return emptyLedger(); throw e; }
}

// 唯一写入函数：独占建锁文件→读最新→改→写临时文件再改名→删锁；版本号 +1。
// 锁在就等最多 LOCK_WAIT_MS，等不到就这次不写，返回 { busy:true }。
// 锁比 LOCK_STALE_MS 老：只有“锁里 pid 能解析成正整数、且该进程已不存在（ESRCH）”才回收；
// pid 还在（含 EPERM）、锁里没有 pid／读不懂 → 照旧不抢不删，在看护目录记待核。回收做法见 reclaimStaleLock。
const lockInfoOf = (raw) => { try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
// 持锁进程还在不在：ESRCH＝不在；成功或 EPERM（有这个进程但无权限）或别的错＝按在算（保守）；pid 不是正整数＝读不懂。
export function pidState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; } catch (e) { return e.code === 'ESRCH' ? 'dead' : 'alive'; }
}
const watchLog = (watchDir, now, text) => { if (watchDir) { mkdirSync(watchDir, { recursive: true }); appendFileSync(join(watchDir, '台账锁待核.log'), `${new Date(now()).toISOString()} ${text}\n`); } };

// 回收一把“年龄超时＋持锁进程已死”的老锁。返回 'got'（已回收并新建了自己的锁，调用方继续）、'retry'（锁已不在，回到循环再建）、
// 'wait'（别人正在回收，照常等）、{ busy:true,… }（按忙返回，这一次不写）。
// 不用“改名再改回”（renameSync 目标存在会静默覆盖，会盖掉别人刚建的锁）：①先用 wx 新建互斥小文件 .lock.reclaim，建不成就不回收；
// ②拿到互斥后再读一次锁的完整内容，和判死时一字不差才删，不一样（锁已被换过）就放掉互斥、本次按忙；③删旧锁、用 wx 新建自己的锁、删互斥。
// 互斥文件自己遗留（回收者半路被掐）：不自动删，也不绕过去回收，写“待核”日志、本次按忙返回；里面 pid 还在就当别人正在回收、照常等。
function reclaimStaleLock({ lock, rawAtJudge, info, age, now, watchDir, hooks }) {
  const mutex = `${lock}.reclaim`;
  try { const fd = openSync(mutex, 'wx'); writeFileSync(fd, JSON.stringify({ at: now(), pid: process.pid })); closeSync(fd); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let raw = ''; try { raw = readFileSync(mutex, 'utf8'); } catch { /* 刚被删 */ }
    const minfo = lockInfoOf(raw);
    if (!raw) return 'retry';
    if (pidState(minfo.pid) === 'alive') return 'wait';
    watchLog(watchDir, now, `台账锁待核（“回收中”文件遗留，不自动删）：内容 ${raw.trim().slice(0, 100)}，年龄 ${Math.round((now() - (minfo.at ?? 0)) / 60000)} 分钟，里面 pid ${minfo.pid ?? '无'} ${pidState(minfo.pid) === 'dead' ? '已不在' : '读不懂'}`);
    return { busy: true, stale: true, message: '台账锁待核（“回收中”文件遗留，不自动删），稍后由人工处理' };
  }
  try {
    hooks?.afterReclaimMutex?.();
    let rawNow;
    try { rawNow = readFileSync(lock, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return 'retry'; throw e; }
    if (rawNow !== rawAtJudge) return { busy: true, message: '台账忙，稍后再试（锁已被换过，不回收）' };
    rmSync(lock);
    watchLog(watchDir, now, `台账锁回收（旧锁 pid ${info.pid} 已不在，已存在 ${Math.round(age / 60000)} 分钟，回收者 pid ${process.pid}）`);
    try { const fd = openSync(lock, 'wx'); writeFileSync(fd, JSON.stringify({ at: now(), pid: process.pid })); closeSync(fd); } catch (e) {
      if (e.code === 'EEXIST') return 'retry'; // 刚删完就被别人抢先建了锁：回到循环按正常等待
      throw e;
    }
    return 'got';
  } finally { try { rmSync(mutex); } catch { /* 已不在 */ } }
}

export async function withLedger(path, mutate, { now = () => Date.now(), sleep = defaultSleep, watchDir = null, hooks = null } = {}) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = now() + LOCK_WAIT_MS;
  let got = false;
  for (;;) {
    try { const fd = openSync(lock, 'wx'); writeFileSync(fd, JSON.stringify({ at: now(), pid: process.pid })); closeSync(fd); got = true; break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0, rawAtJudge = '';
      // 年龄只看锁里的 at；读不到或还没写完（刚 openSync 建出来还是空的）按 0 算＝照常等，和改前一样。
      try { rawAtJudge = readFileSync(lock, 'utf8'); age = now() - (JSON.parse(rawAtJudge).at ?? 0); } catch { age = 0; }
      if (age > LOCK_STALE_MS) {
        const info = lockInfoOf(rawAtJudge);
        if (pidState(info.pid) === 'dead') {
          const out = reclaimStaleLock({ lock, rawAtJudge, info, age, now, watchDir, hooks });
          if (out === 'got') { got = true; break; }
          if (typeof out === 'object') return out;
          if (out === 'retry') continue;
          // 'wait'：别人正在回收，落到下面的正常等待
        } else {
          watchLog(watchDir, now, `台账锁待核（锁已存在 ${Math.round(age / 60000)} 分钟，pid ${info.pid ?? '无'} ${pidState(info.pid) === 'alive' ? '还在' : '读不懂'}，不抢）`);
          return { busy: true, stale: true, message: '台账锁待核（锁太老，不抢），稍后由人工处理' };
        }
      }
      if (now() >= deadline) return { busy: true, message: '台账忙，稍后再试' };
      await sleep(100);
    }
  }
  try {
    const ledger = readLedgerFile(path);
    const out = await mutate(ledger);
    if (out?.noWrite) return { busy: false, ...out };
    ledger.version = (ledger.version ?? 0) + 1;
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(ledger, null, 1), { mode: 0o600 });
    renameSync(tmp, path);
    return { busy: false, version: ledger.version, ...out };
  } finally { try { rmSync(lock); } catch { /* 已被清理 */ } }
}

let seq = 0;
export function newItemId(now) { seq += 1; return `D-${new Date(now).toISOString().slice(2, 10).replace(/-/g, '')}-${String(seq).padStart(2, '0')}${sha8(`${now}${seq}${Math.random()}`).slice(0, 2)}`; }

// ----- 登记 -----
export function registerItem(ledger, input, now) {
  const required = ['title', 'suggestion', 'blocks', 'requestMessageId'];
  for (const k of required) if (!input[k]) return { error: `缺少 ${k}` };
  const dup = ledger.items.find((it) => it.requestMessageId === String(input.requestMessageId));
  if (dup) return { item: dup, existing: true };
  const item = {
    id: newItemId(now), title: input.title, suggestion: input.suggestion, blocks: input.blocks,
    deadline: input.deadline && input.deadline !== W.noDeadline ? input.deadline : null,
    requestLink: input.requestLink ?? null, requestMessageId: String(input.requestMessageId), requestChannelId: input.requestChannelId ? String(input.requestChannelId) : null,
    threadId: input.threadId ? String(input.threadId) : null, botId: input.botId ?? null,
    firstAskedAt: null, lastRemindedAt: null, remindCount: 0, status: S.noReply, pendingJudgeSince: null, recheckDate: null,
    decision: null, decisionSource: null, decisionBasis: null, isTest: !!input.isTest, autoRegistered: !!input.autoRegistered, batch: input.batch ?? null,
    handledReplies: [], possibleReply: null, responseUnknown: null, preDeadlineRemindedAt: null, registeredAt: now,
    notice: null,
  };
  ledger.items.push(item);
  return { item };
}

// ----- 更新：核主人那条回应对应哪一件 -----
// message: { id, authorId, replyToId, channelId, content }（工具读 Discord 得到）
export function updateItem(ledger, { id, status, recheckDate, decision, source, basis }, message, now) {
  const item = ledger.items.find((it) => it.id === id);
  if (!item) return { error: `找不到 ${id}` };
  const allowed = [S.received, S.decided, S.revoked, S.noReply];
  if (!allowed.includes(status)) return { error: `状态只能是 ${allowed.join('／')}` };
  if (item.isTest && status === S.revoked) { item.status = S.revoked; item.decisionSource = source ?? '测试件撤销'; return { item }; }
  // 程序补登记的条目（autoRegistered）可能是误报（比如 bot 没登记、主人已经点了按钮办完了）：这类条目总控可以撤销，
  // 不要求主人的消息，但必须写“对应依据”说明为什么撤；只许撤销，不许借此判“已定／收到”。
  if (item.autoRegistered && status === S.revoked) {
    if (!basis || !String(basis).trim()) return { error: '撤销程序补登记的条目要填“对应依据”（比如“他已经点了按钮”“这不是要他定的事”）' };
    item.status = S.revoked; item.decisionSource = '程序补登记误报，总控撤销'; item.decisionBasis = String(basis).trim().slice(0, 200); item.pendingJudgeSince = null;
    return { item };
  }
  if (!message) return { error: '没有读到你那条回应的原消息，不改' };
  if (String(message.authorId) !== OWNER_ID) return { error: '那条消息的作者不是主人本人' };
  const linked = (message.replyToId && String(message.replyToId) === item.requestMessageId) || (item.threadId && String(message.channelId) === item.threadId);
  let usedBasis = null;
  if (!linked) {
    if (!basis) return { error: '那条消息没有回复关联这件的原请示，也不在这件的事项线程里：要填“对应依据”（引他原话里点到这件的几个字）' };
    if (!String(message.content ?? '').includes(basis)) return { error: '“对应依据”不在他那条消息的原话里' };
    usedBasis = basis;
  }
  if (item.handledReplies.includes(String(message.id))) return { error: '这条回应已经处理过这件，不再重复处理' };
  item.handledReplies.push(String(message.id));
  item.status = status;
  item.decisionSource = String(message.id);
  item.decisionBasis = usedBasis;
  item.pendingJudgeSince = null;
  if (status === S.received) {
    item.recheckDate = recheckDate || new Date(now + DEFAULT_RECHECK_DAYS * 86400000).toISOString().slice(0, 10);
    item.recheckDefault = !recheckDate;
  }
  if (status === S.decided) item.decision = decision ?? '(未写结论)';
  return { item };
}

// ----- 文字 -----
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export function activeForTable(ledger, now) {
  return ledger.items.filter((it) => !it.isTest && !isApprovalExpiry(it) && [S.noReply, S.judging, S.received].includes(it.status)); // 收到的件一直在总表里显示（到约定日才回到提醒候选，那是 runTick 的事）
}
export const TABLE_MAX_CHARS = 1900; // Discord 一条消息最多 2000 字
export const TABLE_MAX_LINES = 16; // 官方 Discord 渠道每条消息默认最多 17 行，超了会被拆成几条，留 1 行余量
// 三档详细程度：2 行（标题＋建议／卡住／截止，第二行原请示链接）→ 1 行（标题＋链接）→ 只剩标题
function itemLines(it, k, level) {
  const link = it.requestLink ?? N.linkFallback(it.requestMessageId);
  const flags = [it.possibleReply ? N.flagPossible(it.possibleReply.messageId) : null, it.responseUnknown ? N.flagUnknown(it.responseUnknown) : null].filter(Boolean).join(N.flagJoin);
  const st = it.status === S.received ? N.received(S.received, it.recheckDefault, it.recheckDate) : it.status;
  if (level === 0) return N.itemFull(k + 1, it.title, it.suggestion, it.blocks, it.deadline ?? W.noDeadline, st, flags, link);
  if (level === 1) return [N.itemOne(k + 1, it.title, st, link)];
  return [N.itemTitle(k + 1, it.title, st)];
}
export function buildTable(ledger, now) {
  const rows = activeForTable(ledger, now);
  const head = [N.tableTitle, N.tableNote];
  const foot = [N.updated(new Date(now).toISOString().slice(0, 16).replace('T', ' '))];
  const build = (nFull, nOne) => {
    const lines = [...head];
    if (rows.length === 0) lines.push(N.none);
    rows.forEach((it, k) => lines.push(...itemLines(it, k, k < nFull ? 0 : k < nFull + nOne ? 1 : 2)));
    lines.push(...foot);
    return lines.join('\n');
  };
  const ok = (t) => t.length <= TABLE_MAX_CHARS && t.split('\n').length <= TABLE_MAX_LINES;
  // 尽量多放详细的几件，放不下的依次降一档
  let text = build(rows.length, 0);
  for (let n = rows.length - 1; !ok(text) && n >= 0; n--) text = build(n, rows.length - n);
  for (let n = rows.length; !ok(text) && n >= 0; n--) text = build(0, n); // 只留 n 件一行的，其余只写标题
  if (!ok(text)) { const lines = text.split('\n').slice(0, TABLE_MAX_LINES - 2); text = `${lines.join('\n').slice(0, TABLE_MAX_CHARS - 60)}\n${N.tooLong}\n${foot[0]}`; }
  return text;
}

const mention = `<@${OWNER_ID}>`;
const tag = (fp) => N.tag(fp);
const withTag = (text) => `${text}\n${tag(sha8(text))}`;

// ----- 每 30 分钟一遍 -----
// discord 适配：{ send({target,text,replyTo}) → {messageId|null}, edit({target,messageId,text}), pin({target,messageId}),
//               readReplies(item) → [{id,authorId,replyToId,channelId,content}], search({query,channelId}) → [msg] }
// deadlineAt（可选，毫秒时间戳）：这一轮最迟到几点（补登记修改·①-3）。不传＝和以前完全一样。
//   传了：到点不再起新的“读回应／搜索”（每次读的命令上限取“剩余时间和 60 秒里小的”；没读的不算读取失败、下一轮接着读），
//   到点也不再开始新的发送／编辑／置顶／点名／叫醒（状态不改，下一轮自然重来，不会少发也不会重复发）；已经处理好的状态照常落盘、解锁。
export async function runTick({ path, now = () => Date.now(), discord, watchDir = null, sleep, deadlineAt = null }) {
  const actions = [];
  const t = now();
  let deadlineHit = false; let skippedReads = 0;
  const late = () => { if (deadlineAt != null && now() >= deadlineAt) { deadlineHit = true; return true; } return false; };
  const res = await withLedger(path, async (L) => {
    // 1) 先处理上次“发送待核”的
    for (const it of L.items) {
      if (isApprovalExpiry(it)) continue;
      if (it.notice?.state === '发送待核' && late()) continue; // 到点：这条搜索留给下一轮
      if (it.notice?.state === '发送待核') {
        const found = await discord.search({ query: it.notice.token, channelId: WORKSHOP_CHANNEL }).catch(() => null);
        const hit = found?.find?.((m) => String(m.content ?? '').includes(it.notice.token));
        if (hit) { it.notice.state = '已发'; it.notice.messageId = hit.id; actions.push({ type: 'recovered-notice', id: it.id }); } else { it.notice.state = '未送达'; actions.push({ type: 'notice-not-delivered', id: it.id }); }
      }
    }
    // 2) 识别回应
    let readOk = true;
    for (const it of L.items) {
      if (it.isTest || isApprovalExpiry(it) || ![S.noReply, S.judging, S.received].includes(it.status)) continue;
      if (it.status === S.judging && it.pendingJudgeSince && t - it.pendingJudgeSince >= JUDGE_TIMEOUT_MS) {
        // 超时：把那条回应记成“已超时处理”，以后同一条回应再被读到也不再触发
        if (it.lastReplyId && !it.handledReplies.includes(String(it.lastReplyId))) it.handledReplies.push(String(it.lastReplyId));
        it.status = S.noReply; it.pendingJudgeSince = null; it.judgeCall = null; it.possibleReply = { messageId: it.lastReplyId ?? null, note: N.judgeTimeoutNote }; actions.push({ type: 'judge-timeout', id: it.id });
      }
      let msgs;
      if (late()) { skippedReads++; continue; } // 到点：这条留给下一轮，不改 responseUnknown、不算读取失败
      try { msgs = await (deadlineAt == null ? discord.readReplies(it) : discord.readReplies(it, Math.max(1000, Math.min(60000, deadlineAt - now())))); it.responseUnknown = null; } catch (e) { readOk = false; it.responseUnknown = N.readFailed(new Date(t).toISOString().slice(11, 16)); continue; }
      for (const m of msgs ?? []) {
        if (String(m.authorId) !== OWNER_ID) continue;
        const linked = (m.replyToId && String(m.replyToId) === it.requestMessageId) || (it.threadId && String(m.channelId) === it.threadId);
        if (linked) {
          if (it.handledReplies.includes(String(m.id))) continue; // 已处理过的回应不再把状态改回待判
          if (it.status !== S.judging) {
            // 认到回应：建一次性任务叫醒总控去判
            const call = await (discord.wakeJudge ? discord.wakeJudge({ item: it, replyId: String(m.id) }).catch((e) => ({ error: String(e?.message ?? e) })) : Promise.resolve({ error: '没有叫醒办法' }));
            if (call?.jobId) {
              it.status = S.judging; it.pendingJudgeSince = t; it.lastReplyId = String(m.id); it.judgeCall = { state: '已叫起', jobId: call.jobId, at: t };
              actions.push({ type: 'to-judge', id: it.id, replyId: String(m.id), jobId: call.jobId });
            } else {
              it.judgeCall = { state: '叫起失败', error: String(call?.error ?? '没有任务编号').slice(0, 120), at: t }; // 状态不变，下一轮再试；不发任何消息
              actions.push({ type: 'judge-call-failed', id: it.id, replyId: String(m.id) });
            }
          }
        } else if (!it.possibleReply || it.possibleReply.messageId !== String(m.id)) {
          it.possibleReply = { messageId: String(m.id) }; // 同频道无关联的话：只标，不改状态
        }
      }
    }
    if (readOk) { if (skippedReads === 0) L.readFailures = 0; } else L.readFailures = (L.readFailures ?? 0) + 1; // 有没读的（到点跳过）：既不算成功也不算失败，计数不动
    if (skippedReads > 0) actions.push({ type: 'deadline-skip-reads', n: skippedReads });
    // 3) 总表：不同才改；第一次发出并置顶
    const table = buildTable(L, t);
    const th = sha8(table.replace(new RegExp(`\\n${escapeRe(N.updatedLabel)}.*$`, 's'), ''));
    if (late()) { /* 到点：本轮不再发送／编辑，留给下一轮 */ } else if (!L.pinnedMessageId) {
      const r = await discord.send({ target: WORKSHOP_CHANNEL, text: table });
      if (r?.messageId) {
        // 先把编号和内容指纹记下来（以后只改这一条，不再重发），再置顶：置顶失败（例如机器人缺“置顶消息”权限）只记下来，不能让下一轮又发一张新表
        L.pinnedMessageId = r.messageId; L.pinnedTextHash = th; L.pinError = null;
        try { await discord.pin({ target: WORKSHOP_CHANNEL, messageId: r.messageId }); actions.push({ type: 'pin-table' }); }
        catch (e) { L.pinError = `置顶失败：${String(e?.message ?? e).slice(0, 120)}`; actions.push({ type: 'pin-failed', error: L.pinError }); }
      }
    } else if (L.pinnedTextHash !== th) {
      await discord.edit({ target: WORKSHOP_CHANNEL, messageId: L.pinnedMessageId, text: table }); L.pinnedTextHash = th; actions.push({ type: 'edit-table' });
    }
    // 4) 首次点名：没点过的；“搭建期首批”合成一条
    const fresh = L.items.filter((it) => !it.isTest && !isApprovalExpiry(it) && it.status === S.noReply && !it.firstAskedAt && !(it.notice && ['待发', '发送待核'].includes(it.notice.state)));
    const groups = new Map();
    for (const it of fresh) { const k = it.batch === '搭建期首批' ? 'batch' : it.id; (groups.get(k) ?? groups.set(k, []).get(k)).push(it); }
    for (const [, items] of groups) {
      if (late()) break; // 到点：没点过名的留给下一轮（firstAskedAt 没设，不会少点）
      const body = items.length > 1 || items[0].batch === '搭建期首批'
        ? N.batchAsk(mention, items.length, items.map((it, k) => N.batchLine(k + 1, it.title, it.requestLink ?? it.requestMessageId)).join('\n'))
        : N.newAsk(mention, items[0].title, items[0].requestLink ?? items[0].requestMessageId);
      await sendNotice(L, items, body, 'first', t, discord, actions);
    }
    if (!L.lastMergedReminderAt && L.items.some((it) => it.firstAskedAt)) L.lastMergedReminderAt = t; // 第一次点名时起算 3 天
    // 5) 全表合并提醒：满 3 天才发；最多 3 件；上次提醒最早的优先
    const lastM = L.lastMergedReminderAt ?? 0;
    if (L.lastMergedReminderAt && t - lastM >= MERGE_INTERVAL_MS && !late()) {
      const cand = L.items.filter((it) => !it.isTest && !isApprovalExpiry(it) && (it.status === S.noReply || (it.status === S.received && it.recheckDate && it.recheckDate <= dayOf(t))) && it.firstAskedAt)
        .sort((a, b) => (a.lastRemindedAt ?? -1) - (b.lastRemindedAt ?? -1));
      const pick = cand.slice(0, MERGE_MAX_ITEMS);
      if (pick.length > 0) {
        const extra = (L.readFailures ?? 0) >= READ_FAIL_NOTICE ? N.mergedExtra : '';
        const lines = pick.map((it, k) => N.mergedLine(k + 1, it.title, it.possibleReply, it.requestLink ?? it.requestMessageId));
        const body = N.mergedBody(mention, extra, lines.join('\n'));
        const sent = await sendNotice(L, pick, body, 'merged', t, discord, actions);
        if (sent) L.lastMergedReminderAt = t;
      }
    }
    // 6) 截止前 24 小时额外点一次（每件一次）
    for (const it of L.items) {
      if (it.isTest || isApprovalExpiry(it) || !it.deadline || it.preDeadlineRemindedAt || ![S.noReply, S.judging, S.received].includes(it.status)) continue;
      if (late()) break; // 到点：留给下一轮
      const dl = Date.parse(it.deadline);
      if (Number.isNaN(dl) || dl - t > DEADLINE_LEAD_MS || dl < t) continue;
      const body = N.deadlineAsk(mention, it.deadline, it.title, it.requestLink ?? it.requestMessageId);
      if (await sendNotice(L, [it], body, 'deadline', t, discord, actions)) it.preDeadlineRemindedAt = t;
    }
    if (!late()) await runApprovalExpiryTick(L, t, discord, actions);
  }, { now, sleep, watchDir });
  if (deadlineHit) actions.push({ type: 'deadline-skip' }); // 到点跳过了东西：留一条动作，日志里看得到（状态没改，下一轮重来）
  return { ...res, actions };
}

// 登记（在 withLedger 里调用）：kind＝'结案确认'|'桌面角色六类操作'。requestMessageId 填合成编号（不是 Discord 消息号）：台账要求必填且按它去重，
// 所以同一张卡不会登记两次；别的地方不拿它去读 Discord（runTick 对这类条目整个跳过）。绝不设 firstAskedAt（设了会进“3 天合并提醒”）。
export function registerApprovalExpiry(ledger, { kind, what = null, cardId = null, threadId = null, link = null, expiredAt }, now, { probe = false, deadlineAt = null, leadMs = null } = {}) {
  const kindKey = kind === W.ledgerKinds.closing ? W.ledgerKindKeys.closing : W.ledgerKindKeys.desktop;
  const rid = `${W.approvalIdPrefix}:${kindKey}:${cardId ?? threadId ?? W.unknownWord}:${expiredAt ?? now}`;
  const one = String(what ?? N.expiryNoReason).replace(/\s+/g, ' ').trim().slice(0, 60);
  const dl = deadlineAt ?? (now + APPROVAL_EXPIRY_MS);
  const r = registerItem(ledger, {
    title: N.expiryTitle(kind, one), suggestion: N.expirySuggestion, blocks: N.expiryBlocks(kind),
    requestMessageId: rid, requestLink: link, threadId, isTest: false,
  }, now);
  if (r.error || r.existing) return r;
  Object.assign(r.item, { source: APPROVAL_EXPIRED_SOURCE, kind, cardId, link, deadlineAt: dl, leadMs: leadMs ?? APPROVAL_EXPIRY_LEAD_MS, reminded: null, expirySay: null, probe: !!probe, expiredAt: expiredAt ?? now });
  r.item.deadline = new Date(dl).toISOString();
  return r;
}
// 同一件事又出了新的审批卡（说明已经重新申请）：把还没处理的审批过期条目改“已定”，不再提醒也不再撤销。
export function closeApprovalExpiryOnReissue(ledger, { kind, cardId = null, threadId = null }, now) {
  let n = 0;
  for (const it of ledger.items) {
    if (!isApprovalExpiry(it) || it.status !== S.noReply || it.kind !== kind) continue;
    // 结案确认按任务卡号认；桌面角色六类操作按卡号或线程认（同一个线程重新申请就算）。
    const same = kind === W.ledgerKinds.closing ? Boolean(cardId && it.cardId === cardId) : Boolean((cardId && it.cardId === cardId) || (threadId && it.threadId === String(threadId)));
    if (!same) continue;
    it.status = S.decided; it.decision = '已重新申请，出了新的审批卡'; it.decisionSource = '程序'; it.decisionAt = now; n += 1;
  }
  return n;
}
export async function recordApprovalExpiry(path, info, { now = () => Date.now(), ...opts } = {}) {
  return withLedger(path, (L) => registerApprovalExpiry(L, info, now(), opts), { now });
}
export async function recordApprovalReissue(path, info, { now = () => Date.now() } = {}) {
  return withLedger(path, (L) => { const n = closeApprovalExpiryOnReissue(L, info, now()); return n > 0 ? { closed: n } : { noWrite: true, closed: 0 }; }, { now });
}
// 每次 runTick 末尾：①到“截止−提前量”→ 审批频道点名主人一次；②到截止仍没处理 → 撤销，原线程说一句（发失败下一轮再试，最多 3 次）。
export const APPROVAL_EXPIRED_THREAD_TEXT = N.expiryThread;
export async function runApprovalExpiryTick(L, t, discord, actions) {
  // 调用方没明确传发送函数就什么都不发，只记一行（不去猜一个默认的真发送）。
  if (typeof discord?.send !== 'function') {
    if (L.items.some((it) => isApprovalExpiry(it) && it.status === S.noReply)) actions.push({ type: 'approval-expiry-no-send', why: '没有传发送函数，这一遍不发提醒也不撤销' });
    return;
  }
  for (const it of L.items) {
    if (!isApprovalExpiry(it) || it.status !== S.noReply || !Number.isFinite(it.deadlineAt)) continue;
    if (t >= it.deadlineAt) {
      // 原线程那句“过期了”只发一次，记在台账文件里去重——发之前先记 expirySay.state＝'发送中'，
      // 发完记 '已发'（拿到消息编号）或 '结果不明'（命令超时之类，消息可能已经发出去，也算用掉了，不重发）。
      // 条目一进这里就在同一次写入里改成“撤销”，所以下一轮不会再进来；万一这一轮在发送中途进程挂了，下一轮看到 '发送中' 也不重发。
      if (it.threadId && !it.expirySay) {
        it.expirySay = { state: '发送中', at: t };
        try {
          const r = await discord.send({ target: it.threadId, text: APPROVAL_EXPIRED_THREAD_TEXT });
          it.expirySay = r?.messageId ? { state: '已发', at: t, messageId: String(r.messageId) } : { state: '结果不明', at: t, why: '没拿到消息编号' };
        } catch (e) { it.expirySay = { state: '结果不明', at: t, why: String(e?.message ?? e).slice(0, 120) }; }
      }
      it.status = S.revoked; it.decision = '24 小时到了没批，按没批处理'; it.decisionSource = '程序'; it.decisionAt = t;
      actions.push({ type: 'approval-expiry-cancelled', id: it.id, saidInThread: it.expirySay?.state ?? null });
      continue;
    }
    if (!it.reminded && it.deadlineAt - t <= (it.leadMs ?? APPROVAL_EXPIRY_LEAD_MS)) {
      const text = N.expiryReminder(`<@${OWNER_ID}>`, it.deadline, it.title, it.cardId, it.link);
      try { await discord.send({ target: APPROVAL_CHANNEL_ID, text }); it.reminded = t; actions.push({ type: 'approval-expiry-reminded', id: it.id }); }
      catch { actions.push({ type: 'approval-expiry-remind-failed', id: it.id }); }
    }
  }
}

// 发一条点名：先记“待发”，发后记编号；没拿到编号 → 发送待核，不重发
async function sendNotice(L, items, body, kind, t, discord, actions) {
  const text = withTag(body);
  const token = tag(sha8(body));
  for (const it of items) it.notice = { state: '待发', token, kind, at: t };
  const r = await discord.send({ target: WORKSHOP_CHANNEL, text }).catch(() => null);
  if (r?.messageId) {
    for (const it of items) { it.notice = { state: '已发', token, kind, at: t, messageId: r.messageId }; it.lastRemindedAt = t; it.remindCount = (it.remindCount ?? 0) + 1; if (!it.firstAskedAt) it.firstAskedAt = t; }
    actions.push({ type: `notice-${kind}`, ids: items.map((i) => i.id), messageId: r.messageId });
    return true;
  }
  for (const it of items) { it.notice = { state: '发送待核', token, kind, at: t }; if (!it.firstAskedAt) it.firstAskedAt = t; it.lastRemindedAt = t; }
  actions.push({ type: `notice-${kind}-unknown`, ids: items.map((i) => i.id) });
  return true; // 发送结果不明也算这个时点用掉了，不自动重发
}
