#!/usr/bin/env node
// Scheduled command (every 30 minutes, no model calls) that keeps the pending-decision ledger honest and registers missed requests.
// “等你定”命令型定时任务：每 30 分钟跑一遍，不调模型、不花额度。
// 做的事全部在 pending-ledger.mjs 的 runTick 里：读台账→识别回应→总表置顶／更新→首点名→3 天合并提醒→截止前提醒。
// 输出：没话说输出 NO_REPLY（本任务自己用 openclaw message 发到工坊，不靠官方投递）。
// 用法：node pending-decisions.mjs [--ledger <路径>] [--dry-run]
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { runTick, WORKSHOP_CHANNEL } from '../../plugins/personal-inbox/pending-ledger.mjs';
import { reconcileRequests } from '../../plugins/personal-inbox/request-watch.mjs';

import { crew } from '../../plugins/personal-inbox/crew-config.mjs';
import { lexicon } from '../../plugins/personal-inbox/lexicon.mjs';
const W = lexicon(); // folder and file names and report markers follow config "locale" (zh-CN: the literals this script always used)
const DATA_ROOT = process.env.OPENCLAW_DATA_ROOT || crew.paths.dataRoot; // env var first (offline smoke tests), then config
const DEFAULT_LEDGER = join(DATA_ROOT, W.layout.audit, W.layout.auditAwaiting, W.layout.awaitingLedgerFile);
const WATCH_DIR = join(DATA_ROOT, '运行记录', '看护');
export const RUN_DEADLINE_MS = 180 * 1000; // 整轮总时限（补登记修改·①-3）：定时任务上限 300 秒；到这个点 runTick 不再起新的读和发送，最坏再多 60 秒（已经开始的那一条命令）＝240 秒，不会在持锁时被强杀

export function realDiscord(env = process.env) {
  const bin = env.OPENCLAW_BIN || crew.paths.openclawBin;
  const run = (args, timeout = 60000) => execFileSync(bin, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], env: { ...env, NODE_NO_WARNINGS: '1', PATH: `${dirname(process.execPath)}:${env.PATH ?? '/usr/bin:/bin'}` } }); // openclaw 命令行要用 node：把当前 node 所在目录放进 PATH（我手动跑时 PATH 里没有 node，命令起不来）
  const json = (out) => { const i = out.indexOf('{'); return JSON.parse(out.slice(i)); };
  const base = ['message']; const acct = ['--channel', 'discord', '--account', 'default'];
  return {
    async send({ target, text, replyTo }) {
      const args = [...base, 'send', ...acct, '--target', `channel:${target}`, '--message', text, '--json'];
      if (replyTo) args.push('--reply-to', String(replyTo));
      const d = json(run(args));
      const p = d.payload ?? d;
      if (d.dryRun || p.dryRun) return { messageId: null };
      const id = p.messageId ?? p.result?.messageId ?? p.message?.id ?? null;
      return { messageId: id ? String(id) : null };
    },
    async edit({ target, messageId, text }) { run([...base, 'edit', ...acct, '--target', `channel:${target}`, '--message-id', String(messageId), '--message', text, '--json']); },
    async pin({ target, messageId }) { run([...base, 'pin', ...acct, '--target', `channel:${target}`, '--message-id', String(messageId), '--json']); },
    async readReplies(item, timeoutMs = 60000) { // 命令上限：取传进来的剩余时间和 60 秒里小的；不传＝60 秒（runTick 不带总时限时、以及核账补登记都用这个）
      // 读原请示所在频道（或事项线程）原请示之后的消息，回给 runTick 判断；读失败抛错，由它记“未知”
      const chan = item.threadId ?? item.requestChannelId;
      if (!chan) return [];
      const d = json(run([...base, 'read', ...acct, '--target', `channel:${chan}`, '--after', String(item.requestMessageId), '--limit', '50', '--json'], Math.min(60000, Math.max(1000, timeoutMs))));
      return (d.payload?.messages ?? []).map((m) => ({ id: m.id, authorId: m.author?.id, replyToId: m.referenced_message?.id ?? m.message_reference?.message_id ?? m.replyToId ?? null, channelId: m.channel_id ?? chan, content: m.content ?? '' }));
    },
    // 认到主人的回应后：建一次性任务叫醒总控去判（照白天看护的做法；不靠发消息点名——消息是总控自己的账号发的，叫不醒她）
    async wakeJudge({ item, replyId }) {
      const msg = `主人回了“等你定”台账里的一件（台账编号 ${item.id}：${item.title}）：他的回应消息编号 ${replyId}（原请示 ${item.requestLink ?? item.requestMessageId}）。请用 pending_decision_update 判：“周末再看／收到”→状态“收到”并写约定日期（没约定不写）；给了答案→“已定”并写结论一句；source 填 ${replyId}；判不准就在原线程点名主人，不猜。只做这一件事，不发别的消息。`;
      const d = json(run(['automations', 'add', '--name', `等你定叫起-${item.id}`, '--at', '1m', '--agent', 'main', '--session', 'isolated', '--message', msg, '--no-deliver', '--delete-after-run', '--json']));
      const id = d.id ?? d.job?.id ?? d.payload?.id ?? null;
      return { jobId: id ? String(id) : null };
    },
    // 补登记要弄清请示发在线程里还是频道主区域：线程的类型是 10／11／12，parent_id 是它的上级频道
    async channelInfo(channelId, remainingMs = 60000) {
      const d = json(run([...base, 'channel', 'info', ...acct, '--target', `channel:${channelId}`, '--json'], Math.min(60000, Math.max(1000, remainingMs)))); // 单次 60 秒；核账整轮另有 90 秒总预算
      const ch = d.payload?.channel ?? d.channel;
      if (!ch?.id) throw new Error('读不到频道信息');
      return { type: Number(ch.type), parentId: ch.parent_id ? String(ch.parent_id) : null };
    },
    async search({ query, channelId }) {
      const d = json(run([...base, 'search', ...acct, '--channel-id', String(channelId ?? WORKSHOP_CHANNEL), '--query', query, '--limit', '10', '--json']));
      return d.payload?.messages ?? d.messages ?? [];
    },
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const i = argv.indexOf('--ledger');
  const path = i >= 0 ? argv[i + 1] : DEFAULT_LEDGER;
  const discord = deps.discord ?? realDiscord();
  const nowFn = deps.now ?? (() => Date.now());
  const startedAt = nowFn(); // 整轮总时限从这里起算（核账也算在里面）
// bot 发了带按钮的请示却没登记 → 先补登记（出错只记一行，不影响后面照常跑台账）。--ledger 指到别处（测试）时不做。
  if (!(i >= 0) || deps.reconcile) {
    try {
      const rec = await (deps.reconcile ?? reconcileRequests)({ dataRoot: DATA_ROOT, ledgerPath: path, discord, now: deps.now ?? (() => Date.now()), watchDir: WATCH_DIR, log: (row) => process.stderr.write(`请示补登记：${JSON.stringify(row)}\n`) });
      if (rec?.registered) process.stderr.write(`请示补登记：补了 ${rec.registered} 件\n`);
    } catch (e) { process.stderr.write(`请示补登记失败：${String(e?.message ?? e).slice(0, 160)}\n`); }
  }
  const r = await runTick({ path, now: nowFn, discord, watchDir: WATCH_DIR, deadlineAt: startedAt + (deps.deadlineMs ?? RUN_DEADLINE_MS) });
  if (r.busy) process.stderr.write(`台账忙或锁待核：${r.message}\n`); // 不往标准输出写，免得被官方投递当通知发出去
  process.stdout.write('NO_REPLY\n');
  return 0;
}

if (process.argv[1]?.endsWith('pending-decisions.mjs')) main().then((c) => process.exit(c)).catch((e) => { process.stderr.write(`等你定失败：${e.message}\n`); process.exit(1); });
