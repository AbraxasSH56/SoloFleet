// Offline tests for project files: temporary directories and fake data only; nothing touches a real deployment.
// project-files 的离线测试。全部在临时目录里跑，不碰真实资料。
// Run: node --test tests/project-files.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  validateName, sanitizeTitle, dayOf, parseIndex, newProject, newTask, addResult, checkProject, entryHintFor,
  scan, nameProblems, stripTemplateNotes, findProjectByChannel, appendIndexRow, PLACEHOLDER,
} from '../plugins/personal-inbox/project-files.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TPL_DIR = join(HERE, '..', 'templates'); // templates shipped in this repo
const REAL_TPL = join(HERE, 'fixtures', 'old-templates'); // old-format templates (no placeholders): the program must refuse them
const NODE = process.execPath;
const CLI = join(HERE, '..', 'scripts', 'automation', 'project-files.mjs');

const INDEX0 = `# 统一资料入口

说明文字。

| 项目 | Discord 频道 | 主责 bot | 当前入口 | 主档与成果位置 |
| --- | --- | --- | --- | --- |
| Example Project | 暂无项目频道；现在在"工坊"（编号 100000000000000003） | 总控 | [项目入口](项目/ExampleProject/PROJECT.md) | 任务记录在 x |
| 日记 | 日记（编号 100000000000000132） | 日记 | [项目入口](项目/日记/PROJECT.md) | 成果在 项目/日记/成果/ |

闲聊茶会不是项目。
`;

function newRoot({ tpl = 'new' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pf-'));
  mkdirSync(join(root, '模板'), { recursive: true });
  const from = tpl === 'new' ? (existsSync(TPL_DIR) ? TPL_DIR : REAL_TPL) : REAL_TPL;
  for (const f of ['项目入口.md', '任务记录.md']) copyFileSync(join(from, f), join(root, '模板', f));
  writeFileSync(join(root, 'INDEX.md'), INDEX0);
  mkdirSync(join(root, '项目'), { recursive: true });
  return root;
}
const idxPath = (root) => join(root, 'INDEX.md');
const mk = (root, name, o = {}) => newProject({ dataRoot: root, indexPath: idxPath(root), name, channelId: o.channelId ?? '100000000000000173', channelName: o.channelName ?? `${name}频道`, lead: o.lead ?? '总控', goal: o.goal ?? '测试目标', now: o.now });

// ---------- 小工具 ----------
test('validateName：合格和各种不合格', () => {
  assert.equal(validateName('文件管理测试').ok, true);
  for (const bad of ['含 空格', '含/斜杠', '含:冒号', 'a__b', '_开头', '.隐藏', '']) assert.equal(validateName(bad).ok, false, bad);
  assert.equal(validateName('含 空格').suggestion, '含空格');
  assert.equal(validateName('x'.repeat(61)).ok, false);
});
test('sanitizeTitle：特殊符号换短横线并报告', () => {
  assert.deepEqual(sanitizeTitle('执行者G/执行者F 合作: 写三句话'), { name: '执行者G-执行者F-合作-写三句话', changed: true });
  assert.deepEqual(sanitizeTitle('两人合作写三句话自我介绍'), { name: '两人合作写三句话自我介绍', changed: false });
});
test('dayOf：两种日期写法、带时间、非法日期', () => {
  assert.equal(dayOf('2026-11-22'), '2026-11-22');
  assert.equal(dayOf('状态：完成 ｜ 2026-11-22 14:00'), '2026-11-22');
  assert.equal(dayOf('日记_20261122.md'), '2026-11-22');
  assert.equal(dayOf('更新：2026-11-11（测试时区（UTC+5:30））'), '2026-11-11');
  assert.equal(dayOf('没有日期'), null);
  assert.equal(dayOf('2026-13-45'), null);
});
test('stripTemplateNotes：去掉成对标记之间的说明', () => {
  assert.equal(stripTemplateNotes('a\n<!-- 模板说明开始 -->\n说明\n<!-- 模板说明结束 -->\nb\n'), 'a\nb\n');
});
test('parseIndex：项目表、频道编号、入口链接（含 URL 编码）', () => {
  const p = parseIndex(INDEX0.replace('项目/日记/PROJECT.md', '项目/%E6%97%A5%E8%AE%B0/PROJECT.md'));
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[1].channelId, '100000000000000132');
  assert.equal(p.rows[1].entryPath, '项目/日记/PROJECT.md');
  assert.equal(p.rows[0].channelId, '100000000000000003');
  assert.equal(parseIndex('没有表').ok, false);
});
test('nameProblems：机械几条、自然标题不误伤', () => {
  assert.deepEqual(nameProblems('整理当前待办.md'), []);
  assert.deepEqual(nameProblems('临时工安排.md'), []);
  assert.deepEqual(nameProblems('执行者G自我介绍.md'), []);
  assert.ok(nameProblems('方案_最新.md').length);
  assert.ok(nameProblems('报告_v2.md').length);
  assert.ok(nameProblems('报告_第二版.md').length);
  assert.ok(nameProblems('记录 2026-11-22.md').length);
  assert.ok(nameProblems('a__b.md').length);
  assert.ok(nameProblems('a:b.md').length);
  assert.deepEqual(nameProblems('日记_20261122.md'), []);
});

// ---------- new-project ----------
test('new-project：建出文件夹、入口、索引一行；原有各行不变', () => {
  const root = newRoot();
  const before = readFileSync(idxPath(root), 'utf8').split('\n');
  const r = mk(root, '文件管理测试');
  assert.equal(r.ok, true, r.message);
  for (const s of ['任务', '成果', '历史']) assert.ok(statSync(join(root, '项目', '文件管理测试', s)).isDirectory());
  const entry = readFileSync(join(root, '项目', '文件管理测试', 'PROJECT.md'), 'utf8');
  assert.match(entry, /^# 文件管理测试：项目入口/);
  assert.ok(!entry.includes('{{'), '没有残留占位符');
  assert.ok(!entry.includes('模板说明'), '模板说明已去掉');
  assert.match(entry, /暂无（待写）/);
  assert.match(entry, /文件管理测试频道（编号 100000000000000173）/);
  const after = readFileSync(idxPath(root), 'utf8').split('\n');
  assert.equal(after.length, before.length + 1);
  assert.ok(isSub(before, after), '原有行都在且顺序不变');
  const row = after.find((l) => l.startsWith('| 文件管理测试 |'));
  assert.ok(row && row.includes('[项目入口](项目/文件管理测试/PROJECT.md)'));
  const p = parseIndex(after.join('\n'));
  assert.equal(p.rows.at(-1).name, '文件管理测试');
  assert.equal(p.rows.at(-1).channelId, '100000000000000173');
  // 新行紧跟在表的最后一行后面，不在表外
  assert.equal(after[after.indexOf(row) + 1], '');
});
function isSub(a, b) { let j = 0; for (let i = 0; i < b.length && j < a.length; i += 1) if (b[i] === a[j]) j += 1; return j === a.length; }
test('new-project：不合格的名字被拒绝并给建议；什么都不建', () => {
  const root = newRoot();
  const r = mk(root, '带 空格');
  assert.equal(r.ok, false);
  assert.match(r.message, /建议改成：带空格/);
  assert.deepEqual(readdirSync(join(root, '项目')), []);
  assert.equal(readFileSync(idxPath(root), 'utf8'), INDEX0);
});
test('new-project：重复运行安全（已存在不覆盖）；频道编号被别的项目占用则拒绝', () => {
  const root = newRoot();
  assert.equal(mk(root, 'P甲').ok, true);
  writeFileSync(join(root, '项目', 'P甲', 'PROJECT.md'), '被人改过的入口');
  const again = mk(root, 'P甲');
  assert.equal(again.ok, true);
  assert.equal(again.existed, true);
  assert.equal(readFileSync(join(root, '项目', 'P甲', 'PROJECT.md'), 'utf8'), '被人改过的入口', '没有覆盖');
  const other = mk(root, 'P乙', { channelId: '100000000000000173' });
  assert.equal(other.ok, false);
  assert.match(other.message, /已经登记给了项目《P甲》/);
  const sameNameOtherChannel = mk(root, 'P甲', { channelId: '100000000000000174' });
  assert.equal(sameNameOtherChannel.ok, false);
  assert.equal(readFileSync(idxPath(root), 'utf8').split('\n').filter((l) => l.startsWith('| P甲 |')).length, 1);
});
test('new-project：频道编号不是数字、缺参数、模板旧格式都被拒绝', () => {
  const root = newRoot();
  assert.equal(mk(root, 'Q', { channelId: 'abc' }).ok, false);
  assert.equal(mk(root, 'Q', { goal: '' }).ok, false);
  const old = newRoot({ tpl: 'old' });
  const r = mk(old, 'Q');
  assert.equal(r.ok, false);
  assert.match(r.message, /旧格式/);
  assert.deepEqual(readdirSync(join(old, '项目')), [], '旧模板时不留半截文件夹');
});
test('new-project：索引写之前被别人改了 → 重读重来，别人的改动保留', () => {
  const root = newRoot();
  let n = 0;
  const row = '| X | X频道（编号 100000000000000175） | 总控 | [项目入口](项目/X/PROJECT.md) | y |';
  const r = appendIndexRow(idxPath(root), row, {
    onBeforeWrite: () => { n += 1; if (n === 1) { const t = readFileSync(idxPath(root), 'utf8'); writeFileSync(idxPath(root), t.replace('日记', '日记（改过）')); } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  const t = readFileSync(idxPath(root), 'utf8');
  assert.match(t, /日记（改过）/);
  assert.ok(t.includes(row));
});
test('new-project：索引一直在被改（3 次都冲突）→ 不写、报错', () => {
  const root = newRoot();
  let k = 0;
  const r = appendIndexRow(idxPath(root), '| Z | Z（编号 100000000000000176） | b | [项目入口](项目/Z/PROJECT.md) | y |', {
    onBeforeWrite: () => { k += 1; writeFileSync(idxPath(root), `${readFileSync(idxPath(root), 'utf8')}\n<!-- ${k} -->`); },
  });
  assert.equal(r.ok, false);
  assert.ok(!readFileSync(idxPath(root), 'utf8').includes('| Z |'));
});
test('new-project：索引本身坏了 → 一开始就拒绝，什么都不建；文件夹和入口在但索引没这一行 → 重跑只补登，不重建', () => {
  const root = newRoot();
  const bad = idxPath(root);
  const orig = readFileSync(bad, 'utf8');
  writeFileSync(bad, '这是坏的索引，没有表');
  const r1 = mk(root, '半截');
  assert.equal(r1.ok, false);
  assert.deepEqual(readdirSync(join(root, '项目')), [], '索引读不懂时不留半截文件夹');
  writeFileSync(bad, orig);
  // 模拟"文件夹和入口建好了、索引没登记成功"的半截状态
  mkdirSync(join(root, '项目', '半截', '任务'), { recursive: true });
  writeFileSync(join(root, '项目', '半截', 'PROJECT.md'), '保留的入口');
  const r2 = mk(root, '半截');
  assert.equal(r2.ok, true, r2.message);
  assert.equal(readFileSync(join(root, '项目', '半截', 'PROJECT.md'), 'utf8'), '保留的入口', '入口没被覆盖');
  for (const s of ['成果', '历史']) assert.ok(existsSync(join(root, '项目', '半截', s)), `补建了缺的 ${s}/`);
  assert.ok(readFileSync(bad, 'utf8').includes('| 半截 |'));
  // 文件夹在但没有入口 → 拒绝，不覆盖
  mkdirSync(join(root, '项目', '没入口'), { recursive: true });
  const r3 = mk(root, '没入口', { channelId: '100000000000000177' });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'folder-no-entry');
});

// ---------- new-task ----------
const T = (root, over = {}) => newTask({ dataRoot: root, project: 'P', title: '写自我介绍', threadLink: 'https://discord.com/channels/1/2', executor: '执行者E', quote: '请写三句话\n要简短', quoteDate: '2026-11-22', cardId: 'abcd1234', ...over });
test('new-task：生成任务记录，预填项目名、原话、线程链接；模板说明被去掉', () => {
  const root = newRoot(); mk(root, 'P');
  const r = T(root);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.file, '写自我介绍.md');
  const t = readFileSync(r.path, 'utf8');
  assert.match(t, /^# 任务记录：写自我介绍/);
  assert.ok(!t.includes('{{') && !t.includes('模板说明开始'));
  assert.match(t, /> 请写三句话\n> 要简短/);
  assert.match(t, /状态：进行中 ｜ \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(t, /--project P --name <成果名>/, '收尾清单里命令已预填项目名');
  assert.match(t, /https:\/\/discord.com\/channels\/1\/2/);
  assert.match(t, /abcd1234/);
  assert.ok(!t.includes('任务卡上的两栏'), '给总控看的说明块不进任务记录');
});
test('new-task：标题有特殊符号 → 换名并报告；同名不覆盖；项目不存在拒绝', () => {
  const root = newRoot(); mk(root, 'P');
  const r = T(root, { title: 'A/B: 测试 任务' });
  assert.equal(r.ok, true);
  assert.equal(r.renamed, true);
  assert.equal(r.file, 'A-B-测试-任务.md');
  assert.match(r.message, /实际文件名是 A-B-测试-任务\.md/);
  writeFileSync(r.path, '手改过');
  const again = T(root, { title: 'A/B: 测试 任务' });
  assert.equal(again.ok, true);
  assert.equal(again.existed, true);
  assert.equal(readFileSync(r.path, 'utf8'), '手改过');
  const none = newTask({ dataRoot: root, project: '不存在', title: 't', threadLink: 'u', executor: 'e', quote: 'q' });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'no-project');
  assert.deepEqual(readdirSync(join(root, '项目')).sort(), ['P'], '没有凭空造项目文件夹');
  assert.equal(T(root, { quote: '' }).ok, false);
});

// ---------- add-result ----------
const R = (root, over = {}) => addResult({ dataRoot: root, project: 'P', name: '三句话自我介绍', path: '成果/介绍.md', note: '定稿', now: Date.parse('2026-11-22T08:00:00Z'), ...over });
function withResult(root) { writeFileSync(join(root, '项目', 'P', '成果', '介绍.md'), '内容'); }
test('add-result：占位行被换掉，状态一行更新，别处一个字不动', () => {
  const root = newRoot(); mk(root, 'P', { now: Date.parse('2026-11-20T00:00:00Z') }); withResult(root);
  const e = join(root, '项目', 'P', 'PROJECT.md');
  const before = readFileSync(e, 'utf8').split('\n');
  const r = R(root);
  assert.equal(r.ok, true, r.message);
  const after = readFileSync(e, 'utf8').split('\n');
  assert.ok(after.includes('| 三句话自我介绍 | `成果/介绍.md` | 定稿 |'));
  assert.ok(!after.join('\n').includes('待写'));
  assert.ok(after.some((l) => /^2026-11-22：三句话自我介绍 已完成，见下表$/.test(l)));
  const changed = before.filter((l) => !after.includes(l));
  assert.equal(changed.length, 2, `只改了两处：${JSON.stringify(changed)}`);
  assert.equal(after.length, before.length);
});
test('add-result：成果文件不存在拒绝；--path/--outside 二选一；路径越界拒绝', () => {
  const root = newRoot(); mk(root, 'P');
  const e = join(root, '项目', 'P', 'PROJECT.md');
  const orig = readFileSync(e, 'utf8');
  assert.equal(R(root).ok, false);
  assert.equal(R(root).code, 'no-file');
  assert.equal(R(root, { outside: '别处' }).code, 'path-or-outside');
  assert.equal(R(root, { path: undefined, outside: undefined }).code, 'path-or-outside');
  assert.equal(R(root, { path: '../P/成果/介绍.md' }).code, 'bad-path');
  assert.equal(R(root, { path: '/etc/hosts' }).code, 'bad-path');
  assert.equal(readFileSync(e, 'utf8'), orig, '拒绝时入口没动');
});
test('add-result：--outside 不查文件、同样刷新状态', () => {
  const root = newRoot(); mk(root, 'P');
  const r = R(root, { path: undefined, outside: '改动在 src/scripts/x.mjs（见任务记录）', name: '脚本改动' });
  assert.equal(r.ok, true, r.message);
  const t = readFileSync(join(root, '项目', 'P', 'PROJECT.md'), 'utf8');
  assert.match(t, /\| 脚本改动 \| 改动在 src\/scripts\/x\.mjs（见任务记录） \| 定稿 \|/);
  assert.match(t, /2026-11-22：脚本改动 已完成/);
});
test('add-result：真实成果行的说明里写"暂无异常"不会被当成占位行覆盖；再次登记同名成果是更新不是重复', () => {
  const root = newRoot(); mk(root, 'P'); withResult(root);
  assert.equal(R(root).ok, true);
  const r2 = R(root, { name: '另一个成果', note: '暂无异常，已检查' });
  assert.equal(r2.ok, true);
  let t = readFileSync(join(root, '项目', 'P', 'PROJECT.md'), 'utf8');
  assert.match(t, /\| 三句话自我介绍 \|/);
  assert.match(t, /\| 另一个成果 \|/);
  const r3 = R(root, { note: '二稿' });
  assert.equal(r3.ok, true);
  t = readFileSync(join(root, '项目', 'P', 'PROJECT.md'), 'utf8');
  assert.equal((t.match(/\| 三句话自我介绍 \|/g) ?? []).length, 1);
  assert.match(t, /二稿/);
  assert.match(t, /暂无异常，已检查/);
});
test('add-result：旧项目手写的"（待写）"行（成果名相同）被更新；当前状态有多行时在最前面插一行', () => {
  const root = newRoot(); mk(root, 'P'); withResult(root);
  writeFileSync(join(root, '项目', 'P', 'PROJECT.md'), `# P：项目入口

## 当前状态

2026-11-16 12:14：开工。
还有第二行详情。

## 当前成果

| 成果 | 当前位置 | 说明 |
| --- | --- | --- |
| 三句话自我介绍 | \`成果/介绍.md\`（待写） | 定稿后写入 |
`);
  const r = R(root);
  assert.equal(r.ok, true, r.message);
  const t = readFileSync(join(root, '项目', 'P', 'PROJECT.md'), 'utf8');
  assert.ok(!t.includes('待写'));
  assert.match(t, /2026-11-22：三句话自我介绍 已完成，见下表\n\n2026-11-16 12:14：开工。\n还有第二行详情。/);
  assert.equal(r.statusMode, 'inserted');
});
test('add-result：入口里没有"当前成果"一节 → 不改、报原因', () => {
  const root = newRoot(); mk(root, 'P'); withResult(root);
  writeFileSync(join(root, '项目', 'P', 'PROJECT.md'), '# P\n\n## 当前状态\n\n无\n');
  const r = R(root);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-section');
  assert.equal(readFileSync(join(root, '项目', 'P', 'PROJECT.md'), 'utf8'), '# P\n\n## 当前状态\n\n无\n');
});

// ---------- check-project ----------
const codes = (r) => r.problems.map((p) => p.code).sort();
test('check-project：新建好的项目，一直没填成果 → 报 entry-placeholder（占位口径一致）', () => {
  const root = newRoot(); mk(root, 'P');
  assert.deepEqual(codes(checkProject({ dataRoot: root, indexPath: idxPath(root), name: 'P' })), ['entry-placeholder']);
});
test('check-project：登记后干净；成果没登记；状态落后；散放文件；缺子文件夹；任务记录放错', () => {
  const root = newRoot(); mk(root, 'P', { now: Date.parse('2026-11-20T00:00:00Z') });
  const dir = join(root, '项目', 'P');
  withResult(root);
  assert.deepEqual(codes(checkProject({ dataRoot: root, indexPath: idxPath(root), name: 'P' })), ['entry-placeholder', 'result-unlisted']);
  assert.equal(R(root).ok, true);
  assert.deepEqual(codes(checkProject({ dataRoot: root, indexPath: idxPath(root), name: 'P' })), []);
  // 任务记录里完成日期晚于入口
  writeFileSync(join(dir, '任务', '甲.md'), '# 任务记录：甲\n\n状态：完成 ｜ 2026-11-25 10:00\n');
  assert.deepEqual(codes(checkProject({ dataRoot: root, indexPath: idxPath(root), name: 'P' })), ['status-behind']);
  writeFileSync(join(dir, '任务', '甲.md'), '# 任务记录：甲\n\n状态:完成 | 20261125\n'); // 半角冒号、8 位日期
  assert.deepEqual(codes(checkProject({ dataRoot: root, indexPath: idxPath(root), name: 'P' })), ['status-behind']);
  writeFileSync(join(dir, '任务', '甲.md'), '# 任务记录：甲\n\n状态：完成 ｜ 2026-11-22 23:59\n'); // 同一天不判落后
  assert.deepEqual(codes(checkProject({ dataRoot: root, indexPath: idxPath(root), name: 'P' })), []);
  writeFileSync(join(dir, '散放.txt'), 'x');
  writeFileSync(join(dir, '成果', '乙.md'), '# 任务记录：乙\n');
  const c = codes(checkProject({ dataRoot: root, indexPath: idxPath(root), name: 'P' }));
  assert.deepEqual(c, ['loose-file', 'result-unlisted', 'taskrecord-misplaced']);
  rmDir(join(dir, '历史'));
  assert.ok(codes(checkProject({ dataRoot: root, indexPath: idxPath(root), name: 'P' })).includes('missing-subdir'));
});
function rmDir(p) { // 测试里用：空目录移走（临时目录里，不是真实数据）
  execFileSync('/bin/rmdir', [p]);
}
test('check-project：成果不在项目里的任务用 --outside 登记后，状态不再落后', () => {
  const root = newRoot(); mk(root, 'P', { now: Date.parse('2026-11-20T00:00:00Z') });
  writeFileSync(join(root, '项目', 'P', '任务', '改代码.md'), '# 任务记录：改代码\n\n状态：完成 ｜ 2026-11-22 09:00\n');
  assert.ok(codes(checkProject({ dataRoot: root, indexPath: idxPath(root), name: 'P' })).includes('status-behind'));
  assert.equal(R(root, { path: undefined, outside: '改动在别处', name: '改代码' }).ok, true);
  assert.deepEqual(codes(checkProject({ dataRoot: root, indexPath: idxPath(root), name: 'P' })), []);
});
test('check-project：没传资料根或索引路径 → 不检查，不猜默认路径', () => {
  assert.equal(checkProject({ dataRoot: null, indexPath: null, name: 'P' }).skipped, true);
  assert.equal(entryHintFor({ dataRoot: null, indexPath: null, channelId: '1' }), null);
});
test('entryHintFor：按频道找项目；没跟上才有提醒；找不到/出错返回 null', () => {
  const root = newRoot(); mk(root, 'P', { channelId: '100000000000000178' });
  const h = entryHintFor({ dataRoot: root, indexPath: idxPath(root), channelId: '100000000000000178' });
  assert.match(h, /项目入口还没跟上.*当前成果.*还没登记/);
  withResult(root); R(root);
  assert.equal(entryHintFor({ dataRoot: root, indexPath: idxPath(root), channelId: '100000000000000178' }), null);
  assert.equal(entryHintFor({ dataRoot: root, indexPath: idxPath(root), channelId: '100000000000000112' }), null);
  assert.equal(entryHintFor({ dataRoot: root, indexPath: join(root, '不存在.md'), channelId: '100000000000000178' }), null);
  assert.equal(findProjectByChannel({ dataRoot: root, indexPath: idxPath(root), channelId: '100000000000000178' }).name, 'P');
});
test('模块不依赖自己所在位置：复制到别的目录，结果相同', () => {
  const root = newRoot(); mk(root, 'P', { channelId: '100000000000000178' });
  const other = mkdtempSync(join(tmpdir(), 'pfmod-'));
  cpSync(join(HERE, '..', 'plugins', 'personal-inbox'), other, { recursive: true });
  const r = spawnSync(NODE, ['-e', `import('${join(other, 'project-files.mjs')}').then(m=>{console.log(JSON.stringify(m.entryHintFor({dataRoot:${JSON.stringify(root)},indexPath:${JSON.stringify(idxPath(root))},channelId:'100000000000000178'})));})`], { encoding: 'utf8' });
  assert.match(r.stdout, /项目入口还没跟上/);
  const src = readFileSync(join(HERE, '..', 'plugins', 'personal-inbox', 'project-files.mjs'), 'utf8');
  assert.ok(!/import\.meta\.url/.test(src.replace(/\/\/.*$/gm, '')), '核心模块代码里不许按自己位置推路径');
});

// ---------- scan ----------
function scanRoot() {
  const root = newRoot();
  const runtime = mkdtempSync(join(tmpdir(), 'pfrt-'));
  mkdirSync(join(root, '审计'), { recursive: true });
  mkdirSync(join(root, '垃圾桶'), { recursive: true });
  mkdirSync(join(root, '运行记录', '守门'), { recursive: true });
  for (const f of ['决定账本.md', '主人现况.md']) writeFileSync(join(root, f), 'x');
  // 日记、搭建项目（符合索引）
  for (const [n, id] of [['日记', '100000000000000132'], ['ExampleProject', '100000000000000003']]) {
    mkdirSync(join(root, '项目', n), { recursive: true });
    for (const s of ['任务', '成果', '历史']) mkdirSync(join(root, '项目', n, s), { recursive: true });
    writeFileSync(join(root, '项目', n, 'PROJECT.md'), `# ${n}\n\n## 当前状态\n\n2026-11-01：好\n\n## 当前成果\n\n| 成果 | 当前位置 | 说明 |\n| --- | --- | --- |\n| 某 | x | y |\n`);
  }
  writeFileSync(join(root, '项目', '日记', '成果', '日记_20261109.md'), '日记');
  writeFileSync(join(root, '项目', '日记', '成果', '日记_20261109-重跑前副本-20261110T0415.md'), '日记');
  writeFileSync(join(root, '项目', '日记', 'PROJECT.md'), readFileSync(join(root, '项目', '日记', 'PROJECT.md'), 'utf8').replace('| 某 | x | y |', '| 日记 | 日记_20261109.md 日记_20261109-重跑前副本-20261110T0415.md | y |'));
  for (const w of ['controller', 'worker-a', 'desktop']) { mkdirSync(join(runtime, w, 'memory'), { recursive: true }); for (const f of ['AGENTS.md', 'SOUL.md']) writeFileSync(join(runtime, w, f), 'x'); }
  for (const s of ['_shared', 'auth-recovery', 'power-observer', 'session-rotation']) { mkdirSync(join(runtime, s), { recursive: true }); writeFileSync(join(runtime, s, '杂.txt'), 'x'); }
  writeFileSync(join(runtime, 'controller', 'FOLLOWUPS.md'), 'x');
  return { root, runtime };
}
const WS = (runtime) => [{ id: 'main', dir: join(runtime, 'controller') }, { id: 'worker-a', dir: join(runtime, 'worker-a') }, { id: 'desktop', dir: join(runtime, 'desktop') }];
const S = (root, runtime, o = {}) => scan({ dataRoot: root, indexPath: idxPath(root), runtimeRoot: runtime, workspaces: WS(runtime), date: '2026-11-22', ...o });

test('scan：干净的目录 → 没有发现；日记的重跑前副本、.DS_Store 不误报', () => {
  const { root, runtime } = scanRoot();
  writeFileSync(join(root, '.DS_Store'), 'x');
  writeFileSync(join(root, '项目', '日记', '.DS_Store'), 'x');
  const r = S(root, runtime);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 0, JSON.stringify(r.rows.map((x) => x.key)));
  assert.match(r.report, /^# 文件对账\n业务日期：2026-11-22\n文件对账：新增 0、满 3 天 0、存量 0/);
});
test('scan：第一次运行全部记存量；第二天新出现的算新增；第 3 天满 3 天；消失后再出现重新算新增', () => {
  const { root, runtime } = scanRoot();
  mkdirSync(join(root, '任务测试'));
  const d1 = S(root, runtime);
  assert.equal(d1.firstRun, true);
  assert.deepEqual(d1.counts, { 新增: 0, 满3天: 0, 存量: 1 });
  assert.match(d1.rows[0].suggest, /测试遗留.*垃圾桶/);
  mkdirSync(join(root, '乱放的东西'));
  const d2 = S(root, runtime, { date: '2026-11-23' });
  assert.deepEqual(d2.counts, { 新增: 1, 满3天: 0, 存量: 1 });
  assert.match(d2.report, /## 新增（1）\n- \[S1\] 乱放的东西/);
  const d3 = S(root, runtime, { date: '2026-11-24' });
  assert.deepEqual(d3.counts, { 新增: 0, 满3天: 0, 存量: 2 });
  const d4 = S(root, runtime, { date: '2026-11-25' });
  assert.deepEqual(d4.counts, { 新增: 0, 满3天: 1, 存量: 1 });
  const d5 = S(root, runtime, { date: '2026-11-26' });
  assert.deepEqual(d5.counts, { 新增: 0, 满3天: 0, 存量: 2 });
  // 消失后再出现
  execFileSync('/bin/rmdir', [join(root, '乱放的东西')]);
  S(root, runtime, { date: '2026-11-27' });
  mkdirSync(join(root, '乱放的东西'));
  assert.equal(S(root, runtime, { date: '2026-11-28' }).counts.新增, 1);
});
test('scan：S2 项目对账——孤儿文件夹、索引行指向不存在、解析不了的行、同编号重复、散放文件', () => {
  const { root, runtime } = scanRoot();
  mkdirSync(join(root, '项目', '孤儿'), { recursive: true });
  const t = readFileSync(idxPath(root), 'utf8');
  writeFileSync(idxPath(root), t.replace('\n\n闲聊茶会', '\n| 幽灵 | 幽灵频道（编号 100000000000000003） | 总控 | [项目入口](项目/幽灵/PROJECT.md) | y |\n| 无编号 | 没写编号 | 总控 | 没链接 | y |\n\n闲聊茶会'));
  const r = S(root, runtime);
  const keys = r.rows.map((x) => x.key).join('\n');
  assert.match(keys, /项目\/孤儿\|项目文件夹在，但总索引里没有它的一行/);
  assert.match(keys, /INDEX\.md:幽灵\|入口文件不存在/);
  assert.match(keys, /INDEX\.md:幽灵\|总索引有这个项目|项目\/幽灵\|总索引有这个项目/);
  assert.match(keys, /读不出频道编号/);
  assert.match(keys, /没有项目入口链接/);
  assert.match(keys, /频道编号 100000000000000003 和《Example Project》重复/);
});
test('scan：S3 命名提示——只报机械几条，自然标题不报', () => {
  const { root, runtime } = scanRoot();
  writeFileSync(join(root, '项目', '日记', '成果', '整理当前待办.md'), 'x');
  writeFileSync(join(root, '项目', '日记', '成果', '方案_最新.md'), 'x');
  writeFileSync(join(root, '项目', '日记', '成果', '记录 2026-11-22.md'), 'x');
  const r = S(root, runtime);
  const s3 = r.rows.filter((x) => x.area === 'S3').map((x) => x.where);
  assert.ok(s3.some((w) => w.endsWith('方案_最新.md')));
  assert.ok(s3.some((w) => w.endsWith('记录 2026-11-22.md')));
  assert.ok(!s3.some((w) => w.includes('整理当前待办')));
});
test('scan：S3 不查 项目/<名>/历史/ 下的冻结旧文件（旧线程导出的名字带空格冒号也不报）', () => {
  const { root, runtime } = scanRoot();
  mkdirSync(join(root, '项目', '日记', '历史', '旧导出'), { recursive: true });
  writeFileSync(join(root, '项目', '日记', '历史', '旧导出', 'old_export_p1.json'), 'x');
  writeFileSync(join(root, '项目', '日记', '历史', '_核对.json'), 'x');
  const r = S(root, runtime);
  assert.equal(r.rows.filter((x) => x.area === 'S3').length, 0);
});
test('scan：S4 第一次只建基线；之后只报新出现的、报一次；固定集合和总控 FOLLOWUPS.md 不报；系统目录不扫', () => {
  const { root, runtime } = scanRoot();
  const d1 = S(root, runtime);
  assert.equal(d1.rows.filter((x) => x.area === 'S4').length, 0);
  assert.match(d1.report, /基线也是这次建的/);
  writeFileSync(join(runtime, 'worker-a', '新成果.md'), 'x');
  writeFileSync(join(runtime, 'controller', 'FOLLOWUPS.md'), 'y');
  mkdirSync(join(runtime, 'worker-a', '临时'));
  writeFileSync(join(runtime, '_shared', '又一个.txt'), 'x');
  const d2 = S(root, runtime, { date: '2026-11-23' });
  const s4 = d2.rows.filter((x) => x.area === 'S4');
  assert.equal(s4.length, 1);
  assert.match(s4[0].where, /worker-a\/新成果\.md/);
  assert.equal(s4[0].kind, '新增');
  const d3 = S(root, runtime, { date: '2026-11-24' });
  assert.equal(d3.rows.filter((x) => x.area === 'S4').length, 0, '同一个新文件只报一次');
});
test('scan：对应表——编号和目录名不同的 main→controller 真的扫到；目录不存在/不在 runtime 里的那项被跳过并报"工作区名单有误"，别的照扫', () => {
  const { root, runtime } = scanRoot();
  S(root, runtime); // 建基线
  writeFileSync(join(runtime, 'controller', '总控的新东西.md'), 'x');
  writeFileSync(join(runtime, 'worker-a', '甲的新东西.md'), 'x');
  const outside = mkdtempSync(join(tmpdir(), 'pfout-'));
  const ws = [...WS(runtime), { id: 'ghost', dir: join(runtime, '不存在') }, { id: 'evil', dir: outside }];
  const r = scan({ dataRoot: root, indexPath: idxPath(root), runtimeRoot: runtime, workspaces: ws, date: '2026-11-23' });
  const w = r.rows.map((x) => x.where + '|' + x.problem).join('\n');
  assert.match(w, /controller\/总控的新东西\.md/);
  assert.match(w, /worker-a\/甲的新东西\.md/);
  assert.match(w, /工作区名单:ghost\|工作区名单有误/);
  assert.match(w, /工作区名单:evil\|工作区名单有误/);
});
test('scan：没给对应表时退而扫 runtime/，排除 4 个系统目录；S5 运行记录里不认识的子文件夹', () => {
  const { root, runtime } = scanRoot();
  scan({ dataRoot: root, indexPath: idxPath(root), runtimeRoot: runtime, workspaces: null, date: '2026-11-22' });
  writeFileSync(join(runtime, 'worker-a', '新.md'), 'x');
  writeFileSync(join(runtime, 'power-observer', '新.txt'), 'x');
  mkdirSync(join(root, '运行记录', '神秘日志'));
  const r = scan({ dataRoot: root, indexPath: idxPath(root), runtimeRoot: runtime, workspaces: null, date: '2026-11-23' });
  const w = r.rows.map((x) => x.where).join('\n');
  assert.match(w, /worker-a\/新\.md/);
  assert.ok(!/power-observer/.test(w));
  assert.match(w, /运行记录\/神秘日志/);
  assert.ok(r.notes.length >= 1);
});
test('scan：API额度／提醒／账本待补 是认识的运行记录子文件夹，不报 S5；运行记录顶层散文件仍然报', () => {
  const { root, runtime } = scanRoot();
  scan({ dataRoot: root, indexPath: idxPath(root), runtimeRoot: runtime, workspaces: null, date: '2026-11-22' });
  for (const n of ['API额度', '提醒', '账本待补']) mkdirSync(join(root, '运行记录', n));
  writeFileSync(join(root, '运行记录', '零散.md'), 'x');
  const r = scan({ dataRoot: root, indexPath: idxPath(root), runtimeRoot: runtime, workspaces: null, date: '2026-11-23' });
  const w = r.rows.map((x) => x.where).join('\n');
  for (const n of ['API额度', '提醒', '账本待补']) assert.ok(!w.includes(`运行记录/${n}`), n);
  assert.match(w, /运行记录\/零散\.md/);
});
test('scan：，格式抽查／请示待核 是认识的运行记录子文件夹，不报 S5；不认识的照报', () => {
  const { root, runtime } = scanRoot();
  scan({ dataRoot: root, indexPath: idxPath(root), runtimeRoot: runtime, workspaces: null, date: '2026-11-22' });
  for (const n of ['格式抽查', '请示待核']) mkdirSync(join(root, '运行记录', n));
  mkdirSync(join(root, '运行记录', '神秘日志'));
  const r = scan({ dataRoot: root, indexPath: idxPath(root), runtimeRoot: runtime, workspaces: null, date: '2026-11-23' });
  const w = r.rows.map((x) => x.where).join('\n');
  for (const n of ['格式抽查', '请示待核']) assert.ok(!w.includes(`运行记录/${n}`), n);
  assert.match(w, /运行记录\/神秘日志/);
});
test('scan：盲区抽查 是认识的运行记录子文件夹；桌面角色工作区里的 ui-elements.json 是认识的程序文件；不认识的照报', () => {
  const { root, runtime } = scanRoot();
  S(root, runtime);
  mkdirSync(join(root, '运行记录', '盲区抽查'));
  writeFileSync(join(runtime, 'desktop', 'ui-elements.json'), '{}');
  writeFileSync(join(runtime, 'desktop', 'mystery-new.json'), '{}');
  writeFileSync(join(runtime, 'worker-a', 'ui-elements.json'), '{}'); // 别的角色不认这个名字
  const r = S(root, runtime, { date: '2026-11-23' });
  const w = r.rows.map((x) => x.where).join('\n');
  assert.ok(!w.includes('运行记录/盲区抽查'), w);
  assert.ok(!w.includes('desktop/ui-elements.json'), w);
  assert.match(w, /desktop\/mystery-new\.json/);
  assert.match(w, /worker-a\/ui-elements\.json/);
});
test('scan：写出的对账报告和状态文件；--no-write 不写', () => {
  const { root, runtime } = scanRoot();
  S(root, runtime, { write: false });
  assert.ok(!existsSync(join(root, '运行记录', '文件对账', '状态.json')));
  S(root, runtime);
  assert.ok(existsSync(join(root, '运行记录', '文件对账', '状态.json')));
  assert.ok(existsSync(join(root, '运行记录', '文件对账', '基线.json')));
});

// ---------- 命令行 ----------
function cli(root, args, env = {}) {
  const r = spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, OPENCLAW_DATA_ROOT: root, ...env } });
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* 不是 JSON */ }
  return { code: r.status, j, raw: r.stdout + r.stderr };
}
test('命令行：new-project / new-task / add-result / check-project / scan 走通，退出码对', () => {
  const { root, runtime } = scanRoot();
  let r = cli(root, ['new-project', '--name', '命令行项目', '--channel-id', '100000000000000179', '--channel-name', '命令行频道', '--lead', '总控', '--goal', '试一试']);
  assert.equal(r.code, 0, r.raw); assert.equal(r.j.ok, true);
  r = cli(root, ['new-task', '--project', '命令行项目', '--title', '第一件', '--thread-link', 'https://x/1', '--executor', '执行者E', '--quote', '做吧']);
  assert.equal(r.code, 0, r.raw);
  writeFileSync(join(root, '项目', '命令行项目', '成果', '结果.md'), 'x');
  r = cli(root, ['add-result', '--project', '命令行项目', '--name', '结果', '--path', '成果/结果.md', '--note', '好了']);
  assert.equal(r.code, 0, r.raw);
  r = cli(root, ['check-project', '--project', '命令行项目']);
  assert.equal(r.code, 0); assert.deepEqual(r.j.problems, []);
  const out = join(root, '审计', '日审', '2026-11-22-文件对账.md');
  r = cli(root, ['scan', '--date', '2026-11-22', '--out', out, '--workspaces', `main=${join(runtime, 'controller')},worker-a=${join(runtime, 'worker-a')}`], { OPENCLAW_RUNTIME_ROOT: runtime });
  assert.equal(r.code, 0, r.raw);
  assert.match(readFileSync(out, 'utf8'), /^# 文件对账\n业务日期：2026-11-22\n文件对账：/);
  // 被拒绝 → 退出码 1；缺参数/不认识的命令 → 2
  assert.equal(cli(root, ['new-project', '--name', '带 空格', '--channel-id', '100000000000000180', '--channel-name', 'c', '--lead', 'l', '--goal', 'g']).code, 1);
  assert.equal(cli(root, ['add-result', '--project', 'x']).code, 2);
  assert.equal(cli(root, ['bogus']).code, 2);
  assert.equal(cli(root, ['new-project', '--name']).code, 2);
});

// ---------- additional cases ----------
test('审计A1：scan 的对应表是空数组（读配置失败）→ 当作没给，走 runtime/ 退路并在报告里说明，不静默跳过', () => {
  const { root, runtime } = scanRoot();
  scan({ dataRoot: root, indexPath: idxPath(root), runtimeRoot: runtime, workspaces: [], date: '2026-11-22' }); // 第一次建基线
  writeFileSync(join(runtime, 'worker-a', '新东西.md'), 'x');
  const r = scan({ dataRoot: root, indexPath: idxPath(root), runtimeRoot: runtime, workspaces: [], date: '2026-11-23' });
  assert.ok(r.rows.some((x) => x.area === 'S4' && /worker-a\/新东西\.md/.test(x.where)), '退路确实扫了工作区');
  assert.match(r.report, /没有收到"角色=目录"对应表，退而扫 runtime\//);
});
test('审计A1：命令行 --workspaces ""（空串）→ 当作没给；报告里写明；仍扫 runtime/', () => {
  const { root, runtime } = scanRoot();
  const out = join(root, '审计', '日审', 'x.md');
  let r = cli(root, ['scan', '--date', '2026-11-22', '--out', out, '--workspaces', ''], { OPENCLAW_RUNTIME_ROOT: runtime });
  assert.equal(r.code, 0, r.raw);
  assert.ok(r.j.notes.length >= 1);
  writeFileSync(join(runtime, 'worker-a', '新东西.md'), 'x');
  r = cli(root, ['scan', '--date', '2026-11-23', '--out', out, '--workspaces', ''], { OPENCLAW_RUNTIME_ROOT: runtime });
  assert.equal(r.code, 0, r.raw);
  assert.match(readFileSync(out, 'utf8'), /没有收到"角色=目录"对应表/);
  assert.match(readFileSync(out, 'utf8'), /worker-a\/新东西\.md/);
});
test('审计B：状态.json 和基线.json 权限是 644（里面没有密钥，要让只读审计读得到）', () => {
  const { root, runtime } = scanRoot();
  S(root, runtime);
  for (const f of ['状态.json', '基线.json']) assert.equal((statSync(join(root, '运行记录', '文件对账', f)).mode & 0o777).toString(8), '644', f);
});
test('审计B：每日日记命名样式的成果文件不查"没登记"；普通成果文件仍查', () => {
  const root = newRoot(); mk(root, 'P', { now: Date.parse('2026-11-20T00:00:00Z') });
  const dir = join(root, '项目', 'P', '成果');
  writeFileSync(join(dir, '日记_20261110.md'), 'x');
  writeFileSync(join(dir, '日记_20261110-重跑前副本-20261111T0415.md'), 'x');
  assert.deepEqual(codes(checkProject({ dataRoot: root, indexPath: idxPath(root), name: 'P' })), ['entry-placeholder'], '日记文件不报 result-unlisted');
  writeFileSync(join(dir, '普通成果.md'), 'x');
  assert.ok(codes(checkProject({ dataRoot: root, indexPath: idxPath(root), name: 'P' })).includes('result-unlisted'));
});
test('审计B：命令行经符号链接路径调用也正常执行（不静默成功）', () => {
  const root = newRoot(); mk(root, 'P');
  const linkDir = mkdtempSync(join(tmpdir(), 'pflink-'));
  const link = join(linkDir, 'project-files.mjs');
  execFileSync('/bin/ln', ['-s', CLI, link]);
  const r = spawnSync(NODE, [link, 'check-project', '--project', 'P'], { encoding: 'utf8', env: { ...process.env, OPENCLAW_DATA_ROOT: root } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(JSON.parse(r.stdout).ok === true, '有输出且 ok');
});
