// English (locale en) test of the blind-spot check file: English folder and file name, English "Business date:" and "Status: ..." marks,
// and that day-watch reads the very same mark.
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/audit-blindspots.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { locale } from '../../plugins/personal-inbox/lexicon.mjs';
import { run } from '../../scripts/automation/audit-blindspots.mjs';
import { blindspotsDue } from '../../scripts/automation/day-watch.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const NOW = Date.UTC(2026, 10, 12, 12, 30, 0); // 11-12 18:00 in the test zone
const runFind = (args) => new Promise((res, rej) => execFile('/usr/bin/find', args, { encoding: 'utf8' }, (e, out) => (e ? rej(e) : res(out))));

test('the file is written to audit/daily/<date>-blindspot-check.md with the English marks; day-watch reads the same mark', async () => {
  const d = mkdtempSync(join(tmpdir(), 'blind-en-'));
  try {
    const data = join(d, 'data'); mkdirSync(join(data, 'audit', 'daily'), { recursive: true });
    const b = join(d, 'backups'); mkdirSync(join(b, 'consistent-checkpoints'), { recursive: true });
    const deps = { now: () => NOW, listCards: async () => { throw new Error('openclaw timed out'); }, runFind, git: async () => null };
    await run({ dataRoot: data, deps, nowMs: NOW, areas: { review: join(d, 'review'), roster: join(d, 'roster'), backup: b }, projectRoot: join(d, 'proj'), workspaceRoot: join(d, 'proj', 'runtime') });
    const file = join(data, 'audit', 'daily', '2026-11-12-blindspot-check.md');
    assert.ok(existsSync(file));
    assert.ok(!existsSync(join(data, '审计')));
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^Business date: 2026-11-12$/m);
    assert.match(text, /^Status: incomplete \(Could not check: /m, 'the mark is "Status: incomplete" while a section could not be checked');
    assert.doesNotMatch(text, /^Status: complete$/m);
    for (const h of ['# Blind-spot check · 2026-11-12', '## Summary of leads', '## 1. Rework count', '## 2. Out-of-scope files', '### A Rule files changed', "### B2 How recognition of the Desktop operator's submit-type clicks is running", '## 3. Backup status']) assert.ok(text.includes(h), h);
    assert.equal(blindspotsDue(Date.parse('2026-11-12T17:40:00+05:30'), data), true, 'incomplete: the watch runs it again');
    writeFileSync(file, text.replace(/^Status: incomplete.*$/m, 'Status: complete'));
    assert.equal(blindspotsDue(Date.parse('2026-11-12T17:40:00+05:30'), data), false, 'complete: the watch leaves it alone');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
