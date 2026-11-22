// Stuck guard for the desktop operator: two failed attempts on the same step block further screen calls and force a call for help.
// 桌面角色卡住自救的程序保险（第 8 条改法：不换模型，同一步连败两次就点名任务审计求助；再不行停下等主人）。
// 程序只看得见“屏幕工具放行了、执行后报错”；“点了没反应、点错地方”看不见，那类靠桌面角色规则（每步截图核对，结果不对算失败）。
// 只数“放行了、执行后报错”的调用：放行那一刻（屏幕闸门最后判放行的那一处）记下 toolCallId，after_tool_call 只认记过的编号——
// 被挡下的（拒绝、超时、排队被挡、现场待检查、本保险自己的拦截）没有记过，所以不计数。
// 计数记在文件里（和锁同目录），不记内存：官方可能把插件加载成不止一份，内存计数会分成两份。
// 状态按线程记，并带“这把锁的开始时刻”；换了新锁（放锁后重新拿）就当新的一轮，旧计数作废。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { crew, botId } from './crew-config.mjs';
export const TASK_AUDITOR_MENTION = `<@${botId('task-auditor')}>`; // 任务审计
export const HELP_WAIT_MS = 20 * 60 * 1000; // 求助后 20 分钟没人回，审批频道点名主人一次
export const FAIL_LIMIT = 2; // 同一步连败两次（只限桌面角色的屏幕步骤）
const KEEP_IDS = 10;

export const stuckPathOf = (lockPath) => (lockPath ? join(dirname(lockPath), 'stuck-count.json') : null);

export const HELP_FORMAT = `按这个格式在当前线程点名任务审计 ${TASK_AUDITOR_MENTION}，一条消息写完：\n【求助】\n现象：（卡在哪一步，想做什么）\n我做过什么：（两次各用了什么办法）\n屏幕上现在是什么：（用文字描述，看到了什么窗口、按钮、提示）\n报错原文：（工具返回的原文，没有就写“没有”）`;
export const BLOCK_ASK_HELP = `同一步已经连续失败两次，先停，不要试第三次，也不要再动屏幕。${HELP_FORMAT}\n发出去以后等任务审计回复，照她的建议再试一次。`;
export const BLOCK_AFTER_HELP = '求助以后照建议再试，又连续失败了两次：停下，不要再动屏幕、也不要收尾，保持屏幕原样。在线程里写“卡住：”，说清屏幕现在的样子和试过什么，放锁，点名总控，由她报主人，等主人定。不要换模型、不要继续试。';

export const isHelpRequestText = (text) => typeof text === 'string' && (text.includes(TASK_AUDITOR_MENTION) || text.trimStart().startsWith('【求助】'));
export const isHelpReplyText = (text) => typeof text === 'string' && text.trimStart().startsWith('【求助回复】');

function readAll(path) { try { const v = JSON.parse(readFileSync(path, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) && v.threads && typeof v.threads === 'object' ? v : { threads: {} }; } catch { return { threads: {} }; } }
function writeAll(path, v) { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.tmp-${process.pid}`; writeFileSync(tmp, JSON.stringify(v)); renameSync(tmp, path); }
// 取这个线程的记录；锁的开始时刻变了（新锁）就重置
function recOf(all, threadId, lockStamp) {
  let r = all.threads[threadId];
  if (!r || (lockStamp != null && r.lockStamp != null && r.lockStamp !== lockStamp)) r = all.threads[threadId] = { lockStamp: lockStamp ?? null, allowed: [], errors: 0, phase: 'none', helpAt: null, answered: false, reminded: false };
  if (r.lockStamp == null && lockStamp != null) r.lockStamp = lockStamp;
  return r;
}
const update = (path, threadId, lockStamp, fn) => { const all = readAll(path); const r = recOf(all, threadId, lockStamp); const out = fn(r, all); writeAll(path, all); return out; };

// 屏幕闸门最后判放行时调用：先看要不要拦；不拦就记下这次放行的 toolCallId。返回 null（放行）或 { reason }。
export function stuckGateCheck(path, { threadId, lockStamp, toolCallId }) {
  if (!path || !threadId) return null;
  const all = readAll(path); const r = recOf(all, String(threadId), lockStamp);
  if (r.errors >= FAIL_LIMIT) {
    writeAll(path, all);
    return { reason: r.phase === 'helped' ? BLOCK_AFTER_HELP : BLOCK_ASK_HELP, phase: r.phase };
  }
  if (toolCallId) { r.allowed = [...r.allowed, String(toolCallId)].slice(-KEEP_IDS); writeAll(path, all); }
  return null;
}
// after_tool_call：只认放行时记过的编号。failed＝工具返回报错。
export function stuckNoteResult(path, { threadId, lockStamp, toolCallId, failed }) {
  if (!path || !threadId || !toolCallId) return false;
  const all = readAll(path); const r = all.threads[String(threadId)];
  if (!r || !r.allowed.includes(String(toolCallId))) return false;
  const rr = recOf(all, String(threadId), lockStamp);
  rr.allowed = rr.allowed.filter((x) => x !== String(toolCallId));
  rr.errors = failed ? rr.errors + 1 : 0;
  writeAll(path, all);
  return true;
}
// 桌面角色发出了求助：记“已求助”、记时刻、计数清零、再给 2 次机会；同一把锁里只记一次（再发也不重置，免得绕过“又失败两次就停”）。
export function stuckNoteHelp(path, { threadId, lockStamp, at }) {
  if (!path || !threadId) return false;
  return update(path, String(threadId), lockStamp, (r) => {
    if (r.phase === 'helped') return false;
    r.phase = 'helped'; r.helpAt = at; r.errors = 0; r.answered = false; r.reminded = false; return true;
  });
}
// 任务审计在该线程发出了“【求助回复】…”
export function stuckNoteAnswer(path, { threadId }) {
  if (!path || !threadId) return false;
  const all = readAll(path); const r = all.threads[String(threadId)];
  if (!r || r.phase !== 'helped' || r.answered) return false;
  r.answered = true; writeAll(path, all); return true;
}
// 20 分钟没回的求助（每个只返回一次，调用方发完再标记）
export function stuckDueReminders(path, now, waitMs = HELP_WAIT_MS) {
  if (!path) return [];
  const all = readAll(path);
  return Object.entries(all.threads).filter(([, r]) => r.phase === 'helped' && !r.answered && !r.reminded && Number.isFinite(r.helpAt) && now - r.helpAt >= waitMs).map(([threadId, r]) => ({ threadId, helpAt: r.helpAt }));
}
export function stuckMarkReminded(path, threadId) {
  const all = readAll(path); const r = all.threads[String(threadId)]; if (!r) return;
  r.reminded = true; writeAll(path, all);
}
export const stuckPeek = (path) => readAll(path);
