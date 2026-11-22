// Approval cards: trims the card description to the platform limit and posts a short mention of the owner in the approval channel for every card.
// 审批卡说明的两件事// ①说明文字在程序里先把“官方清理会放大”的字符换成普通空格，再按码点截到上限以内（官方清理后超 512 码点会整张拒掉，不是被截）；
// ②每出一张审批卡，异步用总控账号往“审批”频道另发一条点名主人的短消息（官方转发的卡 mentions 为空、插件改不了卡的内容，只能另发提醒）。
// 本文件只放这两件通用的事；卡的栏目由 desktop-lock.mjs、audit-gate.mjs 各自拼。
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { crew } from './crew-config.mjs';
export const APPROVAL_CHANNEL_ID = crew.channels.approval; // “审批”频道（openclaw.json approvals.plugin.targets）
export const OWNER_MENTION = `<@${crew.owner.userId}>`; // 与 pending-ledger.mjs 的 OWNER_ID 同一个编号（测试里有断言）
export const APPROVAL_DESC_BUDGET = 480; // 实际拒绝线是清理后 512 码点，留余量
export const APPROVAL_TITLE_MAX = 80;
export const NOTICE_DEDUP_MS = 10 * 60 * 1000; // 同一张卡 10 分钟内只另发一次

// 官方清理（exec-approval-text-sanitize）会把这些字符换成 \u{XXXX} 写法，全角空格 1 字变 8 字，所以先换成普通空格。换行保留。
const INFLATING = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}   -   　ᅟᅠㅤﾠ]/gu;
export function plainApprovalText(text) {
  return String(text ?? '').replace(INFLATING, (ch) => (ch === '\n' ? '\n' : ' '));
}
export const cpLength = (text) => Array.from(String(text)).length;
export function cutCodePoints(text, max) {
  const chars = Array.from(String(text));
  return chars.length <= max ? String(text) : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}
// 套官方的清理规则算一遍清理后的码点数（测试用来证明“≤512”；换行也算一个码点）
export function sanitizedLength(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n');
  return cpLength(s.replace(INFLATING, (ch) => (ch === '\n' ? '\n' : `\\u{${ch.codePointAt(0).toString(16).toUpperCase()}}`)));
}

// 按“先后截”的规则拼说明。segments 按文字顺序排：
//   { kind:'keep', text }              始终保留（固定句、批的是什么、申请的 bot、原线程等）
//   { kind:'var', text, order, cut? }  可变栏：超了就按 order 从小到大依次截（cut(room) 可自定义怎么截，默认尾部加“…”）
//   { kind:'tail', text }              末尾可有可无的提示：超了最先整段砍掉
// 返回文字的总码点数不超过 budget。顺序：先砍 tail → 再按 order 截 var → 仍超才截最后一段 keep 的尾部（正常不会发生）。
export function composeApprovalDescription(segments, budget = APPROVAL_DESC_BUDGET) {
  const segs = segments.map((g) => ({ ...g, text: plainApprovalText(g.text), min: g.min ?? 6 }));
  const build = () => segs.map((g) => g.text).join('');
  if (cpLength(build()) <= budget) return build();
  for (const g of segs) if (g.kind === 'tail') g.text = '';
  if (cpLength(build()) <= budget) return build();
  for (const g of segs.filter((x) => x.kind === 'var').sort((x, y) => (x.order ?? 0) - (y.order ?? 0))) {
    const over = cpLength(build()) - budget;
    if (over <= 0) break;
    const room = Math.max(g.min, cpLength(g.text) - over);
    g.text = g.cut ? g.cut(g.text, room) : cutCodePoints(g.text, room);
  }
  if (cpLength(build()) <= budget) return build();
  const last = [...segs].reverse().find((g) => g.kind === 'keep');
  if (last) last.text = cutCodePoints(last.text, Math.max(0, cpLength(last.text) - (cpLength(build()) - budget)));
  return build();
}

// ----- 另发点名消息 -----
const recent = new Map(); // dedupKey -> 发出时刻
export function resetApprovalNoticeState() { recent.clear(); }
export function approvalNoticeText({ what, cardId, source }) {
  const one = cutCodePoints(plainApprovalText(String(what ?? '（没写事由）')).replace(/\s+/g, ' ').trim(), 80);
  return `${OWNER_MENTION} 审批频道有一张新审批卡：${source}${cardId ? `（任务卡 ${cardId}）` : ''}——${one}`;
}
// 异步发，不等结果，发失败只记日志、不影响卡；不发私信；同一张卡 10 分钟内只发一次；P4 测试分支不发（调用方不调用即可）。
// send 默认用 openclaw 命令行（异步 execFile，不堵 Gateway 的事件循环）；测试时换成假的。
// send 必须由调用方明确传入（真实运行时由 index.mjs 传 realApprovalSend）；没传就什么都不发——测试里直接调门函数时不会误发到真实频道。
// 去重表可以记在文件里（dedupPath）。官方会把插件复制到临时目录里加载，同一个进程里这个文件可能被加载不止一份（seen in a lock log: the same fingerprint sent twice 89 seconds apart from one pid），
// 文件级的变量各管各的；记在文件里，不管加载几份、重不重启都管用。没给 dedupPath（测试）就用上面的内存表。读不懂的文件当空表；写失败不影响发送。
function readDedup(dedupPath) {
  try { const v = JSON.parse(readFileSync(dedupPath, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
function writeDedup(dedupPath, table) {
  try {
    mkdirSync(dirname(dedupPath), { recursive: true });
    const tmp = `${dedupPath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(table));
    renameSync(tmp, dedupPath);
  } catch { /* 只是去重记录，写不上就当没有 */ }
}
export function notifyApprovalCard({ dedupKey, what, cardId, source, now = Date.now, send, log = () => {}, dedupPath = null }) {
  if (typeof send !== 'function') { log({ event: 'approval-notice-skipped', why: '没有配置另发函数（测试或未接线）', dedupKey }); return false; }
  const t = now();
  if (dedupPath) {
    const table = readDedup(dedupPath);
    for (const [k, at] of Object.entries(table)) if (typeof at !== 'number' || t - at > NOTICE_DEDUP_MS) delete table[k];
    if (dedupKey && Object.hasOwn(table, dedupKey)) { log({ event: 'approval-notice-skipped', why: '10 分钟内同一张卡已另发过', dedupKey }); return false; }
    if (dedupKey) { table[dedupKey] = t; writeDedup(dedupPath, table); }
  } else {
    for (const [k, at] of recent) if (t - at > NOTICE_DEDUP_MS) recent.delete(k);
    if (dedupKey && recent.has(dedupKey)) { log({ event: 'approval-notice-skipped', why: '10 分钟内同一张卡已另发过', dedupKey }); return false; }
    if (dedupKey) recent.set(dedupKey, t);
  }
  const message = approvalNoticeText({ what, cardId, source });
  try {
    Promise.resolve(send({ account: 'default', target: APPROVAL_CHANNEL_ID, message })).then(
      (r) => log({ event: 'approval-notice-sent', dedupKey, result: r?.ok === false ? 'failed' : 'sent', detail: r?.error ?? null }),
      (e) => log({ event: 'approval-notice-failed', dedupKey, error: String(e?.message ?? e).slice(0, 200) }),
    );
  } catch (e) { log({ event: 'approval-notice-failed', dedupKey, error: String(e?.message ?? e).slice(0, 200) }); }
  return true;
}
export function realApprovalSend({ account, target, message }) {
  // 加固（审计②-3）：node 测试运行器会给子进程设 NODE_TEST_CONTEXT；测试里就算有人经 index.mjs 注册并触发出卡，也不真发（实测：只有默认的 `node --test` 会设这个变量；`--test-isolation=none` 或直接 `node 文件` 跑时是空的，保险不起作用——审计）。
  if (process.env.NODE_TEST_CONTEXT) return Promise.resolve({ ok: false, error: '测试环境，不真发' });
  const bin = process.env.OPENCLAW_BIN || crew.paths.openclawBin;
  return new Promise((resolve, reject) => {
    execFile(bin, ['message', 'send', '--channel', 'discord', '--account', account, '--target', `channel:${target}`, '--message', message, '--json'],
      { encoding: 'utf8', timeout: 60_000 }, (error, stdout) => (error ? reject(error) : resolve({ ok: true, out: String(stdout).slice(0, 200) })));
  });
}
