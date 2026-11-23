// English (locale en): the messages and cards the programs really assemble have no Chinese character.
// notices.en.test.mjs checks every sentence of the lexicon; this file calls the real entry points (the card gate, the master-list tick,
// the catch-up check, the closing gate, the desktop queue, the daytime watch, the ledger watch, the credit gate) and checks the final text.
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/notices-assembled.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locale, lexicon } from '../../plugins/personal-inbox/lexicon.mjs';
import { createScreenGate, readLock, expiredNoticeText, findMarkedMessage } from '../../plugins/personal-inbox/desktop-lock.mjs';
import { loadWords, recordObservation, classifyCall, loadObservations } from '../../plugins/personal-inbox/sensitive-click.mjs';
import { withLedger, registerItem, runTick as ledgerTick } from '../../plugins/personal-inbox/pending-ledger.mjs';
import { runCatchup } from '../../scripts/automation/quota-catchup.mjs';
import { collectAnomalies } from '../../scripts/automation/day-watch.mjs';
import { cmdAdd, runCheck } from '../../scripts/automation/ledger-watch.mjs';
import { TASK_NAMES, cmdInit, runTick as gateTick } from '../../scripts/automation/api-quota-gate.mjs';
import { registerAuditGate } from '../../plugins/personal-inbox/audit-gate.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const HAN = /[㐀-鿿豈-﫿＀-￯　-〿]/;
const W = lexicon();
const WORDS = fileURLToPath(new URL('../../plugins/personal-inbox/sensitive-words.json', import.meta.url));
const cfg = loadWords(WORDS);
const T0 = 1_800_000_000_000;
const THREAD = '1000000000000000145';
const SESSION = `agent:desktop:discord:channel:${THREAD}`;
const noHan = (s, what) => assert.ok(!HAN.test(String(s)), `${what}: ${String(s).slice(0, 300)}`);

// ---------- the six kinds of action: classifyCall and the card ----------
test('classifyCall: the reason of every recognized case is English', () => {
  const obs = [{ at: T0, window: 'Checkout', elements: { e1: { role: 'AXButton', label: 'Submit Order', bounds: { x: 1, y: 1, width: 5, height: 5 } } } }];
  const c = (params) => classifyCall({ toolName: 'computer', params, observations: obs, cfg, now: T0 });
  const whats = [
    classifyCall({ toolName: 'browser', params: { action: 'browser_set_input_files' }, observations: [], cfg, now: T0 }).what,
    classifyCall({ toolName: 'browser', params: { action: 'browser_dialog', accept: true }, observations: [], cfg, now: T0 }).what,
    c({ action: 'left_click', elementRef: 'e1' }).what,
    c({ action: 'invoke_menu', path: ['File', 'Delete everything'] }).what,
    c({ action: 'key', keys: 'Return' }).what,
  ];
  assert.deepEqual(whats, [
    '(auto) choose a file to upload',
    '(auto) click "OK" in a confirmation dialog on a web page',
    '(auto) click "Submit Order" (AXButton), window "Checkout"',
    '(auto) choose menu "File ▸ Delete everything"',
    '(auto) press Return (or input with a line break); the screen shows a "Submit Order" button this may be pressing, window "Checkout"',
  ]);
  for (const w of whats) noHan(w, 'what');
});

function freshLock() {
  const dir = mkdtempSync(join(tmpdir(), 'notice-gate-'));
  writeFileSync(join(dir, 'screen-queue-settings.json'), JSON.stringify({ holdMinutes: 15, confirmMinutes: 5, maxNotifyAttempts: 3, paused: false }));
  return { dir, lockPath: join(dir, 'screen.lock'), obsPath: join(dir, 'ui-elements.json'), logPath: join(dir, 'gate.log'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function gateWith(f, sent) {
  const gate = createScreenGate({ lockPath: f.lockPath, logPath: f.logPath, now: () => T0, observationPath: f.obsPath, wordsPath: WORDS, guardWaitMs: 200, sendApprovalNotice: async (a) => { sent.push(a); return { ok: true }; }, dedupPath: join(f.dir, 'dedup.json') });
  return (params) => gate({ toolName: 'computer', params, toolCallId: 'tc' }, { agentId: 'desktop', sessionKey: SESSION });
}
const observe = (f, label, windowTitle) => recordObservation({ path: f.obsPath, threadId: THREAD, result: { observation: { observationId: 'o1', window: windowTitle, elements: [{ elementRef: 'e1', role: 'AXButton', label, bounds: { x: 100, y: 100, width: 80, height: 30 } }] } }, now: T0, cfg });

test('card of a click the program recognized: no Chinese, the button name and the whole thread link stay visible', async () => {
  const f = freshLock(); const sent = [];
  try {
    const gate = gateWith(f, sent);
    gate({ action: 'screenshot' });
    observe(f, 'Submit Order and pay now with the saved card ending 4242', 'A very long window title of the shopping site checkout');
    const r = gate({ action: 'left_click', elementRef: 'e1' });
    assert.ok(r?.requireApproval, 'a card');
    const d = r.requireApproval.description;
    noHan(d, 'description'); noHan(r.requireApproval.title, 'title'); noHan(r.requireApproval.timeoutReason, 'timeoutReason');
    assert.equal(r.requireApproval.title, 'Six-kinds-of-action confirmation');
    assert.ok([...d].length <= 480, `${[...d].length}`);
    assert.ok(d.includes('Submit Order and pay now with the saved'), d);
    assert.ok(d.includes('Recognized by the program'), d);
    assert.match(d, /; thread: https:\/\/discord\.com\/channels\/\d+\/1000000000000000145\.$|; thread: https:\/\/discord\.com\/channels\/\d+\/1000000000000000145\./, d);
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(sent.length, 1);
    noHan(sent[0].message, 'notice message');
    assert.ok(sent[0].message.includes('Submit Order'), sent[0].message);
    assert.ok(readLock(f.lockPath).what.startsWith('(auto) click "Submit Order'));
  } finally { f.cleanup(); }
});

test('card text of a very long reason keeps the thread link whole', async () => {
  const f = freshLock(); const sent = [];
  try {
    const gate = gateWith(f, sent);
    gate({ action: 'screenshot' });
    // the Desktop operator records its own reason (long), through the lock; the card then repeats it
    const { holdForConfirmation } = await import('../../plugins/personal-inbox/desktop-lock.mjs');
    const held = holdForConfirmation({ lockPath: f.lockPath, threadId: THREAD, what: 'Post the long quarterly report to the public site and then send the announcement to every subscriber of the list '.repeat(4), now: T0 });
    assert.ok(held.ok, JSON.stringify(held));
    const r = gate({ action: 'left_click', elementRef: 'zz' });
    const d = r?.requireApproval?.description ?? '';
    noHan(d, 'description');
    assert.ok([...d].length <= 480, `${[...d].length}`);
    assert.match(d, /Post the long quarterly report/);
    assert.match(d, /; thread: https:\/\/discord\.com\/channels\/\d+\/1000000000000000145\./, d);
  } finally { f.cleanup(); }
});

// ---------- the closing confirmation card ----------
test('closing card of the audit gate: English title, description, reasons, card name, source line and thread link', async () => {
  const hs = {};
  const api = { on: (name, fn) => { (hs[name] ??= []).push(fn); } };
  const fire = async (name, ...a) => { let first; for (const fn of hs[name] ?? []) { const r = await fn(...a); if (first === undefined && r !== undefined) first = r; } return first; };
  const sent = [];
  const gate = registerAuditGate(api, { getCard: async () => ({ id: 'card-ap', title: 'A card with a rather long name that has to be shortened', labels: ['audit:single-task'], notes: '[Audit level] Single (task audit)' }), sendApprovalNotice: async (a) => { sent.push(a); return { ok: true }; } });
  gate.ledger.recordSubmission({ cardId: 'card-ap', n: 1, threadId: 'TAP', paths: [], unverifiable: ['https://example.com/x'], fingerprintMap: {} });
  gate.ledger.recordReport({ threadId: 'TAP', author: 'task-auditor', verdict: 'pass', partsTotal: 1 }); gate.ledger.markPartDelivered('TAP');
  const r = await fire('before_tool_call', { toolName: 'workboard_complete', toolCallId: 'c1', params: { id: 'card-ap' } }, { agentId: 'worker-e', sessionKey: 'agent:worker-e:discord:channel:1000000000000000100' });
  assert.ok(r?.requireApproval, 'a card');
  const c = r.requireApproval;
  noHan(c.title, 'title'); noHan(c.description, 'description'); noHan(c.timeoutReason, 'timeoutReason');
  assert.equal(c.title, 'Closing confirmation');
  assert.ok(c.description.includes('only the owner can approve completing it'), c.description);
  assert.ok(c.description.includes('requested by bot: worker-e; task card: card-ap'), c.description);
  assert.ok(c.description.includes('"A card with a rather long name'), c.description);
  assert.match(c.description, /; thread: https:\/\/discord\.com\/channels\/\d+\/1000000000000000100\. The approval covers this one closing only\.$/);
  assert.equal(c.timeoutReason, 'Not approved, so the closing did not go ahead');
  await new Promise((res) => setTimeout(res, 20));
  for (const a of sent) noHan(a.message, 'notice');
});

// ---------- the master list and its reminders ----------
test('master-list tick: every message that goes out is English, with the English tag; the verification searches the same tag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notice-ledger-'));
  const path = join(dir, 'ledger.json');
  const sent = []; const searches = []; let n = 100; let lose = false;
  const discord = {
    async send(a) { sent.push(a.text); return lose ? { messageId: null } : { messageId: String(++n) }; },
    async edit() {}, async pin() {}, async readReplies() { return []; },
    async search(q) { searches.push(q.query); return []; }, async wakeJudge() { return { jobId: 'j' }; },
  };
  try {
    await withLedger(path, (L) => ({ r: registerItem(L, { title: 'Which plan?', suggestion: 'plan A', blocks: 'the release', requestMessageId: '1000000000000000009', requestLink: 'L', botId: '99' }, T0) }), { now: () => T0 });
    await ledgerTick({ path, now: () => T0 + 10, discord, watchDir: join(dir, 'watch') });
    assert.ok(sent.length >= 2, sent.join('\n---\n'));
    for (const s of sent) noHan(s, 'message');
    const asks = sent.filter((s) => s.includes('[Awaiting decision · '));
    assert.equal(asks.length, 1, sent.join('\n---\n'));
    assert.match(asks[0], /\n\[Awaiting decision · [0-9a-f]{8}\]$/);
    // a send whose id is lost is searched again with the very same tag
    await withLedger(path, (L) => ({ r: registerItem(L, { title: 'Second one', suggestion: 's', blocks: 'b', requestMessageId: '1000000000000000010', requestLink: 'L2', botId: '99' }, T0 + 20) }), { now: () => T0 + 20 });
    lose = true;
    await ledgerTick({ path, now: () => T0 + 30, discord, watchDir: join(dir, 'watch') });
    lose = false;
    await ledgerTick({ path, now: () => T0 + 60_000, discord, watchDir: join(dir, 'watch') });
    assert.ok(searches.length >= 1 && searches.every((q) => /^\[Awaiting decision · [0-9a-f]{8}\]$/.test(q)), searches.join(','));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the catch-up check: the stuck-lock notice ----------
test('catch-up check: the stuck-lock notice is English', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'notice-catchup-'));
  try {
    const base = join(dataRoot, W.layout.runLogs, W.layout.runLogDirs.catchup);
    mkdirSync(base, { recursive: true });
    const lock = join(base, '.lock');
    writeFileSync(lock, '{}');
    const old = new Date(Date.parse('2026-11-23T09:00:00+05:30') - 3 * 3600000); utimesSync(lock, old, old);
    const now = () => Date.parse('2026-11-23T09:00:00+05:30');
    const deps = { now, listJobs: () => [], listRuns: () => [], readReading: () => null, run: () => ({ code: 1, stdout: '', stderr: '' }), send: async () => ({ ok: true }) };
    const lines = runCatchup({ dataRoot, deps });
    assert.deepEqual(lines, ['The catch-up check got stuck and needs checking (the lock file was older than twice the time limit and was not taken over)']);
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

// ---------- the desktop queue: the check marker and the self-check line ----------
test('queue notifications and the self-check carry English markers that the verification searches for', async () => {
  const Q = W.queueText, ND = W.notices.desktopApproval;
  const text = Q.notifyOwnerJob('1000000000000000012', 'Nov 23 09:00', 7, THREAD, 'x', 15);
  assert.ok(text.includes(Q.noMarker(7)), text);
  assert.equal(Q.noMarker(7), '(queue number 7)');
  noHan(text, 'queue notification');
  noHan(expiredNoticeText(7), 'passed-over notice');
  assert.equal(ND.selfCheckMarker(1800), '(self-check S1800)');
  noHan(ND.selfCheck(ND.selfCheckMarker(1800)), 'self-check line');
  // the verification looks for the marker among the messages of the notifying account
  const marker = Q.noMarker(7);
  const found = await findMarkedMessage({ deps: { read: async () => ({ ok: true, messages: [{ id: '1000000000000000050', authorId: '1000000000000000012', content: `${text}` }] }) }, remaining: () => 30000, clock: () => T0 }, { target: THREAD, after: '1000000000000000001', marker, authorId: '1000000000000000012' }).catch((e) => ({ error: String(e) }));
  assert.equal(found?.found?.id, '1000000000000000050', JSON.stringify(found));
});

// ---------- the daytime watch ----------
test('daytime watch: anomaly sentences have no Chinese, unknown values are English, log names are quoted', () => {
  const day = Date.parse('2026-11-23T09:00:00+05:30');
  const cards = [{ id: 'card-1', title: 'A task', status: 'running', updatedAt: day - 3 * 3600000, labels: [], notes: '' }];
  const d = { now: () => day, listCards: () => cards, listJobs: () => [], listRuns: () => [], dataRoot: mkdtempSync(join(tmpdir(), 'notice-day-')), watchDir: null };
  try {
    const list = collectAnomalies(d);
    assert.ok(list.some((a) => a.type === 'card-stale'), JSON.stringify(list));
    for (const a of list) noHan(a.text, `anomaly ${a.type}`);
  } finally { rmSync(d.dataRoot, { recursive: true, force: true }); }
  const D = W.notices.dayWatch;
  assert.equal(D.quotaHit('main', D.quotaChat, '', D.quotaResumeUnknown), 'Stopped because the quota ran out: main (in a conversation), resume time unknown; not one of the four jobs the catch-up looks after, please judge whether to carry on');
  assert.ok(D.lockStale(D.lockWhatLedger, W.layout.watchFiles?.ledgerLock ?? 'x.log', '2026-11-20T10:00').includes('log `'));
});

// ---------- the ledger watch ----------
test('ledger watch: both notices that go to the Workshop are English', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'notice-lw-'));
  const st = { clock: Date.parse('2026-11-22T17:20:00+05:30'), woke: [], sent: [] };
  const deps = {
    dataRoot, now: () => st.clock,
    async wake(msg) { st.woke.push(msg); return { ok: true, jobId: 'j' }; },
    async send(text) { st.sent.push(text); return { ok: true, id: 'm' }; },
    out: () => {}, warn: () => {},
  };
  try {
    assert.equal(await cmdAdd(deps, { 日期: '2026-11-22', 标题: 'Sample', 原话: 'quote', 行号: 'record L100' }), 0);
    for (let i = 0; i < 4; i++) { st.clock += 25 * 3600000; await runCheck(deps); }
    for (const s of [...st.woke, ...st.sent]) noHan(s, 'ledger-watch message');
    assert.ok(st.sent.some((s) => s.startsWith('[Ledger backlog]')), st.sent.join('\n'));
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

// ---------- the API credit gate ----------
test('credit gate: the pause and resume notices that go to the Workshop are English', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'notice-gate2-'));
  const T = (s) => Date.parse(s);
  const st = { clock: T('2031-03-06T07:01:00+05:30'), sent: [], calls: [], out: [], warns: [] };
  const jobs = TASK_NAMES.map((n, i) => ({ id: `id-${i}`, name: n, enabled: true, agentId: i === 1 ? 'main' : 'system-auditor', payload: { kind: 'agentTurn', model: 'anthropic-api/claude-sonnet-5-5' }, state: { lastRunStatus: 'ok' } }));
  const wrap = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: '' });
  const deps = {
    dataRoot, now: () => st.clock,
    run(args) { const [a, b] = args; if (a === 'cron' && b === 'list') return wrap({ jobs }); if (a === 'cron' && b === 'get') return wrap(jobs.find((x) => x.id === args[2])); if (a === 'cron' && b === 'edit') { const j = jobs.find((x) => x.id === args[2]); j.enabled = args.includes('--enable'); return wrap({ id: j.id, enabled: j.enabled }); } if (a === 'cron' && b === 'runs') return wrap({ entries: [] }); if (a === 'infer') return wrap({ ok: true, provider: 'anthropic-api', model: 'x', outputs: [{ text: 'ok' }] }); throw new Error(`unexpected: ${args.join(' ')}`); },
    async send(text) { st.sent.push(text); return { ok: true, id: String(st.sent.length) }; },
    warn: (m) => st.warns.push(m), out: (m) => st.out.push(m),
  };
  try {
    assert.equal(await cmdInit(deps, '2031-03-06'), 0);
    await gateTick(deps);
    assert.equal(st.sent.length, 1, st.sent.join('\n'));
    noHan(st.sent[0], 'pause notice');
    assert.ok(st.sent[0].startsWith('[API credit] This credit period has ended (Mar 6 07:00).'), st.sent[0]);
    st.clock = T('2031-03-06T18:00:00+05:30');
    await gateTick(deps); await gateTick(deps);
    for (const s of st.sent) noHan(s, 'gate notice');
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});
