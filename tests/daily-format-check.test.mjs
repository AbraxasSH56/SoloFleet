// Offline tests for daily format check: temporary directories and fake data only; nothing touches a real deployment.
// 日审“格式抽查＋转手数数”固定脚本离线测试。运行：node --test tests/daily-format-check.test.mjs
// 全部在临时目录里用假数据跑，不碰真实的资料、任务板和 Discord。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkTaskRecord, scanTaskRecords, checkLedgerText, scanLedger, checkCard, countHandoffs, snowflakeMs, windowOf, run, bizDateOf, CHAT_CHANNEL, LIMITS,
} from '../scripts/automation/daily-format-check.mjs';

const NOW = Date.parse('2026-11-22T12:10:00Z'); // 测试时区（UTC+5:30） 17:40
const sf = (ms, extra = 0) => String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(extra));

const GOOD = `# 任务记录：x\n\n## 当前状态\n\n状态：进行中 ｜ 11-22 10:00\n一句话：在做\n\n## 等主人拍板\n\n无\n\n## 下一步\n\n继续\n`;
const withStatus = (s) => GOOD.replace('状态：进行中 ｜ 11-22 10:00', s);
const WAIT_EMPTY = withStatus('状态：等主人 ｜ 11-22 10:00');
const WAIT_FILLED = WAIT_EMPTY.replace('\n无\n', '\n问的是：选哪个\n选项：1 …\n推荐：1\n问在：11-22\n结果：还没回\n');

test('F1 任务记录：合格的不报；缺状态行、开头不对、模板原样都报', () => {
  assert.deepEqual(checkTaskRecord(GOOD), []);
  for (const h of ['完成', '没跑成', '卡住', '等主人']) assert.ok(!checkTaskRecord(withStatus(`状态：${h} ｜ x`)).some((x) => x.includes('开头')), h);
  assert.match(checkTaskRecord(GOOD.replace('状态：进行中 ｜ 11-22 10:00\n', ''))[0], /没有“状态：”一行/);
  assert.match(checkTaskRecord(withStatus('状态：做完了 ｜ x'))[0], /开头不是/);
  assert.match(checkTaskRecord(withStatus('状态：<完成／进行中／没跑成／等主人／卡住> ｜ <日期>'))[0], /模板原样/);
  assert.match(checkTaskRecord('# 任务记录\n\n## 目标\n\nx\n')[0], /没有“当前状态”一节/);
  assert.deepEqual(checkTaskRecord(withStatus('状态:完成 ｜ x')), [], '半角冒号也认');
});

test('F2 状态写了等主人，拍板一节空着／只写无／缺失／模板提示 → 报；填了的不报', () => {
  assert.match(checkTaskRecord(WAIT_EMPTY).join(), /拍板.*空的或只写“无”/);
  assert.match(checkTaskRecord(WAIT_EMPTY.replace('\n无\n', '\n\n')).join(), /空的或只写“无”/);
  assert.match(checkTaskRecord(WAIT_EMPTY.replace('\n无\n', '\n<没有写"无"。有请示时写下面五行>\n')).join(), /空的或只写“无”/, '模板提示不算填了');
  assert.match(checkTaskRecord(WAIT_EMPTY.replace(/## 等主人拍板\n\n无\n\n/, '')).join(), /没有“等主人拍板”一节/);
  assert.deepEqual(checkTaskRecord(WAIT_FILLED), []);
  assert.deepEqual(checkTaskRecord(GOOD), [], '状态不是等主人，拍板节写无是正常的');
});

test('scanTaskRecords：只看窗口内改过的；旧记录只计数；读不了的写未能检查', () => {
  const root = mkdtempSync(join(tmpdir(), 'dfc-'));
  try {
    const dir = join(root, '项目', 'P', '任务'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.md'), GOOD); writeFileSync(join(dir, 'b.md'), WAIT_EMPTY); writeFileSync(join(dir, 'c.md'), GOOD); writeFileSync(join(dir, '.hidden.md'), GOOD); writeFileSync(join(dir, 'x.txt'), 'x');
    const t = NOW / 1000;
    utimesSync(join(dir, 'a.md'), t, t); utimesSync(join(dir, 'b.md'), t, t); utimesSync(join(dir, 'c.md'), t - 3 * 86400, t - 3 * 86400);
    const notes = [];
    const r = scanTaskRecords(root, NOW - 86400000, NOW, notes, 0);
    assert.deepEqual(r.checked.map((x) => x.file).sort(), ['项目/P/任务/a.md', '项目/P/任务/b.md']);
    assert.equal(r.bad.length, 1); assert.equal(r.oldCount, 0);
    const r2 = scanTaskRecords(root, NOW - 86400000, NOW, notes, Date.now() + 1e9); // 当成全是旧记录
    assert.equal(r2.checked.length, 0); assert.equal(r2.oldCount, 2);
    const n2 = []; scanTaskRecords(join(root, '不存在'), 0, NOW, n2, 0);
    assert.match(n2[0], /未能检查：任务记录/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('F4 决定账本：缺日期、缺原话、原话后面空 → 报；单行写法认；自上一轮以来没改过就不查', () => {
  const led = `# 决定账本\n\n## 一、有效的决定\n\n### D-001 好\n- 日期：01-15 ｜ 适用：全部\n- 原话：「不砍」\n- 取代关系：无。\n\n### D-002 缺日期\n- 适用：全部\n- 原话：转述，出处：x\n\n### D-003 缺原话\n- 日期：10-13 ｜ 适用：全部\n- 取代关系：无。\n\n### D-004 原话空\n- 日期：10-13\n- 原话：\n- 取代关系：无。\n\n## 二、已被取代\n\n### S-1 单行\n- 日期：10-30 ｜ 被 D-020 取代 ｜ 原话：转述，出处：y\n`;
  const r = checkLedgerText(led);
  assert.equal(r.total, 5);
  assert.deepEqual(r.bad, [{ id: 'D-002', miss: ['日期'] }, { id: 'D-003', miss: ['原话：'] }, { id: 'D-004', miss: ['原话：'] }]);
  const root = mkdtempSync(join(tmpdir(), 'dfc-'));
  try {
    writeFileSync(join(root, '决定账本.md'), led);
    const old = (NOW - 5 * 86400000) / 1000; utimesSync(join(root, '决定账本.md'), old, old);
    assert.equal(scanLedger(root, NOW - 86400000, []).skipped, true);
    assert.equal(scanLedger(root, NOW - 10 * 86400000, []).bad.length, 3);
    const n = []; assert.equal(scanLedger(join(root, 'x'), 0, n).unreadable, true); assert.match(n[0], /未能检查：决定账本/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const NOTES_OK = '【审计级别】单审（任务审计） ｜ 主人确认于 2031-02-14\n\n【授权范围】\n目标：x\n允许做的：y\n要主人确认的：z\n停止条件：w\n';
const card = (o = {}) => ({ id: 'c1', title: 't', notes: NOTES_OK, labels: ['审计:单审任务审计'], comments: [], created_at: NOW, updated_at: NOW, ...o });
const ctx = { startMs: NOW - 86400000, snapshotAt: null, snapshot: null };

test('F3 任务卡：四项齐的不报；缺标签、缺级别行、缺授权块、缺某一行都报；旧写法“要主人确认的”也算', () => {
  assert.deepEqual(checkCard(card(), ctx), []);
  assert.deepEqual(checkCard(card({ notes: NOTES_OK.replace('要主人确认的', '要主人确认的') }), ctx), []);
  assert.match(checkCard(card({ labels: [] }), ctx).join(), /没有 审计:… 标签/);
  assert.match(checkCard(card({ notes: NOTES_OK.replace('【审计级别】', '级别') }), ctx).join(), /没有【审计级别】/);
  assert.match(checkCard(card({ notes: '【审计级别】x\n没有别的' }), ctx).join(), /没有【授权范围】块/);
  assert.match(checkCard(card({ notes: NOTES_OK.replace('停止条件：w\n', '') }), ctx).join(), /缺：停止条件/);
  assert.match(checkCard(card({ notes: NOTES_OK.replace('目标：x\n', '').replace('允许做的：y\n', '') }), ctx).join(), /缺：目标、允许做的/);
});

test('F3 升降级：评论有改动记录但没有确认 → 报；确认写法“主人于 日期 确认”“主人 03-04 批准”都认；相邻评论也算', () => {
  const chg = { ordinal: 1, body: '审计级别：单审（任务审计） → 串联，原因：后果大', created_at: NOW };
  assert.match(checkCard(card({ comments: [chg] }), ctx).join(), /升降级缺确认/);
  assert.deepEqual(checkCard(card({ comments: [{ ...chg, body: chg.body + '，主人于 03-09 确认' }] }), ctx), []);
  assert.deepEqual(checkCard(card({ comments: [{ ...chg, body: chg.body + '；主人 03-04 批准' }] }), ctx), []);
  assert.deepEqual(checkCard(card({ comments: [chg, { ordinal: 2, body: '主人确认了', created_at: NOW }] }), ctx), [], '相邻评论里的确认');
  assert.deepEqual(checkCard(card({ comments: [{ ...chg, created_at: NOW - 3 * 86400000 }] }), ctx), [], '窗口以前的改动记录不再查');
});

test('F3 标签快照：标签变了却没留评论记录 → 报；留了记录 → 不报；第一次没快照 → 不报', () => {
  const snap = { c1: { audit: '审计:单审任务审计', level: '【审计级别】单审（任务审计） ｜ 主人确认于 2031-02-14' } };
  const changed = card({ labels: ['审计:串联'] });
  assert.match(checkCard(changed, { ...ctx, snapshotAt: NOW - 3600000, snapshot: snap }).join(), /标签或级别行变了/);
  assert.deepEqual(checkCard(card(), { ...ctx, snapshotAt: NOW - 3600000, snapshot: snap }), []);
  const rec = { ordinal: 1, body: '审计级别：单审任务审计 → 串联，主人于 03-09 确认', created_at: NOW };
  assert.deepEqual(checkCard({ ...changed, comments: [rec] }, { ...ctx, snapshotAt: NOW - 3600000, snapshot: snap }), []);
  assert.deepEqual(checkCard(changed, ctx), [], '没有快照＝第一次，不报');
});

test('H1 转手条数：bot 点名另一个 bot 才算；一条点几个只算一条；点自己、点人、人发的都不算；编号表外的 bot 另记', () => {
  const bots = new Set(['1', '2', '3']);
  const msgs = [
    { id: '10', author: { id: '1' }, content: '<@2> 你来' },
    { id: '11', author: { id: '2' }, content: '<@1> <@3> 收到' },
    { id: '12', author: { id: '1' }, content: '<@1> 自己点自己' },
    { id: '13', author: { id: '1' }, content: '<@999> 点的是人' },
    { id: '14', author: { id: '999' }, content: '<@1> 人发的' },
    { id: '15', author: { id: '77', bot: true }, content: '<@1> 编号表外的 bot' },
    { id: '16', author: { id: '3' }, content: '没点名' },
  ];
  const r = countHandoffs(msgs, bots);
  assert.equal(r.n, 2); assert.deepEqual(r.unknownBots, ['77']);
});

test('窗口：业务日期取当天（17:40 不退成昨天）；起点取最近一份“执行: 完成”的截止点，没有就取前 24 小时', () => {
  const root = mkdtempSync(join(tmpdir(), 'dfc-'));
  try {
    assert.equal(bizDateOf(NOW), '2026-11-22');
    let w = windowOf(NOW, root);
    assert.equal(w.bizDate, '2026-11-22'); assert.equal(w.cutMs, Date.parse('2026-11-22T12:35:00Z')); assert.equal(w.startMs, w.cutMs - 86400000); assert.equal(w.endMs, NOW);
    const d = join(root, '审计', '日审'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '2026-11-20.json'), JSON.stringify({ 执行: '完成', 截止点: '2026-11-20T18:05:00+05:30' }));
    writeFileSync(join(d, '2026-11-21.json'), JSON.stringify({ 执行: '完成', 截止点: '2026-11-21T18:05:00+05:30' }));
    writeFileSync(join(d, '2026-11-19.json'), JSON.stringify({ 执行: '未完成', 截止点: '2026-11-22T00:00:00+05:30' }));
    writeFileSync(join(d, '2026-11-22.json'), JSON.stringify({ 执行: '完成', 截止点: '2026-11-22T18:05:00+05:30' })); // 不早于本轮截止点：不算
    writeFileSync(join(d, '坏.json'), '不是 JSON');
    w = windowOf(NOW, root);
    assert.equal(w.startMs, Date.parse('2026-11-21T12:35:00Z'));
    const late = Date.parse('2026-11-22T13:00:00Z'); // 18:30：终点封在截止点
    assert.equal(windowOf(late, root).endMs, Date.parse('2026-11-22T12:35:00Z'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- 整条流程（假依赖） ----------
const BOTS = [{ 角色: 'main', Discord编号: '1001' }, { 角色: 'worker-e', Discord编号: '1002' }, { 角色: 'worker-a', Discord编号: '1003' }];
function world({ threads, messages, cards = [], cardsFail = false, listFail = false, clockStep = 0 }) {
  const root = mkdtempSync(join(tmpdir(), 'dfc-'));
  mkdirSync(join(root, '审计', '日审'), { recursive: true });
  writeFileSync(join(root, '审计', '日审', 'bot编号表.json'), JSON.stringify({ 状态: '有效', 人设bot: BOTS }));
  const dir = join(root, '项目', 'P', '任务'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ok.md'), GOOD); writeFileSync(join(dir, 'bad.md'), WAIT_EMPTY);
  // 修改时间设到假时钟窗口里（假时钟前 1 小时）：不设的话文件时间是真实当下，真实时间一过假时钟（17:40）就会被程序当成“窗口以后改的”跳过
  const mt = (NOW - 3600000) / 1000; utimesSync(join(dir, 'ok.md'), mt, mt); utimesSync(join(dir, 'bad.md'), mt, mt);
  const st = { clock: NOW, reads: [], cards };
  const deps = {
    now: () => { st.clock += clockStep; return st.clock; },
    listThreads: async () => { if (listFail) throw new Error('boom'); return threads; },
    readMessages: async (id, before) => {
      st.reads.push([id, before]);
      const m = messages[id]; if (m instanceof Error) throw m;
      const sorted = [...m].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
      const page = before ? sorted.filter((x) => BigInt(x.id) < BigInt(before)) : sorted;
      return page.slice(0, 100);
    },
    readCards: async () => { if (cardsFail) throw new Error('数据库打不开'); return st.cards; },
  };
  return { root, deps, st };
}
const mkMsgs = (ids, n, base) => Array.from({ length: n }, (_, i) => ({ id: sf(base + i * 1000), author: { id: ids[i % 2] }, content: `<@${ids[(i + 1) % 2]}> 第${i}句` }));
const recent = NOW - 3600000;

test('run：端到端——8 条标交日审判断、7 条不标；闲聊线程和闲聊下的线程排除；窗口前的线程不读', async () => {
  const w = world({
    threads: [
      { id: 'T8', name: '八条', last_message_id: sf(recent + 99999), parent_id: 'P1' },
      { id: 'T7', name: '七条', last_message_id: sf(recent + 99999), parent_id: 'P1' },
      { id: CHAT_CHANNEL, name: '闲聊本身', last_message_id: sf(recent), parent_id: 'X' },
      { id: 'TC', name: '闲聊下的线程', last_message_id: sf(recent), parent_id: CHAT_CHANNEL },
      { id: 'TOLD', name: '老线程', last_message_id: sf(NOW - 5 * 86400000), parent_id: 'P1' },
    ],
    messages: { T8: mkMsgs(['1001', '1002'], 8, recent), T7: mkMsgs(['1001', '1002'], 7, recent) },
    cards: [card({ id: 'cardA', title: '好卡' }), card({ id: 'cardB', title: '坏卡', labels: [] })],
  });
  try {
    const r = await run({ dataRoot: w.root, deps: w.deps, nowMs: NOW });
    const text = readFileSync(r.out, 'utf8');
    assert.match(text, /^# 格式抽查 · 2026-11-22/m); assert.match(text, /^状态：完整/m);
    assert.match(text, /\| T8 \| 八条 \| 8 \| 8 \| \*\*交日审判断\*\* \|/);
    assert.match(text, /\| T7 \| 七条 \| 7 \| 7 \| <8，脚本数，不必读 \|/);
    assert.ok(!text.includes('闲聊'), '闲聊线程不出现');
    assert.ok(!text.includes('TOLD'), '窗口前的线程不读');
    assert.deepEqual(w.st.reads.map((x) => x[0]).sort(), ['T7', 'T8']);
    assert.match(text, /bad\.md：.*等主人.*空的或只写“无”/); assert.match(text, /ok\.md：合格/);
    assert.match(text, /坏卡：没有 审计:… 标签/); assert.match(text, /好卡：合格/);
    assert.match(text, /（第一次运行：只建了审计标签快照/);
    assert.ok(existsSync(join(w.root, '运行记录', '格式抽查', '卡标签快照.json')));
    assert.equal(r.summary.flagged, 1);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('run：第二遍——标签变了没留记录报出来；留了记录不报', async () => {
  const w = world({ threads: [], messages: {}, cards: [card({ id: 'cardA', title: '甲' })] });
  try {
    await run({ dataRoot: w.root, deps: w.deps, nowMs: NOW });
    w.st.cards = [card({ id: 'cardA', title: '甲', labels: ['审计:串联'] })];
    let text = readFileSync((await run({ dataRoot: w.root, deps: w.deps, nowMs: NOW + 1000 })).out, 'utf8');
    assert.match(text, /甲：.*标签或级别行变了/);
    w.st.cards = [card({ id: 'cardA', title: '甲', labels: ['审计:单审独立'], comments: [{ ordinal: 1, body: '审计级别：串联 → 单审独立，主人于 03-09 确认', created_at: NOW + 5000 }] })];
    text = readFileSync((await run({ dataRoot: w.root, deps: w.deps, nowMs: NOW + 2000 })).out, 'utf8');
    const sec = text.split('## 任务卡')[1].split('## 决定账本')[0];
    assert.match(sec, /甲：合格/); assert.ok(!/标签或级别行变了/.test(sec));
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('run：读不到的写“未能检查”，不写成没有——任务板打不开、线程列不出、单条线程读错', async () => {
  const w = world({ threads: [{ id: 'T1', name: 'a', last_message_id: sf(recent), parent_id: 'P' }], messages: { T1: new Error('读失败') }, cardsFail: true });
  try {
    const text = readFileSync((await run({ dataRoot: w.root, deps: w.deps, nowMs: NOW })).out, 'utf8');
    assert.match(text, /未能检查：任务卡（读不了任务板：数据库打不开）/);
    assert.match(text, /\| T1 \| a \| \? \| \? \| 未能检查（读失败）/);
    assert.ok(!existsSync(join(w.root, '运行记录', '格式抽查', '卡标签快照.json')), '任务卡没读成就不更新快照');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
  const w2 = world({ threads: [], messages: {}, listFail: true });
  try {
    const text = readFileSync((await run({ dataRoot: w2.root, deps: w2.deps, nowMs: NOW })).out, 'utf8');
    assert.match(text, /未能检查：转手条数（列不出线程：boom）/);
    assert.match(text, /^状态：未完成/m, '列不出线程是一次性的失败，算未完成，18:00 再试');
  } finally { rmSync(w2.root, { recursive: true, force: true }); }
});

test('run：线程列表官方说没列完（has_more）→ 写明可能不全', async () => {
  const list = []; list.hasMore = true;
  const w = world({ threads: list, messages: {} });
  try {
    assert.match(readFileSync((await run({ dataRoot: w.root, deps: w.deps, nowMs: NOW })).out, 'utf8'), /has_more.*可能不全/);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('run：编号表读不到→转手条数写未能检查；表里没有的 bot 记“编号表缺”', async () => {
  const w = world({ threads: [], messages: {} });
  try {
    rmSync(join(w.root, '审计', '日审', 'bot编号表.json'));
    assert.match(readFileSync((await run({ dataRoot: w.root, deps: w.deps, nowMs: NOW })).out, 'utf8'), /未能检查：转手条数（读不到 bot编号表.json）/);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
  const w2 = world({ threads: [{ id: 'T1', name: 'a', last_message_id: sf(recent), parent_id: 'P' }], messages: { T1: [{ id: sf(recent), author: { id: '555', bot: true }, content: '<@1001> hi' }] } });
  try {
    assert.match(readFileSync((await run({ dataRoot: w2.root, deps: w2.deps, nowMs: NOW })).out, 'utf8'), /编号表缺：555/);
  } finally { rmSync(w2.root, { recursive: true, force: true }); }
});

test('run：超过 100 条要翻页读到线程开头；翻页上限到了写明', async () => {
  const msgs = mkMsgs(['1001', '1002'], 230, recent);
  const w = world({ threads: [{ id: 'TB', name: '长', last_message_id: sf(recent + 999999), parent_id: 'P' }], messages: { TB: msgs } });
  try {
    const text = readFileSync((await run({ dataRoot: w.root, deps: w.deps, nowMs: NOW })).out, 'utf8');
    assert.match(text, /\| TB \| 长 \| 230 \| 230 \|/);
    assert.equal(w.st.reads.length, 3); assert.equal(w.st.reads[0][1], null); assert.ok(w.st.reads[1][1]);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
  const w2 = world({ threads: [{ id: 'TB', name: '长', last_message_id: sf(recent + 999999), parent_id: 'P' }], messages: { TB: msgs } });
  try {
    const text = readFileSync((await run({ dataRoot: w2.root, deps: w2.deps, nowMs: NOW, limits: { ...LIMITS, maxPages: 2 } })).out, 'utf8');
    assert.match(text, /\| TB \| 长 \| \? \| \? \| 未能检查（消息太多/);
  } finally { rmSync(w2.root, { recursive: true, force: true }); }
});

test('run：读 Discord 的总时间用完 → 停读剩余线程，写“其余线程（超时保护）”，状态标未完成（下一遍会再试）', async () => {
  const threads = Array.from({ length: 5 }, (_, i) => ({ id: `T${i}`, name: `n${i}`, last_message_id: sf(recent + 99999 - i), parent_id: 'P' }));
  const messages = Object.fromEntries(threads.map((t) => [t.id, mkMsgs(['1001', '1002'], 3, recent)]));
  const w = world({ threads, messages, clockStep: 4000 }); // 假时钟每看一次走 4 秒
  try {
    const text = readFileSync((await run({ dataRoot: w.root, deps: w.deps, nowMs: NOW, limits: { ...LIMITS, discordMs: 20000 } })).out, 'utf8');
    assert.match(text, /未能检查：其余线程（超时保护，已读 \d+／共 5）/);
    assert.match(text, /^状态：未完成/m);
    assert.ok(w.st.reads.length < 5);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('run：整个脚本不会写到资料根以外；只写 格式抽查.md 和 运行记录/格式抽查/ 下的快照', async () => {
  const w = world({ threads: [], messages: {}, cards: [card()] });
  try {
    const before = new Set();
    const { readdirSync } = await import('node:fs');
    const walk = (d, acc) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); acc.add(p); if (e.isDirectory()) walk(p, acc); } return acc; };
    walk(w.root, before);
    await run({ dataRoot: w.root, deps: w.deps, nowMs: NOW });
    const after = walk(w.root, new Set());
    const created = [...after].filter((p) => !before.has(p)).map((p) => p.slice(w.root.length + 1)).sort();
    assert.deepEqual(created, ['审计/日审/2026-11-22-格式抽查.md', '运行记录', '运行记录/格式抽查', '运行记录/格式抽查/卡标签快照.json']);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('超时没跑完时不推进卡标签快照；第二遍重跑仍能报出标签变动；完整跑完才推进', async () => {
  const threads = Array.from({ length: 5 }, (_, i) => ({ id: `T${i}`, name: `n${i}`, last_message_id: sf(recent + 99999 - i), parent_id: 'P' }));
  const messages = Object.fromEntries(threads.map((t) => [t.id, mkMsgs(['1001', '1002'], 3, recent)]));
  const w = world({ threads, messages, cards: [card({ id: 'cardA', title: '甲' })] });
  try {
    await run({ dataRoot: w.root, deps: w.deps, nowMs: NOW }); // 第一遍：完整，建快照
    const snap = join(w.root, '运行记录', '格式抽查', '卡标签快照.json');
    const first = readFileSync(snap, 'utf8');
    w.st.cards = [card({ id: 'cardA', title: '甲', labels: ['审计:串联'] })]; // 被人改了标签，没留记录
    const slow = world({ threads, messages, cards: w.st.cards, clockStep: 4000 });
    // 在同一个资料根上跑慢的一遍：用慢时钟的依赖，但读同一份快照
    const deps2 = { ...slow.deps, readCards: async () => w.st.cards };
    const r2 = await run({ dataRoot: w.root, deps: deps2, nowMs: NOW + 1000, limits: { ...LIMITS, discordMs: 10000 } });
    const t2 = readFileSync(r2.out, 'utf8');
    assert.match(t2, /^状态：未完成/m); assert.match(t2, /甲：.*标签或级别行变了/);
    assert.equal(readFileSync(snap, 'utf8'), first, '没跑完：快照不推进');
    const r3 = await run({ dataRoot: w.root, deps: w.deps, nowMs: NOW + 2000 }); // 第二遍重跑（这次完整）
    assert.match(readFileSync(r3.out, 'utf8'), /甲：.*标签或级别行变了/, '重跑仍能报出，没被洗白');
    assert.notEqual(readFileSync(snap, 'utf8'), first, '完整跑完才推进');
    const r4 = await run({ dataRoot: w.root, deps: w.deps, nowMs: NOW + 3000 });
    assert.ok(!/甲：.*标签或级别行变了/.test(readFileSync(r4.out, 'utf8')), '推进之后不再重复报');
    slow.root && rmSync(slow.root, { recursive: true, force: true });
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('任务板读不到、线程列不出算“未完成”（18:00 会再试）；超过上限的线程写明；编号表缺字段不变成 "undefined"', async () => {
  const w = world({ threads: [], messages: {}, cardsFail: true });
  try { assert.match(readFileSync((await run({ dataRoot: w.root, deps: w.deps, nowMs: NOW })).out, 'utf8'), /^状态：未完成/m); } finally { rmSync(w.root, { recursive: true, force: true }); }
  const w2 = world({ threads: [], messages: {}, listFail: true });
  try { assert.match(readFileSync((await run({ dataRoot: w2.root, deps: w2.deps, nowMs: NOW })).out, 'utf8'), /^状态：未完成/m); } finally { rmSync(w2.root, { recursive: true, force: true }); }
  const many = Array.from({ length: 5 }, (_, i) => ({ id: `T${i}`, name: `n${i}`, last_message_id: sf(recent + 99999 - i), parent_id: 'P' }));
  const w3 = world({ threads: many, messages: Object.fromEntries(many.map((t) => [t.id, mkMsgs(['1001', '1002'], 2, recent)])) });
  try { assert.match(readFileSync((await run({ dataRoot: w3.root, deps: w3.deps, nowMs: NOW, limits: { ...LIMITS, maxThreads: 3 } })).out, 'utf8'), /超过 3 个活跃线程，只读了最新的 3 个/); } finally { rmSync(w3.root, { recursive: true, force: true }); }
  const w4 = world({ threads: [{ id: 'T1', name: 'a', last_message_id: sf(recent), parent_id: 'P' }], messages: { T1: [{ id: sf(recent), author: { id: 'undefined', bot: true }, content: '<@1001> hi' }] } });
  try {
    writeFileSync(join(w4.root, '审计', '日审', 'bot编号表.json'), JSON.stringify({ 状态: '有效', 人设bot: [{ 角色: 'x' }, { 角色: 'main', Discord编号: '1001' }] }));
    const t4 = readFileSync((await run({ dataRoot: w4.root, deps: w4.deps, nowMs: NOW })).out, 'utf8');
    assert.match(t4, /编号表缺：undefined/, '作者编号恰好是字符串 undefined 也不会被当成编号表里的 bot');
  } finally { rmSync(w4.root, { recursive: true, force: true }); }
});

test('审计级别行单独变了：提示里分开写标签和级别行', () => {
  const snap = { c1: { audit: '审计:单审任务审计', level: '【审计级别】单审（任务审计） ｜ 主人确认于 2031-02-14' } };
  const m = checkCard(card({ notes: NOTES_OK.replace('单审（任务审计）', '串联') }), { ...ctx, snapshotAt: NOW - 3600000, snapshot: snap }).join();
  assert.match(m, /【审计级别】行/); assert.ok(!/标签 审计/.test(m));
});

// ---------- 入口：锁和总时限（上线后复核 ③-4） ----------
const SCRIPT = fileURLToPath(new URL('../scripts/automation/daily-format-check.mjs', import.meta.url));
const mkStub = (dir, body) => { const f = join(dir, 'stub-openclaw.sh'); writeFileSync(f, `#!/bin/bash\n${body}\n`, { mode: 0o755 }); return f; };

test('入口：别的一遍还在跑（锁在、进程活着）→ 这一遍不跑、记一行、退出码 0；不碰当天结果文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'dfcm-'));
  try {
    const sd = join(root, '运行记录', '格式抽查'); mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, '运行.lock'), JSON.stringify({ at: Date.now(), pid: process.pid })); // 本测试进程自己：活着
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 20000, env: { ...process.env, OPENCLAW_DATA_ROOT: root, OPENCLAW_BIN: mkStub(root, 'exit 1') } });
    assert.equal(r.status, 0);
    assert.match(readFileSync(join(sd, '运行.log'), 'utf8'), /上一遍还在跑/);
    assert.ok(!existsSync(join(root, '审计', '日审')) || readdirSync(join(root, '审计', '日审')).length === 0, '没跑，不写结果文件');
    assert.ok(existsSync(join(sd, '运行.lock')), '别人的锁不删');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('入口：老锁（进程已不在，且超过 10 分钟）→ 回收后正常跑完并清掉自己的锁', () => {
  const root = mkdtempSync(join(tmpdir(), 'dfcm-'));
  try {
    const sd = join(root, '运行记录', '格式抽查'); mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, '运行.lock'), JSON.stringify({ at: Date.now() - 3600000, pid: 999999 }));
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 60000, env: { ...process.env, OPENCLAW_DATA_ROOT: root, OPENCLAW_BIN: mkStub(root, 'echo "{}"'), OPENCLAW_WORKBOARD_DB: join(root, '不存在.sqlite') } });
    assert.equal(r.status, 0, r.stderr);
    const log = readFileSync(join(sd, '运行.log'), 'utf8');
    assert.match(log, /回收了老锁/); assert.match(log, /完成/);
    assert.ok(!existsSync(join(sd, '运行.lock')), '跑完清掉自己的锁');
    assert.ok(readdirSync(join(root, '审计', '日审')).some((f) => f.endsWith('-格式抽查.md')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('入口：总时限到了强制结束（退出码 3），清掉自己的锁，记一行；不留半截结果文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'dfcm-'));
  try {
    const stub = mkStub(root, 'sleep 30'); // 假的 openclaw 一直不返回
    mkdirSync(join(root, '审计', '日审'), { recursive: true });
    writeFileSync(join(root, '审计', '日审', 'bot编号表.json'), JSON.stringify({ 状态: '有效', 人设bot: [{ 角色: 'main', Discord编号: '1001' }] })); // 有编号表才会去列线程，才会卡在假命令上
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 20000, env: { ...process.env, OPENCLAW_DATA_ROOT: root, OPENCLAW_BIN: stub, OPENCLAW_DFC_TOTAL_MS: '1500', OPENCLAW_WORKBOARD_DB: join(root, '不存在.sqlite') } });
    assert.equal(r.status, 3); assert.ok(Date.now() - t0 < 15000);
    const sd = join(root, '运行记录', '格式抽查');
    assert.match(readFileSync(join(sd, '运行.log'), 'utf8'), /超过总时限/);
    assert.ok(!existsSync(join(sd, '运行.lock')));
    assert.ok(!readdirSync(join(root, '审计', '日审')).some((f) => f.endsWith('-格式抽查.md')), '被强杀时不留结果文件');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('单条线程读失败（真超时报 Command failed）也算未完成、不推进快照；编号表读不到同样；“消息太多”这种重试也没用的不算', async () => {
  const mk = (err, extra = {}) => world({ threads: [{ id: 'T1', name: 'a', last_message_id: sf(recent), parent_id: 'P' }], messages: { T1: err }, cards: [card({ id: 'cardA', title: '甲' })], ...extra });
  const snapOf = (w) => join(w.root, '运行记录', '格式抽查', '卡标签快照.json');
  const w = mk(new Error('Command failed: openclaw message read'));
  try {
    const t = readFileSync((await run({ dataRoot: w.root, deps: w.deps, nowMs: NOW })).out, 'utf8');
    assert.match(t, /^状态：未完成/m); assert.match(t, /未能检查（Command failed/); assert.ok(!existsSync(snapOf(w)), '没跑完：不建／不推进快照');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
  const w2 = mk([]);
  try {
    rmSync(join(w2.root, '审计', '日审', 'bot编号表.json'));
    const t = readFileSync((await run({ dataRoot: w2.root, deps: w2.deps, nowMs: NOW })).out, 'utf8');
    assert.match(t, /^状态：未完成/m); assert.ok(!existsSync(snapOf(w2)));
  } finally { rmSync(w2.root, { recursive: true, force: true }); }
  const w3 = world({ threads: [{ id: 'TB', name: '长', last_message_id: sf(recent + 999999), parent_id: 'P' }], messages: { TB: mkMsgs(['1001', '1002'], 230, recent) }, cards: [card()] });
  try {
    const t = readFileSync((await run({ dataRoot: w3.root, deps: w3.deps, nowMs: NOW, limits: { ...LIMITS, maxPages: 2 } })).out, 'utf8');
    assert.match(t, /^状态：完整/m, '消息太多是重试也没用的，不拖着快照不动'); assert.ok(existsSync(snapOf(w3)));
  } finally { rmSync(w3.root, { recursive: true, force: true }); }
});
