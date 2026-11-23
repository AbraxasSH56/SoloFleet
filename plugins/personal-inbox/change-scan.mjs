// File-attribute before/after comparison used by the reply card "changed files" line (never reads file contents).
// 附卡"修改"栏的 D：监控目录的文件属性前后对比。
// 只取文件属性（修改时间、大小、inode），绝不读文件内容、不算哈希、不写盘、不起常驻进程、不加定时器。
// 结果只当"本轮期间发现变化（归属未确认）"的候选，不当作归属证据。
import { opendir, lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lexicon } from './lexicon.mjs';

// 明确的系统路径：完全排除（不按后缀一概排除：*.log、*.tmp、*.lock 照常比对）。
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '__pycache__']);
const excludedFile = name => name === '.DS_Store' || /^\.sync-.*\.tmp$/.test(name);

// 私密名：`.env` 作后缀或前缀（测试.env、.env.local、a.env.bak；environment.md 不命中），
// 或含 credential／secret／token／keychain，或是 auth.json。任一段命中，整条只计数。
const PRIVATE_SEGMENT = /(?:\.env(?:\.|$)|credential|secret|token|keychain|auth\.json)/i;
export const isPrivateSegment = segment => PRIVATE_SEGMENT.test(String(segment ?? ''));
export const cleanSegment = segment => String(segment ?? '').replace(/[\r\n`*_<>@]/g, '').slice(0, 100);

// 到截止时间就放弃等待：返回 timedOut，晚到的结果丢掉。
const TIMED_OUT = Symbol('timed-out');
export function withDeadline(promise, deadline, clock = Date.now) {
  if (deadline === undefined) return promise;
  const left = deadline - clock();
  if (left <= 0) { Promise.resolve(promise).catch(() => {}); return Promise.resolve(TIMED_OUT); }
  let timer;
  return Promise.race([promise, new Promise(r => { timer = setTimeout(() => r(TIMED_OUT), left); })]).finally(() => clearTimeout(timer));
}
export const isTimedOut = v => v === TIMED_OUT;
// 截止时间已到就不再发起调用；没到就发起，并按截止时间放弃等待（晚到结果丢弃）。
export function callWithin(fn, args, deadline, clock = Date.now) {
  if (deadline !== undefined && clock() >= deadline) return Promise.resolve(TIMED_OUT);
  return withDeadline(Promise.resolve().then(() => fn(...args)), deadline, clock);
}
// 未完成调用的共享上限：limit＝{ active, max }，放在进程内共享表上，跨模块实例有效。
// 到上限就不发起新调用、也不排队，直接按"超时"处理；调用真正结束（成功或失败）才归还名额——本轮放弃等待不算结束。
export function limitInflight(limit, fn) {
  return (...args) => {
    if (limit.active >= limit.max) return Promise.resolve(TIMED_OUT);
    limit.active++;
    let p;
    try { p = Promise.resolve(fn(...args)); } catch (error) { p = Promise.reject(error); }
    let done = false;
    const settle = () => { if (!done) { done = true; limit.active = Math.max(0, limit.active - 1); } };
    p.then(settle, settle);
    return p;
  };
}

const scanStop = status => Object.assign(new Error(status), { scanStatus: status });
const yieldToLoop = () => new Promise(r => setImmediate(r));

// roots：[{ id:'workspace'|'ziliao', path:<真实路径> }]。每个目录之间交还事件循环，每条之间检查取消和时限。
export async function scanRoots(roots, { signal, maxFiles = 5000, maxMs = 1500, now = Date.now } = {}) {
  const startedAt = now();
  const entries = new Map();
  let files = 0;
  const check = () => {
    if (signal?.aborted) throw scanStop('cancelled');
    if (now() - startedAt > maxMs) throw scanStop('timeout');
  };
  try {
    for (const root of roots) {
      const stack = [root.path];
      while (stack.length) {
        check();
        await yieldToLoop();
        check();
        const dir = stack.pop();
        let handle;
        try { handle = await opendir(dir); }
        catch (error) { if (dir === root.path) throw error; continue; }   // 扫描中途消失的子目录：跳过
        for await (const d of handle) {
          check();
          const full = join(dir, d.name);
          if (d.isDirectory()) {
            if (EXCLUDED_DIRS.has(d.name)) continue;
            if (root.id === 'workspace' && dir === root.path && d.name === '.inbox') continue;   // 内部数据库，收件箱动作由类别 I 负责
            stack.push(full);
            continue;
          }
          if (excludedFile(d.name)) continue;
          let st;
          try { st = await lstat(full); } catch { continue; }   // 不跟随符号链接，只比链接本身
          if (++files > maxFiles) throw scanStop('too-large');
          entries.set(full, { m: st.mtimeMs, s: st.size, i: st.ino, root: root.id, link: st.isSymbolicLink() });
        }
      }
    }
    return { status: 'ok', entries, files, ms: now() - startedAt, completedAt: now() };
  } catch (error) {
    return { status: error?.scanStatus ?? 'error', files, ms: now() - startedAt, completedAt: now() };
  }
}

// 前后对比：新增、删除、属性变了的都算"变化"。sinceMs 给出时（起始快照没赶在第一次写入前完成），
// 再补上修改时间不早于它的文件（只能补一部分）。
export function diffSnapshots(before, after, { sinceMs } = {}) {
  const changed = new Map();
  for (const [key, a] of after) {
    const b = before?.get(key);
    if (!b || b.m !== a.m || b.s !== a.s || b.i !== a.i) changed.set(key, { root: a.root, link: a.link });
    else if (sinceMs !== undefined && a.m >= sinceMs) changed.set(key, { root: a.root, link: a.link });
  }
  if (before) for (const [key, b] of before) if (!after.has(key)) changed.set(key, { root: b.root, link: b.link, deleted: true });
  return changed;
}

export const withinRoot = (rootPath, path) => {
  const rel = relative(rootPath, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : null;
};
export const labelOf = segments => (segments.length > 1 ? segments.slice(-2) : segments).map(cleanSegment).join('/');

// 把变化分成：可显示的候选、记忆目录、垃圾桶、受限（只计数）、指向范围外的链接（不显示）。
// deadline 给出时：每条之前看时间，读链接和解析真实路径都按截止时间放弃（只用异步调用，不做会卡住事件循环的同步文件调用）；
// 到点就返回 timedOut，调用方整份丢弃、写"未比对"。
export async function describeChanges(changed, roots, { deadline, clock = Date.now, readlinkFn = readlink, realpathFn = realpath } = {}) {
  const out = { candidates: [], memory: 0, trash: 0, hidden: 0, outside: 0 };
  const rootPath = id => roots.find(r => r.id === id)?.path;
  for (const [key, info] of changed) {
    if (deadline !== undefined && clock() >= deadline) return { ...out, timedOut: true };
    const base = rootPath(info.root);
    const rel = base ? withinRoot(base, key) : null;
    if (!rel) { out.outside++; continue; }
    const segments = rel.split(sep);
    if (info.root === 'workspace' && segments[0] === 'memory' && segments.length > 1) { out.memory++; continue; }
    if (info.root === 'ziliao' && segments[0] === lexicon().layout.trash && segments.length > 1) { out.trash++; continue; }
    if (segments.some(isPrivateSegment)) { out.hidden++; continue; }
    if (info.link && !info.deleted) {
      let link;
      try { link = await callWithin(readlinkFn, [key], deadline, clock); } catch { out.outside++; continue; }
      if (isTimedOut(link)) return { ...out, timedOut: true };
      const target = resolve(dirname(key), link);
      let real = target;
      try { const got = await callWithin(realpathFn, [target], deadline, clock); if (isTimedOut(got)) return { ...out, timedOut: true }; real = got; } catch {}
      const inside = roots.map(r => withinRoot(r.path, real)).find(Boolean);
      if (!inside) { out.outside++; continue; }
      if (inside.split(sep).some(isPrivateSegment) || target.split(sep).slice(-2).some(isPrivateSegment)) { out.hidden++; continue; }
    }
    out.candidates.push({ key, label: labelOf(segments) });
  }
  return out;
}
