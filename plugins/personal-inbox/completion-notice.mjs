// After a task card is closed successfully, posts one non-mentioning completion line in the project channel.
// 建了卡的活，结案成功之后，程序用总控账号往该项目频道主区域发一行不点名的完成记录。
// 挂法：结案关口（audit-gate）在放行或出审批卡时登记这次工具调用（toolCallId）；结案工具真执行完（after_tool_call 没有报错）才发，
// 所以“程序放行”和“主人点允许后放行”两条路都覆盖；被挡下、被拒绝、超时、执行失败的都不发。
// 频道怎么算：线程 → 官方 `openclaw message channel info` 的 parent_id（异步 execFile，不堵 Gateway）；不是线程就用它自己；
// 算不出来 → 不发、记日志（不猜）；算出来的频道在 channel-exclusions.json 的“完成记录排除”里（现在放着工坊和闲聊茶会，工坊是写死兜底）→ 不发、只记日志。
// 一行里不写 <@，不点名任何人，Discord 设成“仅 @提及”才响，所以不响。发失败只记日志，不影响结案。
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isCompletionExcluded } from './channel-exclusions.mjs';

import { crew } from './crew-config.mjs';
import { lexicon } from './lexicon.mjs';
const THREAD_ID_RE = /:(?:channel|thread):(\d{5,})\b/;
export const GUILD_ID = crew.guildId;
const W = lexicon(); // words follow config "locale"
const BOT_TABLE_REL = [W.layout.audit, W.layout.auditDaily, W.layout.dailyFiles.botRoster];

export function threadIdOfSession(sessionKey) { return THREAD_ID_RE.exec(String(sessionKey ?? ''))?.[1] ?? null; }
const failedShape = (r) => r && typeof r === 'object' && (r.isError === true || r.ok === false || (r.details && typeof r.details === 'object' && (r.details.isError === true || r.details.ok === false)));
export function toolSucceeded(event) { return !event?.error && !failedShape(event?.result); }

export function completionText({ title, executor, threadLink }) {
  const t = String(title ?? W.noCardName).replace(/\s+/g, ' ').trim().slice(0, 80);
  return W.completionRecord(t, executor ?? W.unknownWord, threadLink);
}

// 角色编号 → 显示名：读 日审生成的 bot编号表.json（非口令），读不到就原样写角色编号
export function roleNameFromTable(dataRoot, agentId, read = (p) => readFileSync(p, 'utf8')) {
  try {
    const d = JSON.parse(read([dataRoot, ...BOT_TABLE_REL].join('/')));
    const hit = (d?.人设bot ?? []).find((x) => x.角色 === agentId);
    if (hit?.显示名) return String(hit.显示名);
  } catch { /* 读不到 */ }
  return agentId ?? W.unknownWord;
}

const binPath = () => process.env.OPENCLAW_BIN || crew.paths.openclawBin;
// Gateway 忙的时候这条命令行启动很慢（审批点名同样要 27 秒才发出），原来 30 秒超时被杀、只留一句“Command failed”，
// 算不出频道、没发完成记录。超时放到 120 秒，失败时把"是不是超时被杀"和标准错误尾巴一起带出来，下次一眼看得出原因。
const execAsync = (args, timeout) => new Promise((resolve, reject) => execFile(binPath(), args, { encoding: 'utf8', timeout, env: { ...process.env, NODE_NO_WARNINGS: '1' } }, (e, out, err) => {
  if (!e) return resolve(String(out));
  const tail = String(err ?? '').split('\n').filter((x) => x && !/DeprecationWarning|trace-deprecation/.test(x)).slice(-2).join(' / ').slice(0, 200);
  reject(new Error(`${e.killed ? '超时被杀（' + timeout / 1000 + ' 秒）' : '命令失败'}${e.signal ? `，信号 ${e.signal}` : ''}${e.code != null ? `，退出码 ${e.code}` : ''}${tail ? `：${tail}` : ''}`));
}));
export async function realParentChannel(threadOrChannelId) {
  if (process.env.NODE_TEST_CONTEXT) return null; // 测试里不真调
  const out = await execAsync(['message', 'channel', 'info', '--channel', 'discord', '--account', 'default', '--target', `channel:${threadOrChannelId}`, '--json'], 120_000);
  const d = JSON.parse(out.slice(out.indexOf('{')));
  const ch = d?.payload?.channel ?? d?.channel;
  if (!ch?.id) return null;
  return [10, 11, 12].includes(Number(ch.type)) && ch.parent_id ? String(ch.parent_id) : String(ch.id); // 10／11／12＝各种线程
}
export function realCompletionSend({ target, message }) {
  if (process.env.NODE_TEST_CONTEXT) return Promise.resolve({ ok: false, error: '测试环境，不真发' });
  return execAsync(['message', 'send', '--channel', 'discord', '--account', 'default', '--target', `channel:${target}`, '--message', message, '--json'], 60_000).then((out) => ({ ok: true, out: out.slice(0, 200) }));
}

export function createCompletionNotice({ syncRoot = null, dataRoot = null, getCard = async () => null, parentChannelOf = realParentChannel, send = null, roleName = (a) => roleNameFromTable(dataRoot, a), log = () => {}, read, onSent = null, entryHint = null } = {}) {
  const armed = new Map(); // toolCallId → { cardId, agentId, sessionKey, runId }
  return {
    // 结案关口登记时把它自己的读卡函数和日志函数交过来（没有另外给的话才用）
    bind(deps = {}) { if (typeof deps.getCard === 'function') getCard = deps.getCard; if (typeof deps.log === 'function') log = deps.log; },
    // 结案关口放行或出审批卡时调用
    arm(toolCallId, info) {
      if (!toolCallId || !info?.cardId) return;
      armed.set(String(toolCallId), { cardId: info.cardId, agentId: info.agentId ?? null, sessionKey: info.sessionKey ?? null, runId: info.runId ?? null });
      while (armed.size > 200) armed.delete(armed.keys().next().value);
    },
    // 结案工具真执行完（after_tool_call）调用；返回一个说明发没发（给测试看，生产里不用）
    async settle(event) {
      const id = String(event?.toolCallId ?? '');
      const info = armed.get(id);
      if (!info) return { sent: false, why: '不是登记过的结案调用' };
      armed.delete(id);
      try {
        if (!toolSucceeded(event)) { log({ 结果: '完成记录不发', 卡: info.cardId, 原因: '结案工具没有成功（被挡、被拒、过期或执行失败）' }); return { sent: false, why: '工具没成功' }; }
        if (typeof send !== 'function') { log({ 结果: '完成记录不发', 卡: info.cardId, 原因: '没有配置发送函数' }); return { sent: false, why: '没有发送函数' }; }
        const threadId = threadIdOfSession(info.sessionKey);
        if (!threadId) { log({ 结果: '完成记录不发', 卡: info.cardId, 原因: '会话里读不出线程编号' }); return { sent: false, why: '没有线程编号' }; }
        const channelId = await parentChannelOf(threadId).catch((e) => { log({ 结果: '完成记录算频道失败', 卡: info.cardId, 原因: String(e?.message ?? e).slice(0, 200) }); return null; });
        if (!channelId) { log({ 结果: '完成记录不发', 卡: info.cardId, 原因: '算不出项目频道（不猜）' }); return { sent: false, why: '算不出频道' }; }
        if (isCompletionExcluded(syncRoot, channelId, read)) { log({ 结果: '完成记录不发', 卡: info.cardId, 原因: '频道在排除列表里（工坊、闲聊茶会）', 频道: channelId }); return { sent: false, why: '频道被排除', channelId }; }
        const card = await Promise.resolve(getCard(info.cardId)).catch(() => null);
        let text = completionText({ title: card?.title, executor: roleName(info.agentId), threadLink: `https://discord.com/channels/${GUILD_ID}/${threadId}` });
// 项目入口没跟上（成果没登记、状态日期落后）时，行尾多一句提醒。只是一行字，不点名、不拦结案；
        // 取不到、出错、超过 5 秒都当没有，照常发原来那一行。
        if (typeof entryHint === 'function') {
          try {
            let timer = null;
            const hint = await Promise.race([Promise.resolve(entryHint(channelId)), new Promise((resolve) => { timer = setTimeout(() => resolve(null), 5000); })]).finally(() => clearTimeout(timer));
            if (typeof hint === 'string' && hint.trim()) text += `${W.reminderSep}${hint.trim().replace(/\s+/g, ' ').slice(0, 160)}`;
          } catch (e) { log({ 结果: '入口提醒没取到', 卡: info.cardId, 原因: String(e?.message ?? e).slice(0, 200) }); }
        }
        await Promise.resolve(send({ target: channelId, message: text }));
        log({ 结果: '完成记录已发', 卡: info.cardId, 频道: channelId });
        try { onSent?.({ runId: info.runId, channelId, cardId: info.cardId }); } catch { /* 只是通知 */ }
        return { sent: true, channelId, text };
      } catch (e) {
        log({ 结果: '完成记录发送失败', 卡: info.cardId, 原因: String(e?.message ?? e).slice(0, 200) });
        return { sent: false, why: '出错' };
      }
    },
  };
}
