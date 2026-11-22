#!/usr/bin/env node
// Generates the bot ID table the daily audit uses.
// 日审用的 bot 编号表生成脚本。只用 Node 自带库，只读配置。
// 按 Discord 插件同样的账号继承规则取编号：账号自己的 applicationId 优先，没有就用顶层 channels.discord.applicationId；
// 用 bindings 把账号对到角色；有 Discord 账号的是“人设 bot”，没有的（现在只有 system-auditor）列为“系统角色”。
// 生成失败时旧表不覆盖，只把旧表状态改成“过期”并写原因和时间；没有旧表就写一份只有状态“过期”的空表。
// 用法：node bot-roster.mjs [--config <配置文件>] [--out <输出文件>]
// 退出码：0 生成成功（输出 NO_REPLY）；1 生成失败（已标过期，官方失败提醒会发工坊）；2 连输出都写不了。
import { localIso } from '../../plugins/personal-inbox/tz.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { crew } from '../../plugins/personal-inbox/crew-config.mjs';
export const DEFAULT_CONFIG = `${homedir()}/.openclaw/openclaw.json`;
export const DEFAULT_OUT = join(process.env.OPENCLAW_DATA_ROOT || crew.paths.dataRoot, '审计', '日审', 'bot编号表.json');
// 默认账号（总控）在配置里没有自己的显示名，这里补一个；其余角色用账号项里的 name。
const DISPLAY_FALLBACK = { main: '总控' };
const ID_PATTERN = /^\d{17,20}$/;

export function localNow(date = new Date()) {
  return localIso(date.getTime());
}

class Failure extends Error {}

// 纯函数：由配置对象算出名单；失败抛 Failure（原因是大白话）。
export function buildRoster(cfg) {
  const discord = cfg?.channels?.discord;
  if (!discord || typeof discord !== 'object') throw new Failure('配置里没有 channels.discord');
  const accounts = discord.accounts && typeof discord.accounts === 'object' ? discord.accounts : {};
  const topId = discord.applicationId;
  const entries = cfg?.agents?.entries && typeof cfg.agents.entries === 'object' ? cfg.agents.entries : {};

  // 1. 每个启用的账号：合并出编号
  const byAccount = new Map();
  for (const [accountName, acct] of Object.entries(accounts)) {
    if (!acct || typeof acct !== 'object') throw new Failure(`账号 ${accountName} 的设置不是对象`);
    if (acct.enabled === false) continue;
    const own = acct.applicationId;
    const id = own ?? topId;
    const source = own != null ? '账号自己' : '继承顶层';
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Failure(`账号 ${accountName} 合并后没有有效的 Discord 编号（账号自己和顶层都没写对）`);
    byAccount.set(accountName, { accountName, id, source, label: typeof acct.name === 'string' && acct.name ? acct.name : null });
  }
  if (byAccount.size === 0) throw new Failure('配置里没有启用的 Discord 账号');

  // 2. 编号不能重复（例如某账号漏写、继承了顶层的编号）
  const seenId = new Map();
  for (const a of byAccount.values()) {
    if (seenId.has(a.id)) throw new Failure(`账号 ${seenId.get(a.id)} 和 ${a.accountName} 算出同一个 Discord 编号（可能有账号漏写了自己的编号）`);
    seenId.set(a.id, a.accountName);
  }

  // 3. bindings：账号对角色，一对一
  const bindings = Array.isArray(cfg.bindings) ? cfg.bindings.filter((b) => b?.match?.channel === 'discord') : [];
  const accountToRole = new Map();
  const roleToAccount = new Map();
  for (const b of bindings) {
    const role = b.agentId;
    const accountName = b.match.accountId ?? discord.defaultAccount ?? 'default';
    if (typeof role !== 'string' || !role) throw new Failure('bindings 里有一条没有角色编号');
    if (!byAccount.has(accountName)) throw new Failure(`角色 ${role} 对到的账号 ${accountName} 不存在或没启用`);
    if (accountToRole.has(accountName)) throw new Failure(`账号 ${accountName} 同时对到了两个角色（${accountToRole.get(accountName)}、${role}）`);
    if (roleToAccount.has(role)) throw new Failure(`角色 ${role} 对到了两个账号（${roleToAccount.get(role)}、${accountName}）`);
    accountToRole.set(accountName, role);
    roleToAccount.set(role, accountName);
  }
  for (const accountName of byAccount.keys()) {
    if (!accountToRole.has(accountName)) throw new Failure(`账号 ${accountName} 没有对应的角色（bindings 里找不到）`);
  }

  // 4. 输出：人设 bot（有 Discord 账号的）、系统角色（在 agents.entries 里但没有 Discord 账号的）
  const bots = [];
  for (const b of bindings) {
    const role = b.agentId;
    const accountName = b.match.accountId ?? discord.defaultAccount ?? 'default';
    const a = byAccount.get(accountName);
    const entryName = entries[role]?.name;
    const display = a.label ?? DISPLAY_FALLBACK[role] ?? (entryName && entryName !== role ? entryName : role);
    bots.push({ 角色: role, 显示名: display, 账号名: accountName, Discord编号: a.id, 编号来源: a.source });
  }
  const system = Object.keys(entries)
    .filter((role) => !roleToAccount.has(role))
    .map((role) => ({ 角色: role, 说明: '系统角色，无 Discord 账号，不按编号查' }));
  return { 人设bot: bots, 系统角色: system };
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function diffNote(previous, roster) {
  if (!previous || !Array.isArray(previous.人设bot) || previous.状态 !== '有效') return null;
  const before = new Set(previous.人设bot.map((b) => b.角色));
  const after = new Set(roster.人设bot.map((b) => b.角色));
  const added = [...after].filter((r) => !before.has(r));
  const removed = [...before].filter((r) => !after.has(r));
  if (added.length === 0 && removed.length === 0) return null;
  return `名单有变化：多了 ${added.join('、') || '无'}；少了 ${removed.join('、') || '无'}`;
}

// 刷新：成功写新表；失败保留旧表并标过期。返回 { ok, table, reason }。
export function refreshRoster({ configPath = DEFAULT_CONFIG, outPath = DEFAULT_OUT, now = new Date() } = {}) {
  const at = localNow(now);
  let previous = null;
  if (existsSync(outPath)) {
    try { previous = readJson(outPath); } catch { previous = null; }
  }
  try {
    let raw;
    try { raw = readFileSync(configPath); } catch (e) { throw new Failure(`配置读不到（${e.code ?? e.message}）`); }
    let cfg;
    try { cfg = JSON.parse(raw.toString('utf8')); } catch { throw new Failure('配置不是有效的 JSON'); }
    const roster = buildRoster(cfg);
    const table = {
      状态: '有效',
      生成时间: at,
      配置依据: { 文件: configPath.replace(homedir(), '~'), 文件指纹: createHash('sha256').update(raw).digest('hex') },
      说明: '按 Discord 账号继承规则（账号自己的编号优先，没有就用顶层）和 bindings 生成；人设 bot 才有 Discord 编号，系统角色不按编号查。',
      ...roster,
    };
    const note = diffNote(previous, roster);
    if (note) table.名单变化 = note;
    writeAtomic(outPath, JSON.stringify(table, null, 2) + '\n');
    return { ok: true, table };
  } catch (e) {
    if (!(e instanceof Failure)) throw e;
    const reason = e.message;
    const stale = previous && typeof previous === 'object'
      ? { ...previous, 状态: '过期', 过期原因: reason, 过期时间: at }
      : { 状态: '过期', 过期原因: reason, 过期时间: at, 人设bot: [], 系统角色: [] };
    writeAtomic(outPath, JSON.stringify(stale, null, 2) + '\n');
    return { ok: false, table: stale, reason };
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('bot-roster.mjs')) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  try {
    const res = refreshRoster({ configPath: opt('--config', DEFAULT_CONFIG), outPath: opt('--out', DEFAULT_OUT) });
    if (res.ok) {
      console.log('NO_REPLY');
      process.exit(0);
    }
    console.error(`名单核对失败：${res.reason}。已把旧表标为“过期”。`);
    process.exit(1);
  } catch (e) {
    console.error(`名单核对出错，连输出都没写成：${e.message}`);
    process.exit(2);
  }
}
