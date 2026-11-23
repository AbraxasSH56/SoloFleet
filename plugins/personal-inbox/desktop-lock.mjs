// Desktop exclusive lock and waiting queue for the desktop operator, plus the approval-card wiring for the six sensitive operation types.
// 桌面独占锁。一个锁文件，同一时间只有一个线程能动屏幕。
// 桌面角色第一次用 computer 或 browser 时系统自动拿锁；拿不到就挡下，由她回一句“我在别处忙”。
// 桌面独占锁和等候名单：核对、放锁、按先来后到排队；放锁时给下一位留位，由固定的命令型定时任务（tick）用桌面角色账号点名、判过号。不自动交接屏幕：下一位要自己重新叫桌面角色。
// 所有“先读锁、再改锁”的动作（拿锁、换旧锁、放锁、记等确认、记轮次结束）都放在一个很短的互斥保护里做完，
// 中间不会被别的进程插进来；整段桌面操作用的长锁（screen.lock 本身）不变。
// 这个短保护用系统自己的文件锁（macOS 的 open 带 O_EXLOCK）：拿到的进程一退出，系统自动放掉，
// 不靠“读文件内容判断持有者死没死”，也就没有残留回收、编号核对这些会互相交错的步骤。
// 等候名单（screen-queue.json）、设置文件（screen-queue-settings.json）和锁放在同一个目录，读改都在同一个短保护里做；
import { tzName } from './tz.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId as workerThreadId } from 'node:worker_threads';
import { stuckPathOf, stuckGateCheck, stuckNoteResult, stuckNoteHelp, stuckNoteAnswer, stuckDueReminders, stuckMarkReminded, isHelpRequestText, isHelpReplyText } from './stuck-guard.mjs';
import { APPROVAL_CHANNEL_ID, OWNER_MENTION } from './approval-card.mjs';
import { composeApprovalDescription, cutCodePoints, notifyApprovalCard, plainApprovalText, APPROVAL_TITLE_MAX } from './approval-card.mjs';
import { loadWords, recordObservation, loadObservations, classifyCall, describeDiagnostics, invalidateObservations, wordsPathFromLock, PROGRAM_NOTE } from './sensitive-click.mjs';

import { crew, botId } from './crew-config.mjs';
import { lexicon, escapeRe } from './lexicon.mjs';
const W = lexicon(); // words and instruction texts follow config "locale" (zh-CN: the texts this file always sent)
const Q = W.queueText;
const desktopDir = join(crew.paths.workspaceRoot, 'desktop');
export const defaultLockPath = join(desktopDir, 'screen.lock');
export const defaultLogPath = join(desktopDir, 'screen-lock.log');

// Lock/log/queue paths come from config/crew.json (paths.workspaceRoot/desktop/), shared by the plugin and the small CLI.
export function lockPathsFromConfig() {
  if (!crew.paths.workspaceRoot) return null;
  const dir = desktopDir;
  return {
    lockPath: join(dir, 'screen.lock'),
    logPath: join(dir, 'screen-lock.log'),
    queuePath: join(dir, 'screen-queue.json'),
    settingsPath: join(dir, 'screen-queue-settings.json'),
  };
}

export const SCREEN_TOOLS = ['computer', 'browser'];
export const RUN_ENDED_GRACE_MS = 2 * 60 * 1000;
export const IDLE_STALE_MS = 20 * 60 * 1000;
const GUILD_ID = crew.guildId;

// 桌面角色的 Discord 账号编号（程序用它的账号发点名，核查时按作者认）。
export const DESKTOP_USER_ID = botId('desktop');
// 主人（用户本人）的 Discord 账号编号：与 pending-ledger.mjs 里 OWNER_ID 那一项相同（测试里有一条断言防抄错）；不从那个文件引，免得两份互相牵连。
export const OWNER_USER_ID = crew.owner.userId;
export const CONTROLLER_USER_ID = botId('main');
// 请求方是主人本人时，桌面角色自己的账号叫不醒自己（requireMention＋ignoreOtherMentions），所以改用总控账号发通知点名桌面角色；其余请求方不变（桌面角色账号发、点名请求方）。
export const CONTROLLER_ACCOUNT = 'default';
export function sendRouteFor(requester) {
  return String(requester) === OWNER_USER_ID
    ? { account: CONTROLLER_ACCOUNT, authorId: CONTROLLER_USER_ID, wakesDesktop: true }
    : { account: 'desktop', authorId: DESKTOP_USER_ID, wakesDesktop: false };
}
// Node and the OpenClaw command line (used by tick to send and read messages; the desktop operator's release command uses the same node). From config paths.nodeBin / paths.openclawBin.
export const NODE_BIN = crew.paths.nodeBin;
export const OPENCLAW_BIN = crew.paths.openclawBin;

// 推进的几个时长（4.3、4.4、4.13）。
export const TICK_BUDGET_MS = 100_000; // 一次 tick 的内部时限
export const LEASE_MS = 150_000; // 推进租约
export const ATTEMPT_MS = 60_000; // 一次发送尝试的作废时刻（正常执行下的预留值）
export const SEND_TIMEOUT_MS = 30_000; // 发送子进程时限上限
export const KILL_GRACE_MS = 5_000; // SIGTERM 之后多久 SIGKILL
export const YIELD_GRACE_MS = 60_000; // 让位时刻容差：只往后延，不提前
export const MIN_LEASE_LEFT_FOR_SEND_MS = 40_000;
export const MIN_BUDGET_FOR_SEND_MS = 45_000; // 30 秒发送 + 5 秒强停 + 10 秒收尾
export const MIN_BUDGET_FOR_READ_MS = 15_000;
export const STALL_NOTE_MS = 10 * 60 * 1000; // 推进停了的提醒
export const HISTORY_AFTER_MS = 7 * 24 * 3600 * 1000; // 不占队列的旧件满 7 天挪进历史
export const SKIP_WHY = W.queueSkipReasons;
export const DEFAULT_SETTINGS = Object.freeze({ holdMinutes: 15, confirmMinutes: 5, maxNotifyAttempts: 3, paused: false });
const SETTING_RANGES = { holdMinutes: [1, 120], confirmMinutes: [1, 30], maxNotifyAttempts: [1, 10] };

export function threadIdFromSessionKey(sessionKey) {
  const match = /:(?:channel|thread):(\d+)$/.exec(String(sessionKey ?? ''));
  return match ? match[1] : null;
}

const threadLink = (threadId) => (threadId ? `https://discord.com/channels/${GUILD_ID}/${threadId}` : null);
const clock = (ms) => new Date(ms).toLocaleString(W.clockLocale, { hour12: false, timeZone: tzName() });
const randomToken = () => randomBytes(8).toString('hex');
const isDiscordId = (value) => typeof value === 'string' && /^[1-9]\d{4,24}$/.test(value);

// ---- Discord 消息编号：编号＝(毫秒时间－1420070400000)×2²²，一律按 BigInt 比大小 ----
const DISCORD_EPOCH = 1420070400000n;
export function idFromTime(ms) {
  const value = BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH;
  return (value < 0n ? 0n : value << 22n).toString();
}
export function timeFromId(id) {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}
export function compareIds(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function readLock(lockPath = defaultLockPath) {
  let text;
  try {
    text = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const lock = JSON.parse(text);
    if (!lock || typeof lock.sessionKey !== 'string') throw new Error('missing sessionKey');
    return lock;
  } catch {
    return { unreadable: true };
  }
}

// 原子创建：同名文件已存在就失败，两边抢只会有一个成功。
function createLock(lockPath, lock) {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

// 持锁方自己更新：先写临时文件再改名，读的人不会读到半截。
function rewriteLock(lockPath, lock) {
  const temp = `${lockPath}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, lockPath);
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomToken()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

// 很短的互斥保护：只在“核对 + 修改”这一小段里持有（毫秒级）。
// 打开 screen.lock.guard 时带上系统文件锁（O_EXLOCK，不阻塞 O_NONBLOCK）：同一时间只有一个打开者能成功，
// 别人得到 EAGAIN 就原地等；持有者关掉文件或进程退出（包括被强行结束），系统立刻放掉。
// 保护文件本身永远不删、不改内容，所以没有“残留”可回收，也没有“读到旧状态再动手”的步骤。
// 活着的持有者不会被抢：等到时限还拿不到就报错，让调用方挡下（宁可挡，不可两边同时进）。
// 其他任何错误（路径是目录、没权限等）立刻带着真实原因报出，不重试。
export const GUARD_WAIT_MS = 5_000;
const O_EXLOCK = 0x20; // macOS 的 open(2) 标志；Node 没导出这个常量，这台 Mac 才有此用法
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function withLockGuard(lockPath, hooks, fn) {
  if (process.platform !== 'darwin') throw new Error(`桌面锁的互斥保护目前只支持 macOS，这里是 ${process.platform}，不能继续`);
  const guardPath = `${lockPath}.guard`;
  const waitMs = hooks?.guardWaitMs ?? GUARD_WAIT_MS;
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + waitMs;
  let fd;
  for (;;) {
    try {
      fd = openSync(guardPath, fsConstants.O_RDWR | fsConstants.O_CREAT | O_EXLOCK | fsConstants.O_NONBLOCK, 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EAGAIN') throw new Error(`桌面锁的互斥保护文件打不开（${error.code}）：${error.message}`, { cause: error });
      if (Date.now() >= deadline) throw new Error(`桌面锁的互斥保护等了 ${waitMs} 毫秒，还被别的进程占着，没有强行抢（EAGAIN）`);
      sleepMs(5);
    }
  }
  try {
    hooks?.afterGuard?.();
    return fn();
  } finally {
    closeSync(fd);
  }
}

function newLock({ sessionKey, runId, requester, now }) {
  const threadId = threadIdFromSessionKey(sessionKey);
  return {
    sessionKey,
    threadId,
    link: threadLink(threadId),
    requester: requester?.senderId ?? null,
    requesterAccount: requester?.accountId ?? null,
    requesterIsOwner: requester?.senderIsOwner ?? null,
    runId: runId ?? null,
    startedAt: now,
    lastActivityAt: now,
    state: 'working',
    holderRunEnded: false,
    runEndedAt: null,
  };
}

function holderText(lock) {
  const where = lock.link ?? lock.sessionKey;
  return Q.holderText(where, lock.requester ?? Q.notRecorded, clock(lock.startedAt), clock(lock.lastActivityAt));
}

function staleReason(lock, now) {
  if (lock.state === 'waiting') return null;
  if (lock.holderRunEnded && now - lock.runEndedAt >= RUN_ENDED_GRACE_MS) return '持锁线程那一轮已经结束超过 2 分钟';
  if (now - lock.lastActivityAt >= IDLE_STALE_MS) return '持锁线程超过 20 分钟没有动过屏幕';
  return null;
}

// 排队暂停、设置读不到、名单读不懂时退回的旧说法（仍以“我在别处忙”开头）。
const LEGACY_BUSY_NOTE = '请在当前线程回一句“我在别处忙，好了再叫我”，点名叫你的人或 bot，然后结束这一轮。不要等、不要重试、不要绕开这个检查。';
const LOCK_UNREADABLE_NOTE = '桌面锁文件读不懂，不能确认屏幕有没有人在用。请在当前线程点名主人说明，不要自己改锁文件。';
const SETTINGS_INVALID_NOTE = '排队设置读不到：回话时顺带点名主人说一句。';
const STALL_NOTE = Q.stall;

// ---- 设置文件（4.10）----
function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '不是一个设置对象';
  for (const [key, [min, max]] of Object.entries(SETTING_RANGES)) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) return `${key} 要是 ${min}～${max} 的整数`;
  }
  if (typeof value.paused !== 'boolean') return 'paused 只认 true 或 false';
  return null;
}

const pickSettings = (value) => ({ holdMinutes: value.holdMinutes, confirmMinutes: value.confirmMinutes, maxNotifyAttempts: value.maxNotifyAttempts, paused: value.paused });

// 读不到有效设置（文件不在、读不懂、值不合法）一律当“设置无效”，不按默认值开工。
export function readSettings(settingsPath) {
  let text;
  try {
    text = readFileSync(settingsPath, 'utf8');
  } catch (error) {
    return { valid: false, why: error.code === 'ENOENT' ? '设置文件不在' : `设置文件读不了（${error.code}）` };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { valid: false, why: '设置文件读不懂' };
  }
  const bad = validateSettings(value);
  if (bad) return { valid: false, why: `设置值不合法：${bad}` };
  return { valid: true, values: pickSettings(value) };
}

export function queuePathsFor(lockPath, overrides = {}) {
  const dir = dirname(lockPath);
  return {
    queuePath: overrides.queuePath ?? join(dir, 'screen-queue.json'),
    historyPath: overrides.historyPath ?? join(dir, 'screen-queue-history.jsonl'),
    settingsPath: overrides.settingsPath ?? join(dir, 'screen-queue-settings.json'),
  };
}

// settings 命令：短互斥里读当前值、校验、写临时文件再改名替换、读回。
// 文件不在时按默认四个值建出来再改；文件在但读不懂或值不合法时报错退出、不改文件，不用默认值覆盖。
export function updateSettings({ lockPath = defaultLockPath, settingsPath, sets = [], _hooks } = {}) {
  const path = settingsPath ?? queuePathsFor(lockPath).settingsPath;
  if (!sets.length) return { ok: false, message: '要写 --set <键>=<值>，可以写几个。' };
  const changes = {};
  for (const item of sets) {
    const match = /^([A-Za-z]+)=(.*)$/.exec(String(item));
    if (!match) return { ok: false, message: `看不懂“${item}”，要写成 键=值。设置文件没动。` };
    const [, key, raw] = match;
    if (!(key in DEFAULT_SETTINGS)) return { ok: false, message: `没有“${key}”这个设置。设置文件没动。` };
    if (key === 'paused') {
      if (raw !== 'true' && raw !== 'false') return { ok: false, message: 'paused 只认 true 或 false。设置文件没动。' };
      changes.paused = raw === 'true';
    } else {
      if (!/^\d+$/.test(raw)) return { ok: false, message: `${key} 要是整数。设置文件没动。` };
      changes[key] = Number(raw);
    }
  }
  return withLockGuard(lockPath, _hooks, () => {
    let current;
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') return { ok: false, message: `设置文件读不了（${error.code}），没改。请报主人。` };
      current = { ...DEFAULT_SETTINGS };
    }
    if (current === undefined) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const bad = parsed === undefined ? '读不懂' : validateSettings(parsed);
      if (bad) return { ok: false, message: `设置文件已经在、但${parsed === undefined ? '读不懂' : `值不合法（${bad}）`}：没有改它，也没有用默认值覆盖。请报主人。` };
      current = pickSettings(parsed);
    }
    const next = { ...current, ...changes };
    const bad = validateSettings(next);
    if (bad) return { ok: false, message: `新值不合法：${bad}。设置文件没动。` };
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}-${randomToken()}`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    _hooks?.afterTempWrite?.();
    renameSync(temp, path);
    const back = readSettings(path);
    const same = back.valid && JSON.stringify(back.values) === JSON.stringify(next);
    return { ok: same, values: back.values, message: same ? `设置已写好并读回：${JSON.stringify(back.values)}` : `设置写完读回对不上：${JSON.stringify(back)}` };
  });
}

// ---- 等候名单（4.1）----
const OCCUPYING = new Set(['waiting', 'pending', 'notified']);
export const STATUS_TEXT = W.queueStatusText;

function emptyQueue() {
  return { version: 1, counter: 0, items: [], hold: null, lease: null, inProgress: null, sceneCheck: null, lastTickAt: null, anomalies: [], tickJobId: null };
}

// 读名单：文件不在当空名单（exists:false）；内容读不懂返回 unreadable，不覆盖。
export function readQueue(queuePath) {
  let text;
  try {
    text = readFileSync(queuePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { q: emptyQueue(), exists: false };
    throw error;
  }
  try {
    const q = JSON.parse(text);
    if (!q || q.version !== 1 || !Array.isArray(q.items) || !Number.isInteger(q.counter) || !Array.isArray(q.anomalies)) throw new Error('shape');
    return { q, exists: true };
  } catch {
    return { unreadable: true };
  }
}

function readQueueSafe(queuePath) {
  try {
    return readQueue(queuePath);
  } catch (error) {
    return { unreadable: true, error: error.message };
  }
}

// “名单空”（tick 立刻退出用）：没有占队列的件、没有留位、没有进行中记录、没有现场待检查标记。
export function isQueueIdle(q) {
  return !q.items.some((item) => OCCUPYING.has(item.status)) && !q.hold && !q.inProgress && !q.sceneCheck;
}

function saveQueue(ctx, q) {
  const cutoff = ctx.now - HISTORY_AFTER_MS;
  const old = q.items.filter((item) => !OCCUPYING.has(item.status) && item.endedAt && item.endedAt < cutoff && item.id !== q.hold?.itemId);
  if (old.length) {
    appendFileSync(ctx.paths.historyPath, `${old.map((item) => JSON.stringify(item)).join('\n')}\n`);
    q.items = q.items.filter((item) => !old.includes(item));
  }
  writeJsonAtomic(ctx.paths.queuePath, q);
}

function addAnomaly(q, at, kind, detail) {
  q.anomalies.push({ at, kind, detail });
  if (q.anomalies.length > 200) q.anomalies.splice(0, q.anomalies.length - 200);
}

const findOccupying = (q, threadId) => q.items.find((item) => item.threadId === threadId && OCCUPYING.has(item.status));
const waitingSorted = (q) => q.items.filter((item) => item.status === 'waiting').sort((a, b) => a.queuedAt - b.queuedAt || (a.id < b.id ? -1 : 1));
const itemByQueueNo = (q, queueNo) => q.items.find((item) => item.queueNo === queueNo);

function enqueue(q, { threadId, sessionKey, requester, now }) {
  const existing = findOccupying(q, threadId);
  if (existing) {
    existing.blockedCount += 1;
    existing.lastBlockedAt = now;
    existing.sessionKey = sessionKey;
    if (!isDiscordId(existing.requester) && isDiscordId(requester?.senderId)) {
      existing.requester = requester.senderId;
      existing.requesterAccount = requester.accountId ?? null;
    }
    return existing;
  }
  const item = {
    id: `${threadId}-${now}`,
    threadId,
    link: threadLink(threadId),
    sessionKey,
    requester: requester?.senderId ?? null,
    requesterAccount: requester?.accountId ?? null,
    requesterIsOwner: requester?.senderIsOwner ?? null,
    requestMessageId: null,
    queuedAt: now,
    blockedCount: 1,
    lastBlockedAt: now,
    status: 'waiting',
    queueNo: null,
    endReason: null,
    endedAt: null,
  };
  q.items.push(item);
  return item;
}

// N＝锁有效或有留位时算 1 件，加上排在这件前面的“等候”件数。
function aheadCount(q, item, lockActive) {
  const base = lockActive || q.hold ? 1 : 0;
  if (item.status !== 'waiting') return base;
  return base + Math.max(0, waitingSorted(q).findIndex((other) => other.id === item.id));
}

function tickStalled(q, now) {
  const occupying = q.items.filter((item) => OCCUPYING.has(item.status));
  if (!occupying.length) return false;
  const earliest = Math.min(...occupying.map((item) => item.queuedAt));
  return now - Math.max(q.lastTickAt ?? 0, earliest) > STALL_NOTE_MS;
}

function endHold(q, status, reason, now) {
  const hold = q.hold;
  const item = q.items.find((candidate) => candidate.id === hold.itemId);
  if (item) {
    item.status = status;
    item.endReason = reason;
    item.endedAt = now;
    item.holdRecord = hold;
  }
  q.hold = null;
  return item;
}

function logEvent(logPath, entry) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${JSON.stringify({ ...entry, ...runtimeFacts() })}\n`);
  } catch {
    // 只是记录
  }
}

const scriptPathFor = () => join(crew.paths.projectRoot, 'scripts', 'desktop-lock.mjs');

function noteCommand(ctx, item) {
  const base = `${NODE_BIN} ${scriptPathFor(ctx.lockPath)} note --thread ${item.threadId} --message ${Q.noteMessage}`;
  return isDiscordId(item.requester) ? base : `${base} --requester ${Q.noteRequester}`;
}

// 选人函数（4.3）：调用前已确认设置有效、没暂停。有留位不另挑人；锁有效不挑人；
// 锁已失效、有人等：先在名单里存好现场待检查标记并确认写进去，再把旧锁改名留底（4.8）。
function selectNext(ctx, q) {
  if (q.hold) return { kind: 'has-hold', hold: q.hold };
  const lock = readLock(ctx.lockPath);
  if (lock?.unreadable) return { kind: 'lock-unreadable' };
  if (lock && !staleReason(lock, ctx.now)) return { kind: 'lock-active' };
  if (!waitingSorted(q).length) return { kind: 'empty' };
  if (lock) {
    const reason = staleReason(lock, ctx.now);
    q.sceneCheck = { from: '旧锁接管', oldThreadId: lock.threadId ?? null, oldLink: lock.link ?? null, oldStartedAt: lock.startedAt ?? null, oldLastActivityAt: lock.lastActivityAt ?? null, reason, markedAt: ctx.now };
    saveQueue(ctx, q);
    const back = readQueue(ctx.paths.queuePath);
    if (!back.q?.sceneCheck) throw new Error('现场待检查标记没写进名单，旧锁没挪');
    ctx.hooks?.afterMarkSaved?.();
    try {
      renameSync(ctx.lockPath, `${ctx.lockPath}.stale-${ctx.now}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    logEvent(ctx.logPath, { at: ctx.now, event: 'queue-stale-lock-moved', oldThreadId: lock.threadId ?? null, reason });
  }
  for (const item of waitingSorted(q)) {
    if (!isDiscordId(item.requester)) {
      item.status = 'needs-info';
      item.endReason = '没有请求方编号';
      item.endedAt = ctx.now;
      logEvent(ctx.logPath, { at: ctx.now, event: 'queue-needs-info', threadId: item.threadId });
      continue;
    }
    q.counter += 1;
    const queueNo = `Q${String(q.counter).padStart(4, '0')}`;
    item.status = 'pending';
    item.queueNo = queueNo;
    q.hold = {
      queueNo, itemId: item.id, threadId: item.threadId, link: item.link, requester: item.requester, queuedAt: item.queuedAt,
      requestMessageId: item.requestMessageId ?? null, status: 'pending', selectedAt: ctx.now, attempts: [],
      messageId: null, messageAt: null, yieldAt: null, readIncompleteStreak: 0, readIncompleteTotal: 0, fullNotFound: 0,
    };
    logEvent(ctx.logPath, { at: ctx.now, event: 'queue-selected', queueNo, threadId: item.threadId });
    return { kind: 'selected', hold: q.hold };
  }
  return { kind: 'empty' };
}

// 放锁时记下“原来那把锁”的几项：恢复时靠它判断锁后来有没有变。
// 轮次结束只改 holderRunEnded/runEndedAt，不算变；改“等确认”、同线程又动过屏幕、重新建锁都会改下面某一项。
function lockMark(lock) {
  return { sessionKey: lock.sessionKey ?? null, startedAt: lock.startedAt ?? null, state: lock.state ?? null, lastActivityAt: lock.lastActivityAt ?? null, runId: lock.runId ?? null };
}

// 锁是不是还是放锁时那一把。旧格式记录没记原锁：只有锁仍是“做事中”、而且放锁之后没再动过屏幕，才算原来那把。
function isReleasingLock(inProgress, lock) {
  const mark = inProgress.lock;
  if (!mark) return lock.state === 'working' && (lock.lastActivityAt ?? 0) <= inProgress.at;
  const now = lockMark(lock);
  return Object.keys(mark).every((key) => mark[key] === now[key]);
}

// 两份文件中途断了怎么恢复（4.9）。调用前已确认设置有效、没暂停。
function recoverQueue(ctx, q) {
  const notes = [];
  if (q.inProgress?.kind === 'releasing') {
    const target = q.inProgress.threadId;
    const lock = readLock(ctx.lockPath);
    if (lock && !lock.unreadable && lock.threadId === target && !isReleasingLock(q.inProgress, lock)) {
      // 放锁断了之后，同线程又把锁改了（比如改成“等确认”）：不替它放锁、不选人，锁原样留着，冲突记进异常（4.7“等确认”绝不自动挪走）。
      addAnomaly(q, ctx.now, '放锁中断后锁已变', { threadId: target, releasingAt: q.inProgress.at, was: q.inProgress.lock ?? null, now: lockMark(lock) });
      q.inProgress = null;
      notes.push(`放锁中断：线程 ${target} 的锁后来变了（现在是${lock.state === 'waiting' ? '“等确认”' : '“做事中”'}），锁保留、不选人，已记异常`);
    } else {
      if (lock && !lock.unreadable && lock.threadId === target) {
        unlinkSync(ctx.lockPath);
        notes.push(`放锁中断：替线程 ${target} 删掉还没删的锁`);
      }
      q.inProgress = null;
      const selected = selectNext(ctx, q);
      notes.push(`放锁中断：接着选人（${selected.kind}${selected.hold ? ` ${selected.hold.queueNo}` : ''}）`);
    }
  }
  if (q.hold) {
    const lock = readLock(ctx.lockPath);
    if (lock && !lock.unreadable && lock.threadId === q.hold.threadId) {
      const queueNo = q.hold.queueNo;
      endHold(q, 'taken', '拿到锁（中断后补记）', ctx.now);
      notes.push(`拿锁中断：补记 ${queueNo} 已接`);
    }
  }
  if (notes.length) logEvent(ctx.logPath, { at: ctx.now, event: 'queue-recover', notes });
  return notes;
}

function selectedNote(selected) {
  if (selected.kind === 'selected') return `已把屏幕排给下一位（线程 ${selected.hold.link ?? selected.hold.threadId}，排队号 ${selected.hold.queueNo}），程序两分钟左右去点名，你不用管。`;
  if (selected.kind === 'has-hold') return `屏幕已经留给排在前面的那位（线程 ${selected.hold.link ?? selected.hold.threadId}，排队号 ${selected.hold.queueNo}），程序会去点名，你不用管。`;
  return '名单是空的。';
}

// 拿屏幕：没锁或旧锁时由来的人拿。旧锁照现在的做法改名留底；旧锁或现场待检查标记 → 这一次返回不放行、提示先截图看现场，同时清掉标记。
function takeScreen(ctx, q, lock, { sessionKey, runId, requester, item }) {
  const stale = lock ? staleReason(lock, ctx.now) : null;
  if (lock) {
    ctx.hooks?.afterRead?.(lock);
    try {
      renameSync(ctx.lockPath, `${ctx.lockPath}.stale-${ctx.now}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    ctx.hooks?.afterStaleMoved?.();
  }
  if (!createLock(ctx.lockPath, newLock({ sessionKey, runId, requester, now: ctx.now }))) {
    return { allow: false, reason: `桌面刚被另一个线程拿走。${LEGACY_BUSY_NOTE}` };
  }
  ctx.hooks?.afterLockCreated?.();
  if (item) {
    if (q.hold?.itemId === item.id) endHold(q, 'taken', '拿到锁', ctx.now);
    else {
      item.status = 'taken';
      item.endReason = '拿到锁';
      item.endedAt = ctx.now;
    }
  }
  const mark = q.sceneCheck;
  q.sceneCheck = null;
  if (lock) {
    return {
      allow: false,
      reason: `桌面上一把旧锁已失效（${stale}），已替你换成你这个线程的锁。旧锁：${holderText(lock)}。先截图看屏幕现状，确认屏幕上没有别人留下的还在动的操作，在当前线程说明一句，再重新调用；拿不准就点名主人。`,
    };
  }
  if (mark) return { allow: false, reason: markPrompt(mark) };
  return { allow: true };
}

function markPrompt(mark) {
  return `上一件活的旧锁已失效（${mark.reason ?? '原因没记'}），系统已挪走它，现在替你换成你这个线程的锁。旧锁：线程 ${mark.oldLink ?? mark.oldThreadId ?? '未记录'}，开始 ${mark.oldStartedAt ? clock(mark.oldStartedAt) : '未记录'}，最后一次动屏幕 ${mark.oldLastActivityAt ? clock(mark.oldLastActivityAt) : '未记录'}。先截图看屏幕现状，确认屏幕上没有别人留下的还在动的操作，在当前线程说明一句，再重新调用；拿不准就点名主人。`;
}

function queuedText(ctx, q, item, { lock, why }) {
  const lockActive = Boolean(lock && !lock.unreadable && !staleReason(lock, ctx.now));
  const n = aheadCount(q, item, lockActive);
  let head;
  if (why === 'lock') head = Q.lockHead(lock.state === 'waiting', holderText(lock));
  else if (why === 'hold') head = Q.holdHead(q.hold.queueNo);
  else head = Q.lineHead;
  const including = lockActive || q.hold ? Q.including : '';
  let text = Q.body(head, n, including, isDiscordId(item.requester) ? Q.requesterKnown(item.requester, item.requester === OWNER_USER_ID) : Q.requesterUnknown);
  if (!item.requestMessageId || !isDiscordId(item.requester)) text += `${Q.noteLead}${noteCommand(ctx, item)}`;
  if (tickStalled(q, ctx.now)) text += STALL_NOTE;
  return text;
}

// 原来的锁核对（排队暂停、设置无效、名单读不懂时退回用）。
function legacyAccess(ctx, { sessionKey, runId, requester }) {
  const { lockPath, now } = ctx;
  const _hooks = ctx.hooks;
  const lock = readLock(lockPath);
  if (lock === null) {
    if (createLock(lockPath, newLock({ sessionKey, runId, requester, now }))) return { allow: true };
    return { allow: false, reason: `桌面刚被另一个线程拿走。${LEGACY_BUSY_NOTE}` };
  }
  if (lock.unreadable) return { allow: false, reason: LOCK_UNREADABLE_NOTE };
  if (lock.sessionKey === sessionKey) {
    rewriteLock(lockPath, { ...lock, requester: lock.requester ?? requester?.senderId ?? null, requesterAccount: lock.requesterAccount ?? requester?.accountId ?? null, requesterIsOwner: lock.requesterIsOwner ?? requester?.senderIsOwner ?? null, runId: runId ?? lock.runId, lastActivityAt: now, state: 'working', holderRunEnded: false, runEndedAt: null });
    return { allow: true };
  }
  const stale = staleReason(lock, now);
  if (!stale) {
    const waiting = lock.state === 'waiting' ? '（那边屏幕上留着等主人确认的东西）' : '';
    return { allow: false, reason: `桌面正被另一个线程占用${waiting}。${holderText(lock)}。${LEGACY_BUSY_NOTE}` };
  }
  // 旧锁：先改名挪开，再原子创建新锁。整段在互斥保护里，中间不会有别人插进来。
  _hooks?.afterRead?.(lock);
  const stalePath = `${lockPath}.stale-${now}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  _hooks?.afterStaleMoved?.();
  if (!createLock(lockPath, newLock({ sessionKey, runId, requester, now }))) {
    return { allow: false, reason: `桌面刚被另一个线程拿走。${LEGACY_BUSY_NOTE}` };
  }
  return {
    allow: false,
    reason: `桌面上一把旧锁已失效（${stale}），已替你换成你这个线程的锁。旧锁：${holderText(lock)}。先截图看屏幕现状，确认屏幕上没有别人留下的还在动的操作，在当前线程说明一句，再重新调用；拿不准就点名主人。`,
  };
}

const lockFreeOrStale = (lock, now) => lock === null || (!lock.unreadable && Boolean(staleReason(lock, now)));

// 暂停或设置无效（4.2 第一条）：不恢复、不改名单、不选人、不发送；只读名单里有没有现场待检查标记。
// 有标记（或名单读不懂、看不出有没有）、而且锁空着或已失效 → 不建锁、不放行。没碰上这个条件，才走原来的锁核对。
function fallbackAccess(ctx, args) {
  const invalidNote = ctx.settings.valid ? '' : SETTINGS_INVALID_NOTE;
  if (!ctx.settings.valid) logEvent(ctx.logPath, { at: ctx.now, event: 'queue-settings-invalid', why: ctx.settings.why });
  const read = readQueueSafe(ctx.paths.queuePath);
  const lock = readLock(ctx.lockPath);
  if (lockFreeOrStale(lock, ctx.now) && (read.unreadable || read.q.sceneCheck)) {
    const unknown = read.unreadable ? '（等候名单读不懂，看不出现场有没有检查过，宁可先挡。）' : '';
    return { allow: false, reason: `上一件活的锁失效后还没人检查过现场，排队暂停中，现场待处理：在当前线程回一句“我在别处忙，好了再叫我”，并点名主人说现场待处理。${unknown}${invalidNote}` };
  }
  const verdict = legacyAccess(ctx, args);
  if (!verdict.allow && invalidNote) verdict.reason += invalidNote;
  return verdict;
}

// 排队开着、名单读不懂（4.2 末条）：不覆盖，锁照旧挡，挡下信息退回旧说法，另要她点名主人。
// 锁空着或已失效时看不出有没有现场待检查标记，和暂停时一样宁可先挡。
function unreadableQueueAccess(ctx, args) {
  logEvent(ctx.logPath, { at: ctx.now, event: 'queue-unreadable' });
  const lock = readLock(ctx.lockPath);
  if (lockFreeOrStale(lock, ctx.now)) {
    return { allow: false, reason: '等候名单读不懂，看不出上一件活的现场有没有检查过，为安全起见先不动屏幕：在当前线程回一句“我在别处忙，好了再叫我”，点名叫你的人或 bot，再点名主人说“等候名单读不懂”，然后结束这一轮。' };
  }
  const verdict = legacyAccess(ctx, args);
  if (!verdict.allow) verdict.reason += '另外点名主人说一句“等候名单读不懂”。';
  return verdict;
}

// 动屏幕前的核对。返回 { allow, reason }；allow 为 false 时 reason 就是给她看的挡下说明。
// _hooks 只给测试用，用来把“读完锁之后、改锁之前”这一类时刻固定下来。
export function checkScreenAccess({ lockPath = defaultLockPath, sessionKey, runId, requester, now = Date.now(), logPath = null, settingsPath, queuePath, _hooks } = {}) {
  if (!sessionKey) return { allow: false, reason: '桌面锁检查：读不到这一轮属于哪个线程，不能确认锁是不是在你手上。请点名主人说明。' };
  const paths = queuePathsFor(lockPath, { settingsPath, queuePath });
  return withLockGuard(lockPath, _hooks, () => {
    const settings = readSettings(paths.settingsPath);
    const ctx = { lockPath, paths, logPath, now, settings, hooks: _hooks };
    const args = { sessionKey, runId, requester };
    if (!settings.valid || settings.values.paused) return fallbackAccess(ctx, args);
    const read = readQueueSafe(paths.queuePath);
    _hooks?.afterQueueRead?.();
    if (read.unreadable) return unreadableQueueAccess(ctx, args);
    const q = read.q;
    const before = JSON.stringify(q);
    const save = () => { if (JSON.stringify(q) !== before) saveQueue(ctx, q); };
    recoverQueue(ctx, q);
    const threadId = threadIdFromSessionKey(sessionKey);
    const lock = readLock(lockPath);
    if (lock?.unreadable) {
      save();
      return { allow: false, reason: LOCK_UNREADABLE_NOTE };
    }
    if (lock && lock.sessionKey === sessionKey && lock.state === 'waiting') {
// 锁是“等确认”时，同一线程再动屏幕要先过只有主人能批的官方审批。
      // 这个检查在“再访问会把 waiting 改回 working”之前、同一个互斥保护里做；这里不改锁，批准后由 confirmHeldAccess 改。
      save();
      const waitedAt = lock.waitedAt ?? lock.lastActivityAt;
      return { allow: false, approval: true, approvalInfo: { threadId, what: lock.what ?? null, cardId: lock.cardId ?? null, link: lock.link ?? null, waitedAt, fingerprint: approvalFingerprint(threadId, lock.what, waitedAt) }, reason: '这把锁记着“等确认”：要先过主人的批准才能继续动屏幕。' };
    }
    if (lock && lock.sessionKey === sessionKey) {
      rewriteLock(lockPath, { ...lock, requester: lock.requester ?? requester?.senderId ?? null, requesterAccount: lock.requesterAccount ?? requester?.accountId ?? null, requesterIsOwner: lock.requesterIsOwner ?? requester?.senderIsOwner ?? null, runId: runId ?? lock.runId, lastActivityAt: now, state: 'working', holderRunEnded: false, runEndedAt: null });
      // 锁已在自己手上、名单里却还有现场待检查标记（比如拿锁中断后补记的那一位）：先挡一次、提示看现场，再清标记。
      if (q.sceneCheck) {
        const mark = q.sceneCheck;
        q.sceneCheck = null;
        save();
        return { allow: false, reason: markPrompt(mark) };
      }
      save();
      return { allow: true };
    }
    if (lock && !staleReason(lock, now)) {
      const item = enqueue(q, { threadId, sessionKey, requester, now });
      save();
      return { allow: false, reason: queuedText(ctx, q, item, { lock, why: 'lock' }) };
    }
    // 锁空着或已失效
    if (q.hold) {
      if (q.hold.threadId === threadId) {
        const item = q.items.find((candidate) => candidate.id === q.hold.itemId) ?? null;
        const verdict = takeScreen(ctx, q, lock, { ...args, item });
        save();
        return verdict;
      }
      const item = enqueue(q, { threadId, sessionKey, requester, now });
      save();
      return { allow: false, reason: queuedText(ctx, q, item, { lock, why: 'hold' }) };
    }
    const waiting = waitingSorted(q);
    const mine = findOccupying(q, threadId);
    if (!waiting.length || (mine && waiting[0].id === mine.id)) {
      const verdict = takeScreen(ctx, q, lock, { ...args, item: mine ?? null });
      save();
      return verdict;
    }
    const item = enqueue(q, { threadId, sessionKey, requester, now });
    save();
    return { allow: false, reason: queuedText(ctx, q, item, { lock, why: 'waiting' }) };
  });
}

// 放锁和“等确认”只认锁属于哪个线程，不碰别的线程的锁。读锁、核对、删除/改写在同一段互斥保护里做完。
// 放锁之后按名单选下一位（只改名单，不发送）；结果写在 queueNote 里，message 保持“已放锁。”。
export function releaseLock({ lockPath = defaultLockPath, threadId, now = Date.now(), logPath = null, settingsPath, queuePath, _hooks }) {
  const paths = queuePathsFor(lockPath, { settingsPath, queuePath });
  return withLockGuard(lockPath, _hooks, () => {
    const lock = readLock(lockPath);
    if (lock === null) return { ok: true, message: '现在没有锁。' };
    if (lock.unreadable) return { ok: false, message: '锁文件读不懂，没动它，请点名主人。' };
    if (!threadId || lock.threadId !== String(threadId)) return { ok: false, message: `锁不在这个线程手上，没动它。${holderText(lock)}` };
    _hooks?.afterRead?.(lock);
    const settings = readSettings(paths.settingsPath);
    const ctx = { lockPath, paths, logPath, now, settings, hooks: _hooks };
    if (!settings.valid || settings.values.paused) {
      unlinkSync(lockPath);
      logEvent(logPath, { at: now, event: 'release', threadId: String(threadId), queue: settings.valid ? 'paused' : 'settings-invalid' });
      return { ok: true, message: '已放锁。', queueNote: settings.valid ? '排队暂停中，没有排给下一位。' : '排队设置读不到，没有排给下一位：请点名主人说一句“排队设置读不到”。' };
    }
    const read = readQueueSafe(paths.queuePath);
    if (read.unreadable) {
      unlinkSync(lockPath);
      logEvent(logPath, { at: now, event: 'release', threadId: String(threadId), queue: 'unreadable' });
      return { ok: true, message: '已放锁。', queueNote: '等候名单读不懂，没有排给下一位：请点名主人说一句“等候名单读不懂”。' };
    }
    const q = read.q;
    const before = JSON.stringify(q);
    recoverQueue(ctx, q);
    if (!q.hold && !waitingSorted(q).length && JSON.stringify(q) === before) {
      unlinkSync(lockPath);
      logEvent(logPath, { at: now, event: 'release', threadId: String(threadId), queue: 'empty' });
      return { ok: true, message: '已放锁。', queueNote: '名单是空的。' };
    }
    q.inProgress = { kind: 'releasing', threadId: String(threadId), at: now, lock: lockMark(lock) };
    saveQueue(ctx, q);
    _hooks?.afterReleaseMarked?.();
    unlinkSync(lockPath);
    _hooks?.afterLockDeleted?.();
    const selected = selectNext(ctx, q);
    q.inProgress = null;
    saveQueue(ctx, q);
    logEvent(logPath, { at: now, event: 'release', threadId: String(threadId), queue: selected.kind, queueNo: selected.hold?.queueNo ?? null });
    return { ok: true, message: '已放锁。', queueNote: selectedNote(selected) };
  });
}

export function holdForConfirmation({ lockPath = defaultLockPath, threadId, what = null, now = Date.now(), _hooks }) {
  return withLockGuard(lockPath, _hooks, () => {
    const lock = readLock(lockPath);
    if (lock === null) return { ok: false, message: '现在没有锁，没有可以记为“等确认”的东西。' };
    if (lock.unreadable) return { ok: false, message: '锁文件读不懂，没动它，请点名主人。' };
    if (!threadId || lock.threadId !== String(threadId)) return { ok: false, message: `锁不在这个线程手上，没动它。${holderText(lock)}` };
    _hooks?.afterRead?.(lock);
// 同一把锁里，这一项（文字去掉空白后相同）刚被拒绝或超时没批 → 不再记“等确认”（软检查：改写文字就绕得过，所以条文里写明程序拦不住硬去点提交，靠规则）。
    // 放锁后锁文件没了，标记自然消失，所以他后来改口说可以、重新申请时不会被拦：要先放锁，再重新申请。
    const normWhat = (x) => String(x ?? '').replace(/\s+/g, '');
    if (what && (lock.refused ?? []).some((r) => r.what && normWhat(r.what) === normWhat(what))) {
      return { ok: false, message: '这一项刚被拒绝（或超时没批），不再记“等确认”，也不要再做它：只做收尾（关掉自己打开的窗口，不保存、不提交），然后放锁。如果主人后来改口说可以，要重新申请：先放锁，再重新申请。' };
    }
    rewriteLock(lockPath, { ...lock, state: 'waiting', lastActivityAt: now, waitedAt: now, what: what ? String(what).slice(0, 300) : null });
    return { ok: true, message: '已记为“等确认”。这把锁不会自动失效，等主人确认后继续，做完再放锁。' };
  });
}

// 划掉（4.6）：不用了／完成／被接手。正占着留位就清留位、选下一位（下一轮 tick 发点名）；暂停或设置无效时照样能划掉，只是不选人。
export function skipQueued({ lockPath = defaultLockPath, threadId, why, now = Date.now(), logPath = null, settingsPath, queuePath, _hooks } = {}) {
  if (!threadId) return { ok: false, message: '要写 --thread <线程编号>。名单没动。' };
  if (!SKIP_WHY.includes(why)) return { ok: false, message: Q.whyInvalid(SKIP_WHY) };
  const paths = queuePathsFor(lockPath, { settingsPath, queuePath });
  return withLockGuard(lockPath, _hooks, () => {
    const read = readQueueSafe(paths.queuePath);
    if (read.unreadable) return { ok: false, message: '等候名单读不懂，没动它：请点名主人说一句“等候名单读不懂”。' };
    const q = read.q;
    const item = findOccupying(q, String(threadId));
    if (!item) return { ok: false, message: '这个线程不在名单里，名单没动。' };
    const settings = readSettings(paths.settingsPath);
    const ctx = { lockPath, paths, logPath, now, settings, hooks: _hooks };
    const on = settings.valid && !settings.values.paused;
    const wasHold = q.hold?.itemId === item.id;
    if (wasHold) endHold(q, 'cancelled', why, now);
    else {
      item.status = 'cancelled';
      item.endReason = why;
      item.endedAt = now;
    }
    let note = '';
    if (on) {
      recoverQueue(ctx, q);
      if (wasHold) note = selectedNote(selectNext(ctx, q));
    } else if (wasHold) note = '排队暂停中（或设置读不到），没有排给下一位。';
    saveQueue(ctx, q);
    logEvent(logPath, { at: now, event: 'queue-skip', threadId: String(threadId), why, wasHold });
    return { ok: true, message: `已把这个线程从等候名单里划掉（${why}）。${note}` };
  });
}

// 补资料（4.11 note）：补原请求消息编号、请求方编号；“待补资料”的件补上请求方后回到“等候”，原排上时刻不变，再调选人。
export function noteQueued({ lockPath = defaultLockPath, threadId, message, requester, now = Date.now(), logPath = null, settingsPath, queuePath, _hooks } = {}) {
  if (!threadId) return { ok: false, message: '要写 --thread <线程编号>。名单没动。' };
  if (message === undefined && requester === undefined) return { ok: false, message: '要写 --message <消息编号> 或 --requester <请求方编号>。名单没动。' };
  if (message !== undefined && !isDiscordId(String(message))) return { ok: false, message: '--message 要是 Discord 消息编号（一串数字）。名单没动。' };
  if (requester !== undefined && !isDiscordId(String(requester))) return { ok: false, message: '--requester 要是 Discord 用户编号（一串数字）。名单没动。' };
  const paths = queuePathsFor(lockPath, { settingsPath, queuePath });
  return withLockGuard(lockPath, _hooks, () => {
    const read = readQueueSafe(paths.queuePath);
    if (read.unreadable) return { ok: false, message: '等候名单读不懂，没动它：请点名主人说一句“等候名单读不懂”。' };
    const q = read.q;
    const item = findOccupying(q, String(threadId))
      ?? q.items.filter((candidate) => candidate.threadId === String(threadId) && candidate.status === 'needs-info').sort((a, b) => b.queuedAt - a.queuedAt)[0];
    if (!item) return { ok: false, message: '这个线程不在名单里，名单没动。' };
    if (message !== undefined) item.requestMessageId = String(message);
    if (requester !== undefined) item.requester = String(requester);
    if (q.hold?.itemId === item.id && message !== undefined) q.hold.requestMessageId = String(message);
    let back = '';
    if (item.status === 'needs-info' && isDiscordId(item.requester)) {
      item.status = 'waiting';
      item.endReason = null;
      item.endedAt = null;
      back = '这一件回到等候，原来的位置不变。';
    }
    const settings = readSettings(paths.settingsPath);
    const ctx = { lockPath, paths, logPath, now, settings, hooks: _hooks };
    if (settings.valid && !settings.values.paused) {
      recoverQueue(ctx, q);
      selectNext(ctx, q);
    }
    saveQueue(ctx, q);
    logEvent(logPath, { at: now, event: 'queue-note', threadId: String(threadId), message: message ?? null, requester: requester ?? null });
    return { ok: true, message: `已补记。${back}` };
  });
}

// 手动选人（施工、测试用；不发送）。
export function selectNextCommand({ lockPath = defaultLockPath, now = Date.now(), logPath = null, settingsPath, queuePath, _hooks } = {}) {
  const paths = queuePathsFor(lockPath, { settingsPath, queuePath });
  return withLockGuard(lockPath, _hooks, () => {
    const settings = readSettings(paths.settingsPath);
    if (!settings.valid || settings.values.paused) return { ok: false, message: settings.valid ? '排队暂停中，没有选人。' : `排队设置读不到（${settings.why}），没有选人。` };
    const read = readQueueSafe(paths.queuePath);
    if (read.unreadable) return { ok: false, message: '等候名单读不懂，没有选人。' };
    const q = read.q;
    const before = JSON.stringify(q);
    const ctx = { lockPath, paths, logPath, now, settings, hooks: _hooks };
    recoverQueue(ctx, q);
    const selected = selectNext(ctx, q);
    if (JSON.stringify(q) !== before) saveQueue(ctx, q);
    return { ok: true, message: selected.kind === 'lock-active' ? '锁还有效，不挑人。' : selected.kind === 'lock-unreadable' ? '锁文件读不懂，不挑人。' : selectedNote(selected), selected: selected.kind };
  });
}

export function describeLock({ lockPath = defaultLockPath, now = Date.now(), queuePath } = {}) {
  const lock = readLock(lockPath);
  if (lock === null) {
    const read = readQueueSafe(queuePath ?? queuePathsFor(lockPath).queuePath);
    if (read.unreadable) return '现在没有锁，但等候名单读不懂，看不出现场有没有检查过：现场待处理，不算空闲。';
    const mark = read.q.sceneCheck;
    if (mark) return `现在没有锁，但现场待处理：上一件活的锁（线程 ${mark.oldLink ?? mark.oldThreadId ?? '未记录'}）失效后被挪走，还没人检查过现场，不算空闲。`;
    return '现在没有锁，屏幕空着。';
  }
  if (lock.unreadable) return '锁文件读不懂。';
  const stale = staleReason(lock, now);
  return `${holderText(lock)}；状态：${lock.state === 'waiting' ? '等确认' : '进行中'}${lock.holderRunEnded ? '（持锁那一轮已结束）' : ''}${stale ? `；已可视为旧锁：${stale}` : ''}`;
}

// status 的排队那一行。
export function describeQueueLine({ lockPath = defaultLockPath, settingsPath, queuePath } = {}) {
  const paths = queuePathsFor(lockPath, { settingsPath, queuePath });
  const settings = readSettings(paths.settingsPath);
  const read = readQueueSafe(paths.queuePath);
  const settingsText = settings.valid ? W.queueSummary.settingsOk(settings.values.holdMinutes, settings.values.paused) : W.queueSummary.settingsBad(settings.why);
  if (read.unreadable) return W.queueSummary.unreadable(settingsText);
  const q = read.q;
  const occupying = q.items.filter((item) => OCCUPYING.has(item.status)).length;
  const hold = q.hold ? W.queueSummary.hold(q.hold.queueNo, STATUS_TEXT[q.hold.status], q.hold.threadId) : W.queueSummary.noHold;
  return W.queueSummary.line(occupying, hold, settingsText, q.sceneCheck);
}

// queue：只读，列出占队列的、留位、发送尝试、现场待检查标记、最近的划掉记录和异常。
export function describeQueue({ lockPath = defaultLockPath, settingsPath, queuePath } = {}) {
  const paths = queuePathsFor(lockPath, { settingsPath, queuePath });
  const settings = readSettings(paths.settingsPath);
  const read = readQueueSafe(paths.queuePath);
  if (read.unreadable) return { ok: false, text: JSON.stringify({ queue: '读不懂', settings }, null, 2) };
  const q = read.q;
  const label = (item) => ({ ...item, statusText: STATUS_TEXT[item.status] ?? item.status, queuedAtText: clock(item.queuedAt) });
  const view = {
    settings,
    exists: read.exists,
    occupying: q.items.filter((item) => OCCUPYING.has(item.status)).sort((a, b) => a.queuedAt - b.queuedAt).map(label),
    hold: q.hold ? { ...q.hold, statusText: STATUS_TEXT[q.hold.status], yieldAtText: q.hold.yieldAt ? clock(q.hold.yieldAt) : null } : null,
    sceneCheck: q.sceneCheck,
    lease: q.lease,
    inProgress: q.inProgress,
    lastTickAt: q.lastTickAt,
    lastTickAtText: q.lastTickAt ? clock(q.lastTickAt) : null,
    counter: q.counter,
    recentEnded: q.items.filter((item) => !OCCUPYING.has(item.status)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 10).map(label),
    anomalies: q.anomalies.slice(-20),
    tickJobId: q.tickJobId,
  };
  return { ok: true, text: JSON.stringify(view, null, 2) };
}

// 一轮结束时记一笔；“等确认”的锁不记，它不会因为一轮结束而失效。
export function markRunEnded({ lockPath = defaultLockPath, sessionKey, now = Date.now(), _hooks }) {
  if (!sessionKey) return;
  withLockGuard(lockPath, _hooks, () => {
    const lock = readLock(lockPath);
    if (!lock || lock.unreadable || lock.sessionKey !== sessionKey || lock.state !== 'working') return;
    _hooks?.afterRead?.(lock);
    rewriteLock(lockPath, { ...lock, holderRunEnded: true, runEndedAt: now });
  });
}

// ---- 发送和读消息的依赖层（4.11）：真的走 openclaw 命令行，单元测试换成假的 ----
function tail(text, max = 600) {
  const value = String(text ?? '').trim();
  return value.length > max ? `…${value.slice(-max)}` : value;
}

function parseJsonOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // 前面可能夹着别的行：从最后一个以 { 开头的行往后试
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].trimStart().startsWith('{')) continue;
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {
      // 接着往前找
    }
  }
  return null;
}

// 跑一条命令：参数按数组传，不拼 shell；到时限先 SIGTERM，5 秒后 SIGKILL。
function runCli(args, timeoutMs) {
  return new Promise((resolve) => {
    let started = false;
    let killed = false;
    let stdout = '';
    let stderr = '';
    let termTimer;
    let killTimer;
    let child;
    try {
      child = spawn(OPENCLAW_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ started: false, spawnError: error });
      return;
    }
    child.on('spawn', () => {
      started = true;
    });
    child.on('error', (error) => {
      if (!started) {
        clearTimeout(termTimer);
        resolve({ started: false, spawnError: error });
      }
    });
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    termTimer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      if (started) resolve({ started: true, code, signal, killedByTimeout: killed, stdout, stderr });
    });
  });
}

function extractMessages(output) {
  const candidates = [output?.payload?.messages, output?.messages, output?.payload?.result?.messages, output?.result?.messages, output?.payload];
  return candidates.find((value) => Array.isArray(value)) ?? null;
}

// 发送结果分三种（4.4 第 4 条）。官方命令行失败时只给错误文字，不给能证明“没投递”的结构化标记，
// 所以“确认没发出”只算命令根本没能启动这一种（发前核对没过在 tick 里另记）；其余一律“可能已发出”。
export function defaultDeps() {
  return {
    async send({ target, message, timeoutMs, account = 'desktop' }) {
      // node 测试运行器会给子进程设 NODE_TEST_CONTEXT；测试里就算有人没换掉默认发送函数，也不真发。
      if (process.env.NODE_TEST_CONTEXT) return { kind: 'not-sent', reason: '测试环境，不真发', error: '' };
      const result = await runCli(['message', 'send', '--channel', 'discord', '--account', account, '--target', `channel:${target}`, '--message', message, '--json'], timeoutMs);
      if (!result.started) return { kind: 'not-sent', reason: `发送命令没能启动（${result.spawnError?.code ?? '原因不明'}）`, error: String(result.spawnError?.message ?? '') };
      if (result.killedByTimeout) return { kind: 'unknown', reason: '发送超时，子进程已被结束', error: tail(result.stderr) };
      const output = parseJsonOutput(result.stdout);
      const messageId = output?.messageId ?? output?.payload?.messageId ?? output?.payload?.result?.messageId;
      if (result.code === 0 && output && output.ok !== false && isDiscordId(String(messageId ?? ''))) return { kind: 'sent', messageId: String(messageId) };
      return { kind: 'unknown', reason: `发送结果读不出（退出码 ${result.code}${result.signal ? `，信号 ${result.signal}` : ''}）`, error: tail(result.stderr || result.stdout) };
    },
    async read({ target, after, limit, timeoutMs }) {
      const result = await runCli(['message', 'read', '--channel', 'discord', '--account', 'desktop', '--target', `channel:${target}`, '--after', String(after), '--limit', String(limit), '--json'], timeoutMs);
      if (!result.started) return { ok: false, error: `读消息命令没能启动（${result.spawnError?.code ?? '原因不明'}）` };
      if (result.killedByTimeout) return { ok: false, error: '读消息超时' };
      if (result.code !== 0) return { ok: false, error: `读消息失败（退出码 ${result.code}）：${tail(result.stderr || result.stdout, 300)}` };
      const list = extractMessages(parseJsonOutput(result.stdout));
      if (!list) return { ok: false, error: '读消息的返回读不懂' };
      return { ok: true, messages: list.map((m) => ({ id: String(m?.id ?? ''), authorId: String(m?.author?.id ?? m?.authorId ?? m?.author_id ?? ''), content: typeof m?.content === 'string' ? m.content : '' })) };
    },
  };
}

// 从下限往后一页页读，找作者是实际发送账号（默认桌面角色；请求方是主人时是总控）、正文含标记的消息（4.4 第 5 条）。
// 一页里最大的编号做下一页的下限；游标必须严格往后走；读到空页才算读完（不靠“一页不满上限”判断，单页上限变了也不会漏）。
export async function findMarkedMessage({ deps, remaining, clock: now }, { target, after, marker, authorId = DESKTOP_USER_ID, limit = 100 }) {
  let cursor = String(after);
  let pages = 0;
  for (;;) {
    if (remaining() < MIN_BUDGET_FOR_READ_MS) return { found: null, complete: false, why: '本次推进剩余时间不够，没读完', pages };
    let result;
    try {
      result = await deps.read({ target, after: cursor, limit, timeoutMs: Math.max(1_000, Math.min(20_000, remaining() - 5_000)) });
    } catch (error) {
      return { found: null, complete: false, why: `读消息出错：${error.message}`, pages };
    }
    pages += 1;
    if (!result?.ok) return { found: null, complete: false, why: result?.error ?? '读消息失败', pages };
    if (!Array.isArray(result.messages)) return { found: null, complete: false, why: '读消息的返回读不懂', pages };
    if (!result.messages.length) return { found: null, complete: true, pages };
    let max = null;
    let found = null;
    let skew = false;
    for (const m of result.messages) {
      if (!isDiscordId(m.id)) return { found: null, complete: false, why: '返回里有读不懂的消息编号', pages };
      if (max === null || compareIds(m.id, max) > 0) max = m.id;
      if (timeFromId(m.id) > now() + 60_000) skew = true;
      if (m.authorId === authorId && m.content.includes(marker) && (!found || compareIds(m.id, found.id) < 0)) found = m;
    }
    if (skew) return { found, complete: false, clockSkew: true, why: '本机时间和 Discord 消息时间对不上超过 1 分钟', pages };
    if (found) return { found, complete: true, pages };
    if (compareIds(max, cursor) <= 0) return { found: null, complete: false, why: '翻页游标没往后走', pages };
    cursor = max;
  }
}

export function notifyText(hold, holdMinutes) {
  if (String(hold.requester) === OWNER_USER_ID) {
    // 请求方是主人本人：程序用总控账号点名桌面角色，桌面角色读他的原话直接接着做。不点名主人（免得又打扰他）、不点名总控。
    return Q.notifyOwnerJob(DESKTOP_USER_ID, clock(hold.queuedAt), hold.queueNo, hold.threadId, SKIP_WHY[0], holdMinutes);
  }
  return Q.notifyRequesterJob(hold.requester, clock(hold.queuedAt), hold.queueNo, W.sectionCurrentStatus, SKIP_WHY[0], holdMinutes);
}

// 主人的件过号（桌面角色这一轮没接上）时，用总控账号在原线程点名他一句。每个留位只会过号一次，所以只发一次。
export function expiredNoticeText(queueNo) {
  return `<@${OWNER_USER_ID}> 桌面角色这一轮没接上（排队号 ${queueNo}），你那件事先让给下一位了；还要做就在这个线程再叫她一次。`;
}

function findAttempt(q, queueNo, token) {
  const hold = q.hold?.queueNo === queueNo ? q.hold : itemByQueueNo(q, queueNo)?.holdRecord;
  return hold?.attempts?.find((attempt) => attempt.token === token) ?? null;
}

// ---- tick：固定推进任务每 2 分钟跑一次（4.13）。只有 tick 读消息、发送、判过号 ----
// 20 分钟兜底提醒。
export async function stuckReminderTick({ lockPath, deps, now = Date.now, logPath = null }) {
  const path = stuckPathOf(lockPath);
  if (!path) return [];
  // 没有发送函数就不发，只记一行（下一遍有了再发，提醒不会丢）。
  if (typeof deps?.send !== 'function') {
    if (stuckDueReminders(path, now()).length) logEvent(logPath, { at: now(), event: 'stuck-help-reminder-skipped', why: '没有传发送函数' });
    return [];
  }
  const sentFor = [];
  for (const { threadId } of stuckDueReminders(path, now())) {
    const message = `${OWNER_MENTION} 桌面角色在线程 https://discord.com/channels/${GUILD_ID}/${threadId} 卡住了，点名任务审计求助，已经超过 20 分钟没有收到她的“【求助回复】”。桌面角色不会再自己动屏幕，屏幕停在卡住的地方。你可以去那个线程说一声怎么办，或者叫任务审计再看一眼。`;
    const r = await deps.send({ target: APPROVAL_CHANNEL_ID, message, timeoutMs: 30_000, account: 'default' });
    if (r?.kind === 'sent' || r?.kind === 'unknown') { stuckMarkReminded(path, threadId); sentFor.push(threadId); } // 结果不明也算这一次用掉了，不自动重发
    logEvent(logPath, { at: now(), event: 'stuck-help-reminder', threadId, result: r?.kind ?? null });
  }
  return sentFor;
}

export async function runTick({ lockPath = defaultLockPath, logPath = null, settingsPath, queuePath, deps = defaultDeps(), clock: now = Date.now, budgetMs = TICK_BUDGET_MS, runId = `tick-${Date.now()}-${randomToken()}`, _hooks } = {}) {
  const startedAt = now();
// 桌面角色求助任务审计后 20 分钟没收到“【求助回复】”→ 往审批频道点名主人一次（每个求助只发一次；发失败下一轮再试）。出错不影响下面的排队推进。
  try { await stuckReminderTick({ lockPath, deps, now, logPath }); } catch (error) { logEvent(logPath, { at: now(), event: 'stuck-reminder-error', runId, error: String(error?.message ?? error).slice(0, 200) }); }
  const remaining = () => budgetMs - (now() - startedAt);
  const paths = queuePathsFor(lockPath, { settingsPath, queuePath });
  const settings = readSettings(paths.settingsPath);
  if (!settings.valid || settings.values.paused) {
    if (!settings.valid) {
      withLockGuard(lockPath, _hooks, () => {
        const read = readQueueSafe(paths.queuePath);
        if (read.unreadable || !read.exists) return;
        const last = [...read.q.anomalies].reverse().find((a) => a.kind === '设置无效');
        if (last && now() - last.at < 3600_000) return;
        addAnomaly(read.q, now(), '设置无效', settings.why);
        saveQueue({ now: now(), paths }, read.q);
        logEvent(logPath, { at: now(), event: 'tick-settings-invalid', runId, why: settings.why });
      });
    }
    return { output: 'NO_REPLY', did: settings.valid ? 'paused' : 'settings-invalid' };
  }
  const first = readQueueSafe(paths.queuePath);
  if (first.unreadable) {
    logEvent(logPath, { at: now(), event: 'tick-queue-unreadable', runId });
    return { output: 'NO_REPLY', did: 'queue-unreadable' };
  }
  if (isQueueIdle(first.q)) return { output: 'NO_REPLY', did: 'empty' };

  const token = randomToken();
  const plan = withLockGuard(lockPath, _hooks, () => {
    const current = readSettings(paths.settingsPath);
    if (!current.valid || current.values.paused) return { did: 'paused' };
    const read = readQueueSafe(paths.queuePath);
    if (read.unreadable) {
      logEvent(logPath, { at: now(), event: 'tick-queue-unreadable', runId });
      return { did: 'queue-unreadable' };
    }
    const q = read.q;
    const at = now();
    const ctx = { lockPath, paths, logPath, now: at, settings: current, hooks: _hooks };
    const holdMs = current.values.holdMinutes * 60_000;
    recoverQueue(ctx, q);
    q.lastTickAt = at;
    if (q.lease && q.lease.expiresAt > at) {
      saveQueue(ctx, q);
      logEvent(logPath, { at, event: 'tick-lease-busy', runId, leaseRunId: q.lease.runId });
      return { did: 'lease-busy' };
    }
    if (q.lease) logEvent(logPath, { at, event: 'tick-lease-taken-over', runId, oldRunId: q.lease.runId });
    q.lease = { token, runId, startedAt: at, expiresAt: at + LEASE_MS };
    // 旧执行者留下的“进行中”尝试一律按“可能已发出”处理，不另发（4.3）。
    if (q.hold) {
      for (const attempt of q.hold.attempts) {
        if (attempt.result !== 'in-progress') continue;
        attempt.result = 'maybe-sent';
        attempt.reason = '上一次推进中途断了，结果未定（按可能已发出处理，不补发）';
        attempt.finishedAt = at;
        if (q.hold.status === 'pending' && !q.hold.yieldAt) q.hold.yieldAt = attempt.expiresAt + holdMs;
        logEvent(logPath, { at, event: 'tick-attempt-abandoned', runId, queueNo: q.hold.queueNo, n: attempt.n });
      }
    }
    // 到了让位时刻（容差只往后延）。
    let expiredNotice = null;
    if (q.hold && q.hold.yieldAt && at >= q.hold.yieldAt + YIELD_GRACE_MS) {
      const queueNo = q.hold.queueNo;
      if (q.hold.status === 'notified') {
        if (String(q.hold.requester) === OWNER_USER_ID) expiredNotice = { queueNo, threadId: q.hold.threadId };
        endHold(q, 'expired', '被点名后没在留位时间内来接', at);
        logEvent(logPath, { at, event: 'tick-expired', runId, queueNo });
      } else {
        endHold(q, 'notify-unknown', '通知结果未定，留位已按规则让出', at);
        addAnomaly(q, at, '通知结果未定', queueNo);
        logEvent(logPath, { at, event: 'tick-notify-unknown', runId, queueNo });
      }
    }
    if (!q.hold) selectNext(ctx, q);
    let action = null;
    let attempt = null;
    if (q.hold && q.hold.status === 'pending') {
      if (q.hold.attempts.some((a) => a.result === 'maybe-sent')) action = 'verify';
      else if (remaining() >= MIN_BUDGET_FOR_SEND_MS) {
        attempt = { n: q.hold.attempts.length + 1, token, runId, startedAt: at, expiresAt: at + ATTEMPT_MS, result: 'in-progress' };
        q.hold.attempts.push(attempt);
        action = 'send';
      }
    }
    if (!action) q.lease = null;
    saveQueue(ctx, q);
    return { did: action ?? 'nothing', action, hold: action ? JSON.parse(JSON.stringify(q.hold)) : null, holdMs, max: current.values.maxNotifyAttempts, holdMinutes: current.values.holdMinutes, expiredNotice };
  });
  const env = { lockPath, paths, logPath, deps, now, remaining, runId, token, hooks: _hooks };
  if (!plan.action) {
    // 没有后续动作的这一轮，过号通知照样要发（它排在本轮其他发送之后；本轮没有其他发送）。
    await tickExpiredNotice(env, plan.expiredNotice);
    return { output: 'NO_REPLY', did: plan.did };
  }
  await _hooks?.afterLeaseTaken?.(plan);
  const did = plan.action === 'send' ? await tickSend(env, plan) : await tickVerify(env, plan);
  await tickExpiredNotice(env, plan.expiredNotice);
  return { output: 'NO_REPLY', did };
}

// 过号通知：只在请求方是主人本人且这一件是“过号（expired）”时发；用总控账号、短时限（不超过 10 秒）；
// 发失败只记日志、不重试、不影响记账；本轮剩余时间不够（发前要剩 45 秒）就这一轮放弃、记日志（过号已记账，不另加字段）。
async function tickExpiredNotice(env, notice) {
  if (!notice) return;
  const { logPath, deps, now, remaining, runId } = env;
  if (remaining() < MIN_BUDGET_FOR_SEND_MS) {
    logEvent(logPath, { at: now(), event: 'tick-expired-notice-skipped', runId, queueNo: notice.queueNo, threadId: notice.threadId, why: '本轮剩余时间不够，放弃（过号已记账）' });
    return;
  }
  let result;
  try {
    result = await deps.send({ target: notice.threadId, message: expiredNoticeText(notice.queueNo), timeoutMs: Math.min(10_000, Math.max(1_000, remaining() - 10_000)), account: CONTROLLER_ACCOUNT });
  } catch (error) {
    result = { kind: 'unknown', reason: '发送调用出错', error: error.message };
  }
  logEvent(logPath, { at: now(), event: 'tick-expired-notice', kind: '程序通知', runId, queueNo: notice.queueNo, threadId: notice.threadId, account: CONTROLLER_ACCOUNT, result: result?.kind ?? null, messageId: result?.messageId ?? null, reason: result?.reason ?? null, error: result?.error ?? null });
}

function leaseIsMine(q, token, at) {
  return Boolean(q.lease && q.lease.token === token && q.lease.expiresAt > at);
}

async function tickSend(env, plan) {
  const { lockPath, paths, logPath, deps, now, remaining, runId, token, hooks } = env;
  const queueNo = plan.hold.queueNo;
  await hooks?.afterAttemptRecorded?.(plan);
  // 发之前再核一次（4.4 第 2 条）。
  const pre = withLockGuard(lockPath, hooks, () => {
    const at = now();
    const settings = readSettings(paths.settingsPath);
    const read = readQueueSafe(paths.queuePath);
    if (read.unreadable) return { ok: false, why: '名单读不懂' };
    const q = read.q;
    const why = [];
    if (!settings.valid) why.push('设置无效');
    else if (settings.values.paused) why.push('暂停中');
    if (!q.lease || q.lease.token !== token) why.push('推进租约不是自己的');
    else if (q.lease.expiresAt - at < MIN_LEASE_LEFT_FOR_SEND_MS) why.push('推进租约剩余时间不够');
    if (!q.hold || q.hold.queueNo !== queueNo) why.push('留位已经换了');
    else if (q.hold.status !== 'pending') why.push('留位不是待通知');
    if (remaining() < MIN_BUDGET_FOR_SEND_MS) why.push('本次推进剩余时间不够');
    if (!why.length) return { ok: true };
    const attempt = findAttempt(q, queueNo, token);
    const before = JSON.stringify(q);
    if (attempt && attempt.result === 'in-progress') {
      attempt.result = 'not-sent';
      attempt.reason = `未发出（发前核对没过：${why.join('、')}）`;
      attempt.finishedAt = at;
    }
    if (q.lease?.token === token) q.lease = null;
    else logEvent(logPath, { at, event: 'tick-stale-stopped', runId, queueNo, note: '过时的推进，已停手' });
    if (JSON.stringify(q) !== before) saveQueue({ now: at, paths }, q);
    return { ok: false, why: why.join('、') };
  });
  if (!pre.ok) return `send-skipped（${pre.why}）`;
  const message = notifyText(plan.hold, plan.holdMinutes);
  const timeoutMs = Math.max(1_000, Math.min(SEND_TIMEOUT_MS, remaining() - 10_000));
  const route = sendRouteFor(plan.hold.requester);
  const sendArgs = { target: plan.hold.threadId, message, timeoutMs };
  if (route.account !== 'desktop') sendArgs.account = route.account; // 请求方是 bot 时调用参数和改前逐字相同
  let result;
  try {
    result = await deps.send(sendArgs);
  } catch (error) {
    result = { kind: 'unknown', reason: '发送调用出错', error: error.message };
  }
  await hooks?.beforeWriteResult?.(result);
  return withLockGuard(lockPath, hooks, () => {
    const at = now();
    const read = readQueueSafe(paths.queuePath);
    if (read.unreadable) {
      logEvent(logPath, { at, event: 'tick-result-dropped', runId, queueNo, why: '名单读不懂', result });
      return 'result-dropped';
    }
    const q = read.q;
    if (!leaseIsMine(q, token, at)) {
      logEvent(logPath, { at, event: 'tick-stale-stopped', runId, queueNo, note: '过时的推进，已停手（结果丢弃）', result });
      return 'result-dropped';
    }
    const settings = readSettings(paths.settingsPath);
    const ctx = { lockPath, paths, logPath, now: at, settings, hooks };
    const live = q.hold?.queueNo === queueNo ? q.hold : null;
    const attempt = findAttempt(q, queueNo, token);
    if (attempt) {
      attempt.finishedAt = at;
      attempt.error = result.error ?? null;
    }
    if (result.kind === 'sent') {
      if (attempt) {
        attempt.result = 'sent';
        attempt.messageId = result.messageId;
      }
      const messageAt = timeFromId(result.messageId);
      if (attempt && (messageAt < attempt.startedAt - 60_000 || messageAt > at + 60_000)) addAnomaly(q, at, '时钟异常', `${queueNo}：消息时间 ${clock(messageAt)}，本机发送时刻 ${clock(attempt.startedAt)}`);
      if (live) {
        if (live.status === 'pending') {
          live.status = 'notified';
          live.messageId = result.messageId;
          live.messageAt = messageAt;
          live.yieldAt = messageAt + plan.holdMs;
          const item = q.items.find((candidate) => candidate.id === live.itemId);
          if (item) item.status = 'notified';
        }
      } else {
        const item = itemByQueueNo(q, queueNo);
        if (item?.status === 'taken') {
          if (item.holdRecord) item.holdRecord.messageId = result.messageId;
        } else addAnomaly(q, at, '取消后才送达的通知', `${queueNo}，消息编号 ${result.messageId}`);
      }
    } else if (result.kind === 'not-sent') {
      if (attempt) {
        attempt.result = 'not-sent';
        attempt.reason = `未发出：${result.reason}`;
      }
      if (live && live.attempts.filter((a) => a.result === 'not-sent').length >= plan.max) {
        endHold(q, 'notify-failed', `点名确认没发出，已试满 ${plan.max} 次`, at);
        if (settings.valid && !settings.values.paused) selectNext(ctx, q);
      }
    } else {
      if (attempt) {
        attempt.result = 'maybe-sent';
        attempt.reason = `可能已发出、结果未定：${result.reason ?? '原因不明'}`;
      }
      if (live && live.status === 'pending' && !live.yieldAt && attempt) live.yieldAt = attempt.expiresAt + plan.holdMs;
    }
    q.lease = null;
    saveQueue(ctx, q);
    logEvent(logPath, { at, event: 'tick-send', kind: '程序通知', runId, queueNo, threadId: plan.hold.threadId, account: route.account, n: attempt?.n ?? null, result: result.kind, messageId: result.messageId ?? null, reason: result.reason ?? null, error: result.error ?? null });
    return `send-${result.kind}`;
  });
}

async function tickVerify(env, plan) {
  const { lockPath, paths, logPath, deps, now, remaining, runId, token, hooks } = env;
  const hold = plan.hold;
  let lower = idFromTime(hold.selectedAt - 60_000);
  if (hold.requestMessageId && isDiscordId(hold.requestMessageId) && compareIds(hold.requestMessageId, lower) < 0) lower = hold.requestMessageId;
  const found = await findMarkedMessage({ deps, remaining, clock: now }, { target: hold.threadId, after: lower, marker: `（排队号 ${hold.queueNo}）`, authorId: sendRouteFor(hold.requester).authorId });
  return withLockGuard(lockPath, hooks, () => {
    const at = now();
    const read = readQueueSafe(paths.queuePath);
    if (read.unreadable) return 'verify-dropped';
    const q = read.q;
    if (!leaseIsMine(q, token, at)) {
      logEvent(logPath, { at, event: 'tick-stale-stopped', runId, queueNo: hold.queueNo, note: '过时的推进，已停手（核查结果丢弃）' });
      return 'verify-dropped';
    }
    const live = q.hold?.queueNo === hold.queueNo && q.hold.status === 'pending' ? q.hold : null;
    let did;
    if (found.clockSkew) addAnomaly(q, at, '时钟异常', `${hold.queueNo}：${found.why}`);
    if (found.found) {
      const messageAt = timeFromId(found.found.id);
      if (live) {
        const attempt = live.attempts.find((a) => a.result === 'maybe-sent');
        if (attempt) {
          attempt.result = 'sent';
          attempt.messageId = found.found.id;
          attempt.reason = `${attempt.reason ?? ''}；核查找到这条点名`;
        }
        live.status = 'notified';
        live.messageId = found.found.id;
        live.messageAt = messageAt;
        live.yieldAt = messageAt + plan.holdMs;
        live.readIncompleteStreak = 0;
        const item = q.items.find((candidate) => candidate.id === live.itemId);
        if (item) item.status = 'notified';
      } else {
        const item = itemByQueueNo(q, hold.queueNo);
        if (item?.status === 'taken' && item.holdRecord) item.holdRecord.messageId = found.found.id;
      }
      did = 'verify-found';
    } else if (live) {
      if (found.complete) {
        live.fullNotFound += 1;
        live.readIncompleteStreak = 0;
        did = 'verify-complete-not-found';
      } else {
        live.readIncompleteTotal += 1;
        live.readIncompleteStreak += 1;
        if (live.readIncompleteStreak === 3) addAnomaly(q, at, '通知核查连续读不全', hold.queueNo);
        did = 'verify-incomplete';
      }
    } else did = 'verify-hold-changed';
    q.lease = null;
    saveQueue({ now: at, paths }, q);
    logEvent(logPath, { at, event: 'tick-verify', runId, queueNo: hold.queueNo, did, why: found.why ?? null, pages: found.pages, messageId: found.found?.id ?? null });
    return did;
  });
}

// S1 自检：在定时任务的执行环境里用桌面角色账号发一句、按编号读回、再照 4.4 第 5 条翻页找到它。
export async function runSelftest({ threadId, resultPath, deps = defaultDeps(), clock: now = Date.now } = {}) {
  const startedAt = now();
  const remaining = () => TICK_BUDGET_MS - (now() - startedAt);
  const marker = `（自检号 S${startedAt}）`;
  const result = { startedAt, startedAtText: clock(startedAt), threadId, marker, send: null, readBack: null, paging: null, ok: false };
  if (!isDiscordId(String(threadId ?? ''))) {
    result.error = '线程编号不对';
  } else {
    result.send = await deps.send({ target: threadId, message: `桌面角色排队自检（不是点名）${marker}`, timeoutMs: SEND_TIMEOUT_MS });
    if (result.send.kind === 'sent') {
      const back = await deps.read({ target: threadId, after: (BigInt(result.send.messageId) - 1n).toString(), limit: 1, timeoutMs: 20_000 });
      result.readBack = { ok: Boolean(back?.ok), error: back?.error ?? null, matched: Boolean(back?.messages?.some((m) => m.id === result.send.messageId && m.content.includes(marker) && m.authorId === DESKTOP_USER_ID)), count: back?.messages?.length ?? null };
      const paging = await findMarkedMessage({ deps, remaining, clock: now }, { target: threadId, after: idFromTime(startedAt - 60_000), marker });
      result.paging = { complete: paging.complete, why: paging.why ?? null, pages: paging.pages, foundId: paging.found?.id ?? null };
      result.ok = result.readBack.matched && paging.found?.id === result.send.messageId;
    }
  }
  result.finishedAt = now();
  result.ms = result.finishedAt - startedAt;
  if (resultPath) writeJsonAtomic(resultPath, result);
  return result;
}

const agentIdOf = (ctx) => ctx?.agentId ?? /^agent:([^:]+):/.exec(String(ctx?.sessionKey ?? ''))?.[1];

// 每次核对记一行（时间、工具、线程、放行或挡下），方便事后对照后台记录；写不进去不影响核对。
// 顺带记下是哪个进程、哪个线程在核对，用来证明真实运行里所有核对都排在同一个进程里一件一件做。
function runtimeFacts() {
  return { pid: process.pid, wt: workerThreadId };
}

function logDecision(logPath, entry) {
  logEvent(logPath, entry);
}

// 批准绑定：线程＋“等确认”时记下的那件事＋记“等确认”的时刻；换线程、换事、重新记过“等确认”都对不上。
export function approvalFingerprint(threadId, what, waitedAt) {
  return createHash('sha256').update(`${threadId}|${what ?? ''}|${waitedAt}`).digest('hex').slice(0, 16);
}

// 批准通过后调用：锁还是同一线程、还是“等确认”、指纹对得上，才改回“做事中”；用过即失效（这次批准只放行当前这一次调用）。
export function confirmHeldAccess({ lockPath = defaultLockPath, threadId, fingerprint, now = Date.now(), _hooks }) {
  return withLockGuard(lockPath, _hooks, () => {
    const lock = readLock(lockPath);
    if (!lock || lock.unreadable || lock.state !== 'waiting' || lock.threadId !== String(threadId)) return { ok: false, message: '锁已经变了，这次批准作废' };
    if (approvalFingerprint(threadId, lock.what, lock.waitedAt ?? lock.lastActivityAt) !== fingerprint) return { ok: false, message: '锁上记的事变了，这次批准作废' };
    rewriteLock(lockPath, { ...lock, state: 'working', lastActivityAt: now, holderRunEnded: false, runEndedAt: null, approvedAt: now, what: null, waitedAt: null });
    return { ok: true };
  });
}

// 他点了拒绝、卡超时或被取消后调用。照 confirmHeldAccess 先核三样：同一线程、锁还是“等确认”、指纹对得上，才把锁改回“做事中”
// （这样桌面角色可以不再问就收尾：关掉自己打开的窗口、不保存、不提交，然后放锁，不会因为一动屏幕又出第二张卡）；同时记一笔“这一项已被拒”。
// 对不上（锁已换线程、已放、已变）不动锁。注意：程序拦不住她硬去点提交——“等确认”本来就是她自己记的，规则写明被拒后只做收尾。
export function refuseHeldAccess({ lockPath = defaultLockPath, threadId, fingerprint, reason = 'approval-denied', now = Date.now(), _hooks }) {
  return withLockGuard(lockPath, _hooks, () => {
    const lock = readLock(lockPath);
    if (!lock || lock.unreadable || lock.state !== 'waiting' || lock.threadId !== String(threadId)) return { ok: false, message: '锁已经变了，没动它' };
    if (approvalFingerprint(threadId, lock.what, lock.waitedAt ?? lock.lastActivityAt) !== fingerprint) return { ok: false, message: '锁上记的事变了，没动它' };
    const refused = [...(lock.refused ?? []), { what: lock.what ?? null, at: now, reason }].slice(-10);
    rewriteLock(lockPath, { ...lock, state: 'working', lastActivityAt: now, holderRunEnded: false, runEndedAt: null, what: null, waitedAt: null, refused });
    return { ok: true };
  });
}

// 审批卡过期（官方给的是“取消”）时，官方交给桌面角色的工具结果写的是“Plugin approval required (gateway unavailable)”，
// 她当成网络故障，锁一改回“做事中”她就重试，把没批准的“提交”点了出去。先后试过两种办法：
//   ① 只挡一次（023971d6）——软挡，第二次就放行，放锁再拿锁标记也没了；
//   ② 现在：**线程级的“只许收尾”标记**。被拒、超时、取消以后，这个线程记进 refused-threads.json（和锁同目录，不跟着锁走），
//      之后这个线程的屏幕调用只放行“看”和“关窗”（见下面白名单），点击、打字、回车、别的按键一律挡；放锁再拿锁也去不掉；
//      只有这个线程又出了新卡、而且新卡被批准（allow-once）才清掉；另外 24 小时后自己过期（不然这个线程以后什么都点不了）。
//      程序读标记出错一律按挡处理，不按放行。
// 白名单（照官方 computer 工具的动作名，dist/computer-use-contract-*.mjs）：
//   只看：screenshot、zoom、list_apps、list_windows、get_accessibility_tree、get_window_state、get_cursor_position、get_browser_state、get_recording_state；
//   等待和调窗口前台：wait、bring_to_front；
//   关窗：key 且按键正好是 cmd+w（含 command+w、meta+w、super+w 写法）；invoke_menu 且菜单路径最后一级是“关闭／Close（窗口、标签页）”。
//   其余（left_click／right_click／double_click…、mouse_move、left_click_drag、scroll、type、set_value、hold_key、别的 key、launch_app、kill_app、
//   browser_* 全部、escalate_scope、录制和回放、没写 action 的）一律挡。browser 工具和 computer 工具用同一张名单。
export const REFUSED_BLOCK_TEXT = '这一项没批（审批卡被拒绝、过期没批或被取消，没有得到主人的批准；工具先前返回的“Plugin approval required (gateway unavailable)”之类的话不是网络故障，意思就是没批），只能收尾；收尾只许截图和关窗。遇到要点按钮的对话框（比如问要不要保存），就停下放锁，在线程里说清楚屏幕停在哪，留给主人。要重新申请，先放锁，再重新申请（出新卡、他点“允许”之后才放开）。';
export const REFUSED_FILE_ERROR_TEXT = '屏幕检查读不懂“只许收尾”的记录（出错一律按挡处理，不让动屏幕）。请点名主人说明。';
export const REFUSED_EXPIRE_MS = 24 * 3600 * 1000;
const SEE_ACTIONS = new Set(['screenshot', 'zoom', 'list_apps', 'list_windows', 'get_accessibility_tree', 'get_window_state', 'get_cursor_position', 'get_browser_state', 'get_recording_state', 'wait', 'bring_to_front']);
const CLOSE_KEYS = new Set(['cmd+w', 'command+w', 'meta+w', 'super+w']);
export const refusedPathOf = (lockPath) => (lockPath ? join(dirname(lockPath), 'refused-threads.json') : null);
export function isCleanupAction(params) {
  const p = params && typeof params === 'object' ? params : {};
  const action = String(p.action ?? '').trim().toLowerCase();
  if (!action) return false;
  if (SEE_ACTIONS.has(action)) return true;
  if (action === 'key') {
    const keys = String(p.keys ?? p.text ?? '').toLowerCase().replace(/\s+/g, '');
    return CLOSE_KEYS.has(keys);
  }
  if (action === 'invoke_menu') {
    const path = Array.isArray(p.path) ? p.path : [];
    const last = String(path.at(-1) ?? '').trim();
    return /^(close( window| tab)?|关闭(窗口|标签页|标签)?)$/i.test(last);
  }
  return false;
}
function readRefusedFile(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return { threads: {} }; throw e; }
  const v = JSON.parse(raw); // 读不懂就抛：调用方按“挡”处理
  if (!v || typeof v !== 'object' || Array.isArray(v) || !v.threads || typeof v.threads !== 'object') throw new Error('refused-threads.json 格式不对');
  return v;
}
function writeRefusedFile(path, v) { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.tmp-${process.pid}`; writeFileSync(tmp, JSON.stringify(v)); renameSync(tmp, path); }
export function markThreadRefused(path, threadId, { at = Date.now(), reason = 'approval-denied', what = null } = {}) {
  if (!path || !threadId) throw new Error('缺少路径或线程编号');
  let v; try { v = readRefusedFile(path); } catch { v = { threads: {} }; } // 写的时候文件坏了就重写成只有这一条（比放行安全）
  v.threads[String(threadId)] = { at, reason, what: what ? String(what).slice(0, 200) : null };
  writeRefusedFile(path, v);
}
export function clearThreadRefused(path, threadId) {
  if (!path || !threadId) return false;
  const v = readRefusedFile(path);
  if (!Object.hasOwn(v.threads, String(threadId))) return false;
  delete v.threads[String(threadId)]; writeRefusedFile(path, v); return true;
}
// 返回 null＝没有标记（或已过 24 小时）；否则返回记录。文件读不懂会抛（调用方按挡处理）。
export function threadRefusedState(path, threadId, now = Date.now()) {
  if (!path || !threadId) return null;
  const rec = readRefusedFile(path).threads[String(threadId)];
  if (!rec) return null;
  if (Number.isFinite(rec.at) && now - rec.at > REFUSED_EXPIRE_MS) return null;
  return rec;
}

// 桌面角色请求来自哪张任务卡：先查程序自动记的“卡↔线程对应”（card-thread-map.mjs 在工具调用、开线程时记，文件
// 资料/运行记录/卡线程/对应.json）；查不到再按任务记录文件找；再不到才返回 null。对应表里同一线程对着多张还没结束的卡 → 返回 {ambiguous:[…]}，不挑。
// 下面是任务记录那一层（小补二）：按**任务记录文件**找——现行模板（资料/模板/任务记录.md）一个 Discord 线程对应一份任务记录，
// 线程链接写在“## Discord 线程链接”一栏、任务卡号写在“## 任务卡号”一栏。只认“线程链接”那一栏里精确等于这个线程编号的；
// 再读同一份记录“任务卡号”一栏里的卡号；不认任务卡正文里随便出现的编号（会挂到别的卡上）。
// 匹配到多份记录、或那份记录的卡号栏不是正好一个卡号、或一份都没有 → 返回 null，由调用方写“没查到关联任务卡（线程 <编号>）”。
// 同步只读（读任务记录文件、只读打开任务板数据库取卡名），不写任何东西。
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function recordSection(text, heading) {
  const m = new RegExp(`^##\\s*${escapeRe(heading)}\\s*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm').exec(text);
  return m ? m[1] : null;
}
const DONE_STATUS = ['done'];
function readCardInfo(dbPath, ids) {
  const out = new Map();
  try {
    const sqlite = process.getBuiltinModule('node:sqlite');
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      for (const id of ids) {
        let row;
        try { row = db.prepare('SELECT title, status, archived_at FROM workboard_cards WHERE id = ?').get(id); } catch { row = db.prepare('SELECT title FROM workboard_cards WHERE id = ?').get(id); }
        if (row) out.set(id, { title: row.title ?? null, status: row.status ?? null, archived: row.archived_at != null });
      }
    } finally { db.close(); }
  } catch { /* 读不到就只有卡号、不过滤 */ }
  return out;
}
export function findCardByThread(threadId, { dataRoot = crew.paths.dataRoot || `${process.env.HOME}/OpenClaw/资料`, dbPath = `${process.env.HOME}/.openclaw/plugins/workboard/workboard.sqlite` } = {}) {
  try {
    const tid = String(threadId ?? '').replace(/[^0-9]/g, '');
    if (tid.length < 5) return null;
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    // 第一层：程序自动记的对应。同一线程可能对着好几张卡（旧的已归档或已完成的不算），剩下恰好一张才用，多张不挑
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dataRoot, W.layout.runLogs, W.layout.runLogDirs.cardThreads, '对应.json'), 'utf8'));
      // 会话键里线程和频道长得一样：只认“已知是 thread-create 开出来的线程”（对应表 threads 里有，或这条是开线程时记的），不把项目频道主区域挂到卡上
      const knownThread = !!doc.threads?.[tid];
      const ids = [...new Set((doc.links ?? []).filter((l) => l.threadId === tid && (knownThread || (l.via ?? []).some((v) => String(v).startsWith('开线程') || String(v).startsWith('同一轮建卡再开线程')))).map((l) => l.cardId))];
      if (ids.length) {
        const info = readCardInfo(dbPath, ids);
        const live = ids.filter((id) => { const c = info.get(id); return !c || (!c.archived && !DONE_STATUS.includes(String(c.status ?? '').toLowerCase())); });
        if (live.length === 1) return { id: live[0], title: info.get(live[0])?.title ?? null, via: '自动对应' };
        if (live.length > 1) return { ambiguous: live.map((id) => ({ id, title: info.get(id)?.title ?? null })) };
      }
    } catch { /* 没有对应表就走任务记录那一层 */ }
    // 第二层：任务记录文件
    const projects = path.join(dataRoot, W.layout.projects);
    const hits = [];
    for (const proj of fs.readdirSync(projects)) {
      const dir = path.join(projects, proj, W.layout.tasks);
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { continue; }
      for (const n of names) {
        let text; try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
        const link = recordSection(text, W.taskRecordSections.threadLink);
        if (!link) continue;
        const ids = [...link.matchAll(/(?<!\d)(\d{17,20})(?!\d)/g)].map((m) => m[1]);
        if (!ids.includes(tid)) continue;
        hits.push({ file: n, cards: [...new Set((recordSection(text, W.taskRecordSections.cardId) ?? '').match(UUID_RE) ?? [])] });
      }
    }
    if (hits.length !== 1 || hits[0].cards.length !== 1) return null;
    const id = hits[0].cards[0];
    return { id, title: readCardInfo(dbPath, [id]).get(id)?.title ?? null, via: '任务记录' };
  } catch { return null; }
}

// 审批卡上“来自任务卡”这一栏的文字
export function cardTextOf(found, threadId) {
  if (found?.ambiguous) return `这个线程对应多张还没结束的卡（${found.ambiguous.map((c) => `${c.id}${c.title ? `《${c.title}》` : ''}`).join('、')}），没法确定是哪张（线程 ${threadId}）`;
  if (found) return `${found.id}${found.title ? `《${found.title}》` : ''}`;
  return `没查到关联任务卡（线程 ${threadId}）`;
}

// 界面元素表放在锁文件同目录的小状态文件里（几份插件拷贝共用）。
export const observationPathOf = (lockPath) => (lockPath ? join(dirname(lockPath), 'ui-elements.json') : null);

export function createScreenGate({ lockPath = defaultLockPath, logPath = defaultLogPath, now = Date.now, guardWaitMs, findCard = null, dataRoot = null, sendApprovalNotice, dedupPath = null, approvalLedger = null, sensitive = true, observationPath, wordsPath } = {}) {
  const obsPath = observationPath ?? observationPathOf(lockPath);
  const wordsFile = wordsPath ?? wordsPathFromLock(lockPath); // 从锁文件位置拼，不从插件自己的位置推
  let wordsCfg = null;
  return function desktopScreenGate(event, ctx) {
    const toolName = String(event?.toolName ?? ctx?.toolName ?? '').replace(/^mcp__openclaw__/, '').toLowerCase();
    if (!SCREEN_TOOLS.includes(toolName)) return;
    const agentId = agentIdOf(ctx);
    if (!agentId) {
      logDecision(logPath, { at: now(), toolName, agentId: null, sessionKey: ctx?.sessionKey ?? null, decision: 'block-no-identity' });
      return { block: true, blockReason: '桌面锁检查：读不到这一轮是哪个角色，为安全起见不让动屏幕。请点名主人说明。' };
    }
    if (agentId === 'desktop' && !lockPath) {
      return { block: true, blockReason: '桌面锁检查不知道锁文件放在哪里（读不到项目根目录），为安全起见不让动屏幕。请点名主人说明。' };
    }
    if (agentId !== 'desktop') {
      logDecision(logPath, { at: now(), toolName, agentId: agentId ?? null, sessionKey: ctx?.sessionKey ?? null, decision: 'ignored-not-desktop' });
      return;
    }
    try {
      const verdict = checkScreenAccess({
        lockPath,
        logPath,
        sessionKey: ctx.sessionKey,
        runId: ctx.runId ?? event?.runId,
        requester: ctx.requester,
        now: now(),
        _hooks: guardWaitMs === undefined ? undefined : { guardWaitMs },
      });
      logDecision(logPath, { at: now(), toolName, agentId, sessionKey: ctx.sessionKey ?? null, decision: verdict.allow ? 'allow' : 'block', requester: ctx.requester?.senderId ?? null, reason: verdict.allow ? undefined : verdict.reason.slice(0, 80) });
      const approvalReturn = (info) => {
        const found = info.cardId ? { id: info.cardId, title: null } : (findCard ?? ((tid) => findCardByThread(tid, dataRoot ? { dataRoot } : {})))(info.threadId);
        const cardText = cardTextOf(found, info.threadId);
        logDecision(logPath, { at: now(), toolName, agentId, sessionKey: ctx.sessionKey ?? null, decision: 'require-approval', fingerprint: info.fingerprint });
        // 说明在程序里先换掉会被官方清理放大的字符、再截到 480 码点以内（官方清理后超 512 会整张拒掉）。
        // 先后：先砍末尾的提示 → 再截“多张卡没法确定”那一栏（给张数上限）→ 再截“什么事”；“批的是什么”“申请的 bot”“原线程”始终保留。
        const link = info.link ?? `https://discord.com/channels/${GUILD_ID}/${info.threadId}`;
        const cardField = found?.ambiguous
          ? (text, room) => { const n = found.ambiguous.length; const shown = found.ambiguous.slice(0, Math.max(1, Math.min(n, Math.floor((room - 40) / 40)))); return `这个线程对应多张还没结束的卡（${shown.map((c) => `${plainApprovalText(c.id)}${c.title ? `《${cutCodePoints(plainApprovalText(c.title), 8)}》` : ''}`).join('、')}${shown.length < n ? `等 ${n} 张` : ''}），没法确定是哪张（线程 ${info.threadId}）`; }
          : undefined;
        const description = composeApprovalDescription([
          { kind: 'keep', text: '什么事：' },
          { kind: 'var', order: 1, min: 20, text: `${info.what ?? '（没有记下是哪件事）'}`, cut: (text, room) => cutCodePoints(text, room) },
          { kind: 'keep', text: `。批的是什么：只放行桌面角色的这一次屏幕调用（用过就作废，下一项要重新记等确认、重新批）。${info.auto ? PROGRAM_NOTE : ''}申请的 bot：桌面角色。来自任务卡：` },
          { kind: 'var', order: 0, min: 60, text: cardText, cut: cardField },
          { kind: 'keep', text: `；原线程：${link}。` },
          { kind: 'tail', text: `桌面角色在线程 ${info.threadId} 里要继续动屏幕；之后要再做六类操作，桌面角色要先重新记“等确认”、重新批。` },
        ]);
// 同一线程又出了新的审批卡（重新申请）→ 把还没处理的“审批过期”条目改已定（失败不影响卡）。
        try { Promise.resolve(approvalLedger?.reissued?.({ kind: W.ledgerKinds.desktop, cardId: info.cardId ?? found?.id ?? null, threadId: info.threadId })).catch(() => {}); } catch { /* 只是记录 */ }
        // 每出一张卡，异步用总控账号往“审批”频道另发一条点名主人的短消息（做法二）；发失败只记日志，不影响卡。
        try {
          notifyApprovalCard({ dedupKey: `desktop:${info.fingerprint ?? info.threadId}`, what: info.what, cardId: info.cardId ?? found?.id ?? null, source: '桌面角色六类操作', now, send: sendApprovalNotice, dedupPath, log: (row) => logDecision(logPath, { at: now(), toolName, agentId, ...row }) });
        } catch { /* 另发提醒失败不影响卡 */ }
        return {
          requireApproval: {
            title: cutCodePoints('六类操作确认', APPROVAL_TITLE_MAX),
            description,
            severity: 'warning', allowedDecisions: ['allow-once', 'deny'], timeoutMs: 600_000, timeoutReason: '没有批准，屏幕上的东西没有被动', pluginId: 'personal-inbox',
            onResolution: (decision) => {
              const d = typeof decision === 'string' ? decision : decision?.decision;
              if (d === 'allow-once') {
                const r = confirmHeldAccess({ lockPath, threadId: info.threadId, fingerprint: info.fingerprint, now: now() });
                if (r.ok) { try { clearThreadRefused(refusedPathOf(lockPath), info.threadId); } catch (e) { logDecision(logPath, { at: now(), toolName, agentId, decision: 'refused-clear-failed', reason: String(e?.message ?? e).slice(0, 200) }); } }
                logDecision(logPath, { at: now(), toolName, agentId, decision: r.ok ? 'approved-once' : 'approval-void', reason: r.ok ? undefined : r.message });
              } else {
// 拒绝、超时、取消分开记；锁改回“做事中”让桌面角色收尾放锁（核三样，对不上不动锁）；超时和取消另登记进“等你定”，拒绝不登记。
                const kind = d === 'deny' ? 'approval-denied' : d === 'timeout' ? 'approval-timeout' : d === 'cancelled' ? 'approval-cancelled' : 'approval-denied-or-timeout';
                let r = { ok: false, message: '没处理' };
                let marked = true;
                try { markThreadRefused(refusedPathOf(lockPath), info.threadId, { at: now(), reason: kind, what: info.what ?? null }); } catch (e) { marked = false; logDecision(logPath, { at: now(), toolName, agentId, decision: 'refused-mark-failed', reason: String(e?.message ?? e).slice(0, 200) }); }
                // 标记没写成：锁不改回“做事中”，仍停在“等确认”（再动屏幕就出新卡），宁可多一张卡也不放行
                if (marked) try { r = refuseHeldAccess({ lockPath, threadId: info.threadId, fingerprint: info.fingerprint, reason: kind, now: now() }); } catch (e) { r = { ok: false, message: String(e?.message ?? e) }; }
                logDecision(logPath, { at: now(), toolName, agentId, decision: kind, lockReleasedToWorking: r.ok, reason: r.ok ? undefined : r.message });
                if (kind === 'approval-timeout' || kind === 'approval-cancelled' || kind === 'approval-denied-or-timeout') {
                  try { Promise.resolve(approvalLedger?.expired?.({ kind: W.ledgerKinds.desktop, what: info.what ?? null, cardId: info.cardId ?? found?.id ?? null, threadId: info.threadId, link: info.link ?? null, expiredAt: now() })).catch((e) => logDecision(logPath, { at: now(), toolName, agentId, decision: 'approval-expiry-register-failed', reason: String(e?.message ?? e).slice(0, 200) })); } catch { /* 登记失败不影响卡 */ }
                }
              }
            },
          },
        };
      };
      if (verdict.approval) return approvalReturn(verdict.approvalInfo);
      if (!verdict.allow) return { block: true, blockReason: verdict.reason };
// 放在“屏幕闸门最后判放行”的这一处——前面所有会挡下的情况（排队、现场待检查、审批卡、锁变了……）都已经 return 了，
      // 不会被记成放行。连续 2 次“放行后报错”就拦下第三次并叫她点名任务审计求助；求助后又连败 2 次就叫她停下。不拦就记下这次放行的 toolCallId，after_tool_call 只认这些编号。
      // 保险自己出错不影响屏幕（宁可少拦）。
      // 线程级“只许收尾”：这里不吞错——读标记出错会抛到外面的 catch，那里统一按“挡”处理。
      const refusedRec = threadRefusedState(refusedPathOf(lockPath), threadIdFromSessionKey(ctx.sessionKey), now());
      if (refusedRec && !isCleanupAction(event?.params)) {
        logDecision(logPath, { at: now(), toolName, agentId, sessionKey: ctx.sessionKey ?? null, decision: 'refused-block', action: String(event?.params?.action ?? '').slice(0, 40) });
        return { block: true, blockReason: REFUSED_BLOCK_TEXT };
      }
// 只在前面都放行了的调用上才运行——不是放行、已在“只许收尾”、已被卡住计数拦下的都不碰；
      // 所以放在“只许收尾”硬拦之后、卡住计数之前。认出来就替她记一次“等确认”，直接用同一个出卡分支。
      if (sensitive && obsPath) {
        let s = null;
        const sThread = threadIdFromSessionKey(ctx.sessionKey);
        try {
          wordsCfg ??= loadWords(wordsFile);
          s = classifyCall({ toolName, params: event?.params, observations: loadObservations({ path: obsPath, threadId: sThread, now: now() }), cfg: wordsCfg, now: now() });
          if (s.unrecognized) logDecision(logPath, { at: now(), toolName, agentId, sessionKey: ctx.sessionKey ?? null, decision: 'sensitive-unrecognized', action: String(event?.params?.action ?? '').slice(0, 40) });
        } catch (e) {
          s = null; // 识别自己出错：放行（现状不比现在差），记日志
          logDecision(logPath, { at: now(), toolName, agentId, sessionKey: ctx.sessionKey ?? null, decision: 'sensitive-error', reason: String(e?.message ?? e).slice(0, 120) });
        }
        if (s?.hit) {
          const held = holdForConfirmation({ lockPath, threadId: sThread, what: s.what, now: now(), _hooks: guardWaitMs === undefined ? undefined : { guardWaitMs } });
          if (!held.ok) {
            // 复核新同义的 lock.refused 还在时不改锁，直接按它的话拦下，不出卡
            logDecision(logPath, { at: now(), toolName, agentId, sessionKey: ctx.sessionKey ?? null, decision: 'sensitive-hold-refused', word: s.word });
            return { block: true, blockReason: held.message };
          }
          const lk = readLock(lockPath);
          const info = { threadId: sThread, what: lk.what ?? null, cardId: lk.cardId ?? null, link: lk.link ?? null, waitedAt: lk.waitedAt, fingerprint: approvalFingerprint(sThread, lk.what, lk.waitedAt), auto: true };
          logDecision(logPath, { at: now(), toolName, agentId, sessionKey: ctx.sessionKey ?? null, decision: 'sensitive-detected', via: s.via, word: s.word, always: s.always ? true : undefined });
          return approvalReturn(info);
        }
      }
      try {
        const threadId = threadIdFromSessionKey(ctx.sessionKey);
        const lock = readLock(lockPath);
        const stuck = stuckGateCheck(stuckPathOf(lockPath), { threadId, lockStamp: lock && !lock.unreadable && lock.threadId === threadId ? lock.startedAt : null, toolCallId: event?.toolCallId });
        if (stuck) {
          logDecision(logPath, { at: now(), toolName, agentId, sessionKey: ctx.sessionKey ?? null, decision: 'stuck-block', phase: stuck.phase });
          return { block: true, blockReason: stuck.reason };
        }
      } catch { /* 保险出错：放行 */ }
    } catch (error) {
      logDecision(logPath, { at: now(), toolName, agentId, sessionKey: ctx?.sessionKey ?? null, decision: 'error', reason: error.message });
      return { block: true, blockReason: `桌面锁检查出错，为安全起见不让动屏幕：${error.message}。请点名主人说明。` };
    }
  };
}

// 桌面角色自己合法的命令（desktop-lock、ioreg、system_profiler、date、读写自己工作区文件）一个都不含这些词。
export const EXEC_SCREEN_WORDS = /\b(osascript|cliclick|peekaboo|screencapture)\b|tell\s+application|system\s+events/i;
export const EXEC_BLOCK_TEXT = '桌面角色用屏幕工具（computer）动屏幕，不用命令行动屏幕：osascript、cliclick、peekaboo、screencapture、tell application、System Events 这类命令不能用。需要截图就用屏幕工具的 screenshot。';
export function createDesktopExecGuard({ logPath = null, now = Date.now } = {}) {
  return function desktopExecGuard(event, ctx) {
    try {
      if (agentIdOf(ctx) !== 'desktop') return;
      const tool = String(event?.toolName ?? ctx?.toolName ?? '').replace(/^mcp__openclaw__/, '').toLowerCase();
      if (tool && !['exec', 'bash'].includes(tool)) return; // 没写工具名的（测试里直接调）按命令内容判
      const cmd = String(event?.params?.command ?? '');
      if (!EXEC_SCREEN_WORDS.test(cmd)) return;
      if (logPath) logDecision(logPath, { at: now(), toolName: 'exec', agentId: 'desktop', sessionKey: ctx?.sessionKey ?? null, decision: 'exec-screen-block' });
      return { block: true, blockReason: EXEC_BLOCK_TEXT };
    } catch { return; } // 保险出错不影响（宁可少拦）
  };
}

// 官方结果"出错了"的几种形状（原来只在 stuck 保险那一块里用，作废旧观察也要用，所以外提到这里）。
export const failedShapeOf = (r) => r && typeof r === 'object' && (r.isError === true || r.ok === false || (r.details && typeof r.details === 'object' && (r.details.isError === true || r.details.ok === false)));
// 只给"旧观察作废"判断用的"只读动作集合"：这些动作不会改变页面，旧观察继续有效；
// 其余动作（点击、滚动、打字、按键、**切窗 bring_to_front**、启动／关闭应用、菜单、browser 的点击等）放行之后都作废旧观察。
// **不是 SEE_ACTIONS**：SEE_ACTIONS 给"只许收尾"硬拦放行 bring_to_front 用，不能改。browser 工具的只读动作 snapshot／status／tabs 也在这里。
export const NON_INVALIDATING_ACTIONS = new Set(['screenshot', 'zoom', 'list_apps', 'list_windows', 'get_accessibility_tree', 'get_window_state', 'get_cursor_position', 'get_browser_state', 'get_recording_state', 'wait', 'snapshot', 'status', 'tabs']);
export const isInvalidatingAction = (action) => { const a = String(action ?? '').trim().toLowerCase(); return Boolean(a) && !NON_INVALIDATING_ACTIONS.has(a); };

export function registerDesktopScreenLock(api, options = {}) {
  // 官方在不同路径上给的工具名可能带 mcp__openclaw__ 前缀，两种都盯。
  api.on('before_tool_call', createScreenGate(options), {
    matcher: [...SCREEN_TOOLS, ...SCREEN_TOOLS.map((name) => `mcp__openclaw__${name}`)],
    registrationId: 'desktop-screen-lock-gate',
  });
// 词表读不到不能静悄悄失效——注册时就读一遍，读不到写进日志（并给官方日志一行警告）；运行中每次读不到也会记 sensitive-error。
  if (options.lockPath && options.sensitive !== false) {
    try { loadWords(options.wordsPath ?? wordsPathFromLock(options.lockPath)); }
    catch (e) {
      const msg = `desktop-lock: 提交类点击词表读不到（${String(e?.message ?? e).slice(0, 120)}），程序认提交按钮暂时不生效`;
      if (options.logPath) logDecision(options.logPath, { at: Date.now(), toolName: null, agentId: 'desktop', decision: 'sensitive-words-unreadable', reason: msg.slice(0, 200) });
      try { api.logger?.warn?.(msg); } catch { /* 只是日志 */ }
    }
  }
// 记桌面角色最近看到的界面元素表（只管桌面角色、只管屏幕工具；失败的调用不记）。
  if (options.lockPath && options.sensitive !== false) {
    const obsPath = options.observationPath ?? observationPathOf(options.lockPath);
    const guardHooks = options.guardWaitMs === undefined ? undefined : { guardWaitMs: options.guardWaitMs };
    let wordsCfg = null; // 词表在注册时读一次；读不到（上面已记日志）就是 null：状态文件所有文字留空
    try { wordsCfg = loadWords(options.wordsPath ?? wordsPathFromLock(options.lockPath)); } catch { wordsCfg = null; }
    api.on('after_tool_call', (event, ctx) => {
      try {
        if (agentIdOf(ctx) !== 'desktop') return;
        const tool = String(event?.toolName ?? '').replace(/^mcp__openclaw__/, '').toLowerCase();
        if (!SCREEN_TOOLS.includes(tool) || event?.error) return;
        const threadId = threadIdFromSessionKey(ctx?.sessionKey);
        if (!threadId) return;
        // 抓真实事件形状（上线第一步用）：锁文件同目录里放一个空文件 capture-shape.flag，就把每次屏幕调用结果的“键名和类型”（不含任何值）追加进 shape-capture.jsonl；删掉标记文件就停。
        const shapeLog = options.shapeLogPath ?? (existsSync(join(dirname(options.lockPath), 'capture-shape.flag')) ? join(dirname(options.lockPath), 'shape-capture.jsonl') : null);
        if (shapeLog) { try { appendFileSync(shapeLog, `${JSON.stringify(describeDiagnostics(event, { tool }))}\n`); } catch { /* 只是记形状 */ } }
        if (failedShapeOf(event?.result)) return; // 出错的调用一概不动（不记、不作废）
        const action = String(event?.params?.action ?? '');
        withLockGuard(options.lockPath, guardHooks, () => {
          const now = Date.now();
          if (isInvalidatingAction(action)) invalidateObservations({ path: obsPath, threadId, now }); // 先作废旧的，再记这次结果里可能带的新表
          recordObservation({ path: obsPath, threadId, result: event?.result, now, cfg: wordsCfg, onSkip: (info) => { if (options.logPath) logDecision(options.logPath, { at: now, toolName: tool, agentId: 'desktop', decision: 'observation-skipped', ...info }); } });
        });
      } catch { /* 记不下来只是认不出，不影响屏幕 */ }
    }, { registrationId: 'desktop-observation-record' });
  }
// 桌面角色的 exec 命令里含动屏幕的关键字就挡（她有屏幕工具，不需要命令行动屏幕）。
  if (options.execBlock !== false) {
    // 不写 matcher：官方只认"规范工具编号"；
    // 和审计守门一样，在处理函数里自己按工具名过滤。
    api.on('before_tool_call', createDesktopExecGuard({ logPath: options.logPath }), { registrationId: 'desktop-exec-screen-block' });
  }
// 数“放行后报错”、认“已求助”（普通回复和 message 工具两条路都认）、认“任务审计已回”。
  const stuckPath = options.stuckPath ?? stuckPathOf(options.lockPath);
  if (stuckPath && options.lockPath) {
    const failedShape = failedShapeOf;
    api.on('after_tool_call', (event, ctx) => {
      try {
        if (agentIdOf(ctx) !== 'desktop') return;
        const tool = String(event?.toolName ?? '').replace(/^mcp__openclaw__/, '').toLowerCase();
        if (!SCREEN_TOOLS.includes(tool)) return;
        const threadId = threadIdFromSessionKey(ctx?.sessionKey);
        const lock = readLock(options.lockPath);
        stuckNoteResult(stuckPath, { threadId, lockStamp: lock && !lock.unreadable && lock.threadId === threadId ? lock.startedAt : null, toolCallId: event?.toolCallId ?? ctx?.toolCallId, failed: Boolean(event?.error) || failedShape(event?.result) });
      } catch { /* 保险出错不影响 */ }
    }, { registrationId: 'desktop-stuck-result' });
    const noteText = (agentId, text, ctx, event, via = 'message_sending') => {
      if (typeof text !== 'string') return;
      if (agentId === 'desktop' && isHelpRequestText(text)) {
        const threadId = threadIdFromSessionKey(ctx?.sessionKey);
        const lock = readLock(options.lockPath);
        if (stuckNoteHelp(stuckPath, { threadId, lockStamp: lock && !lock.unreadable && lock.threadId === threadId ? lock.startedAt : null, at: Date.now() }) && options.logPath) logDecision(options.logPath, { at: Date.now(), toolName: 'message', agentId, sessionKey: ctx?.sessionKey ?? null, decision: 'stuck-help-requested', via });
      } else if (agentId === 'task-auditor' && isHelpReplyText(text)) {
        const threadId = (event?.threadId != null ? String(event.threadId) : null) ?? (/(\d{5,})$/.exec(String(event?.to ?? '')) ?? [])[1] ?? threadIdFromSessionKey(ctx?.sessionKey);
        if (stuckNoteAnswer(stuckPath, { threadId }) && options.logPath) logDecision(options.logPath, { at: Date.now(), toolName: 'message', agentId, sessionKey: ctx?.sessionKey ?? null, decision: 'stuck-help-answered', via });
      }
    };
    api.on('message_sending', (event, ctx) => { try { noteText(agentIdOf(ctx), event?.content, ctx, event); } catch { /* 只是记录 */ } return undefined; }, { registrationId: 'desktop-stuck-message-sending' });
    api.on('before_tool_call', (event, ctx) => {
      try {
        const tool = String(event?.toolName ?? '').replace(/^mcp__openclaw__/, '').toLowerCase();
        if (tool !== 'message') return undefined;
        const p = event?.params ?? {};
        noteText(agentIdOf(ctx), p.message ?? p.content ?? p.text ?? p.body, ctx, { threadId: p.threadId ?? null, to: p.target ?? null }, 'before_tool_call');
      } catch { /* 只是记录 */ }
      return undefined;
    }, { matcher: ['message', 'mcp__openclaw__message'], registrationId: 'desktop-stuck-message-tool' });
  }
  api.on('agent_end', (_event, ctx) => {
    if (agentIdOf(ctx) !== 'desktop') return;
    try {
      markRunEnded({ lockPath: options.lockPath, sessionKey: ctx.sessionKey, _hooks: options.guardWaitMs === undefined ? undefined : { guardWaitMs: options.guardWaitMs } });
    } catch (error) {
      // 只是记一笔；记不上时，锁靠“20 分钟没动静”失效。真实原因记进日志，不吞掉。
      if (options.logPath) logDecision(options.logPath, { at: Date.now(), toolName: 'agent_end', agentId: 'desktop', sessionKey: ctx.sessionKey ?? null, decision: 'run-ended-error', reason: error.message });
    }
  }, { registrationId: 'desktop-screen-lock-run-ended' });
}
