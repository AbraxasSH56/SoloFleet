#!/usr/bin/env node
// Catch-up for scheduled audit jobs that failed on a quota error: reruns them once after the quota is back.
// 额度补跑：命令型定时任务，每 10 分钟跑一次，不调模型。
// 范围：只补 日审、巡查、异常深审、周审 四个任务；今后新增的任务不会自动纳入。
// 流程：先收尾已有的补跑账 → 再看有没有新的“因订阅额度失败、还没补”的一轮 → 到点直接试（同一轮最多 2 次、间隔至少 30 分钟）→ 说一句通知。
// 当轮计划取自插件存的“任务开始”事件存档（quota-recovery.mjs）；失败对不上唯一存档的那一轮不自动补。
// 防重复：先记账再发起；锁文件保证同一时刻只有一个发起者；结果不明只核不重发。
// 用法：node quota-catchup.mjs [--data-root <资料根>] [--test-bench <测试台目录>]
// 输出：没话说输出 NO_REPLY；有通知输出通知文字（官方把它发到工坊）。
import { localDate, localDateTime } from '../../plugins/personal-inbox/tz.mjs';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isQuotaSentence, nextOccurrence, previousOccurrence, resetAt, writeReplace } from '../../plugins/personal-inbox/quota-recovery.mjs';

import { crew } from '../../plugins/personal-inbox/crew-config.mjs';
export const DEFAULT_DATA_ROOT = process.env.OPENCLAW_DATA_ROOT || crew.paths.dataRoot; // env var first, then config
// 4-12 原设计：这四个任务有本轮记录接着做、发布脚本防重发。近线小时＝离下一轮不到这么久就跳过（周审 24 小时）。
export const TASKS = {
  日审: { 目录: '日审', 近线小时: 6, 要发布: false },
  巡查: { 目录: '巡查', 近线小时: 6, 要发布: true },
  异常深审: { 目录: '异常深审', 近线小时: 6, 要发布: true },
  周审: { 目录: '周审', 近线小时: 24, 要发布: true },
};
const MAX_TRIES = 2;
const GAP_MS = 30 * 60000; // 两次之间至少隔 30 分钟（起草定，可改）
const FALLBACK_AFTER_MS = 5 * 3600000; // 报错和 CodexBar 都没给恢复时间时：失败时间＋5 小时（五小时窗口的长度，起草定，可改）
const SETTLE_MS = 10 * 60000; // 官方重试结束＝最后一次运行结束满 10 分钟
const PREPARED_WAIT_MS = 10 * 60000;
const QUEUED_MAX_MS = 6 * 3600000;
const LOCK_STALE_MS = 2 * 300000; // 锁比脚本时限（300 秒）的两倍还老 → 不抢
const CODEXBAR_FRESH_MS = 10 * 60000;
const CODEXBAR_AHEAD_MS = 60000;
const CHANNEL_TARGET = `channel:${crew.channels.workshop}`;
const TERMINAL = new Set(['已补跑', '已跳过', '补跑失败', '待核', '补跑结果待核', '不再补跑']);

const stateName = (s) => String(s ?? '').split('（')[0];
const fmt = (ms) => localDateTime(ms).slice(0, 16);

// ---------- 官方命令（可替换成假的做离线测试）----------
export function realDeps(env = process.env) {
  const bin = env.OPENCLAW_BIN || crew.paths.openclawBin;
  const run = (args, timeout = 60000) => execFileSync(bin, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    now: () => Date.now(),
    listJobs: () => JSON.parse(run(['automations', 'list', '--all', '--json'])).jobs ?? [],
    listRuns: (jobId) => (JSON.parse(run(['automations', 'runs', jobId, '--json', '--limit', '50'])).entries ?? []),
    runJob: (jobId) => run(['automations', 'run', jobId], 120000),
    codexbar: () => {
      try {
        const out = execFileSync(crew.paths.codexbarBin || '/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI', ['usage', '--provider', 'claude', '--source', 'cli', '--format', 'json', '--no-credits'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
        return JSON.parse(out);
      } catch { return null; }
    },
  };
}

// ---------- 账本 ----------
function paths(dataRoot) {
  const base = join(dataRoot, '运行记录', '补跑');
  return {
    base,
    lock: join(base, '.lock'),
    stuck: join(base, '.stuck-notified'),
    account: (task, date) => join(base, `${task}-${date}.json`),
    quotaDir: join(dataRoot, '运行记录', '额度'),
    archiveDir: join(dataRoot, '运行记录', '额度', '计划存档'),
    round: (task, date) => join(dataRoot, '审计', TASKS[task].目录, `${date}.json`),
    credential: (task, date) => join(dataRoot, '审计', '发布', '凭据', `${task}-${date}.json`),
    receipt: (task, date) => join(dataRoot, '审计', '发布', '凭据', `${task}-${date}.回执.txt`),
  };
}
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

function listAccounts(P, task) {
  if (!existsSync(P.base)) return [];
  return readdirSync(P.base).filter((n) => n.startsWith(`${task}-`) && n.endsWith('.json')).sort().map((n) => ({ file: join(P.base, n), data: readJson(join(P.base, n)) })).filter((a) => a.data);
}
const saveAccount = (file, data, now) => writeReplace(file, { ...data, 更新时间毫秒: now() });

// ---------- 本轮记录和发送凭据 ----------
export function roundDone(P, task, date) {
  const rec = readJson(P.round(task, date));
  if (!rec || rec.执行 !== '完成' || rec.业务日期 !== date) return false;
  if (!TASKS[task].要发布) return true;
  return credentialTrusted(P, task, date);
}
// 可信已送达（日审.md 第 3 节的条件）：任务、业务日期一致，账号 default，频道 discord，目标工坊，状态已送达，消息编号 17～20 位数字，回执文件在。
export function credentialTrusted(P, task, date) {
  const c = readJson(P.credential(task, date));
  if (!c) return false;
  return c.任务 === task && c.业务日期 === date && c.账号 === 'default' && c.频道 === 'discord' && c.目标 === CHANNEL_TARGET
    && c.状态 === '已送达' && /^\d{17,20}$/.test(String(c.消息编号 ?? '')) && existsSync(P.receipt(task, date));
}

// ---------- 运行记录的归类 ----------
const errorText = (e) => String(e.error ?? e.errorMessage ?? e.summary ?? '');
const endedAt = (e) => (Number.isFinite(e.ts) ? e.ts : (e.runAtMs ?? 0) + (e.durationMs ?? 0));
// 额度失败：errorReason 是 rate_limit／billing 只算候选，认定要报错原文是订阅额度句（或测试台开关）。
export function classify(entry, bench) {
  if (bench?.把运行当额度失败?.includes(entry.runId)) return { kind: 'quota', text: bench.假报错 }; // 测试台：正常跑完的运行也可以被当成额度失败
  if (entry.status === 'ok') return { kind: 'ok' };
  const text = errorText(entry);
  if (isQuotaSentence(text)) return { kind: 'quota', text };
  return { kind: 'other', reason: entry.errorReason ?? text.slice(0, 80) ?? '未知' };
}

// ---------- CodexBar 参考读数（只用来推迟，不当发起的硬条件；边界②：同一登录来源、账号未直接比对）----------
export function windowResetAt(reading, model, errorTextValue, now) {
  try {
    const u = reading?.[0]?.usage ?? reading?.usage;
    if (!u || typeof u.updatedAt !== 'string') return null;
    const sampled = Date.parse(u.updatedAt);
    if (!Number.isFinite(sampled) || now() - sampled > CODEXBAR_FRESH_MS || sampled - now() > CODEXBAR_AHEAD_MS) return null;
    const lower = `${model ?? ''} ${errorTextValue ?? ''}`.toLowerCase();
    let w = u.primary;
    if (/fable/.test(lower)) w = u.extraRateWindows?.find((x) => /fable/i.test(x.id ?? ''))?.window ?? null;
    else if (/weekly|week/.test(lower)) w = u.secondary;
    if (!w || !Number.isFinite(w.usedPercent) || typeof w.resetsAt !== 'string') return null;
    const reset = Date.parse(w.resetsAt);
    return w.usedPercent >= 100 && reset > now() ? reset : null; // 还满（用光）且重置在将来 → 推迟
  } catch { return null; }
}

// ---------- 主流程 ----------
export function runCatchup({ dataRoot = DEFAULT_DATA_ROOT, deps = realDeps(), bench = null, log = () => {} } = {}) {
  const P = paths(dataRoot);
  const now = deps.now;
  const gapMs = bench?.间隔毫秒 ?? GAP_MS;
  const lines = [];
  mkdirSync(P.base, { recursive: true });

  // 0. 单一发起者
  let fd;
  try { fd = openSync(P.lock, 'wx'); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const age = now() - (statSync(P.lock).mtimeMs ?? now());
    if (age > LOCK_STALE_MS) {
      const day = localDate(now());
      if (readJson(P.stuck)?.日期 !== day) { writeReplace(P.stuck, { 日期: day }); return ['补跑检查卡住，待核（锁文件比时限的两倍还老，没有抢锁）']; }
    }
    return [];
  }
  try {
    writeFileSync(fd, JSON.stringify({ 开始毫秒: now(), pid: process.pid }));
    closeSync(fd);
    run(P, deps, now, gapMs, bench, lines, log);
  } finally {
    try { unlinkSync(P.lock); } catch { /* 锁已经没了 */ }
  }
  return lines;
}

function run(P, deps, now, gapMs, bench, lines, log) {
  const jobs = deps.listJobs();
  const ownJob = jobs.find((j) => j.name === '额度补跑');
  settleNotices(P, deps, ownJob, now);

  for (const task of Object.keys(TASKS)) {
    // Cleanup: 测试台模式只处理映射过的测试任务，没映射的不按真名去查真实任务
    if (bench && !Object.prototype.hasOwnProperty.call(bench.测试任务名 ?? {}, task)) { log(`${task}：测试台模式没有映射这个任务，跳过（不去查真实任务）`); continue; }
    const jobName = bench?.测试任务名?.[task] ?? task;
    const matches = jobs.filter((j) => j.name === jobName);
    if (matches.length !== 1) { log(`${task}：任务对不上（${matches.length} 个同名），不发起`); continue; }
    const job = matches[0];
    const runs = deps.listRuns(job.id).filter((e) => e.action === undefined || e.action === 'finished');
    let touched = false;

    // 3. 先收尾所有没收尾的账（含跨了业务日期的旧账）
    for (const acc of listAccounts(P, task)) {
      const s = stateName(acc.data.状态);
      if (TERMINAL.has(s) || s === '额度未恢复') continue;
      touched = true;
      finishAccount(P, task, job, acc, runs, deps, now, bench);
    }
    if (touched) continue;

    // 4. 没有待收尾的账：找最近这一两轮里因订阅额度失败的运行（补跑自己的运行不算新的一轮失败）
    const horizon = task === '周审' ? 8 * 86400000 : 30 * 3600000;
    const own = new Set(listAccounts(P, task).flatMap((a) => (a.data.尝试 ?? []).map((x) => x.运行编号)));
    const quotaRuns = runs.filter((e) => e.runAtMs >= now() - horizon && !own.has(e.runId) && classify(e, bench).kind === 'quota');
    if (quotaRuns.length === 0) continue;
    const last = quotaRuns.reduce((x, y) => (endedAt(y) > endedAt(x) ? y : x));
    // 失败属于哪一轮：按失败那次运行对上的“任务开始”事件存档里的计划算；对不上存档才退而用现在的计划（这种情况最后会判“计划未知”）
    const snapshot = matchArchive(P, job.id, last.runAtMs);
    const due = previousOccurrence(snapshot?.计划 ?? job.schedule, last.runAtMs);
    if (!due) { log(`${task}：读不出失败那一轮的原定轮次`); continue; }
    const date = due.businessDate;
    const accFile = P.account(task, date);
    const existing = readJson(accFile);
    if (existing && TERMINAL.has(stateName(existing.状态))) continue;
    if (roundDone(P, task, date)) continue;
    const nextDue = nextOccurrence(snapshot?.计划 ?? job.schedule, due.atMs);
    if (runs.some((e) => classify(e, bench).kind === 'ok' && e.runAtMs >= due.atMs && (!nextDue || e.runAtMs < nextDue.atMs))) continue; // 本轮已有成功的运行：以本轮记录为准，不补
    decideAndLaunch(P, task, job, last, snapshot, due, nextDue, existing, accFile, deps, now, gapMs, bench, lines, log);
  }
  emitNotices(P, now, lines);
}

// 7. 判断并发起
function decideAndLaunch(P, task, job, last, snapshot, due, nextDue, existing, accFile, deps, now, gapMs, bench, lines, log) {
  const date = due.businessDate;
  const tries = existing?.尝试 ?? [];
  const k = tries.length + 1;
  const lastText = classify(last, bench).text ?? errorText(last);
  const base = existing ?? {
    任务: task, 任务编号: job.id, 业务日期: date, 状态: '准备中', 尝试: [],
    失败登记: { 运行编号: last.runId, 开始毫秒: last.runAtMs, 结束毫秒: endedAt(last), 型号: last.model ?? null, 报错: lastText.slice(0, 200) },
  };
  const close = (state, reason, notice) => {
    const acc = { ...base, 状态: `${state}${reason ? `（${reason}）` : ''}` };
    if (notice) acc.通知 = { 文字: notice, 状态: '待交出' };
    saveAccount(accFile, acc, now);
  };
  if (k > MAX_TRIES) { close('补跑失败', '额度两次未恢复', `补跑失败：${task}（${date}）额度两次未恢复，不再试`); return; }
  // 计划快照：必须唯一对上“任务开始”事件存档；事后读到的计划不能顶替失败时的计划
  const origin = existing?.原计划快照 ?? snapshot?.计划;
  if (!origin) { close('不再补跑', '原计划未知', null); return; }
  base.原计划快照 = origin;
  base.检查时现状 = { 计划: job.schedule };
  if (!job.enabled) { close('不再补跑', '任务已停用', null); return; }
  if (JSON.stringify(job.schedule) !== JSON.stringify(origin)) { close('不再补跑', '改过计划', null); return; }
  // 原定那一轮和官方重试都已结束：没有正在跑的；官方下次运行时间已回到下一轮原定时间；最后一次运行结束满 10 分钟
  if (job.state?.runningAtMs) { log(`${task}：任务正在跑，等`); return; }
  if (nextDue && Number.isFinite(job.state?.nextRunAtMs) && Math.abs(job.state.nextRunAtMs - nextDue.atMs) > 60000) { log(`${task}：官方下次运行时间还没回到下一轮，等官方重试`); return; }
  if (now() - endedAt(last) < (bench?.结算毫秒 ?? SETTLE_MS)) { log(`${task}：最后一次失败结束还不满 10 分钟，等`); return; }

  // 最早可试时间：报错里的恢复时间优先，次选 CodexBar 重置时间，再次失败＋5 小时；第 2 次取较晚者
  const text = base.失败登记.报错 ?? lastText; // 第 2 次用第 1 次补跑被拒时的新报错（里面有新的恢复时间）
  const failedAt = base.失败登记.结束毫秒 ?? endedAt(last);
  const reading = deps.codexbar?.();
  const fromError = resetAt(text, failedAt);
  const reference = windowResetAt(reading, base.失败登记.型号 ?? job.payload?.model, text, now);
  let earliest = fromError ?? reference ?? failedAt + FALLBACK_AFTER_MS;
  if (k >= 2) earliest = Math.max(earliest, tries[tries.length - 1].发起时间毫秒 + gapMs);
  const nearMs = TASKS[task].近线小时 * 3600000;
  const effective = Math.max(now(), earliest);
  if (nextDue && nextDue.atMs - effective < nearMs) {
    close('已跳过', '离下一轮太近', `已跳过：${task}（${date}）离下一轮太近，不补了`);
    return;
  }
  if (now() < earliest) { log(`${task}：还没到最早可试时间 ${fmt(earliest)}`); return; }
  if (reference && reference > now()) { log(`${task}：CodexBar 参考读数显示额度还没恢复，推迟到 ${fmt(reference)} 之后`); return; }

  // 先记账再发起
  const attempt = { 序号: k, 记账时间毫秒: now(), 发起时间毫秒: now(), 状态: '准备发起' };
  const acc = { ...base, 状态: `准备发起（第 ${k} 次）`, 尝试: [...tries, attempt] };
  saveAccount(accFile, acc, now);
  let out = '';
  try { out = deps.runJob(job.id); } catch (e) { log(`${task}：发起命令报错，保持“准备发起”，下次去核：${String(e.message).slice(0, 100)}`); return; }
  const runId = parseRunId(out, job.id);
  if (!runId) { log(`${task}：发起命令没返回运行编号，保持“准备发起”`); return; }
  acc.尝试[acc.尝试.length - 1] = { ...attempt, 状态: '已发起', 运行编号: runId };
  acc.状态 = `已发起（第 ${k} 次）`;
  saveAccount(accFile, acc, now);
}

export function parseRunId(out, jobId) {
  const text = String(out ?? '');
  try {
    const j = JSON.parse(text);
    const walk = (v) => {
      if (typeof v === 'string' && v.startsWith(`cron:${jobId}:`)) return v;
      if (v && typeof v === 'object') for (const x of Object.values(v)) { const r = walk(x); if (r) return r; }
      return null;
    };
    const hit = walk(j);
    if (hit) return hit;
    if (typeof j?.runId === 'string') return j.runId;
  } catch { /* 不是 JSON，按文字找 */ }
  return new RegExp(`cron:${jobId}:\\d+:[^\\s"',]+`).exec(text)?.[0] ?? null;
}

function matchArchive(P, jobId, startMs) {
  if (!existsSync(P.archiveDir)) return null;
  const hits = readdirSync(P.archiveDir).filter((n) => n.startsWith(`${jobId}-`) && n.endsWith('.json'))
    .map((n) => readJson(join(P.archiveDir, n))).filter((a) => a && a.任务编号 === jobId && Math.abs(a.开始时间毫秒 - startMs) <= 1000 && a.计划);
  return hits.length === 1 ? hits[0] : null; // 漏存、对上不止一份 → 计划未知
}

// 这次补跑运行的实际用量：照实记“看到用量（多少）”或“看不到用量”；运行记录没有 usage 不等于零
export function usageNote(entry) {
  const u = entry?.usage;
  if (u && typeof u === 'object' && Object.keys(u).length > 0) return { 看到用量: true, 用量: u };
  return { 看到用量: false, 说明: '看不到用量（运行记录没有 usage，不等于零）' };
}

// 3. 收尾一份账
function finishAccount(P, task, job, acc, runs, deps, now, bench) {
  const d = acc.data;
  const date = d.业务日期;
  const k = d.尝试?.length ?? 0;
  const att = d.尝试?.[k - 1];
  const s = stateName(d.状态);
  const save = (state, notice) => saveAccount(acc.file, { ...d, 状态: state, ...(notice ? { 通知: { 文字: notice, 状态: '待交出' } } : {}) }, now);
  if (!att) { save('待核'); return; }
  if (s === '准备发起') {
    const after = runs.filter((e) => e.runAtMs >= att.发起时间毫秒 - 1000);
    if (after.length === 1) {
      const tries = [...d.尝试]; tries[k - 1] = { ...att, 状态: '已发起', 运行编号: after[0].runId };
      saveAccount(acc.file, { ...d, 状态: `已发起（第 ${k} 次）`, 尝试: tries }, now);
    } else if (after.length > 1) save('待核', `补跑待核：${task}（${date}），发起后出现了不止一条运行，不再自动发起`);
    else if (now() - att.发起时间毫秒 > PREPARED_WAIT_MS) save('待核', `补跑待核：${task}（${date}），没找到发起记录，不再自动发起`);
    return;
  }
  if (s !== '已发起') { save('待核'); return; }
  const entry = runs.find((e) => e.runId === att.运行编号);
  if (!entry) {
    if (now() - att.发起时间毫秒 > QUEUED_MAX_MS) save('补跑结果待核', `补跑结果待核：${task}（${date}），排队太久查不到结果，不再追加请求`);
    return; // 还在排队或跑：等，不能拿第二次名额重发
  }
  // 唯一对上：发起以后只能有这一条运行；运行不能跨进下一轮
  const dueAtLaunch = previousOccurrence(job.schedule, att.发起时间毫秒);
  const nextDue = dueAtLaunch ? nextOccurrence(job.schedule, dueAtLaunch.atMs) : null;
  const crossed = nextDue && entry.runAtMs >= nextDue.atMs;
  const others = runs.filter((e) => e.runAtMs >= att.发起时间毫秒 - 1000 && e.runId !== entry.runId);
  const verdict = classify(entry, bench);
  if (crossed || others.length > 0) {
    save('补跑结果待核', `补跑结果待核：${task}（${date}），查不清这条运行属于哪一轮，不再追加请求`);
    return;
  }
  if (verdict.kind === 'ok') {
    const tries = [...d.尝试]; tries[k - 1] = { ...att, 结束毫秒: endedAt(entry), 实际用量: usageNote(entry) }; d.尝试 = tries;
    if (roundDone(P, task, date)) save('已补跑', `已补跑：${task}（${date}）`);
    else save('补跑结果待核', `补跑结果待核：${task}（${date}），运行成功但本轮记录或发送凭据没核过`);
    return;
  }
  if (verdict.kind === 'quota') {
    const tries = [...d.尝试]; tries[k - 1] = { ...att, 状态: '额度未恢复', 结束毫秒: endedAt(entry), 报错: verdict.text.slice(0, 200), 实际用量: usageNote(entry) };
    if (k >= MAX_TRIES) {
      saveAccount(acc.file, { ...d, 尝试: tries, 状态: '补跑失败（额度两次未恢复）', 通知: { 文字: `补跑失败：${task}（${date}）额度两次未恢复，不再试`, 状态: '待交出' } }, now);
    } else {
      saveAccount(acc.file, { ...d, 尝试: tries, 状态: `额度未恢复（第 ${k} 次）`, 失败登记: { ...d.失败登记, 结束毫秒: endedAt(entry), 型号: entry.model ?? d.失败登记?.型号, 报错: verdict.text.slice(0, 200) } }, now);
    }
    return;
  }
  { const tries = [...d.尝试]; tries[k - 1] = { ...att, 结束毫秒: endedAt(entry), 实际用量: usageNote(entry) }; d.尝试 = tries; }
  save(`补跑失败（${verdict.reason}）`, `补跑失败：${task}（${date}）${verdict.reason}，不再试`);
}

// 10. 通知：每个任务每个业务日期每种只一次；先记账再交出；下一次核投递状态，不重发
function emitNotices(P, now, lines) {
  for (const task of Object.keys(TASKS)) {
    for (const acc of listAccounts(P, task)) {
      if (acc.data.通知?.状态 !== '待交出') continue;
      lines.push(acc.data.通知.文字);
      saveAccount(acc.file, { ...acc.data, 通知: { ...acc.data.通知, 状态: '已交出待核', 交出时间毫秒: now() } }, now);
    }
  }
}
function settleNotices(P, deps, ownJob, now) {
  let ownRuns = null;
  for (const task of Object.keys(TASKS)) {
    for (const acc of listAccounts(P, task)) {
      const n = acc.data.通知;
      if (n?.状态 !== '已交出待核') continue;
      ownRuns ??= ownJob ? deps.listRuns(ownJob.id) : [];
      const hit = ownRuns.filter((e) => e.runAtMs >= n.交出时间毫秒 - 600000 && endedAt(e) >= n.交出时间毫秒).sort((a, b) => a.runAtMs - b.runAtMs)[0];
      let state = null;
      if (hit) state = hit.delivered === true || hit.deliveryStatus === 'delivered' ? '已送达' : (hit.deliveryStatus === 'not-requested' ? '待核' : '未送达');
      else if (now() - n.交出时间毫秒 > 30 * 60000) state = '待核';
      if (state) saveAccount(acc.file, { ...acc.data, 通知: { ...n, 状态: state } }, now);
    }
  }
}

// ---------- 命令行 ----------
function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const testBench = opt('--test-bench');
  let dataRoot = opt('--data-root') ?? DEFAULT_DATA_ROOT;
  let bench = null;
  if (testBench) {
    dataRoot = testBench;
    bench = readJson(join(testBench, '测试开关.json')) ?? {};
  }
  try {
    const lines = runCatchup({ dataRoot, bench, log: (m) => process.stderr.write(`${m}\n`) });
    console.log(lines.length ? lines.join('\n') : 'NO_REPLY');
  } catch (e) {
    console.error(`额度补跑出错：${e.message}`);
    process.exit(1);
  }
}
if (process.argv[1]?.endsWith('quota-catchup.mjs')) main();

