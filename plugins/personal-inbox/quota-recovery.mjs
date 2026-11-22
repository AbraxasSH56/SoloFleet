// Registers runs that ended on a subscription-quota error so they can be resumed after the quota comes back.
// 额度失败登记。
// 这个模块现在只做“登记”，不再改任何定时任务、不再派活：
//   1. 凡一轮因额度句结束（任何角色、定时任务和对话都记），登记到 <资料根>/运行记录/额度/<运行编号>.json；
//   2. 日审、巡查、异常深审、周审每次开始时，把官方“任务开始”事件自带的当轮计划存档到 <资料根>/运行记录/额度/计划存档/<任务编号>-<开始时间>.json；
//   3. 能解析 resets 后面的整点（3pm）、带分钟（3:10pm）、跨天（Nov 12, 3pm／Nov 12 at 3:10pm）写法，认不出写“未知”。
// 补跑由命令型定时任务“额度补跑”（scripts/automation/quota-catchup.mjs）做；它只读这里写的登记和存档。
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const AUDIT_TASK_NAMES = ['日审', '巡查', '异常深审', '周审'];
// 订阅额度句（新旧两版）：5-hour／session／weekly／Opus／Sonnet／Fable 限额。usage credit 不算订阅额度。
export const QUOTA_SENTENCE = /you['’]ve hit your (?:session|5-hour|weekly|opus|sonnet|fable) limit/i;
export const isQuotaSentence = (text) => QUOTA_SENTENCE.test(String(text ?? ''));

// ---------- 时区与时间解析 ----------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  return f;
}
export function validTimeZone(tz) {
  try { formatter(tz); return true; } catch { return false; }
}
function wallClock(tz, utcMs) {
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(utcMs)).map((p) => [p.type, Number(p.value)]));
  return { y: parts.year, mo: parts.month - 1, d: parts.day, h: parts.hour, mi: parts.minute, s: parts.second };
}
function tzOffsetMs(tz, utcMs) {
  const w = wallClock(tz, utcMs);
  return Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s) - Math.floor(utcMs / 1000) * 1000;
}
// 某时区的“年月日时分”对应的 UTC 毫秒；日期会按日历进位（d 可以是 32 之类）；该时刻在这个时区不存在（夏令时空档）返回 null。
export function zonedTimeToUtc(tz, y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const first = guess - tzOffsetMs(tz, guess);
  const t = guess - tzOffsetMs(tz, first);
  const back = wallClock(tz, t);
  const want = new Date(guess);
  return back.y === want.getUTCFullYear() && back.mo === want.getUTCMonth() && back.d === want.getUTCDate() && back.h === want.getUTCHours() && back.mi === want.getUTCMinutes() ? t : null;
}
export function localDate(tz, utcMs) {
  const w = wallClock(tz, utcMs);
  return `${w.y}-${String(w.mo + 1).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

const RESETS = /resets\s+(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:,|\s+at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([A-Za-z_]+(?:\/[A-Za-z_+\-0-9]+){0,2}|UTC)\)/i;
// 解析报错里 resets 后面的恢复时间。只认已经观察到的写法；认不出返回 null（调用方写“未知”）。不做百分比换算。
export function resetAt(error, endedAt) {
  const text = String(error ?? '');
  if (!isQuotaSentence(text) || !Number.isFinite(endedAt)) return null;
  const m = RESETS.exec(text);
  if (!m) return null;
  const tz = m[6];
  if (!validTimeZone(tz)) return null;
  const hour12 = Number(m[3]);
  const minute = m[4] === undefined ? 0 : Number(m[4]);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const h = hour12 % 12 + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  const base = wallClock(tz, endedAt);
  if (m[1] === undefined) {
    let at = zonedTimeToUtc(tz, base.y, base.mo, base.d, h, minute);
    if (at !== null && at <= endedAt) at = zonedTimeToUtc(tz, base.y, base.mo, base.d + 1, h, minute);
    return at !== null && at > endedAt && at - endedAt <= 2 * 86400000 ? at : null;
  }
  const month = MONTHS.indexOf(m[1].toLowerCase());
  const day = Number(m[2]);
  if (day < 1 || day > 31) return null;
  for (const y of [base.y, base.y + 1]) {
    const probe = new Date(Date.UTC(y, month, day));
    if (probe.getUTCMonth() !== month || probe.getUTCDate() !== day) continue; // 2 月 30 日这类
    const at = zonedTimeToUtc(tz, y, month, day, h, minute);
    if (at !== null && at > endedAt && at - endedAt <= 10 * 86400000) return at;
  }
  return null;
}

// ---------- 计划里的原定轮次 ----------
function parseCronField(field, min, max) {
  if (field === '*') return null; // 任意
  const values = new Set();
  for (const part of field.split(',')) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) return undefined;
    const a = Number(range[1]);
    const b = range[2] === undefined ? a : Number(range[2]);
    if (a < min || b > max || a > b) return undefined;
    for (let v = a; v <= b; v += 1) values.add(v);
  }
  return values;
}
function parseSimpleCron(schedule) {
  if (!schedule || schedule.kind !== 'cron' || typeof schedule.expr !== 'string') return null;
  const f = schedule.expr.trim().split(/\s+/);
  if (f.length !== 5 || f[2] !== '*' || f[3] !== '*') return null;
  const minute = Number(f[0]);
  const hour = Number(f[1]);
  if (!Number.isInteger(minute) || !Number.isInteger(hour) || minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  const dows = parseCronField(f[4].replace(/\b7\b/g, '0'), 0, 6);
  if (dows === undefined) return null;
  const tz = schedule.tz ?? 'UTC';
  if (!validTimeZone(tz)) return null;
  return { minute, hour, dows, tz };
}
// 最近一个“已到”的原定时间（≤ atMs）；只支持“每天某时”或“每周某天某时”的 cron，其他返回 null。
export function previousOccurrence(schedule, atMs) {
  const c = parseSimpleCron(schedule);
  if (!c) return null;
  const base = wallClock(c.tz, atMs);
  for (let back = 0; back <= 9; back += 1) {
    const dow = new Date(Date.UTC(base.y, base.mo, base.d - back)).getUTCDay();
    if (c.dows && !c.dows.has(dow)) continue;
    const t = zonedTimeToUtc(c.tz, base.y, base.mo, base.d - back, c.hour, c.minute);
    if (t !== null && t <= atMs) return { atMs: t, businessDate: localDate(c.tz, t) };
  }
  return null;
}
// 严格晚于 afterMs 的下一个原定时间。
export function nextOccurrence(schedule, afterMs) {
  const c = parseSimpleCron(schedule);
  if (!c) return null;
  const base = wallClock(c.tz, afterMs);
  for (let ahead = 0; ahead <= 9; ahead += 1) {
    const dow = new Date(Date.UTC(base.y, base.mo, base.d + ahead)).getUTCDay();
    if (c.dows && !c.dows.has(dow)) continue;
    const t = zonedTimeToUtc(c.tz, base.y, base.mo, base.d + ahead, c.hour, c.minute);
    if (t !== null && t > afterMs) return { atMs: t, businessDate: localDate(c.tz, t) };
  }
  return null;
}

// ---------- 文件写法 ----------
const safeName = (s) => String(s).replace(/[\/\\]/g, '_');
function writeTemp(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  return tmp;
}
// 同名已存在不重写：写临时文件再硬链接过去（链接遇到已存在的文件会失败）。返回 true＝新写入。
export function writeIfAbsent(path, data) {
  const tmp = writeTemp(path, data);
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    try { unlinkSync(tmp); } catch { /* 临时文件已经没了 */ }
  }
}
export function writeReplace(path, data) {
  const tmp = writeTemp(path, data);
  renameSync(tmp, path);
}
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

// ---------- 登记 ----------
export function createQuotaRegistry({ dataRoot, modelFor = () => null, now = Date.now }) {
  const dir = join(dataRoot, '运行记录', '额度');
  const archiveDir = join(dir, '计划存档');
  const actions = new Map();
  const jobIdOf = (sessionKey) => /^agent:[^:]+:cron:([^:]+):run:/.exec(sessionKey ?? '')?.[1] ?? null;

  // 额度失败登记。返回登记内容（没登记返回 null）。
  function observe(event) {
    if (!event?.runId || !event.agentId) return null;
    const model = modelFor(event.agentId);
    if (!/^anthropic\/claude-/.test(model ?? '')) return null;
    if (event.stream === 'tool') {
      const list = actions.get(event.runId) ?? [];
      list.push({ seq: event.seq, phase: event.data?.phase, name: event.data?.name, toolCallId: event.data?.toolCallId });
      actions.set(event.runId, list.slice(-40));
      return null;
    }
    if (event.stream !== 'lifecycle' || !['end', 'error'].includes(event.data?.phase)) return null;
    const seen = actions.get(event.runId) ?? [];
    actions.delete(event.runId);
    const error = String(event.data?.error ?? '');
    if (!isQuotaSentence(error)) return null;
    const endedAt = event.data.endedAt ?? event.ts;
    const reset = resetAt(error, endedAt);
    const jobId = jobIdOf(event.sessionKey);
    const record = {
      运行编号: event.runId,
      会话键: event.sessionKey ?? null,
      角色: event.agentId,
      是定时任务: jobId !== null,
      任务编号: jobId,
      型号: model,
      开始时间毫秒: event.data.startedAt ?? null,
      失败时间毫秒: endedAt,
      报错前200字: error.slice(0, 200),
      恢复时间毫秒: reset,
      恢复时间: reset === null ? '未知' : new Date(reset).toISOString(),
      终态已确认: event.data.executionSettled === true,
      已做的工具动作: seen,
      说明: '只登记，不改任何定时任务、不派活；补跑由“额度补跑”任务按这份登记和计划存档判断。',
      登记时间毫秒: now(),
    };
    const path = join(dir, `${safeName(event.runId)}.json`);
    if (!writeIfAbsent(path, record)) {
      const prior = readJson(path);
      // 第一次看到时终态还没确认，后来确认了：只更新这一处；其余不重写
      if (prior && prior.终态已确认 !== true && record.终态已确认) writeReplace(path, { ...prior, ...record, 登记时间毫秒: prior.登记时间毫秒 });
      return prior;
    }
    return record;
  }

  // 官方“任务开始”事件：只认四个审计任务。同名存档已存在不覆盖；官方重试（30 秒、1 分钟、5 分钟）各自是另一份。
  function cronChanged(event) {
    if (event?.action !== 'started') return null;
    const job = event.job;
    // Cleanup: 不再读“测试台.json”做测试分流；测试台演练改用名字叫“额度补跑测试”之外的真实路径时，由补跑脚本的测试开关管，不在这里分流。
    if (!job || !AUDIT_TASK_NAMES.includes(job.name) || !Number.isFinite(event.runAtMs) || typeof event.jobId !== 'string') return null;
    const targetDir = archiveDir;
    const schedule = job.schedule ? JSON.parse(JSON.stringify(job.schedule)) : null;
    const due = previousOccurrence(schedule, event.runAtMs);
    const record = {
      任务编号: event.jobId,
      任务名: job.name,
      开始时间毫秒: event.runAtMs,
      开始时间: new Date(event.runAtMs).toISOString(),
      计划: schedule,
      计划来源: '官方 cron_changed “任务开始”事件自带的 job.schedule',
      原定轮次: due ? { 业务日期: due.businessDate, 原定时间毫秒: due.atMs, 距原定时间秒: Math.round((event.runAtMs - due.atMs) / 1000) } : '未知',
      推断: '距原定时间很近视为原定那轮；明显晚于原定时间的是官方重试或手动运行（事件本身不带这个标记，这里是推断）',
      任务状态摘要: { 下次运行毫秒: job.state?.nextRunAtMs ?? null, 运行中毫秒: job.state?.runningAtMs ?? null, 启用: job.enabled ?? null },
      存档时间毫秒: now(),
    };
    writeIfAbsent(join(targetDir, `${safeName(event.jobId)}-${event.runAtMs}.json`), record);
    return record;
  }
  return { observe, cronChanged, dir, archiveDir };
}

// 配置里角色的 model 可能写的是别名（如 opus、anthropic/opus），按 agents.defaults.models 里的别名还原成真实型号。
export function modelFromConfig(config, id) {
  const m = config?.agents?.entries?.[id]?.model;
  const raw = typeof m === 'string' ? m : m?.primary;
  if (typeof raw !== 'string') return raw;
  const models = config?.agents?.defaults?.models;
  if (!models || typeof models !== 'object' || Object.hasOwn(models, raw)) return raw;
  const want = raw.trim().toLowerCase();
  for (const [ref, entry] of Object.entries(models)) {
    const alias = typeof entry?.alias === 'string' ? entry.alias.trim().toLowerCase() : '';
    if (!alias) continue;
    const provider = ref.includes('/') ? ref.slice(0, ref.indexOf('/')).toLowerCase() : '';
    if (want === alias || (provider && want === `${provider}/${alias}`)) return ref;
  }
  return raw;
}

export function registerQuotaRecovery(api, root, options = {}) {
  if (!root) return;
  const dataRoot = options.dataRoot ?? join(dirname(root), '资料');
  let registry = null;
  let stopHook = null;
  api.on('cron_changed', (event) => {
    try { registry?.cronChanged(event); } catch (error) { api.logger.warn(`quota plan archive: ${error}`); }
  }, { registrationId: 'quota-plan-archive-cron-started' });
  api.registerService({
    id: 'personal-inbox-quota-registry',
    reload: { configPrefixes: ['agents.entries', 'agents.defaults'] },
    async start(ctx) {
      registry = createQuotaRegistry({ dataRoot, modelFor: (id) => modelFromConfig(ctx.config, id) });
      const unsubscribe = api.runtime.events.onAgentEvent((event) => {
        try { registry?.observe(event); } catch (error) { ctx.logger.warn(`quota registry: ${error}`); }
      });
      stopHook = () => { unsubscribe(); registry = null; };
    },
    async stop() { stopHook?.(); stopHook = null; },
  });
}

