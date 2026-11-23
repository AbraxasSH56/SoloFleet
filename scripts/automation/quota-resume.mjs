#!/usr/bin/env node
// After a subscription-quota failure, calls the original session back once the quota is restored so it continues instead of starting over.
// 订阅额度撞限后，停在半路的活，额度恢复后由程序叫醒原会话接着做。命令型定时任务 `额度接续`，每 10 分钟一次，不调模型。
// 读：插件 quota-recovery.mjs 写的"额度失败登记"（资料/运行记录/额度/<运行编号>.json，插件不改）。
// 叫醒：官方 `openclaw agent --session-key … --message … --deliver …`，在原会话里再跑一轮，回复发回原线程。
// 账：资料/运行记录/额度/接续/账.json（644）。以"会话键"为一条链：叫醒后又撞限，新登记并进同一条链、次数接着数；只有"已接上"才清零。
// 规矩（设计 5.3）：
//   - 不归我管的（定时任务、桌面角色、备用A、备用B、会话键不是频道／线程）不进账，归白天看护的老路；
//   - 闲聊茶会、审批频道（线程取父频道）不接续；查不出来本轮不动，超 6 小时记"读不出"；
//   - 到点＝恢复时间＋2 分钟（没有恢复时间就失败时间＋5 小时），且 CodexBar 参考读数不说"还满着"；过期＝（恢复时间或失败＋5 小时）＋24 小时；
//   - 线程里已经有人接上就不叫：主人的话，或这个 bot 自己发的、晚于链的最新失败时间和最近一次发起时间、且不像额度句的话；像额度句的话任何时候都不算接上；
//   - 同一条链最多叫 2 次，两次间隔 ≥30 分钟；一轮最多发起 1 个；先记账再发起；发起是脱离的子进程，输出和退出码按次写进独立文件，主脚本不等它，下一轮核对；
//   - 结果不明（30 分钟没有退出码也没有新消息）记"结果待核"，不自动重发。
// 用法：node quota-resume.mjs [--data-root <资料根>] [--notify-target <频道编号>] [--dry-run]
// 输出：NO_REPLY（脚本自己发汇总，定时任务设成不投递）。
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DATA_ROOT, NODE_BIN, WORKSHOP_CHANNEL, join, parseJsonLoose, readJson, realRunner, realSend, withLock } from './gap-common.mjs';
import { GUILD_ID, readConfigSlice, roleAccountMap, roleDiscordId } from './lead-free.mjs';
import { windowResetAt } from './quota-catchup.mjs';
import { isQuotaSentence } from '../../plugins/personal-inbox/quota-recovery.mjs';
import { CALL_STATES, SESSION_KEY_RE, SKIP_ROLES, ledgerLookup, managedByResume } from './quota-resume-lib.mjs';
import { lexicon } from '../../plugins/personal-inbox/lexicon.mjs';
const W = lexicon(); // words follow config "locale" (zh-CN: the literals this script always used)
export { CALL_STATES, SESSION_KEY_RE, SKIP_ROLES, ledgerLookup, managedByResume };

export const CHAT_CHANNEL = crew.channels.lounge; // 闲聊茶会
export const APPROVAL_CHANNEL = crew.channels.approval; // 审批频道
export const OWNER_ID = crew.owner.userId;
export const MARK = W.quotaResumePrefix;
export const MIN = 60000;
export const READY_MARGIN_MS = 2 * MIN;
export const FALLBACK_AFTER_MS = 5 * 3600000;
export const EXPIRE_AFTER_MS = 24 * 3600000;
export const GAP_MS = 30 * MIN;
export const MAX_LAUNCHES = 2;
export const UNKNOWN_AFTER_MS = 30 * MIN;
export const UNREADABLE_AFTER_MS = 6 * 3600000;
export const SUMMARY_MAX_WAIT_MS = 60 * MIN;
export const MAX_NOTICE_TRIES = 5;
// 真实测试里 `openclaw message read／channel info` 在机器忙时单次要 20～51 秒（负载 6.6），30 秒会超时、链卡在“已发起”读不出；改 90 秒，每轮最多读 4 次（最坏 4×90＝360 秒，所以定时任务超时给 600 秒）
export const READ_TIMEOUT_MS = 90000;
const PENDING = new Set(['待发起', '发起失败待重试']);
const OPEN = new Set(['待发起', '已发起', '发起失败待重试', '结果待核', '读不出']); // 新登记可以并进这些链

export const WAKE_TEXT = W.quotaResumeWakeText(MARK);

// ---------- 纯判断 ----------
// 只认官方额度报错的样子（Fable 叫醒后 bot 回话里提到“上次因额度中断”不该被当成没接上。
// 官方句式：插件 quota-recovery.mjs 认的 “you've hit your (session|5-hour|weekly|opus|sonnet|fable) limit”，
// 以及官方回复里带的 “resets 2:30am (时区)” 样子（短句才算，免得 bot 长篇回话里引用）。
export function quotaLike(text) {
  const t = String(text ?? '');
  if (isQuotaSentence(t)) return true;
  return t.length < 300 && (/hit your[^\n]{0,40}limit/i.test(t) || /resets\s+(?:[a-z]{3,9}\s+\d{1,2}(?:,|\s+at)?\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)/i.test(t));
}
export function readyAt(chain) { return (Number.isFinite(chain.恢复时间毫秒) ? chain.恢复时间毫秒 : chain.最新失败时间毫秒 + FALLBACK_AFTER_MS) + READY_MARGIN_MS; }
export function expireAt(chain) { return (Number.isFinite(chain.恢复时间毫秒) ? chain.恢复时间毫秒 : chain.最新失败时间毫秒 + FALLBACK_AFTER_MS) + EXPIRE_AFTER_MS; }
// ---------- 文件 ----------
export function paths(dataRoot) {
  const quotaDir = join(dataRoot, W.layout.runLogs, W.layout.runLogDirs.quota);
  const dir = join(quotaDir, W.layout.runLogDirs.quotaResume);
  return { quotaDir, dir, ledger: join(dir, '账.json'), lock: join(dir, '.接续.lock'), logs: join(dir, '发起日志') };
}
export function writeFile644(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  writeFileSync(tmp, text, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
}
export const writeJson644 = (path, obj) => writeFile644(path, JSON.stringify(obj, null, 2) + '\n');
export function listRegistry(quotaDir) {
  let names = [];
  try { names = readdirSync(quotaDir); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.json')) continue;
    let d = null; try { d = JSON.parse(readFileSync(join(quotaDir, n), 'utf8')); } catch { continue; }
    if (d && typeof d === 'object' && d.运行编号) out.push(d);
  }
  return out;
}
const emptyLedger = () => ({ 版本: 1, 链: {}, 运行: {}, 通知: [] });

// ---------- 一轮 ----------
// deps: { slice(), channelInfo(id), readMessages(id), launch(spec), send(text, channel), codexbar(), now() }
export async function tick({ dataRoot = DEFAULT_DATA_ROOT, deps, notifyChannel = WORKSHOP_CHANNEL, dryRun = false, maxReads = 4 }) {
  const P = paths(dataRoot);
  const now = deps.now();
  const result = { launched: [], changes: [], notices: 0, reads: 0 };
  const locked = await withLock(P.lock, async () => {
    const ledger = readJson(P.ledger, null) ?? emptyLedger();
    ledger.链 ??= {}; ledger.运行 ??= {}; ledger.通知 ??= [];
    const change = (chain, 状态, 说明) => { if (chain.状态 !== 状态) { result.changes.push(`${chain.id}: ${chain.状态} → ${状态}${说明 ? `（${说明}）` : ''}`); chain.状态 = 状态; chain.状态时间毫秒 = now; if (说明) chain.说明 = 说明; } };
    const addEvent = (chain, 类型) => ledger.通知.push({ key: `${chain.id}|${类型}|${chain.发起.length}`, 类型, 链: chain.id, 线程: chain.频道编号, 角色: chain.角色, 时间毫秒: now, 试: 0 });

    // 1. 收登记：不归我管的略过；已在账里的略过；新的并进链或新建链
    // 失败超过 14 天的登记不再收（账里 14 天后会清掉旧链，不能让还留在登记目录里的老文件把旧链又复活一遍）
    const regs = listRegistry(P.quotaDir).filter((q) => managedByResume(q) && q.失败时间毫秒 >= now - 14 * 86400000).sort((a, b) => a.失败时间毫秒 - b.失败时间毫秒);
    for (const q of regs) {
      if (ledger.运行[q.运行编号]) continue;
      const key = String(q.会话键);
      // 同一会话键有开着的、没过期的链就并入——不看登记先后（插件会先记“终态未确认”、之后才改成确认，较早的登记可能后进来；）
      const open = Object.values(ledger.链).filter((c) => c.会话键 === key && OPEN.has(c.状态) && now <= expireAt(c))
        .sort((a, b) => b.最新失败时间毫秒 - a.最新失败时间毫秒)[0];
      if (open) {
        ledger.运行[q.运行编号] = open.id; open.运行编号.push(q.运行编号);
        if (q.失败时间毫秒 > open.最新失败时间毫秒) { // 更晚的登记才更新链的“最新”：失败时间、恢复时间、型号、报错
          open.最新运行编号 = q.运行编号; open.最新失败时间毫秒 = q.失败时间毫秒;
          open.恢复时间毫秒 = Number.isFinite(q.恢复时间毫秒) ? q.恢复时间毫秒 : null; open.型号 = q.型号 ?? open.型号; open.报错 = q.报错前200字 ?? open.报错;
          delete open.读不出开始毫秒;
          if (open.状态 !== '待发起') change(open, '待发起', '又撞限，并进同一条链');
          result.changes.push(`${open.id}: 并入新登记 ${q.运行编号}`);
        } else result.changes.push(`${open.id}: 并入较早的登记 ${q.运行编号}（链的最新时间不变）`);
        continue;
      }
      // 新链编号取该会话键现有最大编号＋1（旧链清掉后不重号）
      const n = Math.max(0, ...Object.values(ledger.链).filter((c) => c.会话键 === key).map((c) => Number(String(c.id).split('#')[1]) || 0)) + 1;
      const chain = {
        id: `${key}#${n}`, 会话键: key, 角色: q.角色, 频道编号: SESSION_KEY_RE.exec(key)[2], 状态: '待发起', 状态时间毫秒: now,
        运行编号: [q.运行编号], 最新运行编号: q.运行编号, 最新失败时间毫秒: q.失败时间毫秒, 恢复时间毫秒: Number.isFinite(q.恢复时间毫秒) ? q.恢复时间毫秒 : null,
        型号: q.型号 ?? null, 报错: q.报错前200字 ?? '', 发起: [], 频道检查: null, 新建毫秒: now,
      };
      ledger.链[chain.id] = chain; ledger.运行[q.运行编号] = chain.id;
      result.changes.push(`${chain.id}: 新建（失败 ${q.运行编号}）`);
    }

    let slice = null;
    const getSlice = () => { if (!slice) slice = deps.slice(); return slice; };
    let cbar; let cbarDone = false;
    const getCodexbar = () => { if (!cbarDone) { cbarDone = true; try { cbar = deps.codexbar?.() ?? null; } catch { cbar = null; } } return cbar; }; // 每轮最多查一次（外部命令单次最长 20 秒）
    const budgetOk = () => result.reads < maxReads;
    const chains = Object.values(ledger.链).sort((a, b) => a.最新失败时间毫秒 - b.最新失败时间毫秒);
    const candidates = [];
    const unreadableFor = (chain, why) => { // 读不出的计时：超过 6 小时转“读不出”并通知一次，交看护兜底
      chain.读不出开始毫秒 ??= now;
      if (now - chain.读不出开始毫秒 > UNREADABLE_AFTER_MS && chain.状态 !== '读不出') { change(chain, '读不出', why); addEvent(chain, '读不出'); }
    };

    // 2. 逐条链往前推
    for (const chain of chains) {
      if (!OPEN.has(chain.状态)) continue;
      // 2.0 过期
      if (now > expireAt(chain)) {
        const wasActive = chain.发起.length > 0 || now - (chain.新建毫秒 ?? 0) > 60 * MIN; // 刚新建就已经过期的老登记，不吵人
        change(chain, '不接续：过期');
        if (wasActive && !String(chain.频道检查?.结果 ?? 'ok').match(/闲聊|审批/)) addEvent(chain, '过期');
        continue;
      }
      // 2a. 已发起：核对结果
      if (chain.状态 === '已发起') {
        const L = chain.发起[chain.发起.length - 1];
        const exit = readExit(L?.退出码文件);
        if (exit !== null && !L.退出码已读) { L.退出码 = exit.code; L.退出码已读 = true; }
        const failed = L && L.退出码 !== undefined && L.退出码 !== 0;
        let verdict = 'skipped';
        if (budgetOk()) verdict = await joined(chain, deps, getSlice, now, result);
        if (verdict === 'joined') { change(chain, '已接上'); continue; }
        if (failed) { // 发起命令本身失败了：不管线程读不读得出，都按发起失败处理
          change(chain, chain.发起.length >= MAX_LAUNCHES ? '接续没成功' : '发起失败待重试', `第${L.k}次发起退出码 ${L.退出码}`);
          L.结果 = '发起失败';
          if (chain.状态 === '接续没成功') addEvent(chain, '没接上');
          continue;
        }
        if (verdict === 'unreadable') { // 线程读不出：不再永远 continue——发起满 6 小时转“读不出”，交看护兜底
          if (now - L.时间毫秒 > UNREADABLE_AFTER_MS) { change(chain, '读不出', '发起后线程一直读不出'); addEvent(chain, '读不出'); }
          continue;
        }
        if (verdict === 'none' && now - L.时间毫秒 > UNKNOWN_AFTER_MS) { change(chain, '结果待核', '发起后 30 分钟没有新消息'); addEvent(chain, '结果待核'); }
        continue;
      }
      // 2a'. 结果待核：不再永远不关——线程里后来有人接上了就关成已接上，否则一直等到过期
      if (chain.状态 === '结果待核') {
        if (!budgetOk()) continue;
        if ((await joined(chain, deps, getSlice, now, result)) === 'joined') change(chain, '已接上');
        continue;
      }
      // 以下是 待发起／发起失败待重试／读不出
      // 2b. 频道排除（只查一次；查不出本轮不动）
      if (!chain.频道检查) {
        if (!budgetOk()) continue;
        const r = await channelKind(chain.频道编号, deps, result);
        if (r.error) { unreadableFor(chain, `频道信息查不出：${r.error}`); continue; }
        chain.频道检查 = { 结果: r.kind, 时间毫秒: now };
        delete chain.读不出开始毫秒;
        if (chain.状态 === '读不出') change(chain, '待发起', '频道信息查到了');
      }
      if (chain.频道检查.结果 !== 'ok') { change(chain, `不接续：${chain.频道检查.结果}`); continue; }
      // 2d. 到点没有
      if (now < readyAt(chain)) continue;
      const L0 = chain.发起[chain.发起.length - 1];
      if (L0 && now - L0.时间毫秒 < GAP_MS) continue;
      if (windowResetAt(getCodexbar(), chain.型号, chain.报错, () => now)) continue; // CodexBar 说同一个窗口还满着，再等
      // 2e. 线程里有没有人已经接上
      if (!budgetOk()) continue;
      const verdict = await joined(chain, deps, getSlice, now, result);
      if (verdict === 'joined') { change(chain, '已接上'); continue; }
      if (verdict === 'unreadable') { unreadableFor(chain, '线程消息读不出'); continue; }
      delete chain.读不出开始毫秒;
      if (chain.状态 === '读不出') change(chain, '待发起', '线程又读得出了');
      if (chain.发起.length >= MAX_LAUNCHES) { change(chain, '接续没成功', '已叫满 2 次'); addEvent(chain, '没接上'); continue; }
      candidates.push(chain);
    }

    // 3. 一轮最多发起 1 个（最早失败优先）
    if (dryRun) for (const c of candidates) result.launched.push({ 链: c.id, k: c.发起.length + 1, 线程: c.频道编号, 干跑: true });
    if (candidates.length && !dryRun) {
      const chain = candidates[0];
      const k = chain.发起.length + 1;
      const stem = `${chain.最新运行编号}-第${k}次`;
      const acct = roleAccountMap(getSlice()).get(chain.角色) ?? null;
      const L = { k, 时间毫秒: now, 运行编号: chain.最新运行编号, 日志: join(P.logs, `${stem}.log`), 退出码文件: join(P.logs, `${stem}.退出码`), 账号: acct, 状态: '已发起' };
      if (!acct) { change(chain, '接续没成功', '角色对不上账号'); addEvent(chain, '没接上'); }
      else {
        chain.发起.push(L); change(chain, '已发起', `第${k}次`);
        writeJson644(P.ledger, ledger); // 先记账，再发起
        const spec = { args: ['agent', '--agent', chain.角色, '--session-key', chain.会话键, '--message', WAKE_TEXT, '--deliver', '--channel', 'discord', '--reply-channel', 'discord', '--reply-account', acct, '--reply-to', `channel:${chain.频道编号}`, '--timeout', '900'], 日志: L.日志, 退出码文件: L.退出码文件 };
        let lr; try { lr = await deps.launch(spec); } catch (e) { lr = { ok: false, error: String(e?.message ?? e) }; }
        if (!lr?.ok) { writeFile644(L.退出码文件, `${lr?.code ?? 127}\n`); }
        result.launched.push({ 链: chain.id, k, 线程: chain.频道编号 });
        addEvent(chain, '已叫醒');
      }
    }

    // 4. 汇总通知：这一批没有待发起的了，或最早一条已等满 60 分钟；拿到回执才记已发
    const unsent = ledger.通知.filter((e) => !e.已发 && e.试 < MAX_NOTICE_TRIES);
    const hasPending = Object.values(ledger.链).some((c) => PENDING.has(c.状态) && (c.状态 === '发起失败待重试' || readyAt(c) <= now + 30 * MIN)); // 还有几个小时才到点的链（比如周限额）不拖住别的汇总
    if (unsent.length && !dryRun && (!hasPending || now - Math.min(...unsent.map((e) => e.时间毫秒)) >= SUMMARY_MAX_WAIT_MS)) {
      const text = summaryText(unsent);
      for (const e of unsent) e.试 += 1;
      let r; try { r = await deps.send(text, notifyChannel); } catch (e) { r = { ok: false, error: String(e?.message ?? e) }; }
      if (r?.ok) for (const e of unsent) { e.已发 = true; e.消息编号 = r.id; }
      result.notices = r?.ok ? 1 : 0;
    }
    // 账只留近 14 天内有动静的链（避免无限变大）；通知只留最近 14 天
    const cut = now - 14 * 86400000;
    for (const [cid, c] of Object.entries(ledger.链)) if (!OPEN.has(c.状态) && c.状态时间毫秒 < cut) { for (const r of c.运行编号) delete ledger.运行[r]; delete ledger.链[cid]; }
    ledger.通知 = ledger.通知.filter((e) => e.时间毫秒 >= cut);
    if (!dryRun) writeJson644(P.ledger, ledger);
    result.ledger = ledger;
  });
  if (locked.busy) return { busy: true, launched: [], changes: [], notices: 0, reads: 0 };
  return result;
}

function readExit(path) {
  if (!path) return null;
  try { const n = Number(readFileSync(path, 'utf8').trim()); return Number.isFinite(n) ? { code: n } : null; } catch { return null; }
}
async function channelKind(channelId, deps, result) {
  if (channelId === CHAT_CHANNEL) return { kind: '闲聊' };
  if (channelId === APPROVAL_CHANNEL) return { kind: '审批' };
  result.reads += 1;
  let info; try { info = await deps.channelInfo(channelId); } catch (e) { return { error: String(e?.message ?? e).slice(0, 100) }; }
  const isThread = [10, 11, 12].includes(Number(info?.type));
  const parent = isThread ? (info?.parentId ? String(info.parentId) : null) : String(channelId);
  if (isThread && !parent) return { error: '线程却没有上级频道编号' };
  if (parent === CHAT_CHANNEL) return { kind: '闲聊' };
  if (parent === APPROVAL_CHANNEL) return { kind: '审批' };
  return { kind: 'ok' };
}
// 线程里有没有人接上：'joined' | 'none' | 'unreadable'
async function joined(chain, deps, getSlice, now, result) {
  result.reads += 1;
  let msgs; try { msgs = await deps.readMessages(chain.频道编号); } catch { return 'unreadable'; }
  const last = chain.发起[chain.发起.length - 1];
  const anchor = Math.max(chain.最新失败时间毫秒, last?.时间毫秒 ?? 0);
  let botId = null; try { botId = roleDiscordId(getSlice(), chain.角色); } catch { botId = null; }
  for (const m of msgs ?? []) {
    const ts = Number(m.ts);
    if (!Number.isFinite(ts) || ts <= anchor) continue;
    if (String(m.authorId) === OWNER_ID) return 'joined';
    if (botId && String(m.authorId) === botId && !quotaLike(m.content)) return 'joined';
  }
  return 'none';
}
export function summaryText(events) {
  const link = (e) => `https://discord.com/channels/${GUILD_ID}/${e.线程}`;
  const by = (t) => events.filter((e) => e.类型 === t);
  const lines = [];
  if (by('已叫醒').length) lines.push(`额度恢复，已让 ${by('已叫醒').length} 件停在半路的活接着做：${by('已叫醒').map(link).join('、')}`);
  const bad = [...by('没接上'), ...by('结果待核'), ...by('读不出'), ...by('过期')];
  if (bad.length) lines.push(`有 ${bad.length} 件没接上或没法确认，请你在这些线程里说“继续”：${bad.map((e) => `${link(e)}（${e.类型}）`).join('、')}`);
  return lines.join('\n');
}

// ---------- 真实依赖 ----------
export function realDeps(env = process.env) {
  const run = realRunner(env);
  const json = (r) => { if (r.code !== 0) throw new Error(`退出码 ${r.code}`); return parseJsonLoose(r.stdout); };
  return {
    now: () => Date.now(),
    slice: () => readConfigSlice(`${homedir()}/.openclaw/openclaw.json`),
    channelInfo: async (id) => { const d = json(run(['message', 'channel', 'info', '--channel', 'discord', '--account', 'default', '--target', `channel:${id}`, '--json'], { timeout: READ_TIMEOUT_MS })); const ch = d.payload?.channel ?? d.channel; if (!ch?.id) throw new Error('读不到频道信息'); return { type: Number(ch.type), parentId: ch.parent_id ? String(ch.parent_id) : null }; },
    readMessages: async (id) => { const d = json(run(['message', 'read', '--channel', 'discord', '--account', 'default', '--target', `channel:${id}`, '--limit', '30', '--json'], { timeout: READ_TIMEOUT_MS })); return (d.payload?.messages ?? []).map((m) => ({ id: m.id, authorId: m.author?.id, ts: m.timestampMs ?? Date.parse(m.timestamp), content: m.content ?? '' })); },
    send: realSend(run),
    codexbar: () => { try { return JSON.parse(spawnSyncText('/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI', ['usage', '--provider', 'claude', '--source', 'cli', '--format', 'json', '--no-credits'])); } catch { return null; } },
    launch: (spec) => launchDetached(spec, env),
  };
}
import { spawnSync } from 'node:child_process';
import { crew } from '../../plugins/personal-inbox/crew-config.mjs';
function spawnSyncText(bin, args) { const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }); if (r.status !== 0) throw new Error('codexbar'); return r.stdout; }

// 脱离的子进程：自己再用本脚本的 --launch-child 模式，把 openclaw agent 的输出写进日志，退出时把退出码写进文件
const SELF = fileURLToPath(import.meta.url);
export async function launchDetached(spec, env = process.env) {
  mkdirSync(dirname(spec.日志), { recursive: true, mode: 0o755 });
  const specPath = `${spec.日志}.spec.json`;
  writeFile644(specPath, JSON.stringify({ ...spec }));
  return await new Promise((resolve) => {
    let settled = false; let guard = null;
    const done = (v) => { if (!settled) { settled = true; if (guard) clearTimeout(guard); resolve(v); } };
    let child;
    try { child = spawn(NODE_BIN, [SELF, '--launch-child', specPath], { detached: true, stdio: 'ignore', env }); } catch (e) { return done({ ok: false, error: String(e.message) }); }
    child.on('error', (e) => done({ ok: false, error: `起不来：${e.message}`, code: 127 }));
    child.on('spawn', () => { child.unref(); setTimeout(() => done({ ok: true }), 300); });
    guard = setTimeout(() => done({ ok: true }), 2000);
  });
}
export function launchChild(specPath, env = process.env) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const fd = openSync(spec.日志, 'w', 0o644);
  const bin = env.OPENCLAW_BIN || crew.paths.openclawBin;
  const c = spawn(bin, spec.args, { stdio: ['ignore', fd, fd], env: { ...env, PATH: `${dirname(NODE_BIN)}:${env.PATH ?? ''}`, NODE_NO_WARNINGS: '1' } });
  c.on('error', (e) => { try { writeFileSync(fd, `起不来：${e.message}\n`); } catch { /* 写不进日志也要写退出码 */ } finish(127); });
  c.on('close', (code) => finish(code ?? 1));
  let fin = false;
  function finish(code) { if (fin) return; fin = true; try { closeSync(fd); } catch { /* 已关 */ } writeFile644(spec.退出码文件, `${code}\n`); }
}

// ---------- 命令行 ----------
export async function main(argv = process.argv.slice(2), { deps = null } = {}) {
  if (argv[0] === '--launch-child') { launchChild(argv[1]); return null; }
  const o = { dry: false }; let dataRoot = DEFAULT_DATA_ROOT, notify = WORKSHOP_CHANNEL;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') o.dry = true;
    else if (argv[i] === '--data-root' || argv[i] === '--notify-target') {
      const v = argv[i + 1];
      if (v === undefined || String(v).startsWith('--') || String(v).trim() === '') { console.error(`参数 ${argv[i]} 后面没有值`); return 2; } // 缺值就报错退出，绝不静默退回默认（正式资料根／工坊）
      if (argv[i] === '--data-root') dataRoot = v; else notify = v;
      i += 1;
    }
    else { console.error(`看不懂这个参数：${argv[i]}`); return 2; }
  }
  try {
    const r = await tick({ dataRoot, deps: deps ?? realDeps(), notifyChannel: notify, dryRun: o.dry });
    if (o.dry) console.log(JSON.stringify({ 变化: r.changes, 将发起: r.launched }, null, 1)); else console.log('NO_REPLY');
    return 0;
  } catch (e) { console.error(`额度接续出错：${e.message}`); return 1; }
}
function isDirect() {
  const a = process.argv[1];
  if (!a || basename(a) !== 'quota-resume.mjs') return false;
  try { return realpathSync(a) === realpathSync(SELF); } catch { return false; }
}
if (isDirect()) main().then((c) => { if (c !== null) process.exitCode = c; });
