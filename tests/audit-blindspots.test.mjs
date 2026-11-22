// Offline tests for audit blindspots: temporary directories and fake data only; nothing touches a real deployment.
// 全部用临时目录和假依赖，不碰真任务板、不碰真备份。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reworkOf, reworkReport, ruleFileReport, changedFiles, backupStatus, run, screenLockStats } from '../scripts/automation/audit-blindspots.mjs';
import { execFile } from 'node:child_process';

const NOW = Date.UTC(2026, 10, 12, 12, 30, 0); // 测试时区（UTC+5:30） 11-12 18:00；窗口 11-11 18:05 → 11-12 18:00
const START = Date.UTC(2026, 10, 11, 12, 35, 0), END = NOW;
const T = (h) => new Date(Date.UTC(2026, 10, 12, 0, 0, 0) + h * 3600e3).toISOString();
const mv = (h, from, to) => ({ at: T(h), kind: 'moved', fromStatus: from, toStatus: to });
const card = (id, events, extra = {}) => ({ id, title: `卡${id}`, events, metadata: {}, ...extra });
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'blind-')); return { d, cleanup: () => rmSync(d, { recursive: true, force: true }) }; };
const runFind = (args) => new Promise((res, rej) => execFile('/usr/bin/find', args, { encoding: 'utf8' }, (e, out) => (e ? rej(e) : res(out))));

test('返工次数：2 次不触发，3 次触发；attempt_updated 不计；已归档跳过', () => {
  const two = card('a', [mv(1, 'todo', 'running'), mv(2, 'running', 'todo'), mv(3, 'todo', 'running'), mv(4, 'running', 'blocked'), mv(5, 'blocked', 'running')]);
  assert.equal(reworkOf(two).count, 2); // 回 todo 1 次 + blocked→running 1 次
  const three = card('b', [mv(1, 'todo', 'running'), mv(2, 'running', 'todo'), mv(3, 'todo', 'running'), mv(4, 'running', 'ready'), mv(5, 'ready', 'running'), mv(6, 'running', 'blocked'), mv(7, 'blocked', 'running'), { at: T(8), kind: 'attempt_updated' }]);
  const r3 = reworkOf(three); assert.equal(r3.count, 3); assert.equal(r3.attempts, 1); assert.equal(Date.parse(T(7)), r3.reachedAt);
  const arch = card('c', three.events, { metadata: { archivedAt: T(9) } });
  const rep = reworkReport([two, three, arch], START, END);
  assert.deepEqual(rep.hit.map((x) => x.id), ['b']); assert.equal(rep.skipped, 1); assert.equal(rep.max.count, 3);
  // 第 3 次发生在窗口之前 → 不再重复报，列在“之前已报过”
  const old = card('d', [mv(-48, 'running', 'todo'), mv(-47, 'todo', 'running'), mv(-46, 'running', 'todo'), mv(-45, 'todo', 'running'), mv(-44, 'running', 'todo')]);
  const rep2 = reworkReport([old], START, END); assert.equal(rep2.hit.length, 0); assert.equal(rep2.earlier.length, 1);
  assert.equal(reworkOf(card('e', [{ kind: 'moved', fromStatus: 'todo', toStatus: 'running', at: T(1) }])).count, 0);
});

test('规则文件：第一次建基线；之后内容变了的列出来并带 Git 对照；没变的不列', async () => {
  const { d, cleanup } = mk();
  try {
    const pr = join(d, 'proj'); for (const r of ['desktop', 'system-auditor', '_shared', 'standby-a']) mkdirSync(join(pr, 'runtime', r), { recursive: true });
    writeFileSync(join(pr, 'runtime/desktop/AGENTS.md'), 'v1'); writeFileSync(join(pr, 'runtime/desktop/SOUL.md'), 's1'); writeFileSync(join(pr, 'runtime/system-auditor/AGENTS.md'), 'a1'); writeFileSync(join(pr, 'runtime/_shared/AGENTS.md'), 'shared');
    const baselinePath = join(d, 'base.json');
    const git = async (rel) => (rel.includes('desktop') ? 'abc1234（2026-11-12T00:00:00+05:30）' : null);
    const r1 = await ruleFileReport({ projectRoot: pr, baselinePath, startMs: START, endMs: END, git });
    assert.equal(r1.first, true); assert.equal(r1.count, 3); r1.commit(); // _shared 不算；整份报告写完才 commit 基线
    writeFileSync(join(pr, 'runtime/desktop/AGENTS.md'), 'v2'); writeFileSync(join(pr, 'runtime/system-auditor/AGENTS.md'), 'a2'); writeFileSync(join(pr, 'runtime/standby-a/IDENTITY.md'), 'new');
    const r2 = await ruleFileReport({ projectRoot: pr, baselinePath, startMs: START, endMs: END, git });
    assert.equal(r2.changed.length, 2); assert.match(r2.changed.join('\n'), /desktop\/AGENTS\.md：内容变了.*Git 最近提交 abc1234/); assert.match(r2.changed.join('\n'), /system-auditor\/AGENTS\.md.*无 Git 提交可对照/);
    assert.deepEqual(r2.created, ['runtime/standby-a/IDENTITY.md']); r2.commit();
    assert.ok(!r2.changed.join('').includes('SOUL.md'));
    const r3 = await ruleFileReport({ projectRoot: pr, baselinePath, startMs: START, endMs: END, git });
    assert.equal(r3.changed.length, 0, '基线更新后同一个改动不重复报');
  } finally { cleanup(); }
});

test('审查／名册／备份窗口内新增：按文件夹汇总，只列路径不读内容；正常备份目录不逐项列', async () => {
  const { d, cleanup } = mk();
  try {
    const put = (rel, ms) => { const p = join(d, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'x'); utimesSync(p, ms / 1000, ms / 1000); };
    const inWin = START + 3600e3, before = START - 3600e3 * 5;
    put('records/batch-a/a.md', inWin); put('records/batch-a/b.md', inWin); put('notes/progress.md', inWin); put('notes/old.md', before); put('restore-check/big.bin', inWin);
    const g = await changedFiles(d, START, END, runFind, { prune: ['restore-check'] });
    assert.equal(g.get('records/batch-a'), 2); assert.equal(g.get('notes'), 1); assert.ok(![...g.keys()].some((k) => k.includes('old') || k.includes('restore-check')));
  } finally { cleanup(); }
});

test('备份状态：完整、含包、异地、清理摘要、演练天数；缺东西写线索', () => {
  const { d, cleanup } = mk();
  try {
    const b = join(d, 'b'); const ck = join(b, 'consistent-checkpoints', '20261111T114500Z-aaaa'); mkdirSync(ck, { recursive: true });
    writeFileSync(join(ck, 'manifest.json'), JSON.stringify({ status: 'completed', created_at: '20261111T114500Z', review_archive: { path: 'x' } }));
    writeFileSync(join(b, '异地状态.json'), JSON.stringify({ status: 'packed_not_uploaded', lastSuccessDate: '2026-10-25', why: 'MEGAcmd 没装' }));
    writeFileSync(join(b, '清理摘要.json'), JSON.stringify({ pairsTotal: 56, pairsCleanable: 40, cleanableBytes: 36.7e9, pairsNeedLook: 4, generatedAt: '2026-11-11T21:50:00+05:30' }));
    const r = backupStatus({ backups: b, nowMs: NOW });
    const text = r.lines.join('\n');
    assert.match(text, /含审查区包：是；含角色名册包：否/); assert.match(text, /最近一次成功 2026-10-25（18 天前）/); assert.match(text, /可清理 40 对/); assert.match(text, /真恢复演练：还没做过/);
    assert.ok(r.clues.some((c) => /最新备份不含角色名册包/.test(c)) && r.clues.some((c) => /异地备份已 18 天没成功/.test(c)) && r.clues.some((c) => /还没做过正式的真恢复演练/.test(c)));
    mkdirSync(join(b, '恢复演练-20261110')); // 光有目录不算
    mkdirSync(join(b, '恢复演练-20261122-离线预演')); writeFileSync(join(b, '恢复演练-20261122-离线预演', '演练结果.json'), JSON.stringify({ 副本试启动: '通过', 失败项: 0, finishedAt: T(1) })); // 名字带“离线预演”不算
    mkdirSync(join(b, '恢复演练-20261111')); writeFileSync(join(b, '恢复演练-20261111', '演练结果.json'), JSON.stringify({ 副本试启动: '没做', 失败项: 0, finishedAt: T(1) })); // 没做副本试启动不算
    mkdirSync(join(b, '恢复演练-20261112')); writeFileSync(join(b, '恢复演练-20261112', '演练结果.json'), JSON.stringify({ 副本试启动: '通过', 失败项: 2, finishedAt: T(1) })); // 有失败项不算
    const rNone = backupStatus({ backups: b, nowMs: NOW });
    assert.match(rNone.lines.join('\n'), /还没做过正式的（另有 4 个演练目录/); assert.ok(rNone.clues.some((c) => /还没做过正式的真恢复演练/.test(c)));
    mkdirSync(join(b, '恢复演练-20261105')); writeFileSync(join(b, '恢复演练-20261105', '演练结果.json'), JSON.stringify({ 副本试启动: '通过', 失败项: 0, finishedAt: '2026-11-05T01:00:00Z' }));
    const rOk = backupStatus({ backups: b, nowMs: NOW });
    assert.match(rOk.lines.join('\n'), /最近一次通过的在 7 天前/);
    writeFileSync(join(ck, 'manifest.json'), JSON.stringify({ status: 'failed', created_at: '20261111T114500Z' }));
    const r2 = backupStatus({ backups: b, nowMs: NOW });
    assert.ok(r2.clues.some((c) => /最新备份状态是 failed/.test(c)));
    assert.deepEqual(backupStatus({ backups: join(d, 'nope'), nowMs: NOW }).clues, [], 'a missing or not-configured backup area is "not enabled", not a clue');
    assert.match(backupStatus({ backups: '', nowMs: NOW }).lines.join(), /未启用/);
  } finally { cleanup(); }
});

test('整份：写出盲区抽查文件，含“状态：完整”；任务板读不了只那一节写“未能检查”', async () => {
  const { d, cleanup } = mk();
  try {
    const data = join(d, '资料'); mkdirSync(join(data, '审计', '日审'), { recursive: true });
    const b = join(d, '备份'); mkdirSync(join(b, 'consistent-checkpoints'), { recursive: true });
    const deps = { now: () => NOW, listCards: async () => { throw new Error('openclaw 超时'); }, runFind, git: async () => null };
    await run({ dataRoot: data, deps, nowMs: NOW, areas: { review: join(d, '审查'), roster: join(d, '角色名册'), backup: b }, projectRoot: join(d, 'proj'), workspaceRoot: join(join(d, 'proj'), 'runtime') });
    const text = readFileSync(join(data, '审计', '日审', '2026-11-12-盲区抽查.md'), 'utf8');
    assert.match(text, /未启用/); assert.doesNotMatch(text, /^状态：完整$/m); assert.match(text, /^状态：不完整（未能检查：返工次数/m); assert.match(text.split('## 一、返工次数')[0], /盲区抽查这些小节未能检查：返工次数/); assert.match(text, /未能检查：返工次数（openclaw 超时）/); assert.match(text, /### C ~\/OpenClaw 以外的地方/); assert.match(text, /不扫描/);
    assert.ok(!existsSync(join(data, '审计', '日审', '2026-11-12-盲区抽查.md.tmp')));
    // 任务板读得到：返工线索进汇总
    const three = card('b', [mv(1, 'running', 'todo'), mv(2, 'todo', 'running'), mv(3, 'running', 'todo'), mv(4, 'todo', 'running'), mv(5, 'running', 'todo')]);
    await run({ dataRoot: data, deps: { ...deps, listCards: async () => [three] }, nowMs: NOW, areas: { review: join(d, '审查'), roster: join(d, '角色名册'), backup: b }, projectRoot: join(d, 'proj'), workspaceRoot: join(join(d, 'proj'), 'runtime') });
    const t2 = readFileSync(join(data, '审计', '日审', '2026-11-12-盲区抽查.md'), 'utf8');
    assert.match(t2.split('## 一、返工次数')[0], /返工 ≥3 次的卡 1 张/); assert.match(t2, /b《卡b》返工 3 次/);
  } finally { cleanup(); }
});

test('规则基线：整份报告写完才更新；报告没写成（中途出错）基线不动，下一遍还能报出同一个改动', async () => {
  const { d, cleanup } = mk();
  try {
    const pr = join(d, 'proj'); mkdirSync(join(pr, 'runtime/desktop'), { recursive: true }); writeFileSync(join(pr, 'runtime/desktop/AGENTS.md'), 'v1');
    const baselinePath = join(d, 'base.json'); const git = async () => null;
    const r1 = await ruleFileReport({ projectRoot: pr, baselinePath, startMs: START, endMs: END, git });
    assert.equal(existsSync(baselinePath), false, '报告还没写，基线不能先写');
    r1.commit(); assert.equal(existsSync(baselinePath), true);
    writeFileSync(join(pr, 'runtime/desktop/AGENTS.md'), 'v2');
    const r2 = await ruleFileReport({ projectRoot: pr, baselinePath, startMs: START, endMs: END, git }); // 没 commit，模拟被强杀
    const r3 = await ruleFileReport({ projectRoot: pr, baselinePath, startMs: START, endMs: END, git });
    assert.equal(r2.changed.length, 1); assert.equal(r3.changed.length, 1, '没 commit 时下一遍还报同一个改动');
  } finally { cleanup(); }
});

test('桌面角色屏幕锁日志统计：认出多少次（按来源）、认不出、识别出错、词表读不到；窗口外不算；没有日志如实说', () => {
  const { d, cleanup } = mk();
  try {
    const log = join(d, 'screen-lock.log'); const inWin = START + 1000;
    const L = (o) => JSON.stringify({ at: inWin, ...o });
    writeFileSync(log, [L({ decision: 'sensitive-detected', via: 'click' }), L({ decision: 'sensitive-detected', via: 'enter' }), L({ decision: 'sensitive-detected', via: 'enter' }), L({ decision: 'sensitive-unrecognized' }), L({ decision: 'sensitive-error' }),
      L({ decision: 'sensitive-words-unreadable' }), JSON.stringify({ at: START - 5000, decision: 'sensitive-detected', via: 'click' }), 'not json', L({ decision: 'allow' })].join('\n'));
    const st = screenLockStats(log, START, END);
    assert.equal(st.detected, 3); assert.deepEqual(st.byVia, { click: 1, enter: 2 }); assert.equal(st.unrecognized, 1); assert.equal(st.errors, 1); assert.equal(st.wordsUnreadable, 1);
    assert.equal(screenLockStats(join(d, '没有.log'), START, END).nolog, true);
  } finally { cleanup(); }
});

test('备份状态线索：附加包没打成／打包时现场在变／异地等确认／异地暂存有可清理旧包', () => {
  const { d, cleanup } = mk();
  try {
    const b = join(d, 'b'); const ck = join(b, 'consistent-checkpoints', '20261111T114500Z-aaaa'); mkdirSync(ck, { recursive: true });
    writeFileSync(join(ck, 'manifest.json'), JSON.stringify({ status: 'completed', created_at: '20261111T114500Z', review_archive: { ok: false, error: 'review_archive_could_not_be_packed' }, roster_archive: { ok: true, liveChangedDuringCopy: true } }));
    writeFileSync(join(b, '异地状态.json'), JSON.stringify({ status: 'waiting_confirm', lastSuccessDate: null, upload: { why: '等主人确认上传清单' }, retention: { cleanable: ['old1', 'old2'] } }));
    const r = backupStatus({ backups: b, nowMs: NOW });
    const clues = r.clues.join('\n');
    assert.match(clues, /审查区包没打成：review_archive_could_not_be_packed/); assert.match(clues, /角色名册包打包时现场一直在被写/);
    assert.match(clues, /等主人确认上传清单/); assert.match(clues, /2 个超出保留份数的旧包可清理/);
    assert.match(r.lines.join('\n'), /含审查区包：没打成；含角色名册包：是（打包时现场在变）/);
  } finally { cleanup(); }
});

test('②-1 备份区里每天写的“备份清理清单-最新.md/.json”等状态文件算正常备份文件，不当新增线索；别的文件照列', async () => {
  const { d, cleanup } = mk();
  try {
    const put = (rel, ms) => { const p = join(d, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'x'); utimesSync(p, ms / 1000, ms / 1000); };
    const inWin = START + 3600e3;
    for (const f of ['备份清理清单-最新.md', '备份清理清单-最新.json', '清理摘要.json', '异地状态.json', '异地备份.log', '受保护.txt', '异地上传范围.json']) put(`${f}`, inWin);
    put('某个bot乱写的文件.txt', inWin);
    const g = await changedFiles(d, START, END, runFind, {});
    const keys = [...g.keys()];
    // 与 audit-blindspots 内部的“正常备份文件”判定一致：用 run() 的整份输出验证
    const data = join(d, '资料'); mkdirSync(join(data, '审计', '日审'), { recursive: true });
    mkdirSync(join(d, '审查'), { recursive: true }); mkdirSync(join(d, '角色名册'), { recursive: true });
    mkdirSync(join(d, '备份'), { recursive: true });
    for (const f of ['备份清理清单-最新.md', '备份清理清单-最新.json', '清理摘要.json']) put(`备份/${f}`, inWin);
    put('备份/某个bot乱写的文件.txt', inWin);
    await run({ dataRoot: data, deps: { now: () => NOW, listCards: async () => [], runFind, git: async () => null }, nowMs: NOW, areas: { review: join(d, '审查'), roster: join(d, '角色名册'), backup: join(d, '备份') }, projectRoot: join(d, 'proj'), workspaceRoot: join(join(d, 'proj'), 'runtime') });
    const text = readFileSync(join(data, '审计', '日审', '2026-11-12-盲区抽查.md'), 'utf8');
    const back = text.split('### 备份')[1].split('### B2')[0];
    assert.match(back, /某个bot乱写的文件\.txt/);
    assert.match(back, /正常备份目录：[^\n]*备份清理清单-最新\.md/);
    assert.ok(!/^- 备份清理清单-最新/m.test(back), '正常状态文件不该被当作需要看的线索逐项列出');
    assert.ok(keys.length > 0);
  } finally { cleanup(); }
});

test('某一节读不到 → 文件写“状态：不完整”并进线索汇总；全部读到才写“状态：完整”（看护只认后者，会重试）', async () => {
  const { d, cleanup } = mk();
  try {
    const data = join(d, '资料'); mkdirSync(join(data, '审计', '日审'), { recursive: true });
    mkdirSync(join(d, '审查')); mkdirSync(join(d, '角色名册')); mkdirSync(join(d, '备份', 'consistent-checkpoints', '20261111T114500Z-aaaa'), { recursive: true });
    writeFileSync(join(d, '备份', 'consistent-checkpoints', '20261111T114500Z-aaaa', 'manifest.json'), JSON.stringify({ status: 'completed', created_at: '20261111T114500Z', review_archive: { ok: true }, roster_archive: { ok: true } }));
    const proj = join(d, 'proj'); mkdirSync(join(proj, 'runtime/desktop'), { recursive: true }); writeFileSync(join(proj, 'runtime/desktop/AGENTS.md'), 'x');
    const good = { now: () => NOW, listCards: async () => [], runFind, git: async () => null };
    const f = join(data, '审计', '日审', '2026-11-12-盲区抽查.md');
    const r1 = await run({ dataRoot: data, deps: good, nowMs: NOW, areas: { review: join(d, '审查'), roster: join(d, '角色名册'), backup: join(d, '备份') }, projectRoot: proj, workspaceRoot: join(proj, 'runtime') });
    assert.deepEqual(r1.incomplete, []); assert.match(readFileSync(f, 'utf8'), /^状态：完整$/m);
    const r2 = await run({ dataRoot: data, deps: { ...good, listCards: async () => { throw new Error('超时'); } }, nowMs: NOW, areas: { review: join(d, '审查'), roster: join(d, '角色名册'), backup: join(d, '备份') }, projectRoot: proj, workspaceRoot: join(proj, 'runtime') });
    assert.deepEqual(r2.incomplete, ['返工次数']); const t2 = readFileSync(f, 'utf8');
    assert.match(t2, /^状态：不完整（未能检查：返工次数）$/m); assert.doesNotMatch(t2, /^状态：完整$/m);
    // a backup area that is not there is "not enabled", not incomplete
    const r3 = await run({ dataRoot: data, deps: good, nowMs: NOW, areas: { review: join(d, '审查'), roster: join(d, '角色名册'), backup: join(d, '没有这个目录') }, projectRoot: proj, workspaceRoot: join(proj, 'runtime') });
    assert.ok(!r3.incomplete.includes('备份状态')); assert.match(readFileSync(f, 'utf8'), /备份状态：未启用/);
  } finally { cleanup(); }
});
