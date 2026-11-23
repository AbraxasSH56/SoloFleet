#!/usr/bin/env node
// Daily format check: task-record status lines, pending requests written to records, card labels, mention counts per thread. No model calls.
// 日审的“格式抽查＋转手数数”固定脚本。不调模型、不发任何消息、不写异常标记。
// 做什么：把日审指令第 7 步里“查格式、数条数”的机械活做完，写成 <资料根>/审计/日审/<业务日期>-格式抽查.md，日审开工时只读这个文件。
//   F1 任务记录：有没有“状态：”一行、开头是不是 完成／进行中／没跑成／等主人／卡住 之一；旧记录（OLD_RECORD_BEFORE_MS 之前建的，默认不设）只计数。
//   F2 状态写了“等主人”，“等主人拍板”一节却空着或只写“无”。
//   F3 任务卡：有没有 审计:… 标签、【审计级别】一行、【授权范围】块和四行；升降级的卡有没有留改动记录和确认。
//   F4 决定账本：每条有没有日期和“原话：”（自上一轮以来文件没改过就不查）。
//   H1 转手条数：每条线程里“bot 点名另一个 bot”的消息有几条；8 条以上标“交日审判断”。
// 谁来启动：白天看护（day-watch.mjs）在本地时区 17:30～18:04 之间那一遍，用脱钩的子进程起它，看护自己照旧立刻退出。
// 保护：单条 openclaw 命令 15 秒，读 Discord 总共 45 秒，整个脚本 90 秒（到点强制结束）；一次只跑一份（锁文件）。
// 读不到的一律写“未能检查：…（原因）”，不写成“没有”。
import { localDate, localDateTime, localToMs } from '../../plugins/personal-inbox/tz.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync, statSync, openSync, closeSync, appendFileSync } from 'node:fs';

import { crew } from '../../plugins/personal-inbox/crew-config.mjs';
import { lexicon, labelText, labelRe, tagText, escapeRe } from '../../plugins/personal-inbox/lexicon.mjs';
const W = lexicon();
const F = W.fc; // texts of the report this file writes (zh-CN: the Chinese report the daily audit always read) // words follow config "locale" (zh-CN: the literals this script always matched)
const execFileAsync = promisify(execFile);

export const DATA_ROOT = process.env.OPENCLAW_DATA_ROOT || crew.paths.dataRoot; // env var first (offline tests), then config
export const GUILD_ID = crew.guildId;
export const CHAT_CHANNEL = crew.channels.lounge; // 闲聊茶会：主频道和它下面的线程都不查
export const CUT_H = 18, CUT_M = 5; // 日审原定时间 18:05（本地时间，按配置时区）
export const OLD_RECORD_BEFORE_MS = 0; // optional cut-off (epoch ms): task records created before it are only counted, not checked; 0 = check every record
export const LIMITS = { cmdMs: 15000, discordMs: 45000, totalMs: 90000, maxPages: 6, maxThreads: 60, handoffAt: 8, lockStaleMs: 10 * 60 * 1000 };
export const STATUS_HEADS = W.statusHeads;
const pad = (n) => String(n).padStart(2, '0');
export const localStamp = (ms) => localDateTime(ms);
export const bizDateOf = (ms) => localDate(ms);

// ---------- 窗口 ----------
// 业务日期＝现在这一天的本地时区日期（脚本在 17:30～18:04 之间跑，18:05 还没到；不能像命令抽查脚本那样“18:05 前退成昨天”）。
export function windowOf(nowMs, dataRoot) {
  const bizDate = bizDateOf(nowMs);
  const cutMs = localToMs(bizDate, CUT_H, CUT_M);
  return { bizDate, cutMs, startMs: pickStart(nowMs, dataRoot, cutMs), endMs: Math.min(nowMs, cutMs) };
}
function pickStart(nowMs, dataRoot, cutMs) {
  const rounds = [];
  try {
    const dir = join(dataRoot, W.layout.audit, W.layout.auditDaily);
    for (const f of readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        const t = Date.parse(j[W.auditRecordKeys.cutoff]);
        if (j[W.auditRecordKeys.execution] === W.auditRecordValues.done && !Number.isNaN(t) && t < cutMs) rounds.push(t);
      } catch { /* 读不懂的跳过 */ }
    }
  } catch { /* 目录不在 */ }
  return rounds.length ? Math.max(...rounds) : cutMs - 86400000;
}

// ---------- F1／F2 任务记录 ----------
const sectionOf = (text, headRe) => {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => headRe.test(l));
  if (i < 0) return null;
  let j = lines.length;
  for (let k = i + 1; k < lines.length; k++) if (/^##\s/.test(lines[k])) { j = k; break; }
  return lines.slice(i + 1, j).join('\n');
};
export function checkTaskRecord(text) {
  const issues = [];
  let waiting = false;
  const st = sectionOf(text, new RegExp(`^##\\s*${escapeRe(W.sectionCurrentStatus)}`));
  if (st === null) issues.push(F.noSection(W.sectionCurrentStatus));
  else {
    const m = new RegExp(`^${labelRe(W.statusLabel)}(.*)$`, 'm').exec(st);
    if (!m) issues.push(F.noLine(labelText(W.statusLabel)));
    else {
      const rest = m[1].trim();
      if (rest.startsWith('<')) issues.push(F.stillTemplate(labelText(W.statusLabel)));
      else if (!STATUS_HEADS.some((h) => rest.startsWith(h))) issues.push(F.badHead(labelText(W.statusLabel), STATUS_HEADS.join(F.slash), rest.slice(0, 12)));
      else waiting = rest.startsWith(W.statusHeads[3]);
    }
  }
  if (waiting) {
    const dec = sectionOf(text, new RegExp(`^##\\s*${escapeRe(W.sectionWaitingForOwner)}`));
    if (dec === null) issues.push(F.waitNoSection(W.statusHeads[3], W.sectionWaitingForOwner));
    else {
      const body = dec.replace(/<[^>]*>/g, '').trim();
      if (body === '' || new RegExp(`^${escapeRe(W.noneWord)}[。.]?$`, 'i').test(body)) issues.push(F.waitEmpty(W.statusHeads[3], W.sectionWaitingForOwner, W.noneWord));
    }
  }
  return issues;
}
export function scanTaskRecords(dataRoot, startMs, endMs, notes, oldBefore = OLD_RECORD_BEFORE_MS) {
  const out = { checked: [], oldCount: 0, bad: [] };
  const projDir = join(dataRoot, W.layout.projects);
  let projects = [];
  try { projects = readdirSync(projDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')); } catch (e) { notes.push(F.cannotCheck(F.wRecords, F.whyRecordsDir(W.layout.projects, e.code ?? e.message))); return out; }
  for (const p of projects) {
    const tdir = join(projDir, p.name, W.layout.tasks);
    let files = [];
    try { files = readdirSync(tdir).filter((f) => f.endsWith('.md') && !f.startsWith('.')); } catch { continue; }
    for (const f of files) {
      const full = join(tdir, f);
      try {
        const s = statSync(full);
        if (s.mtimeMs < startMs || s.mtimeMs > endMs) continue;
        const rel = relative(dataRoot, full);
        if (s.birthtimeMs < oldBefore) { out.oldCount++; continue; }
        const issues = checkTaskRecord(readFileSync(full, 'utf8'));
        out.checked.push({ file: rel, result: issues.length ? issues.join(F.semi) : F.ok });
        if (issues.length) out.bad.push({ file: rel, issues });
      } catch (e) { notes.push(F.cannotCheck(join(p.name, W.layout.tasks, f), e.code ?? e.message)); }
    }
  }
  return out;
}

// ---------- F4 决定账本 ----------
export function checkLedgerText(text) {
  const bad = [];
  const blocks = text.split(/\n(?=###\s)/).filter((b) => /^###\s*[DS]-\d+/.test(b));
  for (const b of blocks) {
    const id = /^###\s*([DS]-\d+)/.exec(b)[1];
    const miss = [];
    if (!new RegExp(`${labelRe(W.ledgerDateLabel, '[ \\t]*')}\\S`).test(b)) miss.push(W.ledgerDateLabel);
    const m = new RegExp(`${labelRe(W.ledgerQuoteLabel, '[ \\t]*')}(\\S[^\\n]*)?`).exec(b);
    if (!m || !m[1] || !m[1].trim()) miss.push(labelText(W.ledgerQuoteLabel));
    if (miss.length) bad.push({ id, miss });
  }
  return { total: blocks.length, bad };
}
export function scanLedger(dataRoot, startMs, notes) {
  const p = join(dataRoot, W.layout.ledgerFile);
  try {
    const s = statSync(p);
    if (s.mtimeMs < startMs) return { skipped: true };
    return { skipped: false, ...checkLedgerText(readFileSync(p, 'utf8')) };
  } catch (e) { notes.push(F.cannotCheck(F.wLedger, e.code ?? e.message)); return { skipped: true, unreadable: true }; }
}

// ---------- F3 任务卡 ----------
const ROLE_LINES = W.authorizationLines.map((n) => [n, new RegExp(`(^|\\n)\\s*[-*]?\\s*${labelRe(n, '')}`)]);
const CONFIRM_RE = new RegExp(`${escapeRe(W.ownerWord)}[^\\n]{0,24}(${W.confirmWords.map(escapeRe).join('|')})`, 'i');
const CHANGE_RE = new RegExp(`${labelRe(W.auditLevelWord, '')}[^\\n]*→`);
const AUDIT_LABEL_RE = new RegExp(`^${labelRe(W.auditLabelPrefix.slice(0, -1), '')}`); // zh-CN: ^审计[:：]
const LEVEL_TAG = tagText(W.auditLevelWord);
const AUTH_TAG = tagText(W.authorizationWord);
export function auditLabelOf(card) { return (card.labels ?? []).find((l) => AUDIT_LABEL_RE.test(l)) ?? ''; }
export function levelLineOf(card) { const first = String(card.notes ?? '').split('\n').find((l) => l.trim()) ?? ''; return first.startsWith(LEVEL_TAG) ? first.trim() : ''; }
export function checkCard(card, { startMs, snapshotAt, snapshot }) {
  const miss = [];
  const notes = String(card.notes ?? '');
  if (!auditLabelOf(card)) miss.push(F.cardNoLabel(W.auditLabelPrefix));
  if (!levelLineOf(card)) miss.push(F.cardNoLevel(LEVEL_TAG));
  if (!notes.includes(AUTH_TAG)) miss.push(F.cardNoAuth(AUTH_TAG));
  else {
    const lacking = ROLE_LINES.filter(([, re]) => !re.test(notes)).map(([n]) => n);
    if (lacking.length) miss.push(F.cardAuthLacking(AUTH_TAG, lacking.join(F.jn)));
  }
  // 升降级：评论里的改动记录要有确认；标签和快照对不上却没留记录
  const cs = [...(card.comments ?? [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  cs.forEach((c, i) => {
    if (!CHANGE_RE.test(c.body ?? '') || (c.created_at ?? 0) < startMs) return;
    const near = [cs[i - 1], c, cs[i + 1]].filter(Boolean).map((x) => x.body ?? '').join('\n');
    if (!CONFIRM_RE.test(near)) miss.push(F.cardNoConfirm(labelText(W.auditLevelWord), W.ownerWord, W.confirmWords.join(F.slash)));
  });
  const old = snapshot?.[card.id];
  if (old && (old.audit !== auditLabelOf(card) || old.level !== levelLineOf(card))) {
    const recorded = cs.some((c) => CHANGE_RE.test(c.body ?? '') && (c.created_at ?? 0) >= (snapshotAt ?? 0));
    if (!recorded) { const parts = []; if (old.audit !== auditLabelOf(card)) parts.push(F.partLabel(old.audit || F.noneShort, auditLabelOf(card) || F.noneShort)); if (old.level !== levelLineOf(card)) parts.push(F.partLevel(LEVEL_TAG, (old.level || F.noneShort).slice(0, 30), (levelLineOf(card) || F.noneShort).slice(0, 30))); miss.push(F.cardChangedMsg(parts.join(F.semi))); }
  }
  return miss;
}

// ---------- H1 转手条数 ----------
export const snowflakeMs = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);
export function countHandoffs(messages, botIds) {
  let n = 0; const unknownBots = new Set();
  for (const m of messages) {
    const a = String(m?.author?.id ?? '');
    if (!botIds.has(a)) { if (m?.author?.bot && a) unknownBots.add(a); continue; }
    const ids = new Set([...String(m.content ?? '').matchAll(/<@!?(\d+)>/g)].map((x) => x[1]));
    if ([...ids].some((i) => i !== a && botIds.has(i))) n++;
  }
  return { n, unknownBots: [...unknownBots] };
}

// ---------- 真实依赖 ----------
export function realDeps(env = process.env) {
  const bin = env.OPENCLAW_BIN || crew.paths.openclawBin;
  const json = (out) => JSON.parse(out.slice(out.indexOf('{')));
  const runOC = async (args, timeout) => {
    const { stdout } = await execFileAsync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, env: { ...env, NODE_NO_WARNINGS: '1', PATH: `${dirname(process.execPath)}:${env.PATH ?? '/usr/bin:/bin'}` } }); // openclaw 命令行要用 node：把当前 node 所在目录放进 PATH
    return json(stdout);
  };
  const acct = ['--channel', 'discord', '--account', 'default'];
  return {
    now: () => Date.now(),
    async listThreads(timeout) { const d = await runOC(['message', 'thread', 'list', ...acct, '--guild-id', GUILD_ID, '--json'], timeout); const list = d.payload?.threads?.threads ?? []; list.hasMore = Boolean(d.payload?.threads?.has_more ?? d.payload?.hasMore); return list; },
    async readMessages(threadId, before, timeout) {
      const args = ['message', 'read', ...acct, '--target', `channel:${threadId}`, '--limit', '100', '--json'];
      if (before) args.push('--before', String(before));
      const d = await runOC(args, timeout); return d.payload?.messages ?? [];
    },
    async readCards(sinceMs) {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(env.OPENCLAW_WORKBOARD_DB || `${homedir()}/.openclaw/plugins/workboard/workboard.sqlite`, { readOnly: true });
      try {
        const rows = db.prepare('SELECT id, title, notes, status, created_at, updated_at FROM workboard_cards WHERE archived_at IS NULL').all();
        const lab = db.prepare('SELECT label FROM workboard_card_labels WHERE card_id = ? ORDER BY ordinal');
        const com = db.prepare('SELECT ordinal, body, created_at FROM workboard_card_comments WHERE card_id = ? ORDER BY ordinal');
        return rows.map((r) => ({ id: r.id, title: r.title, notes: r.notes ?? '', status: r.status, created_at: r.created_at, updated_at: r.updated_at, labels: lab.all(r.id).map((x) => x.label), comments: com.all(r.id).map((x) => ({ ordinal: x.ordinal, body: x.body, created_at: x.created_at })) }));
      } finally { db.close(); }
    },
  };
}

// ---------- 主流程 ----------
const jread = (p, fb = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fb; } };
function atomicWrite(path, text) { mkdirSync(join(path, '..'), { recursive: true }); const t = `${path}.tmp-${process.pid}`; writeFileSync(t, text, { mode: 0o644 }); renameSync(t, path); }
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(F.eTimeout(what))), ms).unref?.())]);

export async function run({ dataRoot = DATA_ROOT, deps = realDeps(), limits = LIMITS, nowMs = null } = {}) {
  const t0 = deps.now();
  const now = nowMs ?? t0;
  const { bizDate, cutMs, startMs, endMs } = windowOf(now, dataRoot);
  const out = join(dataRoot, W.layout.audit, W.layout.auditDaily, `${bizDate}-${W.layout.dailyFiles.formatCheck}`);
  const stateDir = join(dataRoot, W.layout.runLogs, W.layout.runLogDirs.formatCheck);
  const notes = []; // 未能检查
  let complete = true;
  const budgetLeft = () => limits.discordMs - (deps.now() - discordT0);
  let discordT0 = deps.now();

  // F1／F2
  const rec = scanTaskRecords(dataRoot, startMs, endMs, notes, limits.oldBefore ?? OLD_RECORD_BEFORE_MS);
  // F4
  const led = scanLedger(dataRoot, startMs, notes);
  // F3
  let cards = null; const cardRows = [];
  const snapPath = join(stateDir, '卡标签快照.json');
  const snap = jread(snapPath, null);
  try { cards = await deps.readCards(startMs); } catch (e) { notes.push(F.cannotCheck(F.wCards, F.whyBoard(String(e.message ?? e).slice(0, 60)))); complete = false; }
  if (cards) {
    for (const c of cards) {
      const inWindow = (c.updated_at ?? 0) >= startMs || (c.created_at ?? 0) >= startMs;
      const miss = checkCard(c, { startMs, snapshotAt: snap?.generatedAt ?? null, snapshot: snap?.cards ?? null });
      if (inWindow || miss.some((x) => x.startsWith(F.cardChanged))) cardRows.push({ id: c.id, title: c.title, miss, inWindow });
    }
  }
  // H1
  const rows = []; let threadsTotal = 0; let threadsRead = 0; const unknownBots = new Set();
  try {
    const table = jread(join(dataRoot, W.layout.audit, W.layout.auditDaily, W.layout.dailyFiles.botRoster), null);
    const bots = (table?.人设bot ?? []).map((b) => b?.['Discord编号']).filter((x) => x != null && String(x).trim()).map(String);
    if (!bots.length) { notes.push(F.cannotCheck(F.wHandoff, F.whyNoRoster(W.layout.dailyFiles.botRoster))); complete = false; }
    else {
      const botIds = new Set(bots);
      if (table?.状态 && table.状态 !== '有效') notes.push(F.rosterStatus(table.状态));
      discordT0 = deps.now();
      let threads = [];
      try { threads = await withTimeout(deps.listThreads(limits.cmdMs), limits.cmdMs + 500, F.eListThreads); } catch (e) { notes.push(F.cannotCheck(F.wHandoff, F.whyListThreads(String(e.message ?? e).slice(0, 60)))); threads = null; complete = false; }
      if (threads) {
        if (threads.hasMore) notes.push(F.hasMore);
        const cand = threads.filter((t) => String(t.id) !== CHAT_CHANNEL && String(t.parent_id ?? '') !== CHAT_CHANNEL && t.last_message_id && snowflakeMs(String(t.last_message_id)) >= startMs)
          .sort((a, b) => (BigInt(b.last_message_id) > BigInt(a.last_message_id) ? 1 : -1)).slice(0, limits.maxThreads);
        if (cand.length === limits.maxThreads && threads.filter((t) => String(t.id) !== CHAT_CHANNEL && String(t.parent_id ?? '') !== CHAT_CHANNEL && t.last_message_id && snowflakeMs(String(t.last_message_id)) >= startMs).length > limits.maxThreads) notes.push(F.cannotCheckBare(F.whyTooManyThreads(limits.maxThreads)));
        threadsTotal = cand.length;
        for (const t of cand) {
          if (budgetLeft() < 1000) { notes.push(F.cannotCheck(F.wOtherThreads, F.whyTimeGuard(threadsRead, threadsTotal))); complete = false; break; }
          try {
            const all = new Map(); let before = null;
            for (let page = 0; page < limits.maxPages; page++) {
              const wait = Math.min(limits.cmdMs, budgetLeft());
              if (wait < 500) throw new Error(F.eBudget);
              const msgs = await withTimeout(deps.readMessages(String(t.id), before, wait), wait + 500, F.eReadThread);
              if (!msgs.length) { before = null; break; }
              for (const m of msgs) all.set(String(m.id), m);
              if (msgs.length < 100) { before = null; break; }
              before = msgs.reduce((mn, m) => (BigInt(m.id) < mn ? BigInt(m.id) : mn), BigInt(msgs[0].id)).toString();
              if (page === limits.maxPages - 1) throw new Error(F.eTooMany(all.size));
            }
            const { n, unknownBots: ub } = countHandoffs([...all.values()], botIds);
            ub.forEach((x) => unknownBots.add(x));
            rows.push({ id: String(t.id), name: String(t.name ?? ''), total: all.size, n });
            threadsRead++;
          } catch (e) { rows.push({ id: String(t.id), name: String(t.name ?? ''), error: String(e.message ?? e).slice(0, 60) }); if (!new RegExp(F.tooManyRe).test(String(e.message ?? e))) complete = false; /* 任何一条线程读失败（“消息太多”是重试也没用的，不算）（真超时报的是 Command failed，不含“超时”二字）都算未完成：不推进快照，18:05 前下一遍再试 */ }
        }
      }
    }
  } catch (e) { notes.push(F.cannotCheck(F.wHandoff, String(e.message ?? e).slice(0, 60))); }

  // ---- 写文件 ----
  const L = [];
  const stopAt = localStamp(endMs);
  const badRec = rec.bad.length;
  const badCards = cardRows.filter((c) => c.miss.length).length;
  const flagged = rows.filter((r) => r.n >= limits.handoffAt);
  L.push(F.title(bizDate), '', `${labelText(W.businessDateLabel)}${bizDate}`, `${labelText(W.statusLabel)}${complete ? W.reportComplete : `${W.reportUnfinished}${F.statusUnfinishedNote}`}`,
    F.windowLine(localStamp(startMs), stopAt, W.auditRecordKeys.execution, W.auditRecordValues.done, stopAt.slice(11, 16)),
    F.cutoffLine(bizDate, `${pad(CUT_H)}:${pad(CUT_M)}`), F.generatedLine(localStamp(deps.now()), Math.round((deps.now() - t0) / 1000)),
    F.noteLine, '',
    F.summaryLine(rec.checked.length, badRec, rec.oldCount, cardRows.length, badCards, led.skipped ? (led.unreadable ? F.ledgerSummaryUnreadable : F.ledgerSummaryUnchanged) : F.ledgerChecked(led.total, led.bad.length), threadsRead, threadsTotal, limits.handoffAt, flagged.length), '');
  L.push(F.secRecords, '');
  L.push(F.recordsNote(rec.checked.length, rec.oldCount), '');
  L.push(rec.checked.length ? rec.checked.map((r) => F.recordLine(r.file, r.result)).join('\n') : F.listNone, '');
  L.push(F.secCards, '');
  L.push(cardRows.length ? cardRows.map((c) => F.cardLine(c.id.slice(0, 8), c.title, c.miss.length ? c.miss.join(F.semi) : F.ok)).join('\n') : F.cardsNone, '');
  if (cards && !snap) L.push(F.firstRun, '');
  L.push(F.secLedger, '');
  L.push(led.skipped ? (led.unreadable ? F.ledgerUnreadable : F.ledgerUnchanged) : (led.bad.length ? led.bad.map((b) => F.ledgerMiss(b.id, b.miss.join(F.jn))).join('\n') : F.ledgerAllOk(led.total, W.ledgerQuoteLabel)), '');
  L.push(F.secHandoff(limits.handoffAt), '');
  L.push(rows.length ? [...F.tableHead, ...rows.map((r) => (r.error ? F.rowError(r.id, r.name, r.error) : F.rowOk(r.id, r.name, r.total, r.n, limits.handoffAt)))].join('\n') : F.handoffNone, '');
  if (unknownBots.size) L.push(F.rosterLacks([...unknownBots].join(F.jn)), '');
  L.push(F.secNotChecked, '', notes.length ? notes.map((x) => `- ${x}`).join('\n') : F.listNone, '');
  atomicWrite(out, L.join('\n'));
  // 快照：只有任务卡读成功、而且这一遍完整跑完才更新
  if (cards && complete) {
    const cs = {}; for (const c of cards) cs[c.id] = { audit: auditLabelOf(c), level: levelLineOf(c) };
    atomicWrite(snapPath, JSON.stringify({ generatedAt: deps.now(), cards: cs }, null, 1));
  }
  return { out, bizDate, summary: { records: rec.checked.length, badRec, cards: cardRows.length, badCards, ledgerBad: led.bad?.length ?? 0, threadsRead, threadsTotal, flagged: flagged.length, notes: notes.length }, complete };
}

// ---------- 入口：锁＋总时限 ----------
export async function main(argv = process.argv.slice(2)) {
  const stateDir = join(DATA_ROOT, W.layout.runLogs, W.layout.runLogDirs.formatCheck);
  mkdirSync(stateDir, { recursive: true });
  const lock = join(stateDir, '运行.lock');
  const log = (s) => { try { appendFileSync(join(stateDir, '运行.log'), `${new Date().toISOString()} ${s}\n`); } catch { /* 只是日志 */ } };
  try { const fd = openSync(lock, 'wx'); writeFileSync(fd, JSON.stringify({ at: Date.now(), pid: process.pid })); closeSync(fd); } catch (e) {
    if (e.code !== 'EEXIST') { log(`起不来：${e.message}`); return 1; }
    const l = jread(lock, {});
    let alive = false; try { process.kill(l.pid, 0); alive = true; } catch (er) { alive = er.code !== 'ESRCH'; }
    if (alive || Date.now() - (l.at ?? 0) < LIMITS.lockStaleMs) { log('上一遍还在跑，这一遍不跑'); return 0; }
    try { rmSync(lock); const fd = openSync(lock, 'wx'); writeFileSync(fd, JSON.stringify({ at: Date.now(), pid: process.pid })); closeSync(fd); log('回收了老锁'); } catch { return 0; }
  }
  const totalMs = Number(process.env.OPENCLAW_DFC_TOTAL_MS) || LIMITS.totalMs; // 环境变量只给离线测试缩短用，正式不设
  const killer = setTimeout(() => { log(`超过总时限 ${totalMs / 1000} 秒，强制结束`); try { rmSync(lock); } catch { /* 已清理 */ } process.exit(3); }, totalMs);
  try {
    const r = await run({});
    log(`完成 ${JSON.stringify(r.summary)}`);
    return 0;
  } catch (e) { log(`失败：${String(e?.stack ?? e).slice(0, 400)}`); return 1; }
  finally { clearTimeout(killer); try { rmSync(lock); } catch { /* 已清理 */ } }
}

if (process.argv[1]?.endsWith('daily-format-check.mjs')) main().then((c) => process.exit(c));
