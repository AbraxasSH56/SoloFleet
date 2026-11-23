#!/usr/bin/env node
// Pending list of decisions not yet written into the decision ledger; wakes the controller when entries are older than a day.
// 总控把它写进 资料/决定账本.md 后标“已入账”
// 定时任务每天 17:20 跑一次检查（不调模型）：没有待补就静默，有待补且最早一条超过 24 小时才叫醒总控，叫满 3 次或拖过 3 天在工坊说一句。
// 待补.json 是真账，只由本脚本改（加锁、原子替换）；待补清单.md 是脚本自动生成的“给人和总控看的版本”。bot 不手改这两个文件。
// 用法：
//   node ledger-watch.mjs list [--all]
//   node ledger-watch.mjs done <编号> --ledger-id D-0xx
//   node ledger-watch.mjs void <编号>        只许作废带“测试”标记的条目
//   node ledger-watch.mjs commit [--dry-run] 手动提交决定账本（只提交 资料根/决定账本.md 这一个文件，不 push；--dry-run 只说会提交什么）
//   node ledger-watch.mjs                    定时任务入口（先兜底提交账本，再检查、叫醒、提示；输出 NO_REPLY）
// 选项：--data-root <资料根>（只给离线测试用）
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { DAY_MS, DEFAULT_DATA_ROOT, NODE_BIN, atomicWriteJson, localParts, localIso, isRealDate, join, parseJsonLoose, readJson, realRunner, realSend, withLock, writeTextAtomic } from './gap-common.mjs';

import { crew } from '../../plugins/personal-inbox/crew-config.mjs';
import { lexicon } from '../../plugins/personal-inbox/lexicon.mjs';
const W = lexicon(); // words follow config "locale" (zh-CN: the literals this script always used)
export const WAKE_AFTER_MS = 24 * 3600000;
export const WAKE_MAX = 3;
export const STALE_NOTICE_MS = 3 * DAY_MS;
const SCRIPT = join(crew.paths.projectRoot, 'scripts', 'automation', 'ledger-watch.mjs');

export function paths(dataRoot) {
  const dir = join(dataRoot, W.layout.runLogs, W.layout.runLogDirs.ledgerBacklog);
  return { dir, data: join(dir, '待补.json'), view: join(dir, '待补清单.md'), lock: join(dir, '.待补.lock'), ledger: join(dataRoot, W.layout.ledgerFile) };
}
const ms = (s) => { const v = Date.parse(s ?? ''); return Number.isFinite(v) ? v : null; };
const emptyData = () => ({ 下个编号: 1, 条目: [], 已叫醒批次: [], 提示: { 超3天上次: null, 叫满: {} } });

export function renderView(data, nowMs) {
  const pend = data.条目.filter((e) => e.状态 === '待补');
  const done = data.条目.filter((e) => e.状态 === '已入账');
  const B = W.ledgerBacklog;
  const lines = [`# ${B.title}`, '', B.note(localIso(nowMs), pend.length, done.length), ''];
  lines.push(B.pendingHead, '');
  if (!pend.length) lines.push(B.none);
  for (const e of pend) lines.push(B.entryHead(e.编号, e.测试, e.标题), B.date(e.日期), B.quote(e.原话), ...(e.行号 ? [B.position(e.行号)] : []), B.added(e.添加时间), '');
  lines.push(B.doneHead, '');
  for (const e of done.slice(-20)) lines.push(B.doneLine(e.编号, e.标题, e.账本编号, e.完成时间));
  return lines.join('\n') + '\n';
}

function save(p, data, nowMs) { atomicWriteJson(p.data, data); writeTextAtomic(p.view, renderView(data, nowMs)); }

// ---------- 账本自动提交 ----------
// 只提交 <资料根>/决定账本.md 这一个文件；不 push；资料根里别的没提交的改动（比如 INDEX.md）一概不带进去（git commit -- 路径）。
// 触发点：①done 标已入账之后；②每天 17:20 定时检查开头（兜底）；③手动 commit。任何出错只写日志，不抛错、不影响调用方。
// deps.git(args) 没有就整个跳过（离线老测试不用改）；真实运行时由 realDeps 给 /usr/bin/git，node --test 环境下默认不给。
export const GIT_BIN = '/usr/bin/git';
export const LEDGER_FILE = W.layout.ledgerFile;
const gitErr = (r) => String(r?.stderr || r?.stdout || '').split('\n').find((l) => l.trim())?.trim().slice(0, 200) || `退出码 ${r?.code}`;

function writeCommitLog(deps, { 触发, 结果, 提交号 = '', 原因 = '' }) {
  try {
    const dir = paths(deps.dataRoot).dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = join(dir, '运行.log');
    const fresh = !existsSync(f);
    appendFileSync(f, `${localIso(deps.now())} 触发=${触发} 结果=${结果}${提交号 ? ` 提交号=${提交号}` : ''}${原因 ? ` 原因=${原因}` : ''}\n`, { mode: 0o600 });
    if (fresh) chmodSync(f, 0o600);
  } catch { /* 日志写不了也不影响 */ }
}

export function commitMessage(deps, 编号) {
  const date = localParts(deps.now()).date;
  return Array.isArray(编号) && 编号.length
    ? W.ledgerBacklog.commitWithIds(date, 编号.join(W.listSep))
    : W.ledgerBacklog.commitFallback(date);
}

export async function commitLedger(deps, { 触发 = '手动', 编号 = null, dryRun = false } = {}) {
  const done = (动作, 提交号 = '', 原因 = '', writeLog = true) => {
    if (writeLog) writeCommitLog(deps, { 触发, 结果: 动作, 提交号, 原因 });
    return { 动作, 提交号, 原因 };
  };
  try {
    if (typeof deps.git !== 'function') return { 动作: '未启用', 提交号: '', 原因: '没有 git 工具' };
    const root = deps.dataRoot;
    const git = (args) => deps.git(['-C', root, ...args]);
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    // 1 认仓库：资料根必须正好是仓库根，免得把东西提交进上一层的仓库
    const top = git(['rev-parse', '--show-toplevel']);
    let sameRoot = false;
    try { sameRoot = top.code === 0 && realpathSync(String(top.stdout).trim()) === realpathSync(root); } catch { sameRoot = false; }
    if (!sameRoot) return done('跳过', '', '资料根不是 Git 仓库根');
    // 2 账本文件不在（被删或被挪走）就不提交：免得把"删除"当成一次正常提交盖过去
    if (!existsSync(join(root, LEDGER_FILE))) return done('跳过', '', '账本文件不在，没提交');
    // 看账本有没有没提交的改动
    const st = git(['status', '--porcelain', '--', LEDGER_FILE]);
    if (st.code !== 0) return done('失败', '', `查账本状态失败：${gitErr(st)}`);
    const line = String(st.stdout).trim();
    if (!line) return { 动作: '无改动', 提交号: '', 原因: '' };
    if (line.startsWith('??')) return done('跳过', '', '账本没被 Git 跟踪');
    if (line[0] === 'D' || line[1] === 'D') return done('跳过', '', '账本文件不在，没提交');
    // 3 演习：只说会提交什么
    if (dryRun) {
      const ns = git(['diff', '--numstat', '--', LEDGER_FILE]);
      const [add = '?', del = '?'] = String(ns.stdout).trim().split(/\s+/);
      return { 动作: '演习', 提交号: '', 原因: `会提交：${LEDGER_FILE}（加 ${add} 行、减 ${del} 行）` };
    }
    // 4 提交；碰到 index.lock（别的会话正在提交）等 5 秒只重试一次，不删锁
    const run = async (args) => {
      let r = git(args);
      if (r.code !== 0 && /index\.lock/.test(String(r.stderr))) { await sleep(5000); r = git(args); }
      return r;
    };
    const a = await run(['add', '--', LEDGER_FILE]);
    if (a.code !== 0) return done('失败', '', /index\.lock/.test(String(a.stderr)) ? '仓库正忙（index.lock）' : `add 失败：${gitErr(a)}`);
    const c = await run(['commit', '-m', commitMessage(deps, 编号), '--', LEDGER_FILE]);
    if (c.code !== 0) return done('失败', '', /index\.lock/.test(String(c.stderr)) ? '仓库正忙（index.lock）' : `commit 失败：${gitErr(c)}`);
    // 5 读回
    const lg = git(['log', '-1', '--format=%h', '--', LEDGER_FILE]);
    const st2 = git(['status', '--porcelain', '--', LEDGER_FILE]);
    const hash = String(lg.stdout).trim();
    if (st2.code !== 0 || String(st2.stdout).trim()) return done('失败', hash, '提交后账本仍有改动');
    return done('已提交', hash);
  } catch (e) {
    try { writeCommitLog(deps, { 触发, 结果: '失败', 原因: `意外：${String(e?.message ?? e).slice(0, 200)}` }); } catch { /* 忽略 */ }
    return { 动作: '失败', 提交号: '', 原因: `意外：${String(e?.message ?? e).slice(0, 200)}` };
  }
}
export const commitSummary = (c) => `${c.动作}${c.提交号 ? ` ${c.提交号}` : ''}${c.原因 ? `（${c.原因}）` : ''}`;

// ---------- 命令 ----------
export async function cmdAdd(deps, a) {
  if (!isRealDate(a.日期)) { deps.out(`日期不对：${a.日期 ?? '没给'}（要 YYYY-MM-DD）`); return 2; }
  if (!a.标题?.trim() || !a.原话?.trim()) { deps.out('标题和原话都要给。'); return 2; }
  const p = paths(deps.dataRoot);
  const res = await withLock(p.lock, async () => {
    const data = readJson(p.data, null) ?? emptyData();
    const dup = data.条目.find((e) => e.状态 !== '测试作废' && e.日期 === a.日期 && e.标题 === a.标题.trim() && e.原话 === a.原话.trim());
    if (dup) { deps.out(`已经登记过了：编号 ${dup.编号}（状态：${dup.状态}）。`); return 0; }
    const e = { 编号: data.下个编号++, 日期: a.日期, 标题: a.标题.trim(), 原话: a.原话.trim(), 行号: a.行号 ?? null, 状态: '待补', 添加时间: localIso(deps.now()), 测试: !!a.测试 };
    data.条目.push(e);
    save(p, data, deps.now());
    deps.out(`已登记：编号 ${e.编号}。`);
    return 0;
  }, { now: deps.now });
  return res.busy ? (deps.out('待补单正忙，请稍后再试。'), 1) : res.value;
}

export async function cmdList(deps, all = false) {
  const data = readJson(paths(deps.dataRoot).data, null) ?? emptyData();
  const rows = data.条目.filter((e) => all || e.状态 === '待补');
  if (!rows.length) { deps.out(all ? '待补单是空的。' : '没有待补的。'); return 0; }
  for (const e of rows) deps.out(`${e.编号}｜${e.状态}${e.测试 ? '｜测试' : ''}｜${e.日期}｜${e.标题}｜原话：${e.原话}${e.行号 ? `｜位置：${e.行号}` : ''}${e.账本编号 ? `｜账本：${e.账本编号}` : ''}`);
  return 0;
}

export async function cmdDone(deps, id, ledgerId) {
  const n = Number(id);
  if (!Number.isInteger(n)) { deps.out(`编号不对：${id}`); return 2; }
  if (!/^[A-Z]-\d{3,}$/.test(String(ledgerId ?? ''))) { deps.out(`账本编号格式不对：${ledgerId ?? '没给'}（要像 D-052）`); return 2; }
  const p = paths(deps.dataRoot);
  let marked = false, isTest = false;
  const res = await withLock(p.lock, async () => {
    const data = readJson(p.data, null);
    const e = data?.条目.find((x) => x.编号 === n);
    if (!e) { deps.out(`没有编号 ${n}。`); return 1; }
    if (e.状态 === '已入账') { deps.out(`${n} 早就标过已入账了（${e.账本编号}）。`); return 0; }
    if (e.状态 !== '待补') { deps.out(`${n} 现在是“${e.状态}”，不能标已入账。`); return 1; }
    e.状态 = '已入账'; e.账本编号 = ledgerId; e.完成时间 = localIso(deps.now());
    marked = true; isTest = !!e.测试;
    save(p, data, deps.now());
    deps.out(`已标：${n} → ${ledgerId}。`);
    return 0;
  }, { now: deps.now });
  if (res.busy) return (deps.out('待补单正忙，请稍后再试。'), 1);
  // 标完以后（锁已放开）顺手提交一次账本；测试条目不触发；不管成不成，done 本身的结果不变
  if (res.value === 0 && marked && !isTest) {
    try {
      const c = await commitLedger(deps, { 触发: 'done', 编号: [n] });
      if (c.动作 !== '未启用') deps.out(`账本提交：${commitSummary(c)}`);
    } catch { /* 不影响 done */ }
  }
  return res.value;
}

export async function cmdVoid(deps, id) {
  const n = Number(id);
  const p = paths(deps.dataRoot);
  const res = await withLock(p.lock, async () => {
    const data = readJson(p.data, null);
    const e = data?.条目.find((x) => x.编号 === n);
    if (!e) { deps.out(`没有编号 ${id}。`); return 1; }
    if (!e.测试) { deps.out('只有带“测试”标记的条目才能作废。'); return 1; }
    if (e.状态 === '测试作废') { deps.out('早就作废了。'); return 0; }
    e.状态 = '测试作废'; e.完成时间 = localIso(deps.now());
    save(p, data, deps.now());
    deps.out(`已作废测试条目 ${n}。`);
    return 0;
  }, { now: deps.now });
  return res.busy ? (deps.out('待补单正忙，请稍后再试。'), 1) : res.value;
}

// ---------- 定时检查 ----------
export function wakeMessage(pend) {
  const test = pend.some((e) => e.测试);
  const base = W.wake.ledgerBacklog(pend.length, NODE_BIN, SCRIPT);
  return test ? W.wake.ledgerBacklogTest(base) : base;
}

export async function runCheck(deps) {
  const p = paths(deps.dataRoot);
  const nowMs = deps.now();
  // 兜底：账本有没提交的改动就提交一次（没有待补条目时也提交）。结果只写日志；定时任务的输出仍然只有 NO_REPLY。
  try { const c = await commitLedger(deps, { 触发: '定时兜底' }); if (c.动作 === '失败' || (c.动作 === '跳过' && /账本文件不在/.test(c.原因))) deps.warn(`账本提交没成：${c.原因}`); } catch { /* 不影响检查 */ }
  const res = await withLock(p.lock, async () => {
    const data = readJson(p.data, null);
    if (!data) return { 动作: '无' };
    const pend = data.条目.filter((e) => e.状态 === '待补');
    if (!pend.length) return { 动作: '无' };
    const oldest = Math.min(...pend.map((e) => ms(e.添加时间) ?? nowMs));
    const age = nowMs - oldest;
    const batch = pend.map((e) => e.编号).sort((a, b) => a - b).join(',');
    const acts = [];
    if (age >= WAKE_AFTER_MS) {
      let rec = data.已叫醒批次.find((b) => b.批次 === batch);
      if (!rec || (rec.次数 < WAKE_MAX && nowMs - ms(rec.最近时间) >= WAKE_AFTER_MS - 60000)) {
        const w = await deps.wake(wakeMessage(pend));
        if (w.ok) {
          if (!rec) { rec = { 批次: batch, 次数: 0, 最近时间: null }; data.已叫醒批次.push(rec); }
          rec.次数 += 1; rec.最近时间 = localIso(nowMs); acts.push('叫醒');
        } else deps.warn(`叫醒总控没成：${w.error ?? '未知'}`);
      } else if (rec.次数 >= WAKE_MAX && !data.提示.叫满[batch]) {
        const s = await deps.send(`【账本待补】还有 ${pend.length} 条决定没写进账本，已经叫过总控 ${WAKE_MAX} 次没补上，请人看一下。`);
        if (s.ok) { data.提示.叫满[batch] = localIso(nowMs); acts.push('叫满提示'); } else deps.warn(`叫满提示没发出去：${s.error}`);
      }
    }
    if (age >= STALE_NOTICE_MS && (!data.提示.超3天上次 || nowMs - ms(data.提示.超3天上次) >= STALE_NOTICE_MS)) {
      const s = await deps.send(`【账本待补】账本还有 ${pend.length} 条决定没补，最早一条已经 ${Math.floor(age / DAY_MS)} 天了，请看一下。`);
      if (s.ok) { data.提示.超3天上次 = localIso(nowMs); acts.push('超3天提示'); } else deps.warn(`超3天提示没发出去：${s.error}`);
    }
    if (acts.length) save(p, data, nowMs);
    return { 动作: acts.join('、') || '无' };
  }, { now: deps.now });
  if (res.busy) { deps.warn('待补单正忙，本轮跳过'); return { 动作: '忙' }; }
  return res.value;
}

export function realDeps(env = process.env, dataRoot = DEFAULT_DATA_ROOT) {
  const run = realRunner(env);
  return {
    now: () => Date.now(), dataRoot, send: realSend(run),
    // 叫醒总控：建一次性小任务（用完自动删），照 pending-decisions.mjs 的做法；发消息叫不醒她（消息是她自己账号发的）
    wake: async (message) => {
      const r = run(['automations', 'add', '--name', `${W.wake.ledgerBacklogJob}${localParts(Date.now()).date}`, '--at', '1m', '--agent', 'main', '--session', 'isolated', '--message', message, '--no-deliver', '--delete-after-run', '--json'], { timeout: 60000 });
      if (r.code !== 0) return { ok: false, error: `automations add 退出码 ${r.code}` };
      try { const d = parseJsonLoose(r.stdout); const id = d.id ?? d.job?.id ?? d.payload?.id ?? null; return id ? { ok: true, jobId: String(id) } : { ok: false, error: '没拿到任务编号' }; } catch (e) { return { ok: false, error: e.message }; }
    },
    // 账本自动提交用的 git：node --test 环境下默认不给（防止测试里真去动仓库），除非显式设 LEDGER_WATCH_ALLOW_GIT_IN_TEST=1
    git: (env.NODE_TEST_CONTEXT && env.LEDGER_WATCH_ALLOW_GIT_IN_TEST !== '1') ? null : (args) => {
      const r = spawnSync(GIT_BIN, args, { encoding: 'utf8', timeout: 20000, env: env });
      return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '' };
    },
    warn: (m) => process.stderr.write(`账本待补：${m}\n`), out: (m) => process.stdout.write(`${m}\n`),
  };
}

function argsOf(argv, flags) { const o = {}; for (const f of flags) { const i = argv.indexOf(`--${f}`); if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) o[f] = argv[i + 1]; } return o; }

export async function main(argv = process.argv.slice(2), deps = null) {
  const di = argv.indexOf('--data-root');
  const dataRoot = di >= 0 ? argv[di + 1] : (process.env.OPENCLAW_DATA_ROOT || DEFAULT_DATA_ROOT);
  const d = deps ?? realDeps(process.env, dataRoot);
  d.dataRoot = d.dataRoot ?? dataRoot;
  const di2 = argv.indexOf('--data-root'); // 子命令可以放在 --data-root 后面
  const rest = di2 >= 0 ? [...argv.slice(0, di2), ...argv.slice(di2 + 2)] : argv;
  const cmd = rest[0];
  if (cmd === 'add') { const e = argsOf(argv, ['date', 'title', 'quote', 'line']); return cmdAdd(d, { 日期: e.date, 标题: e.title, 原话: e.quote, 行号: e.line, 测试: argv.includes('--test') }); }
  if (cmd === 'list') return cmdList(d, argv.includes('--all'));
  if (cmd === 'done') return cmdDone(d, rest[1], argsOf(argv, ['ledger-id'])['ledger-id']);
  if (cmd === 'void') return cmdVoid(d, rest[1]);
  if (cmd === 'commit') {
    const c = await commitLedger(d, { 触发: '手动', dryRun: argv.includes('--dry-run') });
    d.out(`账本提交：${commitSummary(c)}`);
    return c.动作 === '失败' ? 1 : 0;
  }
  if (cmd && !cmd.startsWith('--')) { d.out(`不认识的命令：${cmd}（有 add／list／done／void／commit，或不带参数＝定时检查）`); return 2; }
  await runCheck(d);
  d.out('NO_REPLY');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().then((c) => process.exit(c)).catch((e) => { process.stderr.write(`账本待补失败：${e.message}\n`); process.exit(1); });
