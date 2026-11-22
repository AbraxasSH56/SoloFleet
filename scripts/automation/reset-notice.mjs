#!/usr/bin/env node
// Fixed notices before and after the daily session reset.
// 每天 18:00 重置的"重置前提醒、重置后通知"。
// 命令型定时任务 `重置通知`，每 15 分钟一次（本地时区 17:00～21:30），不调模型。脚本自己判断该不该发，其余时间什么都不做。
// 每天（按本地时区日期，周末也发）各一条：
//   重置前：17:30 起、18:00 前发一次（17:30、17:45 两轮，第一次没发成还能再试）；
//   重置后：18:00 起、21:30 前发一次。
// 发送：用 gap-common 的发工坊工具（openclaw message send），拿到消息编号的回执才记"已发"；发失败下一轮重发，同一条最多试 3 次；错过了窗口就作废（重置前那条过了 18:00 不补）。
// 状态：资料/运行记录/提醒/重置通知.json（权限 644，只由本脚本写）。
// 用法：
//   node reset-notice.mjs                          定时任务入口（输出 NO_REPLY）
//   node reset-notice.mjs --dry-run [--now <ISO>]  只说这一刻会发什么，不发不记
//   node reset-notice.mjs --target <频道编号> [--now <ISO>]   发到指定频道（测试用）；状态记在另一个"测试"状态文件里，不影响正式的
// 选项：--data-root <资料根>（只给离线测试用）
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { DEFAULT_DATA_ROOT, WORKSHOP_CHANNEL, localParts, localIso, join, readJson, realSend, withLock } from './gap-common.mjs';

export const PRE_FROM = 17 * 60 + 30; // 17:30
export const RESET_AT = 18 * 60; // 18:00
export const POST_UNTIL = 21 * 60 + 30; // 21:30
export const MAX_TRIES = 3;
export const KEEP_DAYS = 14;

export const TEXT_PRE = '【每日重置提醒】18:00 整，工坊和各项目频道主区域的会话会重置：之后各 bot 在主区域的第一句话会开新会话，靠任务记录接着做，你不用重新解释。任务线程不受影响（闲置满 24 小时才重置）。有话没说完的话，18:00 前说完最稳。';
export const TEXT_POST = '【每日重置】18:00 已过。从现在起各 bot 在主区域的下一句话会用新会话；做到一半的活靠任务记录接着做。如果哪个 bot 不记得上文，叫它先读任务记录。';

export function paths(dataRoot, test = false) {
  const dir = join(dataRoot, '运行记录', '提醒');
  return { dir, state: join(dir, test ? '重置通知.测试.json' : '重置通知.json'), lock: join(dir, test ? '.重置通知.测试.lock' : '.重置通知.lock') };
}
// 644 原子写（gap-common 的 atomicWriteJson 写死 600，本批不改它，这里自己实现）
export function writeJson644(path, obj) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
}

// 这一刻该发哪一条（纯函数）：返回 'pre'、'post' 或 null
export function dueKind({ nowMs, day }) {
  const b = localParts(nowMs);
  const rec = day ?? {};
  const done = (k) => rec[k]?.状态 === '已发' || (rec[k]?.试 ?? 0) >= MAX_TRIES;
  if (b.minutes >= PRE_FROM && b.minutes < RESET_AT && !done('pre')) return 'pre';
  if (b.minutes >= RESET_AT && b.minutes < POST_UNTIL && !done('post')) return 'post';
  return null;
}

export async function runOnce({ nowMs, dataRoot = DEFAULT_DATA_ROOT, send, channel = WORKSHOP_CHANNEL, dryRun = false, test = false }) {
  const P = paths(dataRoot, test);
  const date = localParts(nowMs).date;
  if (dryRun) {
    const st = readJson(P.state, { 天: {} });
    const kind = dueKind({ nowMs, day: st.天?.[date] });
    return { kind, text: kind === 'pre' ? TEXT_PRE : kind === 'post' ? TEXT_POST : null, 说明: kind ? `这一刻（${localIso(nowMs)}）会发“${kind === 'pre' ? '重置前提醒' : '重置后通知'}”` : `这一刻（${localIso(nowMs)}）什么都不发` };
  }
  const locked = await withLock(P.lock, async () => {
    const st = readJson(P.state, { 天: {} });
    st.天 ??= {};
    const kind = dueKind({ nowMs, day: st.天[date] });
    if (!kind) return { kind: null };
    const rec = (st.天[date] ??= {});
    const item = (rec[kind] ??= { 试: 0 });
    item.试 = (item.试 ?? 0) + 1;
    item.最后尝试 = localIso(nowMs);
    writeJson644(P.state, st); // 先记"试了一次"，再发（发的过程中进程被杀也不会无限重试）
    const r = await send(kind === 'pre' ? TEXT_PRE : TEXT_POST, channel);
    if (r.ok) { item.状态 = '已发'; item.消息编号 = r.id; item.发出时间 = localIso(nowMs); delete item.错误; } else item.错误 = String(r.error ?? '未知').slice(0, 200);
    // 只留最近 KEEP_DAYS 天
    const days = Object.keys(st.天).sort();
    for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete st.天[d];
    writeJson644(P.state, st);
    return { kind, ok: r.ok, id: r.id, error: r.error };
  });
  return locked.busy ? { kind: null, busy: true } : locked.value;
}

function parseArgs(argv) {
  const o = { flags: new Set(), val: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') o.flags.add('dry');
    else if (['--now', '--target', '--data-root'].includes(a)) {
      if (argv[i + 1] === undefined || String(argv[i + 1]).startsWith('--') || String(argv[i + 1]).trim() === '') return { error: `参数 ${a} 后面没有值` }; // 缺值就报错退出，绝不静默退回发工坊
      o.val[a.slice(2)] = argv[i + 1]; i += 1;
    }
    else return { error: `看不懂这个参数：${a}` };
  }
  return o;
}
export async function main(argv = process.argv.slice(2), { send = realSend(), nowFn = () => Date.now() } = {}) {
  const o = parseArgs(argv);
  if (o.error) { console.error(o.error); return 2; }
  const dry = o.flags.has('dry');
  const target = o.val.target ?? null;
  if (o.val.now && !dry && !target) { console.error('--now 只能和 --dry-run 或 --target 一起用（免得拨时间发到工坊）'); return 2; }
  if (target && !/^\d{15,}$/.test(target)) { console.error('--target 要是 15 位以上的频道编号'); return 2; }
  if (target === WORKSHOP_CHANNEL) { console.error('测试发送不许发到工坊'); return 2; }
  const nowMs = o.val.now ? Date.parse(o.val.now) : nowFn();
  if (!Number.isFinite(nowMs)) { console.error('--now 不是合法时间'); return 2; }
  try {
    const r = await runOnce({ nowMs, dataRoot: o.val['data-root'] ?? DEFAULT_DATA_ROOT, send, channel: target ?? WORKSHOP_CHANNEL, dryRun: dry, test: !!target });
    if (dry) { console.log(JSON.stringify(r, null, 1)); return 0; }
    console.log(target ? JSON.stringify(r) : 'NO_REPLY');
    return r.kind && r.ok === false ? 1 : 0;
  } catch (e) { console.error(`重置通知出错：${e.message}`); return 1; }
}
function isDirect() {
  const a = process.argv[1];
  if (!a || basename(a) !== 'reset-notice.mjs') return false;
  try { return realpathSync(a) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isDirect()) main().then((c) => { process.exitCode = c; });
