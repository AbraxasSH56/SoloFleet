#!/usr/bin/env node
// Command line for project files: new-project, new-task, add-result, check-project, scan. Thin wrapper; the logic lives in plugins/personal-inbox/project-files.mjs.
// 项目文件命令行（薄薄一层，逻辑都在 plugins/personal-inbox/project-files.mjs）。
// 用法（Node 请用完整路径 /usr/local/bin/node）：
//   new-project --name <项目名> --channel-id <频道编号> --channel-name <频道名> --lead <主责bot显示名> --goal <一句话目标>
//   new-task    --project <项目名> --title <任务标题> --thread-link <线程链接> --executor <bot显示名> --quote <主人原话> [--quote-date <日期>] [--card-id <任务卡号>] [--goal <一句话>]
//   add-result  --project <项目名> --name <成果名> (--path 成果/<文件名> | --outside <说明>) --note <一句话>
//   check-project --project <项目名>
//   scan [--out <文件>] [--date <业务日期>] [--workspaces <角色=目录,角色=目录,...>] [--no-write]
// 输出一段 JSON；退出码 0＝成功，1＝被拒绝或出错（message 里写原因），2＝用法错误。
// Data root: env var OPENCLAW_DATA_ROOT first, then config paths.dataRoot.
import { mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { newProject, newTask, addResult, checkProject, scan, atomicWrite } from '../../plugins/personal-inbox/project-files.mjs';
import { ensureLeadFree, leadFreeMode, runnerFor } from './lead-free.mjs';

import { crew } from '../../plugins/personal-inbox/crew-config.mjs';
const DATA_ROOT = process.env.OPENCLAW_DATA_ROOT || crew.paths.dataRoot;
const RUNTIME_ROOT = process.env.OPENCLAW_RUNTIME_ROOT || crew.paths.workspaceRoot;

// 给主责开免点名。只有"正式环境"，或"假命令＋假配置两个替身都给了"才真调；
// 否则（离线测试、换了数据根、有 NODE_TEST_CONTEXT）一律跳过，不碰真实配置。失败只在输出里报警，不让建项目失败。
function leadFreeStep({ channelId, lead, indexPath }) {
  try {
    const mode = leadFreeMode(process.env);
    if (!mode.run) return { ok: true, skipped: true, reason: mode.reason };
    const r = ensureLeadFree({ channelId, lead, indexPath, configPath: mode.configPath, run: runnerFor(mode, process.env), timeout: 60000 });
    return r.ok ? { ok: true, changed: r.changed, message: r.message } : { ok: false, message: `免点名没开成：${r.message}。可稍后用 lead-free.mjs ensure 重试，并如实告诉主人` };
  } catch (e) { return { ok: false, message: `免点名没开成：${String(e?.message ?? e).slice(0, 200)}。可稍后用 lead-free.mjs ensure 重试，并如实告诉主人` }; }
}

export function parseArgs(argv) {
  const cmd = argv[0];
  const opts = {};
  const flags = new Set(['no-write']);
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) return { cmd, error: `看不懂这个参数：${a}` };
    const eq = a.indexOf('=');
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2));
    if (flags.has(key)) { opts[key] = true; continue; }
    let val;
    if (eq > 0) val = a.slice(eq + 1);
    else { val = argv[i + 1]; i += 1; }
    if (val === undefined) return { cmd, error: `参数 --${key} 后面没有值` };
    opts[key] = val;
  }
  return { cmd, opts };
}
const out = (obj, code = 0) => { process.stdout.write(`${JSON.stringify(obj, null, 1)}\n`); return code; };

export function run(argv) {
  const { cmd, opts, error } = parseArgs(argv);
  if (error) return out({ ok: false, message: error }, 2);
  const indexPath = join(DATA_ROOT, 'INDEX.md');
  const need = (keys) => keys.filter((k) => opts[k] === undefined || String(opts[k]).trim() === '');
  try {
    switch (cmd) {
      case 'new-project': {
        const miss = need(['name', 'channel-id', 'channel-name', 'lead', 'goal']);
        if (miss.length) return out({ ok: false, message: `缺少参数：${miss.map((k) => `--${k}`).join('、')}` }, 2);
        const r = newProject({ dataRoot: DATA_ROOT, indexPath, name: opts.name, channelId: opts['channel-id'], channelName: opts['channel-name'], lead: opts.lead, goal: opts.goal });
        if (r.ok) r.leadFree = leadFreeStep({ channelId: opts['channel-id'], lead: opts.lead, indexPath }); // 建好（或已存在）就给主责开免点名；失败不影响建项目
        return out(r, r.ok ? 0 : 1);
      }
      case 'new-task': {
        const miss = need(['project', 'title', 'thread-link', 'executor', 'quote']);
        if (miss.length) return out({ ok: false, message: `缺少参数：${miss.map((k) => `--${k}`).join('、')}` }, 2);
        const r = newTask({ dataRoot: DATA_ROOT, project: opts.project, title: opts.title, threadLink: opts['thread-link'], executor: opts.executor, quote: opts.quote, quoteDate: opts['quote-date'], cardId: opts['card-id'], goal: opts.goal });
        return out(r, r.ok ? 0 : 1);
      }
      case 'add-result': {
        const miss = need(['project', 'name', 'note']);
        if (miss.length) return out({ ok: false, message: `缺少参数：${miss.map((k) => `--${k}`).join('、')}` }, 2);
        const r = addResult({ dataRoot: DATA_ROOT, project: opts.project, name: opts.name, path: opts.path, outside: opts.outside, note: opts.note });
        return out(r, r.ok ? 0 : 1);
      }
      case 'check-project': {
        const miss = need(['project']);
        if (miss.length) return out({ ok: false, message: '缺少参数：--project' }, 2);
        const r = checkProject({ dataRoot: DATA_ROOT, indexPath, name: opts.project });
        return out({ ok: true, ...r }, 0);
      }
      case 'scan': {
        let workspaces = null;
        if (opts.workspaces !== undefined && String(opts.workspaces).trim() !== '') { // 空串（比如读配置失败）当作没给，走 runtime/ 退路并在报告里说明
          workspaces = String(opts.workspaces).split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const i = s.indexOf('='); return i > 0 ? { id: s.slice(0, i), dir: s.slice(i + 1) } : { id: s, dir: '' }; });
        }
        const r = scan({ dataRoot: DATA_ROOT, indexPath, runtimeRoot: RUNTIME_ROOT, workspaces, date: opts.date || null, write: !opts['no-write'] });
        if (!r.ok) return out(r, 1);
        if (opts.out) {
          mkdirSync(dirname(resolve(opts.out)), { recursive: true });
          atomicWrite(resolve(opts.out), r.report);
        }
        return out({ ok: true, header: r.header, counts: r.counts, firstRun: r.firstRun, notes: r.notes, out: opts.out ? resolve(opts.out) : null }, 0);
      }
      default:
        return out({ ok: false, message: `不认识的命令：${cmd ?? '（没写）'}；可用：new-project、new-task、add-result、check-project、scan` }, 2);
    }
  } catch (e) {
    return out({ ok: false, message: `命令内部出错：${String(e?.message ?? e).slice(0, 300)}。请照模板手工做，并在汇报里带这句原因` }, 1);
  }
}

// 直接运行时才执行。路径里有符号链接时，先取真实路径再比（import.meta.url 已经是真实路径，process.argv[1] 是调用时写的路径）；
// 文件名对得上却不是同一个文件时，报错、退出码非 0，不静默成功。被别的模块导入（如测试）时不执行。
function isDirectRun() {
  const a = process.argv[1];
  if (!a || basename(a) !== 'project-files.mjs') return { direct: false };
  try {
    return { direct: realpathSync(a) === realpathSync(fileURLToPath(import.meta.url)), mismatch: realpathSync(a) !== realpathSync(fileURLToPath(import.meta.url)) };
  } catch (e) { return { direct: false, mismatch: true, error: String(e?.message ?? e) }; }
}
const dr = isDirectRun();
if (dr.direct) process.exitCode = run(process.argv.slice(2));
else if (dr.mismatch) { process.stdout.write(`${JSON.stringify({ ok: false, message: `没有执行：调用的 project-files.mjs 不是本脚本（${dr.error ?? '路径对不上'}）。请用完整路径调用 ${join(crew.paths.projectRoot, 'scripts', 'automation', 'project-files.mjs')}` })}\n`); process.exitCode = 1; }
