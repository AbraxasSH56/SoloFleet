#!/usr/bin/env node
// Daytime watch (runs every 30 minutes, no model calls): looks for stuck work, closes the books afterwards and starts the daily checks.
// “白天看护”命令型定时任务：08:00～22:00 每 30 分钟跑一遍，不调模型。
// 有异常才叫总控（建一次性定时任务），没异常输出 NO_REPLY、不花额度。
// 先记账再叫、同一异常只有一个发起者、结果不明核原请求不重建、按“这次异常开始的时刻”分新旧。
import { localDate, localDateTime, localDayStart, offsetMs } from '../../plugins/personal-inbox/tz.mjs';
const localMinutes = (ms) => { const s = localDateTime(ms); return Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16)); };
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLedger, registerItem, WORKSHOP_CHANNEL } from '../../plugins/personal-inbox/pending-ledger.mjs';
import { CALL_STATES, ledgerLookup, managedByResume } from './quota-resume-lib.mjs';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync, openSync, closeSync, statSync, appendFileSync } from 'node:fs';

import { crew } from '../../plugins/personal-inbox/crew-config.mjs';
import { lexicon, labelRe, escapeRe, locale } from '../../plugins/personal-inbox/lexicon.mjs';
const W = lexicon(); // words, report markers and folder names follow config "locale" (zh-CN: the literals this script always used)
// the "complete" line the format check and the blind-spot check write at the top of their files: zh-CN `状态：完整`, en `Status: complete`
const COMPLETE_RE = new RegExp(`^${locale() === 'en' ? `${escapeRe(W.statusLabel)}:\\s*` : `${W.statusLabel}：`}${escapeRe(W.reportComplete)}`, 'm');
const DATA_ROOT = process.env.OPENCLAW_DATA_ROOT || crew.paths.dataRoot; // env var first (offline smoke tests), then config
const WATCH_DIR = join(DATA_ROOT, '运行记录', '看护');
// 常量（起草定，可改；STALE 可用环境变量缩短做测试，正式不设）
export const STALE_MS = Number(process.env.OPENCLAW_DAYWATCH_STALE_MS) || 2 * 3600 * 1000;
export const LOCK_STALE_MS = 10 * 60 * 1000;
export const UNKNOWN_WAIT_MS = 10 * 60 * 1000;
export const REPEAT_MAX_DAYS = 3;
const DONE = ['done'];
const WAITING_LABELS = W.waitingLabels;

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const jread = (p, fb = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fb; } };
function jwrite(p, obj) { mkdirSync(join(p, '..'), { recursive: true }); const t = `${p}.tmp-${process.pid}`; writeFileSync(t, JSON.stringify(obj, null, 1), { mode: 0o600 }); renameSync(t, p); }

export function realDeps(env = process.env) {
  const bin = env.OPENCLAW_BIN || crew.paths.openclawBin;
  const run = (args, timeout = 60000) => execFileSync(bin, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], env: { ...env, NODE_NO_WARNINGS: '1' } });
  const js = (out) => JSON.parse(out.slice(out.indexOf('{') >= 0 && (out.indexOf('[') < 0 || out.indexOf('{') < out.indexOf('[')) ? out.indexOf('{') : out.indexOf('[')));
  return {
    now: () => Date.now(),
    watchDir: WATCH_DIR,
    dataRoot: DATA_ROOT,
    listCards: () => js(run(['workboard', 'list', '--json'])).cards ?? [],
    listJobs: () => js(run(['automations', 'list', '--all', '--json'])).jobs ?? [],
    listRuns: (jobId) => js(run(['automations', 'runs', jobId, '--json', '--limit', '50'])).entries ?? [],
    addJob: (message, name) => js(run(['automations', 'add', '--name', name, '--at', '1m', '--agent', 'main', '--session', 'isolated', '--message', message, '--no-deliver', '--delete-after-run', '--json'])),
    deskWaitingCard: () => { const l = jread(join(crew.paths.workspaceRoot, 'desktop', 'screen.lock'), null); return l?.state === 'waiting' ? l.cardId ?? null : null; },
    pendingLedgerPath: join(DATA_ROOT, W.layout.audit, W.layout.auditAwaiting, W.layout.awaitingLedgerFile),
    closingBaselinePath: join(WATCH_DIR, '结案基线.json'),
    closingLedgerPath: join(DATA_ROOT, '运行记录', '结案', '账.json'),
    collectCatchupFlags: () => collectCatchupFlags(DATA_ROOT, Date.now(), WATCH_DIR),
    collectDiscordHealthFlags: () => collectDiscordHealthFlags(process.env.OPENCLAW_GATEWAY_LOG_DIR || '/tmp/openclaw', Date.now()),
  };
}

// 真正代表出事的是两样：①续不上（resume=false，丢了连接状态）；②心跳没回（heartbeat ACK timeout）一小时里很多次。重连次数本身不再告警。
// 读网关日志（/tmp/openclaw/openclaw-日期.log，只留两天左右），看最近 1 小时；读不到当没有。
export const HEALTH_WINDOW_MS = 3600 * 1000;
export const HEARTBEAT_TIMEOUT_ALERT = 5; // 起草定，可改：一小时里心跳没回超过这个次数才算（现在每天约 1 次）
export function collectDiscordHealthFlags(logDir, nowMs) {
  const out = [];
  const days = [nowMs, nowMs - 86400000].map((ms) => localDate(ms)); // local date in the configured zone
  let resumeFalse = 0, hbTimeout = 0, firstAt = null;
  for (const day of new Set(days)) {
    let text;
    try { const f = join(logDir, `openclaw-${day}.log`); if (statSync(f).size > 50 * 1024 * 1024) continue; text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const rf = line.includes('resume=false'), hb = line.includes('heartbeat ACK timeout');
      if (!rf && !hb) continue;
      let at; try { at = Date.parse(JSON.parse(line)?._meta?.date); } catch { continue; }
      if (!Number.isFinite(at) || nowMs - at > HEALTH_WINDOW_MS || at > nowMs + 60000) continue;
      if (rf && line.includes('Gateway reconnect scheduled')) { resumeFalse += 1; firstAt = Math.min(firstAt ?? at, at); }
      if (hb) { hbTimeout += 1; firstAt = Math.min(firstAt ?? at, at); }
    }
  }
  const hour = Math.floor(nowMs / HEALTH_WINDOW_MS) * HEALTH_WINDOW_MS;
  if (resumeFalse > 0) out.push({ type: 'discord-resume-failed', object: `discord-resume:${hour}`, startedAt: firstAt ?? hour, text: `最近 1 小时 Discord 有 ${resumeFalse} 次重连没能续上原来的连接（resume=false），可能丢了这几秒的消息` });
  if (hbTimeout >= HEARTBEAT_TIMEOUT_ALERT) out.push({ type: 'discord-heartbeat-timeout', object: `discord-heartbeat:${hour}`, startedAt: firstAt ?? hour, text: `最近 1 小时 Discord 心跳没回 ${hbTimeout} 次（平时一天约 1 次）` });
  return out;
}

// ----- 第一段 3.5 留下的待核、卡住的锁、没接住的撞额度，以及台账锁／看护锁待核日志-----
// 补跑那四个任务（日审、巡查、异常深审、周审）的撞额度由 3.5 补跑接；这里只报“没人接的”：对话里撞的、别的任务撞的
const CATCHUP_JOB_IDS = new Set(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000004']);
const QUOTA_LOOKBACK_MS = 48 * 3600 * 1000;
// 订阅 bot 在频道／线程里撞限的，归命令型任务“额度接续”管；看护先让路，只在接续自己标了需要人看的状态时才兜底叫醒总控。
const RESUME_GRACE_MS = 30 * 60 * 1000; // 登记出现后 30 分钟内，账里还没有这条：先给额度接续一轮机会把它收进账
// 读额度接续的账：没有这个文件（接续还没跑过）＝空账；文件在但读不出（损坏），或者超过 45 分钟没更新（额度接续每 10 分钟一轮、每轮都会重写账；
// 停用了或连续出错就会变旧）＝undefined，看护照旧不让路——免得账里一条“待发起”让看护永远让路、谁也不叫
const RESUME_LEDGER_STALE_MS = 45 * 60 * 1000;
function readResumeLedger(dataRoot, nowMs) {
  const f = join(dataRoot, '运行记录', '额度', '接续', '账.json');
  if (!existsSync(f)) return { 链: {}, 运行: {} };
  try {
    if (nowMs - statSync(f).mtimeMs > RESUME_LEDGER_STALE_MS) return undefined;
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch { return undefined; }
}
export function collectCatchupFlags(dataRoot, nowMs, watchDir = join(dataRoot, '运行记录', '看护')) {
  const out = [];
  const day = Math.floor(nowMs / 86400000) * 86400000;
  const listJson = (dir) => { try { return readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => [n, join(dir, n)]); } catch { return []; } };
  // 补跑账里的“待核”“补跑结果待核”“通知未送达”
  const base = join(dataRoot, '运行记录', '补跑');
  for (const [n, f] of listJson(base)) {
    const d = jread(f, null); if (!d) continue;
    const st = String(d.状态 ?? '').split('（')[0];
    if (st === '待核' || st === '补跑结果待核') out.push({ type: 'catchup-flag', object: `补跑账:${n}:${st}`, startedAt: d.更新时间毫秒 ?? day, text: `补跑账“${n.replace(/\.json$/, '')}”状态是“${st}”（第一段补跑留下的，要人看一眼）` });
    const ns = d.通知?.状态;
    if (ns === '未送达' || ns === '待核') out.push({ type: 'catchup-flag', object: `补跑账:${n}:通知${ns}`, startedAt: d.更新时间毫秒 ?? day, text: `补跑账“${n.replace(/\.json$/, '')}”的通知${ns}（工坊可能没收到）` });
  }
  // 补跑锁卡住
  const stuck = jread(join(base, '.stuck-notified'), null);
  if (stuck?.日期) out.push({ type: 'catchup-flag', object: '补跑检查卡住', startedAt: localDayStart(stuck.日期) || day, text: `补跑检查卡住过（${stuck.日期}，锁比时限的两倍还老，没有抢锁）` });
  // 没接住的撞额度：额度登记里不属于补跑四个任务、失败时间在近 48 小时内、终态已确认的
  const resumeLedger = readResumeLedger(dataRoot, nowMs);
  for (const [n, f] of listJson(join(dataRoot, '运行记录', '额度'))) {
    const q = jread(f, null); if (!q || !q.失败时间毫秒) continue;
    if (nowMs - q.失败时间毫秒 > QUOTA_LOOKBACK_MS || !q.终态已确认) continue;
    if (q.是定时任务 && CATCHUP_JOB_IDS.has(String(q.任务编号))) continue;
    // 先看归不归额度接续管（managedByResume 为假的：一次性定时任务、桌面角色、备用A、备用B、非频道会话键，走老路，不查账、不等）；
    // 归它管的按“运行编号”查账：查到就让路（只有需要人看的状态才兜底），查不到（含同会话键以前有旧链、这条是新运行编号）等 30 分钟宽限，超时照旧叫醒；账文件损坏照旧
    if (resumeLedger !== undefined && managedByResume(q)) {
      const hit = ledgerLookup(resumeLedger, q.运行编号);
      if (hit.found ? !CALL_STATES.includes(hit.state) : nowMs - q.失败时间毫秒 < RESUME_GRACE_MS) continue;
    }
    out.push({ type: 'quota-hit', object: String(q.运行编号 ?? n), startedAt: q.失败时间毫秒, text: `额度用完停下：${q.角色 ?? '未知角色'}${q.是定时任务 ? `（定时任务 ${q.任务编号}）` : '（对话里）'}，${q.报错前200字 ? `“${String(q.报错前200字).slice(0, 80)}”，` : ''}恢复时间 ${q.恢复时间 ?? '未知'}；不是补跑管的那四个任务，请判断要不要接着做` });
  }
  // 台账锁／看护锁待核日志
  for (const [name, what] of [['台账锁待核.log', '“等你定”台账锁太老'], ['看护锁待核.log', '白天看护锁太老']]) {
    try {
      const f = join(watchDir, name); const st = statSync(f);
      if (nowMs - st.mtimeMs < 3 * 86400000) out.push({ type: 'catchup-flag', object: name, startedAt: Math.floor(st.mtimeMs / 86400000) * 86400000, text: `${what}，没有抢锁（日志 ${name}，最后一次 ${new Date(st.mtimeMs).toISOString().slice(0, 16)}），要人处理` });
    } catch { /* 没有这个日志 */ }
  }
  return out;
}

// 归档标记：真实 `openclaw workboard list --json` 的卡在 `metadata.archivedAt`（顶层没有）；两处都看，防以后官方挪位置
export const isArchived = (c) => !!(c?.metadata?.archivedAt || c?.archivedAt || c?.archived_at);

// ----- 收集异常 -----
export function collectAnomalies(d) {
  const t = d.now();
  const out = [];
  let cards = [];
  try { cards = d.listCards(); } catch (e) { out.push({ type: 'read-fail', object: '任务板', startedAt: Math.floor(t / 86400000) * 86400000, text: `读不到任务板：${e.message}` }); }
  const waitingCard = d.deskWaitingCard?.();
  for (const c of cards) {
    const status = String(c.status ?? '');
    if (DONE.includes(status)) continue;
    if (isArchived(c)) continue; // 已归档的卡（测试卡收尾时只归档不改状态，状态还是运行中）不算久没动
    const running = status === 'running' || !!c.claim;
    if (!running) continue;
    const blob = `${(c.labels ?? []).join(' ')} ${c.notes ?? ''}`;
    if (WAITING_LABELS.some((w) => blob.includes(w))) continue;
    if (waitingCard && (c.id === waitingCard)) continue;
    if (t - (c.updatedAt ?? t) < STALE_MS) continue;
    out.push({ type: 'card-stale', object: c.id, startedAt: c.updatedAt, text: `任务卡“${c.title}”（${c.id}）运行中，${Math.round((t - c.updatedAt) / 60000)} 分钟没动` });
  }
  // 3.5 留下的待核和卡住的锁；额度未接住的
  for (const x of d.collectCatchupFlags?.() ?? []) out.push(x);
// Discord 续不上／心跳连续没回（重连次数本身不告警）
  for (const x of d.collectDiscordHealthFlags?.() ?? []) out.push(x);
  // 3.13 到点任务：卡上有定时任务编号、时间已过、任务还在或运行记录不是 ok；运行 ok 但事没做成
  for (const c of cards) {
    const m = new RegExp(`${labelRe(W.timedJobLabels.id)}(\\S+)`).exec(c.notes ?? '');
    const tm = new RegExp(`${labelRe(W.timedJobLabels.due)}(\\S+)`).exec(c.notes ?? '');
    if (!m || !tm || DONE.includes(String(c.status)) || isArchived(c)) continue;
    const due = Date.parse(tm[1]);
    if (Number.isNaN(due) || due > t - 10 * 60 * 1000) continue;
    let runs = [];
    try { runs = d.listRuns(m[1]); } catch { /* 任务已移除或读不到 */ }
    const last = runs.at(-1) ?? runs[0];
    if (!last) { out.push({ type: 'oneshot-missed', object: c.id, startedAt: due, text: `卡“${c.title}”的到点任务 ${m[1]} 时间已过，没有运行记录` }); continue; }
    if (last.status !== 'ok') out.push({ type: 'oneshot-failed', object: c.id, startedAt: last.runAtMs ?? due, text: `卡“${c.title}”的到点任务 ${m[1]} 运行状态是 ${last.status}` });
    else out.push({ type: 'oneshot-ok-not-done', object: c.id, startedAt: last.runAtMs ?? due, text: `卡“${c.title}”的到点任务 ${m[1]} 跑完了（ok），但卡还没完成：核实事情是不是真做成了` });
  }
  // 事后核账：启用以后新完成或重新完成的卡有没有放行记录
  const base = jread(d.closingBaselinePath, null);
  if (base) {
    const rel = jread(d.closingLedgerPath, { releases: [] })?.releases ?? [];
    for (const c of cards) {
      if (!DONE.includes(String(c.status))) continue;
      const b = base.cards?.[c.id];
      const completedAt = c.completedAt ?? c.updatedAt;
      if (b && completedAt <= b.completedAt) continue;
      if (rel.some((r) => r.cardId === c.id)) continue;
      out.push({ type: 'closing-unlogged', object: c.id, startedAt: completedAt, text: `卡“${c.title}”（${c.id}）完成了，但结案关口没有放行记录（可能是你本人在控制台改的，也可能走了绕法）` });
    }
  }
  return out;
}

// 启用那一刻记基线：当时已是完成状态的卡（卡号＋完成时间）
export function writeClosingBaseline(d) {
  if (existsSync(d.closingBaselinePath)) return { exists: true };
  const cards = d.listCards().filter((c) => DONE.includes(String(c.status)));
  const o = { at: d.now(), cards: Object.fromEntries(cards.map((c) => [c.id, { completedAt: c.completedAt ?? c.updatedAt }])) };
  jwrite(d.closingBaselinePath, o);
  return { exists: false, count: cards.length };
}

// ----- 先记账再叫 -----
function acct(d, fp) { return join(d.watchDir, `${fp}.json`); }
// “一天”按配置时区的天算（按 UTC 天算的话，同一个本地日可能跨两个 UTC 天、叫两次）
export const localDay = (ms) => Math.floor((ms + offsetMs(ms)) / 86400000);
// 叫起的那个一次性任务“最后一次结束的运行”的 status。官方运行记录 `automations runs` 默认从新到旧排，结束记录带 status；
// 按时间戳（ts 或 runAtMs）取最大的一条；没有时间戳又有好几条时取最保守的：只要有一条不是 ok 就不算 ok。没有结束记录返回 undefined。
export function lastFinishedStatus(runs) {
  const fin = (runs ?? []).filter((r) => r?.action === 'finished');
  if (!fin.length) return undefined;
  const ts = (r) => (Number.isFinite(r.ts) ? r.ts : Number.isFinite(r.runAtMs) ? r.runAtMs : null);
  if (fin.every((r) => ts(r) !== null)) return fin.reduce((m, r) => (ts(r) > ts(m) ? r : m)).status;
  return fin.every((r) => r.status === 'ok') ? 'ok' : (fin.find((r) => r.status !== 'ok')?.status ?? 'unknown');
}
export async function handleAnomaly(d, an) {
  const t = d.now();
  const fp = sha(`${an.object}|${an.type}|${an.startedAt}`);
  const file = acct(d, fp);
  const a = jread(file, null);
  if (!a) {
    jwrite(file, { fp, ...an, state: '准备叫起', preparedAt: t, calls: [] });   // 先记账
    return await callAndRecord(d, an, fp, file);
  }
  if (a.state === '准备叫起') {
    // 上次建任务命令没返回编号：先按指纹找原请求，找到补记，找不到且已过 10 分钟改“叫起待核”，不重建
    const found = await findByFingerprint(d, fp);
    if (found) { a.state = '已叫起'; a.jobId = found; a.calledAt = a.preparedAt; jwrite(file, a); return { action: 'recovered', fp }; }
    if (t - a.preparedAt >= UNKNOWN_WAIT_MS) { a.state = '叫起待核'; jwrite(file, a); return { action: 'unknown', fp, note: `叫起待核：${an.text}` }; }
    return { action: 'wait', fp };
  }
  if (a.state === '叫起待核') return { action: 'noop', fp };
  if (a.state === '已叫起') {
    // 那个一次性任务还没结束 → 不再叫
    let runs = []; let jobAlive = false;
    try { runs = d.listRuns(a.jobId); } catch { /* 读不到 */ }
    try { jobAlive = d.listJobs().some((j) => j.id === a.jobId); } catch { jobAlive = false; }
    const finished = runs.some((r) => r.action === 'finished') || (!jobAlive && runs.length > 0);
    if (!finished && jobAlive) return { action: 'busy', fp };
    // 撞额度（quota-hit）是“过去发生的一次事件”：叫起去核实的那次运行正常跑完（最后一次结束记录 status 是 ok），就算处理过，
    // 之后这件在 48 小时登记窗口里还在，也不再叫、不升级（以前每天都再叫，最多连叫 3 天）。叫起的那次没跑完／报错／被打断（status 不是 ok），
    // 照下面“一天最多再叫一次、连续 3 天升级”走，免得真没人管的事被悄悄放掉。其他类型的异常行为不变。
    if (an.type === 'quota-hit' && lastFinishedStatus(runs) === 'ok') return { action: 'noop', fp };
    // 结束了但异常还在：一天最多再叫一次（按本地时区的天算）；连续 3 天每天都还在 → 不再叫，交主人
    const day = localDay(t);
    const days = new Set((a.calls ?? []).map((c) => localDay(c)));
    if (days.has(day)) return { action: 'already-today', fp };
    if (days.size >= REPEAT_MAX_DAYS && [...days].sort().slice(-REPEAT_MAX_DAYS).every((x, k, arr) => k === 0 || x === arr[k - 1] + 1)) {
      if (!a.escalated) { a.escalated = true; jwrite(file, a); return { action: 'escalate', fp, an }; }
      return { action: 'noop', fp };
    }
    a.state = '准备叫起'; a.preparedAt = t; jwrite(file, a);
    return await callAndRecord(d, an, fp, file);
  }
  return { action: 'noop', fp };
}

async function findByFingerprint(d, fp) {
  try { return d.listJobs().find((j) => String(j.payload?.message ?? '').includes(`〔看护·${fp}〕`))?.id ?? null; } catch { return null; }
}

async function callAndRecord(d, an, fp, file) {
  const msg = `〔看护·${fp}〕异常清单原样：${an.text}\n按规则核实；需要就在对应线程点名相关 bot；要主人定的照丙档登记台账（pending_decision_register）。`;
  let r = null;
  try { r = d.addJob(msg, `白天看护叫起-${fp}`); } catch { r = null; }
  const a = jread(file, {});
  if (r?.id) { a.state = '已叫起'; a.jobId = r.id; a.calledAt = d.now(); a.calls = [...(a.calls ?? []), d.now()]; jwrite(file, a); return { action: 'called', fp, jobId: r.id }; }
  return { action: 'prepared-unknown', fp }; // 保持“准备叫起”，下一次先按指纹找原请求
}

// ----- 日审格式抽查：看护顺手把它放到后台，自己照旧立刻退出 -----
// 本地时区 17:30～18:04 之间那一遍，当天的“格式抽查”文件还没写完整（没有“状态：完整”一行），就用脱钩的子进程起 daily-format-check.mjs。
// 子进程自己管 90 秒上限、自己写日志；这里不等它、不读它的输出，任何出错都只记一行，不影响看护的输出和退出码。
export const FORMAT_CHECK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'daily-format-check.mjs');
export function formatCheckDue(nowMs, dataRoot = DATA_ROOT) {
  const minutes = localMinutes(nowMs);
  if (minutes < 17 * 60 + 30 || minutes >= 18 * 60 + 5) return false;
  const bizDate = localDate(nowMs);
  try { if (COMPLETE_RE.test(readFileSync(join(dataRoot, W.layout.audit, W.layout.auditDaily, `${bizDate}-${W.layout.dailyFiles.formatCheck}`), 'utf8'))) return false; } catch { /* 还没有：该跑 */ }
  return true;
}
export function startFormatCheck({ nowMs = Date.now(), dataRoot = DATA_ROOT, script = FORMAT_CHECK_SCRIPT, spawnFn = spawn, execPath = process.execPath, log = null } = {}) {
  // 出错日志写在传进来的数据根下面（不再写死全局 WATCH_DIR：测试传临时目录时不会碰真实的看护目录）
  const note = (t) => { try { (log ?? ((x) => { const d = join(dataRoot, '运行记录', '看护'); mkdirSync(d, { recursive: true }); appendFileSync(join(d, '格式抽查启动.log'), `${new Date().toISOString()} ${x}\n`); }))(t); } catch { /* 只是日志 */ } };
  try {
    if (!formatCheckDue(nowMs, dataRoot)) return { started: false };
    const child = spawnFn(execPath, [script], { detached: true, stdio: 'ignore', env: process.env });
    child?.on?.('error', (e) => note(`格式抽查没起来：${e.message}`));
    child?.unref?.();
    return { started: true, child };
  } catch (e) { note(`格式抽查没起来：${String(e?.message ?? e).slice(0, 100)}`); return { started: false, error: true }; }
}
// ----- 审计盲区抽查：同一个办法——本地时区 17:30 以后第一遍，当天的“盲区抽查”文件还没写完整就用脱钩子进程起 audit-blindspots.mjs -----
// 子进程自己管 90 秒上限、锁文件和日志；这里不等它、不读它的输出，出错只记一行，不影响看护的输出和退出码。
export const BLINDSPOTS_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'audit-blindspots.mjs');
export function blindspotsDue(nowMs, dataRoot = DATA_ROOT) {
  const minutes = localMinutes(nowMs);
  if (minutes < 17 * 60 + 30) return false; // 看护只在白天跑，没有上限也行；17:30 以后第一遍就跑，没写完整的下一遍再试
  const bizDate = localDate(nowMs);
  try { if (COMPLETE_RE.test(readFileSync(join(dataRoot, W.layout.audit, W.layout.auditDaily, `${bizDate}-${W.layout.dailyFiles.blindspot}`), 'utf8'))) return false; } catch { /* 还没有：该跑 */ }
  return true;
}
export function startBlindspots({ nowMs = Date.now(), dataRoot = DATA_ROOT, script = BLINDSPOTS_SCRIPT, spawnFn = spawn, execPath = process.execPath, log = null } = {}) {
  const note = (t) => { try { (log ?? ((x) => { const d = join(dataRoot, '运行记录', '看护'); mkdirSync(d, { recursive: true }); appendFileSync(join(d, '盲区抽查启动.log'), `${new Date().toISOString()} ${x}\n`); }))(t); } catch { /* 只是日志 */ } };
  try {
    if (!blindspotsDue(nowMs, dataRoot)) return { started: false };
    const child = spawnFn(execPath, [script], { detached: true, stdio: 'ignore', env: process.env });
    child?.on?.('error', (e) => note(`盲区抽查没起来：${e.message}`));
    child?.unref?.();
    return { started: true, child };
  } catch (e) { note(`盲区抽查没起来：${String(e?.message ?? e).slice(0, 100)}`); return { started: false, error: true }; }
}
// 退出前最多等 0.5 秒，让“起不来”的异步错误事件有机会把日志写下来；子进程正常起来时一收到 spawn 事件就走，不等它跑完
export function settleFormatCheck(r) {
  return new Promise((resolve) => {
    const c = r?.child;
    if (!c?.once) return resolve();
    const t = setTimeout(resolve, 500); t.unref?.();
    c.once('spawn', () => { clearTimeout(t); resolve(); });
    c.once('error', () => { setTimeout(resolve, 20); });
  });
}

// ----- 一遍 -----
export async function main(d = realDeps()) {
  mkdirSync(d.watchDir, { recursive: true });
  const lock = join(d.watchDir, '看护.lock');
  try { const fd = openSync(lock, 'wx'); writeFileSync(fd, JSON.stringify({ at: d.now(), pid: process.pid })); closeSync(fd); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const age = d.now() - (jread(lock, {})?.at ?? 0);
    if (age > LOCK_STALE_MS) appendFileSync(join(d.watchDir, '看护锁待核.log'), `${new Date(d.now()).toISOString()} 看护锁待核（已存在 ${Math.round(age / 60000)} 分钟）\n`);
    return { skipped: true };
  }
  const results = [];
  try {
    writeClosingBaseline(d);
    for (const an of collectAnomalies(d)) {
      const r = await handleAnomaly(d, an);
      results.push({ an, r });
      // 连续 3 天每天都还在，或事后核账发现没有放行记录 → 登记台账交主人（丙档，建议“停用这项看护或人工处理”）
      if (r.action === 'escalate' || an.type === 'closing-unlogged') {
        await withLedger(d.pendingLedgerPath, (L) => {
          const res = registerItem(L, { title: `白天看护：${an.text}`, suggestion: r.action === 'escalate' ? '停用这项看护或人工处理' : '看一眼这张卡是不是你本人改的；不是就让总控查', blocks: '这件异常目前没人处理，会一直重复出现', requestMessageId: `watch-${sha(`${an.object}|${an.type}|${an.startedAt}`)}`, requestChannelId: WORKSHOP_CHANNEL }, d.now());
          return res.error ? { noWrite: true } : {};
        }, { now: d.now, watchDir: d.watchDir }).catch(() => null);
      }
    }
  } finally { try { rmSync(lock); } catch { /* 已清理 */ } }
  return { skipped: false, results };
}

if (process.argv[1]?.endsWith('day-watch.mjs')) {
  main().then((o) => {
    const called = (o.results ?? []).filter((x) => ['called', 'escalate'].includes(x.r.action));
    process.stdout.write(called.length === 0 ? 'NO_REPLY\n' : 'NO_REPLY\n'); // 看护自己不发消息；叫起由总控那一轮在线程里说
    Promise.all([settleFormatCheck(startFormatCheck()), settleFormatCheck(startBlindspots())]).then(() => process.exit(0)); // 放到后台就走，不等它跑完；出错只记日志
  }).catch((e) => { process.stderr.write(`白天看护失败：${e.message}\n`); process.exit(1); });
}
