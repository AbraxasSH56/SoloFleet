// Offline tests for ledger watch: temporary directories and fake data only; nothing touches a real deployment.
// 假时钟、假的“叫醒”和“发消息”；全部在临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { statSync, mkdirSync as mkdir2 } from 'node:fs';
import { cmdAdd, cmdDone, cmdList, cmdVoid, commitLedger, commitMessage, main, paths, realDeps, runCheck, wakeMessage } from '../scripts/automation/ledger-watch.mjs';

const T = (s) => Date.parse(s);
const H = 3600000;

function mk(now = '2026-11-22T17:20:00+05:30') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'led-'));
  const st = { clock: T(now), woke: [], sent: [], wakeOk: true, sendOk: true, out: [], warns: [] };
  const deps = {
    dataRoot, now: () => st.clock,
    async wake(msg) { st.woke.push(msg); return st.wakeOk ? { ok: true, jobId: `j${st.woke.length}` } : { ok: false, error: '假失败' }; },
    async send(text) { st.sent.push(text); return st.sendOk ? { ok: true, id: 'm' } : { ok: false, error: '假失败' }; },
    out: (m) => st.out.push(m), warn: (m) => st.warns.push(m),
  };
  const p = paths(dataRoot);
  const data = () => JSON.parse(readFileSync(p.data, 'utf8'));
  const at = (s) => { st.clock = T(s); };
  const add = (title = '示例', extra = {}) => cmdAdd(deps, { 日期: '2026-11-22', 标题: title, 原话: `原话：${title}`, 行号: 'record L100', ...extra });
  return { st, deps, p, data, at, add, check: () => runCheck(deps) };
}

test('add：登记一条，状态“待补”，同时生成待补清单.md；重复登记同一条不重复', async () => {
  const e = mk();
  assert.equal(await e.add('A'), 0);
  assert.equal(e.data().条目.length, 1); assert.equal(e.data().条目[0].状态, '待补');
  assert.match(readFileSync(e.p.view, 'utf8'), /待补 1：A/); assert.match(readFileSync(e.p.view, 'utf8'), /主人原话：原话：A/);
  assert.equal(await e.add('A'), 0); assert.equal(e.data().条目.length, 1, '重复不增');
  assert.match(e.st.out.at(-1), /已经登记过了/);
  assert.equal(await e.add('B'), 0); assert.equal(e.data().条目[1].编号, 2);
});

test('add：日期不对／缺标题／缺原话 → 拒绝，不写文件', async () => {
  const e = mk();
  assert.equal(await cmdAdd(e.deps, { 日期: '11月22日', 标题: 'x', 原话: 'y' }), 2);
  assert.equal(await cmdAdd(e.deps, { 日期: '2026-11-22', 标题: ' ', 原话: 'y' }), 2);
  assert.equal(await cmdAdd(e.deps, { 日期: '2026-11-22', 标题: 'x', 原话: '' }), 2);
  assert.equal(existsSync(e.p.data), false);
});

test('done：标已入账、记账本编号；可重复执行不出错；不存在的编号／格式不对 → 报错不改', async () => {
  const e = mk(); await e.add('A');
  assert.equal(await cmdDone(e.deps, '1', 'D-052'), 0);
  assert.equal(e.data().条目[0].状态, '已入账'); assert.equal(e.data().条目[0].账本编号, 'D-052');
  assert.equal(await cmdDone(e.deps, '1', 'D-052'), 0, '重复执行不出错');
  assert.match(e.st.out.at(-1), /早就标过/);
  assert.equal(await cmdDone(e.deps, '9', 'D-053'), 1);
  assert.equal(await cmdDone(e.deps, '1', '052'), 2);
  assert.equal(await cmdDone(e.deps, 'x', 'D-052'), 2);
  assert.match(readFileSync(e.p.view, 'utf8'), /1 A → D-052/);
});

test('list：默认只列待补；--all lists everything；空的时候说一句', async () => {
  const e = mk();
  await cmdList(e.deps); assert.equal(e.st.out.at(-1), '没有待补的。');
  await e.add('A'); await e.add('B'); await cmdDone(e.deps, '1', 'D-052');
  e.st.out.length = 0; await cmdList(e.deps); assert.equal(e.st.out.length, 1); assert.match(e.st.out[0], /B/);
  e.st.out.length = 0; await cmdList(e.deps, true); assert.equal(e.st.out.length, 2);
});

test('void：只有测试条目能作废；作废后不再算待补', async () => {
  const e = mk(); await e.add('正式'); await e.add('测', { 测试: true });
  assert.equal(await cmdVoid(e.deps, '1'), 1, '正式条目不能作废');
  assert.equal(await cmdVoid(e.deps, '2'), 0);
  assert.equal(e.data().条目[1].状态, '测试作废');
  assert.equal(await cmdVoid(e.deps, '2'), 0, '重复执行不出错');
});

test('检查：没有待补／没有数据文件 → 静默，不叫醒不发消息', async () => {
  const e = mk();
  await e.check(); assert.equal(e.st.woke.length + e.st.sent.length, 0);
  await e.add('A'); await cmdDone(e.deps, '1', 'D-052');
  e.at('2026-11-25T17:20:00+05:30'); await e.check(); assert.equal(e.st.woke.length + e.st.sent.length, 0);
});

test('检查：不到 24 小时静默；超过 24 小时叫醒一次；同一批 24 小时内不重复叫', async () => {
  const e = mk('2026-11-22T10:00:00+05:30'); await e.add('A');
  e.at('2026-11-22T17:20:00+05:30'); await e.check(); assert.equal(e.st.woke.length, 0);
  e.at('2026-11-23T10:30:00+05:30'); await e.check(); assert.equal(e.st.woke.length, 1);
  assert.match(e.st.woke[0], /ledger-watch\.mjs list/); assert.match(e.st.woke[0], /不要运行 git/); assert.match(e.st.woke[0], /`node .*ledger-watch/);
  e.at('2026-11-23T17:20:00+05:30'); await e.check(); assert.equal(e.st.woke.length, 1, '24 小时内不重复叫');
});

test('检查：同一批叫满 3 次后只发一句提示；之后不再叫、不重复提示', async () => {
  const e = mk('2026-11-22T10:00:00+05:30'); await e.add('A');
  for (const [i, d] of ['2026-11-23T10:30', '2026-11-24T10:30', '2026-11-25T10:30'].entries()) { e.at(`${d}:00+05:30`); await e.check(); assert.equal(e.st.woke.length, i + 1); }
  e.at('2026-11-26T10:30:00+05:30'); await e.check();
  assert.equal(e.st.woke.length, 3); assert.ok(e.st.sent.some((t) => /叫过总控 3 次/.test(t)));
  const n = e.st.sent.length;
  e.at('2026-11-27T10:30:00+05:30'); await e.check();
  assert.equal(e.st.woke.length, 3); assert.equal(e.st.sent.filter((t) => /叫过总控 3 次/.test(t)).length, 1, '提示只发一次');
  assert.ok(e.st.sent.length >= n);
});

test('检查：批次有变化（新增了条目）时可以再叫；叫醒失败不记次数', async () => {
  const e = mk('2026-11-22T10:00:00+05:30'); await e.add('A');
  e.at('2026-11-23T10:30:00+05:30'); e.st.wakeOk = false; await e.check();
  assert.equal(e.data().已叫醒批次.length, 0); assert.ok(e.st.warns.some((w) => /叫醒总控没成/.test(w)));
  e.st.wakeOk = true; await e.check(); assert.equal(e.data().已叫醒批次[0].次数, 1);
  e.at('2026-11-23T11:00:00+05:30'); await e.add('B'); await e.check();
  assert.equal(e.st.woke.length, 3, '前面失败一次＋成功一次，批次变了再叫一次');
  assert.equal(e.data().已叫醒批次.length, 2);
});

test('检查：超过 3 天仍有待补 → 工坊说一句，之后每满 3 天才再说；发失败不记', async () => {
  const e = mk('2026-11-22T10:00:00+05:30'); await e.add('A');
  e.at('2026-11-25T10:30:00+05:30'); e.st.sendOk = false; await e.check();
  assert.equal(e.data().提示.超3天上次, null);
  e.st.sendOk = true; await e.check();
  assert.ok(e.st.sent.some((t) => /最早一条已经 3 天了/.test(t))); assert.ok(e.data().提示.超3天上次);
  const n = e.st.sent.length;
  e.at('2026-11-26T10:30:00+05:30'); await e.check(); assert.equal(e.st.sent.length, n, '1 天后不重复');
  e.at('2026-11-28T11:00:00+05:30'); await e.check(); assert.equal(e.st.sent.length, n + 1, '满 3 天再说一次');
});

test('测试条目：叫醒消息写明“这是测试，不要改决定账本”', async () => {
  const e = mk('2026-11-22T10:00:00+05:30'); await e.add('测', { 测试: true });
  e.at('2026-11-23T10:30:00+05:30'); await e.check();
  assert.match(e.st.woke[0], /这是测试，不要改决定账本\.md/);
  assert.doesNotMatch(wakeMessage([{ 测试: false }]), /这是测试/);
});

test('加锁：锁在时命令不改文件；定时入口输出 NO_REPLY；不认识的命令报错', async () => {
  const e = mk(); await e.add('A');
  const lock = e.p.lock; writeFileSync(lock, 'x'); utimesSync(lock, e.st.clock / 1000, e.st.clock / 1000);
  assert.equal(await cmdDone(e.deps, '1', 'D-052'), 1); assert.equal(e.data().条目[0].状态, '待补');
  const { unlinkSync } = await import('node:fs'); unlinkSync(lock);
  e.st.out.length = 0; assert.equal(await main(['--data-root', e.dataRoot ?? e.deps.dataRoot], e.deps), 0); assert.deepEqual(e.st.out, ['NO_REPLY']);
  e.st.out.length = 0; assert.equal(await main(['乱来'], e.deps), 2);
});

test('main 命令行解析：add／list／done 走通', async () => {
  const e = mk();
  assert.equal(await main(['add', '--date', '2026-11-22', '--title', '测试标题', '--quote', '这是原话 带空格', '--line', 'L9'], e.deps), 0);
  assert.equal(e.data().条目[0].原话, '这是原话 带空格');
  assert.equal(await main(['done', '1', '--ledger-id', 'D-060'], e.deps), 0);
  assert.equal(e.data().条目[0].状态, '已入账');
});

test('审计--data-root 放在子命令前面也能认出子命令', async () => {
  const e = mk();
  assert.equal(await main(['--data-root', e.deps.dataRoot, 'add', '--date', '2026-11-22', '--title', 'X', '--quote', 'Y'], e.deps), 0);
  assert.equal(e.data().条目.length, 1);
});


// ───── 正式 SOP 落字第 7 项：账本自动提交（临时目录里 git init 假资料仓库；不碰真仓库）─────
const GIT = '/usr/bin/git';
const gitRun = (cwd, ...args) => spawnSync(GIT, ['-c', 'user.name=测试', '-c', 'user.email=test@local', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
const fakeGit = (extra = {}) => (args) => { const r = gitRun(process.cwd(), ...args); return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; };
function mkRepo(e, { track = true } = {}) {
  const root = e.deps.dataRoot;
  gitRun(root, 'init', '-q'); 
  writeFileSync(join(root, '决定账本.md'), '# 决定账本\n\n### D-001 老条\n');
  writeFileSync(join(root, 'INDEX.md'), '索引\n');
  if (track) { gitRun(root, 'add', '决定账本.md', 'INDEX.md'); gitRun(root, 'commit', '-q', '-m', '初始'); }
  e.deps.git = fakeGit(); e.deps.sleep = async () => {};
  e.count = () => Number(gitRun(root, 'rev-list', '--count', 'HEAD').stdout.trim());
  e.lastMsg = () => gitRun(root, 'log', '-1', '--format=%s').stdout.trim();
  e.ledgerPath = join(root, '决定账本.md');
  return e;
}

test('账本提交：账本没改动 → 不提交、返回无改动', async () => {
  const e = mkRepo(mk());
  const c = await commitLedger(e.deps, { 触发: '手动' });
  assert.equal(c.动作, '无改动'); assert.equal(e.count(), 1);
});

test('账本提交：账本和 INDEX.md 都改了（INDEX.md 还 add 过）→ 只提交账本，INDEX.md 仍是没提交', async () => {
  const e = mkRepo(mk());
  writeFileSync(e.ledgerPath, '# 决定账本\n\n### D-001 老条\n### D-002 新条\n');
  writeFileSync(join(e.deps.dataRoot, 'INDEX.md'), '索引改了\n'); gitRun(e.deps.dataRoot, 'add', 'INDEX.md');
  const c = await commitLedger(e.deps, { 触发: '手动' });
  assert.equal(c.动作, '已提交'); assert.match(c.提交号, /^[0-9a-f]{4,}$/);
  assert.equal(e.count(), 2);
  assert.deepEqual(gitRun(e.deps.dataRoot, '-c', 'core.quotepath=false', 'show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n'), ['决定账本.md']);
  assert.match(gitRun(e.deps.dataRoot, 'status', '--porcelain').stdout, /INDEX\.md/, 'INDEX.md 的改动还在');
  assert.doesNotMatch(gitRun(e.deps.dataRoot, 'status', '--porcelain', '--', '决定账本.md').stdout, /\S/);
});

test('账本提交：账本没被 Git 跟踪 → 跳过，不 add、不提交', async () => {
  const e = mkRepo(mk(), { track: false });
  gitRun(e.deps.dataRoot, 'commit', '-q', '--allow-empty', '-m', '空初始');
  const c = await commitLedger(e.deps, { 触发: '手动' });
  assert.equal(c.动作, '跳过'); assert.match(c.原因, /没被 Git 跟踪/);
  assert.equal(gitRun(e.deps.dataRoot, 'ls-files').stdout.trim(), '', 'add 没发生');
});

test('账本提交：index.lock 存在 → 重试一次后失败，不删锁；done 返回码仍是 0', async () => {
  const e = mkRepo(mk()); await e.add('A');
  writeFileSync(e.ledgerPath, '# 决定账本\n### D-002 新条\n');
  const lock = join(e.deps.dataRoot, '.git', 'index.lock'); writeFileSync(lock, '');
  let sleeps = 0; e.deps.sleep = async () => { sleeps += 1; };
  assert.equal(await cmdDone(e.deps, '1', 'D-002'), 0);
  assert.equal(sleeps, 1, '只重试一次'); assert.ok(existsSync(lock), '锁没被删');
  assert.match(e.st.out.at(-1), /账本提交：失败（仓库正忙/);
  assert.equal(e.count(), 1);
});

test('账本提交：done 触发提交，说明里有待补编号；测试条目的 done 不触发', async () => {
  const e = mkRepo(mk()); await e.add('A'); await e.add('T', { 测试: true });
  writeFileSync(e.ledgerPath, '# 决定账本\n### D-002 新条\n');
  assert.equal(await cmdDone(e.deps, '2', 'D-002'), 0);
  assert.equal(e.count(), 1, '测试条目不触发');
  assert.equal(await cmdDone(e.deps, '1', 'D-002'), 0);
  assert.equal(e.count(), 2); assert.match(e.lastMsg(), /^决定账本：程序自动提交（总控补写，2026-11-22，待补编号 1）$/);
  assert.match(e.st.out.at(-1), /账本提交：已提交 [0-9a-f]+/);
  assert.equal(await cmdDone(e.deps, '1', 'D-002'), 0); assert.match(e.st.out.at(-1), /早就标过/);
  assert.equal(e.count(), 2, '重复 done 不再提交');
});

test('账本提交：17:20 定时检查没有待补条目也会提交，说明是定时兜底样式，输出只有 NO_REPLY', async () => {
  const e = mkRepo(mk());
  writeFileSync(e.ledgerPath, '# 决定账本\n### D-003 开发会话手改的\n');
  e.st.out.length = 0;
  assert.equal(await main(['--data-root', e.deps.dataRoot], e.deps), 0);
  assert.deepEqual(e.st.out, ['NO_REPLY']);
  assert.equal(e.count(), 2); assert.equal(e.lastMsg(), '决定账本：程序自动提交（2026-11-22，定时兜底）');
});

test('账本提交：--dry-run 不 add 不 commit；commit 子命令正常提交', async () => {
  const e = mkRepo(mk());
  writeFileSync(e.ledgerPath, '# 决定账本\n### D-004\n');
  assert.equal(await main(['commit', '--dry-run', '--data-root', e.deps.dataRoot], e.deps), 0);
  assert.match(e.st.out.at(-1), /账本提交：演习（会提交：决定账本\.md（加 \d+ 行、减 \d+ 行））/);
  assert.equal(e.count(), 1); assert.match(gitRun(e.deps.dataRoot, 'status', '--porcelain', '--', '决定账本.md').stdout, /M/);
  assert.equal(gitRun(e.deps.dataRoot, 'diff', '--cached', '--name-only').stdout.trim(), '', '没有 add');
  assert.equal(await main(['commit', '--data-root', e.deps.dataRoot], e.deps), 0);
  assert.equal(e.count(), 2);
});

test('账本提交：资料根不是仓库根（套在上一层仓库里）→ 跳过，上层仓库不受影响', async () => {
  const outer = mk(); mkRepo(outer);
  const inner = join(outer.deps.dataRoot, '子目录'); mkdir2(inner);
  writeFileSync(join(inner, '决定账本.md'), '子目录账本\n');
  const deps = { ...outer.deps, dataRoot: inner };
  const c = await commitLedger(deps, { 触发: '手动' });
  assert.equal(c.动作, '跳过'); assert.match(c.原因, /不是 Git 仓库根/);
  assert.equal(outer.count(), 1);
});

test('账本提交：没有 deps.git → 未启用，done 不多输出一行，原有行为不变', async () => {
  const e = mk(); await e.add('A');
  assert.equal((await commitLedger(e.deps, {})).动作, '未启用');
  e.st.out.length = 0; assert.equal(await cmdDone(e.deps, '1', 'D-009'), 0);
  assert.deepEqual(e.st.out, ['已标：1 → D-009。']);
});

test('账本提交：git 抛错 → 返回失败；done 和定时检查都不受影响', async () => {
  const e = mk(); await e.add('A'); e.deps.git = () => { throw new Error('假的 git 炸了'); };
  const c = await commitLedger(e.deps, {}); assert.equal(c.动作, '失败'); assert.match(c.原因, /假的 git 炸了/);
  assert.equal(await cmdDone(e.deps, '1', 'D-009'), 0);
  assert.equal(e.data().条目[0].状态, '已入账');
  e.st.out.length = 0; assert.equal(await main([], e.deps), 0); assert.deepEqual(e.st.out, ['NO_REPLY']);
});

test('账本提交：日志只记结果不记账本内容，权限 600；提交说明和日志里没有账本正文', async () => {
  const e = mkRepo(mk());
  writeFileSync(e.ledgerPath, '# 决定账本\n### D-005 机密正文不要进日志\n');
  await commitLedger(e.deps, { 触发: '定时兜底' });
  const log = join(paths(e.deps.dataRoot).dir, '运行.log');
  const t = readFileSync(log, 'utf8');
  assert.match(t, /触发=定时兜底 结果=已提交 提交号=[0-9a-f]+/); assert.ok(!t.includes('机密正文'));
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.ok(!e.lastMsg().includes('机密正文'));
  const e2 = mkRepo(mk()); await commitLedger(e2.deps, {});
  assert.ok(!existsSync(join(paths(e2.deps.dataRoot).dir, '运行.log')), '无改动不写日志');
});

test('账本提交：commitMessage 两种样式；realDeps 在 node --test 下不给 git（防误动真仓库）', async () => {
  const e = mk();
  assert.equal(commitMessage(e.deps, [3, 4]), '决定账本：程序自动提交（总控补写，2026-11-22，待补编号 3、4）');
  assert.equal(commitMessage(e.deps, null), '决定账本：程序自动提交（2026-11-22，定时兜底）');
  assert.equal(realDeps({ ...process.env }, e.deps.dataRoot).git, null);
});

test('账本提交：账本文件被挪走 → 不提交（走 existsSync 那一支）、日志写"账本文件不在，没提交"，定时检查给出警告', async () => {
  const { renameSync } = await import('node:fs');
  const e = mkRepo(mk());
  renameSync(e.ledgerPath, join(e.deps.dataRoot, '决定账本.md.搬走了'));
  const c = await commitLedger(e.deps, { 触发: '手动' });
  assert.equal(c.动作, '跳过'); assert.match(c.原因, /账本文件不在，没提交/);
  assert.equal(e.count(), 1, '没有产生"删除账本"的提交');
  const log = readFileSync(join(paths(e.deps.dataRoot).dir, '运行.log'), 'utf8');
  assert.match(log, /结果=跳过 .*账本文件不在，没提交/); assert.ok(!/结果=已提交/.test(log));
  // 定时检查：不提交，输出仍只有 NO_REPLY，但 warn 了一句
  e.st.warns.length = 0; e.st.out.length = 0;
  assert.equal(await main(['--data-root', e.deps.dataRoot], e.deps), 0);
  assert.deepEqual(e.st.out, ['NO_REPLY']); assert.ok(e.st.warns.some((w) => /账本文件不在/.test(w)));
  assert.equal(e.count(), 1);
});

test('realDeps 判断测试环境用的是入参 env，不是全局 process.env', async () => {
  const e = mk();
  assert.equal(realDeps({ NODE_TEST_CONTEXT: 'child' }, e.deps.dataRoot).git, null);
  assert.equal(typeof realDeps({ NODE_TEST_CONTEXT: 'child', LEDGER_WATCH_ALLOW_GIT_IN_TEST: '1' }, e.deps.dataRoot).git, 'function');
  assert.equal(typeof realDeps({}, e.deps.dataRoot).git, 'function');
});

test('账本提交：账本文件还在工作区、但 Git 里已经 `git rm --cached`（暂存区是删除状态）→ 走状态行以 D 开头那一支，不提交', async () => {
  const e = mkRepo(mk());
  gitRun(e.deps.dataRoot, 'rm', '-q', '--cached', '决定账本.md');
  assert.ok(existsSync(e.ledgerPath), '文件还在工作区，existsSync 那一支命不中');
  const st = gitRun(e.deps.dataRoot, '-c', 'core.quotepath=false', 'status', '--porcelain', '--', '决定账本.md').stdout;
  assert.match(st.trim().split('\n')[0], /^D/, '状态行第一行以 D 开头');
  const c = await commitLedger(e.deps, { 触发: '手动' });
  assert.equal(c.动作, '跳过'); assert.match(c.原因, /账本文件不在，没提交/);
  assert.equal(e.count(), 1, '没有产生删除账本的提交');
  assert.match(gitRun(e.deps.dataRoot, 'status', '--porcelain').stdout, /D/, '暂存区的删除原样留着，没被提交');
});
