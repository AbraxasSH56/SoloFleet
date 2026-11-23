// The two ledger tools: pending_decision_register and pending_decision_update.
// “等你定”登记和更新工具。两个工具都只写台账、不发消息。
// register 给 main 和各执行者、desktop、diary（配置里加名）；update 只给 main（配置里只给 main 加名，这里再核一次角色）。
import { withLedger, registerItem, updateItem, OWNER_ID, WORKSHOP_CHANNEL } from './pending-ledger.mjs';
import { lexicon } from './lexicon.mjs';
const W = lexicon(); // tool texts and status words follow config "locale"
const PT = W.pendingTools;
const S = W.ledgerStatus;

const str = (maxLength, description) => ({ type: 'string', minLength: 1, maxLength, description });
export const registerParameters = {
  type: 'object', additionalProperties: false,
  required: ['title', 'suggestion', 'blocks', 'requestMessageId'],
  properties: {
    title: str(200, PT.title),
    suggestion: str(500, PT.suggestion),
    blocks: str(500, PT.blocks),
    deadline: str(64, PT.deadline),
    requestMessageId: str(32, PT.requestMessageId),
    requestChannelId: str(32, PT.requestChannelId),
    requestLink: str(300, PT.requestLink),
    threadId: str(32, PT.threadId),
  },
};
export const updateParameters = {
  type: 'object', additionalProperties: false,
  required: ['id', 'status', 'source'],
  properties: {
    id: str(40, PT.id),
    status: { type: 'string', enum: [S.received, S.decided, S.revoked, S.noReply] },
    recheckDate: str(10, PT.recheckDate),
    decision: str(500, PT.decision),
    source: str(32, PT.source),
    basis: str(300, PT.basis),
  },
};

const out = (details) => ({ content: [{ type: 'text', text: JSON.stringify(details) }], details });

// 真实读一条 Discord 消息：先在事项线程、再在原请示频道、最后在工坊里找；读失败抛错，找不到返回 null。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { crew } from './crew-config.mjs';
// 必须用异步：插件跑在 Gateway 进程里，同步执行 openclaw 命令会把 Gateway 自己的事件循环堵住，命令连不上 Gateway，只能等到超时
const execFileAsync = promisify(execFile);
export function makeMessageReader(env = process.env) {
  const bin = env.OPENCLAW_BIN || crew.paths.openclawBin;
  return async (item, messageId) => {
    const chans = [item.threadId, item.requestChannelId, WORKSHOP_CHANNEL].filter(Boolean);
    let lastErr = null;
    for (const ch of chans) {
      try {
        const { stdout: out } = await execFileAsync(bin, ['message', 'read', '--channel', 'discord', '--account', 'default', '--target', `channel:${ch}`, '--message-id', String(messageId), '--json'], { encoding: 'utf8', timeout: 60000, env: { ...env, NODE_NO_WARNINGS: '1' } });
        const d = JSON.parse(out.slice(out.indexOf('{')));
        const m = (d.payload?.messages ?? [d.payload?.message]).filter(Boolean).find((x) => String(x.id) === String(messageId));
        if (m) return { id: String(m.id), authorId: m.author?.id, replyToId: m.referenced_message?.id ?? m.message_reference?.message_id ?? null, channelId: m.channel_id ?? ch, content: m.content ?? '' };
      } catch (e) { lastErr = e; }
    }
    if (lastErr) throw lastErr;
    return null;
  };
}

export function registerPendingTools(api, { ledgerPath, readMessage, now = () => Date.now(), watchDir = null }) {
  api.registerTool({
    contextVersion: 2,
    create(ctx) {
      return {
        name: 'pending_decision_register',
        description: PT.registerDescription,
        parameters: registerParameters,
        async execute(_id, params) {
          if (!ledgerPath) return out({ ok: false, message: '没有资料根，台账不可用' });
          const r = await withLedger(ledgerPath, (L) => {
            const res = registerItem(L, { ...params, botId: ctx?.agentId ?? ctx?.channelContext?.applicationId ?? null }, now());
            return res.error ? { noWrite: true, error: res.error } : { item: res.item, existing: !!res.existing };
          }, { now, watchDir });
          if (r.busy) return out({ ok: false, message: r.message });
          if (r.error) return out({ ok: false, message: r.error });
          return out({ ok: true, id: r.item.id, existing: r.existing, status: r.item.status });
        },
      };
    },
  }, { name: 'pending_decision_register' });

  api.registerTool({
    contextVersion: 2,
    create(ctx) {
      if (ctx?.agentId && ctx.agentId !== 'main') return null; // update 只给 main
      return {
        name: 'pending_decision_update',
        description: PT.updateDescription,
        parameters: updateParameters,
        async execute(_id, params) {
          if (!ledgerPath) return out({ ok: false, message: '没有资料根，台账不可用' });
          let message = null; let readErr = null;
          try {
            const L0 = await withLedger(ledgerPath, (L) => ({ noWrite: true, item: L.items.find((i) => i.id === params.id) }), { now, watchDir });
            const item = L0.item;
            if (item && !(item.isTest && params.status === S.revoked) && !(item.autoRegistered && params.status === S.revoked)) message = await readMessage(item, params.source);
          } catch (e) { readErr = String(e.message ?? e); }
          if (readErr) return out({ ok: false, message: `读不到那条消息（${readErr}），不改` });
          const r = await withLedger(ledgerPath, (L) => {
            const res = updateItem(L, params, message, now());
            return res.error ? { noWrite: true, error: res.error } : { item: res.item };
          }, { now, watchDir });
          if (r.busy) return out({ ok: false, message: r.message });
          if (r.error) return out({ ok: false, message: r.error });
          return out({ ok: true, id: r.item.id, status: r.item.status, recheckDate: r.item.recheckDate, basis: r.item.decisionBasis });
        },
      };
    },
  }, { name: 'pending_decision_update' });
}
