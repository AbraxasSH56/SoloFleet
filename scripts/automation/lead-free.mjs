#!/usr/bin/env node
// When a project channel is created, lets only its lead bot answer without being mentioned there.
// 新建项目频道时，只给"主责 bot"开免点名。
// 做法：往 openclaw.json 里加一条项目频道项 { enabled:true, requireMention:false, ignoreOtherMentions:true }，用官方 `openclaw config patch`（热生效，不重启）。
// 铁规矩：
//  - 读配置只许用 jq 抽非密钥字段（账号名、enabled、applicationId、defaultAccount、bindings），过滤式里不出现任何密钥字段名；绝不用 `openclaw config get` 读整个 accounts。
//  - 频道必须已经登记在总索引里，且总索引那一行的"主责 bot"和传进来的 --lead 一致；否则拒绝。
//  - 只写这一个频道项这一个值；已经是这个值就什么都不写（重复运行安全）。
//  - 没有"假命令＋假配置"两个替身、而数据根又不是正式目录（或有 NODE_TEST_CONTEXT）时，拒绝运行（给 project-files.mjs 命令行入口用的 skipped 规则在那边）。
// 用法（Node 请用完整路径）：
//   lead-free.mjs ensure  --channel-id <频道编号> --lead <主责显示名>
//   lead-free.mjs check   --channel-id <频道编号> --lead <主责显示名>      只读
//   lead-free.mjs remove  --channel-id <频道编号> --lead <主责显示名>      把那一条设成 null（测试清理、退回用）
//   lead-free.mjs backfill                                                  只读：总索引每个项目行对一遍，列出没开的
// 选项：--config <配置文件>（只给离线测试用，配合环境变量 OPENCLAW_LEAD_FREE_FAKE_CMD）
// 退出码：0 成功／已是目标；1 被拒绝或出错；2 用法错误。
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
import { parseJsonLoose, realRunner } from './gap-common.mjs';
import { readIndex } from '../../plugins/personal-inbox/project-files.mjs';

import { crew } from '../../plugins/personal-inbox/crew-config.mjs';
export const GUILD_ID = crew.guildId;
export const WORKSHOP_ID = crew.channels.workshop;
export const DEFAULT_CONFIG_PATH = `${homedir()}/.openclaw/openclaw.json`;
export const DEFAULT_DATA_ROOT = process.env.OPENCLAW_DATA_ROOT || crew.paths.dataRoot; // env var first, then config
export const ENTRY_VALUE = Object.freeze({ enabled: true, requireMention: false, ignoreOtherMentions: true });

// ---------- 读配置：只抽非密钥字段 ----------
// 过滤式里只有这几个字段名；测试里断言这段文字不含密钥字段名。
export const JQ_SLICE_FILTER = `{
  defaultAccount: (.channels.discord.defaultAccount // null),
  applicationId: (.channels.discord.applicationId // null),
  accounts: ((.channels.discord.accounts // {}) | with_entries(.value |= {name: (.name // null), enabled: .enabled, applicationId: (.applicationId // null)})),
  bindings: [(.bindings // [])[] | {agentId: .agentId, channel: (.match.channel // null), accountId: (.match.accountId // null)}]
}`;
// jq 写全路径：定时任务和总控命令行环境的 PATH 里不一定有 /usr/bin，之前出过"找不到 node"的事。
// 找法：环境变量 OPENCLAW_JQ → /usr/bin/jq → /opt/homebrew/bin/jq → /usr/local/bin/jq → 最后才用名字 jq 靠 PATH。
export function findJq(env = process.env) {
  return [env.OPENCLAW_JQ, '/usr/bin/jq', '/opt/homebrew/bin/jq', '/usr/local/bin/jq'].find((p) => p && existsSync(p)) ?? 'jq';
}
export function jqRun(args, configPath, { jq = findJq(), timeout = 20000 } = {}) {
  const r = spawnSync(jq, ['-c', ...args, configPath], { encoding: 'utf8', timeout });
  if (r.status !== 0) throw new Error(`jq 读配置失败：${(r.stderr || r.error?.message || '').slice(0, 160)}`);
  return JSON.parse(r.stdout);
}
export function readConfigSlice(configPath, opts) { return jqRun([JQ_SLICE_FILTER], configPath, opts); }
// 某账号下这个项目频道现在的那一条（没有就 null）
export function entryPathFilter(account) {
  return account === 'default'
    ? '.channels.discord.guilds[$g].channels[$c] // null'
    : '.channels.discord.accounts[$a].guilds[$g].channels[$c] // null';
}
// 这个账号在这个服务器下有没有自己的通配项（"*"）。没有的话，一旦给它写了某个频道项，官方会把它的频道表当成白名单，它在别的频道就全哑了
export function hasGuildWildcard(configPath, account, opts) {
  const f = account === 'default'
    ? '.channels.discord.guilds[$g].channels["*"] // null'
    : '.channels.discord.accounts[$a].guilds[$g].channels["*"] // null';
  return jqRun(['--arg', 'g', GUILD_ID, '--arg', 'a', account, f], configPath, opts) !== null;
}
export function readChannelEntry(configPath, account, channelId, opts) {
  return jqRun(['--arg', 'g', GUILD_ID, '--arg', 'c', String(channelId), '--arg', 'a', account, entryPathFilter(account)], configPath, opts);
}

// ---------- 角色、账号、显示名、Discord 编号 ----------
// 角色→账号：一律以 bindings 的 agentId ↔ match.accountId ?? defaultAccount ?? 'default' 为准，只认 discord 绑定（照 bot-roster.mjs）
export function roleAccountMap(slice) {
  const map = new Map();
  for (const b of slice?.bindings ?? []) {
    if (!b || b.channel !== 'discord' || !b.agentId) continue;
    map.set(b.agentId, b.accountId ?? slice.defaultAccount ?? 'default');
  }
  return map;
}
// 账号→Discord 编号：账号自己的 applicationId 优先，没有就用顶层的（照 bot-roster.mjs 的继承规则）
export function appIdOfAccount(slice, account) {
  const id = slice?.accounts?.[account]?.applicationId ?? slice?.applicationId ?? null;
  return /^\d{17,20}$/.test(String(id ?? '')) ? String(id) : null;
}
export function roleDiscordId(slice, role) {
  const acct = roleAccountMap(slice).get(role);
  return acct ? appIdOfAccount(slice, acct) : null;
}
// 显示名→账号。总控在配置里没有显示名，补 总控→default；停用（enabled === false）的账号排除
export function accountByDisplayName(slice, display) {
  const want = stripParen(display);
  if (!want) return null;
  if (want === '总控') return 'default';
  for (const [acct, v] of Object.entries(slice?.accounts ?? {})) {
    if (v?.enabled === false) continue;
    if (stripParen(v?.name) === want) return acct;
  }
  return null;
}
// 去掉"（暂代…）"这类括号注释再比较
export function stripParen(s) { return String(s ?? '').replace(/[（(][^）)]*[）)]/g, '').trim(); }

// ---------- ensure / check / remove ----------
function patchFor(account, channelId, value) {
  const chan = { [String(channelId)]: value };
  const guild = { [GUILD_ID]: { channels: chan } };
  return account === 'default'
    ? { channels: { discord: { guilds: guild } } }
    : { channels: { discord: { accounts: { [account]: { guilds: guild } } } } };
}
const sameEntry = (a) => !!a && typeof a === 'object' && a.enabled === true && a.requireMention === false && a.ignoreOtherMentions === true;

function resolveTarget({ channelId, lead, indexPath, configPath, jqOpts }) {
  if (!/^\d{15,}$/.test(String(channelId ?? ''))) return { ok: false, message: '频道编号要是 15 位以上的数字' };
  if (!String(lead ?? '').trim()) return { ok: false, message: '缺少主责 bot' };
  if (String(channelId) === WORKSHOP_ID) return { ok: true, builtin: true };
  const idx = readIndex(indexPath);
  if (!idx.ok) return { ok: false, message: `总索引读不到或读不懂：${idx.message}` };
  const rows = idx.rows.filter((r) => r.channelId === String(channelId));
  if (rows.length !== 1) return { ok: false, message: rows.length === 0 ? `频道 ${channelId} 没有登记在总索引里，不给它开免点名` : `总索引里有 ${rows.length} 行用了频道 ${channelId}，先理清` };
  const indexLead = rows[0].cells?.[2] ?? '';
  if (stripParen(indexLead) !== stripParen(lead)) return { ok: false, message: `总索引里这个项目的主责是“${stripParen(indexLead)}”，不是“${stripParen(lead)}”，不开免点名` };
  let slice;
  try { slice = readConfigSlice(configPath, jqOpts); } catch (e) { return { ok: false, message: e.message }; }
  const account = accountByDisplayName(slice, lead);
  if (!account) return { ok: false, message: `主责 bot“${stripParen(lead)}”认不出（配置里没有叫这个名字的启用账号）` };
  try {
    if (!hasGuildWildcard(configPath, account, jqOpts)) return { ok: false, message: `“${stripParen(lead)}”（${account}）在这个服务器下没有自己的频道设置（通配项），现在给它写频道项会让它在别的频道都不回话，已拒绝；请先让开发会话补上它的频道设置` };
  } catch (e) { return { ok: false, message: e.message }; }
  return { ok: true, account, project: rows[0].name };
}

export function checkLeadFree({ channelId, lead, indexPath, configPath = DEFAULT_CONFIG_PATH, jqOpts }) {
  const t = resolveTarget({ channelId, lead, indexPath, configPath, jqOpts });
  if (!t.ok) return t;
  if (t.builtin) return { ok: true, open: true, message: '工坊本来就是免点名' };
  try {
    const cur = readChannelEntry(configPath, t.account, channelId, jqOpts);
    return { ok: true, open: sameEntry(cur), account: t.account, message: sameEntry(cur) ? '已开着' : '没开' };
  } catch (e) { return { ok: false, message: e.message }; }
}

// run：gap-common.realRunner 返回的函数（带 NODE_BIN 的 PATH）；离线测试换假的
export function ensureLeadFree({ channelId, lead, indexPath, configPath = DEFAULT_CONFIG_PATH, run = realRunner(), jqOpts, timeout = 60000 }) {
  const t = resolveTarget({ channelId, lead, indexPath, configPath, jqOpts });
  if (!t.ok) return t;
  if (t.builtin) return { ok: true, changed: false, message: '工坊本来就是免点名，不用改' };
  let cur;
  try { cur = readChannelEntry(configPath, t.account, channelId, jqOpts); } catch (e) { return { ok: false, message: e.message }; }
  if (sameEntry(cur)) return { ok: true, changed: false, account: t.account, message: `已经开着（${t.account}），没有改` };
  const body = JSON.stringify(patchFor(t.account, channelId, { ...ENTRY_VALUE }));
  const dry = run(['config', 'patch', '--stdin', '--dry-run'], { timeout, input: body });
  if (dry.code !== 0) return { ok: false, message: `官方校验没过（config patch --dry-run 退出码 ${dry.code}）：${(dry.stderr || dry.stdout).slice(0, 200)}` };
  const real = run(['config', 'patch', '--stdin'], { timeout, input: body });
  if (real.code !== 0) return { ok: false, message: `写入失败（config patch 退出码 ${real.code}）：${(real.stderr || real.stdout).slice(0, 200)}` };
  let back;
  try { back = readChannelEntry(configPath, t.account, channelId, jqOpts); } catch (e) { return { ok: false, message: `写完读回失败：${e.message}` }; }
  if (!sameEntry(back)) return { ok: false, message: '写完读回，这一条对不上（可能被别的改动盖掉了或还没生效），没有假装成功' };
  return { ok: true, changed: true, account: t.account, message: `已给“${stripParen(lead)}”（${t.account}）开了这个频道的免点名` };
}

export function removeLeadFree({ channelId, lead, indexPath, configPath = DEFAULT_CONFIG_PATH, run = realRunner(), jqOpts, timeout = 60000 }) {
  // 清理时项目行可能已经从总索引去掉，所以账号直接按显示名查，不要求总索引还在
  if (!/^\d{15,}$/.test(String(channelId ?? ''))) return { ok: false, message: '频道编号要是 15 位以上的数字' };
  if (String(channelId) === WORKSHOP_ID) return { ok: false, message: '工坊的免点名不是本批开的，不动' };
  let slice;
  try { slice = readConfigSlice(configPath, jqOpts); } catch (e) { return { ok: false, message: e.message }; }
  const account = accountByDisplayName(slice, lead);
  if (!account) return { ok: false, message: `主责 bot“${stripParen(lead)}”认不出` };
  let cur;
  try { cur = readChannelEntry(configPath, account, channelId, jqOpts); } catch (e) { return { ok: false, message: e.message }; }
  if (cur === null) return { ok: true, changed: false, account, message: '本来就没有这一条' };
  // 只删“恰好等于本工具写入的值”的那一条；别的频道项（闲聊茶会的自动开线程、日记的免点名等）不是本工具加的，不动
  if (!sameEntry(cur) || Object.keys(cur).sort().join() !== Object.keys(ENTRY_VALUE).sort().join()) return { ok: false, message: '这一条的值不是本工具写入的（不等于“免点名＋忽略别人被点名”那三项），不删，请人工处理' };
  const body = JSON.stringify(patchFor(account, channelId, null));
  const real = run(['config', 'patch', '--stdin'], { timeout, input: body });
  if (real.code !== 0) return { ok: false, message: `删除失败（config patch 退出码 ${real.code}）：${(real.stderr || real.stdout).slice(0, 200)}` };
  let back;
  try { back = readChannelEntry(configPath, account, channelId, jqOpts); } catch (e) { return { ok: false, message: `删完读回失败：${e.message}` }; }
  return back === null ? { ok: true, changed: true, account, message: '已删掉这一条' } : { ok: false, message: '删完读回，这一条还在' };
}

export function backfill({ indexPath, configPath = DEFAULT_CONFIG_PATH, jqOpts }) {
  const idx = readIndex(indexPath);
  if (!idx.ok) return { ok: false, message: idx.message };
  const rows = [];
  for (const r of idx.rows) {
    if (!r.channelId) { rows.push({ project: r.name, status: '总索引没写频道编号，没法查' }); continue; }
    const c = checkLeadFree({ channelId: r.channelId, lead: r.cells?.[2] ?? '', indexPath, configPath, jqOpts });
    rows.push({ project: r.name, channelId: r.channelId, lead: stripParen(r.cells?.[2] ?? ''), status: c.ok ? c.message : `查不了：${c.message}` });
  }
  return { ok: true, rows };
}

// ---------- 能不能真调：给命令行入口用 ----------
// 正式环境：没设 OPENCLAW_DATA_ROOT、也没有 NODE_TEST_CONTEXT（node --test 会设）。
// 否则必须"假命令＋假配置"两个替身都给了才真调；缺一个就跳过。
export function leadFreeMode(env = process.env, fakeConfig = null) {
  const fakeCmd = env.OPENCLAW_LEAD_FREE_FAKE_CMD || null;
  const cfg = fakeConfig ?? env.OPENCLAW_LEAD_FREE_FAKE_CONFIG ?? null;
  if (fakeCmd && cfg) return { run: true, fake: true, fakeCmd, configPath: cfg };
  // 只给了一个替身（只有假命令，或只有假配置）：必须拒绝，绝不退回去改真实配置
  if (fakeCmd || cfg) return { run: false, reason: '假命令和假配置必须同时给，缺一个就拒绝运行（不会退回去碰真实配置）' };
  if (!env.OPENCLAW_DATA_ROOT && !env.NODE_TEST_CONTEXT) return { run: true, fake: false, configPath: DEFAULT_CONFIG_PATH };
  return { run: false, reason: '非正式数据目录或测试环境，没有碰真实配置' };
}
export function runnerFor(mode, env = process.env) {
  return realRunner(mode.fake ? { ...env, OPENCLAW_BIN: mode.fakeCmd } : env);
}

// ---------- 命令行 ----------
function parseArgs(argv) {
  const cmd = argv[0]; const opts = {};
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) return { cmd, error: `看不懂这个参数：${a}` };
    const v = argv[i + 1]; if (v === undefined) return { cmd, error: `参数 ${a} 后面没有值` };
    opts[a.slice(2)] = v; i += 1;
  }
  return { cmd, opts };
}
const out = (o, code = 0) => { process.stdout.write(`${JSON.stringify(o, null, 1)}\n`); return code; };
export function main(argv, env = process.env) {
  const { cmd, opts, error } = parseArgs(argv);
  if (error) return out({ ok: false, message: error }, 2);
  const dataRoot = env.OPENCLAW_DATA_ROOT || DEFAULT_DATA_ROOT;
  const indexPath = join(dataRoot, 'INDEX.md');
  const mode = leadFreeMode(env, opts.config ?? null);
  if (!mode.run) return out({ ok: false, message: `拒绝运行：${mode.reason}。离线测试请同时给 OPENCLAW_LEAD_FREE_FAKE_CMD 和 --config` }, 1);
  const common = { indexPath, configPath: mode.configPath };
  try {
    if (cmd === 'backfill') { const r = backfill(common); return out(r, r.ok ? 0 : 1); }
    if (!['ensure', 'check', 'remove'].includes(cmd)) return out({ ok: false, message: `不认识的命令：${cmd ?? '（没写）'}；可用：ensure、check、remove、backfill` }, 2);
    if (!opts['channel-id'] || !opts.lead) return out({ ok: false, message: '缺少参数：--channel-id、--lead' }, 2);
    const args = { ...common, channelId: opts['channel-id'], lead: opts.lead };
    const r = cmd === 'check' ? checkLeadFree(args) : cmd === 'remove' ? removeLeadFree({ ...args, run: runnerFor(mode, env) }) : ensureLeadFree({ ...args, run: runnerFor(mode, env) });
    return out(r, r.ok ? 0 : 1);
  } catch (e) { return out({ ok: false, message: `内部出错：${String(e?.message ?? e).slice(0, 300)}` }, 1); }
}
function isDirect() {
  const a = process.argv[1];
  if (!a || basename(a) !== 'lead-free.mjs') return false;
  try { return realpathSync(a) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isDirect()) process.exitCode = main(process.argv.slice(2));
export { parseJsonLoose };
