// Offline tests for sensitive click: temporary directories and fake data only; nothing touches a real deployment.
// 程序认出“提交类点击”＋命令行动屏幕的硬挡。全部用临时目录，不碰真锁、不碰屏幕。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createScreenGate, createDesktopExecGuard, readLock, holdForConfirmation, registerDesktopScreenLock,
} from '../plugins/personal-inbox/desktop-lock.mjs';
import { fileURLToPath } from 'node:url';
import { invalidateObservations, MAX_RESULT_TEXT } from '../plugins/personal-inbox/sensitive-click.mjs';
import { isInvalidatingAction, NON_INVALIDATING_ACTIONS, isCleanupAction, failedShapeOf } from '../plugins/personal-inbox/desktop-lock.mjs';
import { loadWords, recordObservation, loadObservations, classifyCall, extractObservation, shapeOf, wordsPathFromLock, isEnterKey, describeDiagnostics, OBSERVATION_TTL_MS } from '../plugins/personal-inbox/sensitive-click.mjs';

import { SENSITIVE_WORDS_EN } from '../plugins/personal-inbox/lexicon.mjs';
import { crew } from '../plugins/personal-inbox/crew-config.mjs';
const T0 = 1_800_000_000_000;
const A = 'agent:desktop:discord:channel:100000000000000145';
const THREAD_A = '100000000000000145';
const WORDS = fileURLToPath(new URL('../plugins/personal-inbox/sensitive-words.json', import.meta.url));
const cfg = loadWords(WORDS);

const result = (elements, extra = {}) => ({ observation: { observationId: 'obs-1', elements, ...extra } });
const els = [
  { elementRef: 'e1', role: 'AXButton', label: '提交', bounds: { x: 100, y: 100, width: 80, height: 30 } },
  { elementRef: 'e2', role: 'AXButton', label: '取消', bounds: { x: 200, y: 100, width: 80, height: 30 } },
  { elementRef: 'e3', role: 'AXStaticText', label: '点这里删除所有东西的说明文字', bounds: { x: 0, y: 200, width: 400, height: 40 } },
  { elementRef: 'e4', role: 'AXMenuItem', label: '发 送', bounds: { x: 0, y: 300, width: 100, height: 20 } },
  { elementRef: 'e5', role: 'AXGroup', label: '大容器', bounds: { x: 90, y: 90, width: 300, height: 100 } },
  { elementRef: 'e6', role: 'AXButton', label: 'Sender settings', bounds: { x: 0, y: 400, width: 100, height: 20 } },
  { elementRef: 'e7', role: 'AXButton', label: 'Submit Order', bounds: { x: 0, y: 500, width: 100, height: 20 } },
  { elementRef: 'e8', role: 'AXTextField', label: '搜索', value: '我的密码是abc', bounds: { x: 0, y: 600, width: 100, height: 20 } },
];

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'sensitive-click-test-'));
  writeFileSync(join(dir, 'screen-queue-settings.json'), JSON.stringify({ holdMinutes: 15, confirmMinutes: 5, maxNotifyAttempts: 3, paused: false }));
  return { dir, lockPath: join(dir, 'screen.lock'), obsPath: join(dir, 'ui-elements.json'), logPath: join(dir, 'gate.log'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const logs = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const observe = (obsPath, now = T0, e = els, extra) => recordObservation({ path: obsPath, threadId: THREAD_A, result: result(e, extra), now, cfg });

// ───── 纯判断 ─────
test('按钮「提交」命中；「取消」不命中；段落文字里有“删除”不命中', () => {
  const { obsPath, cleanup } = fresh();
  try {
    observe(obsPath);
    const obs = loadObservations({ path: obsPath, threadId: THREAD_A, now: T0 });
    const c = (params) => classifyCall({ toolName: 'computer', params, observations: obs, cfg, now: T0 });
    assert.equal(c({ action: 'left_click', elementRef: 'e1' }).hit, true);
    assert.equal(c({ action: 'left_click', elementRef: 'e2' }).hit, false);
    assert.equal(c({ action: 'left_click', elementRef: 'e3' }).hit, false); // 角色不是按钮
    assert.equal(c({ action: 'double_click', elementRef: 'e4' }).hit, true); // 去掉空格后“发送”
    assert.equal(c({ action: 'left_click', elementRef: 'e7' }).hit, true); // 英文不分大小写
    assert.equal(c({ action: 'left_click', elementRef: 'e6' }).hit, false); // sender 排除词
    assert.equal(c({ action: 'left_click', elementRef: 'e8' }).hit, false);
  } finally { cleanup(); }
});

test('只有坐标：找包含该点的最小一格；两格重叠取小的；不在任何格里算认不出', () => {
  const { obsPath, cleanup } = fresh();
  try {
    observe(obsPath);
    const obs = loadObservations({ path: obsPath, threadId: THREAD_A, now: T0 });
    // 退回甲：按坐标反查默认关闭（还没有截图坐标↔屏幕点的换算）；下面这些是"打开以后"的逻辑，用 coordinateLookup:true 保留覆盖
    const off = classifyCall({ toolName: 'computer', params: { action: 'left_click', x: 120, y: 110 }, observations: obs, cfg, now: T0 });
    assert.deepEqual(off, { hit: false, unrecognized: true }, '默认一律当认不出放行');
    const c = (params) => classifyCall({ toolName: 'computer', params, observations: obs, cfg, now: T0, coordinateLookup: true });
    assert.equal(c({ action: 'left_click', x: 120, y: 110 }).hit, true); // 在“提交”里，也在大容器里 → 取小的
    assert.equal(c({ action: 'left_click', x: 220, y: 110 }).hit, false); // “取消”
    const nowhere = c({ action: 'left_click', x: 5000, y: 5000 });
    assert.equal(nowhere.hit, false); assert.equal(nowhere.unrecognized, true);
    const none = classifyCall({ toolName: 'computer', params: { action: 'left_click', elementRef: 'x9' }, observations: [], cfg, now: T0 });
    assert.equal(none.unrecognized, true); assert.equal(none.hit, false);
  } finally { cleanup(); }
});

test('观察过期不再用；只留最近 3 次；状态文件里没有 value 和截图', () => {
  const { obsPath, cleanup } = fresh();
  try {
    observe(obsPath, T0);
    assert.equal(loadObservations({ path: obsPath, threadId: THREAD_A, now: T0 + OBSERVATION_TTL_MS + 1 }).length, 0);
    for (let i = 1; i <= 4; i += 1) observe(obsPath, T0 + i, els, { observationId: `o${i}` });
    const obs = loadObservations({ path: obsPath, threadId: THREAD_A, now: T0 + 10 });
    assert.deepEqual(obs.map((o) => o.observationId), ['o2', 'o3', 'o4']);
    const raw = readFileSync(obsPath, 'utf8');
    assert.ok(!raw.includes('我的密码是abc'), '输入框里的字不能进状态文件');
  } finally { cleanup(); }
});

test('菜单、Return 键、上传、确认框', () => {
  const { obsPath, cleanup } = fresh();
  try {
    observe(obsPath);
    const obs = loadObservations({ path: obsPath, threadId: THREAD_A, now: T0 });
    const c = (params, now = T0) => classifyCall({ toolName: 'computer', params, observations: obs, cfg, now });
    assert.equal(c({ action: 'invoke_menu', path: ['文件', '发送'] }).hit, true);
    assert.equal(c({ action: 'invoke_menu', path: ['文件', '关闭窗口'] }).hit, false);
    assert.equal(c({ action: 'key', keys: 'Return' }).hit, true); // 屏幕上有“提交”按钮
    assert.equal(c({ action: 'key', keys: 'Return' }, T0 + 61_000).hit, false); // 观察超过 60 秒
    assert.equal(c({ action: 'key', keys: 'space' }).hit, false); // 空格不算
    assert.equal(c({ action: 'key', keys: 'cmd+w' }).hit, false);
    assert.equal(c({ action: 'browser_set_input_files' }).always, true);
    assert.equal(c({ action: 'browser_dialog', accept: true }).hit, true);
    assert.equal(c({ action: 'browser_dialog', accept: false }).hit, false);
    assert.equal(c({ action: 'screenshot' }).hit, false);
    const noButtons = classifyCall({ toolName: 'computer', params: { action: 'key', keys: 'Return' }, observations: [{ at: T0, observationId: 'z', elements: { a: { role: 'AXButton', label: '取消', bounds: null } } }], cfg, now: T0 });
    assert.equal(noButtons.hit, false);
  } finally { cleanup(); }
});

test('结果套了一层（details／content 里的 JSON 文字）也找得到；找不到就记 0 格不报错', () => {
  const inner = { observation: { observationId: 'q', elements: [{ elementRef: 'a', role: 'button', label: '支付', bounds: [1, 1, 5, 5] }] } };
  assert.equal(extractObservation({ details: inner }).elements.length, 1);
  assert.equal(extractObservation({ content: [{ type: 'text', text: JSON.stringify(inner) }] }).elements.length, 1);
  assert.equal(extractObservation({ content: [{ type: 'text', text: '没有元素' }] }), null);
  assert.equal(recordObservation({ path: join(tmpdir(), 'nonexist-ui.json'), threadId: 't', result: { ok: true } }), 0);
  assert.deepEqual(shapeOf({ a: 1, b: { c: 'x' } }), { a: 'number', b: { c: 'string' } });
});

// ───── 接进闸门 ─────
function gateWith(ctx0) {
  const gate = createScreenGate({ lockPath: ctx0.lockPath, logPath: ctx0.logPath, now: () => T0, observationPath: ctx0.obsPath, wordsPath: WORDS, guardWaitMs: 200 });
  return (params, toolName = 'computer') => gate({ toolName, params, toolCallId: 'tc' }, { agentId: 'desktop', sessionKey: A });
}

test('闸门：点「提交」→ 出审批卡、锁变“等确认”、说明里有程序提示；点「取消」放行', () => {
  const f = fresh();
  try {
    const gate = gateWith(f);
    assert.equal(gate({ action: 'screenshot' }), undefined); // 拿锁
    observe(f.obsPath);
    assert.equal(gate({ action: 'left_click', elementRef: 'e2' }), undefined);
    assert.equal(readLock(f.lockPath).state, 'working');
    const r = gate({ action: 'left_click', elementRef: 'e1' });
    assert.ok(r?.requireApproval, '要出卡');
    assert.match(r.requireApproval.description, /程序认出/);
    assert.match(r.requireApproval.description, /这一项是程序认出来的/);
    assert.ok([...r.requireApproval.description].length <= 512);
    const lock = readLock(f.lockPath);
    assert.equal(lock.state, 'waiting');
    assert.match(lock.what, /提交/);
    assert.ok(logs(f.logPath).some((l) => l.decision === 'sensitive-detected'));
    // 批准一次：锁回“做事中”，下一次再点又要卡
    r.requireApproval.onResolution('allow-once');
    assert.equal(readLock(f.lockPath).state, 'working');
    assert.ok(gate({ action: 'left_click', elementRef: 'e1' })?.requireApproval);
  } finally { f.cleanup(); }
});

test('闸门：拒绝后进“只许收尾”，再点「提交」不会弹新卡（识别不运行），而是被硬拦', () => {
  const f = fresh();
  try {
    const gate = gateWith(f);
    gate({ action: 'screenshot' });
    observe(f.obsPath);
    const r = gate({ action: 'left_click', elementRef: 'e1' });
    r.requireApproval.onResolution('deny');
    const before = JSON.stringify(readLock(f.lockPath));
    const again = gate({ action: 'left_click', elementRef: 'e1' });
    assert.equal(again.block, true);
    assert.match(again.blockReason, /只能收尾/);
    assert.equal(JSON.stringify(readLock(f.lockPath)), before, '锁不能变');
    assert.ok(logs(f.logPath).filter((l) => l.decision === 'sensitive-detected').length === 1);
  } finally { f.cleanup(); }
});

test('闸门：不是放行（别的线程占着锁）时识别不运行、锁不变', () => {
  const f = fresh();
  try {
    const gateX = createScreenGate({ lockPath: f.lockPath, logPath: f.logPath, now: () => T0, observationPath: f.obsPath, wordsPath: WORDS, guardWaitMs: 200 });
    gateX({ toolName: 'computer', params: { action: 'screenshot' } }, { agentId: 'desktop', sessionKey: 'agent:desktop:discord:channel:100000000000000165' });
    observe(f.obsPath);
    const before = JSON.stringify(readLock(f.lockPath));
    const r = gateWith(f)({ action: 'left_click', elementRef: 'e1' });
    assert.equal(r.block, true);
    assert.ok(!r.requireApproval);
    assert.equal(JSON.stringify(readLock(f.lockPath)), before);
    assert.ok(!logs(f.logPath).some((l) => l.decision === 'sensitive-detected'));
  } finally { f.cleanup(); }
});

test('闸门：同义的 lock.refused 还在时 hold 返回 ok:false → 直接拦下、不出卡、不改锁', () => {
  const f = fresh();
  try {
    const gate = gateWith(f);
    gate({ action: 'screenshot' });
    observe(f.obsPath);
    const first = gate({ action: 'left_click', elementRef: 'e1' });
    first.requireApproval.onResolution('deny'); // 锁里记下 refused，同时线程进“只许收尾”
    // 模拟 24 小时后“只许收尾”标记过期、锁没放：删掉标记文件
    rmSync(join(f.dir, 'refused-threads.json'), { force: true });
    const r = gate({ action: 'left_click', elementRef: 'e1' });
    assert.equal(r.block, true);
    assert.ok(!r.requireApproval);
    assert.match(r.blockReason, /刚被拒绝/);
    assert.equal(readLock(f.lockPath).state, 'working');
    assert.ok(logs(f.logPath).some((l) => l.decision === 'sensitive-hold-refused'));
  } finally { f.cleanup(); }
});

test('闸门：很长的窗口标题和按钮名 → 说明被截断到 512 码点内，而不是整张卡失败', () => {
  const f = fresh();
  try {
    const gate = gateWith(f);
    gate({ action: 'screenshot' });
    observe(f.obsPath, T0, [{ elementRef: 'z', role: 'AXButton', label: `提交${'很长的标签'.repeat(40)}`, bounds: [0, 0, 10, 10] }], { window: { title: '窗口'.repeat(400) } });
    const r = gate({ action: 'left_click', elementRef: 'z' });
    assert.ok(r?.requireApproval);
    assert.ok([...r.requireApproval.description].length <= 512, `长度 ${[...r.requireApproval.description].length}`);
  } finally { f.cleanup(); }
});

test('闸门：认不出的点击放行并记日志；识别开关关掉时和以前一样', () => {
  const f = fresh();
  try {
    const gate = gateWith(f);
    gate({ action: 'screenshot' });
    assert.equal(gate({ action: 'left_click', x: 5, y: 5 }), undefined); // 没有任何观察
    assert.ok(logs(f.logPath).some((l) => l.decision === 'sensitive-unrecognized'));
    observe(f.obsPath);
    const off = createScreenGate({ lockPath: f.lockPath, logPath: f.logPath, now: () => T0, observationPath: f.obsPath, wordsPath: WORDS, guardWaitMs: 200, sensitive: false });
    assert.equal(off({ toolName: 'computer', params: { action: 'left_click', elementRef: 'e1' } }, { agentId: 'desktop', sessionKey: A }), undefined);
  } finally { f.cleanup(); }
});

test('别的 bot 不受影响', () => {
  const f = fresh();
  try {
    observe(f.obsPath);
    const gate = createScreenGate({ lockPath: f.lockPath, logPath: f.logPath, now: () => T0, observationPath: f.obsPath });
    assert.equal(gate({ toolName: 'computer', params: { action: 'left_click', elementRef: 'e1' } }, { agentId: 'worker-c', sessionKey: A }), undefined);
  } finally { f.cleanup(); }
});

test('登记：after_tool_call 记下桌面角色看到的元素表（别的角色、失败的调用不记）', () => {
  const f = fresh();
  try {
    const registered = [];
    registerDesktopScreenLock({ on: (name, handler, options) => registered.push({ name, handler, options }) }, { lockPath: f.lockPath, logPath: f.logPath });
    const rec = registered.find((r) => r.options?.registrationId === 'desktop-observation-record');
    assert.ok(rec);
    rec.handler({ toolName: 'computer', params: { action: 'screenshot' }, result: result(els) }, { agentId: 'worker-c', sessionKey: A });
    assert.equal(existsSync(f.obsPath), false);
    rec.handler({ toolName: 'computer', error: 'boom', result: result(els) }, { agentId: 'desktop', sessionKey: A });
    assert.equal(existsSync(f.obsPath), false);
    rec.handler({ toolName: 'mcp__openclaw__computer', params: { action: 'screenshot' }, result: result(els) }, { agentId: 'desktop', sessionKey: A });
    assert.equal(loadObservations({ path: f.obsPath, threadId: THREAD_A, now: Date.now() }).length, 1);
  } finally { f.cleanup(); }
});

test('命令行动屏幕的硬挡：桌面角色用 osascript 等被挡，合法命令和别的 bot 不受影响', () => {
  const guard = createDesktopExecGuard({});
  const d = (command) => guard({ params: { command } }, { agentId: 'desktop', sessionKey: A });
  assert.equal(d('osascript -e "tell application \\"Finder\\" to activate"').block, true);
  assert.equal(d('cliclick c:100,100').block, true);
  assert.equal(d('/usr/sbin/screencapture -x /tmp/a.png').block, true);
  assert.equal(d('peekaboo see').block, true);
  assert.equal(d('osascript').block, true);
  assert.equal(d('node scripts/desktop-lock.mjs release --thread 123'), undefined);
  assert.equal(d('ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked'), undefined);
  assert.equal(d('system_profiler SPDisplaysDataType'), undefined);
  assert.equal(d('ls workspace'), undefined);
  assert.equal(guard({ params: { command: 'osascript -e x' } }, { agentId: 'worker-c', sessionKey: 'agent:worker-c:main' }), undefined);
  assert.equal(guard({ params: {} }, { agentId: 'desktop' }), undefined);
});

test('登记：exec 硬挡不带 matcher（官方只认规范工具编号，写错会让整个插件注册失败），在处理函数里按工具名过滤，只盯 exec／bash', () => {
  const registered = [];
  registerDesktopScreenLock({ on: (name, handler, options) => registered.push({ name, handler, options }) }, { lockPath: null });
  const g = registered.find((r) => r.options?.registrationId === 'desktop-exec-screen-block');
  assert.ok(g);
  assert.equal(g.options.matcher, undefined);
  const call = (toolName, command) => g.handler({ toolName, params: { command } }, { agentId: 'desktop', sessionKey: 'agent:desktop:main' });
  assert.equal(call('exec', 'osascript -e x').block, true);
  assert.equal(call('mcp__openclaw__exec', 'osascript -e x').block, true);
  assert.equal(call('bash', 'cliclick c:1,1').block, true);
  assert.equal(call('read', 'osascript -e x'), undefined, '不是 exec／bash 的工具不管');
  assert.equal(call('exec', 'ls'), undefined);
});

test('抓形状：有 capture-shape.flag 才记，只记键名和类型，不记值；没有标记文件不写', () => {
  const f = fresh();
  try {
    const registered = [];
    registerDesktopScreenLock({ on: (name, handler, options) => registered.push({ name, handler, options }) }, { lockPath: f.lockPath, logPath: f.logPath });
    const rec = registered.find((r) => r.options?.registrationId === 'desktop-observation-record');
    const ev = { toolName: 'computer', params: { action: 'screenshot' }, result: result([{ elementRef: 'e1', role: 'AXButton', label: '机密按钮文字', bounds: [1, 2, 3, 4] }]) };
    rec.handler(ev, { agentId: 'desktop', sessionKey: A });
    assert.equal(existsSync(join(f.dir, 'shape-capture.jsonl')), false);
    writeFileSync(join(f.dir, 'capture-shape.flag'), '');
    rec.handler(ev, { agentId: 'desktop', sessionKey: A });
    const raw = readFileSync(join(f.dir, 'shape-capture.jsonl'), 'utf8');
    assert.ok(raw.includes('"observation"') && raw.includes('"elementRef":"string"') && raw.includes('paramKeys'));
    assert.ok(!raw.includes('机密按钮文字'), '形状里不能有值');
  } finally { f.cleanup(); }
});

test('browser 工具参数里没有 action：记“未识别”（放行写日志），computer 工具没有 action 照旧不记', () => {
  const obs = [];
  assert.deepEqual(classifyCall({ toolName: 'browser', params: { url: 'x' }, observations: obs, cfg, now: T0 }), { hit: false, unrecognized: true });
  assert.deepEqual(classifyCall({ toolName: 'computer', params: {}, observations: obs, cfg, now: T0 }), { hit: false });
  const f = fresh();
  try {
    const gate = gateWith(f);
    gate({ action: 'screenshot' });
    assert.equal(gate({ url: 'x' }, 'browser'), undefined);
    assert.ok(logs(f.logPath).some((l) => l.decision === 'sensitive-unrecognized' && l.toolName === 'browser'));
  } finally { f.cleanup(); }
});

test('B1 词表位置从锁文件位置拼（<项目根>/plugins/personal-inbox/…），读不到会报出来，不静默失效', () => {
  assert.equal(wordsPathFromLock('/proj/runtime/desktop/screen.lock'), '/proj/plugins/personal-inbox/sensitive-words.json');
  assert.equal(wordsPathFromLock(null), null);
  const f = fresh();
  try {
    // 注册时：词表读不到 → 日志里有 sensitive-words-unreadable，并给官方日志一行警告
    const warns = [], registered = [];
    registerDesktopScreenLock({ on: (name, handler, options) => registered.push({ name, handler, options }), logger: { warn: (m) => warns.push(m) } }, { lockPath: f.lockPath, logPath: f.logPath });
    assert.ok(logs(f.logPath).some((l) => l.decision === 'sensitive-words-unreadable'));
    assert.match(warns[0], /词表读不到/);
    // 运行中：每次读不到都记 sensitive-error，屏幕本身照放行
    const gate = createScreenGate({ lockPath: f.lockPath, logPath: f.logPath, now: () => T0, observationPath: f.obsPath, guardWaitMs: 200 });
    gate({ toolName: 'computer', params: { action: 'screenshot' } }, { agentId: 'desktop', sessionKey: A });
    observe(f.obsPath);
    assert.equal(gate({ toolName: 'computer', params: { action: 'left_click', elementRef: 'e1' } }, { agentId: 'desktop', sessionKey: A }), undefined);
    assert.ok(logs(f.logPath).some((l) => l.decision === 'sensitive-error'));
    // 词表放对位置（<根>/plugins/personal-inbox/）后，注册时不再报
    const root = join(f.dir, 'root'); mkdirSync(join(root, 'plugins/personal-inbox'), { recursive: true }); mkdirSync(join(root, 'runtime/desktop'), { recursive: true });
    writeFileSync(join(root, 'plugins/personal-inbox/sensitive-words.json'), readFileSync(WORDS));
    const lp = join(root, 'runtime/desktop/screen.lock'), lg = join(root, 'runtime/desktop/log');
    const w2 = []; registerDesktopScreenLock({ on() {}, logger: { warn: (m) => w2.push(m) } }, { lockPath: lp, logPath: lg });
    assert.equal(w2.length, 0); assert.equal(existsSync(lg), false);
  } finally { f.cleanup(); }
});

test('B8 回车类：Return／Enter、cmd／ctrl+Return、type 末尾带换行、browser 回车都算；shift／alt+Return、空格不算', () => {
  for (const k of ['Return', 'enter', 'cmd+Return', 'ctrl+enter', 'Command+Enter', 'meta + return']) assert.equal(isEnterKey(k), true, k);
  for (const k of ['shift+Return', 'alt+Return', 'space', 'cmd+w', 'a', '']) assert.equal(isEnterKey(k), false, k);
  const obs = [{ at: T0, observationId: 'o', elements: { a: { role: 'AXButton', label: '发送', bounds: null } } }];
  const c = (toolName, params) => classifyCall({ toolName, params, observations: obs, cfg, now: T0 });
  assert.equal(c('computer', { action: 'key', keys: 'cmd+Return' }).hit, true);
  assert.equal(c('computer', { action: 'key', keys: 'cmd+Return' }).via, 'enter');
  assert.equal(c('computer', { action: 'type', text: '好的，发出去\n' }).hit, true);
  assert.equal(c('computer', { action: 'type', text: '只是打字' }).hit, false);
  assert.equal(c('browser', { action: 'browser_press_key', key: 'Enter' }).hit, true);
  assert.equal(c('browser', { action: 'browser_type', text: 'x', submit: true }).hit, true);
  assert.equal(c('computer', { action: 'key', keys: 'shift+Return' }).hit, false);
  // 屏幕上没有提交类按钮时，回车不拦
  assert.equal(classifyCall({ toolName: 'computer', params: { action: 'key', keys: 'Return' }, observations: [{ at: T0, observationId: 'o', elements: { a: { role: 'AXButton', label: '取消', bounds: null } } }], cfg, now: T0 }).hit, false);
});

test('②-7 browser 工具里不认识的动作记“未识别”，只读动作和已认识的不记', () => {
  const c = (action) => classifyCall({ toolName: 'browser', params: { action }, observations: [], cfg, now: T0 });
  assert.deepEqual(c('act'), { hit: false, unrecognized: true });
  assert.deepEqual(c('browser_fill_form'), { hit: false, unrecognized: true });
  assert.deepEqual(c('snapshot'), { hit: false });
  assert.deepEqual(c('screenshot'), { hit: false });
  assert.equal(classifyCall({ toolName: 'computer', params: { action: 'mystery' }, observations: [], cfg, now: T0 }).unrecognized, undefined, 'computer 工具不受影响');
});

// ───── 只读形状诊断（网页提交按钮补救 第 2 步）─────
const deepResult = (extra = {}) => ({ content: [{ type: 'text', text: '机密正文' }], details: { node: 'n1', action: 'get_accessibility_tree', screenIndex: 0, result: { ok: true, details: { totalElementCount: 1200, elements: [{ role: 'button', label: '机密按钮', identifier: 'abc', bounds: [1, 2, 3, 4], ref: 'e1' }, { role: 'x' }], ...extra } } } });

test('诊断：深度 7 看得到 elements[0] 里面的键名；总数、个数、字节数、耗时都记，值一个不记', () => {
  const d = describeDiagnostics({ toolName: 'computer', params: { action: 'get_accessibility_tree', app: '机密应用名' }, result: deepResult(), durationMs: 1234 }, { tool: 'computer', now: 5 });
  assert.equal(d.at, 5); assert.equal(d.action, 'get_accessibility_tree'); assert.deepEqual(d.paramKeys, ['action', 'app']);
  assert.equal(d.elements.length, 2); assert.equal(d.elements.totalElementCount, 1200);
  assert.deepEqual(d.elements.firstKeys, { role: 'string', label: 'string', identifier: 'string', bounds: 'array', ref: 'string' });
  assert.ok(d.resultBytes > 100); assert.equal(d.durationMs, 1234);
  assert.equal(d.shape.details.result.details.elements[1].role, 'string', 'shapeOf 到第 7 层能看到元素里的键');
  const raw = JSON.stringify(d);
  for (const secret of ['机密正文', '机密按钮', '机密应用名', 'abc', 'e1']) assert.ok(!raw.includes(secret), `诊断里不能有值：${secret}`);
});

test('诊断：没有元素表的结果（截图）也能记形状；没有耗时字段记 null；坏结果不抛错', () => {
  const d = describeDiagnostics({ params: { action: 'screenshot' }, result: { content: [], details: { width: 1200, height: 675, refWidth: 1200, screenIndex: 0, frameId: 'f' } } }, { tool: 'computer' });
  assert.equal(d.elements, undefined); assert.equal(d.durationMs, null); assert.equal(d.shape.details.frameId, 'string');
  const cyc = {}; cyc.self = cyc;
  assert.doesNotThrow(() => describeDiagnostics({ params: {}, result: cyc }, { tool: 'computer' }));
  assert.equal(describeDiagnostics({ result: cyc }, { tool: 'computer' }).resultBytes, null);
  assert.doesNotThrow(() => describeDiagnostics(undefined, { tool: 'computer' }));
});

test('诊断：没有 capture-shape.flag 不写文件；有了才写，并且 recordObservation 的结果和没开时逐字相同', () => {
  const a = fresh(), b = fresh();
  try {
    const mk = (f) => { const reg = []; registerDesktopScreenLock({ on: (n, h, o) => reg.push({ n, h, o }) }, { lockPath: f.lockPath, logPath: f.logPath, wordsPath: WORDS }); return reg.find((r) => r.o?.registrationId === 'desktop-observation-record'); };
    const ra = mk(a), rb = mk(b);
    writeFileSync(join(b.dir, 'capture-shape.flag'), '');
    const ev = { toolName: 'computer', params: { action: 'get_accessibility_tree' }, result: deepResult() };
    const ctx = { agentId: 'desktop', sessionKey: A };
    ra.h(ev, ctx); rb.h(ev, ctx);
    assert.equal(existsSync(join(a.dir, 'shape-capture.jsonl')), false);
    const line = JSON.parse(readFileSync(join(b.dir, 'shape-capture.jsonl'), 'utf8').trim());
    assert.equal(line.elements.totalElementCount, 1200);
    const strip = (p) => { const j = JSON.parse(readFileSync(p, 'utf8')); for (const t of Object.values(j.threads)) for (const o of t.observations) o.at = 0; return JSON.stringify(j); };
    assert.equal(strip(a.obsPath), strip(b.obsPath), '开诊断前后，记下的界面元素表一模一样');
  } finally { a.cleanup(); b.cleanup(); }
});

// ───── 退回甲那一批─────
const realTree = (n, withButtonAtEnd = true) => ({ content: [{ type: 'text', text: 'x' }], details: { node: 'n', action: 'get_accessibility_tree', screenIndex: 0, result: { ok: true, details: { totalElementCount: n + 1, elements: [
  ...Array.from({ length: n }, (_, i) => ({ value: '正文' + i, role: i % 2 ? 'other' : 'group', label: '机密正文文字' + i, bounds: { x: 0, y: i, width: 10, height: 10 } })),
  ...(withButtonAtEnd ? [{ value: '', role: 'button', label: '提交', bounds: { x: 5, y: 9000, width: 80, height: 30 } }, { value: '', role: 'button', label: '普通按钮机密名', bounds: { x: 100, y: 9000, width: 80, height: 30 } }] : []),
] } } } });

test('先过滤再截：3000 个格里"提交"排在最后也不会被前面的正文挤掉；被过滤的数记下来', () => {
  const { obsPath, cleanup } = fresh();
  try {
    const n = recordObservation({ path: obsPath, threadId: THREAD_A, result: realTree(3000), now: T0, cfg });
    assert.equal(n, 2, '只剩两个按钮');
    const [o] = loadObservations({ path: obsPath, threadId: THREAD_A, now: T0 });
    assert.equal(o.filteredOut, 3000); assert.equal(o.truncated, 0);
    assert.ok(Object.values(o.elements).some((e) => e.label === '提交'));
    // 真实形状：元素没有编号字段 → 键是自编的 b0…；bounds 是 {x,y,width,height}
    assert.deepEqual(Object.keys(o.elements), ['b0', 'b1']); assert.deepEqual(o.elements.b0.bounds, [5, 9000, 80, 30]);
  } finally { cleanup(); }
});

test('只存命中词表的文字：其余格文字留空，正文和普通按钮名不落盘；窗口标题截 30 字；不存 value', () => {
  const { obsPath, cleanup } = fresh();
  try {
    recordObservation({ path: obsPath, threadId: THREAD_A, result: { observation: { observationId: 'o', window: { title: '窗口标题'.repeat(20) }, elements: JSON.parse(JSON.stringify(realTree(5).details.result.details.elements)) } }, now: T0, cfg });
    const raw = readFileSync(obsPath, 'utf8');
    assert.ok(raw.includes('提交')); assert.ok(!raw.includes('机密正文文字') && !raw.includes('普通按钮机密名') && !raw.includes('正文0'));
    const [o] = loadObservations({ path: obsPath, threadId: THREAD_A, now: T0 });
    assert.equal([...o.window].length, 30);
  } finally { cleanup(); }
});

test('词表没读到（cfg 为空）：不抛错，不过滤角色（只截 800），所有格文字一律留空', () => {
  const { obsPath, cleanup } = fresh();
  try {
    const n = recordObservation({ path: obsPath, threadId: THREAD_A, result: realTree(900), now: T0, cfg: null });
    assert.equal(n, 800);
    const [o] = loadObservations({ path: obsPath, threadId: THREAD_A, now: T0 });
    assert.equal(o.truncated, 102); assert.ok(Object.values(o.elements).every((e) => e.label === ''));
    assert.ok(!readFileSync(obsPath, 'utf8').includes('机密'));
  } finally { cleanup(); }
});

test('旧观察作废：作废后按编号点和按坐标点都当认不出；回车 60 秒规则不受影响；新观察又有效', () => {
  const { obsPath, cleanup } = fresh();
  try {
    observe(obsPath);
    const cl = (params, o) => classifyCall({ toolName: 'computer', params, observations: o, cfg, now: T0, coordinateLookup: true });
    let obs = loadObservations({ path: obsPath, threadId: THREAD_A, now: T0 });
    assert.equal(cl({ action: 'left_click', elementRef: 'e1' }, obs).hit, true);
    assert.equal(invalidateObservations({ path: obsPath, threadId: THREAD_A, now: T0 + 1 }), 1);
    obs = loadObservations({ path: obsPath, threadId: THREAD_A, now: T0 + 1 });
    assert.equal(obs[0].stale, true);
    assert.deepEqual(cl({ action: 'left_click', elementRef: 'e1' }, obs), { hit: false, unrecognized: true });
    assert.deepEqual(cl({ action: 'left_click', x: 120, y: 110 }, obs), { hit: false, unrecognized: true });
    assert.equal(cl({ action: 'key', keys: 'Return' }, obs).hit, true, '回车规则看"屏幕上有没有提交按钮"，不看坐标');
    observe(obsPath, T0 + 2);
    obs = loadObservations({ path: obsPath, threadId: THREAD_A, now: T0 + 2 });
    assert.equal(cl({ action: 'left_click', elementRef: 'e1' }, obs).hit, true);
  } finally { cleanup(); }
});

test('作废判断用的动作集合：切窗、滚动要作废；只读动作（含 browser 的 snapshot／status／tabs）不作废；只许收尾照旧放行 bring_to_front', () => {
  for (const a of ['bring_to_front', 'scroll', 'left_click', 'type', 'key', 'launch_app', 'invoke_menu', 'browser_click', 'mouse_move']) assert.equal(isInvalidatingAction(a), true, a);
  for (const a of ['screenshot', 'zoom', 'list_windows', 'get_accessibility_tree', 'get_window_state', 'wait', 'snapshot', 'status', 'tabs', 'get_browser_state']) assert.equal(isInvalidatingAction(a), false, a);
  assert.equal(isInvalidatingAction(''), false);
  assert.ok(NON_INVALIDATING_ACTIONS instanceof Set && !NON_INVALIDATING_ACTIONS.has('bring_to_front'));
  assert.equal(isCleanupAction({ action: 'bring_to_front' }), true, '"只许收尾"硬拦的白名单（SEE_ACTIONS）没被改');
  assert.equal(isCleanupAction({ action: 'screenshot' }), true); assert.equal(isCleanupAction({ action: 'left_click' }), false);
});

test('after_tool_call：切窗／点击放行后旧观察作废；读树记新表；出错的调用不记也不作废；别的角色不管', () => {
  const f = fresh();
  try {
    const reg = [];
    registerDesktopScreenLock({ on: (n, h, o) => reg.push({ n, h, o }) }, { lockPath: f.lockPath, logPath: f.logPath, wordsPath: WORDS, guardWaitMs: 500 });
    const rec = reg.find((r) => r.o?.registrationId === 'desktop-observation-record');
    const ctx = { agentId: 'desktop', sessionKey: A };
    const stale = () => loadObservations({ path: f.obsPath, threadId: THREAD_A, now: Date.now() }).map((o) => o.stale);
    rec.h({ toolName: 'computer', params: { action: 'get_accessibility_tree' }, result: realTree(3) }, ctx);
    assert.deepEqual(stale(), [false]);
    rec.h({ toolName: 'computer', params: { action: 'screenshot' }, result: { details: { width: 1 } } }, ctx);
    assert.deepEqual(stale(), [false], '只读动作不作废');
    rec.h({ toolName: 'computer', params: { action: 'left_click' }, error: 'boom', result: {} }, ctx);
    rec.h({ toolName: 'computer', params: { action: 'left_click' }, result: { isError: true } }, ctx);
    rec.h({ toolName: 'computer', params: { action: 'left_click' }, result: { details: { ok: false } } }, ctx);
    assert.deepEqual(stale(), [false], '出错的调用不作废');
    rec.h({ toolName: 'computer', params: { action: 'left_click' }, result: { details: { width: 1 } } }, { agentId: 'worker-c', sessionKey: A });
    assert.deepEqual(stale(), [false], '别的角色不管');
    rec.h({ toolName: 'computer', params: { action: 'bring_to_front' }, result: { details: { width: 1 } } }, ctx);
    assert.deepEqual(stale(), [true], '切窗放行后作废');
    rec.h({ toolName: 'computer', params: { action: 'get_accessibility_tree' }, result: realTree(3) }, ctx);
    assert.deepEqual(stale(), [true, false], '重新读树记新表，旧的仍是作废');
    assert.equal(failedShapeOf({ details: { ok: false } }), true);
  } finally { f.cleanup(); }
});

test('结果文本超 8MB：跳过并通过回调报出来（extractObservation 单参调用照旧）', () => {
  const big = { content: [{ type: 'text', text: '{"elements":[' + 'x'.repeat(MAX_RESULT_TEXT) + ']}' }] };
  const skipped = [];
  assert.equal(extractObservation(big, (i) => skipped.push(i)), null);
  assert.equal(skipped[0].skipped, 'too-large');
  assert.equal(extractObservation(big), null, '没传回调也不抛错');
  const f = fresh();
  try {
    const got = [];
    assert.equal(recordObservation({ path: f.obsPath, threadId: THREAD_A, result: big, now: T0, cfg, onSkip: (i) => got.push(i) }), 0);
    assert.equal(got.length, 1);
  } finally { f.cleanup(); }
});

// ───── additional cases─────
test('词表正常加载、可点击元素超 800 个：只存前 800 个，truncated 记下多出的数', () => {
  const { obsPath, cleanup } = fresh();
  try {
    const elements = Array.from({ length: 900 }, (_, i) => ({ value: '', role: 'button', label: i === 899 ? '提交' : '普通' + i, bounds: { x: i, y: 0, width: 10, height: 10 } }));
    const n = recordObservation({ path: obsPath, threadId: THREAD_A, result: { details: { result: { details: { elements } } } }, now: T0, cfg });
    assert.equal(n, 800);
    const [o] = loadObservations({ path: obsPath, threadId: THREAD_A, now: T0 });
    assert.equal(o.truncated, 100); assert.equal(o.filteredOut, 0);
    assert.ok(!Object.values(o.elements).some((e) => e.label === '提交'), '第 900 个排在 800 之后，被截掉（这是已写明的边界）');
  } finally { cleanup(); }
});

test('8MB 以上的文本不管 "elements" 排在多后面都跳过；没有 "elements" 的大文本静默跳过不记日志', () => {
  const late = { content: [{ type: 'text', text: ' '.repeat(5000) + '{"elements":[{"role":"button","label":"提交","bounds":{"x":1,"y":1,"width":1,"height":1}}]}' + ' '.repeat(MAX_RESULT_TEXT) }] };
  const got = [];
  assert.equal(extractObservation(late, (i) => got.push(i)), null);
  assert.equal(got.length, 1);
  const plain = { content: [{ type: 'text', text: 'x'.repeat(MAX_RESULT_TEXT + 1) }] };
  const got2 = [];
  assert.equal(extractObservation(plain, (i) => got2.push(i)), null);
  assert.equal(got2.length, 0);
});

test('after_tool_call：8MB 读树结果跳过后往日志写一条 observation-skipped，不写观察表', () => {
  const f = fresh();
  try {
    const reg = [];
    registerDesktopScreenLock({ on: (n, h, o) => reg.push({ n, h, o }) }, { lockPath: f.lockPath, logPath: f.logPath, wordsPath: WORDS, guardWaitMs: 500 });
    const rec = reg.find((r) => r.o?.registrationId === 'desktop-observation-record');
    const big = { content: [{ type: 'text', text: '{"elements":[' + 'x'.repeat(MAX_RESULT_TEXT) + ']}' }] };
    rec.h({ toolName: 'computer', params: { action: 'get_accessibility_tree' }, result: big }, { agentId: 'desktop', sessionKey: A });
    const skipped = logs(f.logPath).filter((l) => l.decision === 'observation-skipped');
    assert.equal(skipped.length, 1); assert.equal(skipped[0].skipped, 'too-large');
    assert.deepEqual(loadObservations({ path: f.obsPath, threadId: THREAD_A, now: Date.now() }), []);
  } finally { f.cleanup(); }
});

test('the English sensitive words in sensitive-words.json match the list in lexicon.mjs (and include subscribe and authorize)', () => {
  const words = JSON.parse(readFileSync(WORDS, 'utf8')).words.filter((w) => /^[a-z]+$/.test(w));
  assert.deepEqual([...words].sort(), [...SENSITIVE_WORDS_EN].sort());
  assert.ok(words.includes('subscribe') && words.includes('authorize'));
});
