// English (locale en) tests of the daytime watch: the "Status: complete" mark of the two reports, the timed-job card lines, the waiting labels,
// and the same mark written by the format check and the blind-spot check.
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/day-watch.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locale } from '../../plugins/personal-inbox/lexicon.mjs';
import { formatCheckDue, blindspotsDue, collectAnomalies } from '../../scripts/automation/day-watch.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const at = (hhmm) => Date.parse(`2026-11-22T${hhmm}:00+05:30`); // Asia/Kolkata test zone

function root() { const r = mkdtempSync(join(tmpdir(), 'dw-en-')); mkdirSync(join(r, 'audit', 'daily'), { recursive: true }); return r; }

test('format check is due between 17:30 and 18:05 until the English file says "Status: complete"', () => {
  const r = root();
  try {
    assert.equal(formatCheckDue(at('17:40'), r), true);
    assert.equal(formatCheckDue(at('17:00'), r), false, 'too early');
    assert.equal(formatCheckDue(at('18:10'), r), false, 'too late');
    writeFileSync(join(r, 'audit', 'daily', '2026-11-22-format-check.md'), '# Format check · 2026-11-22\n\nBusiness date: 2026-11-22\nStatus: unfinished (x)\n');
    assert.equal(formatCheckDue(at('17:40'), r), true, 'an unfinished file runs again');
    writeFileSync(join(r, 'audit', 'daily', '2026-11-22-format-check.md'), '# Format check · 2026-11-22\n\nBusiness date: 2026-11-22\nStatus: complete\n');
    assert.equal(formatCheckDue(at('17:40'), r), false);
    // the mark must be at the start of a line, and the Chinese mark does not count in en
    writeFileSync(join(r, 'audit', 'daily', '2026-11-22-format-check.md'), 'x Status: complete\n状态：完整\n');
    assert.equal(formatCheckDue(at('17:40'), r), true);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test('blind-spot check: same rule, other file name; "Status: incomplete" does not count as complete', () => {
  const r = root();
  try {
    assert.equal(blindspotsDue(at('17:40'), r), true);
    writeFileSync(join(r, 'audit', 'daily', '2026-11-22-blindspot-check.md'), 'Status: incomplete (could not check: x)\n');
    assert.equal(blindspotsDue(at('17:40'), r), true);
    writeFileSync(join(r, 'audit', 'daily', '2026-11-22-blindspot-check.md'), 'Business date: 2026-11-22\nStatus: complete\n');
    assert.equal(blindspotsDue(at('17:40'), r), false);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

const H = 3600000;
const T0 = Date.parse('2026-11-22T12:00:00Z');
const board = (cards, jobs = [], runs = {}) => ({ now: () => T0, listCards: () => cards, listJobs: () => jobs, listRuns: (id) => runs[id] ?? [], deskWaitingCard: () => null });
const stale = (over = {}) => ({ id: 'c1', title: 'Card one', status: 'running', labels: [], notes: '', updatedAt: T0 - 3 * H, ...over });

test('a running card that has not moved is reported; one with an English waiting label, "waiting-owner-confirm" in the notes, or cancelled is not', () => {
  assert.deepEqual(collectAnomalies(board([stale()])).map((a) => a.type), ['card-stale']);
  assert.deepEqual(collectAnomalies(board([stale({ labels: ['waiting-confirm'] }), stale({ id: 'b', notes: 'waiting-owner-confirm' }), stale({ id: 'd', labels: ['cancelled'] })])), []);
  assert.deepEqual(collectAnomalies(board([stale({ labels: ['等确认'] })])).map((a) => a.type), ['card-stale'], 'the Chinese label is not read in en');
});

test('timed-job lines in the card body: "Timed job ID:" and "Due time:"', () => {
  const due = Date.parse('2026-11-22T10:00:00Z');
  const card = stale({ updatedAt: T0 - 10 * 60000, notes: `Timed job ID: job-77\nDue time: ${new Date(due).toISOString()}\n` });
  const types = collectAnomalies(board([card], [{ id: 'job-77' }])).map((a) => a.type);
  assert.ok(types.includes('oneshot-missed') || types.includes('oneshot-failed') || types.includes('oneshot-ok-not-done'), JSON.stringify(types));
  const zh = stale({ updatedAt: T0 - 10 * 60000, notes: `定时任务编号：job-77\n到点时间：${new Date(due).toISOString()}\n` });
  assert.deepEqual(collectAnomalies(board([zh], [{ id: 'job-77' }])), [], 'the Chinese lines are not read in en');
});
