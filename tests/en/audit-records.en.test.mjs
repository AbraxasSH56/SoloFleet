// English (locale en) tests of the files the job instructions have the models write and the scripts read:
// the audit round record (task / business_date / cutoff / execution), the publish receipt, the anomaly flags.
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/audit-records.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locale } from '../../plugins/personal-inbox/lexicon.mjs';
import { roundDone, credentialTrusted, TASKS } from '../../scripts/automation/quota-catchup.mjs';
import { windowOf } from '../../scripts/automation/daily-format-check.mjs';
import { TASK_NAMES } from '../../scripts/automation/api-quota-gate.mjs';
import { AUDIT_TASK_NAMES } from '../../plugins/personal-inbox/quota-recovery.mjs';
import { crew } from '../../plugins/personal-inbox/crew-config.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const TARGET = `channel:${crew.channels.workshop}`;

test('job names are the English ones everywhere', () => {
  assert.deepEqual(Object.keys(TASKS), ['daily-audit', 'patrol', 'deep-review', 'weekly-audit']);
  assert.deepEqual(TASK_NAMES, ['daily-audit', 'patrol', 'deep-review', 'weekly-audit']);
  assert.deepEqual(AUDIT_TASK_NAMES, ['daily-audit', 'patrol', 'deep-review', 'weekly-audit']);
  assert.deepEqual(Object.values(TASKS).map((t) => t.目录), ['daily', 'patrol', 'deep-review', 'weekly']);
});

function world() {
  const root = mkdtempSync(join(tmpdir(), 'rec-en-'));
  const A = join(root, 'audit'); const R = join(A, 'publish', 'receipts');
  mkdirSync(join(A, 'weekly'), { recursive: true }); mkdirSync(join(A, 'daily'), { recursive: true }); mkdirSync(R, { recursive: true });
  const P = { round: (t, d) => join(A, TASKS[t].目录, `${d}.json`), credential: (t, d) => join(R, `${t}-${d}.json`), receipt: (t, d) => join(R, `${t}-${d}.receipt.txt`) };
  return { root, A, R, P, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('roundDone / credentialTrusted read the English record and receipt keys', () => {
  const w = world();
  try {
    const d = '2026-11-15'; const task = 'weekly-audit';
    writeFileSync(w.P.round(task, d), JSON.stringify({ task, business_date: d, cutoff: `${d}T19:00:00+05:30`, execution: 'done' }));
    assert.equal(roundDone(w.P, task, d), false, 'a published task also needs a trusted receipt');
    const cred = { task, business_date: d, digest: 'x', account: 'default', channel: 'discord', target: TARGET, state: 'delivered', message_id: '100000000000000102', receipt_time: 't' };
    writeFileSync(w.P.credential(task, d), JSON.stringify(cred));
    assert.equal(credentialTrusted(w.P, task, d), false, 'the receipt file is missing');
    writeFileSync(w.P.receipt(task, d), 'receipt');
    assert.equal(credentialTrusted(w.P, task, d), true);
    assert.equal(roundDone(w.P, task, d), true);
    writeFileSync(w.P.credential(task, d), JSON.stringify({ ...cred, state: 'to-verify' }));
    assert.equal(roundDone(w.P, task, d), false);
    writeFileSync(w.P.credential(task, d), JSON.stringify({ ...cred, message_id: '12ab' }));
    assert.equal(credentialTrusted(w.P, task, d), false);
    // a round that is in progress, or the Chinese keys, do not count
    writeFileSync(w.P.round(task, d), JSON.stringify({ task, business_date: d, execution: 'in-progress' }));
    assert.equal(roundDone(w.P, task, d), false);
    writeFileSync(w.P.round(task, d), JSON.stringify({ 任务: task, 业务日期: d, 执行: '完成' }));
    assert.equal(roundDone(w.P, task, d), false);
  } finally { w.cleanup(); }
});

test('the format check starts its window at the cutoff of the last finished daily-audit round (audit/daily/<date>.json)', () => {
  const w = world();
  try {
    writeFileSync(join(w.A, 'daily', '2026-11-20.json'), JSON.stringify({ task: 'daily-audit', business_date: '2026-11-20', cutoff: '2026-11-20T18:05:00+05:30', execution: 'done' }));
    writeFileSync(join(w.A, 'daily', '2026-11-21.json'), JSON.stringify({ task: 'daily-audit', business_date: '2026-11-21', cutoff: '2026-11-21T18:05:00+05:30', execution: 'in-progress' }));
    const now = Date.parse('2026-11-22T17:40:00+05:30');
    const win = windowOf(now, w.root);
    assert.equal(win.startMs, Date.parse('2026-11-20T18:05:00+05:30'), 'the unfinished round of 11-21 is skipped');
  } finally { w.cleanup(); }
});
