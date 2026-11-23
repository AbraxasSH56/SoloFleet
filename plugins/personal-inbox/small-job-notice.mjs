// For small jobs without a task card: if the bot forgot to report in the channel, the program adds one line.
// 没建卡的小活，bot 忘了在项目频道主区域报时，程序补一行。
// 一轮结束（agent_end）时，**全部**满足才补：
//   ① 这一轮是主人本人叫的——只认发话人编号（`ctx.senderId` 等于 OWNER_ID）和 `trigger==='user'`，不靠 inputProvenance（它分不出人和 bot）；
//   ② 在任务线程里（线程的上级频道不是它自己）；上级频道不在 channel-exclusions.json 的“完成记录排除”里（现在放着工坊（写死兜底）和闲聊茶会）；
//   ③ 这一轮真的写过文件（写类工具成功，记文件名）；
//   ④ 这一轮没往上级频道主区域发过话（bot 自己已经在主区报过就不补）；
//   ⑤ 这一轮没有发过“完成记录”；
//   ⑥ 不是审计角色（系统审计、任务审计）。
// 补的那一行用总控账号发，不点名任何人：`完成记录（小活）：执行者E在线程 <链接> 做完一件，改了：a.md、b.txt`。发失败只记日志。
// 判断在后台做（算上级频道要起命令行，Gateway 忙时要几十秒），agent_end 钩子立刻返回。每一轮只补一次。
// 边界：只认写类工具（write／edit 等）的成功调用；用命令行（exec）写文件的轮次看不见，不补。
import { classifyTool } from './execution-record.mjs';
import { isCompletionExcluded } from './channel-exclusions.mjs';
import { lexicon } from './lexicon.mjs';
import { GUILD_ID, threadIdOfSession, toolSucceeded, roleNameFromTable } from './completion-notice.mjs';
import { OWNER_ID } from './pending-ledger.mjs';

const W = lexicon(); // words follow config "locale"
const MAX_FILES_SHOWN = 6;
const SEND_ACTION = /^(send|reply|thread[-_]?reply|broadcast)/i;
const SKIP_AGENTS = new Set(['system-auditor', 'task-auditor']);
const idOfTarget = (t) => (/(\d{5,})$/.exec(String(t ?? '')) ?? [])[1] ?? null;

export function smallJobText({ executor, threadLink, files }) {
  const names = [...new Set(files.map((f) => String(f).split('/').filter(Boolean).at(-1)).filter(Boolean))];
  const shown = names.slice(0, MAX_FILES_SHOWN).join(W.listSep);
  const more = names.length > MAX_FILES_SHOWN ? W.smallJobMore(names.length) : '';
  return W.smallJobRecord(executor ?? W.unknownWord, threadLink, shown, more);
}

export function createSmallJobNotice({ syncRoot = null, dataRoot = null, parentChannelOf, send = null, roleName = (a) => roleNameFromTable(dataRoot, a), log = () => {}, read, now = Date.now, getWrites = null, getToolSummary = null } = {}) {
  const runs = new Map(); // runId → { writes:Set, targets:Set, completionSent:boolean, done:boolean, at, toolNames:Set }
  const runOf = (runId) => {
    let r = runs.get(runId);
    if (!r) {
      for (const [k, v] of runs) if (now() - v.at > 3 * 3600 * 1000) runs.delete(k);
      while (runs.size >= 200) runs.delete(runs.keys().next().value);
      r = { writes: new Set(), targets: new Set(), completionSent: false, done: false, at: now(), toolNames: new Set() };
      runs.set(runId, r);
    }
    return r;
  };
  const skip = (why, extra = {}) => { try { log({ event: 'small-job-skip', why, ...extra }); } catch { /* 只是记录 */ } return { sent: false, why }; };
  return {
    // after_tool_call：记写过的文件、往哪些频道发过话
    noteTool(event, ctx = {}) {
      const runId = ctx?.runId ?? event?.runId;
      if (runId && event?.toolName) { const rr = runOf(runId); if (rr.toolNames.size < 20) rr.toolNames.add(`${String(event.toolName).slice(0, 40)}${toolSucceeded(event) ? '' : '(失败)'}`); }
      if (!runId || !toolSucceeded(event)) return;
      const cl = classifyTool(event?.toolName, event?.params);
      const p = event?.params;
      if (cl.cls === 'W' && p && typeof p === 'object') {
        const path = p.file_path ?? p.path ?? p.notebook_path;
        if (typeof path === 'string' && path.trim()) runOf(runId).writes.add(path.trim());
      } else if (cl.cls === 'M' && SEND_ACTION.test(String(cl.action ?? p?.action ?? '')) && p && typeof p === 'object') {
        const id = idOfTarget(p.target ?? p.to ?? p.channelId ?? p.channel);
        if (id) runOf(runId).targets.add(id);
      }
    },
    noteCompletionSent(runId) { if (runId) runOf(runId).completionSent = true; },
    // agent_end：判断并补一行；返回结果给测试看
    async settle(ctx = {}) {
      const runId = ctx?.runId;
      if (!runId) return { sent: false, why: '没有这一轮的记录' };
      // 写过的文件有两个来源：①after_tool_call 钩子看到的写类工具；②执行记录的写入证据（getWrites）——命令行路径上原生写文件的调用走事件流，
      // after_tool_call 不一定看得到（第 8 步 S7c 第一次实测：执行者E写了文件、附卡也列了，这里却一轮"没动文件"），所以两边合并。
      let external = [];
      try { external = typeof getWrites === 'function' ? (getWrites(runId) ?? []) : []; } catch { external = []; }
      let r = runs.get(runId);
      // 诊断（S7c 第二次实测仍没补上、日志里什么都没有）：主人本人叫的每一轮都记一行，写明看到了几个写过的文件、发话人字段有没有值，下次一眼看出卡在哪一步。
      if (ctx?.trigger === 'user' && ctx?.senderId && String(ctx.senderId) === OWNER_ID) { try { log({ event: 'small-job-checked', runId, agentId: ctx?.agentId ?? null, viaTools: r?.writes.size ?? 0, viaRecord: external.length, hasRun: Boolean(r), hookTools: r ? [...r.toolNames] : [], recordTools: typeof getToolSummary === 'function' ? (getToolSummary(runId) ?? null) : null, sessionKeyTail: String(ctx?.sessionKey ?? '').slice(-24) }); } catch { /* 只是记录 */ } }
      if (!r && !external.length) return { sent: false, why: '没有这一轮的记录' };
      r ??= runOf(runId);
      if (r.done) return { sent: false, why: '没有这一轮的记录' };
      for (const f of external) r.writes.add(f);
      r.done = true;
      const agentId = ctx?.agentId ?? (/^agent:([^:]+):/.exec(String(ctx?.sessionKey ?? ''))?.[1] ?? null);
      try {
        if (!r.writes.size) return { sent: false, why: '没动文件' }; // 绝大多数轮次：安静返回，不记日志
        if (ctx?.trigger !== 'user' || !ctx?.senderId || String(ctx.senderId) !== OWNER_ID) return skip('不是主人本人叫的（只认发话人编号）', { runId, agentId, trigger: ctx?.trigger ?? null, senderIdPresent: Boolean(ctx?.senderId) });
        if (SKIP_AGENTS.has(agentId)) return skip('审计角色不补', { runId, agentId });
        if (r.completionSent) return skip('这一轮程序已经发过完成记录', { runId, agentId });
        const threadId = threadIdOfSession(ctx?.sessionKey);
        if (!threadId) return skip('会话里读不出线程编号', { runId, agentId });
        if (isCompletionExcluded(syncRoot, threadId, read)) return skip('频道在排除列表里', { runId, agentId, channelId: threadId });
        if (typeof send !== 'function') return skip('没有配置发送函数', { runId, agentId });
        const parent = await Promise.resolve(parentChannelOf(threadId)).catch((e) => { log({ event: 'small-job-parent-failed', runId, error: String(e?.message ?? e).slice(0, 200) }); return null; });
        if (!parent) return skip('算不出上级频道（不猜）', { runId, agentId });
        if (String(parent) === String(threadId)) return skip('不是在线程里（本来就在主区域）', { runId, agentId, channelId: threadId });
        if (isCompletionExcluded(syncRoot, parent, read)) return skip('上级频道在排除列表里（工坊、闲聊茶会）', { runId, agentId, channelId: parent });
        if (r.targets.has(String(parent))) return skip('这一轮已经往主区域发过话', { runId, agentId, channelId: parent });
        const text = smallJobText({ executor: roleName(agentId), threadLink: `https://discord.com/channels/${GUILD_ID}/${threadId}`, files: [...r.writes] });
        await Promise.resolve(send({ target: String(parent), message: text }));
        log({ event: 'small-job-sent', runId, agentId, channelId: String(parent), files: r.writes.size });
        return { sent: true, channelId: String(parent), text };
      } catch (e) {
        try { log({ event: 'small-job-error', runId, error: String(e?.message ?? e).slice(0, 200) }); } catch { /* 只是记录 */ }
        return { sent: false, why: '出错' };
      } finally {
        runs.delete(runId);
      }
    },
  };
}

export function registerSmallJobNotice(api, notice) {
  if (!notice) return;
  api.on('after_tool_call', (event, ctx) => { try { notice.noteTool(event, ctx); } catch { /* 只是记录 */ } return undefined; }, { registrationId: 'small-job-notice-tools' });
  // 不等它：算频道和发消息要起命令行，Gateway 忙时要几十秒
  api.on('agent_end', (_event, ctx) => { try { void notice.settle(ctx); } catch { /* 只是记录 */ } return undefined; }, { registrationId: 'small-job-notice-end' });
}
