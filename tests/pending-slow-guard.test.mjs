// Offline tests for pending slow guard: temporary directories and fake data only; nothing touches a real deployment.
// “等你定”整轮总时限离线测试（补登记修改·①-3）。运行：node --test tests/pending-slow-guard.test.mjs
// runTick 带 deadlineAt：到点不再起新的读、读命令上限取“剩余和 60 秒里小的”、到点不再开始发送；没读的不算读取失败；状态照常落盘解锁。不带 deadlineAt＝和以前一样。
// 全部用假时钟、假 Discord、临时目录里的台账；不碰真实台账和真实 Discord。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLedger, registerItem, runTick, readLedgerFile } from '../plugins/personal-inbox/pending-ledger.mjs';

const T0 = Date.parse('2026-11-22T03:00:00Z');
function mk({ items = 3, readMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slow-'));
  const path = join(dir, '台账.json');
  const st = { clock: T0, reads: [], sent: [], edits: [], pins: [], readMs, readFail: false };
  const discord = {
    async send(a) { st.sent.push(a); return { messageId: String(900 + st.sent.length) }; },
    async edit(a) { st.edits.push(a); },
    async pin(a) { st.pins.push(a); },
    async readReplies(item, ...rest) { st.reads.push({ id: item.id, args: rest.length, timeoutMs: rest[0], at: st.clock }); st.clock += st.readMs; if (st.readFail) throw new Error('读不到'); return []; },
    async search() { return []; },
    async wakeJudge() { return { jobId: 'j1' }; },
  };
  const setup = () => withLedger(path, (L) => { for (let i = 0; i < items; i++) registerItem(L, { title: `事项${i}`, suggestion: 's', blocks: 'b', requestMessageId: `rq${i}`, requestChannelId: '2001', requestLink: 'L', botId: '99' }, T0); return {}; });
  const tick = (extra = {}) => runTick({ path, now: () => st.clock, discord, watchDir: join(dir, 'watch'), ...extra });
  return { dir, path, st, setup, tick, ledger: () => readLedgerFile(path), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('不带 deadlineAt：和以前一样——readReplies 只收到一个参数，读完照常发总表和首次点名', async () => {
  const t = mk();
  try {
    await t.setup(); await t.tick();
    assert.equal(t.st.reads.length, 3); assert.ok(t.st.reads.every((r) => r.args === 0), '没带总时限时不多传参数');
    assert.ok(t.st.sent.length >= 1, '总表／点名照常发出');
  } finally { t.cleanup(); }
});

test('带 deadlineAt：每次读的命令上限＝剩余时间和 60 秒里小的，最少 1 秒', async () => {
  const t = mk({ readMs: 50000 });
  try {
    await t.setup();
    await t.tick({ deadlineAt: T0 + 100000 });
    // 第一条：剩 100 秒→60 秒；第二条开始时已过 50 秒，剩 50 秒→50 秒；第三条开始时已过 100 秒＝到点→不读
    assert.deepEqual(t.st.reads.map((r) => r.timeoutMs), [60000, 50000]);
  } finally { t.cleanup(); }
});

test('到点：不再起新的读；没读的不改“读取失败”、不动连续读失败计数；不再开始发送；状态落盘、锁放开；下一轮接着读、接着发', async () => {
  const t = mk({ readMs: 70000 });
  try {
    await t.setup();
    await withLedger(t.path, (L) => { L.readFailures = 2; return {}; });
    const r = await t.tick({ deadlineAt: T0 + 100000 }); // 第一条 0→70，第二条 70→140（过了点），第三条不读
    assert.deepEqual(t.st.reads.map((x) => x.id.length > 0), [true, true], '只读了两条');
    const L1 = t.ledger();
    const third = L1.items[2];
    assert.equal(third.responseUnknown ?? null, null, '没读的那条没被标成读取失败');
    assert.equal(L1.readFailures, 2, '有没读的：连续读失败计数不动（既不清零也不加）');
    assert.deepEqual(t.st.sent, []); assert.deepEqual(t.st.edits, []); assert.deepEqual(t.st.pins, [], '到点后不再开始任何发送／编辑／置顶');
    assert.ok(r.actions.some((a) => a.type === 'deadline-skip-reads' && a.n === 1)); assert.ok(r.actions.some((a) => a.type === 'deadline-skip'));
    assert.ok(!existsSync(`${t.path}.lock`), '锁已放开');
    assert.ok(L1.items.every((it) => !it.firstAskedAt), '没点过名的，下一轮才点（状态没改）');
    // 下一轮不带总时限：读完三条、发总表、首次点名
    t.st.readMs = 0; t.st.clock += 1800000;
    await t.tick();
    assert.equal(t.st.reads.length, 5, '下一轮三条都读了（2＋3）');
    assert.ok(t.st.sent.length >= 1 && t.ledger().items.every((it) => it.firstAskedAt), '下一轮发了总表和点名，没有少发');
    assert.equal(t.ledger().readFailures, 0, '全读成功后计数清零');
  } finally { t.cleanup(); }
});

test('读失败照旧计数；到点跳过的读不算失败：有失败又有跳过时只加一次', async () => {
  const t = mk({ items: 2, readMs: 70000 });
  try {
    await t.setup(); t.st.readFail = true;
    await t.tick({ deadlineAt: T0 + 60000 }); // 第一条读（失败）→已过 70 秒到点→第二条不读
    const L = t.ledger();
    assert.match(L.items[0].responseUnknown ?? '', /读取失败/); assert.equal(L.items[1].responseUnknown ?? null, null);
    assert.equal(L.readFailures, 1);
  } finally { t.cleanup(); }
});

test('总用时保证：任何一条命令都慢（每次 59 秒）时，整轮最坏不超过 总时限＋一条最长命令；到点前已经开始的发送最多再用一条', async () => {
  const t = mk({ items: 6, readMs: 0 });
  try {
    await t.setup();
    // 让读和发都很慢（每次 59 秒），总时限 180 秒
    const slow = async (f) => { t.st.clock += 59000; return f(); };
    const start = t.st.clock;
    const discord = {
      async send(a) { return slow(() => { t.st.sent.push(a); return { messageId: String(900 + t.st.sent.length) }; }); },
      async edit(a) { return slow(() => t.st.edits.push(a)); },
      async pin(a) { return slow(() => t.st.pins.push(a)); },
      async readReplies(item, timeoutMs) { return slow(() => { t.st.reads.push({ id: item.id, timeoutMs }); return []; }); },
      async search() { return slow(() => []); },
      async wakeJudge() { return slow(() => ({ jobId: 'j' })); },
    };
    await runTick({ path: t.path, now: () => t.st.clock, discord, watchDir: join(t.dir, 'watch'), deadlineAt: start + 180000 });
    assert.ok(t.st.clock - start <= 180000 + 59000 + 59000, `总用时 ${(t.st.clock - start) / 1000} 秒应不超过 296 秒（总时限 180＋最多两条在途命令）`);
    assert.ok(!existsSync(`${t.path}.lock`), '到点正常解锁');
  } finally { t.cleanup(); }
});

test('pending-decisions.main：把“启动时间＋总时限”当 deadlineAt 传给 runTick（读命令上限＝min(60 秒, 总时限)）；核账被注入时也算在总时限里', async () => {
  const { main } = await import('../scripts/automation/pending-decisions.mjs');
  const t = mk({ items: 1 });
  try {
    await t.setup();
    let clock = T0; const seen = [];
    const discord = { async send() { return { messageId: '1' }; }, async edit() {}, async pin() {}, async search() { return []; }, async readReplies(item, ...r) { seen.push(r[0]); return []; } };
    await main(['--ledger', t.path], { discord, now: () => clock, deadlineMs: 30000, reconcile: async () => { clock += 5000; return {}; } });
    assert.deepEqual(seen, [25000], '核账用了 5 秒，总时限 30 秒，读命令上限只剩 25 秒（也小于 60 秒）');
    seen.length = 0; clock = T0;
    await main(['--ledger', t.path], { discord, now: () => clock, reconcile: async () => ({}) });
    assert.deepEqual(seen, [60000], '默认总时限 180 秒：读命令上限封顶 60 秒');
  } finally { t.cleanup(); }
});
