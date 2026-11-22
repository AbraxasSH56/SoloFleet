#!/usr/bin/env node
// Timed reminders: API quota period ending, login expiry, optional review date. No model calls.
// 日期全部现算（读额度闸状态里的当期到期、问 claude auth status 拿登录到期），不写死。
// 发消息：脚本自己用 openclaw message send 发到工坊，拿到消息编号的回执才记“已发”；发失败下一轮重发（同一条当天最多试 12 次（约 6 小时），免得刷屏）。
// 去重键带周期：<提醒名>@<到期日或年月>，明年／下一期不会被今年的记录挡住。
// 用法：
//   node timed-reminders.mjs                         定时任务入口（输出 NO_REPLY）
//   node timed-reminders.mjs --dry-run [--now <ISO>]  只列出这一刻会发什么，不发、不记（--now 只在干跑时可用，给审计和测试拨时间）
//   node timed-reminders.mjs --init-login <到期ISO>   上线前预置“上次看到的登录到期日”，免得首轮误发“登录已更新”
// 选项：--data-root <资料根>（只给离线测试用）
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DAY_MS, DEFAULT_DATA_ROOT, OWNER_MENTION, addDays, atomicWriteJson, localParts, localDayStart, localIso, cnDate, cnDateTime, join, parseJsonLoose, readJson, realRunner, realSend, withLock } from './gap-common.mjs';

import { crew } from '../../plugins/personal-inbox/crew-config.mjs';
export const DEFAULT_CONFIG = {
  提醒小时: 9, // reminders go out from 09:00 local time (config timezone)
  到期前天数: [7, 1],
  停满天数: 7,
  复议日期: null, // optional review date YYYY-MM-DD; set it in the reminders config file (运行记录/提醒/配置.json)
  登录前天数: [5, 2],
  最多试发: 12, // 每 30 分钟一轮，当天内最多试 12 次（约 6 小时）；提醒只在当天有效，试满就不再试
  登录过期后还提醒天数: 3,
};
export const CLAUDE_BIN = crew.paths.claudeBin || `${homedir()}/.local/bin/claude`; // config paths.claudeBin (default: the usual install location)

export function paths(dataRoot) {
  const dir = join(dataRoot, '运行记录', '提醒');
  return { dir, state: join(dir, '已发.json'), config: join(dir, '配置.json'), lock: join(dir, '.提醒.lock'), gate: join(dataRoot, '运行记录', 'API额度', '状态.json') };
}
const ms = (s) => { const v = Date.parse(s ?? ''); return Number.isFinite(v) ? v : null; };
const dayMinus = (dateStr, n) => addDays(dateStr, -n);
const MENTION = OWNER_MENTION;

// ---------- 问 Claude 登录到期（只取 loggedIn、loginExpiresAt）----------
export function realClaudeStatus() {
  return () => {
    const r = spawnSync(CLAUDE_BIN, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) return { ok: false, error: `claude auth status 退出码 ${r.status ?? '无'}` };
    try {
      const d = parseJsonLoose(r.stdout);
      const exp = d.loginExpiresAt ? Date.parse(d.loginExpiresAt) : null;
      return { ok: true, loggedIn: d.loggedIn === true, expiresAt: Number.isFinite(exp) ? exp : null };
    } catch (e) { return { ok: false, error: `返回格式读不懂：${e.message}` }; }
  };
}

// ---------- 算出这一刻该发哪些（纯函数，离线测试主要测它）----------
export function dueReminders({ nowMs, gate, login, cfg = DEFAULT_CONFIG, status }) {
  const out = [];
  const b = localParts(nowMs); const today = b.date; const after = b.minutes >= cfg.提醒小时 * 60;
  const atHour = (dateStr) => localDayStart(dateStr) + cfg.提醒小时 * 3600000;

  // —— API 额度 ——
  if (gate) {
    const exp = ms(gate.当期到期);
    const paused = gate.状态 === '已暂停';
    const used = paused && gate.暂停原因 === '用完';
    if (exp != null && exp > nowMs) {
      const expDate = localParts(exp).date;
      for (const d of cfg.到期前天数) {
        if (after && today === dayMinus(expDate, d)) {
          const first = `这一期 API 额度 ${cnDateTime(exp)} 到期，还剩 ${d} 天。`;
          let text;
          if (used && d >= 3) text = `【API 额度提醒】${MENTION} 额度已经用完，日审、巡查、异常深审、周审已经停了；${first}请去 Anthropic Console 的 Billing 页看有没有下一期可领。`;
          else if (d >= 3) text = `【API 额度提醒】${MENTION} ${first}请去 Anthropic Console 的 Billing 页看有没有下一期可领；这期用不完的话，可以叫总控调备用A、备用B多用一点。`;
          else if (used) text = `【API 额度提醒】${MENTION} 额度已经用完，日审、巡查、异常深审、周审已经停了；${first}下一期领了吗？领了回总控一句“新一期到 X 月 X 日到期”。`;
          else text = `【API 额度提醒】${MENTION} 明天（${cnDateTime(exp)}）这一期 API 额度到期。领了下一期的话，回总控一句“新一期到 X 月 X 日到期”；没领到的话，到点后四个审计任务会自动暂停。这期还有用不完的额度，可以叫总控今天调备用A、备用B用掉。`;
          out.push({ key: `到期前${d}天@${expDate}`, text });
        }
      }
    }
    if (paused && gate.暂停时间) {
      const t = ms(gate.暂停时间);
      if (t != null && after && today >= localParts(t + cfg.停满天数 * DAY_MS).date) {
        const days = Math.max(cfg.停满天数, Math.round((nowMs - t) / DAY_MS));
        out.push({ key: `停满${cfg.停满天数}天@${localParts(t).date}`, text: `【API 额度提醒】${MENTION} 日审、巡查、异常深审、周审已经停了 ${days} 天（${gate.暂停原因 ?? '额度'}）。下一期领了吗？领了回总控一句“新一期到 X 月 X 日到期”，我就恢复。` });
      }
    }
    if (after && today.endsWith('-01') && (exp == null || exp <= nowMs)) {
      out.push({ key: `月初@${today.slice(0, 7)}`, text: `【API 额度提醒】${MENTION} 我没记着下一期 API 额度的到期日。请去 Console 看一下，回总控一句“新一期到 X 月 X 日到期”。` });
    }
  } else if (after && today.endsWith('-01')) {
    out.push({ key: `月初@${today.slice(0, 7)}`, text: `【API 额度提醒】${MENTION} 我这边读不到额度闸的状态，也就不知道下一期到期日。请去 Console 看一下，回总控一句“新一期到 X 月 X 日到期”。` });
  }

  // —— 复议提醒：不依赖额度闸状态；读不到状态也照发——
  if (after && today === cfg.复议日期) {
    const zones = gate?.暂停区间 ?? [];
    const days = zones.reduce((s, z) => { const a = ms(z.开始); const e = z.结束 ? ms(z.结束) : nowMs; return a != null && e != null ? s + Math.max(0, e - a) : s; }, 0) / DAY_MS;
    const hist = !gate ? '额度闸的记录我这次读不到，审计任务停过几次不清楚。' : zones.length ? `这段时间审计任务共停过 ${zones.length} 次，约 ${Math.round(days)} 天。` : '这段时间审计任务没因额度停过。';
    out.push({ key: `复议@${cfg.复议日期}`, text: `【API 额度·复议】${MENTION} 当初约好这个时候复议，现在该定了：①继续“用完即停” ②改成“用完转订阅” ③撤回订阅，三选一。${hist}用量请再去 Console 看一眼。` });
  }

  // —— Claude 本机登录 ——
  const lg = login ?? {};
  let loginExp = null; let caveat = '';
  if (status?.ok) {
    if (status.loggedIn === false) {
      out.push({ key: `登录已退出@${today}`, text: `【Claude 登录】${MENTION} 本机的 Claude 已经退出登录了。所有走 Claude 订阅的 bot 现在可能都不能回话。重新登录：打开「终端」→ 输入 \`~/.local/bin/claude auth login\` 回车 → 浏览器里按平时登 Claude 的方式登录并同意授权。` });
    } else loginExp = status.expiresAt;
  } else { loginExp = ms(lg.记录到期); caveat = '（按记录的到期日，没能向 Claude 核实）'; }
  if (loginExp != null) {
    const prev = ms(lg.上次看到到期);
    const expIso = new Date(loginExp).toISOString().slice(0, 19) + 'Z';
    if (status?.ok && prev != null && loginExp - prev > 60000) { // 新到期日比记着的晚一分钟以上才算“更新”（官方返回带毫秒，不能直接比）
      out.push({ key: `登录已更新@${expIso}`, text: `【Claude 登录】${MENTION} 登录已更新，新的到期日是 ${cnDateTime(loginExp)}。旧的提醒作废。`, 登录看到: expIso });
    }
    const expDate = localParts(loginExp).date;
    const [d1, d2] = cfg.登录前天数;
    const w1 = atHour(dayMinus(expDate, d1)); const w2 = atHour(dayMinus(expDate, d2));
    const daysLeft = Math.round((localDayStart(expDate) - localDayStart(today)) / DAY_MS);
    const body = (n) => `本机的 Claude 登录 **${cnDateTime(loginExp)}** 到期（还剩 ${n} 天）${caveat}。到期后**所有走 Claude 订阅的 bot 会同时不能回话**（走 API 额度的备用A、备用B和四个审计任务不受这个影响）。重新登录大约 2 分钟：\n1. 打开 Mac 上的「终端」。\n2. 输入 \`~/.local/bin/claude auth login\` 然后回车。（直接敲 \`claude\` 会提示找不到命令。）\n3. 浏览器会自动弹出 Claude 的登录页，按平时登 Claude 的方式登，出现授权就点同意。\n4. 回到终端，看到登录成功就行。\n登完不用做别的：这条提醒下次会自动发现新到期日并停发。`;
    // 和 API 提醒一样：到点（当天 09:00 起）、当天内补发，过了当天作废
    if (nowMs >= w1 && today === dayMinus(expDate, d1) && nowMs < loginExp) out.push({ key: `登录前${d1}天@${expIso}`, text: `【Claude 登录快到期】${MENTION}：${body(daysLeft)}` });
    if (nowMs >= w2 && today === dayMinus(expDate, d2) && nowMs < loginExp) out.push({ key: `登录前${d2}天@${expIso}`, text: `【Claude 登录快到期】${MENTION}：${body(daysLeft)}` });
    if (nowMs >= loginExp && nowMs < loginExp + cfg.登录过期后还提醒天数 * DAY_MS) out.push({ key: `登录已过期@${expIso}`, text: `【Claude 登录已过期】${MENTION} 本机的 Claude 登录已经过期（${cnDateTime(loginExp)}）${caveat}。所有走 Claude 订阅的 bot 现在应该都不能回话。请尽快重新登录：打开「终端」→ 输入 \`~/.local/bin/claude auth login\` 回车 → 浏览器里登录并同意授权。` });
  }
  return out;
}

// ---------- 一轮：算、发、记 ----------
export async function runTick(deps, { dryRun = false } = {}) {
  const p = paths(deps.dataRoot);
  const nowMs = deps.now();
  const body = async () => {
    const cfg = { ...DEFAULT_CONFIG, ...(readJson(p.config, null) ?? {}) };
    let state;
    try { state = readJson(p.state, null); } catch (e) { deps.warn(`已发记录读不了：${e.message}，本轮不发（免得重复）`); return { sent: [], skipped: 'state坏' }; }
    state ??= { 已发: {}, 尝试: {}, 登录: {} };
    state.已发 ??= {}; state.尝试 ??= {}; state.登录 ??= {};
    let gate = null; try { gate = readJson(p.gate, null); } catch (e) { deps.warn(`额度闸状态读不了：${e.message}`); }
    const status = deps.claudeStatus();
    if (!status.ok) deps.warn(`问 Claude 登录状态没成：${status.error}`);
    // 首次看到登录到期日（没预置过）：静默记下，不发“已更新”
    if (status.ok && status.loggedIn && status.expiresAt && !state.登录.上次看到到期) { state.登录.上次看到到期 = new Date(status.expiresAt).toISOString().slice(0, 19) + 'Z'; state.登录.记录到期 = state.登录.上次看到到期; }
    const due = dueReminders({ nowMs, gate, login: state.登录, cfg, status });
    const todo = due.filter((r) => !state.已发[r.key]);
    if (dryRun) return { sent: [], would: todo };
    const sent = [];
    let n = 0;
    for (const r of todo) {
      if ((state.尝试[r.key] ?? 0) >= cfg.最多试发) { deps.warn(`“${r.key}”已试发 ${cfg.最多试发} 次都没成，不再试`); continue; }
      if (n >= 3) break; // 一轮最多 3 条，别一次刷屏
      const res = await deps.send(r.text);
      n += 1;
      if (res.ok) {
        state.已发[r.key] = { 时间: localIso(nowMs), 消息编号: res.id };
        if (r.登录看到) { state.登录.上次看到到期 = r.登录看到; state.登录.记录到期 = r.登录看到; }
        sent.push(r.key);
      } else { state.尝试[r.key] = (state.尝试[r.key] ?? 0) + 1; deps.warn(`“${r.key}”没发出去：${res.error}`); }
      atomicWriteJson(p.state, state); // 每条发完立刻记，崩了也最多重发一条
    }
    // 看到的登录到期日变新但没走“已更新”提醒（比如那条没发成）时不动；只在没有待发更新且到期日一致/更早时同步
    if (status.ok && status.loggedIn && status.expiresAt) {
      const seen = new Date(status.expiresAt).toISOString().slice(0, 19) + 'Z';
      if (seen === state.登录.上次看到到期) { state.登录.上次核实时间 = localIso(nowMs); }
    }
    atomicWriteJson(p.state, state);
    return { sent };
  };
  const res = await withLock(p.lock, body, { now: deps.now });
  if (res.busy) { deps.warn('上一轮还没跑完（锁在），本轮跳过'); return { busy: true, sent: [] }; }
  return res.value;
}

export async function cmdInitLogin(deps, arg) {
  const p = paths(deps.dataRoot);
  const t = Date.parse(arg ?? '');
  if (!Number.isFinite(t) || !/(Z|[+-]\d\d:\d\d)$/.test(arg)) { deps.out(`到期时间格式不对：${arg}（要带时区，如 2031-03-10T00:00:00Z）`); return 2; }
  const res = await withLock(p.lock, async () => {
    const state = readJson(p.state, null) ?? { 已发: {}, 尝试: {}, 登录: {} };
    state.登录 = { ...(state.登录 ?? {}), 上次看到到期: arg, 记录到期: arg };
    atomicWriteJson(p.state, state);
    deps.out(`已预置登录到期日 ${arg}（本地时区 ${cnDateTime(t)}）。`);
    return 0;
  }, { now: deps.now });
  return res.busy ? 1 : res.value;
}

export function realDeps(env = process.env, dataRoot = DEFAULT_DATA_ROOT) {
  const run = realRunner(env);
  return { now: () => Date.now(), send: realSend(run), claudeStatus: realClaudeStatus(), dataRoot, warn: (m) => process.stderr.write(`定点提醒：${m}\n`), out: (m) => process.stdout.write(`${m}\n`) };
}

export async function main(argv = process.argv.slice(2), deps = null) {
  const di = argv.indexOf('--data-root');
  const dataRoot = di >= 0 ? argv[di + 1] : (process.env.OPENCLAW_DATA_ROOT || DEFAULT_DATA_ROOT);
  const d = deps ?? realDeps(process.env, dataRoot);
  d.dataRoot = d.dataRoot ?? dataRoot;
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  if (argv.includes('--init-login')) return cmdInitLogin(d, val('--init-login'));
  const dry = argv.includes('--dry-run');
  if (val('--now') && !dry) { d.out('--now 只能和 --dry-run 一起用（正式运行不许拨时间）。'); return 2; }
  if (dry && val('--now')) { const t = Date.parse(val('--now')); if (!Number.isFinite(t)) { d.out('--now 格式不对'); return 2; } d.now = () => t; }
  const r = await runTick(d, { dryRun: dry });
  if (dry) { d.out(r.would?.length ? r.would.map((x) => `【会发】${x.key}\n${x.text}`).join('\n---\n') : '这一刻没有要发的提醒。'); return 0; }
  d.out('NO_REPLY');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().then((c) => process.exit(c)).catch((e) => { process.stderr.write(`定点提醒失败：${e.message}\n`); process.exit(1); });
