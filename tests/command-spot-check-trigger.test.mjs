// Offline tests for command spot check trigger: temporary directories and fake data only; nothing touches a real deployment.
// 命令抽查触发脚本（scripts/automation/command-spot-check-trigger.js）的离线测试。
// 前五类用假输出测"解析端"；第六类和第七类真的在 bash 里跑脚本发出的命令（假 openclaw、假会话记录目录），测"命令里的 jq"。
// 不碰真实数据、不碰正式目录：脚本里的四个根目录常量按测试临时目录替换。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'scripts/automation/command-spot-check-trigger.js'), 'utf8').replace(/const TIMEZONE = "[^"]*";/, 'const TIMEZONE = "Asia/Kolkata";'); // fixed UTC+5:30 test zone
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const NOW = '2026-11-12T12:35:00Z'; // 业务日期 2026-11-12，窗口 2026-11-11T12:35:00Z → 2026-11-12T12:35:00Z
const T = (i) => new Date(Date.parse('2026-11-11T16:30:00Z') + i * 1000).toISOString();
const dirName = (ws) => Array.from(ws).map((c) => (c === '/' || c.codePointAt(0) > 127 ? '-' : c)).join('');
let HAS_JQ = true; try { execFileSync('jq', ['--version']); } catch { HAS_JQ = false; }

function srcWith(consts) {
  let s = SRC;
  for (const [k, v] of Object.entries(consts)) {
    const re = new RegExp(`const ${k} = "[^"]*";`);
    assert.ok(re.test(s), `脚本里找不到常量 ${k}`);
    s = s.replace(re, `const ${k} = ${JSON.stringify(v)};`);
  }
  return s;
}
async function runScript(src, exec) {
  let result; const calls = [];
  const wrapped = async (a) => { calls.push(a.command); return exec(a, calls.length); };
  await new AsyncFunction('exec', 'json', 'FAKE_NOW', src)(wrapped, (o) => { result = o; return o; }, NOW);
  return { result, calls };
}
const decodeWrite = (cmd) => Buffer.from(cmd.match(/printf %s '([A-Za-z0-9+/=]*)'/)[1], 'base64').toString('utf8');

// ---------- 假输出（只测解析端） ----------
const PR = '/opt/solofleet';
const cfgOut = `main\t${PR}/runtime/main\nworker-x\t${PR}/runtime/worker-x\n=====ROUNDS\n=====END\n`;
const cmdLine = (i, k = '', c = 'ls -la') => `${T(i)}\t${k}\t0\t${c}`;
const roleBlock = (r, cmds, n, audit) => `=====ROLE ${r}\n${cmds.join('\n')}${cmds.length ? '\n' : ''}${n === null ? '' : `=====CMDN ${n}\n`}${audit === null ? '' : `${audit}\n`}`;
const aud = (r, total, known, n) => `=====AUDIT ${r} arr=1 total=${total} known=${known} n=${n}`;
async function runFake(out2) {
  let written = null;
  const { result } = await runScript(SRC.replace(/const DATA_ROOT = "[^"]*";/, 'const DATA_ROOT = "/tmp/不会写到这里";'), async ({ command }) => {
    if (command.includes('=====ROUNDS')) return { isError: false, aggregated: cfgOut };
    if (command.includes('base64')) { written = decodeWrite(command); return { isError: false, aggregated: 'WROTE\n' }; }
    return { isError: false, aggregated: out2 };
  });
  return { result, written };
}
const rowOf = (text, role) => (text.match(new RegExp(`^\\| ${role} \\|.*$`, 'm')) ?? [null])[0];

test('① 正常输出（有开头和结尾标记）：逐角色对账正确，不出现"没读到"', async () => {
  const out = '=====BEGIN\n' + roleBlock('main', [cmdLine(1), cmdLine(2)], 2, aud('main', 5, 5, 2)) + roleBlock('worker-x', [], 0, aud('worker-x', 0, 0, 0)) + '=====END\n';
  const { written } = await runFake(out);
  assert.match(rowOf(written, 'main'), /\| main \| 2 \| 2 \| 对得上 \|/);
  assert.match(rowOf(written, 'worker-x'), /\| worker-x \| 0 \| 0 \| 本轮没有命令行调用 \|/);
  assert.ok(!written.includes('没读到'));
  assert.ok(!written.includes('输出被截断'));
});

test('② 输出被截掉开头（没有 =====BEGIN）：整份写"记录不足（输出被截断）"，不逐角色写"没读到"', async () => {
  const out = roleBlock('worker-x', [], 0, aud('worker-x', 0, 0, 0)) + '=====END\n'; // main 整段连同开头标记都丢了
  const { written, result } = await runFake(out);
  assert.match(written, /记录不足（会话记录读取失败或输出被截断：开头标记丢了）/);
  assert.ok(!written.includes('没读到'));
  assert.ok(!written.includes('| main |'));
  assert.match(result.message, /记录不足/);
});

test('③ 缺结尾标记：整份写"记录不足（输出被截断）"，注明结尾标记丢了', async () => {
  const out = '=====BEGIN\n' + roleBlock('main', [cmdLine(1)], 1, aud('main', 1, 1, 1));
  const { written } = await runFake(out);
  assert.match(written, /结尾标记丢了/);
  assert.ok(!written.includes('没读到'));
});

test('③b 开头和结尾标记都丢了', async () => {
  const { written } = await runFake(roleBlock('worker-x', [], 0, aud('worker-x', 0, 0, 0)));
  assert.match(written, /开头和结尾标记都丢了/);
});

test('④ 某角色官方记录读不了：AUDIT 行整行缺失、arr=0（格式不认识）、有记录但没有可认事件，口径与旧版一致', async () => {
  const out = '=====BEGIN\n'
    + roleBlock('main', [cmdLine(1)], 1, null) // 整行缺失（openclaw audit 没输出时 jq 什么也不打）
    + roleBlock('worker-x', [cmdLine(2)], 1, '=====AUDIT worker-x arr=0') + '=====END\n';
  const { written } = await runFake(out);
  assert.match(rowOf(written, 'main'), /\| main \| 1 \| 读不了 \| 记录不足：官方记录读不了 \|/);
  assert.match(rowOf(written, 'worker-x'), /\| worker-x \| 1 \| 读不了 \| 记录不足：官方记录读不了（格式不认识） \|/);
  const out2 = '=====BEGIN\n' + roleBlock('main', [], 0, aud('main', 7, 0, 0)) + roleBlock('worker-x', [], 0, null) + '=====END\n'; // 7 条事件但没有一条同时带工具名和动作
  const w2 = (await runFake(out2)).written;
  assert.match(rowOf(w2, 'main'), /官方记录读不了（格式不认识）/);
});

test('④b 某角色的会话命令段没出现 CMDN（jq 中途坏了）：写"这个角色的结果没读到"，其他角色不受影响', async () => {
  const out = '=====BEGIN\n' + roleBlock('main', [cmdLine(1)], null, aud('main', 1, 1, 1)) + roleBlock('worker-x', [], 0, aud('worker-x', 0, 0, 0)) + '=====END\n';
  const { written } = await runFake(out);
  assert.match(rowOf(written, 'main'), /记录不足：这个角色的结果没读到/);
  assert.match(rowOf(written, 'worker-x'), /本轮没有命令行调用/);
});

test('⑤ 官方记录满 500 条算读不了；499 条照算；差 1 算窗口边缘；差 2 记录不足', async () => {
  const out = '=====BEGIN\n' + roleBlock('main', [cmdLine(1)], 40, aud('main', 500, 500, 40))
    + roleBlock('worker-x', [], 0, aud('worker-x', 499, 499, 0)) + '=====END\n';
  const { written } = await runFake(out);
  assert.match(rowOf(written, 'main'), /官方记录读不了（达到单页上限 500，可能不全）/);
  assert.match(rowOf(written, 'worker-x'), /本轮没有命令行调用/);
  const w2 = (await runFake('=====BEGIN\n' + roleBlock('main', [], 5, aud('main', 9, 9, 6)) + roleBlock('worker-x', [], 5, aud('worker-x', 9, 9, 7)) + '=====END\n')).written;
  assert.match(rowOf(w2, 'main'), /对得上（差 1，窗口边缘）/);
  assert.match(rowOf(w2, 'worker-x'), /记录不足：条数对不上（官方 7、会话记录 5）/);
});

test('⑤b 命中关键字的行带回的数据照样进"命中关键字"一节，并按总数对账', async () => {
  const out = '=====BEGIN\n' + roleBlock('main', [cmdLine(1, 'osascript,peekaboo', 'osascript -e x'), cmdLine(2)], 150, aud('main', 150, 150, 150)) + roleBlock('worker-x', [], 0, aud('worker-x', 0, 0, 0)) + '=====END\n';
  const { written, result } = await runFake(out);
  assert.match(rowOf(written, 'main'), /\| main \| 150 \| 150 \| 对得上 \|/);
  assert.match(written, /- main \S+ 命中：osascript、peekaboo；osascript -e x/);
  assert.match(result.message, /命中关键字 1 条/);
  assert.match(result.message, /共 150 条命令/);
});

// ---------- 真跑命令里的 jq（假 openclaw、假会话记录目录） ----------
function mkFixture(roles) {
  const dir = mkdtempSync(join(tmpdir(), 'cmd-spot-'));
  const proj = join(dir, 'proj'), claude = join(dir, 'claude'), data = join(dir, 'data'), fix = join(dir, 'fix'), bin = join(dir, 'bin');
  for (const d of [proj, claude, join(data, '审计/日审'), fix, bin]) mkdirSync(d, { recursive: true });
  const cfg = { agents: { entries: Object.fromEntries(roles.map((r) => [r, { workspace: r === 'main' ? `${proj}/runtime/main` : `${proj}/runtime/${r}` }])) } };
  writeFileSync(join(dir, 'openclaw.json'), JSON.stringify(cfg));
  writeFileSync(join(bin, 'openclaw'), `#!/bin/bash\nwhile [ $# -gt 0 ]; do [ "$1" = "--agent" ] && a="$2"; shift; done\n[ -f "${fix}/audit-$a.out" ] && cat "${fix}/audit-$a.out"\nexit 0\n`);
  chmodSync(join(bin, 'openclaw'), 0o755);
  return { dir, proj, claude, data, fix, bin, cfgFile: join(dir, 'openclaw.json') };
}
const wsOf = (fx, r) => (r === 'main' ? `${fx.proj}/runtime/main` : `${fx.proj}/runtime/${r}`);
function putSession(fx, r, lines) {
  const d = join(fx.claude, dirName(wsOf(fx, r)));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 's1.jsonl'), lines.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n');
}
const execTool = (i, command, name = 'Bash') => ({ type: 'assistant', timestamp: T(i), message: { content: [{ type: 'text', text: '好' }, { type: 'tool_use', name, input: { command } }] } });
const auditEv = (toolName, action) => ({ toolName, action, status: 'ok' });
async function runReal(fx) {
  const src = srcWith({ DATA_ROOT: fx.data, PROJECT_ROOT: fx.proj, WORKSPACE_ROOT: `${fx.proj}/runtime`, CLAUDE_ROOT: fx.claude, CONFIG_FILE: fx.cfgFile });
  const sizes = [];
  const { result } = await runScript(src, ({ command }) => new Promise((res) => {
    execFile('/bin/bash', ['-c', command], { maxBuffer: 1 << 26, env: { ...process.env, PATH: `${fx.bin}:${process.env.PATH}` } }, (err, stdout) => { sizes.push(String(stdout).length); res({ isError: false, aggregated: String(stdout) }); });
  }));
  const f = join(fx.data, '审计/日审'); const name = readdirSync(f).find((x) => x.endsWith('-命令抽查.md'));
  return { result, text: readFileSync(join(f, name), 'utf8'), sizes };
}

test('⑥ 真跑 jq：某角色 130 条命令，正文只带 100 条、总数照报、超出封顶的命中关键字行全部带回、官方数按口径算', { skip: !HAS_JQ }, async () => {
  const fx = mkFixture(['main', 'worker-x']);
  try {
    const sess = [];
    for (let i = 0; i < 130; i++) sess.push(execTool(i, i === 110 ? 'osascript -e "x"' : i === 125 ? 'echo screencapture; open -a Foo' : `echo 命令-${i}`));
    sess.push(execTool(200, 'echo 窗口之外', 'Bash')); sess[sess.length - 1].timestamp = '2026-11-12T13:30:00.000Z'; // 窗口之外，不算
    sess.push('这不是 JSON 行');
    sess.push({ type: 'assistant', timestamp: T(300), message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] } }); // 不是命令工具
    putSession(fx, 'main', sess);
    const events = [];
    for (let i = 0; i < 130; i++) events.push(auditEv('exec', 'tool.finished'), auditEv('exec', 'tool.started'));
    events.push(auditEv('read', 'tool.finished'));
    writeFileSync(join(fx.fix, 'audit-main.out'), JSON.stringify({ events }));
    const { text, result, sizes } = await runReal(fx);
    assert.match(rowOf(text, 'main'), /\| main \| 130 \| 130 \| 对得上 \|/);
    assert.match(rowOf(text, 'worker-x'), /\| worker-x \| 0 \| 读不了 \| 记录不足：官方记录读不了 \|/); // 没有 audit 输出
    const listed = text.split('## 全部命令')[1].split('\n').filter((l) => l.startsWith('- main '));
    assert.equal(listed.length, 102, '前 100 条＋超出封顶的 2 条命中关键字行');
    assert.match(text, /- main \S+ 命中：osascript；osascript -e "x"/);
    assert.match(text, /命中：screencapture、open -a；/);
    assert.match(text.split('## 命中关键字')[1].split('## 全部命令')[0], /osascript/);
    assert.ok(!text.includes('窗口之外'));
    assert.match(text, /共 130 条/);
    assert.match(result.message, /命中关键字 2 条/);
    assert.ok(Math.max(...sizes) < 100000, `第 2 次命令输出应远小于 20 万字符，实际 ${Math.max(...sizes)}`);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('⑦ 真跑 jq：官方记录各种形状（满 500 条、空输出、不是 JSON、纯数组、无可认事件）判法与旧版一致', { skip: !HAS_JQ }, async () => {
  const roles = ['main', 'worker-a', 'worker-b', 'worker-c', 'worker-d', 'worker-e'];
  const fx = mkFixture(roles);
  try {
    putSession(fx, 'main', [execTool(1, 'ls')]);
    const ev = (n, tool = 'exec') => Array.from({ length: n }, () => auditEv(tool, 'tool.finished'));
    writeFileSync(join(fx.fix, 'audit-main.out'), JSON.stringify(ev(1))); // 纯数组
    writeFileSync(join(fx.fix, 'audit-worker-a.out'), JSON.stringify({ events: ev(500) })); // 满 500
    writeFileSync(join(fx.fix, 'audit-worker-b.out'), 'oops: 这不是 JSON\n'); // 不是 JSON
    // worker-c 没有输出文件 → 空输出
    writeFileSync(join(fx.fix, 'audit-worker-d.out'), JSON.stringify({ events: [{ foo: 1 }, { bar: 2 }] })); // 有记录但没有可认事件
    writeFileSync(join(fx.fix, 'audit-worker-e.out'), JSON.stringify({ events: [{ toolName: 'mcp__openclaw__exec', action: 'tool.finished' }, { toolName: 'exec', action: null }, { tool_name: 'exec', action: 'x.finished' }, { toolName: 'read', action: 'finished' }] })); // 旧口径：action:null 算认得但不计数
    const { text } = await runReal(fx);
    assert.match(rowOf(text, 'main'), /\| main \| 1 \| 1 \| 对得上 \|/);
    assert.match(rowOf(text, 'worker-a'), /官方记录读不了（达到单页上限 500，可能不全）/);
    assert.match(rowOf(text, 'worker-b'), /\| worker-b \| 0 \| 读不了 \| 记录不足：官方记录读不了 \|/);
    assert.match(rowOf(text, 'worker-c'), /\| worker-c \| 0 \| 读不了 \| 记录不足：官方记录读不了 \|/);
    assert.match(rowOf(text, 'worker-d'), /官方记录读不了（格式不认识）/);
    assert.match(rowOf(text, 'worker-e'), /\| worker-e \| 0 \| 2 \| 记录不足：条数对不上（官方 2、会话记录 0）/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('⑧ 真跑 jq：命令超过 400 字符时只带回前 400，关键字仍按前 4000 字符判；密钥照旧遮蔽，截断处的半截"像密钥的字符"被去掉', { skip: !HAS_JQ }, async () => {
  const fx = mkFixture(['main']);
  try {
    const longCmd = 'echo ' + 'a b '.repeat(120) + 'XYZ' + 'peekaboo ' + 'Q'.repeat(30); // peekaboo 在第 4xx 字符，超出 400 带回长度，但在 4000 内
    const secret = 'curl -H "Authorization: Bearer abcdefghijklmnop1234567890" https://x';
    putSession(fx, 'main', [execTool(1, longCmd), execTool(2, secret), execTool(3, 'echo ' + 'x'.repeat(390) + 'sk-' + 'A'.repeat(10))]);
    writeFileSync(join(fx.fix, 'audit-main.out'), JSON.stringify({ events: [1, 2, 3].map(() => auditEv('exec', 'finished')) }));
    const { text } = await runReal(fx);
    assert.match(text, /- main \S+ 命中：peekaboo；echo a b a b/);
    assert.ok(!text.includes('abcdefghijklmnop1234567890'));
    assert.match(text, /Bearer \[已遮蔽\]/);
    assert.ok(!/sk-A{1,10}/.test(text) || !text.includes('sk-AAAAAAAAAA'));
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('⑨ 真跑 jq：会话记录里有形状不对的行（message 是字符串、content 里有字符串元素、整行是数字、assistant 但没有 message），只跳过坏行，其余命令照样读到、总数照报', { skip: !HAS_JQ }, async () => {
  const fx = mkFixture(['main']);
  try {
    putSession(fx, 'main', [
      execTool(1, 'echo 好1'),
      { type: 'assistant', timestamp: T(2), message: 'oops' },
      { type: 'assistant', timestamp: T(3), message: { content: ['一段字符串', { type: 'tool_use', name: 'Bash', input: { command: 'echo 好2' } }] } },
      '123',
      '"一整行字符串"',
      '[1,2]',
      { type: 'assistant', timestamp: T(4) },
      { type: 'assistant', timestamp: T(5), message: { content: 'abc' } },
      { type: 'assistant', timestamp: T(6), message: { content: [{ type: 'tool_use', name: 'Bash', input: 7 }] } },
      execTool(7, 'echo 好3'),
    ]);
    writeFileSync(join(fx.fix, 'audit-main.out'), JSON.stringify({ events: [1, 2, 3].map(() => auditEv('exec', 'finished')) }));
    const { text } = await runReal(fx);
    assert.ok(!text.includes('没读到'), '坏行不能让整个角色变成没读到');
    assert.match(rowOf(text, 'main'), /\| main \| 3 \| 3 \| 对得上 \|/);
    for (const k of ['好1', '好2', '好3']) assert.ok(text.includes(`echo ${k}`), `${k} 要读到`);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

// ---------- API 通路不拿去和命令行会话记录对账，单列 ----------
// 官方记录里的 exec 分两类：①命令行通路（会话正文在 ~/.claude/projects，照旧对账）②API 通路（运行方式 openclaw：整个角色走 API，或定时任务模型走 API；会话正文不在那里，单列、不判"记录不足"）。
const audA = (r, total, known, n, api) => `=====AUDIT ${r} arr=1 total=${total} known=${known} n=${n} api=${api}`;

test('⑩ API 通路：官方有数、会话记录天然是 0，不判"记录不足"，单列一行"官方 N 条，API 通路，明细见下面“读事件库的 API 通路命令”一节"', async () => {
  const out = '=====BEGIN\n' + roleBlock('main', [], 0, audA('main', 4, 4, 2, 2)) + roleBlock('worker-x', [], 0, audA('worker-x', 0, 0, 0, 0)) + '=====END\n';
  const { written } = await runFake(out);
  assert.match(rowOf(written, 'main'), /\| main \| 0 \| 0 \| 本轮没有命令行调用（API 通路另列 2 条） \|/);
  assert.ok(!rowOf(written, 'main').includes('记录不足'));
  const apiSec = written.split('## API 通路')[1].split('## 命中关键字')[0];
  assert.match(apiSec, /^- main：官方 2 条，API 通路，明细见下面“读事件库的 API 通路命令”一节$/m);
  assert.ok(!apiSec.includes('worker-x'));
});

test('⑪ 混合：同一角色既有命令行会话又有 API 通路的 exec，命令行部分照旧对账，API 部分另列', async () => {
  const out = '=====BEGIN\n' + roleBlock('main', [cmdLine(1), cmdLine(2)], 2, audA('main', 20, 20, 41, 39 > 41 ? 0 : 39)) + roleBlock('worker-x', [cmdLine(3)], 1, audA('worker-x', 2, 2, 1, 0)) + '=====END\n';
  const { written } = await runFake(out);
  assert.match(rowOf(written, 'main'), /\| main \| 2 \| 2 \| 对得上（API 通路另列 39 条） \|/); // 官方 41 条里 39 条是 API，命令行 2 条＝会话 2 条
  assert.match(written.split('## API 通路')[1].split('## 命中关键字')[0], /- main：官方 39 条，API 通路，明细见下面“读事件库的 API 通路命令”一节/);
  assert.match(rowOf(written, 'worker-x'), /\| worker-x \| 1 \| 1 \| 对得上 \|/);
});

test('⑫ 命令行通路的真缺口不被 API 单列盖住：官方命令行部分和会话记录对不上照样"记录不足"；没有 api= 的旧格式照旧', async () => {
  const out = '=====BEGIN\n' + roleBlock('main', [cmdLine(1)], 1, audA('main', 20, 20, 10, 3)) + roleBlock('worker-x', [], 0, aud('worker-x', 2, 2, 2)) + '=====END\n';
  const { written } = await runFake(out);
  assert.match(rowOf(written, 'main'), /\| main \| 1 \| 7 \| 记录不足：条数对不上（官方 7、会话记录 1）（API 通路另列 3 条） \|/);
  assert.match(rowOf(written, 'worker-x'), /\| worker-x \| 0 \| 2 \| 记录不足：条数对不上（官方 2、会话记录 0） \|/); // 旧格式、没有 api= → 全按命令行算
  assert.ok(!written.split('## API 通路')[1].split('## 命中关键字')[0].includes('worker-x'));
});

function mkFixtureApi() {
  const dir = mkdtempSync(join(tmpdir(), 'cmd-spot-api-'));
  const proj = join(dir, 'proj'), claude = join(dir, 'claude'), data = join(dir, 'data'), fix = join(dir, 'fix'), bin = join(dir, 'bin');
  for (const d of [proj, claude, join(data, '审计/日审'), fix, bin]) mkdirSync(d, { recursive: true });
  const ws = (r) => (r === 'main' ? `${proj}/runtime/main` : `${proj}/runtime/${r}`);
  const rt = { agentRuntime: { id: 'openclaw' } };
  const cfg = {
    agents: {
      defaults: { models: { 'anthropic-standby-b/claude-opus-5-5': rt, 'anthropic-api/claude-opus-5-5': rt, 'anthropic/claude-opus-5-5': { agentRuntime: { id: 'claude-cli' } } } },
      entries: {
        main: { workspace: ws('main'), model: { primary: 'anthropic/claude-opus-5-5', fallbacks: [] } },
        'standby-a': { workspace: ws('standby-a'), model: { primary: 'anthropic-standby-a/claude-fable-5-2@某档案', fallbacks: [] }, models: { 'anthropic-standby-a/claude-fable-5-2': rt } },
        'standby-b': { workspace: ws('standby-b'), model: 'anthropic-standby-b/claude-opus-5-5' },
        'worker-y': { workspace: ws('worker-y') },
      },
    },
  };
  writeFileSync(join(dir, 'openclaw.json'), JSON.stringify(cfg));
  const cron = { jobs: [
    { id: '11111111-aaaa-4bbb-8ccc-000000000001', agentId: 'main', payload: { kind: 'agentTurn', model: 'anthropic-api/claude-opus-5-5' } }, // API 任务
    { id: '22222222-aaaa-4bbb-8ccc-000000000002', agentId: 'main', payload: { kind: 'agentTurn', model: 'sonnet' } }, // 别名＝命令行
    { id: '33333333-aaaa-4bbb-8ccc-000000000003', agentId: 'main', payload: { kind: 'command' } }, // 不是 agentTurn
  ] };
  writeFileSync(join(fix, 'cron.out'), '[plugins] 一行杂音\n' + JSON.stringify(cron, null, 1) + '\n');
  writeFileSync(join(bin, 'openclaw'), `#!/bin/bash\nif [ "$1" = "cron" ]; then cat "${fix}/cron.out"; exit 0; fi\nwhile [ $# -gt 0 ]; do [ "$1" = "--agent" ] && a="$2"; shift; done\n[ -f "${fix}/audit-$a.out" ] && cat "${fix}/audit-$a.out"\nexit 0\n`);
  chmodSync(join(bin, 'openclaw'), 0o755);
  return { dir, proj, claude, data, fix, bin, cfgFile: join(dir, 'openclaw.json'), ws };
}

test('⑬ 真跑：按配置和定时任务判通路——角色走 openclaw、任务模型走 openclaw 的 exec 单列，命令行部分对账，真缺口照报', { skip: !HAS_JQ }, async () => {
  const fx = mkFixtureApi();
  try {
    const ev = (n, sessionKey) => Array.from({ length: n }, () => ({ toolName: 'exec', action: 'tool.action.finished', sessionKey }));
    // main：命令行会话 2 条 ＋ 命令行定时任务（别名 sonnet）1 条 ＝ 命令行 3 条；API 定时任务 3 条
    const sess = [execTool(1, 'ls'), execTool(2, 'pwd'), execTool(3, 'date')];
    putSession(fx, 'main', sess);
    writeFileSync(join(fx.fix, 'audit-main.out'), JSON.stringify({ events: [...ev(2, 'agent:main:discord:channel:1'), ...ev(1, 'agent:main:cron:22222222-aaaa-4bbb-8ccc-000000000002:run:x'), ...ev(3, 'agent:main:cron:11111111-aaaa-4bbb-8ccc-000000000001:run:y'), { toolName: 'read', action: 'tool.action.finished', sessionKey: 'agent:main:discord:channel:1' }] }));
    writeFileSync(join(fx.fix, 'audit-standby-a.out'), JSON.stringify({ events: ev(1, 'agent:standby-a:discord:channel:2') })); // 整个角色走 API（entries.models 里写了 openclaw，主模型带 @档案名）
    writeFileSync(join(fx.fix, 'audit-standby-b.out'), JSON.stringify({ events: ev(2, 'agent:standby-b:discord:channel:3') })); // 整个角色走 API（defaults.models 里写了 openclaw，主模型是字符串）
    writeFileSync(join(fx.fix, 'audit-worker-y.out'), JSON.stringify({ events: ev(2, 'agent:worker-y:discord:channel:4') })); // 命令行角色，会话记录是 0 → 真缺口
    const { text } = await runReal(fx);
    assert.match(rowOf(text, 'main'), /\| main \| 3 \| 3 \| 对得上（API 通路另列 3 条） \|/);
    assert.match(rowOf(text, 'standby-a'), /\| standby-a \| 0 \| 0 \| 本轮没有命令行调用（API 通路另列 1 条） \|/);
    assert.match(rowOf(text, 'standby-b'), /\| standby-b \| 0 \| 0 \| 本轮没有命令行调用（API 通路另列 2 条） \|/);
    assert.match(rowOf(text, 'worker-y'), /\| worker-y \| 0 \| 2 \| 记录不足：条数对不上（官方 2、会话记录 0） \|/);
    const apiSec = text.split('## API 通路')[1].split('## 命中关键字')[0];
    assert.match(apiSec, /^- main：官方 3 条，API 通路，明细见下面“读事件库的 API 通路命令”一节$/m);
    assert.match(apiSec, /^- standby-a：官方 1 条，API 通路，明细见下面“读事件库的 API 通路命令”一节$/m);
    assert.match(apiSec, /^- standby-b：官方 2 条，API 通路，明细见下面“读事件库的 API 通路命令”一节$/m);
    assert.ok(!apiSec.includes('worker-y'));
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('⑭ 真跑：读不到定时任务清单或型号名单时，退回"都按命令行算"（不会多算 API，也不崩）', { skip: !HAS_JQ }, async () => {
  const fx = mkFixtureApi();
  try {
    writeFileSync(join(fx.fix, 'cron.out'), '读不了\n'); // 清单不是 JSON
    putSession(fx, 'main', [execTool(1, 'ls')]);
    writeFileSync(join(fx.fix, 'audit-main.out'), JSON.stringify({ events: [{ toolName: 'exec', action: 'tool.action.finished', sessionKey: 'agent:main:cron:11111111-aaaa-4bbb-8ccc-000000000001:run:y' }] }));
    const { text } = await runReal(fx);
    assert.match(rowOf(text, 'main'), /\| main \| 1 \| 1 \| 对得上 \|/); // 清单读不到 → 这条被当作命令行，条数 1＝1
    assert.ok(!rowOf(text, 'main').includes('API 通路另列'));
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('⑭ 文件对账并进写文件那次 exec：调用次数 4；命令里带 scan 和对应表；成功/失败各自在消息里报', async () => {
  const out = '=====BEGIN\n' + roleBlock('main', [cmdLine(1)], 1, aud('main', 1, 1, 1)) + '=====END\n';
  for (const [agg, expect] of [['WROTE\nSCANOK\n', '文件对账=已生成'], ['WROTE\nSCANFAIL\n', '文件对账=没生成']]) {
    let writeCmd = null; let n = 0;
    const { result, calls } = await runScript(SRC.replace(/const DATA_ROOT = "[^"]*";/, 'const DATA_ROOT = "/tmp/不会写到这里";'), async ({ command }) => {
      n += 1;
      if (command.includes('=====ROUNDS')) return { isError: false, aggregated: cfgOut };
      if (command.includes('base64')) { writeCmd = command; return { isError: false, aggregated: agg }; }
      return { isError: false, aggregated: out };
    });
    assert.equal(calls.length, 4, '起工具调用次数是 4（读配置、读会话、读桌面角色＋API 通路事件库、写文件＋对账），仍在官方预算 5 次内');
    assert.match(writeCmd, /project-files\.mjs' scan --date 2026-11-12 --out '\/tmp\/不会写到这里\/审计\/日审\/2026-11-12-文件对账\.md' --workspaces "\$WS"/);
    assert.match(writeCmd, /'\/usr\/local\/bin\/node'/);
    assert.match(writeCmd, /jq -r '\.agents\.entries \| to_entries \| map\("\\\(\.key\)=\\\(\.value\.workspace\)"\) \| join\(","\)'/);
    assert.ok(result.fire === true && result.message.includes(expect), result.message);
    assert.ok(result.message.includes('命令抽查文件='), '命令抽查文件写出的消息还在');
  }
});
test('⑭b 文件对账失败时，命令抽查文件照样算写出（WROTE 在、SCANFAIL）', async () => {
  const out = '=====BEGIN\n' + roleBlock('main', [cmdLine(1)], 1, aud('main', 1, 1, 1)) + '=====END\n';
  const { result } = await runScript(SRC.replace(/const DATA_ROOT = "[^"]*";/, 'const DATA_ROOT = "/tmp/不会写到这里";'), async ({ command }) => {
    if (command.includes('=====ROUNDS')) return { isError: false, aggregated: cfgOut };
    if (command.includes('base64')) return { isError: false, aggregated: 'WROTE\nSCANFAIL\n' };
    return { isError: false, aggregated: out };
  });
  assert.ok(!result.message.includes('没能写出'));
});
test('⑭c 真跑：把脚本发出的那条写文件＋对账命令在 bash 里执行（数据根换成临时目录），命令抽查文件和文件对账文件都写出来', { skip: !HAS_JQ }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'trig-'));
  const data = join(root, '资料'); mkdirSync(join(data, '审计', '日审'), { recursive: true }); mkdirSync(join(data, '项目'), { recursive: true });
  writeFileSync(join(data, 'INDEX.md'), '| 项目 | Discord 频道 | 主责 bot | 当前入口 | 主档 |\n| --- | --- | --- | --- | --- |\n');
  const cfg = join(root, 'openclaw.json');
  writeFileSync(cfg, JSON.stringify({ agents: { entries: { main: { workspace: `${PR}/runtime/main` } } } }));
  let cmd = null;
  const out = '=====BEGIN\n' + roleBlock('main', [cmdLine(1)], 1, aud('main', 1, 1, 1)) + '=====END\n';
  const src = srcWith({ DATA_ROOT: data, CONFIG_FILE: cfg, NODE_BIN: process.execPath, PROJECT_ROOT: ROOT });
  await runScript(src, async ({ command }) => {
    if (command.includes('=====ROUNDS')) return { isError: false, aggregated: cfgOut };
    if (command.includes('base64')) { cmd = command; return { isError: false, aggregated: 'WROTE\n' }; }
    return { isError: false, aggregated: out };
  });
  const r = execFileSync('/bin/bash', ['-c', cmd], { encoding: 'utf8' });
  assert.match(r, /WROTE/); assert.match(r, /SCANOK/);
  const text = readFileSync(join(data, '审计', '日审', '2026-11-12-文件对账.md'), 'utf8');
  assert.match(text, /^# 文件对账\n业务日期：2026-11-12\n文件对账：新增 0、满 3 天 0、存量 \d+/);
  assert.ok(readFileSync(join(data, '审计', '日审', '2026-11-12-命令抽查.md'), 'utf8').includes('# 命令抽查'));
});

function mkFixtureExtra() {
  const fx = mkFixtureApi();
  const cfg = JSON.parse(readFileSync(fx.cfgFile, 'utf8'));
  cfg.agents.entries.desktop = { workspace: `${fx.proj}/runtime/desktop`, model: 'anthropic/claude-opus-5-5' };
  cfg.agents.entries['system-auditor'] = { workspace: `${fx.proj}/runtime/system-auditor`, model: 'anthropic/claude-opus-5-5' };
  writeFileSync(fx.cfgFile, JSON.stringify(cfg));
  const cron = JSON.parse(readFileSync(join(fx.fix, 'cron.out'), 'utf8').split('\n').slice(1).join('\n'));
  cron.jobs.push({ id: '44444444-aaaa-4bbb-8ccc-000000000004', agentId: 'system-auditor', payload: { kind: 'agentTurn', model: 'anthropic-api/claude-opus-5-5' } });
  writeFileSync(join(fx.fix, 'cron.out'), JSON.stringify(cron));
  fx.agents = join(fx.dir, 'agents'); mkdirSync(fx.agents, { recursive: true });
  return fx;
}
const SCHEMA = 'create table session_windows(session_id text primary key, session_key text); create table transcript_events(session_id text, seq integer, event_json text, created_at integer, event_zstd blob, message_role text, primary key(session_id, seq));';
function mkDb(fx, role, sessions, events) {
  const d = join(fx.agents, role, 'agent'); mkdirSync(d, { recursive: true });
  const f = join(d, 'openclaw-agent.sqlite');
  const sql = [SCHEMA, ...sessions.map(([id, key]) => `insert into session_windows values('${id}','${key}');`)];
  let seq = 0;
  for (const [sid, i, cmd, role2 = 'assistant', raw = null] of events) {
    seq += 1;
    const body = raw ?? JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'toolCall', name: 'exec', arguments: { command: cmd } }] } });
    sql.push(cmd === null && raw === null ? `insert into transcript_events(session_id,seq,event_json,created_at,event_zstd,message_role) values('${sid}',${seq},NULL,${Date.parse(T(i))},x'28b52ffd','${role2}');` : `insert into transcript_events(session_id,seq,event_json,created_at,message_role) values('${sid}',${seq},'${body.replace(/'/g, "''")}',${Date.parse(T(i))},'${role2}');`);
  }
  execFileSync('/usr/bin/sqlite3', [f, sql.join('\n')]);
}
async function runExtra(fx) {
  const src = srcWith({ DATA_ROOT: fx.data, PROJECT_ROOT: fx.proj, WORKSPACE_ROOT: `${fx.proj}/runtime`, CLAUDE_ROOT: fx.claude, CONFIG_FILE: fx.cfgFile, AGENTS_ROOT: fx.agents });
  const { result, calls } = await runScript(src, ({ command }) => new Promise((res) => {
    execFile('/bin/bash', ['-c', command], { maxBuffer: 1 << 26, env: { ...process.env, PATH: `${fx.bin}:${process.env.PATH}` } }, (err, stdout) => res({ isError: false, aggregated: String(stdout) }));
  }));
  const f = join(fx.data, '审计/日审'); const name = readdirSync(f).find((x) => x.endsWith('-命令抽查.md'));
  return { result, calls, text: readFileSync(join(f, name), 'utf8') };
}
let HAS_SQLITE = true; try { execFileSync('/usr/bin/sqlite3', ['--version']); } catch { HAS_SQLITE = false; }

test('⑮ 真跑：桌面角色命令全部列出，命中动屏幕关键字标 ⚠ 并进"命中关键字"，白名单命令不标，其余只作线索', { skip: !HAS_JQ }, async () => {
  const fx = mkFixtureExtra();
  try {
    putSession(fx, 'desktop', [
      execTool(1, 'node scripts/desktop-lock.mjs release --thread 123', 'mcp__openclaw__exec'),
      execTool(2, 'osascript -e "tell application \\"Finder\\" to activate"', 'mcp__openclaw__exec'),
      execTool(3, 'curl https://example.com', 'mcp__openclaw__exec'),
      execTool(4, 'ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked', 'mcp__openclaw__exec'),
      execTool(5, 'date', 'mcp__openclaw__exec'),
      execTool(6, 'cat runtime/desktop/notes.md', 'mcp__openclaw__exec'),
    ]);
    const { text, result, calls } = await runExtra(fx); 
    const desk = text.split('## 桌面角色（desktop）的命令')[1].split('## 读事件库的 API 通路命令')[0];
    assert.match(desk, /共 6 条/);
    assert.match(desk.split('### ⚠')[1].split('### 非白名单')[0], /⚠ 疑似用命令行动屏幕：命中 osascript、tell application/);
    const nonWl = desk.split('### 非白名单（线索）')[1].split('### 全部')[0];
    assert.match(nonWl, /curl https:\/\/example\.com/);
    assert.ok(!nonWl.includes('desktop-lock') && !nonWl.includes('ioreg') && !nonWl.includes('date') && !nonWl.includes('cat runtime/desktop'), nonWl);
    assert.match(text.split('## 命中关键字')[1].split('## 全部命令')[0], /^- desktop \S+ ⚠命中：osascript、tell application；/m);
    assert.equal(calls.length, 4);
    assert.match(result.message, /桌面角色命令 6 条，⚠ 1 条/);
    // 上面对账表里仍没有 desktop／system-auditor 行
    assert.ok(!rowOf(text, 'desktop') && !rowOf(text, 'system-auditor'));
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('⑯ 真跑事件库：roleApi 的角色读全部会话；只有定时任务走 API 的角色（main、system-auditor）只读 cron 会话；窗口外、非助手、坏 JSON、压缩行不乱', { skip: !HAS_JQ || !HAS_SQLITE }, async () => {
  const fx = mkFixtureExtra();
  try {
    // standby-a（roleApi）：整库都读；130 条里 1 条命中 screencapture（第 120 条），正文只带 100 条＋命中的
    const kEvents = Array.from({ length: 130 }, (_, i) => ['k1', i, i === 120 ? 'screencapture -x /tmp/a.png' : `echo ${i}`]);
    kEvents.push(['k1', -100000, 'echo 窗口外'], ['k1', 5, 'echo 用户消息', 'user'], ['k1', 6, null, 'assistant'] /* 压缩行 */, ['k1', 7, null, 'assistant', 'not json at all']);
    mkDb(fx, 'standby-a', [['k1', 'agent:standby-a:discord:channel:1']], kEvents);
    // main（订阅主会话＋API 定时任务 1111）：只取 cron:1111 的会话，discord 会话的命令不能出现
    mkDb(fx, 'main', [['m1', 'agent:main:cron:11111111-aaaa-4bbb-8ccc-000000000001'], ['m2', 'agent:main:discord:channel:9'], ['m3', 'agent:main:cron:22222222-aaaa-4bbb-8ccc-000000000002']],
      [['m1', 10, 'ls cron-api'], ['m2', 11, 'echo 订阅会话不该出现'], ['m3', 12, 'echo 命令行任务不该出现']]);
    // system-auditor（只有定时任务 4444 走 API）
    mkDb(fx, 'system-auditor', [['a1', 'agent:system-auditor:cron:44444444-aaaa-4bbb-8ccc-000000000004:run:x']], [['a1', 20, 'python3 publish-self.py --token=abcdef123456789']]);
    const { text, result } = await runExtra(fx);
    const api = text.split('## 读事件库的 API 通路命令')[1];
    const sec = (r) => api.split(`### ${r}\n`)[1].split('\n### ')[0];
    assert.match(sec('standby-a'), /窗口内命令 130 条/); // 130 条；坏 JSON、用户消息、窗口外都不算；压缩行单独计
    assert.match(sec('standby-a'), /另有 1 条消息压缩存放，没抽查到/);
    assert.match(sec('standby-a'), /命中：screencapture；screencapture -x/);
    const kLines = sec('standby-a').split('\n').filter((l) => l.startsWith('- standby-a'));
    assert.equal(kLines.length, 101); // 前 100 条＋第 120 条命中
    assert.match(sec('main'), /窗口内命令 1 条/); assert.match(sec('main'), /ls cron-api/);
    assert.ok(!api.includes('订阅会话不该出现') && !api.includes('命令行任务不该出现'));
    assert.match(sec('system-auditor'), /窗口内命令 1 条/); assert.match(sec('system-auditor'), /publish-self\.py/);
    assert.ok(!api.includes('abcdef123456789'), '密钥要遮蔽');
    assert.match(text.split('## 命中关键字')[1].split('## 全部命令')[0], /- standby-a \S+ 命中：screencapture；.*（API 通路）/);
    assert.match(result.message, /API 通路事件库 main:1、standby-a:130、standby-b:没读、system-auditor:1/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('⑰ 事件库缺失／损坏／第 3 次读取失败：只那一段写"记录不足"，其余照常，不崩', { skip: !HAS_JQ || !HAS_SQLITE }, async () => {
  const fx = mkFixtureExtra();
  try {
    mkdirSync(join(fx.agents, 'main/agent'), { recursive: true }); writeFileSync(join(fx.agents, 'main/agent/openclaw-agent.sqlite'), 'this is not a database');
    const { text } = await runExtra(fx);
    const api = text.split('## 读事件库的 API 通路命令')[1];
    assert.match(api.split('### main\n')[1].split('\n### ')[0], /记录不足：事件库读取出错/);
    assert.match(api.split('### standby-a\n')[1].split('\n### ')[0], /记录不足：找不到它的事件库文件/);
    assert.ok(text.includes('## 条数对账'));
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
  // 第 3 次读取返回空
  let n = 0;
  const { result } = await runScript(SRC.replace(/const DATA_ROOT = "[^"]*";/, 'const DATA_ROOT = "/tmp/不会写到这里";'), async ({ command }) => {
    n += 1;
    if (command.includes('=====ROUNDS')) return { isError: false, aggregated: cfgOut };
    if (command.includes('base64')) return { isError: false, aggregated: 'WROTE\n' };
    if (command.includes('=====EXTRA_BEGIN')) return { isError: true, aggregated: '' };
    return { isError: false, aggregated: '=====BEGIN\n' + roleBlock('main', [cmdLine(1)], 1, aud('main', 1, 1, 1)) + '=====END\n' };
  });
  assert.match(result.message, /桌面角色／API 通路命令：记录不足/);
  assert.equal(n, 4);
});

test('⑱ 关键字不分大小写（桌面角色 "SYSTEM EVENTS"）；事件库 content 数组里夹纯字符串元素也不让该角色整段报错', { skip: !HAS_JQ || !HAS_SQLITE }, async () => {
  const fx = mkFixtureExtra();
  try {
    putSession(fx, 'desktop', [execTool(1, 'echo "SYSTEM EVENTS click"', 'mcp__openclaw__exec'), execTool(2, 'TELL APPLICATION "x"', 'mcp__openclaw__exec')]);
    const mixed = JSON.stringify({ type: 'message', message: { role: 'assistant', content: ['纯字符串元素', { type: 'toolCall', name: 'exec', arguments: { command: 'ls mixed-ok' } }, 42] } });
    mkDb(fx, 'standby-a', [['k1', 'agent:standby-a:discord:channel:1']], [['k1', 1, null, 'assistant', mixed], ['k1', 2, 'SCREENCAPTURE -x a.png']]);
    const { text } = await runExtra(fx);
    const desk = text.split('## 桌面角色（desktop）的命令')[1].split('## 读事件库')[0];
    assert.match(desk, /⚠ 疑似用命令行动屏幕：命中 System Events/); assert.match(desk, /命中 tell application/);
    const k = text.split('### standby-a\n')[1].split('\n### ')[0];
    assert.match(k, /窗口内命令 2 条/); assert.match(k, /ls mixed-ok/); assert.match(k, /命中：screencapture/);
    assert.ok(!k.includes('记录不足'));
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});
