// English (locale en): "write and read meet" tests added after the pre-push result audit.
// What one program writes must be found by the one that reads it, and the sentences the programs send to a bot must use the words of the English tools.
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/rework-closure.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locale, lexicon } from '../../plugins/personal-inbox/lexicon.mjs';
import { createQuotaRegistry } from '../../plugins/personal-inbox/quota-recovery.mjs';
import { paths as catchupPaths } from '../../scripts/automation/quota-catchup.mjs';
import { paths as resumePaths } from '../../scripts/automation/quota-resume.mjs';
import { readResumeLedger } from '../../scripts/automation/day-watch.mjs';
import { findCardByThread, STATUS_TEXT } from '../../plugins/personal-inbox/desktop-lock.mjs';
import { wakeMessage } from '../../scripts/automation/ledger-watch.mjs';
import { updateParameters } from '../../plugins/personal-inbox/pending-tools.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const W = lexicon('en'), Z = lexicon('zh-CN');
const HAN = /[㐀-鿿豈-﫿]/;
const tmp = () => mkdtempSync(join(tmpdir(), 'rework-en-'));

test('the quota plan-archive folder: the registry writes where the catch-up reads', () => {
  const d = tmp();
  try {
    const reg = createQuotaRegistry({ dataRoot: d });
    assert.equal(reg.archiveDir, catchupPaths(d).archiveDir);
    assert.equal(reg.archiveDir, join(d, 'run-logs', 'quota', 'plan-archive'));
    assert.equal(reg.dir, catchupPaths(d).quotaDir);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the quota-resume ledger: the folder the resume script writes is the folder the daytime watch reads', () => {
  const d = tmp();
  try {
    const P = resumePaths(d);
    assert.equal(P.dir, join(d, 'run-logs', 'quota', 'resume'));
    mkdirSync(P.dir, { recursive: true });
    writeFileSync(P.ledger, JSON.stringify({ 链: { a: { x: 1 } }, 运行: {} }));
    assert.deepEqual(readResumeLedger(d, Date.now()), { 链: { a: { x: 1 } }, 运行: {} });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('findCardByThread: without the mapping table the second layer reads the English task-record sections', () => {
  const d = tmp();
  try {
    const dir = join(d, W.layout.projects, 'P', W.layout.tasks);
    mkdirSync(dir, { recursive: true });
    const card = '12345678-1234-4234-8234-123456789abc';
    writeFileSync(join(dir, 'x.md'), `# Task\n\n## ${W.taskRecordSections.cardId}\n\n${card}\n\n## ${W.taskRecordSections.threadLink}\n\nhttps://discord.com/channels/1000000000000000001/1000000000000000002/1000000000000000003\n`);
    const found = findCardByThread('1000000000000000003', { dataRoot: d, dbPath: join(d, 'none.sqlite') });
    assert.equal(found?.id, card);
    assert.equal(found?.via, '任务记录');
    // the Chinese headings are not read in en
    writeFileSync(join(dir, 'x.md'), `# 任务\n\n## ${Z.taskRecordSections.cardId}\n\n${card}\n\n## ${Z.taskRecordSections.threadLink}\n\n1000000000000000003\n`);
    assert.equal(findCardByThread('1000000000000000003', { dataRoot: d, dbPath: join(d, 'none.sqlite') }), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('wake sentences: no Chinese, and the status words are the ones the English tool accepts', () => {
  const judge = W.wake.pendingJudge('P-001', 'Title', '1000000000000000009', 'https://discord.com/channels/1/2/3');
  assert.ok(!HAN.test(judge));
  const enumWords = updateParameters.properties.status.enum;
  for (const w of ['received', 'decided']) { assert.ok(enumWords.includes(w), w); assert.ok(judge.includes(`"${w}"`), `the sentence names "${w}"`); }
  for (const f of [W.wake.ledgerBacklog(2, '/node', '/script.mjs'), W.wake.ledgerBacklogTest('x'), W.wake.watchBody(W.wake.watchMarker('fp'), 'list')]) assert.ok(!HAN.test(f));
  assert.match(W.wake.pendingJudgeJob + W.wake.ledgerBacklogJob + W.wake.watchJob, /^[\x20-\x7e]+$/);
});

test('ledger-watch wake message names the English ledger file and the English run-log folder', () => {
  const m = wakeMessage([{ 测试: false }, { 测试: false }]);
  assert.ok(!HAN.test(m));
  assert.ok(m.includes(W.layout.ledgerFile), 'the ledger file name');
  assert.ok(m.includes(W.layout.runLogs), 'the run-log folder name');
  assert.ok(wakeMessage([{ 测试: true }]).startsWith('[This is a test'));
});

test('desktop queue: the status texts are the English status codes the patrol job names', () => {
  assert.deepEqual(Object.values(STATUS_TEXT).sort(), ['crossed-off', 'expired', 'needs-info', 'notified', 'notify-failed', 'notify-unknown', 'taken', 'to-notify', 'waiting']);
  const patrol = readFileSync(join(ROOT, 'jobs', 'patrol.md'), 'utf8');
  for (const w of ['waiting', 'needs-info', 'notify-failed', 'notify-unknown', 'notified']) assert.ok(patrol.includes(`\`${w}\``), `patrol.md names status ${w}`);
  const q = W.queueSummary;
  for (const t of [q.settingsOk(30, true), q.settingsBad('x'), q.unreadable('s'), q.hold('3', 'waiting', '1000000000000000003'), q.noHold, q.line(1, 'h', 's', true)]) assert.ok(!HAN.test(t));
});

test('report headings: the names the English jobs quote are the names the report writers use', () => {
  const daily = readFileSync(join(ROOT, 'jobs', 'daily-audit.md'), 'utf8');
  const weekly = readFileSync(join(ROOT, 'jobs', 'weekly-audit.md'), 'utf8');
  const bare = (h) => h.replace(/^#+\s*/, '');
  const F = W.fc, B = W.bs;
  for (const h of [bare(F.secRecords), bare(F.secCards), bare(F.secLedger)]) assert.ok(daily.includes(`"${h}"`), h);
  assert.ok(daily.includes('"Hand-off counts"') && bare(F.secHandoff(8)).startsWith('Hand-off counts'));
  assert.ok(daily.includes(`"${F.ledgerUnchanged.replace(/^- /, '')}"`));
  assert.ok(daily.includes('"Could not check"') && F.secNotChecked === '## Could not check');
  assert.ok(daily.includes('"hand to daily audit"') && F.rowOk('a', 'b', 9, 9, 8).includes('**hand to daily audit**'));
  assert.ok(daily.includes('"Summary of leads"') && bare(B.secClues) === 'Summary of leads');
  assert.ok(daily.includes('"3. Backup status"') && bare(B.secBackup) === '3. Backup status');
  assert.ok(daily.includes('"2. Out-of-scope files') && bare(B.secOutside).startsWith('2. Out-of-scope files'));
  assert.ok(weekly.includes(`"${bare(B.secLock).replace(/ \(from .*$/, '')}"`));
  for (const o of [F, B]) for (const [k, v] of Object.entries(o)) {
    const sample = typeof v === 'function' ? v(...Array.from({ length: v.length }, () => 'x')) : v;
    assert.ok(!HAN.test(JSON.stringify(sample)), `fc/bs.${k} has no Chinese in en`);
  }
  assert.ok(daily.includes('"Count reconciliation"') && daily.includes('"Keyword hits"') && daily.includes('"All commands"'));
});

test('the command-check and deep-review trigger tables: every English text has no Chinese, and says what the jobs quote', () => {
  const tableOf = (file) => { const src = readFileSync(join(ROOT, 'scripts/automation', file), 'utf8'); const a = src.indexOf('const LX = ('), b = src.indexOf(')[LOCALE];'); return new Function(`return (${src.slice(a + 'const LX = ('.length, b)});`)(); };
  for (const f of ['command-spot-check-trigger.js', 'deep-review-trigger.js']) {
    const en = tableOf(f).en;
    const walk = (o, path) => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object') walk(v, `${path}.${k}`); else { const s = typeof v === 'function' ? v(...Array.from({ length: v.length }, () => 'x')) : String(v); assert.ok(!HAN.test(s), `${f} ${path}.${k}`); } } };
    walk(en, f);
  }
  const R = tableOf('command-spot-check-trigger.js').en.R;
  const body = R.body('H', 'a', 'b', 'rows', 'api', 'kw', 'hits', 1, 2, false, 3, 'all', 'extra');
  for (const h of ['## Count reconciliation', '## Keyword hits', '## All commands']) assert.ok(body.includes(h), h);
  assert.ok(R.ins === 'records insufficient');
  assert.match(tableOf('deep-review-trigger.js').en.inc('why', 'head', '/dir'), /^Condition check read incomplete: why; head; /);
});

test('no program builds a path from a Chinese run-log sub-folder name any more', () => {
  const names = Object.values(Z.layout.runLogDirs);
  const bad = [];
  const walk = (dir) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (n === '__pycache__') continue; if (statSync(p).isDirectory()) walk(p); else if (/\.(mjs|js)$/.test(n) && n !== 'lexicon.mjs') {
    readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (/^\s*(\/\/|\*)/.test(l)) return; const code = l.split(' // ')[0]; if (!/\b(join|resolve)\(/.test(code)) return; for (const nm of names) if (code.includes(`'${nm}'`) || code.includes(`"${nm}"`)) bad.push(`${p.replace(ROOT, '')}:${i + 1} ${nm}`); }); } } };
  walk(join(ROOT, 'plugins')); walk(join(ROOT, 'scripts'));
  assert.deepEqual(bad, []);
});
