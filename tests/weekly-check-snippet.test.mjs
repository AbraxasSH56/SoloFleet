// Offline tests for weekly check snippet: temporary directories and fake data only; nothing touches a real deployment.
// 周审第 2 步“程序核对”固定片段的行为测试。
// 用测试台目录里的假安装目录和假清单，把片段里写死的两个目录换成测试目录后运行；
// 正式片段（真实目录）只在守门测试里核“能否放行”，并另对真实安装目录做一次只读核对（见证据）。
// 运行：node --test tests/weekly-check-snippet.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractSnippet } from '../plugins/personal-inbox/audit-guard.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const rules = JSON.parse(readFileSync(join(ROOT, 'plugins/personal-inbox/audit-guard-rules.json'), 'utf8'));
const def = rules.snippets.find((s) => s.name === '周审程序核对');
const REAL = extractSnippet(readFileSync(join(ROOT, def.file['zh-CN']), 'utf8'), def.start['zh-CN'], def.end['zh-CN']);
const IR_LINE = /^IR=.*$/m;
const LD_LINE = /^LD=.*$/m;
assert.match(REAL, IR_LINE);
assert.match(REAL, LD_LINE);

const md5 = (buf) => createHash('sha256').update(buf).digest('hex');

function bench(version = '2026.10.10') {
  const root = mkdtempSync(join(tmpdir(), 'wk-'));
  const inst = join(root, '安装目录');
  const lists = join(root, '清单目录');
  mkdirSync(inst, { recursive: true });
  mkdirSync(lists, { recursive: true });
  const put = (rel, content) => { mkdirSync(dirname(join(inst, rel)), { recursive: true }); writeFileSync(join(inst, rel), content); };
  put('package.json', JSON.stringify({ name: 'openclaw', version, dependencies: { a: '1.0.0' } }, null, 2) + '\n');
  put('openclaw.mjs', 'console.log(1)\n');
  put('dist/a.js', 'a\n');
  put('dist/有 空格.js', 'space\n');
  put('node_modules/dep/index.js', 'dep\n');
  put('node_modules/dep/package.json', '{"name":"dep"}\n');
  const manifest = (extra = []) => {
    const rels = ['package.json', 'openclaw.mjs', 'dist/a.js', 'dist/有 空格.js', 'node_modules/dep/index.js', 'node_modules/dep/package.json', ...extra];
    return rels.map((r) => `${md5(readFileSync(join(inst, r)))}  ${r}`).join('\n') + '\n';
  };
  const writeList = (text, ver = version) => writeFileSync(join(lists, `openclaw-${ver}.sha256`), text);
  writeList(manifest());
  return { root, inst, lists, put, manifest, writeList };
}

function run(b, { alarm } = {}) {
  let text = REAL.replace(IR_LINE, `IR=${b.inst}`).replace(LD_LINE, `LD=${b.lists}`);
  if (alarm) text = text.replace('signal.alarm(280)', `signal.alarm(${alarm})`);
  const r = spawnSync('sh', ['-c', text], { encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: r.stdout + r.stderr };
}
const done = (b) => rmSync(b.root, { recursive: true, force: true });
const SAME = '程序一致性：核对完成，一致';
const DIFF = '程序一致性：核对完成，有差异';
const CANNOT = '程序一致性：未能核对';

test('片段里没有单引号和反引号（才能整段放进 sh -c 的单引号里）', () => {
  assert.equal(REAL.includes("'"), false);
  assert.equal(REAL.includes('`'), false);
});

test('材料完整且一致 → 明确报“核对完成，一致”并带覆盖范围', () => {
  const b = bench();
  try {
    const r = run(b);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(SAME));
    assert.match(r.out, /覆盖范围：清单内 6 个文件（含依赖目录里的 2 个）/);
    assert.match(r.out, /所用清单：openclaw-2026\.10\.10\.sha256/);
  } finally { done(b); }
});

test('已列文件被改、被删；非依赖目录多出文件 → 分别报出', () => {
  const b = bench();
  try {
    b.put('dist/a.js', 'changed\n');
    unlinkSync(join(b.inst, 'openclaw.mjs'));
    b.put('dist/新增.js', 'extra\n');
    const r = run(b);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /文件内容不符：1 个\n  dist\/a\.js/);
    assert.match(r.out, /清单里有、实际缺失：1 个\n  openclaw\.mjs/);
    assert.match(r.out, /清单外多出：1 个\n  dist\/新增\.js/);
    assert.match(r.out, new RegExp(DIFF));
    assert.doesNotMatch(r.out, new RegExp(SAME));
  } finally { done(b); }
});

test('依赖目录里已列文件被改 → 报差异；依赖目录另添未列文件 → 按覆盖范围排除', () => {
  const b = bench();
  try {
    b.put('node_modules/dep/index.js', 'tampered\n');
    let r = run(b);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /文件内容不符：1 个\n  node_modules\/dep\/index\.js/);
    b.put('node_modules/dep/index.js', 'dep\n');
    b.put('node_modules/另一个/新.js', 'new\n');
    r = run(b);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(SAME));
  } finally { done(b); }
});

test('清单缺失、为空、损坏、版本不符 → 报“未能核对”，不报一致', () => {
  for (const [name, setup, re] of [
    ['缺失', (b) => unlinkSync(join(b.lists, 'openclaw-2026.10.10.sha256')), /没有对应版本的清单/],
    ['为空', (b) => b.writeList(''), /清单是空的/],
    ['只有空白', (b) => b.writeList('  \n\n'), /清单是空的/],
    ['格式损坏', (b) => b.writeList('这不是清单\n'), /格式不认识/],
    ['指纹太短', (b) => b.writeList('abc  openclaw.mjs\n'), /格式不认识/],
    ['单空格', (b) => b.writeList(`${'a'.repeat(64)} openclaw.mjs\n`), /格式不认识/],
    ['路径含 ..', (b) => b.writeList(b.manifest() + `${'a'.repeat(64)}  ../x\n`), /路径不合要求/],
    ['路径是绝对路径', (b) => b.writeList(b.manifest() + `${'a'.repeat(64)}  /etc/passwd\n`), /路径不合要求/],
    ['路径重复', (b) => b.writeList(b.manifest() + b.manifest().split('\n')[0] + '\n'), /路径重复/],
    ['缺 package.json 那条', (b) => b.writeList(b.manifest().split('\n').slice(1).join('\n')), /package\.json 自己的那一条/],
    ['版本不符（只有别的版本的清单）', (b) => { unlinkSync(join(b.lists, 'openclaw-2026.10.10.sha256')); b.writeList(b.manifest(), '2026.10.9'); }, /没有对应版本的清单/],
  ]) {
    const b = bench();
    try {
      setup(b);
      const r = run(b);
      assert.equal(r.code, 3, `${name}：${r.out}`);
      assert.match(r.out, new RegExp(CANNOT), name);
      assert.match(r.out, re, name);
      assert.doesNotMatch(r.out, new RegExp(SAME), name);
    } finally { done(b); }
  }
});

test('扫描失败、校验读不了文件、超时 → 不得报“一致”', () => {
  // 扫描失败：依赖目录之外有读不了的子目录
  let b = bench();
  try {
    b.put('dist/锁/x.js', 'x\n');
    chmodSync(join(b.inst, 'dist/锁'), 0o000);
    const r = run(b);
    chmodSync(join(b.inst, 'dist/锁'), 0o755);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /扫描文件失败/);
    assert.doesNotMatch(r.out, new RegExp(SAME));
  } finally { done(b); }
  // 校验中途：清单里的文件读不了
  b = bench();
  try {
    chmodSync(join(b.inst, 'dist/a.js'), 0o000);
    const r = run(b);
    chmodSync(join(b.inst, 'dist/a.js'), 0o644);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /核对指纹时读不了文件/);
    assert.doesNotMatch(r.out, new RegExp(SAME));
  } finally { done(b); }
  // 超时：清单里的“文件”是一个没人写的管道，读它会一直挂住
  b = bench();
  try {
    unlinkSync(join(b.inst, 'dist/a.js'));
    spawnSync('mkfifo', [join(b.inst, 'dist/a.js')]);
    const r = run(b, { alarm: 2 });
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /超时/);
    assert.doesNotMatch(r.out, new RegExp(SAME));
  } finally { done(b); }
});

test('进安装目录失败 → 立即报“未能核对”', () => {
  const b = bench();
  try {
    rmSync(b.inst, { recursive: true, force: true });
    const r = run(b);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /进不了程序安装目录/);
  } finally { done(b); }
});

test('文件名含空格能正确比较；不认识的文件名格式明确报“未能核对”', () => {
  const b = bench();
  try {
    let r = run(b);
    assert.equal(r.code, 0, r.out);
    b.put('dist/有 空格.js', 'changed\n');
    r = run(b);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /文件内容不符：1 个\n  dist\/有 空格\.js/);
    b.put('dist/有 空格.js', 'space\n');
    b.writeList(b.manifest().replace('  dist/有 空格.js', '  dist/有\t空格.js'));
    r = run(b);
    assert.equal(r.code, 3, r.out);
  } finally { done(b); }
});

test('package.json 损坏、版本值缺失、带 /、换行或命令文字 → 报“未能核对”，不执行任何东西', () => {
  const marker = join(tmpdir(), `wk-pwn-${process.pid}-${Date.now()}`);
  for (const [name, content, re] of [
    ['损坏', '{坏的', /读不到或内容损坏/],
    ['不是对象', '[1,2]', /没有版本值/],
    ['版本缺失', '{"name":"x"}', /没有版本值/],
    ['版本不是字符串', '{"version":20261010}', /没有版本值/],
    ['带斜杠', '{"version":"2026.10.10/../x"}', /格式不支持/],
    ['带换行', '{"version":"2026.10.10\\nrm x"}', /格式不支持/],
    ['命令文字', `{"version":"$(touch ${marker})"}`, /格式不支持/],
    ['反引号', `{"version":"\`touch ${marker}\`"}`, /格式不支持/],
    ['分号', `{"version":"1.0.0; touch ${marker}"}`, /格式不支持/],
    ['格式不是三段', '{"version":"2026.10"}', /格式不支持/],
    ['空字符串', '{"version":""}', /格式不支持/],
  ]) {
    const b = bench();
    try {
      writeFileSync(join(b.inst, 'package.json'), content);
      const r = run(b);
      assert.equal(r.code, 3, `${name}：${r.out}`);
      assert.match(r.out, re, name);
      assert.equal(existsSync(marker), false, `${name}：不得执行命令文字`);
    } finally { done(b); }
  }
  // 文件根本不存在
  const b = bench();
  try {
    unlinkSync(join(b.inst, 'package.json'));
    const r = run(b);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /读不到或内容损坏/);
  } finally { done(b); }
});

test('新版本：没有对应清单 → “未能核对”；已有正确清单 → 正常核对（不自己换别的版本）', () => {
  let b = bench('2026.11.1');
  try {
    unlinkSync(join(b.lists, 'openclaw-2026.11.1.sha256'));
    b.writeList(b.manifest(), '2026.10.10'); // 只有旧版本的清单
    let r = run(b);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /没有对应版本的清单 openclaw-2026\.11\.1\.sha256/);
    b.writeList(b.manifest(), '2026.11.1');
    r = run(b);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /openclaw-2026\.11\.1\.sha256/);
  } finally { done(b); }
  b = bench('2026.11.1-beta.2');
  try {
    const r = run(b);
    assert.equal(r.code, 0, r.out);
  } finally { done(b); }
});

test('链接不算多余文件；符号链接不被当普通文件扫描', () => {
  const b = bench();
  try {
    spawnSync('ln', ['-s', join(b.inst, 'dist/a.js'), join(b.inst, 'dist/链接.js')]);
    const r = run(b);
    assert.equal(r.code, 0, r.out);
  } finally { done(b); }
});
