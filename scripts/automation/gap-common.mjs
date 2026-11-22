// Shared helpers for the quota/reminder/ledger scripts: official-CLI runner, Discord send, local-time helpers, JSON files, locks.
// 全部不读密钥；官方命令只通过 openclaw 命令行调用；解析 --json 输出前一律跳过开头的警告行。
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { crew as _crew } from '../../plugins/personal-inbox/crew-config.mjs';
export const DEFAULT_DATA_ROOT = _crew.paths.dataRoot;
export const WORKSHOP_CHANNEL = _crew.channels.workshop; // workshop channel (shared with quota catch-up and pending decisions)
export const OWNER_MENTION = `<@${_crew.owner.userId}>`;
export const NODE_BIN = _crew.paths.nodeBin;
export const DAY_MS = 86400000;

export function openclawBin(env = process.env) {
  return env.OPENCLAW_BIN || _crew.paths.openclawBin;
}

// ---------- 解析官方 --json 输出：先跳过开头的警告行 ----------
export function parseJsonLoose(text) {
  const s = String(text ?? '');
  const starts = [];
  if (s.startsWith('{') || s.startsWith('[')) starts.push(0);
  for (let i = s.indexOf('\n'); i >= 0 && i < s.length - 1; i = s.indexOf('\n', i + 1)) {
    if (s[i + 1] === '{' || s[i + 1] === '[') starts.push(i + 1);
  }
  const first = s.search(/[{[]/);
  if (first >= 0 && !starts.includes(first)) starts.push(first);
  for (const i of starts) {
    const open = s[i];
    const close = open === '{' ? '}' : ']';
    const end = s.lastIndexOf(close);
    for (const slice of [s.slice(i), end > i ? s.slice(i, end + 1) : null]) {
      if (!slice) continue;
      try { return JSON.parse(slice); } catch { /* 试下一个起点 */ }
    }
  }
  throw new Error('输出里找不到可解析的 JSON');
}

// ---------- 官方命令执行（离线测试里换成假的）----------
export function realRunner(env = process.env) {
  const bin = openclawBin(env);
  return function run(args, { timeout = 90000, input } = {}) {
    const nodeDir = dirname(NODE_BIN); // 官方 openclaw 是个脚本链接，PATH 里没有 node 会报找不到：把 node 所在目录补到最前面
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout, input, env: { ...env, PATH: `${nodeDir}:${env.PATH ?? ''}`, NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: r.status ?? (r.error ? 1 : 0), stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.error?.code === 'ETIMEDOUT' };
  };
}

// 发到工坊；只有拿到消息编号的回执才算成功（调用方据此决定记不记“已发”）
export function realSend(run = realRunner()) {
  return async function send(text, channelId = WORKSHOP_CHANNEL) {
    const r = run(['message', 'send', '--channel', 'discord', '--account', 'default', '--target', `channel:${channelId}`, '--message', text, '--json'], { timeout: 60000 });
    if (r.code !== 0) return { ok: false, error: `message send 退出码 ${r.code}` };
    try {
      const d = parseJsonLoose(r.stdout);
      const p = d.payload ?? d;
      if (d.dryRun || p.dryRun) return { ok: false, error: '干跑，没真发' };
      const id = p.messageId ?? p.result?.messageId ?? p.message?.id ?? null;
      return id ? { ok: true, id: String(id) } : { ok: false, error: '没拿到消息编号的回执' };
    } catch (e) { return { ok: false, error: `回执解析失败：${e.message}` }; }
  };
}

// ---------- Local time (config "timezone"; no fixed offsets) ----------
import { localDate, localDateTime, localIso as tzLocalIso, localDayStart as tzDayStart, offsetMs } from '../../plugins/personal-inbox/tz.mjs';
export function localParts(ms) {
  const dt = localDateTime(ms); // YYYY-MM-DD HH:MM:SS in the configured zone
  const [y, m, d] = dt.slice(0, 10).split('-').map(Number);
  return { date: dt.slice(0, 10), minutes: Number(dt.slice(11, 13)) * 60 + Number(dt.slice(14, 16)), weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}
export function localIso(ms) { return tzLocalIso(ms); }
export function localDayStart(dateStr) { return tzDayStart(dateStr); }
export function addDays(dateStr, n) { const [y, m, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
export const localOffsetMs = (ms) => offsetMs(ms);
export function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''))) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}
export function cnDate(ms) { const b = localParts(ms).date.split('-'); return `${Number(b[1])} 月 ${Number(b[2])} 日`; }
export function cnDateTime(ms) { const b = localParts(ms); const hh = String(Math.floor(b.minutes / 60)).padStart(2, '0'); const mm = String(b.minutes % 60).padStart(2, '0'); const d = b.date.split('-'); return `${Number(d[1])} 月 ${Number(d[2])} 日 ${hh}:${mm}`; }

// ---------- 文件：读、原子写、锁 ----------
export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function atomicWriteJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}
export function writeTextAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}
// 同一时刻只让一个进程改状态文件。锁文件超过 staleMs 视为上次崩溃遗留，清掉再试一次。
export async function withLock(lockPath, fn, { staleMs = 10 * 60000, now = () => Date.now() } = {}) {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd = null;
  for (let attempt = 0; attempt < 2 && fd === null; attempt++) {
    try { fd = openSync(lockPath, 'wx', 0o600); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0; try { age = now() - statSync(lockPath).mtimeMs; } catch { /* 刚被释放 */ }
      if (age > staleMs) { try { unlinkSync(lockPath); } catch { /* 别人先清了 */ } } else return { busy: true };
    }
  }
  if (fd === null) return { busy: true };
  try { writeFileSync(fd, `${process.pid} ${new Date(now()).toISOString()}\n`); } catch { /* 只是备注 */ }
  try { return { busy: false, value: await fn() }; } finally { try { closeSync(fd); } catch { /* 已关 */ } try { unlinkSync(lockPath); } catch { /* 已清 */ } }
}
export function fileExists(p) { return existsSync(p); }
export { join };
