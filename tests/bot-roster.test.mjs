// Offline tests for bot roster: temporary directories and fake data only; nothing touches a real deployment.
// bot 编号表生成脚本离线测试。用当前配置的真实形状（只取非口令字段）。
// 运行：node --test tests/bot-roster.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRoster, refreshRoster } from '../scripts/automation/bot-roster.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/automation/bot-roster.mjs', import.meta.url));
const TOP = '100000000000000011';
const ACCOUNTS = {
  desktop: ['桌面角色', '100000000000000012'], 'worker-e': ['执行者E', '100000000000000107'], 'worker-f': ['执行者F', '100000000000000138'],
  'worker-g': ['执行者D', '100000000000000167'], 'worker-a': ['执行者B', '100000000000000168'], 'worker-b': ['执行者C', '100000000000000169'],
  'worker-d': ['执行者I', '100000000000000170'], 'task-auditor': ['任务审计', '100000000000000013'], diary: ['日记', '100000000000000148'],
};
function realShape() {
  const accounts = { default: { enabled: true, allowBots: true } };
  for (const [k, [name, id]] of Object.entries(ACCOUNTS)) accounts[k] = { name, enabled: true, applicationId: id };
  const bindings = [{ agentId: 'main', match: { channel: 'discord', accountId: 'default' } }, ...Object.keys(ACCOUNTS).map((k) => ({ agentId: k, match: { channel: 'discord', accountId: k } }))];
  const entries = { main: { name: 'main' }, 'system-auditor': {}, desktop: {}, diary: {} };
  for (const k of Object.keys(ACCOUNTS)) entries[k] ??= {};
  return { channels: { discord: { applicationId: TOP, defaultAccount: 'default', accounts } }, bindings, agents: { entries } };
}
const tmp = () => mkdtempSync(join(tmpdir(), 'roster-'));

test('当前配置的真实形状：10 个人设 bot（含总控、执行者B、执行者C、执行者I），system-auditor 列为系统角色', () => {
  const r = buildRoster(realShape());
  assert.equal(r.人设bot.length, 10);
  const main = r.人设bot.find((b) => b.角色 === 'main');
  assert.deepEqual(main, { 角色: 'main', 显示名: '总控', 账号名: 'default', Discord编号: TOP, 编号来源: '继承顶层' });
  for (const [k, [name, id]] of Object.entries(ACCOUNTS)) assert.deepEqual(r.人设bot.find((b) => b.角色 === k), { 角色: k, 显示名: name, 账号名: k, Discord编号: id, 编号来源: '账号自己' });
  assert.deepEqual(r.系统角色.map((s) => s.角色), ['system-auditor']);
});

test('账号漏写编号 → 继承到顶层 → 和总控重复 → 生成失败', () => {
  const cfg = realShape();
  delete cfg.channels.discord.accounts['worker-b'].applicationId;
  assert.throws(() => buildRoster(cfg), /同一个 Discord 编号/);
});

test('合并后没有有效编号、bindings 少一条、一个账号对两个角色、角色对到不存在的账号 → 生成失败', () => {
  let cfg = realShape(); cfg.channels.discord.accounts['worker-b'].applicationId = 'abc'; assert.throws(() => buildRoster(cfg), /没有有效的 Discord 编号/);
  cfg = realShape(); cfg.bindings = cfg.bindings.filter((b) => b.agentId !== 'worker-d'); assert.throws(() => buildRoster(cfg), /没有对应的角色/);
  cfg = realShape(); cfg.bindings.push({ agentId: 'worker-x', match: { channel: 'discord', accountId: 'worker-a' } }); assert.throws(() => buildRoster(cfg), /对到了两个角色/);
  cfg = realShape(); cfg.bindings.push({ agentId: 'worker-d', match: { channel: 'discord', accountId: 'diary' } }); assert.throws(() => buildRoster(cfg), /对到了两个账号|对到了两个角色/);
  cfg = realShape(); cfg.bindings.push({ agentId: 'worker-z', match: { channel: 'discord', accountId: 'nope' } }); assert.throws(() => buildRoster(cfg), /不存在或没启用/);
  cfg = realShape(); delete cfg.channels.discord; assert.throws(() => buildRoster(cfg), /没有 channels\.discord/);
});

test('停用的账号不进名单也不报错', () => {
  const cfg = realShape();
  cfg.channels.discord.accounts['worker-f'].enabled = false;
  cfg.bindings = cfg.bindings.filter((b) => b.agentId !== 'worker-f');
  const r = buildRoster(cfg);
  assert.equal(r.人设bot.length, 9);
  assert.ok(r.系统角色.some((s) => s.角色 === 'worker-f'));
});

test('成功：写出有效表（含生成时间、配置依据、状态）；人设 bot 数变化时写“名单有变化”', () => {
  const dir = tmp();
  try {
    const cfgPath = join(dir, 'c.json'); const out = join(dir, 'out.json');
    writeFileSync(cfgPath, JSON.stringify(realShape()));
    let res = refreshRoster({ configPath: cfgPath, outPath: out, now: new Date('2026-11-11T12:30:00Z') });
    assert.equal(res.ok, true);
    let t = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(t.状态, '有效'); assert.equal(t.生成时间, '2026-11-11T18:00:00+05:30'); assert.match(t.配置依据.文件指纹, /^[0-9a-f]{64}$/);
    assert.equal(t.名单变化, undefined);
    const cfg = realShape(); delete cfg.channels.discord.accounts['worker-f']; cfg.bindings = cfg.bindings.filter((b) => b.agentId !== 'worker-f'); cfg.agents.entries['worker-f'] = {};
    writeFileSync(cfgPath, JSON.stringify(cfg));
    res = refreshRoster({ configPath: cfgPath, outPath: out });
    t = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(res.ok, true); assert.match(t.名单变化, /少了 worker-f/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('配置读不到：旧表不覆盖，只标“过期”并写原因和时间；没有旧表就写空的过期表', () => {
  const dir = tmp();
  try {
    const cfgPath = join(dir, 'c.json'); const out = join(dir, 'out.json');
    let res = refreshRoster({ configPath: join(dir, '没有.json'), outPath: out });
    assert.equal(res.ok, false);
    let t = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(t.状态, '过期'); assert.deepEqual(t.人设bot, []); assert.match(t.过期原因, /配置读不到/);
    writeFileSync(cfgPath, JSON.stringify(realShape()));
    refreshRoster({ configPath: cfgPath, outPath: out });
    const good = JSON.parse(readFileSync(out, 'utf8'));
    writeFileSync(cfgPath, '{坏的');
    res = refreshRoster({ configPath: cfgPath, outPath: out, now: new Date('2026-11-12T04:30:00Z') });
    t = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(res.ok, false); assert.equal(t.状态, '过期'); assert.match(t.过期原因, /不是有效的 JSON/);
    assert.equal(t.过期时间, '2026-11-12T10:00:00+05:30');
    assert.deepEqual(t.人设bot, good.人设bot, '旧名单保留');
    assert.equal(t.生成时间, good.生成时间, '旧的生成时间保留');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('命令行：成功输出 NO_REPLY、退出码 0；失败退出码 1 并在标准错误说原因', () => {
  const dir = tmp();
  try {
    const cfgPath = join(dir, 'c.json'); const out = join(dir, 'out.json');
    writeFileSync(cfgPath, JSON.stringify(realShape()));
    let r = spawnSync(process.execPath, [SCRIPT, '--config', cfgPath, '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'NO_REPLY');
    writeFileSync(cfgPath, '{');
    r = spawnSync(process.execPath, [SCRIPT, '--config', cfgPath, '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /名单核对失败/);
    assert.equal(existsSync(`${out}.tmp-${r.pid}`), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
