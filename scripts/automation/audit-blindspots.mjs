#!/usr/bin/env node
// Daily blind-spot check for the system audit: rule-file fingerprints, rework counts and other things an audit cannot see. Read-only.
// 审计盲区抽查。固定脚本：不调模型、不发任何消息、不写异常标记、只读（只写自己的结果文件和规则文件基线）。
// 产出 <资料根>/审计/日审/<业务日期>-盲区抽查.md，日审开工时只读这个文件；周审只读每天的这份。
//   一、返工次数：任务板每张卡的事件记录里数“退回”次数，≥3 次的列出来（已归档的卡跳过；每张卡只在首次达到那天报一次）。
//   二、范围外文件：A 已有的规则文件（AGENTS.md／SOUL.md／IDENTITY.md）被改了没有；
//       B 审查区、角色名册、备份区里窗口内新增或改动的文件（只列路径分组和数量，不读内容）。~/OpenClaw 以外的地方不扫描。
//   三、备份状态：最新一份备份是否完整、含不含审查区和角色名册、异地最近成功、可清理几对、距上次真恢复演练多少天。
// 谁来启动：白天看护（day-watch.mjs）17:30 以后第一遍，用脱钩的子进程起它，看护自己照旧立刻退出。
// 保护：单条命令 20 秒，整个脚本 90 秒（到点强制结束）；一次只跑一份（锁文件）。读不到的一律写“未能检查：…（原因）”，不写成“没有”。
import { localDayStart } from '../../plugins/personal-inbox/tz.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { bizDateOf, localStamp, windowOf } from './daily-format-check.mjs';

import { crew } from '../../plugins/personal-inbox/crew-config.mjs';
import { lexicon, labelText } from '../../plugins/personal-inbox/lexicon.mjs';
const W = lexicon(); // folder and file names and report markers follow config "locale" (zh-CN: the literals this script always used)
import { locale } from '../../plugins/personal-inbox/lexicon.mjs';
const execFileAsync = promisify(execFile);
export const DATA_ROOT = process.env.OPENCLAW_DATA_ROOT || crew.paths.dataRoot; // env var first (offline tests), then config
export const PROJECT_ROOT = process.env.OPENCLAW_PROJECT_ROOT || crew.paths.projectRoot;
export const WORKSPACE_ROOT = process.env.OPENCLAW_RUNTIME_ROOT || crew.paths.workspaceRoot; // <workspaceRoot>/<agentId>/ holds the role rule files
// Optional areas of the reference deployment (a review folder, a roster folder, a backup folder). Not set or not there = skipped and reported as "未启用" (not enabled), never as incomplete.
export const AREAS = { review: process.env.OPENCLAW_BLIND_REVIEW || crew.auditAreas?.review || '', roster: process.env.OPENCLAW_BLIND_ROSTER || crew.auditAreas?.roster || '', backup: process.env.OPENCLAW_BLIND_BACKUP || crew.auditAreas?.backup || '' };
const syncLang = () => (locale() === 'zh-CN' ? 'zh-CN' : 'en');
export const LIMITS = { cmdMs: 20000, totalMs: 90000, lockStaleMs: 10 * 60 * 1000, reworkAt: 3, maxGroups: 30, drillStaleDays: 90, offsiteStaleDays: 9 };
const RULE_FILES = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md'];
const FROM_BACK = new Set(['running', 'blocked', 'done']);
const TO_TODO = new Set(['todo', 'ready']);
const FROM_STUCK = new Set(['blocked', 'done']);
const COMPLETE = new Set(['completed', 'partial_program_backup_failed']);

const atMs = (v) => (typeof v === 'number' ? v : Date.parse(v));
const jread = (p, fb = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fb; } };
function atomicWrite(path, text) { mkdirSync(join(path, '..'), { recursive: true }); const t = `${path}.tmp-${process.pid}`; writeFileSync(t, text, { mode: 0o644 }); renameSync(t, path); }
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const isArchived = (c) => Boolean(c?.metadata?.archivedAt ?? c?.archivedAt);

// ───── 一、返工次数 ─────
// 返工 = ①从 running／blocked／done 回到 todo／ready ＋ ②从 blocked／done 再进 running。attempt_updated 不计入门槛，只记条数作线索。
export function reworkOf(card) {
  const ev = [...(card.events ?? [])].filter((e) => e && e.kind === 'moved').sort((a, b) => atMs(a.at) - atMs(b.at));
  const times = [];
  for (const e of ev) {
    const from = String(e.fromStatus ?? '').toLowerCase(), to = String(e.toStatus ?? '').toLowerCase();
    if ((FROM_BACK.has(from) && TO_TODO.has(to)) || (FROM_STUCK.has(from) && to === 'running')) times.push(atMs(e.at));
  }
  return { count: times.length, reachedAt: times.length >= LIMITS.reworkAt ? times[LIMITS.reworkAt - 1] : null, attempts: (card.events ?? []).filter((e) => e?.kind === 'attempt_updated').length };
}
export function reworkReport(cards, startMs, endMs) {
  const hit = [], earlier = [];
  let max = { count: 0, id: null }, attemptNotes = 0, skipped = 0;
  for (const c of cards) {
    if (isArchived(c)) { skipped += 1; continue; }
    const r = reworkOf(c);
    attemptNotes += r.attempts;
    if (r.count > max.count) max = { count: r.count, id: c.id };
    if (r.count >= LIMITS.reworkAt) {
      const row = { id: c.id, title: String(c.title ?? '').slice(0, 40), count: r.count, reachedAt: r.reachedAt };
      (r.reachedAt >= startMs && r.reachedAt < endMs ? hit : earlier).push(row);
    }
  }
  return { hit, earlier, max, attemptNotes, skipped, total: cards.length };
}
function reworkSection(rep) {
  if (rep.error) return `未能检查：返工次数（${rep.error}）`;
  const lines = [`卡 ${rep.total} 张（已归档跳过 ${rep.skipped} 张）；返工次数最多的一张是 ${rep.max.count} 次${rep.max.id ? `（${rep.max.id}）` : ''}。定义：从“进行中／卡住／完成”退回“待办”的次数，加上从“卡住／完成”再进“进行中”的次数；≥${LIMITS.reworkAt} 次才列。“重新尝试”事件另有 ${rep.attemptNotes} 条（只作线索，不计入）。`];
  if (rep.hit.length) lines.push('', '**本轮首次达到的：**', ...rep.hit.map((x) => `- ${x.id}《${x.title}》返工 ${x.count} 次（第 ${LIMITS.reworkAt} 次发生在 ${localStamp(x.reachedAt)}）`));
  else lines.push('', '本轮没有卡首次达到。');
  if (rep.earlier.length) lines.push('', `之前已报过、仍未归档的：${rep.earlier.map((x) => `${x.id}（${x.count} 次）`).join('、')}`);
  return lines.join('\n');
}

// ───── 二 A、规则文件被改 ─────
export function listRuleFiles(workspaceRoot) {
  const out = [];
  const rt = workspaceRoot;
  let dirs = [];
  try { dirs = readdirSync(rt, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.')).map((d) => d.name).sort(); } catch { return out; }
  for (const d of dirs) for (const f of RULE_FILES) { const p = join(rt, d, f); if (existsSync(p)) out.push({ rel: `runtime/${d}/${f}`, path: p }); }
  return out;
}
export async function ruleFileReport({ projectRoot, workspaceRoot = join(projectRoot, 'runtime'), baselinePath, startMs, endMs, git }) {
  const files = listRuleFiles(workspaceRoot);
  const base = jread(baselinePath, null);
  const now = {};
  for (const f of files) { try { const st = statSync(f.path); now[f.rel] = { sha: sha(f.path), mtimeMs: st.mtimeMs }; } catch { /* 读不了的跳过 */ } }
  let syncNote = '';
  try { const st = statSync(join(workspaceRoot, '_shared', '.sync', syncLang(), 'fingerprints.json')); syncNote = st.mtimeMs >= startMs && st.mtimeMs < endMs ? '窗口内跑过共用规则同步（共用段变动属正常）' : '窗口内没有共用规则同步'; } catch { syncNote = '读不到同步指纹文件（无法判断窗口内有没有同步）'; }
  const changed = [], created = [];
  if (base) {
    for (const [rel, v] of Object.entries(now)) {
      if (!base.files?.[rel]) created.push(rel);
      else if (base.files[rel].sha !== v.sha) changed.push(rel);
    }
  }
  const rows = [];
  for (const rel of changed) {
    let g = null; try { g = await git(rel); } catch { g = null; }
    rows.push(`- ${rel}：内容变了（${String(base.files[rel].sha).slice(0, 8)} → ${now[rel].sha.slice(0, 8)}，改于 ${localStamp(now[rel].mtimeMs)}）；${g ? `Git 最近提交 ${g}` : '无 Git 提交可对照（要么不在 Git 里，要么还没提交）'}`);
  }
  // 基线等整份报告写完再更新（commit）：中途被强杀，下一遍还能把这次的改动报出来
  const commit = () => { if (baselinePath) { try { atomicWrite(baselinePath, JSON.stringify({ at: endMs, files: now })); } catch { /* 基线写不下：下次再比 */ } } };
  return { commit, first: !base, count: files.length, changed: rows, created, syncNote, baselineAt: base?.at ?? null };
}
function ruleSection(r) {
  if (r.error) return `未能检查：规则文件（${r.error}）`;
  if (r.first) return `首次建立基线：${r.count} 个规则文件（AGENTS.md／SOUL.md／IDENTITY.md，只算实际存在的）。明天起才和基线比。${r.syncNote}。`;
  const lines = [`和上一次基线（${localStamp(r.baselineAt)}）比，${r.count} 个规则文件里：${r.changed.length ? `${r.changed.length} 个内容变了` : '没有内容变了的'}${r.created.length ? `；新出现 ${r.created.length} 个（${r.created.join('、')}）` : ''}。${r.syncNote}。`];
  if (r.changed.length) lines.push('', ...r.changed, '', '（有 Git 提交＝开发会话改的，只作线索；无提交且文件刚变＝疑似 bot 或手工改，交日审判断，本脚本不记异常标记。）');
  return lines.join('\n');
}

// ───── 二 B、审查区／角色名册／备份区窗口内新增改动 ─────
const NORMAL_BACKUP = /^(consistent-checkpoints|scheduled-archives|异地暂存|backup-tmp|恢复演练-.*|清理摘要\.json|备份清理清单-最新\.(md|json)|异地状态\.json|异地备份\.log|受保护\.txt|异地上传范围\.json)$/; // 备份任务自己每天写的状态文件也算正常
export async function changedFiles(root, startMs, endMs, runFind, { prune = [] } = {}) {
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const args = [root];
  if (prune.length) { args.push('(', ...prune.flatMap((p, i) => (i ? ['-o', '-name', p] : ['-name', p])), ')', '-prune', '-o'); }
  args.push('-type', 'f', '-newermt', `${fmt(startMs)}Z`, '!', '-newermt', `${fmt(endMs)}Z`, '-print');
  const out = await runFind(args);
  const groups = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const rel = line.slice(root.length + 1).split('/');
    const key = rel.length > 2 ? `${rel[0]}/${rel[1]}` : rel[0];
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return groups;
}
function groupLines(groups, normalRe = null) {
  const rows = [...groups.entries()].sort((a, b) => b[1] - a[1]);
  const normal = normalRe ? rows.filter(([k]) => normalRe.test(k.split('/')[0])) : [];
  const other = normalRe ? rows.filter(([k]) => !normalRe.test(k.split('/')[0])) : rows;
  const out = other.slice(0, LIMITS.maxGroups).map(([k, n]) => `- ${k}：${n} 个文件`);
  if (other.length > LIMITS.maxGroups) out.push(`- …还有 ${other.length - LIMITS.maxGroups} 组没列`);
  if (normal.length) out.push(`- （正常备份目录：${normal.map(([k, n]) => `${k} ${n} 个`).join('、')}，不逐项列）`);
  return out;
}
async function outsideSection(runFind, startMs, endMs, areas = AREAS) {
  const parts = [];
  for (const [key, name, normalRe, prune] of [['review', '审查', null, ['恢复验证', '资料包', '.DS_Store']], ['roster', '角色名册', null, ['.DS_Store']], ['backup', '备份', NORMAL_BACKUP, ['.DS_Store']]]) {
    const root = areas[key];
    if (!root || !existsSync(root)) { parts.push(`### ${name}\n\n未启用（没配置，或目录不存在）。`); continue; }
    try {
      const g = await changedFiles(root, startMs, endMs, runFind, { prune });
      const lines = groupLines(g, normalRe);
      parts.push(`### ${name}\n\n窗口内新增或改动的文件按文件夹汇总（只列路径，不读内容）：${lines.length ? '\n' + lines.join('\n') : '无。'}`);
    } catch (e) { parts.push(`### ${name}\n\n未能检查：${String(e?.message ?? e).slice(0, 100)}。`); }
  }
  return parts.join('\n\n');
}

const archiveState = (a) => (!a ? '否' : a.ok === false ? '没打成' : a.liveChangedDuringCopy ? '是（打包时现场在变）' : '是');

// ───── 桌面角色屏幕锁日志里的识别统计（程序认出提交类点击的运行情况）─────
export function screenLockStats(logPath, startMs, endMs) {
  const out = { detected: 0, byVia: {}, unrecognized: 0, errors: 0, wordsUnreadable: 0, ok: true };
  let raw;
  try { raw = readFileSync(logPath, 'utf8'); } catch (e) { return e?.code === 'ENOENT' ? { ...out, nolog: true } : { ...out, ok: false, why: String(e?.message ?? e).slice(0, 60) }; }
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (typeof r.at !== 'number' || r.at < startMs || r.at >= endMs) continue;
    if (r.decision === 'sensitive-detected') { out.detected += 1; out.byVia[r.via ?? '?'] = (out.byVia[r.via ?? '?'] ?? 0) + 1; }
    else if (r.decision === 'sensitive-unrecognized') out.unrecognized += 1;
    else if (r.decision === 'sensitive-error') out.errors += 1;
    else if (r.decision === 'sensitive-words-unreadable') out.wordsUnreadable += 1;
  }
  return out;
}
function screenLockSection(st) {
  if (!st.ok) return `未能检查：桌面角色屏幕锁日志（${st.why}）`;
  if (st.nolog) return '桌面角色屏幕锁日志还不存在（还没有桌面角色动过屏幕，或日志位置不对）。';
  const via = Object.entries(st.byVia).map(([k, n]) => `${k} ${n}`).join('、');
  return `窗口内程序认出提交类点击 ${st.detected} 次${via ? `（按来源：${via}；回车类的次数多就该收窄）` : ''}；认不出的点击 ${st.unrecognized} 次；识别自己出错 ${st.errors} 次；词表读不到 ${st.wordsUnreadable} 次。（网页不认、鼠标点按钮按坐标反查已关闭：认出 0 次≠没发生提交。）`;
}

// ───── 三、备份状态 ─────
export function backupStatus({ backups, nowMs }) {
  const out = { lines: [], clues: [] };
  if (!backups || !existsSync(join(backups, 'consistent-checkpoints'))) return { lines: ['备份状态：未启用（没配置，或目录不存在）。'], clues: [], disabled: true };
  const dirs = (() => { try { return readdirSync(join(backups, 'consistent-checkpoints'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return null; } })();
  if (dirs === null) return { lines: ['未能检查：备份目录读不了。'], clues: ['备份状态：未能检查'] };
  let latest = null;
  for (const d of [...dirs].reverse()) { const m = jread(join(backups, 'consistent-checkpoints', d, 'manifest.json'), null); if (m) { latest = { d, m }; break; } }
  if (!latest) out.lines.push('最新一份备份：读不到清单。');
  else {
    const st = latest.m.status;
    const created = Date.parse(latest.m.created_at?.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z') ?? '');
    const age = Number.isNaN(created) ? null : Math.floor((nowMs - created) / 86400000);
    out.lines.push(`最新一份备份：${latest.d}（${st}${age !== null ? `，${age} 天前` : ''}）；含审查区包：${archiveState(latest.m.review_archive)}；含角色名册包：${archiveState(latest.m.roster_archive)}。`);
    if (!COMPLETE.has(st)) out.clues.push(`最新备份状态是 ${st}，不是完整的一份`);
    if (age !== null && age >= 2) out.clues.push(`最新备份已经 ${age} 天前`);
    for (const [k, label] of [['review_archive', '审查区包'], ['roster_archive', '角色名册包']]) {
      const a = latest.m[k];
      if (!a) out.clues.push(`最新备份不含${label}（备份加入它之前的，或这一步没做）`);
      else if (a.ok === false) out.clues.push(`最新备份的${label}没打成：${String(a.error ?? '').slice(0, 60)}`);
      else if (a.liveChangedDuringCopy) out.clues.push(`最新备份的${label}打包时现场一直在被写（包是完整可读的，内容可能差几个刚改的文件）`);
    }
  }
  const off = jread(join(backups, '异地状态.json'), null);
  if (!off) out.lines.push('异地备份：未启用（还没有状态文件）。');
  else {
    const last = off.lastSuccessDate ?? null;
    const days = last ? Math.floor((nowMs - localDayStart(last)) / 86400000) : null;
    out.lines.push(`异地备份：状态 ${off.status}；最近一次成功 ${last ?? '没有'}${days !== null ? `（${days} 天前）` : ''}${off.why ? `；${off.why}` : ''}${off.upload?.why ? `；${off.upload.why}` : ''}。`);
    if (off.status === 'waiting_confirm') out.clues.push('异地备份在等主人确认上传清单（只在本机打了包，没上传）');
    const cl = off.retention?.cleanable ?? [];
    if (cl.length) out.clues.push(`异地暂存里有 ${cl.length} 个超出保留份数的旧包可清理（要主人批准句）`);
    if (['failed', 'start_failed'].includes(off.status)) out.clues.push(`异地备份最近一次失败：${String(off.error ?? '').slice(0, 80)}`);
    if (days !== null && days > LIMITS.offsiteStaleDays) out.clues.push(`异地备份已 ${days} 天没成功`);
  }
  const sum = jread(join(backups, '清理摘要.json'), null);
  if (!sum) out.lines.push('备份清理摘要：还没有（每日备份外壳还没生成过）。');
  else out.lines.push(`备份清理：共 ${sum.pairsTotal} 对，可清理 ${sum.pairsCleanable} 对（约 ${(sum.cleanableBytes / 1e9).toFixed(1)}GB），要人看 ${sum.pairsNeedLook} 对；摘要生成于 ${sum.generatedAt}。清理要主人说批准句。`);
  // 真恢复演练：只认演练目录里正式演练写出的 演练结果.json（副本试启动＝通过，失败项＝0，目录名是 恢复演练-YYYYMMDD）；
  // 光有 恢复演练-* 目录不算，名字带“离线预演”等字样的、结果文件说失败或没做副本试启动的都不算。
  let drillMs = null, notCounted = 0;
  try {
    for (const d of readdirSync(backups)) {
      if (!/^恢复演练-/.test(d)) continue;
      const res = /^恢复演练-\d{8}(-\d+)?$/.test(d) ? jread(join(backups, d, '演练结果.json'), null) : null;
      if (res && res['副本试启动'] === '通过' && res['失败项'] === 0) { const t = Date.parse(res.finishedAt); if (!Number.isNaN(t) && (drillMs === null || t > drillMs)) drillMs = t; } else notCounted += 1;
    }
  } catch { /* 读不了 */ }
  const noteNot = notCounted ? `（另有 ${notCounted} 个演练目录因没有“副本试启动通过且失败项为 0”的结果文件，不算数）` : '';
  if (drillMs === null) { out.lines.push(`真恢复演练：还没做过正式的${noteNot}。`); out.clues.push('还没做过正式的真恢复演练'); }
  else { const days = Math.floor((nowMs - drillMs) / 86400000); out.lines.push(`真恢复演练：最近一次通过的在 ${days} 天前${noteNot}。`); if (days > LIMITS.drillStaleDays) out.clues.push(`距上次真恢复演练已 ${days} 天（超过 ${LIMITS.drillStaleDays} 天）`); }
  return out;
}

// ───── 主流程 ─────
export function realDeps(env = process.env) {
  const oc = env.OPENCLAW_BIN || crew.paths.openclawBin;
  return {
    now: () => Date.now(),
    async listCards() {
      const { stdout } = await execFileAsync(oc, ['workboard', 'list', '--json'], { encoding: 'utf8', timeout: LIMITS.cmdMs, maxBuffer: 64 * 1024 * 1024, env: { ...env, NODE_NO_WARNINGS: '1', PATH: `${dirname(process.execPath)}:${env.PATH ?? '/usr/bin:/bin'}` } }); // openclaw 命令靠 PATH 里的 node 起来（定时任务环境的 PATH 可能没有 node）
      return JSON.parse(stdout.slice(stdout.indexOf('{'))).cards ?? [];
    },
    async runFind(args) {
      const { stdout } = await execFileAsync('/usr/bin/find', args, { encoding: 'utf8', timeout: LIMITS.cmdMs, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    },
    async git(rel) {
      const { stdout } = await execFileAsync('/usr/bin/git', ['-C', PROJECT_ROOT, 'log', '-1', '--format=%h（%cI）', '--', rel], { encoding: 'utf8', timeout: LIMITS.cmdMs });
      return stdout.trim() || null;
    },
  };
}

export async function run({ dataRoot = DATA_ROOT, deps = realDeps(), nowMs = null, areas = AREAS, workspaceRoot = WORKSPACE_ROOT, projectRoot = PROJECT_ROOT } = {}) {
  const now = nowMs ?? deps.now();
  const { bizDate, startMs, endMs } = windowOf(now, dataRoot);
  const result = {};
  try { result.rework = reworkReport(await deps.listCards(), startMs, endMs); } catch (e) { result.rework = { error: String(e?.message ?? e).slice(0, 80) }; }
  try { result.rules = await ruleFileReport({ projectRoot, workspaceRoot, baselinePath: join(dataRoot, '运行记录', '盲区抽查', '规则文件基线.json'), startMs, endMs, git: deps.git }); } catch (e) { result.rules = { error: String(e?.message ?? e).slice(0, 80) }; }
  const outside = await outsideSection(deps.runFind, startMs, endMs, areas);
  const lockStats = screenLockStats(join(workspaceRoot, 'desktop', 'screen-lock.log'), startMs, endMs);
  const bk = backupStatus({ backups: areas.backup, nowMs: now });
  // 某一节读不到（写的是“未能检查”）：整份不能照样写“状态：完整”——写“不完整”并进线索汇总，看护下一遍会重试（它只认“状态：完整”）
  const incomplete = [];
  if (result.rework?.error) incomplete.push('返工次数');
  if (result.rules?.error) incomplete.push('规则文件');
  if (/未能检查/.test(outside)) incomplete.push('审查区／名册／备份区新增');
  if (!lockStats.ok) incomplete.push('桌面角色屏幕锁日志');
  if (bk.lines.some((l) => /未能检查/.test(l)) || bk.clues.some((c) => /未能检查/.test(c))) incomplete.push('备份状态');
  const clues = [];
  if (incomplete.length) clues.push(`盲区抽查这些小节未能检查：${incomplete.join('、')}（这份文件不算完整，看护会重试）`);
  if (result.rework?.hit?.length) clues.push(`返工 ≥${LIMITS.reworkAt} 次的卡 ${result.rework.hit.length} 张`);
  if (result.rules?.changed?.length) clues.push(`规则文件内容变了 ${result.rules.changed.length} 个`);
  if (lockStats.ok && (lockStats.errors || lockStats.wordsUnreadable)) clues.push(`桌面角色提交类点击识别出错 ${lockStats.errors} 次、词表读不到 ${lockStats.wordsUnreadable} 次（识别可能没在起作用）`);
  clues.push(...bk.clues);
  const text = [
    `# 盲区抽查 · ${bizDate}`, '',
    `${labelText(W.businessDateLabel)}${bizDate}`, `窗口：${localStamp(startMs)} → ${localStamp(endMs)}（本地时区）`, `生成时间：${new Date(now).toISOString()}`,
    '说明：脚本自己生成，只读；只放数量和文件夹分组，不放内容；日审只读本文件，周审也只读这份。读不到的写“未能检查”，不写“没有”。', '',
    '## 线索汇总', '', clues.length ? clues.map((c) => `- ${c}`).join('\n') : '无', '',
    '## 一、返工次数', '', reworkSection(result.rework), '',
    '## 二、范围外文件（补文件管理那份没盖的）', '', '### A 规则文件被改', '', ruleSection(result.rules), '', outside, '',
    '### B2 桌面角色提交类点击识别的运行情况（来自屏幕锁日志）', '', screenLockSection(lockStats), '',
    '### C ~/OpenClaw 以外的地方', '', '不扫描（全局规矩不扫描个人文件夹、照片、云同步目录）。这些地方只能靠命令抽查里 bot 的命令指向它们来发现——**这是一个明确的看不到的地方**。', '',
    '## 三、备份状态', '', ...bk.lines.map((l) => `- ${l}`), '',
    incomplete.length ? `${labelText(W.statusLabel)}${W.reportIncomplete}（未能检查：${incomplete.join('、')}）` : `${labelText(W.statusLabel)}${W.reportComplete}`, '',
  ].join('\n');
  atomicWrite(join(dataRoot, W.layout.audit, W.layout.auditDaily, `${bizDate}-${W.layout.dailyFiles.blindspot}`), text);
  try { result.rules?.commit?.(); } catch { /* 基线更新失败不影响报告 */ }
  return { bizDate, incomplete, clues: clues.length, summary: { rework: result.rework?.hit?.length ?? null, rulesChanged: result.rules?.changed?.length ?? null } };
}

export async function main() {
  const stateDir = join(DATA_ROOT, '运行记录', '盲区抽查');
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
  const totalMs = Number(process.env.OPENCLAW_BLIND_TOTAL_MS) || LIMITS.totalMs; // 环境变量只给离线测试缩短用，正式不设
  const killer = setTimeout(() => { log(`超过总时限 ${totalMs / 1000} 秒，强制结束`); try { rmSync(lock); } catch { /* 已清理 */ } process.exit(3); }, totalMs);
  try { const r = await run({}); log(`完成 ${JSON.stringify(r)}`); return 0; }
  catch (e) { log(`失败：${String(e?.stack ?? e).slice(0, 400)}`); return 1; }
  finally { clearTimeout(killer); try { rmSync(lock); } catch { /* 已清理 */ } }
}

if (process.argv[1]?.endsWith('audit-blindspots.mjs')) main().then((c) => process.exit(c));
