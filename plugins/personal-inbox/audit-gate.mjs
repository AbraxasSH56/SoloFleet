// Completion gate: a task card cannot move to "done" unless an audit report passed and the result files are unchanged since submission.
// 结案关口：卡转成“完成”之前，程序核审计报告和成果指纹。
// 本文件分三块：
//   1. 入口判断（纯函数）：工具参数、命令文字里哪些会把卡写成完成。只看几个指定字段，不扫全文。
//   2. 账本和结案判断（纯逻辑，账本存取由外面传进来，方便离线测试）。
//   3. 钩子登记 registerAuditGate（插件 index.mjs 调用）。
// 边界（写给交接）：命令文字守门只管 `workboard`／`gateway call workboard.cards` 这类写法；写脚本绕开、直接改任务板数据库
// 不在能挡的范围，由白天看护的“事后核账”兜底。官方任务板自己启动的 worker 收尾也是 workboard_complete，不开例外。
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { composeApprovalDescription, cutCodePoints, notifyApprovalCard, APPROVAL_TITLE_MAX } from './approval-card.mjs';

import { crew, botId } from './crew-config.mjs';
import { lexicon, locale, labelRe, escapeRe, tagCloseRe } from './lexicon.mjs';
const W = lexicon(); // words follow config "locale" (zh-CN: the literals this file always matched)
const N = W.notices; // fixed sentences for the owner follow config "locale"
const [TQ_PRE, TQ_POST] = N.titleQuote('\u0000').split('\u0000'); // the brackets around a card title, to cut the title inside them
const EN = locale() === 'en';
// ---------- 常量 ----------
export const DONE_STATES = ['done']; // 官方状态里只有 done 算完成（第 0 步：dist/src-uqZESs4H.mjs）
export const AUDIT_LABEL_PREFIX = W.auditLabelPrefix;
export const AUDIT_LABEL_VALUES = W.auditLabelValues; // 认得的几种（《任务记录》模板：审计:单审任务审计、审计:单审独立、审计:串联）；其余算“不认识”
export const REVIEWER_AGENT = 'task-auditor'; // 任务审计
export const CLOSING_TOOLS = ['workboard_complete', 'workboard_release', 'workboard_move', 'workboard_reassign', 'workboard_reclaim'];
const NOT_ALLOWED_MSG = '改卡为完成请用 workboard_complete，它会做结案检查；不能直接建出已完成的卡';
const WORKER_HINT = '不要重试、不要换别的办法；用 workboard_block 记“待送审”，或直接结束；送审由主会话做';

const isDone = (v) => typeof v === 'string' && DONE_STATES.includes(v.trim().toLowerCase());
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => v !== undefined && v !== null && v !== '' && v !== false;

// ---------- 1. 入口判断 ----------
// 返回 { kind: 'pass' } | { kind: 'block', reason } | { kind: 'closing' }（要走结案核）
const pass = { kind: 'pass' };
const block = (reason) => ({ kind: 'block', reason });

// 参数里“会让卡变成完成”的几个字段（不扫全文）。
function createsDone(p) {
  if (!isObj(p)) return false;
  return isDone(p.status) || nonEmpty(p.completedAt) || (isObj(p.execution) && isDone(p.execution.status));
}

export function judgeToolParams(toolName, params, { workerRun = false } = {}) {
  const p = isObj(params) ? params : {};
  const tail = workerRun ? `；${WORKER_HINT}` : '';
  switch (toolName) {
    case 'workboard_create':
      if (createsDone(p)) return block(`不能直接建出已完成的卡：先建普通卡，做完再走完成${tail}`);
      return pass;
    case 'workboard_decompose':
      if (p.completeParent !== false) return block('拆分时不能顺带完成父卡：写 completeParent:false，父卡之后照常送审、完成');
      if (Array.isArray(p.children) && p.children.some(createsDone)) return block('拆分出的子卡不能带完成状态');
      return pass;
    case 'workboard_complete':
      return { kind: 'closing' };
    case 'workboard_release':
    case 'workboard_move':
    case 'workboard_reassign':
    case 'workboard_reclaim':
      return isDone(p.status) ? { kind: 'closing' } : pass;
    default:
      return pass;
  }
}

// 命令文字：找 `workboard.cards.<方法>`（gateway call）和 `workboard <create|move …>`（命令行），按文字匹配，不按程序名。
const METHOD_RE = /workboard\.cards\.([A-Za-z]+)(?:\.owner)?/g;
const CLI_RE = /(?:^|[\s'"/=])workboard\s+(create|move|dispatch|list|show)\b/g;

function stripQuotes(s) { return s.replace(/^['"]|['"]$/g, ''); }

// 取命令里 --params 后面的 JSON 文本；失败返回 { error }
function extractParams(command) {
  const m = /--params(?:\s+|=)/.exec(command);
  if (!m) return { missing: true };
  let rest = command.slice(m.index + m[0].length).trimStart();
  if (!rest) return { error: '--params 后面没有内容' };
  if (rest.startsWith('@') || rest.startsWith('-') || rest.startsWith('$') || rest.startsWith('`')) return { error: '--params 从文件、标准输入或命令替换读取，不接受' };
  const q = rest[0];
  let body;
  if (q === "'" || q === '"') {
    const end = rest.indexOf(q, 1);
    if (end < 0) return { error: '--params 引号没有闭合' };
    body = rest.slice(1, end);
    if (q === '"') body = body.replace(/\\"/g, '"');
  } else {
    body = rest.split(/\s+/)[0];
  }
  try { return { value: JSON.parse(body) }; } catch { return { error: '--params 不是合法 JSON' }; }
}

function judgeGatewayMethod(method, params) {
  const p = isObj(params) ? params : {};
  switch (method) {
    case 'complete': return block('gateway call workboard.cards.complete 一律不接受；' + NOT_ALLOWED_MSG);
    case 'release': case 'reassign': case 'reclaim': case 'move':
      return isDone(p.status) ? block(NOT_ALLOWED_MSG) : pass;
    case 'create': case 'captureSession':
      return createsDone(p) ? block(NOT_ALLOWED_MSG) : pass;
    case 'update': case 'bulk': {
      // 官方：有 patch 对象时看 patch，没有就把整个参数当补丁；这里两处都查。update/bulk 状态不是完成时官方会删 completedAt，单给 completedAt 做不出完成卡，所以只看状态字段。
      if (isDone(p.status) || (isObj(p.patch) && isDone(p.patch.status))) return block(NOT_ALLOWED_MSG);
      return pass;
    }
    case 'decompose':
      if (p.completeParent !== false) return block('拆分时不能顺带完成父卡：写 completeParent:false');
      if (Array.isArray(p.children) && p.children.some(createsDone)) return block('拆分出的子卡不能带完成状态');
      return pass;
    default:
      return pass; // list、dispatch、block、unblock、promote 等不产生完成
  }
}

// 审批只有主人本人能在 Discord 里点：bot 不能用命令行自己批。
// 一律挡 resolve 这类动作（含选拒绝）；`approvals pending` 这类只列出的照常。
const APPROVAL_RESOLVE_RES = [
  /(?:^|[\s'"/=;&|(])(?:exec-)?approvals?\s+(?:resolve|approve|allow|deny|reject)\b/i,
  /(?:plugin|exec)\.approval\.(?:resolve|approve|allow|deny|reject)\b/i,
  /\bapproval\.resolve\b/i,
  /\/approve\s+\S+\s+(?:allow-once|allow-always|deny)\b/i, // 用 openclaw message send 之类替主人发“/approve …”
];
export function isApproveChatText(text) { return /^\s*\/approve\b/i.test(String(text ?? '')) || /\/approve\s+\S+\s+(?:allow-once|allow-always|deny)\b/i.test(String(text ?? '')); }
export const APPROVAL_BLOCK_MSG = '审批只有主人本人能批，不能用命令行批（包括选拒绝）：到 Discord 的“审批”频道等他点；批准只放行那一下。';
// 比对前先把单双引号和反斜杠去掉（`openclaw 'approvals' 'resolve'`、`approv\als` 这类加引号、加转义的写法也认得）；
// 解析 --params 的 JSON 仍用原文。变量代词、脚本、编码后再执行、process 工具开 shell 这几种绕法按命令文字挡不住，写进交接“边界”，不硬挡。
const stripQuoteChars = (t) => String(t).replace(/['"\\]/g, '');
export function judgeCommandText(command) {
  const raw = String(command ?? '');
  const norm = stripQuoteChars(raw);
  if (APPROVAL_RESOLVE_RES.some((re) => re.test(raw) || re.test(norm))) return block(APPROVAL_BLOCK_MSG);
  if (!/workboard/.test(norm)) return pass;
  // 命令行：create／move 的 --status done 或 --status=done
  CLI_RE.lastIndex = 0;
  let m;
  while ((m = CLI_RE.exec(norm))) {
    const sub = m[1];
    if (sub !== 'create' && sub !== 'move') continue;
    const rest = norm.slice(m.index);
    const sm = /--status(?:\s+|=)(['"]?)([^\s'"]+)\1/.exec(rest);
    if (sm && isDone(sm[2])) return block(NOT_ALLOWED_MSG);
  }
  // gateway call
  METHOD_RE.lastIndex = 0;
  const seen = [];
  while ((m = METHOD_RE.exec(norm))) seen.push(m[1]);
  for (const method of seen) {
    if (method === 'complete') return block('gateway call workboard.cards.complete 一律不接受；' + NOT_ALLOWED_MSG);
    const risky = ['release', 'reassign', 'reclaim', 'move', 'create', 'captureSession', 'update', 'bulk', 'decompose'];
    if (!risky.includes(method)) continue;
    const r = extractParams(raw);
    if (r.missing) { if (method === 'decompose') return block('拆分时不能顺带完成父卡：写 completeParent:false'); continue; }
    if (r.error) return block(`${r.error}（${method}）；${NOT_ALLOWED_MSG}`);
    const v = judgeGatewayMethod(method, r.value);
    if (v.kind === 'block') return v;
  }
  return pass;
}

// ---------- 2. 账本和结案判断 ----------
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// 成果指纹：文件算内容；目录算“全部文件的清单＋各自指纹”；跟随链接；读不到 → 返回 { ok:false }
export function fingerprintPath(p, depth = 0) {
  try {
    if (!existsSync(p)) return { ok: false, reason: '路径不存在' };
    const st = statSync(p);
    if (st.isDirectory()) {
      if (depth > 6) return { ok: false, reason: '目录太深' };
      const entries = readdirSync(p).sort().filter((n) => n !== '.git' && n !== 'node_modules');
      const parts = [];
      for (const n of entries) {
        const r = fingerprintPath(join(p, n), depth + 1);
        if (!r.ok) return r;
        parts.push(`${n}\t${r.fingerprint}`);
      }
      return { ok: true, fingerprint: sha256(parts.join('\n')) };
    }
    return { ok: true, fingerprint: sha256(readFileSync(p)) };
  } catch (e) { return { ok: false, reason: String(e.message ?? e) }; }
}

export function fingerprintPaths(paths) {
  const out = {};
  for (const p of paths) {
    const r = fingerprintPath(p);
    if (!r.ok) return { ok: false, reason: `${p}：${r.reason}` };
    out[p] = r.fingerprint;
  }
  return { ok: true, map: out };
}

// 送审单识别：第一行“任务审计 <@100000000000000013> 请审：…（第 N 次）”，第二行“任务卡：…”（controller/AGENTS.md 现行模板）
export const REVIEWER_MENTION = `<@${botId('task-auditor')}>`;
export function parseSubmission(content) {
  const lines = String(content ?? '').replace(/\r\n/g, '\n').split('\n');
  const l1 = lines[0] ?? '';
  const l2 = lines[1] ?? '';
  // zh-CN keeps the exact old pattern; en allows spaces after the colon
  const SH = W.submissionHead;
  const m1 = new RegExp(`^${escapeRe(SH.pre)}${escapeRe(REVIEWER_MENTION)}${escapeRe(SH.mid.trimEnd())}\\s*.*${escapeRe(SH.roundOpen)}(\\d+)${escapeRe(SH.roundClose)}\\s*$`).exec(l1);
  const m2 = new RegExp(`^${escapeRe(W.submissionCard)}${EN ? ':\\s*' : '：'}(\\S+)`).exec(l2);
  if (!m1 || !m2) return null;
  // 成果位置：“成果位置：”之后到下一个“xxx：”标题行之前，一行一个绝对路径
  const paths = [];
  let inPaths = false;
  const unverifiable = [];
  for (const line of lines.slice(2)) {
    const h = new RegExp(`^([^\\s：:][^：:]{0,${EN ? 24 : 12}})[：:](.*)$`).exec(line);
    if (h && !line.startsWith('/') && !h[2].startsWith('//')) {
      inPaths = h[1] === W.submissionPaths;
      if (inPaths && h[2].trim()) { const t = h[2].trim(); (t.startsWith('/') ? paths : unverifiable).push(t); }
      continue;
    }
    if (inPaths && line.trim()) { const t = line.trim(); (t.startsWith('/') ? paths : unverifiable).push(t); }
  }
  return { cardId: m2[1], n: Number(m1[1]), paths, unverifiable };
}

// 报告第一行：我得：通过／不通过／审不了
export function parseVerdict(text) {
  const first = String(text ?? '').replace(/\r\n/g, '\n').split('\n').find((l) => l.trim() !== '') ?? '';
  const V = W.reportVerdictWord;
  const m = new RegExp(`^${escapeRe(W.reportLead)}${EN ? ':\\s*' : '：'}(${[V.pass, V.fail, V.cannot].map(escapeRe).join('|')})`).exec(first.trim());
  return m ? m[1] : null;
}

export class ClosingLedger {
  constructor(store = null) {
    this.store = store; // { load():obj, save(obj) }
    this.data = (store?.load?.()) ?? { submissions: {}, reports: {}, opus: {}, approvals: {}, releases: [] };
    for (const k of ['submissions', 'reports', 'opus', 'approvals']) this.data[k] ??= {};
    this.data.releases ??= [];
  }
  save() { this.store?.save?.(this.data); }
  // 登记送审。同一卡同一 N 出现第二次 → 两次都标“重复待核”
  recordSubmission({ cardId, n, threadId, messageId = null, paths = [], unverifiable = [], now = Date.now(), fingerprintMap = null }) {
    const list = (this.data.submissions[cardId] ??= []);
    const dup = list.find((s) => s.n === n);
    const entry = { cardId, n, threadId, messageId, paths, unverifiable, fingerprintMap, at: now, duplicate: false, unverifiableFlag: unverifiable.length > 0 || paths.length === 0 };
    if (dup) { dup.duplicate = true; entry.duplicate = true; }
    list.push(entry);
    this.save();
    return entry;
  }
  latestSubmission(cardId) {
    const list = this.data.submissions[cardId] ?? [];
    if (list.length === 0) return null;
    return [...list].sort((a, b) => b.n - a.n || b.at - a.at)[0];
  }
  setSubmissionMessageId(threadId, messageId) {
    for (const list of Object.values(this.data.submissions)) for (const s of list) if (s.threadId === threadId && !s.messageId) { s.messageId = messageId; this.save(); return s; }
    return null;
  }
  // 报告：按审计线程对应送审。parts：拆成几条，delivered：已送达几条
  recordReport({ threadId, author, verdict, partsTotal = 1, now = Date.now() }) {
    this.data.reports[threadId] = { threadId, author, verdict, partsTotal, partsDelivered: 0, at: now };
    this.save();
  }
  markPartDelivered(threadId) {
    const r = this.data.reports[threadId];
    if (!r) return null;
    r.partsDelivered = Math.min(r.partsTotal, r.partsDelivered + 1);
    this.save();
    return r;
  }
  reportFor(threadId) {
    const r = this.data.reports[threadId];
    if (!r) return null;
    return { ...r, delivered: r.partsDelivered >= r.partsTotal };
  }
  // Opus 补审绑定：派的时候绑 {卡号, N} 到 runId／childSessionKey；绑不上则记 unbound
  bindOpus({ cardId, n, runId, childSessionKey, now = Date.now() }) {
    const sub = (this.data.submissions[cardId] ?? []).filter((s) => s.n === n);
    const key = runId || childSessionKey || `unbound:${now}`;
    const ok = sub.length === 1 && !!runId && !!childSessionKey;
    this.data.opus[key] = { cardId, n, runId: runId ?? null, childSessionKey: childSessionKey ?? null, bound: ok, verdict: null, at: now, threadId: sub[0]?.threadId ?? null };
    this.save();
    return this.data.opus[key];
  }
  // 只认这个运行编号、这个子任务会话、角色 task-auditor、实际型号 Opus 的那一轮输出
  recordOpusReport({ runId, childSessionKey, agentId, modelId, text }) {
    const rec = Object.values(this.data.opus).find((o) => o.runId && o.runId === runId && o.childSessionKey === childSessionKey);
    if (!rec || !rec.bound) return null;
    if (agentId !== REVIEWER_AGENT || !/opus/i.test(String(modelId ?? ''))) return null;
    const v = parseVerdict(text);
    if (!v) return null;
    rec.verdict = v;
    rec.reportedAt = Date.now();
    this.save();
    return rec;
  }
  opusFor(cardId, n) {
    return Object.values(this.data.opus).filter((o) => o.cardId === cardId && o.n === n);
  }
  addRelease(entry) { this.data.releases.push(entry); this.save(); }
  grantApproval(cardId, submissionKey) { this.data.approvals[cardId] = submissionKey; this.save(); }
  approvalFor(cardId) { return this.data.approvals[cardId] ?? null; }
}

// 正文里的审计级别：zh-CN 认 【审计级别】／审计级别：／审计级别: 后面的几种写法，en 认 [Audit level]／Audit level: 后面的几种写法
const BODY_LEVEL_RE = new RegExp(`${escapeRe(W.auditLevelWord)}${tagCloseRe()}\\s*(${Object.keys(W.auditBodyToLabel).sort((a, b) => b.length - a.length).map(escapeRe).join('|')})`);
// 取卡上的审计标签：返回 { ok, value, reason }
export function readAuditLabel(card) {
  const labels = Array.isArray(card?.labels) ? card.labels : [];
  const hits = labels.filter((l) => typeof l === 'string' && l.startsWith(AUDIT_LABEL_PREFIX));
  if (hits.length === 0) return { ok: false, reason: '卡上没有审计标签' };
  if (hits.length > 1) return { ok: false, reason: '卡上有多个审计标签' };
  const value = hits[0].slice(AUDIT_LABEL_PREFIX.length);
  if (!AUDIT_LABEL_VALUES.includes(value)) return { ok: false, reason: `审计标签“${value}”不认识` };
  // 和卡正文写的审计级别不矛盾：正文里若有“审计级别：…”一行，值要对得上标签的大类
  const notes = String(card?.notes ?? card?.description ?? '');
  const m = BODY_LEVEL_RE.exec(notes);
  if (m) {
    const norm = W.auditBodyToLabel[m[1]] ?? null; // explicit map (no bracket stripping)
    if (norm && norm !== value) return { ok: false, reason: `审计标签“${value}”和卡正文写的审计级别“${norm}”矛盾` };
  }
  return { ok: true, value };
}

// 结案判断。顺序：①标签 ②最近一次送审 ③“不通过”→挡、不给本人批准 ④有效通过 ⑤指纹 ⑥本人批准三种情况
// 返回 { allow:true, via } | { allow:false, reason } | { approval:true, reason, title, description }
export function decideClosing({ ledger, cardId, card, fingerprintFn = fingerprintPaths, workerRun = false }) {
  const tail = workerRun ? `；${WORKER_HINT}` : '';
  const need = (reason) => ({ allow: false, reason: `${reason}${tail}` });
  const lab = readAuditLabel(card);
  if (!lab.ok) return need(`卡上审计标签缺失或不对（${lab.reason}），交总控补正`);
  const sub = ledger.latestSubmission(cardId);
  if (!sub) return need('还没有送审记录：先送审（总控开审计线程），通过后再完成');
  const approvalCase = [];
  if (sub.duplicate) approvalCase.push(N.closing.reasons.duplicate);
  if (sub.unverifiableFlag) approvalCase.push(N.closing.reasons.unverifiable);
  const report = ledger.reportFor(sub.threadId);
  const opus = ledger.opusFor(cardId, sub.n);
  const boundOpus = opus.filter((o) => o.bound);
  if (opus.some((o) => !o.bound)) approvalCase.push(N.closing.reasons.unbound);
  // ③ 已送达的“不通过”（任务审计的，或绑定成立的 Opus 补审）→ 挡，不给本人批准
  if (report?.delivered && report.verdict === W.reportVerdictWord.fail) return need('这次送审的审计报告是“不通过”，要返工后重新送审；本人批准也不能覆盖');
  if (boundOpus.some((o) => o.verdict === W.reportVerdictWord.fail)) return need('这次送审的 Opus 补审是“不通过”，要返工后重新送审；本人批准也不能覆盖');
  // ④ 有效通过
  const passed = (report?.delivered && report.verdict === W.reportVerdictWord.pass) || boundOpus.some((o) => o.verdict === W.reportVerdictWord.pass);
  if (passed && !sub.unverifiableFlag) {
    // ⑤ 成果指纹：重算和送审时记的一致才放行；不一致挡（不给本人批准）
    const fp = fingerprintFn(sub.paths);
    if (!fp.ok) return need(`成果指纹重算失败（${fp.reason}），不放行`);
    const base = sub.fingerprintMap ?? {};
    const same = sub.paths.length > 0 && sub.paths.every((p) => base[p] !== undefined && base[p] === fp.map[p]);
    if (!same) return need('成果在送审后改过，要重新送审');
    if (approvalCase.length === 0) {
      return { allow: true, via: `${report?.delivered && report.verdict === W.reportVerdictWord.pass ? '任务审计单审通过' : 'Opus 补审通过'}（十一.7 临时安排；审计标签 ${lab.value}）`, submissionKey: `${cardId}#${sub.n}` };
    }
  }
  // ⑥ 只有属于“成果无法核对／送审重复待核／补审绑定核不了”之一，才走本人批准；其余没有有效通过的一律挡
  if (approvalCase.length > 0) return approveCase(ledger, sub, cardId, approvalCase);
  if (report?.delivered && report.verdict === W.reportVerdictWord.cannot) return need('任务审计写了“审不了”：要核实是模型拒审后，由总控派绑定本次送审的 Opus 补审');
  return need('还没有通过的审计报告');
}

function approveCase(ledger, sub, cardId, reasons) {
  const key = `${cardId}#${sub.n}`;
  if (ledger.approvalFor(cardId) === key) return { allow: true, via: `本人批准（${reasons.join('、')}）`, submissionKey: key };
  return {
    approval: true,
    reason: reasons.join('、'),
    title: N.closing.title,
    description: N.closing.description(cardId, sub.n, reasons.join(N.closing.jn)),
    submissionKey: key,
  };
}

// ---------- 3. 钩子登记 ----------
// opts: { ledgerPath, logDir, getCard(cardId)->card|null, roleOf(ctx), isWorkerRun(ctx) }
export function createFileStore(path) {
  return {
    load() { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } },
    save(obj) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

export const GUILD_ID = crew.guildId; // 私人工作台服务器
export function threadLinkOf(sessionKey) {
  const m = /:(?:channel|thread):(\d{5,})\b/.exec(String(sessionKey ?? ''));
  return m ? `https://discord.com/channels/${GUILD_ID}/${m[1]}` : N.closing.sessionFallback(sessionKey ?? W.unknownWord);
}

export function registerAuditGate(api, opts = {}) {
  const ledger = new ClosingLedger(opts.ledgerPath ? createFileStore(opts.ledgerPath) : null);
  const log = (row) => { try { opts.log?.(row); } catch { /* 记录失败不影响判断 */ } };
  const getCard = opts.getCard ?? (() => null);
  try { opts.completion?.bind?.({ getCard, log }); } catch { /* 只是接线 */ }

  api.on('before_tool_call', async (event, ctx) => {
    const tool = normTool(event?.toolName);
    // exec（含原生 Bash）：所有 bot 按命令文字判
    if (tool === 'exec' || tool === 'Bash') {
      const cmd = event?.params?.command ?? event?.params?.cmd ?? '';
      const v = judgeCommandText(cmd);
      if (v.kind === 'block') { log({ 结果: '挡', 工具: 'exec', 原因: v.reason, 角色: ctx?.agentId, 内容: String(cmd).slice(0, 300) }); return { block: true, blockReason: v.reason }; }
      return undefined;
    }
    // message 工具发的文字是“/approve …”：bot 不能替主人批（审批卡现在只在“审批”频道，以文字回复批；主人名单里有 bot 的编号，所以这里也挡）
    if (tool === 'message') {
      const txt = event?.params?.message ?? event?.params?.content ?? event?.params?.text ?? event?.params?.body ?? '';
      if (isApproveChatText(txt)) { log({ 结果: '挡', 工具: 'message', 原因: '/approve 文字', 角色: ctx?.agentId, 内容: String(txt).slice(0, 120) }); return { block: true, blockReason: APPROVAL_BLOCK_MSG }; }
      return undefined;
    }
    if (!tool || !tool.startsWith('workboard_')) return undefined;
    const workerRun = !!(opts.isWorkerRun?.(ctx));
    const v = judgeToolParams(tool, event.params, { workerRun });
    if (v.kind === 'block') { log({ 结果: '挡', 工具: tool, 原因: v.reason, 角色: ctx?.agentId, 卡: event.params?.id ?? null, 时刻: new Date().toISOString() }); return { block: true, blockReason: v.reason }; }
    if (v.kind !== 'closing') return undefined;
    const cardId = event.params?.id;
    const card = cardId ? await getCard(cardId) : null;
    const d = decideClosing({ ledger, cardId, card: card ?? {}, workerRun });
    if (d.allow) { ledger.addRelease({ cardId, via: d.via, at: new Date().toISOString(), tool, agent: ctx?.agentId }); log({ 结果: '放行', 工具: tool, 卡: cardId, 依据: d.via }); try { opts.completion?.arm(event.toolCallId, { cardId, agentId: ctx?.agentId, sessionKey: ctx?.sessionKey, runId: ctx?.runId ?? event?.runId }); } catch { /* 只是登记 */ } return undefined; }
    if (d.approval) {
      log({ 结果: '请本人批', 工具: tool, 卡: cardId, 原因: d.reason });
// 点了“允许”后工具会用同一个 toolCallId 真执行；成功了才发完成记录（被拒／过期时 after_tool_call 带错误，不发）
      try { opts.completion?.arm(event.toolCallId, { cardId, agentId: ctx?.agentId, sessionKey: ctx?.sessionKey, runId: ctx?.runId ?? event?.runId }); } catch { /* 只是登记 */ }
      // 说明在程序里先换掉会被官方清理放大的字符、再截到 480 码点以内（官方清理后超 512 会整张拒掉）；先截卡名、再截具体事由，“申请的 bot”“任务卡号”“原线程”“批准只放行…”始终保留。
      const approvalDescription = composeApprovalDescription([
        { kind: 'var', order: 1, min: 30, text: String(d.description ?? '') },
        { kind: 'keep', text: N.closing.botLine(ctx?.agentId ?? W.unknownWord, cardId) },
        ...(card?.title ? [{ kind: 'var', order: 0, min: 8, text: W.notices.titleQuote(card.title), cut: (text, room) => `${TQ_PRE}${cutCodePoints(text.slice(TQ_PRE.length, text.length - TQ_POST.length), Math.max(1, room - TQ_PRE.length - TQ_POST.length - 1))}${TQ_POST}` }] : []),
        { kind: 'keep', text: N.closing.threadLine(threadLinkOf(ctx?.sessionKey)) },
      ]);
// 同一张任务卡又出了新的审批卡（重新申请）→ 把还没处理的“审批过期”条目改已定。失败不影响卡。
      try { Promise.resolve(opts.approvalLedger?.reissued?.({ kind: W.ledgerKinds.closing, cardId })).catch(() => {}); } catch { /* 只是记录 */ }
      // 每出一张卡，异步用总控账号往“审批”频道另发一条点名主人的短消息；发失败只记日志，不影响卡。
      try { notifyApprovalCard({ dedupKey: `closing:${cardId}:${d.submissionKey ?? ''}`, what: d.description, cardId, source: N.closing.source, send: opts.sendApprovalNotice, dedupPath: opts.dedupPath ?? null, log: (row) => log({ 结果: '审批卡另发提醒', 事件: row.event, 卡: cardId, 详情: row.detail ?? row.error ?? row.why ?? null }) }); } catch { /* 另发提醒失败不影响卡 */ }
      return { requireApproval: { title: cutCodePoints(String(d.title ?? ''), APPROVAL_TITLE_MAX), description: approvalDescription, severity: 'warning', allowedDecisions: ['allow-once', 'deny'], timeoutMs: 600000, timeoutReason: N.closing.timeoutReason, pluginId: 'personal-inbox', onResolution: (decision) => { if (decision === 'allow-once' || decision?.decision === 'allow-once') { ledger.grantApproval(cardId, d.submissionKey); ledger.addRelease({ cardId, via: '本人批准（审批卡点了允许一次）', at: new Date().toISOString(), tool, agent: ctx?.agentId }); log({ 结果: '本人批准放行', 工具: tool, 卡: cardId, 角色: ctx?.agentId }); return; }
// 卡过期（timeout）或被取消（cancelled）不算拒绝——登记进“等你定”留 24 小时；他明确点“拒绝”（deny）不登记。失败只记日志，不影响结案关口。
        const dec = typeof decision === 'string' ? decision : decision?.decision;
        if (dec === 'deny') { log({ 结果: '审批卡被拒绝', 工具: tool, 卡: cardId, 角色: ctx?.agentId }); return; }
        try {
          Promise.resolve(opts.approvalLedger?.expired?.({ kind: W.ledgerKinds.closing, what: d.description ?? null, cardId, threadId: (/(\d{5,})$/.exec(String(ctx?.sessionKey ?? '')) ?? [])[1] ?? null, link: threadLinkOf(ctx?.sessionKey) ?? null, expiredAt: Date.now() }))
            .then(() => log({ 结果: '审批卡过期转等你定', 工具: tool, 卡: cardId, 原因: dec ?? '无决定', 角色: ctx?.agentId }), (e) => log({ 结果: '审批过期登记失败', 卡: cardId, 原因: String(e?.message ?? e).slice(0, 200) }));
        } catch (e) { log({ 结果: '审批过期登记失败', 卡: cardId, 原因: String(e?.message ?? e).slice(0, 200) }); }
      } } };
    }
    log({ 结果: '挡', 工具: tool, 卡: cardId, 原因: d.reason, 角色: ctx?.agentId, 时刻: new Date().toISOString() });
    return { block: true, blockReason: d.reason };
  }, { registrationId: 'audit-gate-before-tool' });

  // ----- 记账钩子：送审、报告、Opus 补审绑定。全部失败不影响正常发消息（只记一行）。-----
  const agentOfSession = (key) => /^agent:([^:]+):/.exec(String(key ?? ''))?.[1] ?? null;
  const threadOf = (event) => (event?.threadId != null ? String(event.threadId) : (/(\d{5,})$/.exec(String(event?.to ?? ''))?.[1] ?? null));
  const pendingSends = []; // 等 message_sent 补消息编号的送审／报告片段

  api.on('message_sending', async (event, ctx) => {
    try {
      const agent = agentOfSession(ctx?.sessionKey);
      const content = String(event?.content ?? '');
      if (agent === 'main') {
        const sub = parseSubmission(content);
        if (sub) {
          const threadId = threadOf(event);
          const fp = sub.paths.length ? fingerprintPaths(sub.paths) : { ok: true, map: {} };
          const entry = ledger.recordSubmission({ cardId: sub.cardId, n: sub.n, threadId, paths: sub.paths, unverifiable: fp.ok ? sub.unverifiable : [...sub.unverifiable, ...sub.paths], fingerprintMap: fp.ok ? fp.map : null });
          if (!fp.ok) { entry.unverifiableFlag = true; ledger.save(); }
          pendingSends.push({ kind: 'submission', content, entry });
          log({ 结果: '记送审', 卡: sub.cardId, 第几次: sub.n, 线程: threadId, 成果数: sub.paths.length, 无法核对: entry.unverifiableFlag });
        }
      } else if (agent === REVIEWER_AGENT) {
        const threadId = threadOf(event);
        const verdict = parseVerdict(content);
        if (verdict && threadId) {
          ledger.recordReport({ threadId, author: agent, verdict, partsTotal: 1 });
          pendingSends.push({ kind: 'report', content, threadId, runId: ctx?.runId });
          log({ 结果: '记报告草稿', 线程: threadId, 结论: verdict });
        } else if (threadId && ledger.data.reports[threadId] && ctx?.runId && pendingSends.some((x) => x.kind === 'report' && x.threadId === threadId && x.runId === ctx.runId)) {
          ledger.data.reports[threadId].partsTotal += 1; ledger.save(); // 同一轮拆条的后续片段
          pendingSends.push({ kind: 'report', content, threadId, runId: ctx.runId });
        }
      }
    } catch (e) { log({ 结果: '记账失败', 钩子: 'message_sending', 原因: String(e.message ?? e) }); }
    return undefined;
  }, { registrationId: 'audit-gate-message-sending' });

  api.on('message_sent', async (event) => {
    try {
      if (!event?.success) return;
      const k = pendingSends.findIndex((x) => x.content === event.content);
      if (k < 0) return;
      const item = pendingSends.splice(k, 1)[0];
      if (item.kind === 'submission') {
        if (!item.entry.messageId) item.entry.messageId = event.messageId ?? null;
        if (!item.entry.threadId && event.messageId) item.entry.threadId = String(event.messageId); // 首帖发出后，线程编号＝首帖消息编号（Discord 无起始消息的线程）
        ledger.save();
      } else if (item.kind === 'report') {
        ledger.markPartDelivered(item.threadId);
        log({ 结果: '报告片段已送达', 线程: item.threadId });
      }
    } catch (e) { log({ 结果: '记账失败', 钩子: 'message_sent', 原因: String(e.message ?? e) }); }
  }, { registrationId: 'audit-gate-message-sent' });

  // Opus 补审：派的时候先核派活消息前两行对上一条已记的送审；返回后从回执取 runId 和 childSessionKey 绑定
  const pendingSpawn = new Map();
  api.on('before_tool_call', async (event, ctx) => {
    try {
      if (normTool(event?.toolName) !== 'sessions_spawn' || agentOfSession(ctx?.sessionKey) !== 'main') return undefined;
      const msg = event?.params?.message ?? event?.params?.task ?? '';
      const sub = parseSubmission(String(msg));
      if (sub && event?.toolCallId) pendingSpawn.set(event.toolCallId, sub);
    } catch { /* 忽略 */ }
    return undefined;
  }, { registrationId: 'audit-gate-spawn-before' });
// 结案工具真执行完且没有报错 → 发完成记录（登记过的调用才会发）
  // 不等它：算频道和发消息要起命令行，Gateway 忙时要几十秒，不能拖住结案工具这一轮（钩子本身只有十几秒）。settle 里面自己吞错。
  api.on('after_tool_call', (event) => {
    try { void Promise.resolve(opts.completion?.settle(event)).catch((e) => log({ 结果: '完成记录出错', 原因: String(e?.message ?? e).slice(0, 200) })); } catch (e) { log({ 结果: '完成记录出错', 原因: String(e?.message ?? e).slice(0, 200) }); }
    return undefined;
  }, { registrationId: 'audit-gate-completion-notice' });
  api.on('after_tool_call', async (event) => {
    try {
      if (normTool(event?.toolName) !== 'sessions_spawn') return;
      const sub = pendingSpawn.get(event.toolCallId);
      if (!sub) return;
      pendingSpawn.delete(event.toolCallId);
      const r = typeof event.result === 'string' ? safeJson(event.result) : (event.result?.details ?? event.result);
      const rec = ledger.bindOpus({ cardId: sub.cardId, n: sub.n, runId: r?.runId, childSessionKey: r?.childSessionKey });
      log({ 结果: '记补审绑定', 卡: sub.cardId, 第几次: sub.n, 绑定成立: rec.bound });
    } catch (e) { log({ 结果: '记账失败', 钩子: 'after_tool_call', 原因: String(e.message ?? e) }); }
  }, { registrationId: 'audit-gate-spawn-after' });
  // 总控用 message 工具的 thread-create 开审计线程：首帖不经过 message_sending，
  // 所以派的时候认前两行，回执里取线程编号（thread.id）和首帖消息编号（initialMessageDelivery.deliveredMessageIds[0]）记送审。
  const pendingThread = new Map();
  const isThreadCreate = (action) => /^thread[-_ ]?create$/i.test(String(action ?? '').trim());
  const unwrapResult = (result) => {
    let r = typeof result === 'string' ? safeJson(result) : (result?.details ?? result);
    const text = r?.content?.[0]?.text;
    if (r && !r.thread && typeof text === 'string') r = safeJson(text) ?? r;
    return r;
  };
  api.on('before_tool_call', async (event, ctx) => {
    try {
      if (normTool(event?.toolName) !== 'message' || agentOfSession(ctx?.sessionKey) !== 'main' || !isThreadCreate(event?.params?.action)) return undefined;
      const sub = parseSubmission(String(event?.params?.message ?? event?.params?.content ?? ''));
      if (sub && event?.toolCallId) pendingThread.set(event.toolCallId, sub);
    } catch { /* 忽略 */ }
    return undefined;
  }, { registrationId: 'audit-gate-thread-before' });
  api.on('after_tool_call', async (event) => {
    try {
      const sub = pendingThread.get(event?.toolCallId);
      if (!sub) return;
      pendingThread.delete(event.toolCallId);
      const r = unwrapResult(event?.result);
      const threadId = r?.thread?.id ?? r?.threadId ?? null;
      if (!threadId) { log({ 结果: '记账失败', 钩子: 'thread-create', 原因: '回执里没有线程编号', 卡: sub.cardId }); return; }
      const fp = sub.paths.length ? fingerprintPaths(sub.paths) : { ok: true, map: {} };
      const entry = ledger.recordSubmission({ cardId: sub.cardId, n: sub.n, threadId: String(threadId), messageId: r?.initialMessageDelivery?.deliveredMessageIds?.[0] ?? null, paths: sub.paths, unverifiable: fp.ok ? sub.unverifiable : [...sub.unverifiable, ...sub.paths], fingerprintMap: fp.ok ? fp.map : null });
      if (!fp.ok) { entry.unverifiableFlag = true; ledger.save(); }
      log({ 结果: '记送审', 卡: sub.cardId, 第几次: sub.n, 线程: String(threadId), 成果数: sub.paths.length, 无法核对: entry.unverifiableFlag, 路径: 'thread-create' });
    } catch (e) { log({ 结果: '记账失败', 钩子: 'thread-create', 原因: String(e.message ?? e) }); }
  }, { registrationId: 'audit-gate-thread-after' });
  api.on('agent_end', async (event, ctx) => {
    try {
      if (ctx?.agentId !== REVIEWER_AGENT) return;
      const text = lastAssistantText(event?.messages);
      const rec = ledger.recordOpusReport({ runId: event?.runId ?? ctx?.runId, childSessionKey: ctx?.sessionKey, agentId: ctx?.agentId, modelId: ctx?.modelId, text });
      if (rec) log({ 结果: '记补审结论', 卡: rec.cardId, 结论: rec.verdict });
    } catch (e) { log({ 结果: '记账失败', 钩子: 'agent_end', 原因: String(e.message ?? e) }); }
  }, { registrationId: 'audit-gate-agent-end' });

  return { ledger };
}

// 官方在不同路径上给的工具名可能带 mcp__openclaw__ 前缀（守门记录里就是这样），统一去掉再判
function normTool(name) { return String(name ?? '').replace(/^mcp__openclaw__/, ''); }

function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }

// 取最后一条助手消息的文字（消息结构官方标 unknown：字符串或 [{type:'text',text}] 两种都认）
export function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.filter((x) => x?.type === 'text').map((x) => x.text).join('\n');
  }
  return '';
}
