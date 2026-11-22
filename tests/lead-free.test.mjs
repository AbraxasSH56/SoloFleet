// Offline tests for lead free: temporary directories and fake data only; nothing touches a real deployment.
// lead-free.mjs 和 project-files.mjs 命令行入口接免点名的离线测试。
// 全部在临时目录里，用"假 openclaw 命令＋假配置文件"，不碰真实 ~/.openclaw/openclaw.json。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  GUILD_ID, JQ_SLICE_FILTER, WORKSHOP_ID, findJq, hasGuildWildcard, accountByDisplayName, appIdOfAccount, backfill, checkLeadFree, ensureLeadFree, entryPathFilter,
  leadFreeMode, main, readConfigSlice, removeLeadFree, roleAccountMap, roleDiscordId, stripParen,
} from '../scripts/automation/lead-free.mjs';
import { realRunner } from '../scripts/automation/gap-common.mjs';

const NODE = process.execPath;
const CLI = fileURLToPath(new URL('../scripts/automation/project-files.mjs', import.meta.url));
const LEAD_CLI = fileURLToPath(new URL('../scripts/automation/lead-free.mjs', import.meta.url));
const CH_A = '100000000000000123';
const CH_B = '100000000000000124';
const SECRET = 'SECRET-TOKEN-VALUE-DO-NOT-LEAK';

const baseConfig = () => ({
  channels: { discord: {
    defaultAccount: 'default', applicationId: '100000000000000011', token: SECRET,
    guilds: { [GUILD_ID]: { channels: { '*': { enabled: true, requireMention: true }, [WORKSHOP_ID]: { enabled: true, requireMention: false } } } },
    accounts: {
      default: { allowBots: 'mentions', enabled: true },
      'worker-e': { name: '执行者E', enabled: true, applicationId: '100000000000000107', token: SECRET, guilds: { [GUILD_ID]: { channels: { '*': { enabled: true, requireMention: true } } } } },
      'task-worker-c': { name: '执行者D', enabled: true, applicationId: '100000000000000108', token: SECRET },
      'worker-x': { name: '停用的', enabled: false, applicationId: '100000000000000125', token: SECRET },
    },
  } },
  bindings: [
    { agentId: 'main', match: { channel: 'discord', accountId: 'default' } },
    { agentId: 'worker-e', match: { channel: 'discord', accountId: 'worker-e' } },
    { agentId: 'worker-c', match: { channel: 'discord', accountId: 'task-worker-c' } },
    { agentId: 'noacct', match: { channel: 'discord' } },
    { agentId: 'tg', match: { channel: 'telegram', accountId: 'zzz' } },
  ],
});

const INDEX = (rows) => `# 统一资料入口\n\n| 项目 | Discord 频道 | 主责 bot | 当前入口 | 主档与成果位置 |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n其他文字\n`;
const row = (name, ch, lead) => `| ${name} | 频道${name}（编号 ${ch}） | ${lead} | [项目入口](项目/${name}/PROJECT.md) | x |`;

// 假 openclaw：config patch --stdin [--dry-run] → 合并进 FAKE_CFG（null 删除），每次调用记到 FAKE_LOG；FAKE_FAIL=dry|real 让对应一步失败；FAKE_NOOP=1 成功但不写
const FAKE = `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const a = process.argv.slice(2);
const log = process.env.FAKE_LOG; if (log) appendFileSync(log, JSON.stringify(a) + '\\n');
if (a[0] === 'config' && a[1] === 'patch') {
  const dry = a.includes('--dry-run');
  if (process.env.FAKE_FAIL === (dry ? 'dry' : 'real')) { console.error('假失败'); process.exit(1); }
  const patch = JSON.parse(readFileSync(0, 'utf8'));
  if (dry || process.env.FAKE_NOOP) process.exit(0);
  const cfg = JSON.parse(readFileSync(process.env.FAKE_CFG, 'utf8'));
  const merge = (t, p) => { for (const [k, v] of Object.entries(p)) { if (v === null) delete t[k]; else if (v && typeof v === 'object' && !Array.isArray(v)) { t[k] = (t[k] && typeof t[k] === 'object') ? t[k] : {}; merge(t[k], v); } else t[k] = v; } };
  merge(cfg, patch); writeFileSync(process.env.FAKE_CFG, JSON.stringify(cfg, null, 2)); process.exit(0);
}
console.error('假命令不认识：' + a.join(' ')); process.exit(3);
`;
function setup(rows = [row('项目A', CH_A, '执行者E'), row('项目B', CH_B, '总控（暂代）')]) {
  const dir = mkdtempSync(join(tmpdir(), 'lf-'));
  const cfg = join(dir, 'openclaw.json'); writeFileSync(cfg, JSON.stringify(baseConfig(), null, 2));
  const idx = join(dir, 'INDEX.md'); writeFileSync(idx, INDEX(rows));
  const fake = join(dir, 'fake-openclaw'); writeFileSync(fake, FAKE); chmodSync(fake, 0o755);
  const log = join(dir, 'calls.log');
  const env = { ...process.env, OPENCLAW_BIN: fake, FAKE_CFG: cfg, FAKE_LOG: log };
  return { dir, cfg, idx, fake, log, env, run: realRunner(env), calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []), read: () => JSON.parse(readFileSync(cfg, 'utf8')) };
}

test('过滤式里没有任何密钥字段名；抽出来的内容里没有密钥值', () => {
  assert.ok(!/token|secret|password|apikey/i.test(JQ_SLICE_FILTER));
  assert.ok(!/token|secret|password|apikey/i.test(entryPathFilter('default') + entryPathFilter('worker-e')));
  const s = setup();
  const slice = readConfigSlice(s.cfg);
  assert.ok(!JSON.stringify(slice).includes(SECRET));
  assert.deepEqual(Object.keys(slice).sort(), ['accounts', 'applicationId', 'bindings', 'defaultAccount']);
  assert.deepEqual(Object.keys(slice.accounts['worker-e']).sort(), ['applicationId', 'enabled', 'name']);
});

test('角色→账号以 bindings 为准：worker-c→task-worker-c、main→default、没写账号用 defaultAccount、非 discord 绑定不算', () => {
  const slice = readConfigSlice(setup().cfg);
  const m = roleAccountMap(slice);
  assert.equal(m.get('worker-c'), 'task-worker-c');
  assert.equal(m.get('main'), 'default');
  assert.equal(m.get('noacct'), 'default');
  assert.equal(m.has('tg'), false);
  assert.equal(m.get('worker-e'), 'worker-e');
});

test('Discord 编号：账号自己的优先，没有就用顶层的', () => {
  const slice = readConfigSlice(setup().cfg);
  assert.equal(appIdOfAccount(slice, 'worker-e'), '100000000000000107');
  assert.equal(appIdOfAccount(slice, 'default'), '100000000000000011');
  assert.equal(roleDiscordId(slice, 'worker-c'), '100000000000000108');
  assert.equal(roleDiscordId(slice, 'main'), '100000000000000011');
  assert.equal(roleDiscordId(slice, '不存在'), null);
});

test('显示名→账号：总控→default、执行者E→worker-e、括号注释去掉、停用账号和乱名字认不出', () => {
  const slice = readConfigSlice(setup().cfg);
  assert.equal(accountByDisplayName(slice, '总控'), 'default');
  assert.equal(accountByDisplayName(slice, '总控（暂代；建项目频道时再定）'), 'default');
  assert.equal(accountByDisplayName(slice, '执行者E'), 'worker-e');
  assert.equal(accountByDisplayName(slice, '执行者D'), 'task-worker-c');
  assert.equal(accountByDisplayName(slice, '停用的'), null);
  assert.equal(accountByDisplayName(slice, '乱写的'), null);
  assert.equal(stripParen('总控（暂代）'), '总控');
});

test('ensure：主责是别的 bot → 写在账号下；读回对；再跑一次什么都不写', () => {
  const s = setup();
  const r = ensureLeadFree({ channelId: CH_A, lead: '执行者E', indexPath: s.idx, configPath: s.cfg, run: s.run });
  assert.equal(r.ok, true, r.message); assert.equal(r.changed, true); assert.equal(r.account, 'worker-e');
  const e = s.read().channels.discord.accounts['worker-e'].guilds[GUILD_ID].channels[CH_A];
  assert.deepEqual(e, { enabled: true, requireMention: false, ignoreOtherMentions: true });
  assert.equal(s.read().channels.discord.guilds[GUILD_ID].channels[CH_A], undefined); // 顶层没动
  assert.equal(s.read().channels.discord.accounts['worker-e'].guilds[GUILD_ID].channels['*'].requireMention, true); // 通配没动
  const before = s.calls().length;
  const r2 = ensureLeadFree({ channelId: CH_A, lead: '执行者E', indexPath: s.idx, configPath: s.cfg, run: s.run });
  assert.equal(r2.ok, true); assert.equal(r2.changed, false);
  assert.equal(s.calls().length, before, '已经开着就不再调官方命令');
  // 先 dry-run 再真写
  assert.deepEqual(s.calls().map((c) => c.includes('--dry-run')), [true, false]);
});

test('ensure：主责是总控 → 写在顶层；别的账号一个字没动', () => {
  const s = setup();
  const before = JSON.stringify(s.read().channels.discord.accounts);
  const r = ensureLeadFree({ channelId: CH_B, lead: '总控', indexPath: s.idx, configPath: s.cfg, run: s.run });
  assert.equal(r.ok, true, r.message); assert.equal(r.account, 'default');
  assert.deepEqual(s.read().channels.discord.guilds[GUILD_ID].channels[CH_B], { enabled: true, requireMention: false, ignoreOtherMentions: true });
  assert.equal(JSON.stringify(s.read().channels.discord.accounts), before);
});

test('ensure：拒绝——频道没登记、主责对不上、主责认不出、工坊不动、坏频道编号', () => {
  const s = setup([row('项目A', CH_A, '执行者E'), row('项目C', '100000000000000126', '乱写的')]);
  const go = (channelId, lead) => ensureLeadFree({ channelId, lead, indexPath: s.idx, configPath: s.cfg, run: s.run });
  assert.match(go('100000000000000127', '执行者E').message, /没有登记在总索引/);
  assert.match(go(CH_A, '总控').message, /主责是“执行者E”，不是“总控”/);
  assert.match(go('100000000000000126', '乱写的').message, /认不出/);
  assert.equal(go(WORKSHOP_ID, '总控').changed, false);
  assert.match(go('12', '执行者E').message, /15 位/);
  assert.equal(s.calls().length, 0, '被拒绝时一次官方命令都没调');
});

test('ensure：dry-run 失败不真写；真写失败报错；读回对不上不假装成功', () => {
  let s = setup();
  s.env.FAKE_FAIL = 'dry';
  let r = ensureLeadFree({ channelId: CH_A, lead: '执行者E', indexPath: s.idx, configPath: s.cfg, run: realRunner(s.env) });
  assert.equal(r.ok, false); assert.match(r.message, /校验没过/); assert.equal(s.calls().length, 1);
  s = setup(); s.env.FAKE_FAIL = 'real';
  r = ensureLeadFree({ channelId: CH_A, lead: '执行者E', indexPath: s.idx, configPath: s.cfg, run: realRunner(s.env) });
  assert.equal(r.ok, false); assert.match(r.message, /写入失败/);
  s = setup(); s.env.FAKE_NOOP = '1';
  r = ensureLeadFree({ channelId: CH_A, lead: '执行者E', indexPath: s.idx, configPath: s.cfg, run: realRunner(s.env) });
  assert.equal(r.ok, false); assert.match(r.message, /对不上/);
});

test('check／remove／backfill', () => {
  const s = setup();
  assert.equal(checkLeadFree({ channelId: CH_A, lead: '执行者E', indexPath: s.idx, configPath: s.cfg }).open, false);
  ensureLeadFree({ channelId: CH_A, lead: '执行者E', indexPath: s.idx, configPath: s.cfg, run: s.run });
  assert.equal(checkLeadFree({ channelId: CH_A, lead: '执行者E', indexPath: s.idx, configPath: s.cfg }).open, true);
  const bf = backfill({ indexPath: s.idx, configPath: s.cfg });
  assert.equal(bf.rows.find((x) => x.project === '项目A').status, '已开着');
  assert.equal(bf.rows.find((x) => x.project === '项目B').status, '没开');
  const rm = removeLeadFree({ channelId: CH_A, lead: '执行者E', indexPath: s.idx, configPath: s.cfg, run: s.run });
  assert.equal(rm.ok, true, rm.message); assert.equal(rm.changed, true);
  assert.equal(s.read().channels.discord.accounts['worker-e'].guilds[GUILD_ID].channels[CH_A], undefined);
  assert.equal(removeLeadFree({ channelId: CH_A, lead: '执行者E', indexPath: s.idx, configPath: s.cfg, run: s.run }).changed, false);
  assert.match(removeLeadFree({ channelId: WORKSHOP_ID, lead: '总控', indexPath: s.idx, configPath: s.cfg, run: s.run }).message, /不动/);
});

test('leadFreeMode：正式环境才真调；测试环境／换数据根默认跳过；假命令＋假配置缺一个也跳过', () => {
  assert.equal(leadFreeMode({}).run, true);
  assert.equal(leadFreeMode({ OPENCLAW_DATA_ROOT: '/tmp/x' }).run, false);
  assert.equal(leadFreeMode({ NODE_TEST_CONTEXT: 'child-v8' }).run, false);
  assert.equal(leadFreeMode({ OPENCLAW_DATA_ROOT: '/tmp/x', OPENCLAW_LEAD_FREE_FAKE_CMD: '/x' }).run, false, '只有假命令不行');
  assert.equal(leadFreeMode({ OPENCLAW_DATA_ROOT: '/tmp/x', OPENCLAW_LEAD_FREE_FAKE_CONFIG: '/y' }).run, false, '只有假配置不行');
  const m = leadFreeMode({ OPENCLAW_DATA_ROOT: '/tmp/x', OPENCLAW_LEAD_FREE_FAKE_CMD: '/x', OPENCLAW_LEAD_FREE_FAKE_CONFIG: '/y' });
  assert.equal(m.run, true); assert.equal(m.fake, true); assert.equal(m.configPath, '/y');
  assert.equal(leadFreeMode({ NODE_TEST_CONTEXT: '1', OPENCLAW_LEAD_FREE_FAKE_CMD: '/x' }, '/y').run, true, '--config 也算假配置');
});

// ---------- 命令行 ----------
function cli(script, args, env) { const r = spawnSync(NODE, [script, ...args], { encoding: 'utf8', env }); let j = null; try { j = JSON.parse(r.stdout); } catch { /* 不是 JSON */ } return { code: r.status, j, raw: r.stdout + r.stderr }; }
// 子进程的环境：去掉 NODE_TEST_CONTEXT 以外的无关变量没必要；但 node --test 会给子进程设 NODE_TEST_CONTEXT，这里保留它来证明双保险
const childEnv = (s, extra = {}) => ({ ...s.env, OPENCLAW_DATA_ROOT: s.dir, ...extra });

test('lead-free 命令行：测试环境里没给替身就拒绝运行', () => {
  const s = setup();
  const r = cli(LEAD_CLI, ['ensure', '--channel-id', CH_A, '--lead', '执行者E'], childEnv(s));
  assert.equal(r.code, 1); assert.match(r.j.message, /拒绝运行/);
  assert.equal(s.read().channels.discord.accounts['worker-e'].guilds[GUILD_ID].channels[CH_A], undefined);
  assert.equal(s.calls().length, 0);
});
test('lead-free 命令行：假命令＋--config 都给了才真调', () => {
  const s = setup();
  const r = cli(LEAD_CLI, ['ensure', '--channel-id', CH_A, '--lead', '执行者E', '--config', s.cfg], childEnv(s, { OPENCLAW_LEAD_FREE_FAKE_CMD: s.fake }));
  assert.equal(r.code, 0, r.raw); assert.equal(r.j.changed, true);
  const bf = cli(LEAD_CLI, ['backfill', '--config', s.cfg], childEnv(s, { OPENCLAW_LEAD_FREE_FAKE_CMD: s.fake }));
  assert.equal(bf.code, 0); assert.equal(bf.j.rows.length, 2);
  assert.equal(cli(LEAD_CLI, ['ensure', '--lead', '执行者E', '--config', s.cfg], childEnv(s, { OPENCLAW_LEAD_FREE_FAKE_CMD: s.fake })).code, 2);
});

const NEWP = (ch, lead = '执行者E') => ['new-project', '--name', '新测试项目', '--channel-id', ch, '--channel-name', '新测试频道', '--lead', lead, '--goal', '试一试'];
function withTemplate(s) {
  mkdirSync(join(s.dir, '模板'), { recursive: true });
  const real = '/opt/solofleet-data/模板/项目入口.md';
  writeFileSync(join(s.dir, '模板', '项目入口.md'), existsSync(real) ? readFileSync(real, 'utf8') : '# {{项目名}}\n目标：{{一句话目标}}\n频道：{{频道}}\n主责：{{主责bot}}\n日期：{{日期}}\n');
}
test('project-files 命令行 new-project：只换了数据根（没给替身）→ skipped:true，不碰任何配置、不调官方命令', () => {
  const s = setup([]); withTemplate(s);
  const r = cli(CLI, NEWP('100000000000000128'), childEnv(s));
  assert.equal(r.code, 0, r.raw); assert.equal(r.j.ok, true);
  assert.equal(r.j.leadFree.skipped, true); assert.match(r.j.leadFree.reason, /没有碰真实配置/);
  assert.equal(s.calls().length, 0);
  assert.equal(JSON.stringify(s.read()), JSON.stringify(baseConfig()));
});
test('project-files 命令行 new-project：只给假命令没给假配置 → 仍然跳过', () => {
  const s = setup([]); withTemplate(s);
  const r = cli(CLI, NEWP('100000000000000129'), childEnv(s, { OPENCLAW_LEAD_FREE_FAKE_CMD: s.fake }));
  assert.equal(r.j.leadFree.skipped, true); assert.equal(s.calls().length, 0);
});
test('project-files 命令行 new-project：假命令＋假配置都给了 → 建好项目并给主责开免点名；再跑一次（已存在）也不出事', () => {
  const s = setup([]); withTemplate(s);
  const env = childEnv(s, { OPENCLAW_LEAD_FREE_FAKE_CMD: s.fake, OPENCLAW_LEAD_FREE_FAKE_CONFIG: s.cfg });
  const r = cli(CLI, NEWP('100000000000000130'), env);
  assert.equal(r.code, 0, r.raw); assert.equal(r.j.existed, false);
  assert.equal(r.j.leadFree.ok, true, JSON.stringify(r.j.leadFree)); assert.equal(r.j.leadFree.changed, true);
  assert.equal(s.read().channels.discord.accounts['worker-e'].guilds[GUILD_ID].channels['100000000000000130'].requireMention, false);
  const r2 = cli(CLI, NEWP('100000000000000130'), env);
  assert.equal(r2.j.existed, true); assert.equal(r2.j.leadFree.ok, true); assert.equal(r2.j.leadFree.changed, false);
});
test('project-files 命令行 new-project：免点名失败（认不出主责）→ 项目照建，输出带警告，退出码仍是 0', () => {
  const s = setup([]); withTemplate(s);
  const env = childEnv(s, { OPENCLAW_LEAD_FREE_FAKE_CMD: s.fake, OPENCLAW_LEAD_FREE_FAKE_CONFIG: s.cfg });
  const r = cli(CLI, NEWP('100000000000000131', '乱写的'), env);
  assert.equal(r.code, 0); assert.equal(r.j.ok, true);
  assert.equal(r.j.leadFree.ok, false); assert.match(r.j.leadFree.message, /免点名没开成/);
  assert.ok(existsSync(join(s.dir, '项目', '新测试项目', 'PROJECT.md')));
});


// ---------- additional cases ----------
test('A4：只给一个替身开关时必须拒绝运行，绝不退回真实配置（含"没设数据根也没设测试环境"的普通终端情形）', () => {
  const only = (env, cfg) => leadFreeMode(env, cfg);
  let m = only({}, '/tmp/假配置.json'); assert.equal(m.run, false); assert.match(m.reason, /必须同时给/); assert.equal(m.configPath, undefined);
  m = only({ OPENCLAW_LEAD_FREE_FAKE_CMD: '/x' }); assert.equal(m.run, false); assert.match(m.reason, /必须同时给/);
  m = only({ OPENCLAW_LEAD_FREE_FAKE_CONFIG: '/y' }); assert.equal(m.run, false);
  assert.equal(only({}).run, true, '什么替身都没给、又是正式环境，才走真实配置');
  const s = setup();
  const r = cli(LEAD_CLI, ['ensure', '--channel-id', CH_A, '--lead', '执行者E', '--config', s.cfg], { ...s.env, OPENCLAW_DATA_ROOT: '', NODE_TEST_CONTEXT: '' });
  assert.equal(r.code, 1); assert.match(r.j.message, /拒绝运行/); assert.equal(s.calls().length, 0);
});
test('B3：主责账号在这个服务器下没有自己的通配项 → 拒绝并报出来，不写', () => {
  const s = setup([row('项目A', CH_A, '执行者E'), row('项目C', '100000000000000126', '执行者D')]);
  assert.equal(hasGuildWildcard(s.cfg, 'worker-e'), true); assert.equal(hasGuildWildcard(s.cfg, 'task-worker-c'), false); assert.equal(hasGuildWildcard(s.cfg, 'default'), true);
  const r = ensureLeadFree({ channelId: '100000000000000126', lead: '执行者D', indexPath: s.idx, configPath: s.cfg, run: s.run });
  assert.equal(r.ok, false); assert.match(r.message, /没有自己的频道设置/); assert.equal(s.calls().length, 0);
  assert.equal(s.read().channels.discord.accounts['task-worker-c'].guilds, undefined);
});
test('B5：remove 只删本工具写的值；别的频道项（日记的免点名、闲聊的自动开线程）不动', () => {
  const s = setup();
  const cfg = s.read();
  cfg.channels.discord.accounts['worker-e'].guilds[GUILD_ID].channels['100000000000000132'] = { enabled: true, requireMention: false }; // 像日记那样的项
  cfg.channels.discord.accounts['worker-e'].guilds[GUILD_ID].channels['100000000000000005'] = { enabled: true, requireMention: true, ignoreOtherMentions: true, autoThread: true };
  writeFileSync(s.cfg, JSON.stringify(cfg));
  for (const ch of ['100000000000000132', '100000000000000005']) {
    const r = removeLeadFree({ channelId: ch, lead: '执行者E', indexPath: s.idx, configPath: s.cfg, run: s.run });
    assert.equal(r.ok, false, ch); assert.match(r.message, /不是本工具写入的/);
  }
  assert.equal(s.calls().length, 0);
  ensureLeadFree({ channelId: CH_A, lead: '执行者E', indexPath: s.idx, configPath: s.cfg, run: s.run });
  assert.equal(removeLeadFree({ channelId: CH_A, lead: '执行者E', indexPath: s.idx, configPath: s.cfg, run: s.run }).changed, true, '本工具写的那一条能删');
});
test('jq 写全路径：优先 /usr/bin/jq，环境变量可覆盖，找不到才回退名字', () => {
  assert.equal(findJq({ OPENCLAW_JQ: '/usr/bin/jq' }), '/usr/bin/jq');
  assert.ok(findJq({}).endsWith('jq'));
  assert.equal(findJq({ OPENCLAW_JQ: '/不存在/jq' }) === '/不存在/jq', false);
});
