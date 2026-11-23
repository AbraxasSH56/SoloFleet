// English (locale en) tests of the closing gate: submission sheet, report first line, card label vs. body level.
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/audit-gate.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locale } from '../../plugins/personal-inbox/lexicon.mjs';
import { parseSubmission, parseVerdict, ClosingLedger, decideClosing, readAuditLabel, fingerprintPaths, AUDIT_LABEL_PREFIX, AUDIT_LABEL_VALUES } from '../../plugins/personal-inbox/audit-gate.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');

const SHEET = (n, card, paths, { colonSpace = ' ' } = {}) => `Task audit <@100000000000000013> please review:${colonSpace}test task (round ${n})
Task card:${colonSpace}${card}  Audit level: Single (task audit)
Owner's words: see the section in the card body
Acceptance criteria: 1. a file exists
Result location:
${paths.join('\n')}
Task type: other
Executor: worker <@100000000000000138>`;

test('constants', () => {
  assert.equal(AUDIT_LABEL_PREFIX, 'audit:');
  assert.deepEqual(AUDIT_LABEL_VALUES, ['single-task', 'single-independent', 'chained']);
});

test('submission sheet: first line "Task audit <@ID> please review: … (round N)", second line "Task card:", result location one path per line', () => {
  const s = parseSubmission(SHEET(2, 'card-1', ['/a/b.md', '/a/c']));
  assert.deepEqual({ cardId: s.cardId, n: s.n, paths: s.paths }, { cardId: 'card-1', n: 2, paths: ['/a/b.md', '/a/c'] });
  const noSpace = parseSubmission(SHEET(3, 'card-2', ['/x/y'], { colonSpace: '' }));
  assert.deepEqual({ cardId: noSpace.cardId, n: noSpace.n, paths: noSpace.paths }, { cardId: 'card-2', n: 3, paths: ['/x/y'] });
  assert.equal(parseSubmission('just a sentence'), null);
  assert.equal(parseSubmission('Task audit <@1> please review: x (round 1)\nTask card: c'), null, 'wrong reviewer mention');
  const url = parseSubmission(SHEET(1, 'c', ['https://discord.com/channels/1/2/3']));
  assert.deepEqual(url.paths, []);
  assert.equal(url.unverifiable.length, 1);
});

test('submission sheet: the long English label "Acceptance criteria" does not end the result-location block wrongly, and the label 15 characters long is read', () => {
  const s = parseSubmission(SHEET(1, 'card-1', ['/a/b.md']));
  assert.deepEqual(s.paths, ['/a/b.md']);
});

test('submission sheet: the Chinese sheet is not read in en', () => {
  assert.equal(parseSubmission('任务审计 <@100000000000000013> 请审：测试任务（第 1 次）\n任务卡：card-1\n成果位置：\n/a/b.md'), null);
});

test('report first line', () => {
  assert.equal(parseVerdict('Verdict: pass\nrest'), 'pass');
  assert.equal(parseVerdict('\nVerdict: fail (① 2 items)'), 'fail');
  assert.equal(parseVerdict('Verdict: cannot audit (this kind of content cannot be audited)'), 'cannot audit');
  assert.equal(parseVerdict('Verdict:pass'), 'pass');
  assert.equal(parseVerdict('pass'), null);
  assert.equal(parseVerdict('我得：通过'), null);
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-en-'));
  const f = join(dir, 'result.md');
  writeFileSync(f, 'version one');
  const card = { id: 'card-1', labels: ['audit:single-task'], notes: '[Audit level] Single (task audit)' };
  const ledger = new ClosingLedger();
  const submit = (n = 1, thread = 'T1', paths = [f]) => { const fp = fingerprintPaths(paths); return ledger.recordSubmission({ cardId: 'card-1', n, threadId: thread, paths, fingerprintMap: fp.map }); };
  const report = (thread, verdict, total = 1, delivered = total) => { ledger.recordReport({ threadId: thread, author: 'task-auditor', verdict, partsTotal: total }); for (let i = 0; i < delivered; i++) ledger.markPartDelivered(thread); };
  const decide = (extra = {}) => decideClosing({ ledger, cardId: 'card-1', card, ...extra });
  return { dir, f, card, ledger, submit, report, decide, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('card label versus the level written in the card body: "[Audit level]" and "Audit level:" are both read', () => {
  assert.equal(readAuditLabel({ labels: ['audit:single-task'] }).ok, true);
  assert.equal(readAuditLabel({ labels: ['audit:single-independent'], notes: '[Audit level] Single (independent audit) | owner confirmed on 02-14' }).ok, true);
  assert.equal(readAuditLabel({ labels: ['audit:single-independent'], notes: '[Audit level] Single (task audit) | owner confirmed on 02-14' }).ok, false, 'template wording contradiction');
  assert.equal(readAuditLabel({ labels: ['audit:chained'], notes: 'Audit level: Single (task audit)' }).ok, false);
  assert.equal(readAuditLabel({ labels: ['audit:chained'], notes: 'Audit level:Chained' }).ok, true);
  assert.equal(readAuditLabel({ labels: ['audit:single-task'], notes: '[Audit level] Chained' }).ok, false);
  assert.equal(readAuditLabel({ labels: ['audit:waived'] }).ok, false, 'unknown value');
  assert.equal(readAuditLabel({ labels: ['审计:单审任务审计'] }).ok, false, 'the Chinese label is not read in en');
  assert.equal(readAuditLabel({ labels: [] }).ok, false);
});

test('closing: a pass lets the card through; no submission, a changed result or a fail blocks it', () => {
  const t = setup();
  const d0 = t.decide(); assert.equal(d0.allow, false);
  t.submit(); assert.equal(t.decide().allow, false);
  t.report('T1', 'pass');
  const d = t.decide(); assert.equal(d.allow, true);
  writeFileSync(t.f, 'version two');
  assert.equal(t.decide().allow, false, 'result changed after the submission');
  t.cleanup();
  const t2 = setup(); t2.submit(); t2.report('T1', 'fail');
  const d2 = t2.decide(); assert.equal(d2.allow, false); assert.equal(d2.approval, undefined);
  t2.cleanup();
});

test('closing: "cannot audit" goes to an Opus second audit bound to this submission; its pass lets the card through', () => {
  const mk = (verdictLine) => {
    const t = setup(); t.submit(1, 'T1'); t.report('T1', 'cannot audit');
    t.ledger.bindOpus({ cardId: 'card-1', n: 1, runId: 'R1', childSessionKey: 'S1' });
    t.ledger.recordOpusReport({ runId: 'R1', childSessionKey: 'S1', agentId: 'task-auditor', modelId: 'anthropic/claude-opus-5-5', text: verdictLine });
    return t;
  };
  assert.equal(mk('Verdict: pass').decide().allow, true);
  assert.equal(mk('Verdict: fail (① 1 items)').decide().allow, false);
  assert.equal(mk('Verdict: cannot audit').decide().allow, false);
});
