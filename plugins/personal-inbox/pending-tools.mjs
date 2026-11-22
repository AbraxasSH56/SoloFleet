// The two ledger tools: pending_decision_register and pending_decision_update.
// “等你定”登记和更新工具。两个工具都只写台账、不发消息。
// register 给 main 和各执行者、desktop、diary（配置里加名）；update 只给 main（配置里只给 main 加名，这里再核一次角色）。
import { withLedger, registerItem, updateItem, OWNER_ID, WORKSHOP_CHANNEL } from './pending-ledger.mjs';

const str = (maxLength, description) => ({ type: 'string', minLength: 1, maxLength, description });
export const registerParameters = {
  type: 'object', additionalProperties: false,
  required: ['title', 'suggestion', 'blocks', 'requestMessageId'],
  properties: {
    title: str(200, '要主人定的事，一句话。'),
    suggestion: str(500, '你的建议。'),
    blocks: str(500, '不定会卡住什么。'),
    deadline: str(64, '截止时间（ISO 时间），没有就写“没截止”。'),
    requestMessageId: str(32, '原请示的消息编号；同一原请示重复登记只留一行。'),
    requestChannelId: str(32, '原请示所在频道或线程的编号。'),
    requestLink: str(300, '原请示的消息链接。'),
    threadId: str(32, '这件事的事项线程编号（有的话）。'),
  },
};
export const updateParameters = {
  type: 'object', additionalProperties: false,
  required: ['id', 'status', 'source'],
  properties: {
    id: str(40, '台账里的编号，如 D-261112-01ab。'),
    status: { type: 'string', enum: ['收到', '已定', '撤销', '没回'] },
    recheckDate: str(10, '“收到”时约定的复查日 YYYY-MM-DD；没约定就不写，默认 7 天后。'),
    decision: str(500, '“已定”时的结论一句话。'),
    source: str(32, '主人那条回应的消息编号（工具会去读这条消息核对）。判标题带“（程序补登记）”的条目为“撤销”时不需要他的回应消息，这里随便填一个编号或“无”。'),
    basis: str(300, '对应依据：那条消息没回复关联这件、也不在事项线程里时，引他原话里点到这件的几个字。撤销“（程序补登记）”的条目时必填：写明为什么撤（比如“他已经点了按钮”“这不是要他定的事”）。'),
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
        description: '把一件要主人定的事登记到“等你定”台账（丙档请示发出的同时调用）。同一原请示消息编号重复登记直接返回已有那行。只写台账，不发消息。',
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
        description: '判定主人对某件“等你定”的回应：收到（带约定日期）／已定（带结论）／撤销。工具会读他那条回应，核作者是他本人、回应对应这一件（回复关联、在事项线程里，或你填的“对应依据”确在他原话里）、这条回应没处理过，三样都过才改。不发消息。例外：标题带“（程序补登记）”的条目（程序替 bot 补登记的，可能是误报，比如他已经点了按钮）可以直接判“撤销”，不用他的回应消息，但“对应依据”必须填（写明为什么撤）；source 随便填一个编号或“无”。',
        parameters: updateParameters,
        async execute(_id, params) {
          if (!ledgerPath) return out({ ok: false, message: '没有资料根，台账不可用' });
          let message = null; let readErr = null;
          try {
            const L0 = await withLedger(ledgerPath, (L) => ({ noWrite: true, item: L.items.find((i) => i.id === params.id) }), { now, watchDir });
            const item = L0.item;
            if (item && !(item.isTest && params.status === '撤销') && !(item.autoRegistered && params.status === '撤销')) message = await readMessage(item, params.source);
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
