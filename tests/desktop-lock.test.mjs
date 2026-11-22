// Offline tests for desktop lock: temporary directories and fake data only; nothing touches a real deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GUARD_WAIT_MS, IDLE_STALE_MS, confirmHeldAccess, approvalFingerprint, RUN_ENDED_GRACE_MS, SCREEN_TOOLS, checkScreenAccess, createScreenGate, describeLock, lockPathsFromConfig,
  holdForConfirmation, markRunEnded, readLock, registerDesktopScreenLock, releaseLock, threadIdFromSessionKey, withLockGuard,
} from '../plugins/personal-inbox/desktop-lock.mjs';

// 全部用临时目录里的锁文件，不碰真正的 runtime/desktop/screen.lock，也不碰屏幕。
const moduleUrl = new URL('../plugins/personal-inbox/desktop-lock.mjs', import.meta.url).href;
const scriptPath = fileURLToPath(new URL('../scripts/desktop-lock.mjs', import.meta.url));
const A = 'agent:desktop:discord:channel:100000000000000145';
const B = 'agent:desktop:discord:channel:100000000000000146';
const T0 = 1_800_000_000_000;
const C = 'agent:desktop:discord:channel:100000000000000147';
const THREAD_A = '100000000000000145';

// 桌面角色排队小批：临时目录里先放一份有效的设置文件（照第 2b 步的四个默认值），原有测试按“排队开着”的真实状态跑。
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-lock-test-'));
  writeFileSync(join(dir, 'screen-queue-settings.json'), JSON.stringify({ holdMinutes: 15, confirmMinutes: 5, maxNotifyAttempts: 3, paused: false }));
  return { dir, lockPath: join(dir, 'screen.lock'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('线程编号从会话地址里取', () => {
  assert.equal(threadIdFromSessionKey(A), '100000000000000145');
  assert.equal(threadIdFromSessionKey('agent:desktop:main'), null);
});

test('锁空着：自动拿锁并放行，同线程再来也放行', () => {
  const { lockPath, cleanup } = fresh();
  try {
    assert.equal(checkScreenAccess({ lockPath, sessionKey: A, runId: 'r1', requester: { senderId: 'owner-user', accountId: 'default', senderIsOwner: true }, now: T0 }).allow, true);
    const lock = readLock(lockPath);
    assert.equal(lock.sessionKey, A);
    assert.equal(lock.threadId, '100000000000000145');
    assert.match(lock.link, /^https:\/\/discord\.com\/channels\/\d+\/100000000000000145$/);
    assert.equal(lock.requester, 'owner-user');
    assert.equal(lock.requesterAccount, 'default');
    assert.equal(lock.requesterIsOwner, true);
    assert.equal(lock.runId, 'r1');
    assert.equal(lock.startedAt, T0);
    assert.equal(checkScreenAccess({ lockPath, sessionKey: A, runId: 'r2', now: T0 + 60_000 }).allow, true);
    const again = readLock(lockPath);
    assert.equal(again.startedAt, T0);
    assert.equal(again.lastActivityAt, T0 + 60_000);
    assert.equal(again.runId, 'r2');
  } finally { cleanup(); }
});

test('锁在别的线程手上：挡下，并说明要回“我在别处忙”', () => {
  const { lockPath, cleanup } = fresh();
  try {
    checkScreenAccess({ lockPath, sessionKey: A, requester: { senderId: 'owner-user' }, now: T0 });
    const verdict = checkScreenAccess({ lockPath, sessionKey: B, now: T0 + 30_000 });
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /我在别处忙，排上了，前面还有 1 件/);
    assert.match(verdict.reason, /100000000000000145/);
    assert.match(verdict.reason, /请求方：owner-user/);
    assert.equal(readLock(lockPath).sessionKey, A);
  } finally { cleanup(); }
});

test('两个进程同时抢空锁：每一轮只有一个成功', async () => {
  const { dir, lockPath, cleanup } = fresh();
  try {
    const run = (sessionKey, path) => new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e',
        `import { checkScreenAccess } from ${JSON.stringify(moduleUrl)};
         console.log(checkScreenAccess({ lockPath: ${JSON.stringify(path)}, sessionKey: ${JSON.stringify(sessionKey)} }).allow);`]);
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => resolve(out.trim()));
    });
    for (let round = 0; round < 15; round += 1) {
      const path = join(dir, `race-${round}.lock`);
      const results = await Promise.all([run(A, path), run(B, path)]);
      assert.deepEqual(results.sort(), ['false', 'true'], `第 ${round} 轮结果 ${results}`);
    }
  } finally { cleanup(); }
});

test('旧锁：那一轮结束超过 2 分钟才算旧；换锁时先挡下一次并提醒先截图', () => {
  const { lockPath, cleanup } = fresh();
  try {
    checkScreenAccess({ lockPath, sessionKey: A, now: T0 });
    markRunEnded({ lockPath, sessionKey: A, now: T0 + 10_000 });
    assert.equal(readLock(lockPath).holderRunEnded, true);
    const early = checkScreenAccess({ lockPath, sessionKey: B, now: T0 + 10_000 + RUN_ENDED_GRACE_MS - 1 });
    assert.equal(early.allow, false);
    assert.match(early.reason, /我在别处忙/);
    assert.equal(readLock(lockPath).sessionKey, A);
    const takeover = checkScreenAccess({ lockPath, sessionKey: B, now: T0 + 10_000 + RUN_ENDED_GRACE_MS });
    assert.equal(takeover.allow, false);
    assert.match(takeover.reason, /旧锁已失效/);
    assert.match(takeover.reason, /截图/);
    assert.equal(readLock(lockPath).sessionKey, B);
    assert.equal(checkScreenAccess({ lockPath, sessionKey: B, now: T0 + 10_000 + RUN_ENDED_GRACE_MS + 1000 }).allow, true);
    assert.equal(readdirSync(join(lockPath, '..')).filter((n) => n.startsWith('screen.lock.stale-')).length, 1);
  } finally { cleanup(); }
});

test('旧锁：没结束记录时，20 分钟没动屏幕才算旧', () => {
  const { lockPath, cleanup } = fresh();
  try {
    checkScreenAccess({ lockPath, sessionKey: A, now: T0 });
    assert.equal(checkScreenAccess({ lockPath, sessionKey: B, now: T0 + IDLE_STALE_MS - 1 }).allow, false);
    assert.match(checkScreenAccess({ lockPath, sessionKey: B, now: T0 + IDLE_STALE_MS - 1 }).reason, /我在别处忙/);
    const takeover = checkScreenAccess({ lockPath, sessionKey: B, now: T0 + IDLE_STALE_MS });
    assert.match(takeover.reason, /旧锁已失效/);
    assert.equal(readLock(lockPath).sessionKey, B);
  } finally { cleanup(); }
});

test('“等确认”的锁：多久都不自动失效，一轮结束也不记，只有放锁才空出来', () => {
  const { lockPath, cleanup } = fresh();
  try {
    checkScreenAccess({ lockPath, sessionKey: A, now: T0 });
    assert.equal(holdForConfirmation({ lockPath, threadId: '100000000000000145', now: T0 + 1000 }).ok, true);
    markRunEnded({ lockPath, sessionKey: A, now: T0 + 2000 });
    assert.equal(readLock(lockPath).holderRunEnded, false);
    const verdict = checkScreenAccess({ lockPath, sessionKey: B, now: T0 + 5 * 3600_000 });
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /等主人确认/);
    assert.match(verdict.reason, /我在别处忙/);
    assert.match(describeLock({ lockPath, now: T0 + 5 * 3600_000 }), /等确认/);
    // 第二段 3.12：她自己再动屏幕，要先过主人的批准；没批之前锁仍是“等确认”
    const need = checkScreenAccess({ lockPath, sessionKey: A, now: T0 + 6 * 3600_000 });
    assert.equal(need.allow, false); assert.equal(need.approval, true);
    assert.equal(readLock(lockPath).state, 'waiting');
    // 批准后才改回进行中（批准通过由钩子的审批回调调用 confirmHeldAccess）
    assert.equal(confirmHeldAccess({ lockPath, threadId: '100000000000000145', fingerprint: need.approvalInfo.fingerprint, now: T0 + 6 * 3600_000 }).ok, true);
    assert.equal(readLock(lockPath).state, 'working');
    assert.equal(releaseLock({ lockPath, threadId: '100000000000000145' }).ok, true);
    assert.equal(existsSync(lockPath), false);
    assert.equal(checkScreenAccess({ lockPath, sessionKey: B, now: T0 + 6 * 3600_000 + 1 }).allow, true);
  } finally { cleanup(); }
});

test('放锁：只放自己线程的锁；没有锁不报错；别人的锁、等确认都不能乱动', () => {
  const { lockPath, cleanup } = fresh();
  try {
    assert.equal(releaseLock({ lockPath, threadId: '100000000000000145' }).ok, true);
    assert.equal(holdForConfirmation({ lockPath, threadId: '100000000000000145' }).ok, false);
    checkScreenAccess({ lockPath, sessionKey: A, now: T0 });
    assert.equal(releaseLock({ lockPath, threadId: '100000000000000146' }).ok, false);
    assert.equal(releaseLock({ lockPath }).ok, false);
    assert.equal(holdForConfirmation({ lockPath, threadId: '100000000000000146' }).ok, false);
    assert.equal(existsSync(lockPath), true);
    assert.equal(releaseLock({ lockPath, threadId: '100000000000000145' }).ok, true);
    assert.equal(existsSync(lockPath), false);
  } finally { cleanup(); }
});

test('锁文件读不懂、读不到线程：一律挡下，不乱放行', () => {
  const { lockPath, cleanup } = fresh();
  try {
    writeFileSync(lockPath, '{坏的');
    const verdict = checkScreenAccess({ lockPath, sessionKey: A, now: T0 });
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /读不懂/);
    assert.equal(readFileSync(lockPath, 'utf8'), '{坏的');
    assert.equal(releaseLock({ lockPath, threadId: '100000000000000145' }).ok, false);
    assert.equal(checkScreenAccess({ lockPath: join(lockPath, '..', 'none.lock'), sessionKey: undefined, now: T0 }).allow, false);
  } finally { cleanup(); }
});

test('检查只管桌面角色的 computer 和 browser（含 mcp__openclaw__ 前缀）', () => {
  const { lockPath, cleanup } = fresh();
  try {
    const gate = createScreenGate({ lockPath, logPath: join(lockPath, '..', 'gate.log'), now: () => T0 });
    const desktop = (toolName, sessionKey = A) => gate({ toolName }, { agentId: 'desktop', sessionKey });
    assert.equal(desktop('computer'), undefined);
    assert.equal(readLock(lockPath).sessionKey, A);
    assert.equal(desktop('mcp__openclaw__browser'), undefined);
    const blocked = desktop('computer', B);
    assert.equal(blocked.block, true);
    assert.match(blocked.blockReason, /我在别处忙/);
    assert.equal(desktop('exec', B), undefined);
    assert.equal(desktop('web_fetch', B), undefined);
    assert.equal(gate({ toolName: 'computer' }, { agentId: 'worker-c', sessionKey: B }), undefined);
    assert.equal(gate({ toolName: 'computer' }, { agentId: 'desktop' }).block, true);
    // 没有 agentId 时按会话地址认角色
    assert.equal(gate({ toolName: 'computer' }, { sessionKey: B }).block, true);
    assert.equal(gate({ toolName: 'computer' }, { sessionKey: 'agent:worker-c:discord:channel:1' }), undefined);
    const lines = readFileSync(join(lockPath, '..', 'gate.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.decision === 'allow') && lines.some((l) => l.decision === 'block') && lines.some((l) => l.decision === 'ignored-not-desktop'));
  } finally { cleanup(); }
});

test('没有锁路径时桌面角色动屏幕一律挡下，别的角色不受影响', () => {
  const gate = createScreenGate({ lockPath: null, logPath: null });
  assert.equal(gate({ toolName: 'computer' }, { agentId: 'desktop', sessionKey: A }).block, true);
  assert.equal(gate({ toolName: 'computer' }, { agentId: 'worker-c', sessionKey: B }), undefined);
});

test('登记：before_tool_call 只盯 computer、browser；agent_end 记一轮结束', () => {
  const { lockPath, cleanup } = fresh();
  try {
    const registered = [];
    registerDesktopScreenLock({ on: (name, handler, options) => registered.push({ name, handler, options }) }, { lockPath, logPath: join(lockPath, '..', 'gate.log') });
    const gate = registered.find((r) => r.name === 'before_tool_call' && r.options.registrationId === 'desktop-screen-lock-gate');
    const ended = registered.find((r) => r.name === 'agent_end');
    assert.deepEqual(gate.options.matcher, [...SCREEN_TOOLS, 'mcp__openclaw__computer', 'mcp__openclaw__browser']);
    assert.ok(gate.options.registrationId && ended.options.registrationId);
    gate.handler({ toolName: 'computer' }, { agentId: 'desktop', sessionKey: A });
    ended.handler({}, { agentId: 'worker-c', sessionKey: A });
    assert.equal(readLock(lockPath).holderRunEnded, false);
    ended.handler({}, { agentId: 'desktop', sessionKey: A });
    assert.equal(readLock(lockPath).holderRunEnded, true);
  } finally { cleanup(); }
});

test('小命令 status / wait / release：用临时锁文件走一遍，换了线程的动不了', () => {
  const { lockPath, cleanup } = fresh();
  try {
    const cli = (...args) => spawnSync(process.execPath, [scriptPath, ...args, '--lock', lockPath], { encoding: 'utf8' });
    assert.match(cli('status').stdout, /屏幕空着/);
    checkScreenAccess({ lockPath, sessionKey: A });
    assert.match(cli('status').stdout, /进行中/);
    assert.equal(cli('release', '--thread', '100000000000000146').status, 1);
    assert.equal(cli('wait', '--thread', '100000000000000146').status, 1);
    assert.equal(existsSync(lockPath), true);
    assert.equal(cli('wait', '--thread', '100000000000000145').status, 0);
    assert.match(cli('status').stdout, /等确认/);
    const released = cli('release', '--thread', '100000000000000145');
    assert.equal(released.status, 0);
    assert.match(released.stdout, /已放锁/);
    assert.equal(existsSync(lockPath), false);
    assert.equal(spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' }).status, 2);
  } finally { cleanup(); }
});

test('锁里记请求方；系统没给出请求方时，提示里明说“未记录”，之后同线程再来能补上', () => {
  const { lockPath, cleanup } = fresh();
  try {
    checkScreenAccess({ lockPath, sessionKey: A, now: T0 });
    assert.equal(readLock(lockPath).requester, null);
    assert.match(checkScreenAccess({ lockPath, sessionKey: B, now: T0 + 1000 }).reason, /请求方：未记录（系统没给出）/);
    checkScreenAccess({ lockPath, sessionKey: A, requester: { senderId: '100000000000000148', accountId: 'task-worker-c', senderIsOwner: true }, now: T0 + 2000 });
    const lock = readLock(lockPath);
    assert.equal(lock.requester, '100000000000000148');
    assert.equal(lock.requesterAccount, 'task-worker-c');
    checkScreenAccess({ lockPath, sessionKey: A, requester: { senderId: 'other' }, now: T0 + 3000 });
    assert.equal(readLock(lockPath).requester, '100000000000000148');
  } finally { cleanup(); }
});

test('认不出是哪个角色时一律挡下（既没有角色名，会话地址也读不出），并记一行', () => {
  const { lockPath, cleanup } = fresh();
  try {
    const logPath = join(lockPath, '..', 'gate.log');
    const gate = createScreenGate({ lockPath, logPath, now: () => T0 });
    assert.equal(gate({ toolName: 'computer' }, {}).block, true);
    assert.equal(gate({ toolName: 'browser' }, { sessionKey: 'weird-key' }).block, true);
    assert.equal(gate({ toolName: 'computer' }, undefined).block, true);
    assert.equal(existsSync(lockPath), false);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => l.decision === 'block-no-identity' && l.pid === process.pid));
  } finally { cleanup(); }
});

test('lock location comes from config/crew.json (paths.workspaceRoot/desktop); the small CLI reads it from there too', () => {
  const paths = lockPathsFromConfig();
  assert.equal(paths.lockPath, join(crew.paths.workspaceRoot, 'desktop', 'screen.lock'));
  assert.equal(paths.logPath, join(crew.paths.workspaceRoot, 'desktop', 'screen-lock.log'));
  assert.equal(paths.queuePath, join(crew.paths.workspaceRoot, 'desktop', 'screen-queue.json'));
});

// ---- 交错顺序测试：用真实的独立进程，靠“测试钩子”把关键时刻固定下来 ----
// 子进程按 spec 调用锁模块里的某个函数；hook 指定在“读完锁之后”或“旧锁刚被挪走之后”停住一会儿，
// 停住前先写一个标记文件，测试主进程看到标记就知道子进程正卡在那个时刻。
const RUNNER = `import * as m from ${JSON.stringify(moduleUrl)};
  import { writeFileSync } from 'node:fs';
  const spec = JSON.parse(process.argv[1]);
  const hooks = spec.hook ? { [spec.hook.name]: () => { writeFileSync(spec.hook.marker, '1'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, spec.hook.sleepMs); } } : undefined;
  const result = m[spec.fn]({ ...spec.args, _hooks: hooks });
  console.log(JSON.stringify({ result, finished: Date.now() }));`;

function child(spec) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', RUNNER, JSON.stringify(spec)]);
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch { /* 留给断言报错 */ }
      resolve({ code, err, result: parsed?.result, finished: parsed?.finished });
    });
  });
}

async function waitFor(path) {
  for (let i = 0; i < 400; i += 1) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等不到标记文件 ${path}`);
}

const STALE_NOW = T0 + IDLE_STALE_MS + 1;

test('交错①：放锁已经读到 A 的锁、还没删，B 来换旧锁——B 必须等放锁做完，B 的有效锁一直在，C 被挡', async () => {
  const { dir, lockPath, cleanup } = fresh();
  try {
    checkScreenAccess({ lockPath, sessionKey: A, now: T0 });
    const marker = join(dir, 'released-read');
    const release = child({ fn: 'releaseLock', args: { lockPath, threadId: THREAD_A }, hook: { name: 'afterRead', marker, sleepMs: 700 } });
    await waitFor(marker);
    const swap = child({ fn: 'checkScreenAccess', args: { lockPath, sessionKey: B, now: STALE_NOW } });
    const [r, b] = await Promise.all([release, swap]);
    assert.equal(r.code, 0, r.err);
    assert.equal(b.code, 0, b.err);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.message, '已放锁。');
    assert.ok(b.finished >= r.finished, 'B 必须在放锁做完之后才进得去');
    assert.equal(b.result.allow, true, 'A 放掉后 B 看到的是空锁，直接拿到');
    assert.equal(readLock(lockPath).sessionKey, B);
    const c = await child({ fn: 'checkScreenAccess', args: { lockPath, sessionKey: C, now: STALE_NOW + 1000 } });
    assert.equal(c.code, 0, c.err);
    assert.equal(c.result.allow, false);
    assert.match(c.result.reason, /我在别处忙/);
    const final = readLock(lockPath);
    assert.equal(final.sessionKey, B);
    assert.equal(final.state, 'working');
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.other-') || n.includes('.releasing-') || n.includes('.guard.')), []);
  } finally { cleanup(); }
});

test('交错②：B 刚把 A 的旧锁挪走、新锁还没建好（正式位置是空的）时，C 和 A 的放锁同时来——都得等，B 的有效锁一直在，C 被挡', async () => {
  const { dir, lockPath, cleanup } = fresh();
  try {
    checkScreenAccess({ lockPath, sessionKey: A, now: T0 });
    const marker = join(dir, 'b-moved');
    const swap = child({ fn: 'checkScreenAccess', args: { lockPath, sessionKey: B, now: STALE_NOW }, hook: { name: 'afterStaleMoved', marker, sleepMs: 700 } });
    await waitFor(marker);
    assert.equal(existsSync(lockPath), false, '此刻正式锁位置确实是空的');
    const lateRelease = child({ fn: 'releaseLock', args: { lockPath, threadId: THREAD_A } });
    const lateC = child({ fn: 'checkScreenAccess', args: { lockPath, sessionKey: C, now: STALE_NOW + 500 } });
    const [b, a, c] = await Promise.all([swap, lateRelease, lateC]);
    assert.equal(b.code, 0, b.err);
    assert.equal(a.code, 0, a.err);
    assert.equal(c.code, 0, c.err);
    assert.equal(b.result.allow, false);
    assert.match(b.result.reason, /旧锁已失效/);
    assert.equal(a.result.ok, false, 'A 迟到的放锁看到的已经是 B 的锁，不能动');
    assert.equal(c.result.allow, false, 'C 不能趁空档拿到屏幕');
    assert.match(c.result.reason, /我在别处忙/);
    assert.ok(a.finished >= b.finished && c.finished >= b.finished, 'A 的放锁、C 的核对都要等 B 换完才进得去');
    const final = readLock(lockPath);
    assert.equal(final.sessionKey, B);
    assert.equal(final.state, 'working');
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.other-') || n.includes('.releasing-') || n.includes('.guard.')), []);
  } finally { cleanup(); }
});

test('交错③：A 正在记“等确认”（已读到锁、还没写），B 来换旧锁——B 必须等，写完后 A 的等确认锁不会被换走', async () => {
  const { dir, lockPath, cleanup } = fresh();
  try {
    checkScreenAccess({ lockPath, sessionKey: A, now: T0 });
    const marker = join(dir, 'wait-read');
    const wait = child({ fn: 'holdForConfirmation', args: { lockPath, threadId: THREAD_A, now: STALE_NOW - 1 }, hook: { name: 'afterRead', marker, sleepMs: 700 } });
    await waitFor(marker);
    const swap = child({ fn: 'checkScreenAccess', args: { lockPath, sessionKey: B, now: STALE_NOW } });
    const [w, b] = await Promise.all([wait, swap]);
    assert.equal(w.code, 0, w.err);
    assert.equal(b.code, 0, b.err);
    assert.equal(w.result.ok, true);
    assert.equal(b.result.allow, false);
    assert.match(b.result.reason, /等主人确认/, 'B 看到的是等确认的锁，挡下');
    const final = readLock(lockPath);
    assert.equal(final.sessionKey, A);
    assert.equal(final.state, 'waiting');
  } finally { cleanup(); }
});

test('交错④：A 正在记“一轮结束”（已读到锁、还没写），B 来换旧锁——B 的有效锁不会被 A 的旧数据盖回去', async () => {
  const { dir, lockPath, cleanup } = fresh();
  try {
    checkScreenAccess({ lockPath, sessionKey: A, now: T0 });
    const marker = join(dir, 'ended-read');
    const ended = child({ fn: 'markRunEnded', args: { lockPath, sessionKey: A, now: T0 + 5000 }, hook: { name: 'afterRead', marker, sleepMs: 700 } });
    await waitFor(marker);
    const swap = child({ fn: 'checkScreenAccess', args: { lockPath, sessionKey: B, now: STALE_NOW } });
    const [e, b] = await Promise.all([ended, swap]);
    assert.equal(e.code, 0, e.err);
    assert.equal(b.code, 0, b.err);
    // 顺序是：A 先写完“一轮结束”，B 再进来；A 那一轮结束于 T0+5000，STALE_NOW 比它晚得多，所以 B 换走旧锁
    assert.match(b.result.reason, /旧锁已失效/);
    const final = readLock(lockPath);
    assert.equal(final.sessionKey, B);
    assert.equal(final.holderRunEnded, false);
  } finally { cleanup(); }
});

test('放锁与换锁反复抢 20 轮：每一轮两个进程都正常退出，最后一定是 B 的有效锁，没有残留的临时锁文件', async () => {
  for (let round = 0; round < 20; round += 1) {
    const { dir, lockPath, cleanup } = fresh();
    try {
      checkScreenAccess({ lockPath, sessionKey: A, now: T0 });
      const [r, b] = await Promise.all([
        child({ fn: 'releaseLock', args: { lockPath, threadId: THREAD_A } }),
        child({ fn: 'checkScreenAccess', args: { lockPath, sessionKey: B, now: STALE_NOW } }),
      ]);
      assert.equal(r.code, 0, `第 ${round} 轮放锁进程：${r.err}`);
      assert.equal(b.code, 0, `第 ${round} 轮换锁进程：${b.err}`);
      const lock = readLock(lockPath);
      assert.ok(lock && lock.sessionKey === B, `第 ${round} 轮最后的锁：${JSON.stringify(lock)}`);
      assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.other-') || n.includes('.releasing-') || n.includes('.guard.')), []);
    } finally { cleanup(); }
  }
});

// ---- 短保护自己的时序测试----
// 保护现在是系统文件锁：谁打开 screen.lock.guard 时拿到锁谁进；别人等；持有者退出（含被强行结束）系统自动放。
// 下面用“进出记录”证明受保护的那一小段从没有两个进程同时在里面：每个进程进去写 in、出来写 out，
// 记录里必须一进一出严格交替。
const GUARD_RUNNER = `import * as m from ${JSON.stringify(moduleUrl)};
  import { appendFileSync, writeFileSync } from 'node:fs';
  const spec = JSON.parse(process.argv[1]);
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const out = [];
  for (let i = 0; i < (spec.repeat ?? 1); i += 1) {
    const started = Date.now();
    try {
      m.withLockGuard(spec.lockPath, { guardWaitMs: spec.waitMs }, () => {
        appendFileSync(spec.trace, 'in ' + process.pid + ' ' + Date.now() + '\\n');
        if (spec.marker) writeFileSync(spec.marker, '1');
        sleep(spec.holdMs ?? 0);
        appendFileSync(spec.trace, 'out ' + process.pid + ' ' + Date.now() + '\\n');
      });
      out.push({ ok: true });
    } catch (error) {
      out.push({ ok: false, error: error.message, ms: Date.now() - started });
    }
  }
  console.log(JSON.stringify({ out, finished: Date.now() }));`;

function guardChild(spec) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', GUARD_RUNNER, JSON.stringify(spec)]);
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => proc.on('close', (code, signal) => {
    let parsed = null;
    try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch { /* 被强行结束时没有输出 */ }
    resolve({ code, signal, err, out: parsed?.out, finished: parsed?.finished });
  }));
  return { proc, done };
}

const readTrace = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const [kind, pid, at] = l.split(' '); return { kind, pid, at: Number(at) }; }) : []);

// 一进一出严格交替、且出来的就是刚进去的那个进程；被强行结束的进程只会留下一个没有 out 的 in（放在最后一个“已结束”之前不算重叠）。
function assertNoOverlap(trace, killedPid) {
  let inside = null;
  for (const row of trace) {
    if (row.kind === 'in') {
      if (inside !== null && inside !== killedPid) assert.fail(`进程 ${row.pid} 进去时，进程 ${inside} 还在里面：${JSON.stringify(trace)}`);
      inside = row.pid;
    } else {
      assert.equal(row.pid, inside, `出来的进程不是进去的进程：${JSON.stringify(trace)}`);
      inside = null;
    }
  }
}

test('保护①：A 刚拿到保护、还没动手时 B 来——B 必须等 A 出来才进，进出记录不重叠', async () => {
  const { dir, lockPath, cleanup } = fresh();
  try {
    const trace = join(dir, 'trace');
    const marker = join(dir, 'holder-in');
    const holder = guardChild({ lockPath, trace, marker, holdMs: 700 });
    await waitFor(marker);
    const late = guardChild({ lockPath, trace, holdMs: 50 });
    const [h, l] = await Promise.all([holder.done, late.done]);
    assert.equal(h.code, 0, h.err);
    assert.equal(l.code, 0, l.err);
    assert.deepEqual(h.out, [{ ok: true }]);
    assert.deepEqual(l.out, [{ ok: true }]);
    assert.ok(l.finished >= h.finished);
    const rows = readTrace(trace);
    assert.deepEqual(rows.map((r) => r.kind), ['in', 'out', 'in', 'out']);
    assertNoOverlap(rows);
  } finally { cleanup(); }
});

test('保护②：持有者被强行结束（kill -9）后，系统自动放保护；三个等着的进程只会一个一个进，都在有限时间内完成', async () => {
  const { dir, lockPath, cleanup } = fresh();
  try {
    const trace = join(dir, 'trace');
    const marker = join(dir, 'holder-in');
    const holder = guardChild({ lockPath, trace, marker, holdMs: 600_000 });
    await waitFor(marker);
    const waiters = [1, 2, 3].map(() => guardChild({ lockPath, trace, holdMs: 80, waitMs: 4000 }));
    await new Promise((r) => setTimeout(r, 300));
    const killedAt = Date.now();
    holder.proc.kill('SIGKILL');
    const started = Date.now();
    const results = await Promise.all(waiters.map((w) => w.done));
    assert.ok(Date.now() - started < 3000, '等着的进程应在有限时间内全部完成');
    for (const r of results) {
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(r.out, [{ ok: true }]);
    }
    const rows = readTrace(trace);
    const killedPid = String(holder.proc.pid);
    assertNoOverlap(rows, killedPid);
    const waiterIns = rows.filter((r) => r.kind === 'in' && r.pid !== killedPid);
    assert.equal(waiterIns.length, 3);
    assert.ok(waiterIns.every((r) => r.at >= killedAt - 5), '持有者还活着时，没有任何等待者进去');
    assert.equal((await holder.done).signal, 'SIGKILL');
  } finally { cleanup(); }
});

test('保护③：6 个进程各抢 15 次，受保护的那一小段从没有两个进程同时在里面，也没有一次报错', async () => {
  const { dir, lockPath, cleanup } = fresh();
  try {
    const trace = join(dir, 'trace');
    const runners = Array.from({ length: 6 }, () => guardChild({ lockPath, trace, holdMs: 3, repeat: 15, waitMs: 4000 }));
    const results = await Promise.all(runners.map((r) => r.done));
    for (const r of results) {
      assert.equal(r.code, 0, r.err);
      assert.ok(r.out.every((x) => x.ok), JSON.stringify(r.out));
    }
    const rows = readTrace(trace);
    assert.equal(rows.length, 6 * 15 * 2);
    assertNoOverlap(rows);
  } finally { cleanup(); }
});

test('保护④：持有者活着但占得很久——等的一方在时限内明确报错、没有闯进去，时限从头到尾有界；持有者出来后别人照常能进', async () => {
  const { dir, lockPath, cleanup } = fresh();
  try {
    const trace = join(dir, 'trace');
    const marker = join(dir, 'holder-in');
    const holder = guardChild({ lockPath, trace, marker, holdMs: 1500 });
    await waitFor(marker);
    const impatient = await guardChild({ lockPath, trace, holdMs: 10, waitMs: 300 }).done;
    assert.equal(impatient.code, 0, impatient.err);
    assert.equal(impatient.out[0].ok, false);
    assert.match(impatient.out[0].error, /没有强行抢/);
    assert.match(impatient.out[0].error, /EAGAIN/);
    assert.ok(impatient.out[0].ms >= 250 && impatient.out[0].ms < 1200, `等了 ${impatient.out[0].ms} 毫秒`);
    // 同样的情形放到工具前检查里：挡下，并把真实原因写进日志
    const logPath = join(dir, 'gate.log');
    const gate = createScreenGate({ lockPath, logPath, now: () => T0, guardWaitMs: 200 });
    const t0 = Date.now();
    const blocked = gate({ toolName: 'computer' }, { agentId: 'desktop', sessionKey: A });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(blocked.block, true);
    assert.match(blocked.blockReason, /桌面锁检查出错.*没有强行抢/);
    const logged = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(logged.at(-1).decision, 'error');
    assert.match(logged.at(-1).reason, /EAGAIN/);
    assert.equal(existsSync(lockPath), false, '没拿到保护就不能动锁文件');
    const h = await holder.done;
    assert.equal(h.code, 0, h.err);
    const rows = readTrace(trace);
    assert.deepEqual(rows.map((r) => r.kind), ['in', 'out'], '没拿到保护的一方从没进去过');
    assert.equal((await guardChild({ lockPath, trace, holdMs: 1, waitMs: 1000 }).done).out[0].ok, true);
  } finally { cleanup(); }
});

test('保护⑤：保护文件本身有问题（是个目录、没有权限）时，马上带着真实原因报错，不重试、不卡住', () => {
  const { lockPath, cleanup } = fresh();
  try {
    mkdirSync(`${lockPath}.guard`);
    let t0 = Date.now();
    assert.throws(() => checkScreenAccess({ lockPath, sessionKey: A, now: T0 }), /互斥保护文件打不开（(EISDIR|EACCES|EPERM)）/);
    assert.ok(Date.now() - t0 < 500);
    assert.equal(existsSync(lockPath), false);
    rmSync(`${lockPath}.guard`, { recursive: true });
    writeFileSync(`${lockPath}.guard`, '');
    chmodSync(`${lockPath}.guard`, 0o000);
    t0 = Date.now();
    assert.throws(() => releaseLock({ lockPath, threadId: THREAD_A }), /互斥保护文件打不开（EACCES）/);
    assert.ok(Date.now() - t0 < 500);
    chmodSync(`${lockPath}.guard`, 0o600);
  } finally { cleanup(); }
});

test('保护⑥：同一个进程里嵌套再拿保护——不会死等，到时限报错；保护文件永远是个空文件，不会被删或改', () => {
  const { lockPath, cleanup } = fresh();
  try {
    withLockGuard(lockPath, undefined, () => {
      const t0 = Date.now();
      assert.throws(() => withLockGuard(lockPath, { guardWaitMs: 150 }, () => {}), /没有强行抢/);
      assert.ok(Date.now() - t0 < 1000);
    });
    checkScreenAccess({ lockPath, sessionKey: A, now: T0 });
    releaseLock({ lockPath, threadId: THREAD_A });
    const guard = statSync(`${lockPath}.guard`);
    assert.equal(guard.size, 0);
    assert.equal(GUARD_WAIT_MS, 5000);
  } finally { cleanup(); }
});

// ======================================================================
// 桌面角色排队小批：U1～U39、UB1～UB7。
// 全部用临时目录；发送、读消息换成假的依赖并记下调用；时刻用固定的假时钟。
// 每项结束都核对：当前留位是谁、消息发了几条、有没有下一次会执行的东西（租约、进行中的尝试）、过时的调用能不能改结果。
// ======================================================================
import {
  DESKTOP_USER_ID, describeQueueLine, idFromTime, noteQueued, readQueue, readSettings, runTick, selectNextCommand, skipQueued,
  timeFromId, updateSettings,
} from '../plugins/personal-inbox/desktop-lock.mjs';

const TA = '100000000000000149';
const TB = '100000000000000150';
const TC = '100000000000000151';
const TD = '100000000000000152';
const TE = '100000000000000153';
const sk = (thread) => `agent:desktop:discord:channel:${thread}`;
const REQ = {
  [TA]: { senderId: '100000000000000154', accountId: 'default', senderIsOwner: true },
  [TB]: { senderId: '100000000000000155', accountId: 'worker-e', senderIsOwner: true },
  [TC]: { senderId: '100000000000000156', accountId: 'worker-f', senderIsOwner: true },
  [TD]: { senderId: '100000000000000157', accountId: 'worker-g', senderIsOwner: true },
  [TE]: { senderId: '100000000000000158', accountId: 'worker-a', senderIsOwner: true },
};
const MIN = 60_000;
const msgId = (ms, seq = 0) => (BigInt(idFromTime(ms)) + BigInt(seq)).toString();

function qenv() {
  const base = fresh();
  const env = {
    ...base,
    queuePath: join(base.dir, 'screen-queue.json'),
    settingsPath: join(base.dir, 'screen-queue-settings.json'),
    logPath: join(base.dir, 'screen-lock.log'),
  };
  env.q = () => readQueue(env.queuePath).q;
  env.item = (thread) => env.q().items.filter((i) => i.threadId === thread).at(-1);
  env.setSettings = (patch) => writeFileSync(env.settingsPath, JSON.stringify({ holdMinutes: 15, confirmMinutes: 5, maxNotifyAttempts: 3, paused: false, ...patch }));
  env.queueText = () => (existsSync(env.queuePath) ? readFileSync(env.queuePath, 'utf8') : null);
  env.log = () => (existsSync(env.logPath) ? readFileSync(env.logPath, 'utf8') : '');
  return env;
}
const access = (env, thread, now, opts = {}) => checkScreenAccess({ lockPath: env.lockPath, logPath: env.logPath, sessionKey: sk(thread), requester: opts.noRequester ? undefined : REQ[thread], now, _hooks: opts.hooks });
const release = (env, thread, now, hooks) => releaseLock({ lockPath: env.lockPath, logPath: env.logPath, threadId: thread, now, _hooks: hooks });

function makeDeps(t, { send = [], read = [] } = {}) {
  const calls = { sends: [], reads: [] };
  const deps = {
    async send(args) {
      calls.sends.push({ ...args, at: t.now });
      const step = send.length ? send.shift() : { kind: 'sent' };
      if (typeof step === 'function') return step(args);
      if (step.kind === 'sent' && !step.messageId) return { kind: 'sent', messageId: msgId(t.now, calls.sends.length) };
      return step;
    },
    async read(args) {
      calls.reads.push({ ...args, at: t.now });
      const step = read.length ? read.shift() : { ok: true, messages: [] };
      return typeof step === 'function' ? step(args) : step;
    },
  };
  return { deps, calls };
}
const tick = (env, t, deps, hooks, extra = {}) => runTick({ lockPath: env.lockPath, logPath: env.logPath, deps, clock: () => t.now, _hooks: hooks, ...extra });

// 四件事：当前留位是谁、发了几条、有没有还会执行的东西、过时的调用能不能改结果（租约放了、没有“进行中”的尝试）。
function check4(env, calls, { hold, sends }) {
  const q = env.q();
  assert.equal(q.hold?.threadId ?? null, hold, `当前留位应是 ${hold}`);
  assert.equal(calls.sends.length, sends, `发出的点名应是 ${sends} 条`);
  assert.equal(q.lease, null, '推进租约应已放掉，没有过时的执行者还握着');
  assert.ok(!(q.hold?.attempts ?? []).some((a) => a.result === 'in-progress'), '没有悬着的“进行中”尝试');
}

// A 拿着锁，B、C 先后被挡排上。
function queueABC(env, t0 = T0) {
  assert.equal(access(env, TA, t0).allow, true);
  const b = access(env, TB, t0 + 1000);
  const c = access(env, TC, t0 + 2000);
  return { b, c };
}

test('U1 锁占着时两个线程先后被挡：名单顺序对，N 分别是 1、2', () => {
  const env = qenv();
  try {
    const { b, c } = queueABC(env);
    assert.equal(b.allow, false);
    assert.match(b.reason, /我在别处忙，排上了，前面还有 1 件，轮到你我来叫你，不用再叫我/);
    assert.match(c.reason, /我在别处忙，排上了，前面还有 2 件/);
    const q = env.q();
    assert.deepEqual(q.items.map((i) => [i.threadId, i.status]), [[TB, 'waiting'], [TC, 'waiting']]);
    assert.equal(q.hold, null);
    assert.equal(readLock(env.lockPath).threadId, TA);
  } finally { env.cleanup(); }
});

test('U2 同一线程被挡两次：一件，名次不变，被挡次数 2', () => {
  const env = qenv();
  try {
    queueABC(env);
    const again = access(env, TB, T0 + 3000);
    assert.match(again.reason, /前面还有 1 件/);
    const items = env.q().items.filter((i) => i.threadId === TB);
    assert.equal(items.length, 1);
    assert.equal(items[0].blockedCount, 2);
    assert.equal(env.q().items[0].threadId, TB);
  } finally { env.cleanup(); }
});

test('U3 放锁：取排第一的，留位“待通知”；release 不发送', () => {
  const env = qenv();
  try {
    queueABC(env);
    const r = release(env, TA, T0 + 10_000);
    assert.equal(r.ok, true);
    assert.equal(r.message, '已放锁。');
    assert.match(r.queueNote, /排给下一位.*排队号 Q0001/);
    const q = env.q();
    assert.equal(q.hold.threadId, TB);
    assert.equal(q.hold.status, 'pending');
    assert.equal(q.hold.attempts.length, 0, 'release 只改名单，不发送');
    assert.equal(env.item(TB).status, 'pending');
    assert.equal(existsSync(env.lockPath), false);
    assert.equal(q.inProgress, null);
  } finally { env.cleanup(); }
});

test('U4 确认没发出三种（发前核对没过、连不上 Gateway、Discord 明确拒收）：记“未发出”、下一轮再发；满 3 次记“通知失败”、选下一位', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const { deps, calls } = makeDeps(t, { send: [
      { kind: 'not-sent', reason: '连不上本机 Gateway（测试）' },
      { kind: 'not-sent', reason: 'Discord 明确拒收（测试）' },
    ] });
    // 第一种：发前核对没过（记完尝试后打开暂停，核对完再关上）
    await tick(env, t, deps, { afterAttemptRecorded: () => env.setSettings({ paused: true }) });
    env.setSettings({ paused: false });
    let hold = env.q().hold;
    assert.equal(hold.attempts[0].result, 'not-sent');
    assert.match(hold.attempts[0].reason, /发前核对没过/);
    assert.equal(calls.sends.length, 0);
    t.now += MIN;
    await tick(env, t, deps);
    assert.equal(env.q().hold.attempts[1].result, 'not-sent');
    assert.equal(calls.sends.length, 1);
    t.now += MIN;
    await tick(env, t, deps);
    assert.equal(env.item(TB).status, 'notify-failed');
    assert.equal(env.item(TB).holdRecord.attempts.length, 3);
    check4(env, calls, { hold: TC, sends: 2 });
    t.now += MIN;
    await tick(env, t, deps);
    check4(env, calls, { hold: TC, sends: 3 });
    assert.equal(env.q().hold.status, 'notified');
  } finally { env.cleanup(); }
});

test('U5 确认时留位已被划掉：不改状态，记“取消后才送达的通知”', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const { deps, calls } = makeDeps(t, { send: [async () => {
      assert.equal(skipQueued({ lockPath: env.lockPath, threadId: TB, why: '不用了', now: t.now }).ok, true);
      return { kind: 'sent', messageId: msgId(t.now) };
    }] });
    await tick(env, t, deps);
    assert.equal(env.item(TB).status, 'cancelled');
    assert.ok(env.q().anomalies.some((a) => a.kind === '取消后才送达的通知' && a.detail.includes('Q0001')));
    check4(env, calls, { hold: TC, sends: 1 });
    assert.equal(env.q().hold.status, 'pending', 'C 的留位没被这条迟到的结果改动');
  } finally { env.cleanup(); }
});

test('U6 已有留位时再次放锁、再跑 next：不另挑人，不发送', () => {
  const env = qenv();
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const before = JSON.stringify(env.q().hold);
    assert.equal(release(env, TA, T0 + 11_000).message, '现在没有锁。');
    const next = selectNextCommand({ lockPath: env.lockPath, now: T0 + 12_000 });
    assert.match(next.message, /已经留给排在前面的那位/);
    assert.equal(JSON.stringify(env.q().hold), before);
    assert.equal(env.q().counter, 1);
  } finally { env.cleanup(); }
});

test('U7 留位是 B 时取消排后面的 C：B 的留位不动，不发送', () => {
  const env = qenv();
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const before = JSON.stringify(env.q().hold);
    assert.equal(skipQueued({ lockPath: env.lockPath, threadId: TC, why: '不用了', now: T0 + 12_000 }).ok, true);
    assert.equal(JSON.stringify(env.q().hold), before);
    assert.equal(env.item(TC).status, 'cancelled');
  } finally { env.cleanup(); }
});

test('U8 取消留位那一位 B：留位清掉，C 被选中', () => {
  const env = qenv();
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const r = skipQueued({ lockPath: env.lockPath, threadId: TB, why: '完成', now: T0 + 12_000 });
    assert.match(r.message, /排给下一位.*Q0002/);
    assert.equal(env.item(TB).endReason, '完成');
    assert.equal(env.q().hold.threadId, TC);
  } finally { env.cleanup(); }
});

test('U9 推进时 B 已接：只核对，不发送', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    assert.equal(access(env, TB, T0 + 15_000).allow, true);
    assert.equal(env.item(TB).status, 'taken');
    const { deps, calls } = makeDeps(t);
    const r = await tick(env, t, deps);
    assert.equal(r.output, 'NO_REPLY');
    check4(env, calls, { hold: null, sends: 0 });
    assert.equal(calls.reads.length, 0);
  } finally { env.cleanup(); }
});

test('U10 “已通知”未到让位时刻（含 60 秒容差）：不过号；容差只往后延，不会提前', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const { deps, calls } = makeDeps(t);
    await tick(env, t, deps);
    const hold = env.q().hold;
    assert.equal(hold.status, 'notified');
    assert.equal(hold.yieldAt, timeFromId(hold.messageId) + 15 * MIN);
    t.now = hold.yieldAt - 1;
    await tick(env, t, deps);
    assert.equal(env.q().hold.threadId, TB);
    t.now = hold.yieldAt + 59_999;
    await tick(env, t, deps);
    assert.equal(env.q().hold.threadId, TB, '60 秒容差内仍不过号');
    check4(env, calls, { hold: TB, sends: 1 });
  } finally { env.cleanup(); }
});

test('U11 已到让位时刻：B 过号（保留、不占队列），C 被选中', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const { deps, calls } = makeDeps(t);
    await tick(env, t, deps);
    t.now = env.q().hold.yieldAt + 60_000;
    await tick(env, t, deps);
    assert.equal(env.item(TB).status, 'expired');
    assert.ok(env.q().items.some((i) => i.threadId === TB), '过号的件保留在文件里');
    check4(env, calls, { hold: TC, sends: 2 });
  } finally { env.cleanup(); }
});

test('U12 过号的 B 再来：当新的一件排到末尾', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    access(env, TD, T0 + 3000);
    release(env, TA, T0 + 10_000);
    const { deps } = makeDeps(t);
    await tick(env, t, deps);
    t.now = env.q().hold.yieldAt + 60_000;
    await tick(env, t, deps);
    const back = access(env, TB, t.now + 1000);
    assert.equal(back.allow, false);
    const bs = env.q().items.filter((i) => i.threadId === TB);
    assert.deepEqual(bs.map((i) => i.status), ['expired', 'waiting']);
    assert.match(back.reason, /前面还有 2 件/, '留位 C 算 1 件，D 排在前面');
  } finally { env.cleanup(); }
});

test('U13 留位那一位来拿锁（含过了让位时刻但 tick 还没处理）：放行（无标记时），“已接”', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const { deps } = makeDeps(t);
    await tick(env, t, deps);
    const late = env.q().hold.yieldAt + 10 * MIN;
    assert.equal(access(env, TB, late).allow, true);
    assert.equal(env.item(TB).status, 'taken');
    assert.equal(env.q().hold, null);
    assert.equal(readLock(env.lockPath).threadId, TB);
  } finally { env.cleanup(); }
});

test('U14 留位期间别人来：排末尾，不放行', () => {
  const env = qenv();
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const d = access(env, TD, T0 + 11_000);
    assert.equal(d.allow, false);
    assert.match(d.reason, /屏幕留给排在前面的那位了/);
    assert.match(d.reason, /前面还有 2 件/);
    assert.equal(existsSync(env.lockPath), false);
    assert.equal(env.q().hold.threadId, TB);
  } finally { env.cleanup(); }
});

test('U15 选中的那件没有请求方编号：记“待补资料”，跳到下一位，不发 <@未记录>；note 补上后回到原位置', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    assert.equal(access(env, TA, T0).allow, true);
    const b = access(env, TB, T0 + 1000, { noRequester: true });
    assert.match(b.reason, /note --thread 100000000000000150 --message <点名你的那条消息的编号> --requester/);
    access(env, TC, T0 + 2000);
    access(env, TD, T0 + 3000);
    release(env, TA, T0 + 10_000);
    assert.equal(env.item(TB).status, 'needs-info');
    assert.equal(env.q().hold.threadId, TC);
    const { deps, calls } = makeDeps(t);
    await tick(env, t, deps);
    assert.match(calls.sends[0].message, /^<@100000000000000156> /);
    assert.doesNotMatch(calls.sends[0].message, /未记录|<@null>|<@undefined>/);
    const n = noteQueued({ lockPath: env.lockPath, threadId: TB, requester: '100000000000000155', message: '100000000000000140', now: t.now });
    assert.equal(n.ok, true);
    assert.equal(env.item(TB).status, 'waiting');
    assert.equal(env.item(TB).queuedAt, T0 + 1000, '原排上时刻不变');
    assert.equal(access(env, TC, t.now + 1000).allow, true);
    release(env, TC, t.now + 2000);
    assert.equal(env.q().hold.threadId, TB, 'B 回到原位置，排在 D 前面');
  } finally { env.cleanup(); }
});

test('U16 锁是“等确认”：tick、next 都不动锁、不挑人；永不被判旧锁', async () => {
  const env = qenv();
  const t = { now: T0 + 5 * 3600_000 };
  try {
    access(env, TA, T0);
    holdForConfirmation({ lockPath: env.lockPath, threadId: TA, now: T0 + 1000 });
    access(env, TB, T0 + 2000);
    const { deps, calls } = makeDeps(t);
    await tick(env, t, deps);
    assert.match(selectNextCommand({ lockPath: env.lockPath, now: t.now }).message, /锁还有效/);
    assert.equal(readLock(env.lockPath).state, 'waiting');
    assert.equal(env.q().sceneCheck, null);
    check4(env, calls, { hold: null, sends: 0 });
    assert.match(access(env, TC, t.now).reason, /等主人确认/);
  } finally { env.cleanup(); }
});

test('U17 旧锁、名单里有人等、来的不是第一个：来的人排末尾；tick 把旧锁改名留底、立现场待检查标记、选第一个', async () => {
  const env = qenv();
  const t = { now: T0 + IDLE_STALE_MS + 1000 };
  try {
    queueABC(env);
    const d = access(env, TD, t.now);
    assert.equal(d.allow, false);
    assert.match(d.reason, /前面还有人在等/);
    assert.equal(readLock(env.lockPath).threadId, TA, '来的不是第一个，旧锁不在这时挪');
    const { deps, calls } = makeDeps(t);
    await tick(env, t, deps);
    assert.equal(existsSync(env.lockPath), false);
    assert.equal(readdirSync(env.dir).filter((n) => n.startsWith('screen.lock.stale-')).length, 1);
    assert.equal(env.q().sceneCheck.oldThreadId, TA);
    check4(env, calls, { hold: TB, sends: 1 });
  } finally { env.cleanup(); }
});

test('U18 名单文件读不懂：不覆盖，锁照旧挡，提示退回旧说法', () => {
  const env = qenv();
  try {
    access(env, TA, T0);
    writeFileSync(env.queuePath, '{坏的名单');
    const b = access(env, TB, T0 + 1000);
    assert.equal(b.allow, false);
    assert.match(b.reason, /我在别处忙，好了再叫我/);
    assert.match(b.reason, /等候名单读不懂/);
    assert.equal(readFileSync(env.queuePath, 'utf8'), '{坏的名单');
    release(env, TA, T0 + 2000);
    const c = access(env, TC, T0 + 3000);
    assert.equal(c.allow, false, '锁空着、看不出现场有没有检查过：宁可先挡');
    assert.match(c.reason, /等候名单读不懂/);
    assert.equal(readFileSync(env.queuePath, 'utf8'), '{坏的名单');
  } finally { env.cleanup(); }
});

test('U19 两个线程同时被挡（固定在读完名单、写名单之前）：两件都在，不丢不重', async () => {
  const env = qenv();
  try {
    access(env, TA, T0);
    const marker = join(env.dir, 'b-read');
    const b = child({ fn: 'checkScreenAccess', args: { lockPath: env.lockPath, sessionKey: sk(TB), requester: REQ[TB], now: T0 + 1000 }, hook: { name: 'afterQueueRead', marker, sleepMs: 500 } });
    await waitFor(marker);
    const c = child({ fn: 'checkScreenAccess', args: { lockPath: env.lockPath, sessionKey: sk(TC), requester: REQ[TC], now: T0 + 1001 } });
    const [rb, rc] = await Promise.all([b, c]);
    assert.equal(rb.code, 0, rb.err);
    assert.equal(rc.code, 0, rc.err);
    assert.deepEqual(env.q().items.map((i) => i.threadId), [TB, TC]);
    assert.match(rc.result.reason, /前面还有 2 件/);
  } finally { env.cleanup(); }
});

test('U20 放锁和挡下交错：B 要么排上并被选中，要么在名单里等下一次', async () => {
  const env = qenv();
  try {
    access(env, TA, T0);
    access(env, TC, T0 + 500);
    const marker = join(env.dir, 'release-marked');
    const r = child({ fn: 'releaseLock', args: { lockPath: env.lockPath, threadId: TA, now: T0 + 1000 }, hook: { name: 'afterReleaseMarked', marker, sleepMs: 500 } });
    await waitFor(marker);
    const b = child({ fn: 'checkScreenAccess', args: { lockPath: env.lockPath, sessionKey: sk(TB), requester: REQ[TB], now: T0 + 1001 } });
    const [rr, rb] = await Promise.all([r, b]);
    assert.equal(rr.code, 0, rr.err);
    assert.equal(rb.code, 0, rb.err);
    assert.ok(rb.finished >= rr.finished);
    const q = env.q();
    assert.equal(q.hold.threadId, TC);
    assert.equal(env.item(TB).status, 'waiting');
    assert.equal(rb.result.allow, false);
    assert.equal(q.inProgress, null);
  } finally { env.cleanup(); }
});

test('U21/UB4 恢复：放锁删锁前断、删锁后断；拿锁建锁后、记“已接”前断——都由 tick 进来补齐，结果和没断一样', async () => {
  const crash = () => { throw new Error('模拟中途断了'); };
  for (const point of ['afterReleaseMarked', 'afterLockDeleted']) {
    const env = qenv();
    const t = { now: T0 + 20_000 };
    try {
      queueABC(env);
      assert.throws(() => release(env, TA, T0 + 10_000, { [point]: crash }), /模拟中途断了/);
      assert.equal(env.q().inProgress.kind, 'releasing');
      const { deps, calls } = makeDeps(t);
      await tick(env, t, deps);
      assert.equal(existsSync(env.lockPath), false, `${point}：A 的锁已删`);
      assert.equal(env.q().inProgress, null);
      check4(env, calls, { hold: TB, sends: 1 });
    } finally { env.cleanup(); }
  }
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    assert.throws(() => access(env, TB, T0 + 12_000, { hooks: { afterLockCreated: crash } }), /模拟中途断了/);
    assert.equal(readLock(env.lockPath).threadId, TB);
    assert.equal(env.q().hold.threadId, TB);
    const { deps, calls } = makeDeps(t);
    await tick(env, t, deps);
    assert.equal(env.item(TB).status, 'taken');
    check4(env, calls, { hold: null, sends: 0 });
  } finally { env.cleanup(); }
});

test('U22 设置：四个值都读；settings 命令原子替换（写临时文件后、改名前读到旧的完整内容）；值不合法被拒、文件不变', () => {
  const env = qenv();
  try {
    rmSync(env.settingsPath);
    const created = updateSettings({ lockPath: env.lockPath, sets: ['paused=false'] });
    assert.equal(created.ok, true);
    assert.deepEqual(readSettings(env.settingsPath).values, { holdMinutes: 15, confirmMinutes: 5, maxNotifyAttempts: 3, paused: false });
    const old = readFileSync(env.settingsPath, 'utf8');
    let seen;
    const changed = updateSettings({ lockPath: env.lockPath, sets: ['holdMinutes=2', 'maxNotifyAttempts=4'], _hooks: { afterTempWrite: () => { seen = readFileSync(env.settingsPath, 'utf8'); } } });
    assert.equal(changed.ok, true);
    assert.equal(seen, old, '改名前读到的是旧的完整内容');
    assert.deepEqual(readSettings(env.settingsPath).values, { holdMinutes: 2, confirmMinutes: 5, maxNotifyAttempts: 4, paused: false });
    const now = readFileSync(env.settingsPath, 'utf8');
    for (const bad of [['holdMinutes=0'], ['holdMinutes=121'], ['paused=yes'], ['maxNotifyAttempts=11'], ['nope=1'], ['holdMinutes=1.5']]) {
      assert.equal(updateSettings({ lockPath: env.lockPath, sets: bad }).ok, false, bad.join());
      assert.equal(readFileSync(env.settingsPath, 'utf8'), now);
    }
    writeFileSync(env.settingsPath, '{坏的');
    const broken = updateSettings({ lockPath: env.lockPath, sets: ['paused=true'] });
    assert.equal(broken.ok, false);
    assert.match(broken.message, /没有改它，也没有用默认值覆盖/);
    assert.equal(readFileSync(env.settingsPath, 'utf8'), '{坏的');
    assert.deepEqual(readdirSync(env.dir).filter((n) => n.includes('.tmp-')), []);
  } finally { env.cleanup(); }
});

test('U23 skip 的 --why 不对；不在名单里的线程：报错或报“不在名单里”，名单不动', () => {
  const env = qenv();
  try {
    queueABC(env);
    const before = env.queueText();
    const wrong = skipQueued({ lockPath: env.lockPath, threadId: TB, why: '随便' });
    assert.equal(wrong.ok, false);
    assert.match(wrong.message, /--why 只能是/);
    const missing = skipQueued({ lockPath: env.lockPath, threadId: TE, why: '不用了' });
    assert.equal(missing.ok, false);
    assert.match(missing.message, /不在名单里/);
    assert.equal(env.queueText(), before);
  } finally { env.cleanup(); }
});

test('U24 尝试记录先于发送：写完尝试记录、发送前断——计数已加 1；“进行中”过了作废时刻按“可能已发出”处理，不再发', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const { deps, calls } = makeDeps(t);
    await assert.rejects(tick(env, t, deps, { afterAttemptRecorded: () => { throw new Error('模拟断在发送前'); } }), /模拟断在发送前/);
    const attempt = env.q().hold.attempts[0];
    assert.equal(attempt.result, 'in-progress');
    assert.equal(env.q().hold.attempts.length, 1);
    t.now += 151_000;
    await tick(env, t, deps);
    const hold = env.q().hold;
    assert.equal(hold.attempts[0].result, 'maybe-sent');
    assert.equal(hold.yieldAt, attempt.expiresAt + 15 * MIN);
    assert.equal(calls.reads.length > 0, true, '改成核查，不补发');
    check4(env, calls, { hold: TB, sends: 0 });
  } finally { env.cleanup(); }
});

test('U25 原通知在前几页之后（假读消息分三页返回、单页只给 50 条，编号按数值比，含跨位数的编号）：翻页读到它，按“确认发出”改记，不重发', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    // 补记的原请求消息编号比“选中时刻减 1 分钟”早，而且是 18 位：下限取它，从 18 位编号一路翻到 19 位编号
    assert.equal(noteQueued({ lockPath: env.lockPath, threadId: TB, message: '100000000000000159', now: T0 + 5000 }).ok, true);
    release(env, TA, T0 + 10_000);
    const { deps, calls } = makeDeps(t, { send: [{ kind: 'unknown', reason: '返回丢失（测试）' }] });
    await tick(env, t, deps);
    assert.equal(env.q().hold.attempts[0].result, 'maybe-sent');
    assert.equal(env.q().hold.requestMessageId, '100000000000000159');
    // 120 条消息：前 60 条编号是 18 位、后 60 条是 19 位，原通知是第 110 条
    const all = [];
    for (let i = 0; i < 60; i += 1) all.push({ id: String(100000000000000160n + BigInt(i)), authorId: '100000000000000012', content: `闲聊 ${i}` });
    for (let i = 0; i < 60; i += 1) all.push({ id: (BigInt(msgId(T0 + 15_000)) + BigInt(i)).toString(), authorId: i === 49 ? DESKTOP_USER_ID : '100000000000000012', content: i === 49 ? '<@100000000000000155> 轮到你了（排队号 Q0001）。' : `闲聊 ${60 + i}` });
    const pageReader = ({ after }) => ({ ok: true, messages: all.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, 50).reverse() });
    const lowered = { ...deps, read: async (args) => { calls.reads.push(args); return pageReader(args); } };
    t.now += MIN;
    await tick(env, t, lowered);
    const hold = env.q().hold;
    assert.equal(calls.reads[0].after, '100000000000000159');
    assert.equal(hold.status, 'notified');
    assert.equal(hold.messageId, all[109].id);
    assert.equal(hold.yieldAt, timeFromId(all[109].id) + 15 * MIN);
    assert.ok(calls.reads.length >= 3, `翻了 ${calls.reads.length} 页`);
    check4(env, calls, { hold: TB, sends: 1 });
  } finally { env.cleanup(); }
});

test('U26 读到一半失败、权限不足、游标不前进、时钟偏差：记“读不全”或“时钟异常”，不发送；连续 3 轮读不全只记异常，不让位', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const lower = () => idFromTime(env.q().hold.selectedAt - 60_000);
    const { deps, calls } = makeDeps(t, {
      send: [{ kind: 'unknown', reason: '超时（测试）' }],
      read: [
        () => ({ ok: true, messages: [{ id: msgId(T0 + 11_000), authorId: '1', content: 'x' }] }),
        { ok: false, error: '读到一半网络断了（测试）' },
        { ok: false, error: 'Missing Access（权限不足，测试）' },
        () => ({ ok: true, messages: [{ id: lower(), authorId: '1', content: '游标不前进' }] }),
        () => ({ ok: true, messages: [{ id: msgId(t.now + 10 * MIN), authorId: '1', content: '来自未来的消息' }] }),
      ],
    });
    await tick(env, t, deps);
    for (let round = 0; round < 4; round += 1) {
      t.now += MIN;
      await tick(env, t, deps);
    }
    const q = env.q();
    assert.equal(q.hold.status, 'pending', '没让位');
    assert.equal(q.hold.readIncompleteTotal, 4);
    assert.equal(q.anomalies.filter((a) => a.kind === '通知核查连续读不全').length, 1);
    assert.equal(q.anomalies.filter((a) => a.kind === '时钟异常').length, 1);
    check4(env, calls, { hold: TB, sends: 1 });
  } finally { env.cleanup(); }
});

test('U27 发送超时被杀、返回丢失：记“可能已发出”，不补发；让位时刻＝那次尝试作废时刻＋15 分钟', async () => {
  for (const reason of ['发送超时，子进程已被结束（测试）', '返回里读不出编号（测试）']) {
    const env = qenv();
    const t = { now: T0 + 20_000 };
    try {
      queueABC(env);
      release(env, TA, T0 + 10_000);
      const { deps, calls } = makeDeps(t, { send: [{ kind: 'unknown', reason }] });
      await tick(env, t, deps);
      const hold = env.q().hold;
      assert.equal(hold.attempts[0].result, 'maybe-sent');
      assert.equal(hold.yieldAt, hold.attempts[0].expiresAt + 15 * MIN);
      t.now += MIN;
      await tick(env, t, deps);
      check4(env, calls, { hold: TB, sends: 1 });
      t.now = hold.yieldAt + 60_000;
      await tick(env, t, deps);
      assert.equal(env.item(TB).status, 'notify-unknown');
      assert.ok(env.q().anomalies.some((a) => a.kind === '通知结果未定'));
      check4(env, calls, { hold: TC, sends: 2 });
    } finally { env.cleanup(); }
  }
});

test('U28 原发送还没结束（尝试“进行中”、未过作废时刻），另一个推进入口进来：拿不到租约，不发送、不核查', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const { deps, calls } = makeDeps(t);
    let second;
    await tick(env, t, deps, { afterAttemptRecorded: async () => {
      t.now += 10_000;
      second = await tick(env, t, deps);
    } });
    assert.equal(second.did, 'lease-busy');
    check4(env, calls, { hold: TB, sends: 1 });
    assert.equal(calls.reads.length, 0);
  } finally { env.cleanup(); }
});

test('U29 请求方收到通知马上拿锁，确认回写才到：正常“已接”，补记消息编号，不记异常', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const id = msgId(T0 + 20_000);
    const { deps, calls } = makeDeps(t, { send: [async () => {
      assert.equal(access(env, TB, t.now + 500).allow, true);
      return { kind: 'sent', messageId: id };
    }] });
    await tick(env, t, deps);
    assert.equal(env.item(TB).status, 'taken');
    assert.equal(env.item(TB).holdRecord.messageId, id);
    assert.equal(env.q().anomalies.length, 0);
    check4(env, calls, { hold: null, sends: 1 });
  } finally { env.cleanup(); }
});

test('U30 推进租约：两个推进入口交错（固定在拿租约后）；过时的入口回来写结果——第二个退出；过时的结果被丢弃，锁日志有一行', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const { deps, calls } = makeDeps(t);
    let second;
    let third;
    await tick(env, t, deps, {
      afterLeaseTaken: async () => { second = await tick(env, t, deps); },
      beforeWriteResult: async () => {
        t.now += 151_000;
        third = await tick(env, t, deps);
      },
    });
    assert.equal(second.did, 'lease-busy');
    assert.equal(third.did, 'verify-complete-not-found', '接管的推进只核查，不另发');
    const hold = env.q().hold;
    assert.equal(hold.status, 'pending', '过时的“确认发出”被丢弃');
    assert.equal(hold.attempts[0].result, 'maybe-sent');
    assert.match(env.log(), /过时的推进，已停手/);
    check4(env, calls, { hold: TB, sends: 1 });
  } finally { env.cleanup(); }
});

test('U31 暂停开关：暂停时不选人、不发送、不核查、不动任务；插件退回旧做法；release 照常放锁、不选人；关掉后照常', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    env.setSettings({ paused: true });
    const before = env.queueText();
    const d = access(env, TD, T0 + 3000);
    assert.match(d.reason, /我在别处忙，好了再叫我/);
    assert.doesNotMatch(d.reason, /排上了/);
    const r = release(env, TA, T0 + 10_000);
    assert.equal(r.message, '已放锁。');
    assert.match(r.queueNote, /排队暂停中/);
    const { deps, calls } = makeDeps(t);
    assert.equal((await tick(env, t, deps)).did, 'paused');
    assert.match(selectNextCommand({ lockPath: env.lockPath, now: t.now }).message, /暂停/);
    assert.equal(env.queueText(), before);
    check4(env, calls, { hold: null, sends: 0 });
    env.setSettings({ paused: false });
    await tick(env, t, deps);
    check4(env, calls, { hold: TB, sends: 1 });
  } finally { env.cleanup(); }
});

test('U32 旧 tick 停顿、租约被接管后恢复：旧 tick 发前核对不过（令牌不是自己的），不发；新 tick 没另发；全程最多一条点名', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const { deps, calls } = makeDeps(t);
    let fresh2;
    const old = await tick(env, t, deps, { afterAttemptRecorded: async () => {
      t.now += 151_000;
      fresh2 = await tick(env, t, deps);
    } });
    assert.match(old.did, /send-skipped.*推进租约不是自己的/);
    assert.equal(fresh2.did, 'verify-complete-not-found');
    assert.equal(env.q().hold.attempts[0].result, 'maybe-sent');
    check4(env, calls, { hold: TB, sends: 0 });
    assert.match(env.log(), /过时的推进，已停手/);
  } finally { env.cleanup(); }
});

test('U33 发送已交出去、但消息晚于查询才出现：第一轮“读全了、没有”仍是“结果未定”、不补发；第二轮找到，按消息时间改记“已通知”', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const late = msgId(T0 + 50_000);
    const { deps, calls } = makeDeps(t, {
      send: [{ kind: 'unknown', reason: '超时（测试）' }],
      read: [
        { ok: true, messages: [] },
        { ok: true, messages: [{ id: late, authorId: DESKTOP_USER_ID, content: '轮到你了（排队号 Q0001）' }] },
      ],
    });
    await tick(env, t, deps);
    t.now += MIN;
    await tick(env, t, deps);
    assert.equal(env.q().hold.status, 'pending');
    assert.equal(env.q().hold.fullNotFound, 1);
    t.now += MIN;
    await tick(env, t, deps);
    const hold = env.q().hold;
    assert.equal(hold.status, 'notified');
    assert.equal(hold.yieldAt, timeFromId(late) + 15 * MIN);
    check4(env, calls, { hold: TB, sends: 1 });
  } finally { env.cleanup(); }
});

test('U34 通知实际送达却连续读不全，请求方在 15 分钟内回来：3 轮读不全只记异常；回来拿锁时留位还是它，放行、“已接”', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const { deps, calls } = makeDeps(t, { send: [{ kind: 'unknown', reason: '超时（测试）' }], read: [{ ok: false, error: 'x' }, { ok: false, error: 'y' }, { ok: false, error: 'z' }] });
    await tick(env, t, deps);
    for (let i = 0; i < 3; i += 1) { t.now += 2 * MIN; await tick(env, t, deps); }
    assert.equal(env.q().anomalies.filter((a) => a.kind === '通知核查连续读不全').length, 1);
    assert.equal(env.q().hold.threadId, TB);
    assert.equal(access(env, TB, t.now + MIN).allow, true);
    assert.equal(env.item(TB).status, 'taken');
    check4(env, calls, { hold: null, sends: 1 });
  } finally { env.cleanup(); }
});

test('U35 暂停时名单里留着“放锁中”记录：插件、tick、选人都不做恢复，锁和名单原样不动', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    assert.throws(() => release(env, TA, T0 + 10_000, { afterReleaseMarked: () => { throw new Error('断'); } }));
    env.setSettings({ paused: true });
    const queueBefore = env.queueText();
    const lockBefore = readFileSync(env.lockPath, 'utf8');
    access(env, TD, T0 + 11_000);
    const { deps, calls } = makeDeps(t);
    await tick(env, t, deps);
    selectNextCommand({ lockPath: env.lockPath, now: t.now });
    assert.equal(env.queueText(), queueBefore);
    assert.equal(readFileSync(env.lockPath, 'utf8'), lockBefore);
    assert.equal(env.q().inProgress.kind, 'releasing');
    assert.equal(calls.sends.length + calls.reads.length, 0);
  } finally { env.cleanup(); }
});

test('U36 设置读不到有效值（文件不在、读不懂、值不合法三种）：不做恢复、不选人、不发送，插件退回旧做法，记“设置无效”', async () => {
  for (const breakIt of [(env) => rmSync(env.settingsPath), (env) => writeFileSync(env.settingsPath, '{坏'), (env) => env.setSettings({ holdMinutes: 0 })]) {
    const env = qenv();
    const t = { now: T0 + 20_000 };
    try {
      queueABC(env);
      breakIt(env);
      const before = env.queueText();
      const d = access(env, TD, T0 + 3000);
      assert.match(d.reason, /好了再叫我/);
      assert.match(d.reason, /排队设置读不到/);
      assert.equal(env.queueText(), before, '插件不改名单');
      const r = release(env, TA, T0 + 10_000);
      assert.match(r.queueNote, /排队设置读不到，没有排给下一位/);
      const { deps, calls } = makeDeps(t);
      await tick(env, t, deps);
      await tick(env, t, deps);
      const q = env.q();
      assert.equal(q.anomalies.filter((a) => a.kind === '设置无效').length, 1, '记一笔，不刷屏');
      assert.equal(q.hold, null);
      assert.equal(calls.sends.length + calls.reads.length, 0);
      assert.match(env.log(), /queue-settings-invalid/);
    } finally { env.cleanup(); }
  }
});

test('U37 暂停发生在发送准备阶段（记完尝试、发前核对之前把 paused 改成 true）：发前核对不过，不发；尝试记“未发出（发前核对没过）”', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const { deps, calls } = makeDeps(t);
    await tick(env, t, deps, { afterAttemptRecorded: () => env.setSettings({ paused: true }) });
    const attempt = env.q().hold.attempts[0];
    assert.equal(attempt.result, 'not-sent');
    assert.match(attempt.reason, /未发出（发前核对没过：暂停中/);
    check4(env, calls, { hold: TB, sends: 0 });
  } finally { env.cleanup(); }
});

test('U38 旧锁已挪走、标记还在时暂停或设置无效：B、C 来都被挡下，名单、标记、留位都没变；名单读不懂时同样挡下；先存标记、再挪旧锁之间断，下一次照常接管并给检查提示', async () => {
  const setup = async () => {
    const env = qenv();
    const t = { now: T0 + 30_000 };
    access(env, TA, T0);
    access(env, TB, T0 + 1000);
    access(env, TC, T0 + 2000);
    markRunEnded({ lockPath: env.lockPath, sessionKey: sk(TA), now: T0 + 3000 });
    t.now = T0 + 3000 + RUN_ENDED_GRACE_MS;
    const { deps } = makeDeps(t);
    await tick(env, t, deps);
    assert.ok(env.q().sceneCheck);
    assert.equal(env.q().hold.threadId, TB);
    assert.equal(existsSync(env.lockPath), false);
    return { env, t };
  };
  for (const mode of ['paused', 'invalid', 'paused+unreadable']) {
    const { env, t } = await setup();
    try {
      if (mode.startsWith('paused')) env.setSettings({ paused: true });
      else rmSync(env.settingsPath);
      if (mode.endsWith('unreadable')) writeFileSync(env.queuePath, '{坏');
      const before = env.queueText();
      for (const thread of [TB, TC]) {
        const v = access(env, thread, t.now + 1000);
        assert.equal(v.allow, false, `${mode}：${thread} 被挡`);
        assert.match(v.reason, /现场待处理/);
      }
      assert.equal(existsSync(env.lockPath), false, '不建锁');
      assert.equal(env.queueText(), before, '名单、标记、留位都没变');
    } finally { env.cleanup(); }
  }
  // 先存标记、再挪旧锁之间断
  const env = qenv();
  const t = { now: T0 + 30_000 };
  try {
    access(env, TA, T0);
    access(env, TB, T0 + 1000);
    markRunEnded({ lockPath: env.lockPath, sessionKey: sk(TA), now: T0 + 3000 });
    t.now = T0 + 3000 + RUN_ENDED_GRACE_MS;
    const { deps, calls } = makeDeps(t);
    await assert.rejects(tick(env, t, deps, { afterMarkSaved: () => { throw new Error('断在存完标记、挪旧锁之前'); } }));
    assert.ok(env.q().sceneCheck, '标记在');
    assert.equal(readLock(env.lockPath).threadId, TA, '旧锁还在');
    t.now += 151_000;
    await tick(env, t, deps);
    assert.equal(env.q().hold.threadId, TB);
    const first = access(env, TB, t.now + 1000);
    assert.equal(first.allow, false);
    assert.match(first.reason, /旧锁已失效.*截图/);
    assert.equal(env.q().sceneCheck, null);
    assert.equal(access(env, TB, t.now + 2000).allow, true);
    assert.equal(calls.sends.length, 1);
  } finally { env.cleanup(); }
});

test('U39 退回前没有锁、只有标记：status 不说“空闲”，说“现场待处理”', async () => {
  const env = qenv();
  const t = { now: T0 + IDLE_STALE_MS + 1000 };
  try {
    access(env, TA, T0);
    access(env, TB, T0 + 1000);
    const { deps } = makeDeps(t);
    await tick(env, t, deps);
    skipQueued({ lockPath: env.lockPath, threadId: TB, why: '不用了', now: t.now });
    assert.equal(existsSync(env.lockPath), false);
    const text = describeLock({ lockPath: env.lockPath });
    assert.doesNotMatch(text, /屏幕空着/);
    assert.match(text, /现场待处理/);
    const cli = spawnSync(process.execPath, [scriptPath, 'status', '--lock', env.lockPath], { encoding: 'utf8' });
    assert.match(cli.stdout, /现场待处理/);
    assert.match(cli.stdout, /现场待检查标记：有/);
  } finally { env.cleanup(); }
});

test('UB1 名单空时 tick：输出 NO_REPLY、退出码 0；业务文件都没改、没调发送和读消息', async () => {
  const env = qenv();
  const t = { now: T0 };
  try {
    const { deps, calls } = makeDeps(t);
    const r = await tick(env, t, deps);
    assert.deepEqual(r, { output: 'NO_REPLY', did: 'empty' });
    assert.equal(existsSync(env.queuePath), false);
    // 名单里只有已结束的件：同样不碰
    access(env, TA, T0);
    access(env, TB, T0 + 1000);
    skipQueued({ lockPath: env.lockPath, threadId: TB, why: '完成', now: T0 + 2000 });
    const files = [env.queuePath, env.settingsPath, env.lockPath];
    const before = files.map((f) => readFileSync(f, 'utf8'));
    const logBefore = env.log();
    assert.equal((await tick(env, t, deps)).did, 'empty');
    assert.deepEqual(files.map((f) => readFileSync(f, 'utf8')), before);
    assert.equal(env.log(), logBefore);
    assert.equal(calls.sends.length + calls.reads.length, 0);
    const cli = spawnSync(process.execPath, [scriptPath, 'tick', '--lock', env.lockPath], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout.trim(), 'NO_REPLY');
    assert.deepEqual(files.map((f) => readFileSync(f, 'utf8')), before);
  } finally { env.cleanup(); }
});

test('UB2 tick 推进链：release 选人不发；下一次 tick 发送、确认；到让位时刻的 tick 记过号、选下一位、同一次里给下一位发送', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const { deps, calls } = makeDeps(t);
    assert.equal(env.q().hold.attempts.length, 0);
    await tick(env, t, deps);
    assert.equal(env.q().hold.status, 'notified');
    assert.match(calls.sends[0].message, /^<@100000000000000155> 轮到你了.*（排队号 Q0001）.*给你留 15 分钟/);
    assert.equal(calls.sends[0].target, TB);
    t.now = env.q().hold.yieldAt + 60_000;
    await tick(env, t, deps);
    assert.equal(env.item(TB).status, 'expired');
    assert.equal(env.q().hold.status, 'notified');
    assert.match(calls.sends[1].message, /（排队号 Q0002）/);
    check4(env, calls, { hold: TC, sends: 2 });
  } finally { env.cleanup(); }
});

test('UB3 tick 看到锁失效＋有人等＋无留位：①挪旧锁、立标记、选第一位、发送；②第一位首次来被挡一次、提示看现场，第二次放行；③第一位取消后第二位首次来仍被提示；④“等确认”时什么都不挪', async () => {
  for (const variant of ['first-takes', 'first-cancels']) {
    const env = qenv();
    const t = { now: T0 + IDLE_STALE_MS + 1000 };
    try {
      queueABC(env);
      const { deps, calls } = makeDeps(t);
      await tick(env, t, deps);
      assert.equal(existsSync(env.lockPath), false);
      assert.ok(env.q().sceneCheck);
      check4(env, calls, { hold: TB, sends: 1 });
      const who = variant === 'first-takes' ? TB : TC;
      if (variant === 'first-cancels') {
        skipQueued({ lockPath: env.lockPath, threadId: TB, why: '不用了', now: t.now + 500 });
        assert.ok(env.q().sceneCheck, '标记跟着传给下一位');
        assert.equal(env.q().hold.threadId, TC);
      }
      const first = access(env, who, t.now + 1000);
      assert.equal(first.allow, false);
      assert.match(first.reason, /旧锁已失效.*先截图看屏幕现状/);
      assert.equal(env.q().sceneCheck, null);
      assert.equal(readLock(env.lockPath).threadId, who);
      assert.equal(access(env, who, t.now + 2000).allow, true);
    } finally { env.cleanup(); }
  }
  const env = qenv();
  const t = { now: T0 + 5 * 3600_000 };
  try {
    access(env, TA, T0);
    holdForConfirmation({ lockPath: env.lockPath, threadId: TA, now: T0 + 500 });
    access(env, TB, T0 + 1000);
    const { deps, calls } = makeDeps(t);
    await tick(env, t, deps);
    assert.equal(readLock(env.lockPath).threadId, TA);
    assert.equal(env.q().sceneCheck, null);
    check4(env, calls, { hold: null, sends: 0 });
  } finally { env.cleanup(); }
});

test('UB5 推进停了的提醒：名单不空且 lastTickAt 超过 10 分钟 → 挡下信息带提醒；名单空或 tick 新近跑过 → 不带', async () => {
  const env = qenv();
  const t = { now: T0 + 30_000 };
  try {
    access(env, TA, T0);
    assert.doesNotMatch(access(env, TB, T0 + 1000).reason, /排队推进好像停了/);
    assert.match(access(env, TC, T0 + 11 * MIN).reason, /排队推进好像停了/);
    t.now = T0 + 12 * MIN;
    const { deps } = makeDeps(t);
    await tick(env, t, deps);
    assert.doesNotMatch(access(env, TD, T0 + 13 * MIN).reason, /排队推进好像停了/);
  } finally { env.cleanup(); }
});

test('UB6 tick 内部出错：发送失败、读不全、名单读不懂、设置无效 → 退出码 0、记进名单或日志；代码异常 → 退出码非 0', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const { deps } = makeDeps(t, { send: [{ kind: 'not-sent', reason: '测试' }, { kind: 'unknown', reason: '测试' }], read: [{ ok: false, error: '测试' }] });
    assert.equal((await tick(env, t, deps)).output, 'NO_REPLY');
    t.now += MIN;
    assert.equal((await tick(env, t, deps)).output, 'NO_REPLY');
    t.now += MIN;
    assert.equal((await tick(env, t, deps)).did, 'verify-incomplete');
    const saved = env.queueText();
    writeFileSync(env.queuePath, '{坏');
    assert.equal((await tick(env, t, deps)).did, 'queue-unreadable');
    assert.match(env.log(), /tick-queue-unreadable/);
    writeFileSync(env.queuePath, saved);
    rmSync(env.settingsPath);
    assert.equal((await tick(env, t, deps)).did, 'settings-invalid');
    env.setSettings({});
    // 代码异常：锁文件位置是个目录，读锁抛错 → 命令行非零退出
    rmSync(env.lockPath, { force: true });
    mkdirSync(env.lockPath);
    const cli = spawnSync(process.execPath, [scriptPath, 'tick', '--lock', env.lockPath], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /tick 出错/);
  } finally { env.cleanup(); }
});

test('UB7 内部时限：一次 tick 里同一留位最多发一次；时限快到时不开始发送；时限到了还有子进程 → 先结束子进程、尝试记“可能已发出”、放租约', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    const { deps, calls } = makeDeps(t, { send: [{ kind: 'not-sent', reason: '测试' }] });
    await tick(env, t, deps);
    assert.equal(calls.sends.length, 1, '同一次 tick 不重发');
    t.now += MIN;
    await tick(env, t, deps, undefined, { budgetMs: 44_000 });
    assert.equal(calls.sends.length, 1, '剩余时间不够就不开始发送');
    assert.equal(env.q().hold.attempts.length, 1);
    let seenTimeout;
    const slow = { ...deps, send: async (args) => {
      calls.sends.push(args);
      seenTimeout = args.timeoutMs;
      t.now += args.timeoutMs + 5_000; // 子进程到时限被 SIGTERM、5 秒后 SIGKILL
      return { kind: 'unknown', reason: '发送超时，子进程已被结束' };
    } };
    t.now += MIN;
    await tick(env, t, slow, undefined, { budgetMs: 50_000 });
    assert.ok(seenTimeout <= 50_000 - 10_000 && seenTimeout <= 30_000, `子进程时限 ${seenTimeout}`);
    assert.equal(env.q().hold.attempts[1].result, 'maybe-sent');
    check4(env, calls, { hold: TB, sends: 2 });
  } finally { env.cleanup(); }
});

test('称呼：两个锁程序文件里没有“主人”', () => {
  for (const file of ['../plugins/personal-inbox/desktop-lock.mjs', '../scripts/desktop-lock.mjs']) {
    assert.doesNotMatch(readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'), /the owner/);
  }
});

test('status 的排队那一行：读出名单件数、留位、暂停、设置是否有效', () => {
  const env = qenv();
  try {
    queueABC(env);
    release(env, TA, T0 + 10_000);
    assert.match(describeQueueLine({ lockPath: env.lockPath }), /占队列 2 件；留位：Q0001（待通知/);
    env.setSettings({ paused: true });
    assert.match(describeQueueLine({ lockPath: env.lockPath }), /暂停：是/);
    rmSync(env.settingsPath);
    assert.match(describeQueueLine({ lockPath: env.lockPath }), /设置无效（设置文件不在）/);
  } finally { env.cleanup(); }
});

test('command paths come from config (paths.nodeBin / paths.openclawBin) even when OpenClaw sets OPENCLAW_CLI=1 for a child process', () => {
  const probe = `import { OPENCLAW_BIN, NODE_BIN } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify({ OPENCLAW_BIN, NODE_BIN }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', env: { ...process.env, OPENCLAW_CLI: '1' } });
  assert.equal(run.status, 0, run.stderr);
  const got = JSON.parse(run.stdout.trim());
  assert.equal(got.OPENCLAW_BIN, crew.paths.openclawBin);
  assert.notEqual(got.OPENCLAW_BIN, '1');
  assert.ok(got.OPENCLAW_BIN.startsWith('/'), 'the test config uses a full path');
  assert.equal(got.NODE_BIN, crew.paths.nodeBin);
});

// ======================================================================
// 只有确实还是原来那把锁，才替它把放锁做完（原来能安全恢复的断点见 U21/UB4，照旧要过）。
// ======================================================================
test('U40 放锁删锁前断 → 同线程随后改“等确认” → 推进：锁还在、仍是“等确认”，不选人、不发送，冲突记进异常，放锁中记录清掉', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    assert.throws(() => release(env, TA, T0 + 10_000, { afterReleaseMarked: () => { throw new Error('断'); } }));
    assert.equal(env.q().inProgress.kind, 'releasing');
    assert.equal(holdForConfirmation({ lockPath: env.lockPath, threadId: TA, now: T0 + 11_000 }).ok, true);
    const { deps, calls } = makeDeps(t);
    await tick(env, t, deps);
    const lock = readLock(env.lockPath);
    assert.ok(lock, '锁还在');
    assert.equal(lock.threadId, TA);
    assert.equal(lock.state, 'waiting');
    const q = env.q();
    assert.equal(q.inProgress, null);
    assert.equal(env.item(TB).status, 'waiting');
    assert.equal(env.item(TC).status, 'waiting');
    check4(env, calls, { hold: null, sends: 0 });
    const conflict = q.anomalies.filter((a) => a.kind === '放锁中断后锁已变');
    assert.equal(conflict.length, 1);
    assert.equal(conflict[0].detail.threadId, TA);
    assert.equal(conflict[0].detail.now.state, 'waiting');
    // 再推进几轮：不重复记异常、锁一直在、不选人。
    t.now += 2 * MIN;
    await tick(env, t, deps);
    t.now += 2 * MIN;
    selectNextCommand({ lockPath: env.lockPath, now: t.now });
    assert.equal(readLock(env.lockPath).state, 'waiting');
    assert.equal(env.q().hold, null);
    assert.equal(env.q().anomalies.filter((a) => a.kind === '放锁中断后锁已变').length, 1);
    // 等主人确认后，同线程照常放锁：这时才交给 B。
    const r = release(env, TA, t.now + 1000);
    assert.equal(r.ok, true);
    assert.match(r.queueNote, /排队号 Q0001/);
    assert.equal(existsSync(env.lockPath), false);
    assert.equal(env.q().hold.threadId, TB);
  } finally { env.cleanup(); }
});

test('U41 同一组合换个入口：放锁中断 → 同线程改“等确认” → 别的线程来动屏幕、补资料、手动选人：锁都还在、不选人', () => {
  for (const enter of [
    (env) => { const d = access(env, TD, T0 + 12_000); assert.equal(d.allow, false); },
    (env) => { assert.equal(noteQueued({ lockPath: env.lockPath, logPath: env.logPath, threadId: TB, message: msgId(T0 + 500), now: T0 + 12_000 }).ok, true); },
    (env) => { selectNextCommand({ lockPath: env.lockPath, now: T0 + 12_000 }); },
  ]) {
    const env = qenv();
    try {
      queueABC(env);
      assert.throws(() => release(env, TA, T0 + 10_000, { afterReleaseMarked: () => { throw new Error('断'); } }));
      holdForConfirmation({ lockPath: env.lockPath, threadId: TA, now: T0 + 11_000 });
      enter(env);
      const lock = readLock(env.lockPath);
      assert.equal(lock?.threadId, TA);
      assert.equal(lock?.state, 'waiting');
      assert.equal(env.q().hold, null);
      assert.equal(env.q().inProgress, null);
      assert.equal(env.q().anomalies.filter((a) => a.kind === '放锁中断后锁已变').length, 1);
    } finally { env.cleanup(); }
  }
});

test('U42 锁变了的另外两种：①放锁中断后暂停，期间同线程照旧做事（最后动屏幕时刻变了），恢复排队再推进 → 锁保留；②旧格式“放锁中”记录（没记原锁）：锁是“等确认”保留，锁仍是“做事中”且之后没动过才替它删', async () => {
  {
    const env = qenv();
    const t = { now: T0 + 20_000 };
    try {
      queueABC(env);
      assert.throws(() => release(env, TA, T0 + 10_000, { afterReleaseMarked: () => { throw new Error('断'); } }));
      env.setSettings({ paused: true });
      assert.equal(access(env, TA, T0 + 12_000).allow, true);
      env.setSettings({ paused: false });
      const { deps, calls } = makeDeps(t);
      await tick(env, t, deps);
      assert.equal(readLock(env.lockPath)?.threadId, TA);
      check4(env, calls, { hold: null, sends: 0 });
      assert.equal(env.q().anomalies.filter((a) => a.kind === '放锁中断后锁已变').length, 1);
    } finally { env.cleanup(); }
  }
  for (const [state, expectKept] of [['waiting', true], ['working', false]]) {
    const env = qenv();
    const t = { now: T0 + 20_000 };
    try {
      queueABC(env);
      if (state === 'waiting') holdForConfirmation({ lockPath: env.lockPath, threadId: TA, now: T0 + 5000 });
      const q = env.q();
      q.inProgress = { kind: 'releasing', threadId: TA, at: T0 + 10_000 };
      writeFileSync(env.queuePath, JSON.stringify(q));
      const { deps, calls } = makeDeps(t);
      await tick(env, t, deps);
      assert.equal(existsSync(env.lockPath), expectKept, `${state}：锁${expectKept ? '保留' : '替它删掉'}`);
      assert.equal(env.q().inProgress, null);
      if (expectKept) check4(env, calls, { hold: null, sends: 0 });
      else check4(env, calls, { hold: TB, sends: 1 });
    } finally { env.cleanup(); }
  }
});

test('U43 放锁删锁前断 → 那一轮照常结束（只记“轮次已结束”，锁本身没变）→ 推进：仍算原来那把锁，替它删掉、选下一位，和没断一样', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueABC(env);
    assert.throws(() => release(env, TA, T0 + 10_000, { afterReleaseMarked: () => { throw new Error('断'); } }));
    markRunEnded({ lockPath: env.lockPath, sessionKey: sk(TA), now: T0 + 11_000 });
    assert.equal(readLock(env.lockPath).holderRunEnded, true);
    const { deps, calls } = makeDeps(t);
    await tick(env, t, deps);
    assert.equal(existsSync(env.lockPath), false);
    assert.equal(env.q().inProgress, null);
    assert.equal(env.q().anomalies.filter((a) => a.kind === '放锁中断后锁已变').length, 0);
    check4(env, calls, { hold: TB, sends: 1 });
  } finally { env.cleanup(); }
});

// ---- 第二段 3.12：六类操作要主人批准（官方审批）----
function gateWith(lockPath, extra = {}) {
  const gate = createScreenGate({ lockPath, logPath: null, now: () => T0 + 10_000 + (extra.dt ?? 0) });
  const ctx = { agentId: 'desktop', sessionKey: A, runId: 'r1' };
  return (toolName = 'computer') => gate({ toolName }, ctx);
}

test('六类审批：锁是“等确认”时再动屏幕 → 出审批；批准只放行这一次，用过即失效（再记等确认才再批）', () => {
  const { lockPath, cleanup } = fresh();
  try {
    const gate = gateWith(lockPath);
    assert.equal(gate(), undefined, '先拿锁，普通调用放行');
    holdForConfirmation({ lockPath, threadId: THREAD_A, what: '提交测试表单', now: T0 + 1000 });
    const r = gate();
    assert.ok(r.requireApproval, '出审批'); assert.equal(r.requireApproval.title, '六类操作确认');
    assert.match(r.requireApproval.description, /提交测试表单/);
    assert.deepEqual(r.requireApproval.allowedDecisions, ['allow-once', 'deny']);
    assert.equal(readLock(lockPath).state, 'waiting', '没批之前仍是等确认');
    // 
    // 批准：改回做事中
    r.requireApproval.onResolution('allow-once');
    assert.equal(readLock(lockPath).state, 'working');
    assert.equal(gate(), undefined, '批过以后同一流程里的普通调用不再弹');
    // 用过即失效：桌面角色下一项六类操作要重新记等确认、重新批
    holdForConfirmation({ lockPath, threadId: THREAD_A, what: '另一项提交', now: T0 + 2000 });
    const r2 = gate();
    assert.ok(r2.requireApproval);
    // 旧批准（旧指纹）不能用到这一项
    assert.equal(confirmHeldAccess({ lockPath, threadId: THREAD_A, fingerprint: r.requireApproval ? approvalFingerprint(THREAD_A, '提交测试表单', T0 + 1000) : 'x' }).ok, false);
    assert.equal(readLock(lockPath).state, 'waiting');
  } finally { cleanup(); }
});

test('六类审批：普通截图（没有等确认）不被挡；别的线程的锁、非桌面角色不受影响', () => {
  const { lockPath, cleanup } = fresh();
  try {
    const gate = gateWith(lockPath);
    assert.equal(gate(), undefined);
    assert.equal(gate('browser'), undefined);
    const other = createScreenGate({ lockPath, logPath: null, now: () => T0 + 10_000 });
    assert.equal(other({ toolName: 'computer' }, { agentId: 'worker-e', sessionKey: 'agent:worker-e:x' }), undefined, '非桌面角色不管');
  } finally { cleanup(); }
});

test('六类审批：批准通过时锁已经变了（放了锁／换了线程／重新记过等确认）→ 这次批准作废', () => {
  const { lockPath, cleanup } = fresh();
  try {
    const gate = gateWith(lockPath);
    gate();
    holdForConfirmation({ lockPath, threadId: THREAD_A, what: '甲事', now: T0 + 1000 });
    const r = gate();
    // 期间桌面角色重新记了一次等确认（换了事）→ 指纹对不上
    holdForConfirmation({ lockPath, threadId: THREAD_A, what: '乙事', now: T0 + 3000 });
    r.requireApproval.onResolution('allow-once');
    assert.equal(readLock(lockPath).state, 'waiting', '旧批准不能用到乙事');
    // 放锁后批准作废
    releaseLock({ lockPath, threadId: THREAD_A });
    r.requireApproval.onResolution('allow-once');
    assert.equal(readLock(lockPath), null);
  } finally { cleanup(); }
});

// ---------- 六类审批卡“来自哪张任务卡”要真有内容 ----------
import { findCardByThread } from '../plugins/personal-inbox/desktop-lock.mjs';

test('六类审批卡：线程里有任务卡 → 写卡号和卡名；找不到 → 写“没查到关联任务卡（线程 <编号>）”', () => {
  const { lockPath, cleanup } = fresh();
  try {
    const mk = (findCard) => { const gate = createScreenGate({ lockPath, logPath: null, now: () => T0 + 10_000, findCard }); const ctx = { agentId: 'desktop', sessionKey: A, runId: 'r1' }; return () => gate({ toolName: 'computer' }, ctx); };
    const g1 = mk((tid) => (tid === THREAD_A ? { id: 'card-123', title: '填测试表单' } : null));
    assert.equal(g1(), undefined);
    holdForConfirmation({ lockPath, threadId: THREAD_A, what: '提交测试表单', now: T0 + 1000 });
    const r1 = g1();
    assert.match(r1.requireApproval.description, /来自任务卡：card-123《填测试表单》/);
    assert.match(r1.requireApproval.description, /申请的 bot：桌面角色/);
    const g2 = mk(() => null);
    const r2 = g2();
    assert.match(r2.requireApproval.description, new RegExp(`没查到关联任务卡（线程 ${THREAD_A}）`));
    assert.doesNotMatch(r2.requireApproval.description, /不是从任务线程来的/);
  } finally { cleanup(); }
});

test('findCardByThread：按任务记录文件找（真实模板格式）——只认“Discord 线程链接”栏里精确等于线程编号的，再读同一份记录“任务卡号”栏里的那一个卡号；多份、卡号不唯一、一份都没有、正文里随便出现的编号都不算', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rec-'));
  const mkRec = (proj, name, body) => { const d = join(root, '项目', proj, '任务'); mkdirSync(d, { recursive: true }); writeFileSync(join(d, name), body); };
  const rec = (title, card, link, extra = '') => `# 任务记录：${title}

用法：一个 Discord 线程对应一张任务记录

## 目标

测试

## 成果位置

暂无${extra}

## 任务卡号

${card}

## Discord 线程链接

${link}

## 任务卡上的两栏（建 Workboard 卡时写）

正文
`;
  const CARD = 'aaaaaaaa-1111-4222-8333-444444444444';
  mkRec('甲项目', '有线程的.md', rec('有线程的', CARD, 'https://discord.com/channels/1/2/100000000000000141'));
  mkRec('甲项目', '线程暂无.md', rec('线程暂无', 'bbbbbbbb-1111-4222-8333-444444444444', '暂无（原线程已删除）'));
  mkRec('乙项目', '多卡号.md', rec('多卡号', 'cccccccc-1111-4222-8333-444444444444 和 dddddddd-1111-4222-8333-444444444444', 'https://discord.com/channels/1/2/100000000000000142'));
  mkRec('乙项目', '正文里写了线程.md', rec('正文提到', 'eeeeeeee-1111-4222-8333-444444444444', '暂无', '\n参考线程 100000000000000144'));
  mkRec('丙项目', '重复一.md', rec('重复一', 'ffffffff-1111-4222-8333-444444444444', 'https://discord.com/channels/1/2/100000000000000161'));
  mkRec('丙项目', '重复二.md', rec('重复二', '99999999-1111-4222-8333-444444444444', 'https://discord.com/channels/1/2/100000000000000161'));
  const dbPath = join(root, 'w.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE workboard_cards (id TEXT, title TEXT)');
  db.prepare('INSERT INTO workboard_cards VALUES (?,?)').run(CARD, '有线程的那张卡');
  db.close();
  const o = { dataRoot: root, dbPath };
  assert.deepEqual(findCardByThread('100000000000000141', o), { id: CARD, title: '有线程的那张卡', via: '任务记录' }, '线程栏精确匹配＋读同一份记录的卡号');
  assert.equal(findCardByThread('100000000000000142', o), null, '卡号栏有两个卡号 → 不挑');
  assert.equal(findCardByThread('100000000000000144', o), null, '编号只在别处的正文里出现 → 不认');
  assert.equal(findCardByThread('100000000000000161', o), null, '匹配到多份记录 → 不挑');
  assert.equal(findCardByThread('100000000000000143', o), null, '一份都没有');
  assert.equal(findCardByThread('12', o), null, '编号太短');
  assert.equal(findCardByThread('100000000000000141', { dataRoot: join(root, '不存在'), dbPath }), null, '读不了');
  assert.deepEqual(findCardByThread('100000000000000141', { dataRoot: root, dbPath: join(root, '没有库.sqlite') }), { id: CARD, title: null, via: '任务记录' }, '卡名读不到只写卡号');
  rmSync(root, { recursive: true, force: true });
});

// ---------- 先查程序自动记的“卡↔线程对应”，再查任务记录 ----------
import { cardTextOf } from '../plugins/personal-inbox/desktop-lock.mjs';

test('findCardByThread：先查自动对应表——唯一一张没结束的卡就用；已归档、已完成的不算；多张不挑；对应表没有再退到任务记录', async () => {
  const root = mkdtempSync(join(tmpdir(), 'map-'));
  const dbPath = join(root, 'w.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE workboard_cards (id TEXT, title TEXT, status TEXT, archived_at INTEGER)');
  const ins = db.prepare('INSERT INTO workboard_cards VALUES (?,?,?,?)');
  const C1 = '11111111-1111-4222-8333-444444444444', C2 = '22222222-1111-4222-8333-444444444444', C3 = '33333333-1111-4222-8333-444444444444', C4 = '44444444-1111-4222-8333-444444444444';
  ins.run(C1, '活的一', 'running', null); ins.run(C2, '已完成的', 'done', null); ins.run(C3, '已归档的', 'todo', 1794419322965); ins.run(C4, '活的二', 'todo', null);
  db.close();
  const T = (n) => `100000000000000162${String(n).padStart(2, '0')}`;
  const dir = join(root, '运行记录', '卡线程'); mkdirSync(dir, { recursive: true });
  const row = (threadId, cardId) => ({ threadId, cardId, via: ['claim'], agent: 'worker-e', firstAt: 'x', lastAt: 'x', n: 1 });
  const threads = Object.fromEntries([1, 2, 3, 4].map((n) => [T(n), { at: 'x', by: 'main' }]));
  writeFileSync(join(dir, '对应.json'), JSON.stringify({ version: 1, links: [row(T(1), C1), row(T(2), C1), row(T(2), C2), row(T(2), C3), row(T(3), C1), row(T(3), C4), row(T(4), C2), row(T(5), C1), { ...row(T(6), C4), via: ['开线程首帖'] }], threads }));
  const o = { dataRoot: root, dbPath };
  assert.deepEqual(findCardByThread(T(1), o), { id: C1, title: '活的一', via: '自动对应' });
  assert.deepEqual(findCardByThread(T(2), o), { id: C1, title: '活的一', via: '自动对应' }, '已完成、已归档的旧卡不算，剩一张');
  const amb = findCardByThread(T(3), o);
  assert.deepEqual(amb.ambiguous.map((c) => c.id), [C1, C4], '两张都没结束 → 不挑');
  assert.equal(findCardByThread(T(4), o), null, '只对着已完成的卡 → 当没有');
  assert.equal(findCardByThread(T(5), o), null, '编号不是已知的线程（可能是项目频道主区域）→ 不用，免得把频道挂到卡上');
  assert.equal(findCardByThread(T(6), o)?.id, C4, '虽然不在 threads 里，但这条是开线程时记的 → 认（旧格式兼容）');
  assert.match(cardTextOf(amb, T(3)), /对应多张还没结束的卡.*活的一.*活的二.*没法确定是哪张（线程/);
  assert.equal(cardTextOf(null, T(9)), `没查到关联任务卡（线程 ${T(9)}）`);
  // 对应表优先于任务记录：任务记录里写了另一张卡，也先用对应表
  const d = join(root, '项目', '甲', '任务'); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'x.md'), `# x\n\n## 任务卡号\n\n${C4}\n\n## Discord 线程链接\n\nhttps://discord.com/channels/1/2/${T(1)}\n`);
  assert.equal(findCardByThread(T(1), o).id, C1, '先查对应表');
  assert.equal(findCardByThread(T(4), o)?.id, undefined, '对应表里只剩已完成的卡 → 退到任务记录（这里任务记录没有这个线程）');
  writeFileSync(join(dir, '对应.json'), '坏的{');
  assert.deepEqual(findCardByThread(T(1), o), { id: C4, title: '活的二', via: '任务记录' }, '对应表读不了 → 退到任务记录');
  rmSync(root, { recursive: true, force: true });
});

test('六类审批卡：对应表里同一线程对着多张卡 → 卡上写“对应多张…没法确定”', () => {
  const { lockPath, cleanup } = fresh();
  try {
    const gate = createScreenGate({ lockPath, logPath: null, now: () => T0 + 10_000, findCard: () => ({ ambiguous: [{ id: 'c-1', title: '甲' }, { id: 'c-2', title: null }] }) });
    const ctx = { agentId: 'desktop', sessionKey: A, runId: 'r1' };
    const call = () => gate({ toolName: 'computer' }, ctx);
    assert.equal(call(), undefined);
    holdForConfirmation({ lockPath, threadId: THREAD_A, what: '提交测试表单', now: T0 + 1000 });
    const r = call();
    assert.match(r.requireApproval.description, /来自任务卡：这个线程对应多张还没结束的卡（c-1《甲》、c-2），没法确定是哪张/);
  } finally { cleanup(); }
});

// ======================================================================
// 桌面角色排队直接接续小批：请求方是主人本人时，通知改由总控账号发、点名桌面角色；过号时点名他。
// ======================================================================
import { OWNER_USER_ID, CONTROLLER_USER_ID, CONTROLLER_ACCOUNT, expiredNoticeText, notifyText, sendRouteFor, findMarkedMessage } from '../plugins/personal-inbox/desktop-lock.mjs';
import { OWNER_ID } from '../plugins/personal-inbox/pending-ledger.mjs';

const TF = '100000000000000163';
const OWNER_REQ = { senderId: OWNER_USER_ID, accountId: 'default', senderIsOwner: true };
// A 拿着锁，B 被主人本人（或别的 bot）叫来排队。
function queueFor(env, requesterOfB, t0 = T0) {
  assert.equal(access(env, TA, t0).allow, true);
  const b = checkScreenAccess({ lockPath: env.lockPath, logPath: env.logPath, sessionKey: sk(TB), requester: requesterOfB, now: t0 + 1000 });
  assert.equal(b.allow, false);
  release(env, TA, t0 + 10_000);
}
const abrDeps = (t, opts) => makeDeps(t, opts);

test('D1-1 编号：主人的编号和 pending-ledger 的 OWNER_ID 一样；总控编号、发送账号写死对', () => {
  assert.equal(OWNER_USER_ID, OWNER_ID);
  assert.equal(CONTROLLER_USER_ID, '100000000000000011');
  assert.equal(CONTROLLER_ACCOUNT, 'default');
  assert.deepEqual(sendRouteFor(OWNER_USER_ID), { account: 'default', authorId: CONTROLLER_USER_ID, wakesDesktop: true });
  assert.deepEqual(sendRouteFor('100000000000000155'), { account: 'desktop', authorId: DESKTOP_USER_ID, wakesDesktop: false });
});

test('D1-2 请求方是主人：总控账号发，点名桌面角色、不点名主人和总控，排队号标记逐字保留，写明不用回复', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueFor(env, OWNER_REQ);
    const { deps, calls } = abrDeps(t);
    await tick(env, t, deps);
    assert.equal(calls.sends.length, 1);
    const s = calls.sends[0];
    assert.equal(s.account, 'default');
    assert.equal(s.target, TB);
    assert.ok(s.message.startsWith(`<@${DESKTOP_USER_ID}> 轮到你了`));
    assert.ok(s.message.includes('（排队号 Q0001）'));
    assert.ok(!s.message.includes(`<@${OWNER_USER_ID}>`), '不点名主人');
    assert.ok(!s.message.includes(`<@${CONTROLLER_USER_ID}>`), '不点名总控');
    assert.match(s.message, /不用回复、不要点名总控/);
    assert.match(s.message, /不用他再说一遍/);
    assert.match(s.message, new RegExp(`skip --thread ${TB} --why 不用了`));
    assert.match(s.message, /六类操作.*照旧停下等他，这条通知不是新授权/);
    assert.match(s.message, /给你留 15 分钟/);
    assert.equal(env.q().hold.status, 'notified');
    assert.match(env.log(), /"account":"default"/);
  } finally { env.cleanup(); }
});

test('D1-3 请求方是别的 bot：与改前逐字相同——桌面角色账号（不带 account 参数）、点名请求方', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueFor(env, REQ[TB]);
    const { deps, calls } = abrDeps(t);
    await tick(env, t, deps);
    assert.equal(calls.sends.length, 1);
    assert.deepEqual(Object.keys(calls.sends[0]).sort(), ['at', 'message', 'target', 'timeoutMs'], '调用参数没有多出 account');
    assert.equal(calls.sends[0].message, `<@${REQ[TB].senderId}> 轮到你了：你 ${calls.sends[0].message.match(/你 (.+?) 在这里/)[1]} 在这里叫我做的事，现在屏幕空了（排队号 Q0001）。先重读任务记录的“当前状态”，还要做就在这个线程重新点名我、把事情再说一遍；不用了就点名我说“不用了”。给你留 15 分钟，过了就让给下一位，之后还要做再叫我、重新排。这只是通知，不是新授权。`);
    assert.match(env.log(), /"account":"desktop"/);
  } finally { env.cleanup(); }
});

test('D1-4主人的件“发送结果读不出”：按总控账号找标记消息；桌面角色账号发的同标记消息不认', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueFor(env, OWNER_REQ);
    const found = msgId(T0 + 20_500);
    const fake = msgId(T0 + 20_400);
    const { deps, calls } = abrDeps(t, {
      send: [{ kind: 'unknown', reason: '发送结果读不出（测试）' }],
      read: [{ ok: true, messages: [{ id: fake, authorId: DESKTOP_USER_ID, content: '（排队号 Q0001）冒牌' }] }, { ok: true, messages: [] }],
    });
    await tick(env, t, deps);
    assert.equal(env.q().hold.status, 'pending');
    t.now += 120_000;
    // 第一页只有桌面角色账号发的同标记消息 → 不算；第二页读空 → 没找到
    await tick(env, t, deps);
    assert.equal(env.q().hold.status, 'pending', '桌面角色账号发的不算');
    // 再来一次：总控账号发的带标记消息 → 认
    t.now += 120_000;
    const { deps: deps2 } = abrDeps(t, { read: [{ ok: true, messages: [{ id: found, authorId: CONTROLLER_USER_ID, content: '<@100000000000000012> 轮到你了 （排队号 Q0001）' }] }] });
    await tick(env, t, deps2);
    const q = env.q();
    assert.equal(q.hold.status, 'notified');
    assert.equal(q.hold.messageId, found);
    assert.equal(q.hold.yieldAt, timeFromId(found) + 15 * MIN, '过号时刻仍按消息时间＋留位时长');
  } finally { env.cleanup(); }
});

test('D1-5 别的 bot 的件“发送结果读不出”：仍按桌面角色账号找（和改前一样）', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueFor(env, REQ[TB]);
    const found = msgId(T0 + 20_500);
    const { deps } = abrDeps(t, { send: [{ kind: 'unknown', reason: '读不出' }] });
    await tick(env, t, deps);
    t.now += 120_000;
    const { deps: deps2 } = abrDeps(t, { read: [{ ok: true, messages: [{ id: found, authorId: CONTROLLER_USER_ID, content: '（排队号 Q0001）别人发的' }] }, { ok: true, messages: [] }] });
    await tick(env, t, deps2);
    assert.equal(env.q().hold.status, 'pending', '总控账号发的同标记消息对 bot 的件不算');
    t.now += 120_000;
    const { deps: deps3 } = abrDeps(t, { read: [{ ok: true, messages: [{ id: found, authorId: DESKTOP_USER_ID, content: '（排队号 Q0001）' }] }] });
    await tick(env, t, deps3);
    assert.equal(env.q().hold.status, 'notified');
  } finally { env.cleanup(); }
});

test('D1-6主人的件总控账号“确认没发出”：记 not-sent，留位仍待通知，不退回桌面角色账号发', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueFor(env, OWNER_REQ);
    const { deps, calls } = abrDeps(t, { send: [{ kind: 'not-sent', reason: '命令没能启动（测试）' }] });
    await tick(env, t, deps);
    const q = env.q();
    assert.equal(q.hold.status, 'pending');
    assert.equal(q.hold.attempts[0].result, 'not-sent');
    assert.equal(calls.sends.length, 1);
    assert.equal(calls.sends[0].account, 'default');
    t.now += 120_000;
    await tick(env, t, deps);
    assert.equal(calls.sends.length, 2);
    assert.equal(calls.sends[1].account, 'default', '重试仍是总控账号，不自动退回桌面角色账号');
  } finally { env.cleanup(); }
});

test('D1-7主人的件过号：总控账号在原线程点名他一句（没有后续动作的这一轮也发）；记账不变', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueFor(env, OWNER_REQ);
    const { deps, calls } = abrDeps(t);
    await tick(env, t, deps);
    t.now = env.q().hold.yieldAt + 60_000;
    await tick(env, t, deps);
    assert.equal(env.item(TB).status, 'expired');
    assert.equal(calls.sends.length, 2);
    const n = calls.sends[1];
    assert.equal(n.account, 'default');
    assert.equal(n.target, TB);
    assert.equal(n.message, expiredNoticeText('Q0001'));
    assert.ok(n.message.startsWith(`<@${OWNER_USER_ID}> 桌面角色这一轮没接上（排队号 Q0001）`));
    assert.ok(n.timeoutMs <= 10_000);
    assert.match(env.log(), /tick-expired-notice/);
    // 再跑一轮不重复发
    t.now += 120_000;
    await tick(env, t, deps);
    assert.equal(calls.sends.length, 2);
  } finally { env.cleanup(); }
});

test('D1-8 别的 bot 的件过号：行为与改前相同，不发过号通知', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueFor(env, REQ[TB]);
    const { deps, calls } = abrDeps(t);
    await tick(env, t, deps);
    t.now = env.q().hold.yieldAt + 60_000;
    await tick(env, t, deps);
    assert.equal(env.item(TB).status, 'expired');
    assert.equal(calls.sends.length, 1);
    assert.doesNotMatch(env.log(), /tick-expired-notice/);
  } finally { env.cleanup(); }
});

test('D1-9 过号通知发送失败：记账不变、不重试；发送调用抛错也一样', async () => {
  for (const failure of ['unknown', 'throw']) {
    const env = qenv();
    const t = { now: T0 + 20_000 };
    try {
      queueFor(env, OWNER_REQ);
      const { deps, calls } = abrDeps(t);
      await tick(env, t, deps);
      t.now = env.q().hold.yieldAt + 60_000;
      const failing = { ...deps, send: async (args) => { calls.sends.push(args); if (failure === 'throw') throw new Error('炸了'); return { kind: 'unknown', reason: '读不出' }; } };
      await tick(env, t, failing);
      assert.equal(env.item(TB).status, 'expired', '过号已记账');
      assert.equal(calls.sends.length, 2);
      t.now += 120_000;
      await tick(env, t, failing);
      assert.equal(calls.sends.length, 2, '不重试');
      assert.match(env.log(), /tick-expired-notice/);
    } finally { env.cleanup(); }
  }
});

test('D1-10 过号时本轮剩余时间不够：这一轮放弃过号通知、记日志，过号照常记账', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    queueFor(env, OWNER_REQ);
    const { deps, calls } = abrDeps(t);
    await tick(env, t, deps);
    t.now = env.q().hold.yieldAt + 60_000;
    await tick(env, t, deps, undefined, { budgetMs: 40_000 });
    assert.equal(env.item(TB).status, 'expired');
    assert.equal(calls.sends.length, 1, '没发过号通知');
    assert.match(env.log(), /tick-expired-notice-skipped/);
  } finally { env.cleanup(); }
});

test('D1-11主人的件过号、同时轮到下一位 bot：下一位的通知先发（桌面角色账号），过号通知排在后面', async () => {
  const env = qenv();
  const t = { now: T0 + 20_000 };
  try {
    assert.equal(access(env, TA, T0).allow, true);
    checkScreenAccess({ lockPath: env.lockPath, logPath: env.logPath, sessionKey: sk(TB), requester: OWNER_REQ, now: T0 + 1000 });
    access(env, TC, T0 + 2000);
    release(env, TA, T0 + 10_000);
    const { deps, calls } = abrDeps(t);
    await tick(env, t, deps);
    t.now = env.q().hold.yieldAt + 60_000;
    await tick(env, t, deps);
    assert.equal(calls.sends.length, 3);
    assert.equal(calls.sends[1].target, TC);
    assert.ok(!('account' in calls.sends[1]), '下一位是 bot：桌面角色账号');
    assert.equal(calls.sends[2].target, TB);
    assert.equal(calls.sends[2].account, 'default');
  } finally { env.cleanup(); }
});

test('D1-12 findMarkedMessage 默认仍认桌面角色账号；传了作者就按作者认', async () => {
  const id = msgId(T0);
  const deps = { read: async () => ({ ok: true, messages: [{ id, authorId: CONTROLLER_USER_ID, content: '（排队号 Q9）' }] }) };
  const base = { deps: { read: async ({ after }) => (BigInt(after) < BigInt(id) ? deps.read() : { ok: true, messages: [] }) }, remaining: () => 90_000, clock: () => T0 + 1000 };
  const low = idFromTime(T0 - 60_000);
  assert.equal((await findMarkedMessage(base, { target: TB, after: low, marker: '（排队号 Q9）' })).found, null);
  assert.equal((await findMarkedMessage(base, { target: TB, after: low, marker: '（排队号 Q9）', authorId: CONTROLLER_USER_ID })).found?.id, id);
});

test('D1-13 notifyText 两种写法：别人的件逐字不变，主人的件按新文字', () => {
  const hold = { requester: '100000000000000155', queuedAt: T0, queueNo: 'Q0007', threadId: TB };
  assert.match(notifyText(hold, 15), /^<@100000000000000155> 轮到你了：你 .* 在这里叫我做的事.*（排队号 Q0007）.*这只是通知，不是新授权。$/);
  const a = notifyText({ ...hold, requester: OWNER_USER_ID }, 20);
  assert.match(a, /^<@100000000000000012> 轮到你了：主人 .* 在这个线程叫你做的事.*（排队号 Q0007）/);
  assert.match(a, /给你留 20 分钟，过了就让给下一位。$/);
});

// ======================================================================
// 六类审批卡说明截断；出卡时另发点名（假发送函数）
// ======================================================================
import { sanitizedLength as _sanLen, cpLength as _cpLen, resetApprovalNoticeState as _resetNotice } from '../plugins/personal-inbox/approval-card.mjs';

function d6Gate({ what, findCard, send }) {
  const { lockPath, cleanup } = fresh();
  const gate = createScreenGate({ lockPath, logPath: null, now: () => T0 + 10_000, findCard, sendApprovalNotice: send });
  const ctx = { agentId: 'desktop', sessionKey: A, runId: 'r1' };
  gate({ toolName: 'computer' }, ctx);
  holdForConfirmation({ lockPath, threadId: THREAD_A, what, now: T0 + 1000 });
  return { r: gate({ toolName: 'computer' }, ctx), cleanup };
}

test('D6 六类卡：“什么事”300 字（带全角空格、制表符）＋多张卡 → 清理后 ≤512、栏目都在、卡里没有 <@ 点名', () => {
  _resetNotice();
  const what = ('提　交\t表 单').repeat(75);
  const ambiguous = Array.from({ length: 9 }, (_, i) => ({ id: `card-${i}-aaaaaaaa-bbbb`, title: `很长很长的卡名${i}` }));
  const { r, cleanup } = d6Gate({ what, findCard: () => ({ ambiguous }), send: () => ({ ok: true }) });
  try {
    const d = r.requireApproval.description;
    assert.ok(_sanLen(d) <= 512 && _cpLen(d) <= 480, String(_sanLen(d)));
    for (const must of ['什么事：', '批的是什么：只放行桌面角色的这一次屏幕调用', '申请的 bot：桌面角色', '来自任务卡：', `原线程：https://discord.com/channels/100000000000000002/${THREAD_A}`]) assert.ok(d.includes(must), must);
    assert.ok(!d.includes('<@'));
    assert.ok(_cpLen(r.requireApproval.title) <= 80);
  } finally { cleanup(); }
});

test('D6 六类卡：短说明与改前逐字相同（含“桌面角色在线程…重新批”那句）', () => {
  _resetNotice();
  const { r, cleanup } = d6Gate({ what: '提交测试表单', findCard: () => null, send: () => ({ ok: true }) });
  try {
    assert.equal(r.requireApproval.description, `什么事：提交测试表单。批的是什么：只放行桌面角色的这一次屏幕调用（用过就作废，下一项要重新记等确认、重新批）。申请的 bot：桌面角色。来自任务卡：没查到关联任务卡（线程 ${THREAD_A}）；原线程：https://discord.com/channels/100000000000000002/${THREAD_A}。桌面角色在线程 ${THREAD_A} 里要继续动屏幕；之后要再做六类操作，桌面角色要先重新记“等确认”、重新批。`);
  } finally { cleanup(); }
});

test('D6 六类卡：出卡时另发点名（default 账号、审批频道、点名主人、带事由）；另发失败卡照出；同一张卡不重复发', async () => {
  _resetNotice();
  const sent = [];
  const a = d6Gate({ what: '提交测试表单', findCard: () => ({ id: 'card-77', title: null }), send: (x) => { sent.push(x); return { ok: true }; } });
  await new Promise((x) => setImmediate(x));
  try {
    assert.ok(a.r.requireApproval);
    assert.equal(sent.length, 1); assert.equal(sent[0].account, 'default'); assert.equal(sent[0].target, '100000000000000004');
    assert.match(sent[0].message, /^<@100000000000000001> 审批频道有一张新审批卡：桌面角色六类操作（任务卡 card-77）——提交测试表单/);
  } finally { a.cleanup(); }
  _resetNotice();
  const b = d6Gate({ what: '另一项', findCard: () => null, send: () => { throw new Error('发不出'); } });
  try { assert.ok(b.r.requireApproval, '另发失败，卡照出'); } finally { b.cleanup(); }
});

test('挡下的话里写明请求方（是 Discord 编号就带 <@编号>，是主人本人就注明）；请求方不明时还是旧的泛称', () => {
  const { lockPath, cleanup } = fresh();
  try {
    checkScreenAccess({ lockPath, sessionKey: A, requester: { senderId: 'owner-user' }, now: T0 });
    const abr = checkScreenAccess({ lockPath, sessionKey: B, requester: { senderId: '100000000000000001' }, now: T0 + 30_000 });
    assert.equal(abr.allow, false);
    assert.match(abr.reason, /这次叫你的是 <@100000000000000001>（主人本人），点名它就把 <@100000000000000001> 原样写进回话里/);
    const { lockPath: lp2, cleanup: c2 } = fresh();
    try {
      checkScreenAccess({ lockPath: lp2, sessionKey: A, requester: { senderId: 'owner-user' }, now: T0 });
      const bot = checkScreenAccess({ lockPath: lp2, sessionKey: B, requester: { senderId: '100000000000000011' }, now: T0 + 30_000 });
      assert.match(bot.reason, /这次叫你的是 <@100000000000000011>，点名它就把/);
      assert.ok(!bot.reason.includes('主人本人'));
    } finally { c2(); }
    const { lockPath: lp3, cleanup: c3 } = fresh();
    try {
      checkScreenAccess({ lockPath: lp3, sessionKey: A, requester: { senderId: 'owner-user' }, now: T0 });
      const unk = checkScreenAccess({ lockPath: lp3, sessionKey: B, now: T0 + 30_000 });
      assert.match(unk.reason, /请在当前线程点名请求方（一般是总控或别的 bot）/);
    } finally { c3(); }
  } finally { cleanup(); }
});


// 同一项不再记等确认；锁已变不动它 ─────
import { refuseHeldAccess, stuckReminderTick, REFUSED_BLOCK_TEXT, REFUSED_FILE_ERROR_TEXT, REFUSED_EXPIRE_MS, isCleanupAction, refusedPathOf, markThreadRefused, clearThreadRefused, threadRefusedState } from '../plugins/personal-inbox/desktop-lock.mjs';

function gateWithLedger(lockPath, approvalLedger, logPath = null) {
  const gate = createScreenGate({ lockPath, logPath, now: () => T0 + 10_000, approvalLedger });
  return (params) => gate({ toolName: 'computer', params }, { agentId: 'desktop', sessionKey: A, runId: 'r1' });
}

test('拒绝／超时／取消——锁都改回“做事中”并记被拒；点击被硬挡，收尾的截图和关窗放行，不出第二张卡', () => {
  for (const [dec, word] of [['deny', 'approval-denied'], ['timeout', 'approval-timeout'], ['cancelled', 'approval-cancelled'], [undefined, 'approval-denied-or-timeout']]) {
    const { lockPath, cleanup } = fresh();
    try {
      const gate = gateWithLedger(lockPath, null, join(lockPath, '..', 'log.jsonl'));
      assert.equal(gate(), undefined);
      holdForConfirmation({ lockPath, threadId: THREAD_A, what: '提交测试表单', now: T0 + 1000 });
      const r = gate(); assert.ok(r.requireApproval);
      r.requireApproval.onResolution(dec);
      const lock = readLock(lockPath);
      assert.equal(lock.state, 'working', `${word}：改回做事中`);
      assert.equal(lock.refused.length, 1); assert.equal(lock.refused[0].what, '提交测试表单'); assert.equal(lock.refused[0].reason, word);
      assert.equal(gate({ action: 'left_click' })?.blockReason, REFUSED_BLOCK_TEXT, `${word}：点击被硬挡`);
      assert.equal(gate({ action: 'screenshot' }), undefined, `${word}：截图放行`);
      assert.equal(gate({ action: 'key', keys: 'cmd+w' }), undefined, `${word}：关窗放行（不出第二张卡）`);
      const log = readFileSync(join(lockPath, '..', 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
      assert.ok(log.some((e) => e.decision === word && e.lockReleasedToWorking === true), `锁日志记 ${word}`);
    } finally { cleanup(); }
  }
});

test('锁已经换了线程／已放／指纹对不上——拒绝或超时不动它；refuseHeldAccess 三样都要核', () => {
  const { lockPath, cleanup } = fresh();
  try {
    const gate = gateWith(lockPath);
    gate(); holdForConfirmation({ lockPath, threadId: THREAD_A, what: '提交测试表单', now: T0 + 1000 });
    const r = gate(); const fp = approvalFingerprint(THREAD_A, '提交测试表单', T0 + 1000);
    assert.equal(refuseHeldAccess({ lockPath, threadId: '100000000000000146', fingerprint: fp, now: T0 + 2000 }).ok, false, '换线程');
    assert.equal(refuseHeldAccess({ lockPath, threadId: THREAD_A, fingerprint: 'x'.repeat(16), now: T0 + 2000 }).ok, false, '指纹不对');
    assert.equal(readLock(lockPath).state, 'waiting', '没动');
    releaseLock({ lockPath, threadId: THREAD_A, now: T0 + 3000 });
    r.requireApproval.onResolution('timeout'); // 锁已放：不报错、不动
    assert.equal(readLock(lockPath), null);
    assert.equal(refuseHeldAccess({ lockPath, threadId: THREAD_A, fingerprint: fp, now: T0 + 4000 }).ok, false, '锁没了');
  } finally { cleanup(); }
});

test('同一把锁里同一项（去掉空白后相同）再记“等确认”被拒并提示先放锁再重新申请；不同的项照常；放锁后换新锁不受影响', () => {
  const { lockPath, cleanup } = fresh();
  try {
    const gate = gateWith(lockPath);
    gate(); holdForConfirmation({ lockPath, threadId: THREAD_A, what: '提交测试表单', now: T0 + 1000 });
    gate().requireApproval.onResolution('deny');
    const again = holdForConfirmation({ lockPath, threadId: THREAD_A, what: '提交 测试 表单', now: T0 + 2000 });
    assert.equal(again.ok, false); assert.match(again.message, /先放锁，再重新申请/); assert.equal(readLock(lockPath).state, 'working');
    assert.equal(holdForConfirmation({ lockPath, threadId: THREAD_A, what: '上传另一个文件', now: T0 + 3000 }).ok, true, '不同的项照常');
    releaseLock({ lockPath, threadId: THREAD_A, now: T0 + 4000 });
    const g2 = gateWith(lockPath); g2();
    assert.equal(holdForConfirmation({ lockPath, threadId: THREAD_A, what: '提交测试表单', now: T0 + 5000 }).ok, true, '放锁、拿新锁后可以重新申请');
  } finally { cleanup(); }
});

test('超时和取消登记进“等你定”，拒绝不登记；出新卡时通知“已重新申请”；登记失败不影响卡和锁', async () => {
  const { lockPath, cleanup } = fresh();
  try {
    const calls = []; const ledger = { expired: async (x) => { calls.push(['expired', x]); }, reissued: async (x) => { calls.push(['reissued', x]); } };
    const gate = gateWithLedger(lockPath, ledger);
    gate(); holdForConfirmation({ lockPath, threadId: THREAD_A, what: '提交测试表单', now: T0 + 1000 });
    const r = gate(); assert.ok(r.requireApproval);
    assert.ok(calls.some(([k, x]) => k === 'reissued' && x.kind === '桌面角色六类操作' && x.threadId === THREAD_A), '出卡时通知重新申请');
    r.requireApproval.onResolution('deny');
    assert.equal(calls.filter(([k]) => k === 'expired').length, 0, '拒绝不登记');
    holdForConfirmation({ lockPath, threadId: THREAD_A, what: '上传另一个文件', now: T0 + 2000 });
    const r2 = gate(); r2.requireApproval.onResolution('timeout');
    await new Promise((x) => setImmediate(x));
    const ex = calls.filter(([k]) => k === 'expired'); assert.equal(ex.length, 1);
    assert.equal(ex[0][1].kind, '桌面角色六类操作'); assert.equal(ex[0][1].what, '上传另一个文件'); assert.equal(ex[0][1].threadId, THREAD_A); assert.ok(ex[0][1].expiredAt);
    assert.equal(readLock(lockPath).state, 'working');
    // 取消也登记；登记抛错不影响
    holdForConfirmation({ lockPath, threadId: THREAD_A, what: '第三项', now: T0 + 3000 });
    const bad = gateWithLedger(lockPath, { expired: async () => { throw new Error('台账坏了'); }, reissued: () => { throw new Error('同步抛错'); } });
    const r3 = bad(); assert.ok(r3.requireApproval, '重新申请通知抛错不影响出卡');
    assert.doesNotThrow(() => r3.requireApproval.onResolution('cancelled'));
    await new Promise((x) => setImmediate(x));
    assert.equal(readLock(lockPath).state, 'working');
  } finally { cleanup(); }
});

// 求助后又 2 次 → 停下；任务审计 20 分钟不回 → 审批频道点名主人）─────
import { stuckPathOf, stuckPeek, TASK_AUDITOR_MENTION, BLOCK_ASK_HELP, BLOCK_AFTER_HELP, HELP_WAIT_MS } from '../plugins/personal-inbox/stuck-guard.mjs';
import { APPROVAL_CHANNEL_ID as APPROVAL_CH, OWNER_MENTION as ABR } from '../plugins/personal-inbox/approval-card.mjs';

function stuckEnv() {
  const { lockPath, cleanup } = fresh();
  const handlers = []; let nowMs = T0 + 10_000;
  registerDesktopScreenLock({ on: (name, handler, options) => handlers.push({ name, handler, options }) }, { lockPath, logPath: join(lockPath, '..', 'gate.log'), now: () => nowMs });
  const gate = handlers.find((h) => h.options.registrationId === 'desktop-screen-lock-gate').handler;
  const after = handlers.find((h) => h.options.registrationId === 'desktop-stuck-result').handler;
  const sending = handlers.find((h) => h.options.registrationId === 'desktop-stuck-message-sending').handler;
  const msgTool = handlers.find((h) => h.options.registrationId === 'desktop-stuck-message-tool').handler;
  const wolf = { agentId: 'desktop', sessionKey: A };
  const call = (id, ctx = wolf, params) => gate({ toolName: 'computer', toolCallId: id, params }, ctx);
  const done = (id, failed, ctx = wolf) => after({ toolName: 'computer', toolCallId: id, ...(failed ? { error: '点击没生效' } : { result: { ok: true } }) }, ctx);
  return { lockPath, cleanup, handlers, call, done, wolf, sending, msgTool, setNow: (v) => { nowMs = v; }, stuck: () => stuckPeek(stuckPathOf(lockPath)).threads[THREAD_A] };
}

test('连续 2 次放行后报错 → 第三次被拦并要求点名任务审计（带格式）；成功一次清零；提示里不换模型', () => {
  const e = stuckEnv();
  try {
    assert.equal(e.call('t1'), undefined); e.done('t1', true);
    assert.equal(e.call('t2'), undefined); e.done('t2', false); // 成功清零
    assert.equal(e.stuck().errors, 0);
    assert.equal(e.call('t3'), undefined); e.done('t3', true);
    assert.equal(e.call('t4'), undefined); e.done('t4', true);
    assert.equal(e.stuck().errors, 2);
    const r = e.call('t5');
    assert.equal(r.block, true); assert.equal(r.blockReason, BLOCK_ASK_HELP);
    assert.ok(r.blockReason.includes(TASK_AUDITOR_MENTION) && r.blockReason.includes('【求助】') && r.blockReason.includes('报错原文'));
    assert.ok(!/Opus|换模型/.test(BLOCK_ASK_HELP));
  } finally { e.cleanup(); }
});

test('四种“不是放行后报错”的情况都不计数——拒绝、超时、排队被挡（别的线程占着锁）、未登记的编号', () => {
  const e = stuckEnv();
  try {
    // 排队被挡：B 线程在 A 占着锁时被挡，after_tool_call 带错误也不计数
    assert.equal(e.call('a1'), undefined);
    const B_CTX = { agentId: 'desktop', sessionKey: 'agent:desktop:discord:channel:100000000000000146' };
    for (const id of ['b1', 'b2', 'b3']) { assert.equal(e.call(id, B_CTX).block, true); e.done(id, true, B_CTX); }
    assert.equal(stuckPeek(stuckPathOf(e.lockPath)).threads['100000000000000146'], undefined, '排队被挡的线程没有任何计数记录');
    // 拒绝／超时：出审批卡的调用不是放行，拒绝后 after_tool_call 带错误不计数
    holdForConfirmation({ lockPath: e.lockPath, threadId: THREAD_A, what: '提交表单', now: T0 + 1000 });
    const card = e.call('c1'); assert.ok(card.requireApproval);
    card.requireApproval.onResolution('deny'); e.done('c1', true);
    holdForConfirmation({ lockPath: e.lockPath, threadId: THREAD_A, what: '另一项', now: T0 + 2000 }); // 新的等确认（不清线程标记：只有新卡被批准才清）
    const card2 = e.call('c2'); assert.ok(card2.requireApproval);
    card2.requireApproval.onResolution('timeout'); e.done('c2', true);
    e.done('never-registered', true);
    assert.equal(e.stuck().errors, 0, '拒绝、超时、未登记的都没有计数');
    // 之后：线程还在“只许收尾”里，点击被硬挡（也不计数）；截图这类放行后报错才算
    assert.equal(e.call('d0', e.wolf, { action: 'left_click' }).block, true); e.done('d0', true);
    assert.equal(e.call('d1', e.wolf, { action: 'screenshot' }), undefined); e.done('d1', true);
    assert.equal(e.stuck().errors, 1);
  } finally { e.cleanup(); }
});

test('求助（普通回复点名任务审计）记成“已求助”→ 清零、再给 2 次机会；再连败 2 次 → 拦下并叫她停下放锁；再发求助不重置', () => {
  const e = stuckEnv();
  try {
    for (const id of ['t1', 't2']) { e.call(id); e.done(id, true); }
    assert.equal(e.call('t3').blockReason, BLOCK_ASK_HELP);
    // 普通回复点名任务审计（message_sending）
    e.sending({ content: `${TASK_AUDITOR_MENTION}\n【求助】\n现象：保存窗口没出来` }, e.wolf);
    assert.equal(e.stuck().phase, 'helped'); assert.equal(e.stuck().errors, 0);
    assert.equal(e.call('t4'), undefined, '照建议再试一次：放行');
    e.done('t4', true); assert.equal(e.call('t5'), undefined); e.done('t5', true);
    const r = e.call('t6');
    assert.equal(r.block, true); assert.equal(r.blockReason, BLOCK_AFTER_HELP); assert.match(r.blockReason, /停下.*放锁.*总控/);
    e.sending({ content: `${TASK_AUDITOR_MENTION} 【求助】再来一次` }, e.wolf);
    assert.equal(e.call('t7').blockReason, BLOCK_AFTER_HELP, '再发求助不重置');
  } finally { e.cleanup(); }
});

test('message 工具点名任务审计也记成“已求助”；别的角色或不含点名／格式的话不记；同一线程只记一次', () => {
  const e = stuckEnv();
  try {
    e.sending({ content: `${TASK_AUDITOR_MENTION} 求助` }, { agentId: 'worker-a', sessionKey: A });
    e.sending({ content: '我在找窗口' }, e.wolf);
    assert.equal(e.stuck(), undefined, '别的角色／没点名：不记');
    e.call('t0');
    e.msgTool({ toolName: 'mcp__openclaw__message', params: { action: 'send', message: '【求助】\n现象：…' } }, e.wolf);
    assert.equal(e.stuck().phase, 'helped');
    const at1 = e.stuck().helpAt;
    e.msgTool({ toolName: 'message', params: { message: `${TASK_AUDITOR_MENTION} 再问` } }, e.wolf);
    assert.equal(e.stuck().helpAt, at1, '只记一次');
  } finally { e.cleanup(); }
});

test('放锁后换新锁，旧计数作废', () => {
  const e = stuckEnv();
  try {
    for (const id of ['t1', 't2']) { e.call(id); e.done(id, true); }
    assert.equal(e.call('t3').block, true);
    releaseLock({ lockPath: e.lockPath, threadId: THREAD_A, now: T0 + 5000 });
    e.setNow(T0 + 20_000);
    assert.equal(e.call('n1'), undefined, '新锁：计数从头来');
  } finally { e.cleanup(); }
});

test('任务审计用“【求助回复】”回复（普通回复或 message 工具）记成已回；20 分钟没回 → 排队 tick 往审批频道点名主人一次；有回则不发；发送失败下一轮再试', async () => {
  const mkTick = async (answer) => {
    const e = stuckEnv();
    const sent = []; let mode = 'sent';
    const deps = { async send(a) { sent.push(a); return { kind: mode }; }, async read() { return { ok: true, messages: [] }; } };
    e.call('t1'); e.sending({ content: `${TASK_AUDITOR_MENTION} 【求助】卡住了` }, e.wolf);
    const helpAt = e.stuck().helpAt;
    if (answer === 'sending') e.sending({ content: '【求助回复】试试先把窗口调到前台' }, { agentId: 'task-auditor', sessionKey: 'agent:task-auditor:discord:channel:100000000000000145' }, { threadId: THREAD_A });
    if (answer === 'tool') e.msgTool({ toolName: 'message', params: { message: '【求助回复】先点一下空白处', target: `channel:${THREAD_A}` } }, { agentId: 'task-auditor', sessionKey: 'agent:task-auditor:main' });
    return { e, sent, deps, helpAt, setMode: (m) => { mode = m; } };
  };
  // 没人回
  const a = await mkTick(null);
  try {
    await stuckReminderTick({ lockPath: a.e.lockPath, deps: a.deps, now: () => a.helpAt + HELP_WAIT_MS - 1000 });
    assert.equal(a.sent.length, 0, '不到 20 分钟不发');
    const done = await stuckReminderTick({ lockPath: a.e.lockPath, deps: a.deps, now: () => a.helpAt + HELP_WAIT_MS + 1000 });
    assert.deepEqual(done, [THREAD_A]); assert.equal(a.sent.length, 1);
    assert.equal(a.sent[0].target, APPROVAL_CH); assert.equal(a.sent[0].account, 'default'); assert.ok(a.sent[0].message.startsWith(ABR)); assert.ok(a.sent[0].message.includes(THREAD_A));
    await stuckReminderTick({ lockPath: a.e.lockPath, deps: a.deps, now: () => a.helpAt + 2 * HELP_WAIT_MS });
    assert.equal(a.sent.length, 1, '只发一次');
  } finally { a.e.cleanup(); }
  // 普通回复回了、message 工具回了：不发
  for (const how of ['sending', 'tool']) {
    const b = await mkTick(how);
    try {
      assert.equal(b.e.stuck().answered, true, how);
      await stuckReminderTick({ lockPath: b.e.lockPath, deps: b.deps, now: () => b.helpAt + 3 * HELP_WAIT_MS });
      assert.equal(b.sent.length, 0, `${how}：有回不发`);
    } finally { b.e.cleanup(); }
  }
  // 发送没发出去：下一轮再试
  const c = await mkTick(null);
  try {
    c.setMode('not-sent');
    await stuckReminderTick({ lockPath: c.e.lockPath, deps: c.deps, now: () => c.helpAt + HELP_WAIT_MS + 1000 });
    c.setMode('sent');
    await stuckReminderTick({ lockPath: c.e.lockPath, deps: c.deps, now: () => c.helpAt + HELP_WAIT_MS + 120_000 });
    assert.equal(c.sent.length, 2); 
  } finally { c.e.cleanup(); }
});

test('runTick 会先跑 20 分钟兜底（排队空着也跑）；兜底出错不影响排队推进', async () => {
  const env = qenv(); const t = { now: T0 + 40 * 60_000 };
  try {
    const sent = []; const deps = { async send(a) { sent.push(a); return { kind: 'sent', messageId: '100000000000000164' }; }, async read() { return { ok: true, messages: [] }; } };
    const sp = stuckPathOf(env.lockPath);
    mkdirSync(join(env.lockPath, '..'), { recursive: true });
    writeFileSync(sp, JSON.stringify({ threads: { [THREAD_A]: { lockStamp: 1, allowed: [], errors: 0, phase: 'helped', helpAt: T0, answered: false, reminded: false } } }));
    const r = await tick(env, t, deps);
    assert.equal(r.did, 'empty'); assert.equal(sent.length, 1); assert.equal(sent[0].target, APPROVAL_CH);
    writeFileSync(sp, '{坏的');
    const r2 = await tick(env, t, deps); assert.equal(r2.did, 'empty', '状态文件坏了：不影响推进');
  } finally { env.cleanup(); }
});

// ───── 卡住兜底和默认发送函数都不会在没传时真发 ─────
import { defaultDeps } from '../plugins/personal-inbox/desktop-lock.mjs';
import { crew } from '../plugins/personal-inbox/crew-config.mjs';
test('没有 deps.send → 兜底提醒不发、记一行、提醒不丢；默认发送函数在测试环境不真发', async () => {
  const e = stuckEnv();
  try {
    e.call('t1'); e.sending({ content: `${TASK_AUDITOR_MENTION} 【求助】卡住了` }, e.wolf);
    const helpAt = e.stuck().helpAt;
    const logPath = join(e.lockPath, '..', 'tick.log');
    assert.deepEqual(await stuckReminderTick({ lockPath: e.lockPath, deps: {}, now: () => helpAt + HELP_WAIT_MS + 1000, logPath }), []);
    assert.deepEqual(await stuckReminderTick({ lockPath: e.lockPath, deps: undefined, now: () => helpAt + HELP_WAIT_MS + 1000, logPath }), []);
    assert.match(readFileSync(logPath, 'utf8'), /stuck-help-reminder-skipped/);
    assert.equal(e.stuck().reminded, false, '没发就不标已提醒（提醒不丢）');
    const r = await defaultDeps().send({ target: '1', message: 'x', timeoutMs: 1000 });
    assert.equal(r.kind, 'not-sent'); assert.match(r.reason, /测试环境/);
  } finally { e.cleanup(); }
});

// ───── 现场检查被挡也不计数（闸门真走一遍）─────
test('现场待检查被挡（旧锁已挪走、标记还在，B 第一次来被挡并提示看现场）——不记放行、after_tool_call 带错误也不计数；看完现场后的正常放行才记', async () => {
  const env = qenv(); const t = { now: T0 + 30_000 };
  try {
    access(env, TA, T0); access(env, TB, T0 + 1000); access(env, TC, T0 + 2000);
    markRunEnded({ lockPath: env.lockPath, sessionKey: sk(TA), now: T0 + 3000 });
    t.now = T0 + 3000 + RUN_ENDED_GRACE_MS;
    const { deps } = makeDeps(t); await tick(env, t, deps);
    assert.ok(env.q().sceneCheck, '现场待检查标记在');
    const handlers = [];
    registerDesktopScreenLock({ on: (name, handler, options) => handlers.push({ name, handler, options }) }, { lockPath: env.lockPath, logPath: env.logPath, now: () => t.now });
    const gate = handlers.find((h) => h.options.registrationId === 'desktop-screen-lock-gate').handler;
    const after = handlers.find((h) => h.options.registrationId === 'desktop-stuck-result').handler;
    const ctxB = { agentId: 'desktop', sessionKey: sk(TB), runId: 'rB' };
    const first = gate({ toolName: 'computer', toolCallId: 'scene-1' }, ctxB);
    assert.equal(first?.block, true, '第一次被挡（现场待检查提示）');
    after({ toolName: 'computer', toolCallId: 'scene-1', error: first.blockReason }, ctxB);
    assert.equal(stuckPeek(stuckPathOf(env.lockPath)).threads[TB], undefined, '被现场检查挡下的调用没有任何计数记录');
    const second = gate({ toolName: 'computer', toolCallId: 'ok-1' }, ctxB);
    assert.equal(second, undefined, '看完现场后正常放行');
    after({ toolName: 'computer', toolCallId: 'ok-1', error: '点击没生效' }, ctxB);
    assert.equal(stuckPeek(stuckPathOf(env.lockPath)).threads[TB].errors, 1, '之后真的“放行后报错”才算');
  } finally { env.cleanup(); }
});


// ───── 第 9 步审计后改成硬拦：线程级“只许收尾”——被拒／超时／取消之后只放行看和关窗 ─────
const dirOf = (e) => join(e.lockPath, '..');
function refusedAfter(e, dec) { // 先让桌面角色拿锁、记等确认、出卡，再给一个决定
  e.call('t0'); holdForConfirmation({ lockPath: e.lockPath, threadId: THREAD_A, what: `提交表单-${dec}`, now: T0 + 1000 });
  const card = e.call('c-' + dec); assert.ok(card.requireApproval); card.requireApproval.onResolution(dec); return card;
}

test('isCleanupAction 白名单：只看、等待、调前台、cmd+w、菜单“关闭”放行；点击、打字、回车、别的按键、launch／kill、browser 点击、set_value、没写动作的一律挡', () => {
  for (const p of [{ action: 'screenshot' }, { action: 'zoom' }, { action: 'list_apps' }, { action: 'list_windows' }, { action: 'get_accessibility_tree' }, { action: 'get_window_state' }, { action: 'get_cursor_position' },
    { action: 'get_browser_state' }, { action: 'get_recording_state' }, { action: 'wait' }, { action: 'bring_to_front' }, { action: 'SCREENSHOT' },
    { action: 'key', keys: 'cmd+w' }, { action: 'key', keys: 'Command+W' }, { action: 'key', keys: ' cmd + w ' }, { action: 'key', text: 'meta+w' }, { action: 'key', keys: 'super+w' },
    { action: 'invoke_menu', path: ['文件', '关闭窗口'] }, { action: 'invoke_menu', path: ['File', 'Close Window'] }, { action: 'invoke_menu', path: ['File', 'Close'] }, { action: 'invoke_menu', path: ['窗口', '关闭'] }]) {
    assert.equal(isCleanupAction(p), true, JSON.stringify(p));
  }
  for (const p of [undefined, null, {}, { action: '' }, { action: 'left_click' }, { action: 'right_click' }, { action: 'double_click' }, { action: 'triple_click' }, { action: 'middle_click' }, { action: 'mouse_move' }, { action: 'left_click_drag' },
    { action: 'left_mouse_down' }, { action: 'left_mouse_up' }, { action: 'scroll' }, { action: 'type', text: 'x' }, { action: 'set_value' }, { action: 'hold_key', keys: 'return' },
    { action: 'key', keys: 'return' }, { action: 'key', keys: 'enter' }, { action: 'key', keys: 'space' }, { action: 'key', keys: 'cmd+q' }, { action: 'key', keys: 'cmd+shift+w' }, { action: 'key', keys: 'cmd+w+return' }, { action: 'key' },
    { action: 'launch_app', app: 'Safari' }, { action: 'kill_app', app: 'Safari' }, { action: 'browser_click' }, { action: 'browser_type' }, { action: 'browser_navigate' }, { action: 'browser_dialog' }, { action: 'escalate_scope' }, { action: 'start_recording' }, { action: 'replay_trajectory' },
    { action: 'invoke_menu', path: ['File', 'Save'] }, { action: 'invoke_menu', path: ['File', 'Close All'] }, { action: 'invoke_menu', path: [] }, { action: 'invoke_menu' }, { action: 'nonsense' }]) {
    assert.equal(isCleanupAction(p), false, JSON.stringify(p));
  }
});

test('硬拦：被拒、超时、取消三种以后，点击／打字／回车／别的按键被挡（话说死），截图和关窗放行；被挡的调用不计入卡住保险', () => {
  for (const dec of ['deny', 'timeout', 'cancelled']) {
    const e = stuckEnv();
    try {
      refusedAfter(e, dec);
      assert.equal(readLock(e.lockPath).state, 'working', `${dec}：锁改回做事中，收尾不用再出卡`);
      for (const p of [{ action: 'left_click' }, { action: 'type', text: '提交' }, { action: 'key', keys: 'return' }, { action: 'key', keys: 'enter' }, { action: 'double_click' }, { action: 'set_value' }, { action: 'kill_app' }, undefined]) {
        const r = e.call('x-' + Math.random(), e.wolf, p); assert.equal(r?.block, true, `${dec} ${JSON.stringify(p)}`); assert.equal(r.blockReason, REFUSED_BLOCK_TEXT);
      }
      assert.match(REFUSED_BLOCK_TEXT, /只能收尾；收尾只许截图和关窗/); assert.match(REFUSED_BLOCK_TEXT, /问要不要保存/); assert.match(REFUSED_BLOCK_TEXT, /停下放锁/); assert.match(REFUSED_BLOCK_TEXT, /留给主人/);
      for (const p of [{ action: 'screenshot' }, { action: 'zoom' }, { action: 'list_windows' }, { action: 'key', keys: 'cmd+w' }, { action: 'bring_to_front' }]) assert.equal(e.call('y-' + Math.random(), e.wolf, p), undefined, `${dec} ${JSON.stringify(p)}`);
      e.done('nope', true);
      const rec = stuckPeek(stuckPathOf(e.lockPath)).threads[THREAD_A]; assert.ok(rec.errors === 0, '被硬挡的调用没记成放行，不计数');
    } finally { e.cleanup(); }
  }
});

test('硬拦：标记跟着线程、不跟着锁——放锁再拿锁照样挡；别的线程不受影响；锁日志记 refused-block', () => {
  const e = stuckEnv();
  try {
    refusedAfter(e, 'deny');
    assert.equal(e.call('a', e.wolf, { action: 'left_click' }).block, true);
    releaseLock({ lockPath: e.lockPath, threadId: THREAD_A, now: T0 + 5000 });
    assert.equal(readLock(e.lockPath), null);
    e.setNow(T0 + 20_000);
    assert.equal(e.call('b', e.wolf, { action: 'left_click' })?.blockReason, REFUSED_BLOCK_TEXT, '放锁再拿锁：照样挡');
    assert.equal(readLock(e.lockPath).threadId, THREAD_A, '新锁已经拿上，仍然只许收尾');
    assert.equal(e.call('c', e.wolf, { action: 'key', keys: 'cmd+w' }), undefined);
    releaseLock({ lockPath: e.lockPath, threadId: THREAD_A, now: T0 + 25_000 });
    // 别的线程不受影响
    const B_CTX = { agentId: 'desktop', sessionKey: 'agent:desktop:discord:channel:100000000000000146' };
    e.setNow(T0 + 30_000);
    assert.equal(e.call('d', B_CTX, { action: 'left_click' }), undefined, '别的线程照常点击');
    assert.equal(threadRefusedState(refusedPathOf(e.lockPath), '100000000000000146', T0), null);
    assert.ok(threadRefusedState(refusedPathOf(e.lockPath), THREAD_A, Date.now()));
  } finally { e.cleanup(); }
});

test('硬拦：这个线程又出了新卡、而且新卡被批准（allow-once）才放开；新卡又被拒或过期，标记还在（并刷新）；没批准之前即使记了新的等确认也不放开', () => {
  const e = stuckEnv();
  try {
    refusedAfter(e, 'timeout');
    releaseLock({ lockPath: e.lockPath, threadId: THREAD_A, now: T0 + 2000 });
    e.setNow(T0 + 10_000);
    assert.equal(e.call('p1', e.wolf, { action: 'screenshot' }), undefined); // 重新拿锁
    holdForConfirmation({ lockPath: e.lockPath, threadId: THREAD_A, what: '重新申请的一项', now: T0 + 11_000 });
    assert.ok(threadRefusedState(refusedPathOf(e.lockPath), THREAD_A, T0 + 11_000), '只记了等确认，还没批准：标记在');
    const card = e.call('p2', e.wolf, { action: 'left_click' }); assert.ok(card.requireApproval, '新卡照出（点击这一下是被卡拦住，不是白名单）');
    card.requireApproval.onResolution('cancelled'); // 新卡又过期
    assert.ok(threadRefusedState(refusedPathOf(e.lockPath), THREAD_A, T0 + 12_000), '又过期：标记还在');
    assert.equal(e.call('p3', e.wolf, { action: 'left_click' })?.blockReason, REFUSED_BLOCK_TEXT);
    holdForConfirmation({ lockPath: e.lockPath, threadId: THREAD_A, what: '第三项', now: T0 + 13_000 });
    const c3 = e.call('p4', e.wolf, { action: 'left_click' }); assert.ok(c3.requireApproval); c3.requireApproval.onResolution('allow-once');
    assert.equal(threadRefusedState(refusedPathOf(e.lockPath), THREAD_A, T0 + 14_000), null, '新卡被批准：标记清掉');
    assert.equal(e.call('p5', e.wolf, { action: 'left_click' }), undefined, '放开，可以点击（这一项已批准）');
  } finally { e.cleanup(); }
});

test('硬拦：程序出错一律按挡处理——标记文件读不懂时所有屏幕调用被挡（外层 catch），标记写不进去时锁不放回做事中（再动屏幕就出新卡）', () => {
  const e = stuckEnv();
  try {
    e.call('t0');
    writeFileSync(refusedPathOf(e.lockPath), '{坏的');
    const r = e.call('z1', e.wolf, { action: 'screenshot' });
    assert.equal(r?.block, true, '读不懂：连截图也挡（出错按挡）'); assert.match(r.blockReason, /桌面锁检查出错/);
  } finally { e.cleanup(); }
  const e2 = stuckEnv();
  try {
    e2.call('t0'); holdForConfirmation({ lockPath: e2.lockPath, threadId: THREAD_A, what: '提交表单', now: T0 + 1000 });
    const card = e2.call('c1'); assert.ok(card.requireApproval);
    mkdirSync(refusedPathOf(e2.lockPath)); // 让写标记失败（路径是个目录）
    card.requireApproval.onResolution('cancelled');
    assert.equal(readLock(e2.lockPath).state, 'waiting', '标记没写成：锁仍停在等确认，不放行');
    assert.ok(e2.call('c2').requireApproval, '再动屏幕就出新卡');
  } finally { e2.cleanup(); }
});

test('硬拦：标记 24 小时后自己过期（不然这个线程以后什么都点不了）；clearThreadRefused／markThreadRefused 的基本行为', () => {
  const e = stuckEnv();
  try {
    const path = refusedPathOf(e.lockPath);
    assert.equal(threadRefusedState(path, THREAD_A, T0), null, '没有文件：没有标记');
    markThreadRefused(path, THREAD_A, { at: T0, reason: 'approval-cancelled', what: '提交' });
    assert.ok(threadRefusedState(path, THREAD_A, T0 + REFUSED_EXPIRE_MS - 1)); assert.equal(threadRefusedState(path, THREAD_A, T0 + REFUSED_EXPIRE_MS + 1), null);
    assert.equal(clearThreadRefused(path, THREAD_A), true); assert.equal(clearThreadRefused(path, THREAD_A), false);
    assert.equal(threadRefusedState(null, THREAD_A), null, '没给路径：当没有标记');
    markThreadRefused(path, THREAD_A); markThreadRefused(path, '100000000000000165');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8')).threads).sort(), [THREAD_A, '100000000000000165'].sort());
    assert.match(REFUSED_FILE_ERROR_TEXT, /出错一律按挡/);
  } finally { e.cleanup(); }
});


test('日志：已求助／已回的锁日志里记 via（message_sending＝普通回复；before_tool_call＝message 工具），演练时能分清走的哪一路', () => {
  const e = stuckEnv();
  try {
    e.call('t1'); e.sending({ content: `${TASK_AUDITOR_MENTION} 【求助】卡住了` }, e.wolf);
    e.sending({ content: '【求助回复】试试这个' }, { agentId: 'task-auditor', sessionKey: 'agent:task-auditor:discord:channel:100000000000000145' }, { threadId: THREAD_A });
    const rows = readFileSync(join(e.lockPath, '..', 'gate.log'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
    assert.equal(rows.find((r) => r.decision === 'stuck-help-requested').via, 'message_sending'); assert.equal(rows.find((r) => r.decision === 'stuck-help-answered').via, 'message_sending');
    const e2 = stuckEnv();
    try {
      e2.call('t1'); e2.msgTool({ toolName: 'message', params: { message: `${TASK_AUDITOR_MENTION} 【求助】卡住了` } }, e2.wolf);
      const r2 = readFileSync(join(e2.lockPath, '..', 'gate.log'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
      assert.equal(r2.find((r) => r.decision === 'stuck-help-requested').via, 'before_tool_call');
    } finally { e2.cleanup(); }
  } finally { e.cleanup(); }
});
