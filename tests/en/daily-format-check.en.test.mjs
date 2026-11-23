// English (locale en) tests of the daily format check: it reads the English words and English folder names.
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/daily-format-check.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locale } from '../../plugins/personal-inbox/lexicon.mjs';
import { checkTaskRecord, scanTaskRecords, checkLedgerText, scanLedger, checkCard, auditLabelOf, levelLineOf, STATUS_HEADS, run } from '../../scripts/automation/daily-format-check.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const NOW = Date.parse('2026-11-22T12:10:00Z');

const GOOD = `# Task record: x\n\n## Current status\n\nStatus: In progress | 11-22 10:00\nOne line: working\n\n## Waiting for the owner's decision\n\nNone\n\n## Next step\n\nContinue\n`;
const withStatus = (s) => GOOD.replace('Status: In progress | 11-22 10:00', s);
const WAIT_EMPTY = withStatus('Status: Waiting on owner | 11-22 10:00');

test('the five English status heads', () => {
  assert.deepEqual(STATUS_HEADS, ['Done', 'In progress', 'Did not run', 'Waiting on owner', 'Stuck']);
});

test('F1: a good record passes; missing status line, wrong opener and template text are reported; no-space colon is fine', () => {
  assert.deepEqual(checkTaskRecord(GOOD), []);
  for (const h of ['Done', 'Did not run', 'Stuck', 'Waiting on owner']) assert.ok(!checkTaskRecord(withStatus(`Status: ${h} | x`)).some((x) => x.includes('does not start with')), h);
  assert.match(checkTaskRecord(GOOD.replace('Status: In progress | 11-22 10:00\n', ''))[0], /Status: /);
  assert.match(checkTaskRecord(withStatus('Status: finished | x'))[0], /does not start with one of Done\/In progress\/Did not run\/Waiting on owner\/Stuck/);
  assert.match(checkTaskRecord(withStatus('Status: <Done / In progress> | <date>'))[0], /is still the template as is/);
  assert.match(checkTaskRecord('# Task record\n\n## Goal\n\nx\n')[0], /Current status/);
  assert.deepEqual(checkTaskRecord(withStatus('Status:Done | x')), [], 'no space after the colon is accepted');
  assert.ok(checkTaskRecord(withStatus('状态：完成 | x')).length > 0, 'the Chinese status line is not read in en');
});

test('F2: waiting on the owner with an empty / "None" decision section is reported; a filled section is not', () => {
  assert.match(checkTaskRecord(WAIT_EMPTY).join(), /Waiting for the owner's decision.*None/);
  assert.match(checkTaskRecord(WAIT_EMPTY.replace('\nNone\n', '\n\n')).join(), /Waiting for the owner's decision/);
  assert.match(checkTaskRecord(WAIT_EMPTY.replace(/## Waiting for the owner's decision\n\nNone\n\n/, '')).join(), /Waiting for the owner's decision/);
  assert.deepEqual(checkTaskRecord(WAIT_EMPTY.replace('\nNone\n', '\nAsked: which one\nOptions: 1 ...\nRecommended: 1\nAsked at: 11-22\nResult: no answer yet\n')), []);
  assert.deepEqual(checkTaskRecord(GOOD), []);
  assert.ok(checkTaskRecord(WAIT_EMPTY.replace('\nNone\n', '\nnone.\n')).length > 0, 'a lower-case "none." counts as empty');
});

test('scanTaskRecords reads projects/<name>/tasks', () => {
  const root = mkdtempSync(join(tmpdir(), 'dfc-en-'));
  try {
    const dir = join(root, 'projects', 'P', 'tasks'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.md'), GOOD); writeFileSync(join(dir, 'b.md'), WAIT_EMPTY);
    const t = NOW / 1000;
    utimesSync(join(dir, 'a.md'), t, t); utimesSync(join(dir, 'b.md'), t, t);
    // a Chinese folder is not read in en
    const zhDir = join(root, '项目', 'Q', '任务'); mkdirSync(zhDir, { recursive: true }); writeFileSync(join(zhDir, 'z.md'), GOOD); utimesSync(join(zhDir, 'z.md'), t, t);
    const r = scanTaskRecords(root, NOW - 86400000, NOW, [], 0);
    assert.deepEqual(r.checked.map((x) => x.file).sort(), ['projects/P/tasks/a.md', 'projects/P/tasks/b.md']);
    assert.equal(r.bad.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('F4 decision ledger: "Date:" and "Quote:" lines are required', () => {
  const led = `# Decision ledger\n\n## 1. Active decisions\n\n### D-001 good\n- Date: 01-15 | Scope: all\n- Quote: "do not cut"\n- Replaces: none.\n\n### D-002 no date\n- Scope: all\n- Quote: relayed, source: x\n\n### D-003 no quote\n- Date: 01-15\n- Quote:\n\n### D-004 half-width without space\n- Date:01-15\n- Quote:"ok"\n`;
  const r = checkLedgerText(led);
  assert.equal(r.total, 4);
  assert.deepEqual(r.bad, [{ id: 'D-002', miss: ['Date'] }, { id: 'D-003', miss: ['Quote: '] }]);
  const root = mkdtempSync(join(tmpdir(), 'dfc-en-'));
  try {
    writeFileSync(join(root, 'decision-ledger.md'), led);
    assert.equal(scanLedger(root, 0, []).bad.length, 2);
    const n = []; assert.equal(scanLedger(join(root, 'x'), 0, n).unreadable, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const NOTES_OK = '[Audit level] Single (task audit) | owner confirmed on 2031-02-14\n\n[Authorization scope]\nGoal: x\nAllowed: y\nNeeds owner confirmation: z\nStop conditions: w\n';
const card = (o = {}) => ({ id: 'c1', title: 't', notes: NOTES_OK, labels: ['audit:single-task'], comments: [], created_at: NOW, updated_at: NOW, ...o });
const ctx = { startMs: NOW - 86400000, snapshotAt: null, snapshot: null };

test('F3 task card: label, level line, authorization block and its four lines', () => {
  assert.deepEqual(checkCard(card(), ctx), []);
  assert.equal(auditLabelOf(card()), 'audit:single-task');
  assert.equal(levelLineOf(card()), NOTES_OK.split('\n')[0]);
  assert.match(checkCard(card({ labels: [] }), ctx).join(), /no audit:… label/);
  assert.match(checkCard(card({ labels: ['审计:单审任务审计'] }), ctx).join(), /no audit:… label/, 'the Chinese label is not read in en');
  assert.match(checkCard(card({ notes: NOTES_OK.replace('[Audit level]', 'level') }), ctx).join(), /no \[Audit level\] line/);
  assert.match(checkCard(card({ notes: '[Audit level] x\nnothing else' }), ctx).join(), /no \[Authorization scope\] block/);
  assert.match(checkCard(card({ notes: NOTES_OK.replace('Stop conditions: w\n', '') }), ctx).join(), /lacks: Stop conditions/);
  assert.match(checkCard(card({ notes: NOTES_OK.replace('Goal: x\n', '').replace('Allowed: y\n', '') }), ctx).join(), /lacks: Goal, Allowed/);
  assert.deepEqual(checkCard(card({ notes: NOTES_OK.replace(/: /g, ':') }), ctx), [], 'no space after the colons is fine');
});

test('F3 raising or lowering the level needs an owner confirmation in the same or a neighbouring comment', () => {
  const chg = { ordinal: 1, body: 'Audit level: Single (task audit) → Chained, reason: big consequences', created_at: NOW };
  assert.match(checkCard(card({ comments: [chg] }), ctx).join(), /upgrade\/downgrade lacks confirmation/);
  assert.deepEqual(checkCard(card({ comments: [{ ...chg, body: `${chg.body}, owner confirmed on 03-09` }] }), ctx), []);
  assert.deepEqual(checkCard(card({ comments: [{ ...chg, body: `${chg.body}; owner 03-04 approved` }] }), ctx), []);
  assert.deepEqual(checkCard(card({ comments: [chg, { ordinal: 2, body: 'the owner confirmed it', created_at: NOW }] }), ctx), []);
  assert.deepEqual(checkCard(card({ comments: [{ ...chg, body: '审计级别：单审（任务审计） → 串联，主人于 03-09 确认' }] }), ctx), [], 'the Chinese comment is not read as a change record in en');
});

test('F3 label snapshot: a label that changed without a comment is reported', () => {
  const snap = { c1: { audit: 'audit:single-task', level: NOTES_OK.split('\n')[0] } };
  assert.match(checkCard(card({ labels: ['audit:chained'] }), { ...ctx, snapshotAt: NOW - 3600000, snapshot: snap }).join(), /label or level line changed/);
  assert.deepEqual(checkCard(card(), { ...ctx, snapshotAt: NOW - 3600000, snapshot: snap }), []);
});

test('the whole report is written in English: headings, marks, verdicts and the "Could not check" list', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dfc-en-'));
  try {
    mkdirSync(join(root, 'audit', 'daily'), { recursive: true });
    writeFileSync(join(root, 'audit', 'daily', 'bot-roster.json'), JSON.stringify({ 状态: '有效', 人设bot: [{ 角色: 'main', Discord编号: '1000000000000000001' }] }));
    const dir = join(root, 'projects', 'P', 'tasks'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ok.md'), GOOD); writeFileSync(join(dir, 'bad.md'), WAIT_EMPTY);
    const t = (NOW - 3600000) / 1000; utimesSync(join(dir, 'ok.md'), t, t); utimesSync(join(dir, 'bad.md'), t, t);
    writeFileSync(join(root, 'decision-ledger.md'), '# Decision ledger\n'); const old = (NOW - 3 * 86400000) / 1000; utimesSync(join(root, 'decision-ledger.md'), old, old);
    const deps = { now: () => NOW, listThreads: async () => { throw new Error('boom'); }, readMessages: async () => [], readCards: async () => [card({ id: 'cardA-xxxxxxxx', title: 'Good card' }), card({ id: 'cardB-xxxxxxxx', title: 'Bad card', labels: [] })] };
    const r = await run({ dataRoot: root, deps, nowMs: NOW });
    const text = readFileSync(r.out, 'utf8');
    assert.ok(!/[\u3400-\u9fff]/.test(text), text.match(/.*[\u3400-\u9fff].*/)?.[0]);
    for (const h of ['# Format check · 2026-11-22', 'Business date: 2026-11-22', 'Status: unfinished', '## Task records (F1, F2)', '## Task cards (F3)', '## Decision ledger (F4)', '## Hand-off counts (H1;', '## Could not check', '- Ledger file unchanged since the previous round; not checked']) assert.ok(text.includes(h), h);
    assert.match(text, /bad\.md: .*status is "Waiting on owner", but the "Waiting for the owner's decision" section is empty or only says "None"/);
    assert.match(text, /ok\.md: OK/);
    assert.match(text, /Bad card: no audit:… label/);
    assert.match(text, /Could not check: hand-off counts \(cannot list the threads: boom\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
