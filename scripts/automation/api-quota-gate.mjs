#!/usr/bin/env node
// API quota gate: pauses the API-funded scheduled jobs when the quota period ends or runs out and resumes them automatically. No model calls.
// 做的事：到期（或钱用完）→ 把 日审／巡查／异常深审／周审 四个任务逐个“停用”并在工坊说一句；
//        暂停后每 3 小时试探一次，额度回来 → 自动“启用”并说一句；也可由人给新到期日恢复。
// 四个任务自己的设置一律不改，只动“启用”开关。状态记在 <资料根>/运行记录/API额度/状态.json，只由本脚本写（加锁、原子替换）。
// 用法：
//   node api-quota-gate.mjs                    定时任务入口（输出 NO_REPLY；要说的话脚本自己发到工坊、拿到回执才算发出）
//   node api-quota-gate.mjs --status           只读：输出当前状态一段话
//   node api-quota-gate.mjs --init <到期日>     上线前预置状态文件（到期日 YYYY-MM-DD 或带时区的完整时间；任务编号按名字从官方清单里查）
//   node api-quota-gate.mjs --resume [YYYY-MM-DD]  恢复四个任务并把当期到期日改成这天 07:00（配置时区，钟点见 EXPIRY_HOUR）；不带日期＝恢复但到期日未知
//   node api-quota-gate.mjs --pause            手动暂停（原因＝手动）
// 选项：--data-root <资料根>（只给离线测试用）
import { localIsoAt } from '../../plugins/personal-inbox/tz.mjs';
export const EXPIRY_HOUR = 7; // local hour at which an API credit period ends (edit to match your plan's period end)
import { fileURLToPath } from 'node:url';
import { DAY_MS, DEFAULT_DATA_ROOT, atomicWriteJson, localParts, localDayStart, localIso, cnDate, cnDateTime, isRealDate, join, parseJsonLoose, readJson, realRunner, realSend, withLock } from './gap-common.mjs';
import { lexicon } from '../../plugins/personal-inbox/lexicon.mjs';
const W = lexicon(); // folder names follow config "locale" (zh-CN: the names this file always used)

export const TASK_NAMES = [W.jobNames.daily, W.jobNames.patrol, W.jobNames.deepReview, W.jobNames.weekly];
export const PROBE_AFTER_MIN = 17 * 60 + 30; // 正常状态：17:30 之后才试探（赶在 18:05 日审之前，不是之后）
export const NORMAL_PROBES_PER_DAY = 2;
export const NORMAL_PROBE_GAP_MS = 30 * 60000;
export const PAUSED_PROBE_GAP_MS = 3 * 3600000;
export const PAUSED_PROBES_PER_DAY = 8;
export const PROBE_PROVIDER = 'anthropic-api'; // 试探必须走这条通道才算数；走订阅（provider=anthropic）成功不能当作 API 额度回来了
export const PROBE_PROMPT = '只回复：好';

// 钱用完的说法 vs 临时故障的说法。先判临时（限流／过载／网络），再判钱；两边都没有 → 其他。真实报错原文会记进状态文件，便于事后改。
export const TEMP_RE = /(overload|rate[ _-]?limit|too many requests|\b429\b|\b529\b|timeout|timed out|ETIMEDOUT|ECONN|ENOTFOUND|network|temporarily|unavailable|过载|太快|限流|网络|超时)/i;
export const MONEY_RE = /(credit balance|insufficient[ _-]?(credit|funds|balance)|payment required|purchase credits|plans\s*&\s*billing|billing|余额|信用额度|额度已用完|额度用完|账单)/i;
export function classifyFailure(text) {
  const t = String(text ?? '');
  if (!t.trim()) return '其他';
  if (TEMP_RE.test(t)) return '其他';
  return MONEY_RE.test(t) ? '用完' : '其他';
}

export function paths(dataRoot) {
  const dir = join(dataRoot, W.layout.runLogs, W.layout.runLogDirs.apiQuota);
  return { dir, state: join(dir, '状态.json'), lock: join(dir, '.额度闸.lock') };
}

const trim = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const iso = (ms) => localIso(ms);
const ms = (s) => { const v = Date.parse(s ?? ''); return Number.isFinite(v) ? v : null; };

export function newState({ expiry = null, taskIds = {} } = {}) {
  return {
    当期到期: expiry, 状态: '正常', 暂停原因: null, 暂停时间: null, 上次恢复时间: null,
    暂停区间: [], 简史: [], 试探记录: { 上次时间: null, 上次结果: null, 上次原文: null, 今天: { 日期: null, 次数: 0, 成功: false } },
    任务编号: taskIds, 已提示: {}, 待补动作: null, 待补信息: null, 待补轮数: 0, 暂停前已停用: [], 待发通知: [], 暂停原文: null,
  };
}

function validState(s) {
  if (!s || typeof s !== 'object') return '状态文件不是对象';
  if (!['正常', '已暂停'].includes(s.状态)) return `状态值不认识：${s.状态}`;
  if (!s.任务编号 || typeof s.任务编号 !== 'object') return '缺任务编号';
  for (const n of TASK_NAMES) if (!s.任务编号[n]) return `任务编号里缺“${n}”`;
  return null;
}

// ---------- 官方命令封装 ----------
function listJobs(deps) {
  const r = deps.run(['cron', 'list', '--all', '--json'], { timeout: 90000 });
  if (r.code !== 0) throw new Error(`cron list 失败（退出码 ${r.code}）${r.timedOut ? '，超时' : ''}`);
  const d = parseJsonLoose(r.stdout);
  const jobs = d.jobs ?? d;
  if (!Array.isArray(jobs)) throw new Error('cron list 返回里找不到任务清单');
  return new Map(jobs.map((j) => [j.id, j]));
}
function readEnabled(deps, id) {
  const r = deps.run(['cron', 'get', id, '--json'], { timeout: 60000 });
  if (r.code !== 0) return null;
  try { const j = parseJsonLoose(r.stdout); return typeof j.enabled === 'boolean' ? j.enabled : null; } catch { return null; }
}
// 先不带 --agent 试（本机 2026.10.10 实测带不带都行）；被拒再带上任务自己的 agent 重试，最后读回确认
function setEnabled(deps, job, enable) {
  const flag = enable ? '--enable' : '--disable';
  let r = deps.run(['cron', 'edit', job.id, flag, '--json'], { timeout: 60000 });
  if (r.code !== 0 && job.agentId) r = deps.run(['cron', 'edit', job.id, flag, '--agent', job.agentId, '--json'], { timeout: 60000 });
  return readEnabled(deps, job.id) === enable;
}
function pickModel(jobs, state) {
  const models = TASK_NAMES.map((n) => jobs.get(state.任务编号[n])?.payload?.model).filter((m) => typeof m === 'string' && m.trim());
  return models.find((m) => /sonnet/i.test(m)) ?? models[0] ?? null;
}

// ---------- 通知队列：发成功（拿到回执）才从队列去掉 ----------
function queueNotice(state, key, text) {
  if (state.待发通知.some((n) => n.键 === key)) return;
  state.待发通知.push({ 键: key, 文字: text, 尝试: 0 });
}
async function flushNotices(state, deps) {
  const keep = [];
  for (const n of state.待发通知) {
    const r = await deps.send(n.文字);
    if (r.ok) continue;
    n.尝试 += 1; n.最近错误 = trim(r.error, 120);
    if (n.尝试 >= 5) { deps.warn(`通知“${n.键}”连发 5 次没成功，放弃：${n.最近错误}`); continue; } // 不无限重发
    keep.push(n);
  }
  state.待发通知 = keep;
}

// ---------- 文案（大白话）----------
function pauseText(state, nowMs) {
  const why = state.暂停原因 === '到期' ? `本期额度已到期（${state.当期到期 ? cnDateTime(ms(state.当期到期)) : '到期日'}）` : state.暂停原因 === '手动' ? 'API 额度被手动暂停' : 'API 额度用完了（官方回的是“钱不够”）';
  return `【API 额度】${why}。已暂停日审、巡查、异常深审、周审，不再每天往工坊报失败。\n暂停期间：这四个任务都不跑；挂在日审触发脚本上的每日命令抽查和文件对账也会一起停；没人每天巡检系统，“白天看护”照常跑。备用A、备用B和走订阅的 bot 不受影响。\n恢复办法：额度回来后我会自动试探并恢复；也可以告诉总控“新一期到 X 月 X 日到期”。（${cnDateTime(nowMs)} 记）`;
}
function resumeText(state, nowMs, startMs, why) {
  const days = startMs ? Math.max(0, Math.round((nowMs - startMs) / DAY_MS)) : null;
  const head = why === '手动' ? '已按指令恢复' : '额度回来了，已自动恢复';
  const exp = state.当期到期 ? `新一期记到 ${cnDateTime(ms(state.当期到期))} 到期。` : '请告诉我新一期的到期日（回总控一句“新一期到 X 月 X 日到期”），不然我不知道下次什么时候停。';
  return `【API 额度】${head}日审、巡查、异常深审、周审${days != null ? `（停了约 ${days} 天）` : ''}。${exp}\n提醒：恢复后第一次日审要补审暂停这几天，可能比平时久。`;
}

// ---------- 暂停／恢复动作（可分几轮做完）----------
function startAction(state, action, info, nowMs) {
  state.待补动作 = action; state.待补信息 = info; state.待补轮数 = 0;
  if (action === '停用') { state.暂停前已停用 = []; state.暂停前已记 = false; }
}
function advanceAction(state, deps, nowMs) {
  const action = state.待补动作; if (!action) return;
  const jobs = listJobs(deps);
  const pausing = action === '停用';
  // 暂停前就停着的任务只记一次，并且先写盘再动手：这一轮要是中途被杀，下一轮不会把“我们刚停的”误当成“人停的”（审计 ）
  if (pausing && !state.暂停前已记) {
    state.暂停前已停用 = TASK_NAMES.filter((n) => jobs.get(state.任务编号[n])?.enabled === false);
    state.暂停前已记 = true;
    deps.persist?.(state);
  }
  const failed = [];
  for (const n of TASK_NAMES) {
    const id = state.任务编号[n]; const job = jobs.get(id);
    if (!job) { failed.push(n); continue; }
    if (!pausing && state.暂停前已停用.includes(n)) continue; // 暂停前就是被人停着的，不替人打开
    if (job.enabled === !pausing) continue; // 已经是目标状态
    if (!setEnabled(deps, job, !pausing)) failed.push(n);
  }
  if (failed.length) {
    state.待补轮数 += 1;
    state.已提示 ??= {};
    const verb = pausing ? '没停成' : '没启用成';
    if (state.待补轮数 === 1 && !state.已提示.部分) { state.已提示.部分 = true; queueNotice(state, `部分-${action}`, `【API 额度】${failed.join('、')} ${failed.length} 个${verb}，我会每 30 分钟继续试。`); }
    if (state.待补轮数 >= 3 && !state.已提示.请人看) { state.已提示.请人看 = true; queueNotice(state, `请人看-${action}`, `【API 额度】${failed.join('、')} 连着 3 轮都${verb}，请人看一下（可在终端用 openclaw cron list --all 查）。`); }
    return;
  }
  const info = state.待补信息 ?? {};
  if (pausing) {
    state.状态 = '已暂停'; state.暂停原因 = info.原因; state.暂停时间 = iso(nowMs); state.暂停原文 = info.原文 ?? null;
    state.暂停区间.push({ 开始: iso(nowMs), 结束: null, 原因: info.原因 });
    state.简史.push({ 时间: iso(nowMs), 事件: '暂停', 原因: info.原因 });
    queueNotice(state, `暂停@${iso(nowMs)}`, pauseText(state, nowMs));
  } else {
    const open = [...state.暂停区间].reverse().find((x) => !x.结束);
    const startMs = open ? ms(open.开始) : null;
    if (open) open.结束 = iso(nowMs);
    state.状态 = '正常'; state.上次恢复时间 = iso(nowMs);
    state.当期到期 = info.新到期 ?? null;
    state.暂停原因 = null; state.暂停时间 = null; state.暂停原文 = null;
    state.简史.push({ 时间: iso(nowMs), 事件: '恢复', 原因: info.原因 ?? '自动' });
    queueNotice(state, `恢复@${iso(nowMs)}`, resumeText(state, nowMs, startMs, info.原因));
  }
  state.待补动作 = null; state.待补信息 = null; state.待补轮数 = 0; state.已提示 = {};
}

// ---------- 试探 ----------
async function probe(state, deps, jobs, nowMs) {
  const model = pickModel(jobs, state);
  const rec = state.试探记录;
  const today = localParts(nowMs).date;
  if (rec.今天.日期 !== today) rec.今天 = { 日期: today, 次数: 0, 成功: false };
  rec.今天.次数 += 1; rec.上次时间 = iso(nowMs);
  if (!model) { rec.上次结果 = '没试成'; rec.上次原文 = '四个任务里读不到现行型号'; return { 结果: '其他' }; }
  const r = deps.run(['infer', 'model', 'run', '--model', model, '--prompt', PROBE_PROMPT, '--json'], { timeout: 180000 });
  let d = null; try { d = parseJsonLoose(r.stdout); } catch { /* 没有 JSON：当失败处理 */ }
  if (r.code === 0 && d?.ok === true) {
    if (d.provider === PROBE_PROVIDER && (d.outputs?.[0]?.text ?? '') !== '') { rec.今天.成功 = true; rec.上次结果 = '成功'; rec.上次原文 = null; return { 结果: '成功' }; }
    rec.上次结果 = '通道不对'; rec.上次原文 = trim(`返回的提供商是 ${d.provider ?? '看不出'}，不是 ${PROBE_PROVIDER}，不算数`); return { 结果: '其他' };
  }
  const text = [d?.error?.message, d?.error?.type, r.stderr, r.timedOut ? '超时' : '', r.stdout && !d ? r.stdout : ''].filter(Boolean).join(' ');
  const cls = classifyFailure(text);
  rec.上次结果 = cls === '用完' ? '钱用完' : '失败（非钱）'; rec.上次原文 = trim(text);
  return { 结果: cls, 原文: trim(text) };
}

function probeDue(state, nowMs) {
  const rec = state.试探记录; const today = localParts(nowMs).date;
  const t = rec.今天.日期 === today ? rec.今天 : { 次数: 0, 成功: false };
  const last = ms(rec.上次时间);
  if (state.状态 === '正常') {
    if (localParts(nowMs).minutes < PROBE_AFTER_MIN) return false;
    if (t.成功 || t.次数 >= NORMAL_PROBES_PER_DAY) return false;
    return last == null || nowMs - last >= NORMAL_PROBE_GAP_MS - 60000;
  }
  if (t.次数 >= PAUSED_PROBES_PER_DAY) return false;
  const ref = Math.max(last ?? 0, ms(state.暂停时间) ?? 0);
  return nowMs - ref >= PAUSED_PROBE_GAP_MS - 60000;
}

// 看四个任务最近一次运行：只认“结束时间晚于上次恢复时间”的失败，且报错是钱的说法
function recentMoneyFailure(state, deps, jobs) {
  const since = ms(state.上次恢复时间) ?? 0;
  for (const n of TASK_NAMES) {
    const j = jobs.get(state.任务编号[n]); if (!j) continue;
    if (j.state?.lastRunStatus === 'ok' || !j.state?.lastRunStatus) continue;
    const r = deps.run(['cron', 'runs', j.id, '--json', '--limit', '1'], { timeout: 60000 });
    if (r.code !== 0) continue;
    let e; try { e = (parseJsonLoose(r.stdout).entries ?? [])[0]; } catch { continue; }
    if (!e || e.status === 'ok' || e.action !== 'finished') continue;
    if ((e.ts ?? 0) <= since) continue;
    const text = [e.error, e.summary].filter(Boolean).join(' ');
    if (classifyFailure(text) === '用完') return { 任务: n, 原文: trim(text) };
  }
  return null;
}

// ---------- 一轮 ----------
export async function tickLocked(state, deps) {
  const nowMs = deps.now();
  // 1. 上一轮没做完的停用／启用，先补完（不消耗试探名额）
  if (state.待补动作) advanceAction(state, deps, nowMs);
  if (!state.待补动作) {
    const jobs = listJobs(deps);
    if (state.状态 === '正常') {
      const exp = ms(state.当期到期);
      if (exp != null && nowMs >= exp) { startAction(state, '停用', { 原因: '到期' }, nowMs); advanceAction(state, deps, nowMs); }
      else {
        const f = recentMoneyFailure(state, deps, jobs);
        if (f) { startAction(state, '停用', { 原因: '用完', 原文: `${f.任务}：${f.原文}` }, nowMs); advanceAction(state, deps, nowMs); }
        else if (probeDue(state, nowMs)) {
          const p = await probe(state, deps, jobs, nowMs);
          if (p.结果 === '用完') { startAction(state, '停用', { 原因: '用完', 原文: p.原文 }, nowMs); advanceAction(state, deps, nowMs); }
        }
      }
    } else if (state.暂停原因 !== '手动' && probeDue(state, nowMs)) { // 手动暂停的不自动恢复，只认 --resume（审计 ）
      const p = await probe(state, deps, jobs, nowMs);
      if (p.结果 === '成功') { startAction(state, '启用', { 原因: '自动', 新到期: null }, nowMs); advanceAction(state, deps, nowMs); }
    }
  }
  await flushNotices(state, deps);
  return state;
}

export async function runTick(deps) {
  const p = paths(deps.dataRoot);
  const res = await withLock(p.lock, async () => {
    const state = readJson(p.state, null);
    if (!state) { deps.warn('状态文件还没预置（用 --init 建），本轮不动任何任务'); return; }
    const bad = validState(state); if (bad) { deps.warn(`状态文件有问题：${bad}。本轮不动任何任务`); return; }
    const d2 = { ...deps, persist: (st) => atomicWriteJson(p.state, st) };
    try { await tickLocked(state, d2); } catch (e) { deps.warn(`本轮出错：${e.message}`); }
    atomicWriteJson(p.state, state);
  }, { now: deps.now });
  if (res.busy) deps.warn('上一轮还没跑完（锁在），本轮跳过');
  return res;
}

// ---------- 命令行动作 ----------
export function parseResumeDate(arg, nowMs) {
  if (arg == null) return { ok: true, expiry: null };
  if (!isRealDate(arg)) return { ok: false, error: `日期格式不对：${arg}（要 YYYY-MM-DD，例如 2027-01-06）` };
  const expiry = localIsoAt(arg, EXPIRY_HOUR, 0);
  if (Date.parse(expiry) <= nowMs) return { ok: false, error: `这个日期已经过了：${arg}。新一期到期日要在今天之后` };
  return { ok: true, expiry };
}

export async function cmdResume(deps, arg) {
  const parsed = parseResumeDate(arg, deps.now());
  if (!parsed.ok) { deps.out(parsed.error); return 2; }
  const p = paths(deps.dataRoot);
  const res = await withLock(p.lock, async () => {
    const state = readJson(p.state, null);
    const bad = !state ? '状态文件还没预置' : validState(state);
    if (bad) { deps.out(`不能恢复：${bad}`); return 1; }
    const nowMs = deps.now();
    if (state.状态 === '正常' && !state.待补动作) {
      state.当期到期 = parsed.expiry;
      atomicWriteJson(p.state, state);
      deps.out(parsed.expiry ? `现在本来就是正常运行，已把当期到期日记成 ${cnDateTime(ms(parsed.expiry))}。` : '现在本来就是正常运行，到期日已清空（未知）。');
      return 0;
    }
    if (state.待补动作 !== '启用') startAction(state, '启用', { 原因: '手动', 新到期: parsed.expiry }, nowMs);
    else state.待补信息 = { ...state.待补信息, 新到期: parsed.expiry, 原因: '手动' };
    try { advanceAction(state, deps, nowMs); } catch (e) { deps.out(`恢复没做完：${e.message}。状态已记下，定时任务下一轮会接着做。`); atomicWriteJson(p.state, state); return 1; }
    await flushNotices(state, deps);
    atomicWriteJson(p.state, state);
    deps.out(state.待补动作 ? '有任务没启用成，已记下，定时任务每 30 分钟会接着补。' : `已恢复四个审计任务${parsed.expiry ? `，当期到期日记为 ${cnDateTime(ms(parsed.expiry))}` : '（到期日未知，记得告诉我新一期到期日）'}。`);
    return state.待补动作 ? 1 : 0;
  }, { now: deps.now });
  if (res.busy) { deps.out('额度闸正在跑，请 1 分钟后再试。'); return 1; }
  return res.value ?? 1;
}

export async function cmdPause(deps) {
  const p = paths(deps.dataRoot);
  const res = await withLock(p.lock, async () => {
    const state = readJson(p.state, null);
    const bad = !state ? '状态文件还没预置' : validState(state);
    if (bad) { deps.out(`不能暂停：${bad}`); return 1; }
    if (state.状态 === '已暂停') { deps.out('已经是暂停状态。'); return 0; }
    startAction(state, '停用', { 原因: '手动' }, deps.now());
    try { advanceAction(state, deps, deps.now()); } catch (e) { deps.out(`暂停没做完：${e.message}`); atomicWriteJson(p.state, state); return 1; }
    await flushNotices(state, deps);
    atomicWriteJson(p.state, state);
    deps.out(state.待补动作 ? '有任务没停成，已记下，会继续补。' : '已暂停四个审计任务。');
    return 0;
  }, { now: deps.now });
  if (res.busy) { deps.out('额度闸正在跑，请 1 分钟后再试。'); return 1; }
  return res.value ?? 1;
}

export async function cmdInit(deps, arg, force = false) {
  const p = paths(deps.dataRoot);
  if (readJson(p.state, null) && !force) { deps.out('状态文件已经有了，不覆盖（要重建加 --force）。'); return 1; }
  let expiry = null;
  if (arg) {
    if (isRealDate(arg)) expiry = localIsoAt(arg, EXPIRY_HOUR, 0);
    else if (Number.isFinite(Date.parse(arg)) && /(Z|[+-]\d\d:\d\d)$/.test(arg)) expiry = arg;
    else { deps.out(`到期日格式不对：${arg}`); return 2; }
  }
  const jobs = listJobs(deps);
  const ids = {};
  for (const n of TASK_NAMES) {
    const hits = [...jobs.values()].filter((j) => j.name === n);
    if (hits.length !== 1) { deps.out(`按名字“${n}”找到 ${hits.length} 个任务，不是刚好 1 个，不建状态文件。`); return 1; }
    ids[n] = hits[0].id;
  }
  atomicWriteJson(p.state, newState({ expiry, taskIds: ids }));
  deps.out(`状态文件已建：当期到期 ${expiry ?? '未知'}；任务编号 ${TASK_NAMES.map((n) => `${n}=${ids[n].slice(0, 8)}`).join('、')}。`);
  return 0;
}

export function statusText(state, nowMs) {
  if (!state) return '状态文件还没建。';
  const lines = [`状态：${state.状态}${state.暂停原因 ? `（${state.暂停原因}）` : ''}`, `当期到期：${state.当期到期 ?? '未知'}`];
  if (state.暂停时间) lines.push(`暂停时间：${state.暂停时间}`);
  if (state.上次恢复时间) lines.push(`上次恢复：${state.上次恢复时间}`);
  if (state.待补动作) lines.push(`没做完的动作：${state.待补动作}（已试 ${state.待补轮数} 轮）`);
  const t = state.试探记录; lines.push(`上次试探：${t.上次时间 ?? '没试过'}${t.上次结果 ? `（${t.上次结果}）` : ''}`);
  lines.push(`暂停过 ${state.暂停区间.length} 次`);
  return lines.join('\n');
}

export function realDeps(env = process.env, dataRoot = DEFAULT_DATA_ROOT) {
  const run = realRunner(env);
  return { now: () => Date.now(), run, send: realSend(run), dataRoot, warn: (m) => process.stderr.write(`额度闸：${m}\n`), out: (m) => process.stdout.write(`${m}\n`) };
}

export async function main(argv = process.argv.slice(2), deps = null) {
  const di = argv.indexOf('--data-root');
  const dataRoot = di >= 0 ? argv[di + 1] : (process.env.OPENCLAW_DATA_ROOT || DEFAULT_DATA_ROOT);
  const d = deps ?? realDeps(process.env, dataRoot);
  d.dataRoot = d.dataRoot ?? dataRoot;
  const flagVal = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  if (argv.includes('--status')) { d.out(statusText(readJson(paths(d.dataRoot).state, null), d.now())); return 0; }
  if (argv.includes('--init')) return cmdInit(d, flagVal('--init'), argv.includes('--force'));
  if (argv.includes('--resume')) return cmdResume(d, flagVal('--resume'));
  if (argv.includes('--pause')) return cmdPause(d);
  await runTick(d);
  d.out('NO_REPLY');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().then((c) => process.exit(c)).catch((e) => { process.stderr.write(`额度闸失败：${e.message}\n`); process.exit(1); });
