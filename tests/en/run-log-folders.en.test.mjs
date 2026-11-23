// English (locale en): the run-log folder is "run-logs" and its sub-folders have English names.
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/run-log-folders.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locale, lexicon } from '../../plugins/personal-inbox/lexicon.mjs';
import { requestDir } from '../../plugins/personal-inbox/request-watch.mjs';
import { mapPath } from '../../plugins/personal-inbox/card-thread-map.mjs';
import { writeEnglishArchive } from '../../plugins/personal-inbox/execution-record.mjs';
import { paths as backlogPaths } from '../../scripts/automation/ledger-watch.mjs';
import { scan } from '../../plugins/personal-inbox/project-files.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('paths built by the programs', () => {
  assert.equal(requestDir('/d'), '/d/run-logs/request-watch');
  assert.equal(mapPath('/d'), '/d/run-logs/card-threads/对应.json');
  assert.equal(backlogPaths('/d').dir, '/d/run-logs/ledger-backlog');
  const d = mkdtempSync(join(tmpdir(), 'rl-en-'));
  try {
    writeEnglishArchive(d, { x: 1 }, Date.parse('2026-11-22T10:00:00Z'));
    assert.ok(existsSync(join(d, 'run-logs', 'english-cleanup-raw')));
    assert.ok(!existsSync(join(d, '运行记录')));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the file reconcile accepts exactly the run-log sub-folders of the lexicon (and the ones nested under quota)', () => {
  const d = mkdtempSync(join(tmpdir(), 'rl-en-'));
  try {
    const R = lexicon().layout.runLogDirs;
    
    for (const k of ['closing', 'gate', 'cardThreads', 'requestWatch', 'ledgerBacklog', 'apiQuota', 'quota', 'watch', 'formatCheck', 'blindspot', 'fileReconcile', 'englishCleanupRaw', 'reminders', 'catchup', 'publish']) mkdirSync(join(d, 'run-logs', R[k]), { recursive: true });
    mkdirSync(join(d, 'run-logs', '额度'), { recursive: true });
    mkdirSync(join(d, 'projects'), { recursive: true }); writeFileSync(join(d, 'INDEX.md'), '| Project | Discord channel | Lead bot | Current entry | Files |\n| --- | --- | --- | --- | --- |\n');
    const r = scan({ dataRoot: d, indexPath: join(d, 'INDEX.md'), date: '2026-11-22', write: false });
    const where = r.rows.map((x) => x.where);
    assert.deepEqual(where.filter((w) => w.startsWith('run-logs')), ['run-logs/额度'], 'only the Chinese folder is unknown in en');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('no program still builds a run-log path from the Chinese folder names', () => {
  const bad = [];
  const walk = (dir) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (n === '__pycache__') continue; if (statSync(p).isDirectory()) walk(p); else if (/\.(mjs|js)$/.test(n) && n !== 'lexicon.mjs') {
    readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (/^\s*(\/\/|\*)/.test(l)) return; if (/'运行记录'/.test(l.split(' // ')[0])) bad.push(`${p.replace(ROOT, '')}:${i + 1}`); }); } } };
  walk(join(ROOT, 'plugins')); walk(join(ROOT, 'scripts'));
  assert.deepEqual(bad, []);
});
