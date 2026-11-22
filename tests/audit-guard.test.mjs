// Offline tests for audit guard: temporary directories and fake data only; nothing touches a real deployment.
// 审计守门离线测试。运行：node --test tests/audit-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createAuditGuard, judgeCommand, judgeWrite, identifyTrigger, loadSnippets, parseCommand, extractSnippet, sha256, maskSecrets, EXEC_LOG_CHARS, SEMICOLON_SNIPPET_HINT } from '../plugins/personal-inbox/audit-guard.mjs';

import { crew } from '../plugins/personal-inbox/crew-config.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RULES_PATH = join(ROOT, 'plugins/personal-inbox/audit-guard-rules.json');
const rules = JSON.parse(readFileSync(RULES_PATH, 'utf8'));
rules.paths.projectRoot = ROOT; // snippet files (jobs/*.md) are resolved against the project root
const DATA_TMP = mkdtempSync(join(tmpdir(), 'guard-data-')); // a real data root so the write-directory rules can resolve real paths
for (const d of [...rules.writeDirs, ...rules.denyWriteDirs, '项目']) mkdirSync(join(DATA_TMP, d), { recursive: true });
rules.paths.dataRoot = DATA_TMP;
const weeklyFile = join(ROOT, rules.snippets[2].file['zh-CN']);
const { snippets, problems } = loadSnippets(rules);
const DR = rules.paths.dataRoot;
const PR = rules.paths.projectRoot;

const q = (text) => `'${text.replace(/'/g, `'\\''`)}'`;
const sysAuditorCmd = (command, extra = {}) => judgeCommand({ role: 'system-auditor', command, params: { command }, rules, snippets, ...extra });
const taskAuditorCmd = (command, extra = {}) => judgeCommand({ role: 'task-auditor', command, params: { command }, rules, snippets, ...extra });
const ok = (v, msg) => assert.equal(v.allow, true, `${msg ?? ''} ${JSON.stringify(v)}`);
const no = (v, msg) => assert.equal(v.allow, false, `应被挡：${msg ?? ''}`);

test('三个固定片段都能从指令文件里取出', () => {
  assert.deepEqual(problems, []);
  assert.deepEqual(snippets.map((s) => s.name), ['业务日期片段', '范围外文件查法', '周审程序核对']);
  for (const s of snippets) assert.match(s.fingerprint, /^[0-9a-f]{64}$/);
});

test('现行指令里的只读写法逐条放行（system-auditor）', () => {
  for (const c of [
    'ls -la /opt/solofleet-data/审计/日审',
    'cat /tmp/x.json',
    'grep -rn --include=*.md 异常 /opt/solofleet-data/审计',
    'grep -c 异常 a.md | head -n 5',
    'head -n 20 a.md',
    'tail -n 20 a.md',
    'tail -5 a.md',
    'wc -l a.md',
    'shasum -a 256 a.md',
    'shasum -a 256 -c list.sha256',
    'sort -u a.txt',
    'sort -t , -k 2 -n a.txt',
    'comm -23 a b',
    'date +%s',
    'date -u +%Y-%m-%d',
    "date -j -f '%Y-%m-%d %H:%M:%S' '2026-11-11 12:00:00' +%s",
    'date -j -v-1d -f "%Y-%m-%d %H:%M:%S" "2026-11-11 12:00:00" +%Y-%m-%d',
    'cd /home/example',
    "sed -n '1,5p' a.md",
    "sed -n '5,$p' a.md",
    "sed -E 's/a+/b/g' a.md",
    "grep x a.md | sed 's/x/y/' | sort",
    "jq -r '.name' a.json",
    'jq -c --arg k v .a a.json',
    'find /opt/solofleet-data/审计 -type f -name "*.md"',
    "find /opt/solofleet/runtime -newermt '2026-11-09 18:05:00' \\( -name DREAMS.md -o -path '*/memory/*' \\)",
    'openclaw automations list --all --json',
    'openclaw automations runs 462c40a1 --json --limit 50 --offset 10',
    'openclaw automations show 462c40a1 --json',
    'openclaw workboard list --status blocked --json',
    'openclaw workboard show abc123 --json',
    'openclaw audit --json --limit 20',
    'openclaw message read --channel discord --account default --target channel:100000000000000003 --limit 100 --json',
    'openclaw message read --channel discord --account default --target channel:1 --limit 100 --before 17 --json',
    'openclaw message thread list --channel discord --account default --guild-id 100000000000000002',
    'openclaw message search --channel discord --account default --guild-id 1 --query abc --author-id 2',
    'openclaw models list --all --provider anthropic --plain',
    'openclaw models list --refresh --provider anthropic --plain',
    'openclaw models aliases list',
    '/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI usage --provider claude --source cli --format json --no-credits',
    `/usr/bin/python3 -I ${PR}/scripts/automation/publish-self.py 周审 2026-11-15`,
    `/usr/bin/python3 -I ${PR}/scripts/automation/publish-self.py 异常深审 2026-11-10`,
    'ls /nonexistent 2>/dev/null',
    'ls /x 2>&1 | head -n 3',
    '/usr/bin/sort -u a.txt',
  ]) ok(sysAuditorCmd(c), c);
});

test('允许程序自己的写入／危险参数一律挡（system-auditor）', () => {
  for (const c of [
    'sort -o out.txt in.txt', 'sort -oout.txt in.txt', 'sort --output=out.txt in.txt', 'sort -no out.txt in.txt',
    'sort --compress-program=x in.txt', 'sort -T /tmp in.txt', 'sort -S 1g in.txt',
    'date 0101000026', 'date -s 12:00', 'date -d tomorrow', 'date foo',
    'tail -f a.log', 'tail -F a.log', 'ls --color=always', 'ls -z',
    "find . -fprint out", 'find . -fprint0 out', 'find . -fprintf out x', 'find . -fls out', 'find . -delete', 'find . -exec rm {} +',
    'find . -execdir rm {} +', 'find . -ok rm {} +', 'find . -okdir rm {} +', 'find . -newerat 2026-01-01', 'find . -newerBt 2026-01-01',
    'find . -newermt abc', 'find . -regex x', 'find -name x', 'find . -L',
    "sed -i 's/a/b/' a.md", "sed -i.bak 's/a/b/' a.md", "sed --in-place 's/a/b/' a.md", "sed 's/a/b/w out' a.md", "sed 's/a/b/e' a.md",
    "sed -n 'w out' a.md", "sed -f script a.md", "sed 'y/a/b/' a.md",
    'git log', 'git -c core.pager=x log',
    'openclaw message send --channel discord --target x --message y', 'openclaw automations run abc', 'openclaw automations add x',
    'openclaw config get x', 'openclaw models set x', 'openclaw workboard move abc --status done', 'openclaw workboard create x',
    'openclaw --profile x models list', 'openclaw automations list --bogus', 'openclaw sessions list',
    'python3 -c print(1)', '/usr/bin/python3 -I -c x', '/usr/bin/python3 -I /tmp/x.py', `/usr/bin/python3 -I ${PR}/scripts/automation/publish-self.py 巡查 2026-11-10`,
    `/usr/bin/python3 -I ${PR}/scripts/automation/publish-self.py 周审 abc`, `/usr/bin/python3 -I ${PR}/scripts/automation/publish-self.py 周审 2026-11-15 extra`,
    'cat a > b', 'cat a >> b', 'ls; rm x', 'ls && rm x', 'ls || rm x', 'ls &', 'echo $(id)', 'echo `id`', 'cat <(ls)', 'cat < a',
    'cat a\nrm b', 'ls "$HOME"', 'ls $HOME', 'FOO=bar ls', 'env ls', 'xargs ls', 'sh -c ls', 'bash -c ls', 'nohup ls', 'time ls', 'eval ls',
    'rm x', 'mv a b', 'cp a b', 'tee x', 'awk 1 a', 'cut -d, -f1 a', 'tr a b', 'uniq a', 'strings a', 'curl x', 'touch x', 'echo hi',
    '/tmp/evil/sort a', './sort a', 'openclaw message read --target channel:1 --limit abc --json x',
    'grep -f', 'grep --color=always x a', 'head -n x a', 'shasum -a 1000 a',
    'jq -n 1', 'jq --rawfile a f .', 'jq -f script a.json', 'comm -23 a', 'cat a |', '| cat a', 'cat "unclosed', "cat 'unclosed",
    'cat a 2>b', 'cat a 2> /dev/null', 'ls 2>&1x',
  ]) no(sysAuditorCmd(c), c);
});

test('exec 的额外参数：env、elevated、host=node 等被挡', () => {
  no(judgeCommand({ role: 'system-auditor', command: 'ls', params: { command: 'ls', env: { A: 'b' } }, rules, snippets }), 'env');
  no(judgeCommand({ role: 'system-auditor', command: 'ls', params: { command: 'ls', elevated: true }, rules, snippets }), 'elevated');
  no(judgeCommand({ role: 'system-auditor', command: 'ls', params: { command: 'ls', background: true }, rules, snippets }), 'background');
  no(judgeCommand({ role: 'system-auditor', command: 'ls', params: { command: 'ls', node: 'n' }, rules, snippets }), 'node');
  ok(judgeCommand({ role: 'system-auditor', command: 'ls', params: { command: 'ls', timeoutSeconds: 300, yieldMs: 1000 }, rules, snippets }), '正常的时限参数');
  ok(judgeCommand({ role: 'system-auditor', command: 'ls', params: { command: 'ls', title: '看一下目录', description: 'x', pty: false, workdir: '/tmp', ask: 'off' }, rules, snippets }), 'title／description 等只影响显示的参数（真实测试里任务审计带了 title）');
  no(judgeCommand({ role: 'system-auditor', command: 'ls', params: { command: 'ls', host: 'node' }, rules, snippets }), 'host=node');
  ok(judgeCommand({ role: 'system-auditor', command: 'ls', params: { command: 'ls', host: 'gateway', env: {} }, rules, snippets }), 'host=gateway、空 env');
});

test('任务审计：只读名单，git 读取动作放行，写入和外部程序参数挡', () => {
  for (const c of ['git log -1', 'git -C /opt/solofleet log --oneline -n 5', 'git log --format=%H -n 3', 'git show HEAD --stat', 'git diff HEAD~1 -- a.md',
    'git status -s', 'git rev-parse HEAD', 'git rev-parse --short HEAD', 'git ls-files -z', 'git blame -L 1,5 a.md', 'git cat-file -p HEAD', 'git cat-file -t HEAD',
    'ls -la', 'cat a.md', 'grep -rn x dir', 'shasum -a 256 a.md', 'sort a', 'git log -- config.json']) ok(taskAuditorCmd(c), c);
  for (const c of ['git -c core.pager=cat log -1', 'git --exec-path=x log', 'git log --output=out', 'git diff --output=f', 'git diff --ext-diff', 'git show --textconv HEAD',
    'git commit -m x', 'git add .', 'git checkout x', 'git reset --hard', 'git clean -fd', 'git push', 'git config user.name x', 'git log -o out', 'git cat-file -s HEAD',
    'git cat-file blob HEAD', 'git -C', 'git',
    'jq . a', 'openclaw automations list', 'python3 x.py', '/usr/bin/python3 -I x.py', 'sort -o out in', 'date 0101000026',
    '/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI usage --provider claude --source cli --format json --no-credits',
    'echo hi', 'rm a', 'touch a']) no(taskAuditorCmd(c), c);
});

test('任务审计 diff：只比较两个现有普通文件，可带 -u／-q', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diff-'));
  try {
    writeFileSync(join(dir, 'a'), 'a\n'); writeFileSync(join(dir, 'b'), 'b\n'); mkdirSync(join(dir, 'd'));
    symlinkSync('/dev/null', join(dir, 'devlink')); symlinkSync(join(dir, 'a'), join(dir, 'alink'));
    ok(taskAuditorCmd(`diff ${dir}/a ${dir}/b`), '无选项'); ok(taskAuditorCmd(`diff -u ${dir}/a ${dir}/b`), '-u'); ok(taskAuditorCmd(`diff -q ${dir}/a ${dir}/b`), '-q');
    ok(taskAuditorCmd(`diff ${dir}/a ${dir}/alink`), '链接指向普通文件');
    for (const c of ['diff - ' + dir + '/a', `diff ${dir}/a -`, `diff -l ${dir}/a ${dir}/b`, `diff --paginate ${dir}/a ${dir}/b`, `diff -r ${dir} ${dir}`, `diff -N ${dir}/a ${dir}/b`,
      `diff ${dir}/a ${dir}/d`, `diff ${dir}/a /dev/null`, `diff ${dir}/a ${dir}/devlink`, `diff ${dir}/a ${dir}/missing`, `diff ${dir}/a`, `diff ${dir}/a ${dir}/b ${dir}/a`,
      `diff -u -u -l ${dir}/a ${dir}/b`, `diff --unified ${dir}/a ${dir}/b`, `diff -y ${dir}/a ${dir}/b`]) no(taskAuditorCmd(c), c);
    // 管道文件
    try { execFileSync('mkfifo', [join(dir, 'fifo')]); no(taskAuditorCmd(`diff ${dir}/a ${dir}/fifo`), '管道文件'); } catch { /* 没有 mkfifo 就跳过这一例 */ }
    // system-auditor 没有 diff
    no(sysAuditorCmd(`diff ${dir}/a ${dir}/b`), 'system-auditor 没有 diff');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('find -newermt：只放这一个，其他 -newer 变体仍挡；括号写法', () => {
  ok(sysAuditorCmd("find /x -newermt '2026-11-09 18:05:00'"), '带时间');
  ok(sysAuditorCmd("find /x -type f -newermt '2026-11-09' ! -newermt '2026-11-10'"), '日期');
  ok(sysAuditorCmd("find /x \\( -name a -o -name b \\)"), '转义括号');
  ok(sysAuditorCmd("find /x '(' -name a -o -name b ')'"), '引号括号');
  no(sysAuditorCmd('find /x ( -name a )'), '没转义括号是语法错误且被拆解挡');
  for (const c of ["find /x -newermt", "find /x -newerct '2026-11-09'", "find /x -newerBt '2026-11-09'", "find /x -newerat '2026-11-09'", "find /x -newermm a", "find /x -newermt 'tomorrow'",
    "find /x -newermt '2026-11-09; rm x'", "find /x -newermt '$(id)'"]) no(sysAuditorCmd(c), c);
});

test('固定片段：原样放行；改一个字、删一段、追加命令、多带参数都挡', () => {
  const [bd, outside, weekly] = snippets;
  ok(sysAuditorCmd(`HM=18:05 DOW= sh -c ${q(bd.text)}`), '业务日期片段');
  ok(sysAuditorCmd(`HM=11:00 DOW=0 sh -c ${q(bd.text)}`), '周审业务日期');
  ok(sysAuditorCmd(`HM=18:05 sh -c ${q(bd.text)}`), '不写 DOW');
  ok(sysAuditorCmd(`A='2026-11-10 18:05:00' B='2026-11-11 18:05:00' DR=${DR} PR=${PR} sh -c ${q(outside.text)}`), '范围外查法');
  ok(sysAuditorCmd(`sh -c ${q(weekly.text)}`), '周审程序核对');
  ok(sysAuditorCmd(`sh -c ${q(weekly.text + '\n')}`), '末尾多一个换行仍是原文');
  for (const [name, s, pre] of [['业务日期', bd, 'HM=18:05 DOW= '], ['范围外', outside, `A='2026-11-10 18:05:00' B='2026-11-11 18:05:00' DR=${DR} PR=${PR} `], ['周审', weekly, '']]) {
    no(sysAuditorCmd(`${pre}sh -c ${q(s.text.replace('echo', 'echo 1;echo'))}`), `${name}：改片段`);
    no(sysAuditorCmd(`${pre}sh -c ${q(s.text.split('\n').slice(0, -3).join('\n'))}`), `${name}：删一段`);
    no(sysAuditorCmd(`${pre}sh -c ${q(s.text.split('\n').filter((l) => !l.trimStart().startsWith('#')).slice(3).join('\n'))}`), `${name}：只取一部分（去掉开头三行代码）`);
    no(sysAuditorCmd(`${pre}sh -c ${q(s.text + '\nrm -rf x')}`), `${name}：片段内追加命令`);
    no(sysAuditorCmd(`${pre}sh -c ${q(s.text)}; rm x`), `${name}：后面追加`);
    no(sysAuditorCmd(`${pre}sh -c ${q(s.text)} && rm x`), `${name}：&& 追加`);
    no(sysAuditorCmd(`${pre}sh -c ${q(s.text)} extra`), `${name}：多带参数`);
    no(sysAuditorCmd(`rm x; ${pre}sh -c ${q(s.text)}`), `${name}：前面追加`);
    no(sysAuditorCmd(`${pre}sh -c ${q(s.text)} | cat`), `${name}：接管道`);
    no(sysAuditorCmd(`${pre}bash -c ${q(s.text)}`), `${name}：换成 bash`);
    no(sysAuditorCmd(`${pre}sh ${q(s.text)}`), `${name}：缺 -c`);
    no(sysAuditorCmd(`${pre}sh -c ${q(s.text).replace(/^'/, '"').replace(/'$/, '"')}`), `${name}：改用双引号`);
  }
  no(sysAuditorCmd(`FAKE_NOW=1 HM=18:05 DOW= sh -c ${q(bd.text)}`), 'FAKE_NOW');
  no(sysAuditorCmd(`HM=18:05 HM=19:00 sh -c ${q(bd.text)}`), '重复变量');
  no(sysAuditorCmd(`HM=abc DOW= sh -c ${q(bd.text)}`), '值格式不对');
  no(sysAuditorCmd(`sh -c ${q(bd.text)}`), '缺 HM');
  no(sysAuditorCmd(`A='2026-11-10 18:05:00' B='2026-11-11 18:05:00' DR=/tmp PR=${PR} sh -c ${q(outside.text)}`), 'DR 换了目录');
  no(sysAuditorCmd(`A='2026-11-10 18:05:00' B='2026-11-11 18:05:00' DR=${DR} sh -c ${q(outside.text)}`), '缺 PR');
  no(sysAuditorCmd(`A='x' B='2026-11-11 18:05:00' DR=${DR} PR=${PR} sh -c ${q(outside.text)}`), 'A 格式不对');
  // 第三个片段：调用前加任何变量赋值都挡
  no(sysAuditorCmd(`X=1 sh -c ${q(weekly.text)}`), '周审片段前加变量');
  no(sysAuditorCmd(`IR=/tmp sh -c ${q(weekly.text)}`), '周审片段前换安装目录');
  no(sysAuditorCmd(`HM=18:05 sh -c ${q(weekly.text)}`), '周审片段不接受 HM');
  // 任务审计不能用片段
  no(taskAuditorCmd(`HM=18:05 DOW= sh -c ${q(bd.text)}`), '任务审计没有片段');
  no(taskAuditorCmd(`sh -c ${q(weekly.text)}`), '任务审计没有周审片段');
  // 普通 sh -c、单独 awk 仍然挡
  no(sysAuditorCmd('sh -c ls'), '普通 sh -c'); no(sysAuditorCmd("sh -c 'ls'"), '普通 sh -c 带引号'); no(sysAuditorCmd("awk '{print}' a"), '单独 awk');
  no(sysAuditorCmd("python3 -I - <<'EOF'\nprint(1)\nEOF"), '单独 python3');
});

test('片段比对忽略注释行、空行和行尾空白（模型常把开头的注释去掉），代码行必须逐字一致', () => {
  for (const [s, pre] of [[snippets[0], 'HM=18:05 DOW= '], [snippets[1], `A='2026-11-10 18:05:00' B='2026-11-11 18:05:00' DR=${DR} PR=${PR} `], [snippets[2], '']]) {
    const noComments = s.text.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    ok(sysAuditorCmd(`${pre}sh -c ${q(noComments)}`), `${s.name}：去掉全部注释行`);
    ok(sysAuditorCmd(`${pre}sh -c ${q(noComments.replace(/\n/g, '  \n') + '\n\n')}`), `${s.name}：行尾多空白、末尾多空行`);
    const lines = s.text.split('\n');
    const k = lines.findIndex((l) => l.trim() && !l.trimStart().startsWith('#'));
    lines[k] = lines[k] + ' ';
    ok(sysAuditorCmd(`${pre}sh -c ${q(lines.join('\n'))}`), `${s.name}：代码行尾多一个空格`);
    // 改代码行（哪怕一个字）仍然挡
    const code = lines.map((l, i) => (i === k ? l.replace(/[A-Za-z0-9]/, (c) => (c === 'z' ? 'y' : 'z')) : l)).join('\n');
    no(sysAuditorCmd(`${pre}sh -c ${q(code)}`), `${s.name}：改了代码行`);
    // 缩进改变（python 缩进有意义）仍然挡
    const indented = lines.map((l) => (l.startsWith('    ') ? ' ' + l : l)).join('\n');
    if (indented !== lines.join('\n')) no(sysAuditorCmd(`${pre}sh -c ${q(indented)}`), `${s.name}：缩进变了`);
  }
  // 守门小修：不再把单引号当双引号认。任何引号改动一律挡（反例见下一条测试）
  const [bd, outside] = snippets;
  // 改了引号里的内容仍然挡
  no(sysAuditorCmd(`HM=18:05 DOW= sh -c ${q(bd.text.replace('"$D $HM:00"', '"$D"'))}`), '改了引号里的内容');
  // 只在注释里加东西不影响，但加一行代码就挡
  const extra = snippets[0].text.replace('# 业务日期片段结束', 'echo hacked\n# 业务日期片段结束');
  no(sysAuditorCmd(`HM=18:05 DOW= sh -c ${q(extra)}`), '加一行代码');
});

test('守门小修：三段片段里没有单引号；改引号的各种写法都挡；旧写法被挡时提示按原文', () => {
  const [bd, outside, weekly] = snippets;
  const A = `A='2026-11-10 18:05:00' B='2026-11-11 18:05:00' DR=${DR} PR=${PR} `;
  for (const s of snippets) assert.ok(!s.text.includes("'"), `${s.name} 里不应有单引号`);
  // 原文放行（再确认一遍）
  ok(sysAuditorCmd(`HM=18:05 DOW= sh -c ${q(bd.text)}`), '业务日期原文');
  ok(sysAuditorCmd(`${A}sh -c ${q(outside.text)}`), '范围外原文');
  ok(sysAuditorCmd(`sh -c ${q(weekly.text)}`), '周审原文');
  // 范围外：吞掉后面过滤的写法
  const want = '-not -path "*/__pycache__/*" -not -name "*.pyc"';
  assert.ok(outside.text.includes(want));
  no(sysAuditorCmd(`${A}sh -c ${q(outside.text.replace(want, '-not -path "*/__pycache__/* -not -name *.pyc"'))}`), '吞掉后面的过滤');
  no(sysAuditorCmd(`${A}sh -c ${q(outside.text.replace(want, `-not -path "*/__pycache__/*' -not -name '*.pyc"`))}`), 'the reproduction that slipped through');
  no(sysAuditorCmd(`${A}sh -c ${q(outside.text.replace(want, `-not -path '*/__pycache__/*' -not -name '*.pyc'`))}`), '旧写法（单引号）');
  no(sysAuditorCmd(`${A}sh -c ${q(outside.text.replace(want, '-not -path */__pycache__/* -not -name *.pyc'))}`), '去掉引号');
  // 业务日期：去掉引号、换成单引号
  const date = '"$D $HM:00"';
  assert.ok(bd.text.includes(date));
  no(sysAuditorCmd(`HM=18:05 DOW= sh -c ${q(bd.text.replace(date, '$D $HM:00'))}`), '业务日期：去掉引号');
  no(sysAuditorCmd(`HM=18:05 DOW= sh -c ${q(bd.text.replace(date, "'$D $HM:00'"))}`), '业务日期：换成单引号（旧写法）');
  // 旧写法被挡时，提示里写明按原文
  const v = sysAuditorCmd(`HM=18:05 DOW= sh -c ${q(bd.text.replace(date, "'$D $HM:00'"))}`);
  assert.equal(v.allow, false);
  assert.match(JSON.stringify(v), /片段已经没有单引号/);
});

test('守门小修：前提扫描——片段里没有把 # 行或空行当数据用的块（heredoc 数据块、三引号字符串）', () => {
  for (const s of snippets) {
    assert.ok(!/'{3}|"{3}/.test(s.text), `${s.name} 里有三引号字符串，忽略 # 行和空行不再等价`);
    const lines = s.text.split('\n');
    const heredocs = lines.map((l, k) => [l, k]).filter(([l]) => /<<-?\s*["']?\w+["']?/.test(l));
    for (const [l, k] of heredocs) {
      const tag = /<<-?\s*["']?(\w+)["']?/.exec(l)[1];
      const end = lines.findIndex((x, n) => n > k && x.trim() === tag);
      assert.ok(end > k, `${s.name}：heredoc ${tag} 没有结束行`);
      // 现有唯一的 heredoc 是周审里的 Python 代码：其中以 # 开头的行必须都是 Python 注释（不是数据）。
      // 这里只允许 PYEOF 这一种，别的 heredoc 出现就让这个测试停下来，改片段的人要重新评估前提。
      assert.equal(tag, 'PYEOF', `${s.name}：出现了新的 heredoc ${tag}，请重新评估“忽略注释行”的前提`);
    }
  }
});

test('改动片段里写死的安装目录或清单目录 → 挡（指纹对不上）', () => {
  const weekly = snippets[2];
  const changed = weekly.text.replace(`${DR}/审计/程序校验清单`, '/tmp/fake-list');
  assert.notEqual(changed, weekly.text);
  no(sysAuditorCmd(`sh -c ${q(changed)}`), '换清单目录');
  const changed2 = weekly.text.replace(`IR=${crew.paths.openclawInstallDir}\n`, 'IR=/opt/other\n');
  assert.notEqual(changed2, weekly.text);
  no(sysAuditorCmd(`sh -c ${q(changed2)}`), '换安装目录');
});

test('片段标记缺失、重复或提取不完整 → 该片段不可用，命令被挡', () => {
  const file = '# 说明\n```sh\n# 周审程序核对开始\necho 1\n# 周审程序核对结束\n```\n';
  assert.equal(extractSnippet(file, '# 周审程序核对开始', '# 周审程序核对结束'), '# 周审程序核对开始\necho 1\n# 周审程序核对结束');
  assert.throws(() => extractSnippet(file.replace('# 周审程序核对结束', 'x'), '# 周审程序核对开始', '# 周审程序核对结束'));
  assert.throws(() => extractSnippet(file.replace('# 周审程序核对开始', 'x'), '# 周审程序核对开始', '# 周审程序核对结束'));
  assert.throws(() => extractSnippet(file + file, '# 周审程序核对开始', '# 周审程序核对结束'));
  assert.throws(() => extractSnippet('# 周审程序核对结束\necho\n# 周审程序核对开始', '# 周审程序核对开始', '# 周审程序核对结束'));
  const broken = loadSnippets(rules, (p) => (p === weeklyFile ? file.replace('# 周审程序核对结束', '') : readFileSync(p, 'utf8')));
  assert.equal(broken.snippets.length, 2);
  assert.equal(broken.problems.length, 1);
  no(judgeCommand({ role: 'system-auditor', command: `sh -c ${q(snippets[2].text)}`, params: {}, rules, snippets: broken.snippets }), '标记缺失的片段');
});

test('指令文件被改后，新内容才成为认可原文（重启时重算指纹）', () => {
  const edited = readFileSync(weeklyFile, 'utf8').replace('# 周审程序核对结束', 'echo 新增一行\n# 周审程序核对结束');
  const re = loadSnippets(rules, (p) => (p === weeklyFile ? edited : readFileSync(p, 'utf8')));
  assert.notEqual(re.snippets[2].fingerprint, snippets[2].fingerprint);
  ok(judgeCommand({ role: 'system-auditor', command: `sh -c ${q(re.snippets[2].text)}`, params: {}, rules, snippets: re.snippets }), '重算后新原文可用');
  no(judgeCommand({ role: 'system-auditor', command: `sh -c ${q(snippets[2].text)}`, params: {}, rules, snippets: re.snippets }), '旧原文不再可用');
});

test('命令拆解：引号里的特殊字符不误挡；各种绕写法被挡', () => {
  assert.equal(parseCommand("grep 'a|b' f").length, 1);
  assert.equal(parseCommand('grep "a;b" f').length, 1);
  assert.equal(parseCommand("cat a | sort | head -n 2").length, 3);
  assert.throws(() => parseCommand('cat a;b'));
  assert.throws(() => parseCommand('cat "$(id)"'));
  assert.throws(() => parseCommand('cat a # c'));
  assert.throws(() => parseCommand(''));
  assert.throws(() => parseCommand('   '));
  ok(sysAuditorCmd("grep 'a|b;c&d>e<f$g' f"), '单引号里的符号是普通字符');
});

// ---------- 写入位置 ----------
function bench() {
  const dir = mkdtempSync(join(tmpdir(), 'guard-w-'));
  const dr = join(dir, '资料');
  for (const d of ['审计/日审', '审计/额度读数', '审计/异常深审', '审计/周审', '审计/异常标记', '审计/发布/凭据', '审计/巡查', '项目/甲/任务']) mkdirSync(join(dr, d), { recursive: true });
  writeFileSync(join(dr, '项目/甲/PROJECT.md'), 'x\n');
  writeFileSync(join(dr, '项目/甲/任务/某任务.md'), 'x\n');
  writeFileSync(join(dr, '审计/日审/已有.md'), 'x\n');
  mkdirSync(join(dir, '别处'));
  writeFileSync(join(dir, '别处/文件.md'), 'x\n');
  symlinkSync(join(dir, '别处'), join(dr, '审计/日审/链接'));
  symlinkSync(join(dir, '别处/不存在的新文件'), join(dr, '审计/日审/悬空'));
  symlinkSync(join(dir, '别处/文件.md'), join(dr, '审计/日审/文件链接'));
  const r = { ...rules, paths: { ...rules.paths, dataRoot: dr } };
  return { dir, dr, r };
}
const w = (r, role, toolName, path) => judgeWrite({ role, toolName, params: { path }, rules: r });

test('写入：审计目录放行，其余挡（含链接、..、新文件、凭据目录）', () => {
  const { dir, dr, r } = bench();
  try {
    ok(w(r, 'system-auditor', 'write', join(dr, '审计/日审/已有.md')), '已有文件整份写');
    ok(w(r, 'system-auditor', 'write', join(dr, '审计/日审/2026-11-11.md')), '新文件');
    ok(w(r, 'system-auditor', 'write', join(dr, '审计/周审/新报告.md')), '周审新文件');
    ok(w(r, 'system-auditor', 'write', join(dr, '审计/异常标记/一.md')), '异常标记');
    ok(w(r, 'system-auditor', 'write', join(dr, '审计/额度读数/一.json')), '额度读数');
    ok(w(r, 'system-auditor', 'write', join(dr, '审计/异常深审/一.md')), '异常深审');
    ok(w(r, 'system-auditor', 'edit', join(dr, '审计/日审/已有.md')), 'edit 审计文件');
    ok(w(r, 'system-auditor', 'edit', join(dr, '项目/甲/PROJECT.md')), 'edit PROJECT.md');
    ok(w(r, 'system-auditor', 'edit', join(dr, '项目/甲/任务/某任务.md')), 'edit 任务记录');
    no(w(r, 'system-auditor', 'write', join(dr, '项目/甲/PROJECT.md')), 'write 整份写 PROJECT.md');
    no(w(r, 'system-auditor', 'write', join(dr, '项目/甲/任务/某任务.md')), 'write 整份写任务记录');
    no(w(r, 'system-auditor', 'write', join(dr, '审计/发布/凭据/周审-2026-11-15.json')), '发布凭据');
    no(w(r, 'system-auditor', 'edit', join(dr, '审计/发布/凭据/x.json')), 'edit 发布凭据');
    no(w(r, 'system-auditor', 'write', join(dr, '审计/巡查/x.md')), '巡查目录不是 system-auditor 的');
    no(w(r, 'system-auditor', 'write', join(dr, 'INDEX.md')), '资料根下别的文件');
    no(w(r, 'system-auditor', 'write', join(dr, '项目/甲/别的.md')), '项目下别的文件');
    no(w(r, 'system-auditor', 'edit', join(dr, '项目/甲/别的.md')), 'edit 项目下别的文件');
    no(w(r, 'system-auditor', 'edit', join(dr, '项目/甲/任务/子/深.md')), '任务记录多一级目录');
    no(w(r, 'system-auditor', 'write', join(dr, '审计/日审/链接/新文件.md')), '审计目录里指向范围外的链接目录');
    no(w(r, 'system-auditor', 'write', join(dr, '审计/日审/文件链接')), '审计目录里指向范围外文件的链接');
    no(w(r, 'system-auditor', 'write', join(dr, '审计/日审/悬空')), '指向范围外不存在位置的悬空链接');
    no(w(r, 'system-auditor', 'write', join(dr, '审计/日审/../../别处/新文件')), '用 .. 跳出');
    no(w(r, 'system-auditor', 'write', join(dir, '别处/新文件')), '范围外不存在的新文件');
    no(w(r, 'system-auditor', 'write', join(dr, '审计/日审/不存在的目录/新文件.md')), '所在目录也不存在');
    no(w(r, 'system-auditor', 'write', 'relative.md'), '相对路径');
    no(w(r, 'system-auditor', 'write', ''), '空路径');
    no(judgeWrite({ role: 'system-auditor', toolName: 'write', params: {}, rules: r }), '没有路径');
    no(w(r, 'task-auditor', 'write', join(dr, '审计/日审/x.md')), '任务审计任何写入');
    no(w(r, 'task-auditor', 'edit', join(dr, '项目/甲/PROJECT.md')), '任务审计 edit');
    // 兼容 file_path 参数名
    ok(judgeWrite({ role: 'system-auditor', toolName: 'write', params: { file_path: join(dr, '审计/日审/x.md') }, rules: r }), 'file_path');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 总入口、规则文件读不到、记录 ----------
function mkGuard(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-h-'));
  const rp = join(dir, 'rules.json');
  writeFileSync(rp, JSON.stringify({ ...rules, ...overrides }));
  const logDir = join(dir, 'log');
  const guard = createAuditGuard({ rulesPath: rp, logDir });
  return { dir, rp, logDir, guard };
}
const call = (guard, agentId, toolName, params, sessionKey = 'k', runId = undefined) => guard.handler({ toolName, params }, { agentId, sessionKey, runId });

test('规则文件读不到或格式错 → 两人的 exec、write、edit 一律挡', () => {
  const { dir, guard, logDir } = mkGuard();
  rmSync(dir, { recursive: true, force: true });
  const g2 = createAuditGuard({ rulesPath: join(dir, '没有这个文件.json'), logDir: join(tmpdir(), 'guard-nolog-' + Date.now()) });
  assert.ok(g2.failure);
  for (const role of ['system-auditor', 'task-auditor']) for (const [t, p] of [['exec', { command: 'ls' }], ['write', { path: '/x' }], ['edit', { path: '/x' }]]) {
    assert.equal(call(g2, role, t, p)?.block, true, `${role} ${t}`);
  }
  assert.equal(call(g2, 'worker-e', 'exec', { command: 'rm -rf /' }), undefined, '别的角色不受影响');
  // 格式错
  const d2 = mkdtempSync(join(tmpdir(), 'guard-bad-'));
  writeFileSync(join(d2, 'r.json'), '{坏的');
  const g3 = createAuditGuard({ rulesPath: join(d2, 'r.json'), logDir: join(d2, 'log') });
  assert.equal(call(g3, 'system-auditor', 'exec', { command: 'ls' }).block, true);
  rmSync(d2, { recursive: true, force: true });
  void guard;
});

test('总入口：只对 系统审计、task-auditor 生效；被挡时写守门记录并遮蔽密钥', () => {
  const { dir, guard, logDir } = mkGuard();
  try {
    assert.equal(call(guard, 'worker-e', 'exec', { command: 'rm -rf x' }), undefined, '其他角色不管');
    assert.equal(call(guard, 'main', 'write', { path: '/x' }), undefined);
    assert.equal(call(guard, 'system-auditor', 'exec', { command: 'ls /tmp' }), undefined, '放行返回 undefined');
    assert.equal(call(guard, 'system-auditor', 'read', { path: '/x' }), undefined, '别的工具交给配置');
    const r1 = call(guard, 'system-auditor', 'exec', { command: 'curl https://x/?token=abcdefghijklmnopqrstuvwxyz0123456789' });
    assert.equal(r1.block, true);
    assert.match(r1.blockReason, /审计守门/);
    assert.equal(call(guard, 'system-auditor', 'mcp__openclaw__exec', { command: 'rm x' }).block, true, '带前缀的工具名');
    assert.equal(call(guard, 'system-auditor', 'Bash', { command: 'rm x' }).block, true, '原生 Bash');
    assert.equal(call(guard, 'task-auditor', 'apply_patch', { input: 'x' }).block, true);
    assert.equal(call(guard, 'system-auditor', 'apply_patch', { input: 'x' }).block, true);
    assert.equal(call(guard, 'task-auditor', 'write', { path: '/x' }).block, true);
    const day = readFileSync(join(logDir, readdirOne(logDir)), 'utf8');
    assert.match(day, /"结果":"挡"/);
    assert.doesNotMatch(day, /abcdefghijklmnopqrstuvwxyz0123456789/);
    assert.match(day, /\[已遮蔽\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const readdirOne = (d) => readdirSync(d).filter((f) => f.endsWith('.jsonl'))[0];

test('maskSecrets', () => {
  assert.equal(maskSecrets('Bearer abc.def'), '[已遮蔽]');
  assert.equal(maskSecrets('sk-abc123'), '[已遮蔽]');
  assert.equal(maskSecrets('password=hunter2'), 'password=[已遮蔽]');
  assert.equal(maskSecrets('a'.repeat(30)), '[已遮蔽]');
  assert.equal(maskSecrets('普通话'), '普通话');
});

// ---------- S8 测试审批分支 ----------
const P4KEY = 'agent:worker-e:discord:channel:100000000000000100';
function setFlag(rp, on) {
  const cur = JSON.parse(readFileSync(rp, 'utf8'));
  cur.p4ApprovalTest = on;
  writeFileSync(rp, JSON.stringify(cur));
}

test('S8：默认关；打开后只匹配执行者E那一条；关掉后不用重启就不再出现；每次匹配都记一行开／关', () => {
  const { dir, guard, rp, logDir } = mkGuard();
  try {
    const cmd = { command: 'echo P4转发测试' };
    assert.equal(call(guard, 'worker-e', 'exec', cmd, P4KEY), undefined, '默认关，不出现审批');
    setFlag(rp, true);
    const r = call(guard, 'worker-e', 'exec', cmd, P4KEY);
    assert.ok(r?.requireApproval, '开后出现审批');
    assert.equal(r.requireApproval.title, 'P4 转发测试');
    assert.deepEqual(r.requireApproval.allowedDecisions, ['allow-once', 'deny']);
    // 执行者E能走到这条分支，而别的角色、别的命令、别的频道进不去
    assert.equal(call(guard, 'worker-a', 'exec', cmd, P4KEY.replace('worker-e', 'worker-a')), undefined);
    assert.equal(call(guard, 'worker-e', 'exec', { command: 'echo 别的话' }, P4KEY), undefined);
    assert.equal(call(guard, 'worker-e', 'exec', { command: 'echo P4转发测试 ; rm x' }, P4KEY), undefined);
    assert.equal(call(guard, 'worker-e', 'exec', cmd, 'agent:worker-e:discord:channel:999'), undefined);
    assert.equal(call(guard, 'system-auditor', 'exec', cmd, P4KEY).block, true);
    assert.equal(call(guard, 'worker-e', 'read', { path: '/x' }, P4KEY), undefined);
    // 回调记结果
    r.requireApproval.onResolution('deny');
    setFlag(rp, false);
    assert.equal(call(guard, 'worker-e', 'exec', cmd, P4KEY), undefined, '关后不用重启就不再出现');
    const log = readFileSync(join(logDir, readdirOne(logDir)), 'utf8');
    assert.match(log, /P4 测试分支：开/);
    assert.match(log, /P4 测试分支：关/);
    assert.match(log, /审批结果 deny/);
    // 开关文件被删或损坏：当作关
    writeFileSync(rp, '{坏');
    assert.equal(call(guard, 'worker-e', 'exec', cmd, P4KEY), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('正式规则文件里 p4ApprovalTest 是 false（已提交的默认值）', () => {
  assert.equal(rules.p4ApprovalTest, false);
});

test('sha256 辅助函数', () => { assert.equal(sha256('a').length, 64); });

// ---------- 第二种例外：触发脚本自己的调用 ----------
const RI = '00000000-0000-4000-8000-000000000001'; // 日审
const DI = '00000000-0000-4000-8000-000000000002'; // 异常深审
const UNLISTED = '99999999-9999-4999-8999-999999999999';
const UUID = '11111111-2222-3333-4444-555555555555';
const tKey = (id) => `agent:system-auditor:cron:${id}:trigger`;
const tRun = (id) => `cron-trigger:${id}:${UUID}`;
const mKey = (id) => `agent:system-auditor:cron:${id}:run:${UUID}`;
const BAD_CMD = "ls /不存在 || echo x; FOO=1 sh -c 'cat /etc/hosts'";
const rowsOf = (logDir) => readFileSync(join(logDir, readdirOne(logDir)), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('触发脚本：正式规则文件里有两个任务的白名单', () => {
  assert.equal(rules.triggerJobs[RI], 'daily-audit');
  assert.equal(rules.triggerJobs[DI], 'deep-review');
  assert.match(rules['说明'], /Trigger-script exception/);
});

test('触发脚本：四样都对 → 跳过命令文字检查；同一条命令按模型身份照挡', () => {
  const { dir, guard } = mkGuard();
  try {
    for (const id of [RI, DI]) {
      assert.equal(call(guard, 'system-auditor', 'exec', { command: BAD_CMD }, mKey(id), UUID).block, true, '模型身份：挡');
      assert.equal(call(guard, 'system-auditor', 'exec', { command: BAD_CMD }, tKey(id), tRun(id)), undefined, '触发脚本身份：放行');
    }
    assert.deepEqual(identifyTrigger({ role: 'system-auditor', sessionKey: tKey(RI), runId: tRun(RI), rules }), { jobId: RI, name: 'daily-audit' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('触发脚本：缺任意一样、格式不对、编号不一致 → 按原规则挡（只会多挡）', () => {
  const { dir, guard } = mkGuard();
  try {
    const cases = {
      '角色不是 system-auditor（任务审计）': ['task-auditor', tKey(RI), tRun(RI)],
      '没有会话键': ['system-auditor', undefined, tRun(RI)],
      '没有运行编号': ['system-auditor', tKey(RI), undefined],
      '会话键是模型运行的形状': ['system-auditor', mKey(RI), tRun(RI)],
      '会话键对但运行编号是 UUID（模型运行）': ['system-auditor', tKey(RI), UUID],
      '会话键对，运行编号是别的任务编号的 cron-trigger': ['system-auditor', tKey(RI), tRun(DI)],
      '会话键是别的任务、运行编号是日审的': ['system-auditor', tKey(DI), tRun(RI)],
      '运行编号前缀编号一致但后面是空的': ['system-auditor', tKey(RI), `cron-trigger:${RI}:`],
      '运行编号前缀少一个冒号': ['system-auditor', tKey(RI), `cron-trigger:${RI}`],
      '运行编号带前缀': ['system-auditor', tKey(RI), `x-cron-trigger:${RI}:${UUID}`],
      '会话键后面多了东西': ['system-auditor', tKey(RI) + ':x', tRun(RI)],
      '会话键前面多了东西': ['system-auditor', 'x' + tKey(RI), tRun(RI)],
      '会话键里的编号不是标准写法': ['system-auditor', 'agent:system-auditor:cron:abc:trigger', 'cron-trigger:abc:' + UUID],
      '会话键用了别的角色': ['system-auditor', `agent:main:cron:${RI}:trigger`, tRun(RI)],
      '四样里的格式都对但任务编号不在白名单': ['system-auditor', tKey(UNLISTED), tRun(UNLISTED)],
      '运行编号和会话键不是字符串': ['system-auditor', { a: 1 }, ['x']],
    };
    for (const [name, [role, sk, rid]] of Object.entries(cases)) {
      assert.equal(call(guard, role, 'exec', { command: BAD_CMD }, sk, rid)?.block, true, name);
    }
    // 白名单整个没有／不是对象：全部按原规则
    const { dir: d2, guard: g2 } = mkGuard({ triggerJobs: undefined });
    assert.equal(call(g2, 'system-auditor', 'exec', { command: BAD_CMD }, tKey(RI), tRun(RI)).block, true, '没有白名单');
    rmSync(d2, { recursive: true, force: true });
    const { dir: d3, guard: g3 } = mkGuard({ triggerJobs: [RI] });
    assert.equal(call(g3, 'system-auditor', 'exec', { command: BAD_CMD }, tKey(RI), tRun(RI)).block, true, '白名单是数组');
    rmSync(d3, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('触发脚本：只跳过命令文字检查——exec 额外参数、一律挡的工具、write／edit 写入规则照旧', () => {
  const { dir, guard } = mkGuard();
  try {
    const t = (tool, params) => call(guard, 'system-auditor', tool, params, tKey(RI), tRun(RI));
    assert.equal(t('exec', { command: 'ls', env: { A: '1' } })?.block, true, 'env');
    assert.equal(t('exec', { command: 'ls', elevated: true })?.block, true, 'elevated');
    assert.equal(t('exec', { command: 'ls', background: true })?.block, true, 'background');
    assert.equal(t('exec', { command: 'ls', node: 'x' })?.block, true, 'node');
    assert.equal(t('exec', { command: 'ls', host: 'node' })?.block, true, 'host=node');
    assert.equal(t('exec', { command: 'ls', host: 'gateway' }), undefined, 'host=gateway 本来就放');
    assert.equal(t('exec', { command: '' })?.block, true, '空命令');
    assert.equal(t('exec', {})?.block, true, '没有命令');
    assert.equal(t('apply_patch', { input: 'x' })?.block, true, '一律挡的工具');
    assert.equal(t('write', { path: '/etc/passwd' })?.block, true, 'write 写到审计目录外');
    assert.equal(t('edit', { path: '/etc/passwd' })?.block, true, 'edit 写到审计目录外');
    assert.equal(t('write', { path: join(DR, '项目/x/PROJECT.md') })?.block, true, 'write 写项目目录');
    assert.equal(t('write', { path: join(DR, '审计/日审/__触发脚本测试__.md') }), undefined, '审计目录里照旧可写');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('触发脚本：守门记录每行有会话键、运行编号；放行行有任务编号和整条命令的 sha256', () => {
  const { dir, guard, logDir } = mkGuard();
  try {
    const long = "printf %s 'x' && echo token=abcdefghijklmnopqrstuvwxyz0123456789 " + 'a b '.repeat(80);
    assert.equal(call(guard, 'system-auditor', 'exec', { command: long }, tKey(RI), tRun(RI)), undefined);
    assert.equal(call(guard, 'system-auditor', 'exec', { command: BAD_CMD }, mKey(RI), UUID).block, true);
    assert.equal(call(guard, 'system-auditor', 'apply_patch', { input: 'x' }, 'k', undefined).block, true);
    assert.equal(call(guard, 'system-auditor', 'exec', { command: 'ls', env: { A: '1' } }, tKey(RI), tRun(RI)).block, true);
    const rows = rowsOf(logDir);
    for (const r of rows) { assert.ok('会话键' in r, JSON.stringify(r)); assert.ok('运行编号' in r, JSON.stringify(r)); }
    const allow = rows.find((r) => r.结果 === '放行（触发脚本）');
    assert.ok(allow);
    assert.equal(allow.会话键, tKey(RI));
    assert.equal(allow.运行编号, tRun(RI));
    assert.equal(allow.任务编号, RI);
    assert.equal(allow.命令sha256, sha256(long));
    assert.ok(allow.内容.length <= 200);
    assert.doesNotMatch(allow.内容, /abcdefghijklmnopqrstuvwxyz0123456789/);
    const modelRow = rows.find((r) => r.结果 === '挡' && r.会话键 === mKey(RI));
    assert.ok(modelRow);
    assert.equal(modelRow.运行编号, UUID);
    const noId = rows.find((r) => r.工具 === 'apply_patch');
    assert.equal(noId.会话键, 'k');
    assert.equal(noId.运行编号, null);
    const envRow = rows.find((r) => r.规则 === 'exec 参数');
    assert.equal(envRow.会话键, tKey(RI));
    assert.equal(rows.filter((r) => r.结果 === '放行（触发脚本）').length, 1, '被挡的触发脚本调用不记放行');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('触发脚本：S8 分支和规则文件不可用时的记录行也带会话键、运行编号', () => {
  const { dir, guard, rp, logDir } = mkGuard();
  try {
    setFlag(rp, true);
    const r = call(guard, 'worker-e', 'exec', { command: 'echo P4转发测试' }, P4KEY, 'run-1');
    r.requireApproval.onResolution('deny');
    const rows = rowsOf(logDir);
    assert.ok(rows.length >= 2);
    for (const x of rows) { assert.equal(x.会话键, P4KEY); assert.equal(x.运行编号, 'run-1'); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 回归：把两个触发脚本真的跑一遍（假 exec 只记命令、返回一份看着像样的输出），收集它们发出的全部命令，
// 按“触发脚本身份”过守门应全放行，按“模型身份”过守门应照挡。以后改触发脚本，这条会先坏。
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function runTrigger(file, fakeOutputs) {
  const src = readFileSync(join(ROOT, 'scripts/automation', file), 'utf8');
  const cmds = [];
  let result;
  const exec = async ({ command }) => { cmds.push(command); return { isError: false, aggregated: fakeOutputs(command) }; };
  const json = (o) => { result = o; return o; };
  await new AsyncFunction('exec', 'json', src)(exec, json);
  return { cmds, result };
}

test('回归：日审触发脚本发出的全部命令——触发脚本身份全放行，模型身份照挡', async () => {
  const roleLines = `main\t/opt/solofleet/runtime/main\n`;
  let written = null;
  const { cmds, result } = await runTrigger('command-spot-check-trigger.js', (c) => {
    if (c.includes('=====ROUNDS')) return roleLines + '=====ROUNDS\n=====END\n';
    if (c.includes('=====ROLE')) return '=====BEGIN\n=====ROLE main\n=====NODIR\n=====AUDIT main arr=1 total=0 known=0 n=0\n=====END\n';
    if (c.includes('WROTE') || c.includes('base64')) { written = Buffer.from(c.match(/printf %s '([A-Za-z0-9+\/=]*)'/)[1], 'base64').toString('utf8'); return 'WROTE\n'; }
    return '';
  });
  assert.ok(result && result.fire === true, JSON.stringify(result));
  // 假输出带 =====BEGIN（命令抽查脚本现在要求开头结尾两个标记都在），走的是正常路径，不是"记录不足（输出被截断）"那条
  assert.ok(written && !written.includes('输出被截断') && /\| main \|/.test(written), '日审触发脚本应走正常对账路径');
  assert.ok(cmds.length >= 3, `日审触发脚本应发出至少 3 条命令（读配置、取记录、写文件），实际 ${cmds.length}`);
  assert.ok(cmds.length <= 5, '官方预算 5 次');
  const { dir, guard } = mkGuard();
  try {
    let blockedAsModel = 0;
    for (const c of cmds) {
      assert.equal(call(guard, 'system-auditor', 'exec', { command: c }, tKey(RI), tRun(RI)), undefined, `触发脚本身份应放行：${c.slice(0, 80)}`);
      if (call(guard, 'system-auditor', 'exec', { command: c }, mKey(RI), UUID)?.block) blockedAsModel++;
    }
    assert.ok(blockedAsModel >= 1, '模型身份至少有一条被挡，否则这个例外就没有存在的理由');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('回归：异常深审触发脚本发出的全部命令——触发脚本身份全放行，模型身份照挡；没有待审标记时返回不叫醒', async () => {
  const none = await runTrigger('deep-review-trigger.js', () => 'TOTAL=0\nNONDONE=0\n=====END\n');
  assert.deepEqual(none.result, { fire: false });
  const carry = await runTrigger('deep-review-trigger.js', (c) => (c.includes('=====REC')
    ? '=====REC 2026-11-10\n{"执行":"完成"}\n=====END\n'
    : 'TOTAL=1\nNONDONE=1\n=====FILE a.json\n{"状态":"深审中 2026-11-10"}\n\n=====END\n'));
  assert.equal(carry.result.fire, true);
  assert.equal(carry.cmds.length, 2, '有“深审中”标记时发两条命令');
  const cmds = [...none.cmds, ...carry.cmds];
  const { dir, guard } = mkGuard();
  try {
    let blockedAsModel = 0;
    for (const c of cmds) {
      assert.equal(call(guard, 'system-auditor', 'exec', { command: c }, tKey(DI), tRun(DI)), undefined, `触发脚本身份应放行：${c.slice(0, 80)}`);
      assert.equal(call(guard, 'system-auditor', 'exec', { command: c }, tKey(RI), tRun(DI))?.block, true, '日审的会话键配异常深审的运行编号：挡');
      if (call(guard, 'system-auditor', 'exec', { command: c }, mKey(DI), UUID)?.block) blockedAsModel++;
    }
    assert.ok(blockedAsModel >= 1, '模型身份至少有一条被挡');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 被挡命令记全文（最多 2000 字，先遮蔽再截断）；片段调用因 ; 被挡时加对症提示（只改文字，不改判定） ----------
const asModel = (guard, command) => call(guard, 'system-auditor', 'exec', { command }, mKey(RI), UUID);

test('小修①：业务日期片段后面接 ; 再接一条名单里的只读命令 → 放行；接名单外的程序（echo）→ 照挡；日志“内容”记全文', () => {
  const { dir, guard, logDir } = mkGuard();
  try {
    assert.equal(asModel(guard, `HM=18:05 DOW= sh -c ${q(snippets[0].text)}; ls /tmp`), undefined, '片段算一条语句，后面的 ls 单独过守门');
    const r = asModel(guard, `HM=18:05 DOW= sh -c ${q(snippets[0].text)}; echo x`);
    assert.equal(r?.block, true);
    assert.match(r.blockReason, /echo 不在这个角色的名单里/);
    const row = rowsOf(logDir).at(-1);
    assert.ok(row.内容.endsWith('; echo x'), '内容要记到命令末尾');
    assert.ok(row.内容.length > 200 && row.内容.length <= EXEC_LOG_CHARS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('小修②：正常的片段调用仍然放行（三段固定片段，变量值带引号／带空格／不带变量都行）', () => {
  const { dir, guard } = mkGuard();
  try {
    const [bd, outside, weekly] = snippets;
    for (const [snip, pre] of [[bd, 'HM=18:05 DOW= '], [outside, `A="2026-11-10 18:05:00" B='2026-11-11 18:05:00' DR=${DR} PR=${PR} `], [weekly, '']]) {
      assert.equal(asModel(guard, `${pre}sh -c ${q(snip.text)}`), undefined, `${snip.name} 应放行`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('小修③：三段固定片段的调用写法后面接 ; ls 都放行；片段放在管道里不算片段；没写 allowSemicolon 的角色仍然“不接受 ;”并给对症提示', () => {
  const { dir, guard } = mkGuard();
  try {
    const [bd, outside, weekly] = snippets;
    for (const pre of ['HM=18:05 DOW= ', `A="2026-11-10 18:05:00" B='2026-11-11 18:05:00' DR=${DR} PR=${PR} `, '']) {
      const snip = pre.startsWith('HM') ? bd : pre === '' ? weekly : outside;
      assert.equal(asModel(guard, `${pre}sh -c ${q(snip.text)}; ls`), undefined, `${snip.name} 后面接 ; ls 应放行`);
    }
    const pipe = asModel(guard, `HM=18:05 DOW= sh -c ${q(snippets[0].text)} | cat`);
    assert.equal(pipe?.block, true, '片段放进管道不算固定片段');
    // 没写 allowSemicolon 的角色（用改过的规则副本）：仍然不接受 ;，且片段调用有对症提示
    const r0 = judgeCommand({ role: 'system-auditor', command: `HM=18:05 DOW= sh -c ${q(snippets[0].text)}; ls`, params: {}, rules: { ...rules, roles: { ...rules.roles, 'system-auditor': { ...rules.roles['system-auditor'], allowSemicolon: false } } }, snippets });
    assert.equal(r0.allow, false); assert.match(r0.reason, /不接受 ;/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('小修④：被挡命令长 3000 字符时日志记前 2000 字符；其它工具（写入）的内容长度仍是 200', () => {
  const { dir, guard, logDir } = mkGuard();
  try {
    const cmd = 'echo ' + 'ab '.repeat(1000) + '; ls';
    assert.ok(cmd.length > 3000 - 10);
    asModel(guard, cmd);
    const row = rowsOf(logDir).at(-1);
    assert.equal(row.内容.length, EXEC_LOG_CHARS);
    assert.ok(row.内容.startsWith('echo ab ab ab'));
    const longPath = '/etc/' + 'p'.repeat(100) + '/' + 'q'.repeat(300);
    call(guard, 'system-auditor', 'write', { path: longPath, content: 'x' }, mKey(RI), UUID);
    const w = rowsOf(logDir).at(-1);
    assert.equal(w.工具, 'write');
    assert.ok(w.内容.length <= 200, `写入的内容长度不变，实际 ${w.内容.length}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('小修⑤：密钥样式仍被遮蔽——先遮蔽再截断，横跨旧截断点（200 字符）的密钥不再露出半截', () => {
  const { dir, guard, logDir } = mkGuard();
  try {
    const key = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123';
    const cmd = 'ls ; ' + 'z '.repeat(90) + key + ' tail';
    const i = cmd.indexOf(key); assert.ok(i < 200 && i + key.length > 200, '密钥要横跨第 200 个字符');
    asModel(guard, cmd);
    const row = rowsOf(logDir).at(-1);
    assert.ok(!row.内容.includes('ABCDEFGH') && !row.内容.includes(key.slice(0, 12)), '半截密钥不能露出');
    assert.match(row.内容, /\[已遮蔽\] tail/);
    asModel(guard, 'cat x ; curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123" token=hunter2 y');
    const r2 = rowsOf(logDir).at(-1);
    assert.ok(!r2.内容.includes('abcdefghijklmnopqrstuvwxyz0123') && !r2.内容.includes('hunter2'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('小修⑥：放行逻辑没动——指纹照旧、规则文件没改、片段原文放行／加一行拒绝', () => {
  for (const sn of snippets) assert.match(sn.fingerprint, /^[0-9a-f]{64}$/);
  ok(sysAuditorCmd(`HM=18:05 DOW= sh -c ${q(snippets[0].text)}`), '片段放行');
  no(sysAuditorCmd(`HM=18:05 DOW= sh -c ${q(snippets[0].text)}; echo x`), '片段后接命令');
  no(sysAuditorCmd(`HM=18:05 DOW= sh -c ${q(snippets[0].text + '\necho x')}`), '片段多一行');
});

// ---------- B1 解析命令批（G1 git log 窄规格、G2 jq 禁词、G3 sed 两种只读写法、A9 写法提示四句）----------
test('B1 G1：system-auditor 的 git——只许 git -C <资料根或项目根> [--no-pager] log，放行写法', () => {
  for (const c of [
    `git -C ${DR} log --oneline -n 5`,
    `git -C ${PR} log --since=2026-11-10 --name-only`,
    `git -C ${PR} --no-pager log -n 1 --stat 0c276b0`,
    `git -C ${PR} --no-pager log --oneline -n 3`,
    `git -C ${DR}/ log -3 -- PROJECT.md`,
    `git -C ${PR} log --since 2026-11-10 --until '2026-11-12 10:00' --name-status --follow -- INDEX.md`,
    `git -C ${PR} --no-pager log --format=%H -n 2`,
    `git -C ${PR} --no-pager log --pretty=format:%h%x20%s --max-count 3 --date short --author someone`,
    `git -C ${PR} log --shortstat --abbrev-commit --decorate --no-color HEAD~2`,
    `git -C ${PR} log --stat -n 1 ${'a'.repeat(40)}`, // 文件对象编号：放行，但输出是空的（git 对文件对象什么都不输出，见下面真仓库那条）
    `git -C ${PR} --no-pager log --oneline -n 3 | head -n 2`,
    `git -C ${PR} log --`, // -- 后面没有路径：等于没写，无害
  ]) ok(sysAuditorCmd(c), c);
});

test('B1 G1：git 挡的写法——无 -C、-C 指到别处或绕写、别的子命令、show 任何写法、-p／-S／-G／--output／-c', () => {
  for (const c of [
    'git log', 'git log -n 1', 'git --no-pager log -n 1',
    `git -C /tmp log -n 1`, `git -C ${DR}/.. log -n 1`, `git -C ${DR}/../资料 log -n 1`, `git -C ./x log -n 1`, `git -C ${DR}x log -n 1`, `git -C ${DR.toUpperCase()} log -n 1`, `git -C '${DR} ' log -n 1`, 'git -C / log -n 1',
    `git -C ${PR} status`, `git -C ${PR} diff`, `git -C ${PR} blame a`, `git -C ${PR} cat-file -p HEAD`, `git -C ${PR} ls-files`, `git -C ${PR} rev-parse HEAD`,
    `git -C ${PR} log -p`, `git -C ${PR} log -S x`, `git -C ${PR} log -G x`, `git -C ${PR} log --grep x`, `git -C ${PR} log --graph`, `git -C ${PR} log -s`,
    `git -C ${PR} log --output=x`, `git -C ${PR} log --output x`, `git -C ${PR} log --ext-diff`, `git -C ${PR} log --textconv`,
    `git -C ${PR} -c core.pager=x log`, `git -C ${PR} --no-pager -c x=y log`, `git -C ${PR} --no-pager --no-pager log`, `git --no-pager -C ${PR} log`,
    `git -C ${PR} log -n x`, `git -C ${PR} log --max-count=x`, `git -C ${PR} log --since --output=x`, `git -C ${PR} log --date=` + 'a'.repeat(30),
    `git -C ${PR} log HEAD:PROJECT.md -n 1 --stat`, `git -C ${PR} log HEAD HEAD~1`, `git -C ${PR} log -- a b c d e f`,
    `git -C ${PR}`, `git -C ${PR} --no-pager`, 'git -C',
    `git -C ${PR} show HEAD`, `git -C ${PR} show HEAD --stat`, `git -C ${PR} show ${'a'.repeat(40)} --stat`, `git -C ${PR} show ${'a'.repeat(40)} --name-only --format=`,
    `git -C ${PR} show HEAD:PROJECT.md`, `git -C ${PR} --no-pager show --no-patch HEAD`, `git -C ${DR} show -s HEAD`,
  ]) no(sysAuditorCmd(c), c);
  assert.match(sysAuditorCmd(`git -C ${PR} show HEAD --stat`).reason, /git show 不开/);
});

test('B1 G1：任务审计（task-auditor）的 git 判定一个都不变——尤其 git -C /x --no-pager log 照旧挡', () => {
  for (const c of ['git -C /x --no-pager log', `git -C ${PR} --no-pager log -n 1`, 'git --no-pager log']) no(taskAuditorCmd(c), c);
  for (const c of ['git -C /tmp log -1', 'git log -p', `git -C ${PR} status -s`, 'git show HEAD --stat', 'git -C /x log --oneline']) ok(taskAuditorCmd(c), c);
});

test('task-auditor rule block fingerprint is unchanged (update this value only when you change that block on purpose)', () => {
  // the task-auditor block allows ';', stat/xxd/od/find/sed, and date with only a + format string (TZ may be set to the configured zone)
  assert.equal(sha256(JSON.stringify(rules.roles['task-auditor'])), '8e84e7e58b6f20bb1ce42bd09677e29230304d50f3aa23b98bf27844129b8347');
});
