// English (locale en) tests of project files: folder names, placeholders, index row, task record, results, check, scan.
// Templates are written inline here (the shipped English templates are checked by docs-consistency.en.test.mjs and new-project-templates.en.test.mjs).
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/project-files.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locale } from '../../plugins/personal-inbox/lexicon.mjs';
import { newProject, newTask, addResult, checkProject, entryHintFor, scan, parseIndex, stripTemplateNotes, nameProblems, PLACEHOLDER, SUBDIRS } from '../../plugins/personal-inbox/project-files.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const HAN = /[㐀-鿿＀-￯　-〿]/;

const ENTRY_TPL = `# {{PROJECT_NAME}}: Project entry

<!-- template note begin -->
usage note
<!-- template note end -->

## Current goal

{{ONE_LINE_GOAL}}

## Mapping

- Discord channel: {{CHANNEL}}
- Lead bot: {{LEAD_BOT}}

## Current status

{{DATE}}: The project was just created.

## Current results

| Result | Location | Note |
| --- | --- | --- |
| None yet (to be written) | — | — |
`;
const TASK_TPL = `# Task record: {{TASK_TITLE}}

<!-- template note begin -->
usage note
<!-- template note end -->

## Goal

{{GOAL}}

## Owner's words

{{OWNER_QUOTE}}

## Current status

Status: In progress | {{DATETIME}}
One line: {{EXECUTOR}} has taken it over.

## Waiting for the owner's decision

None

## Result location

None yet

## Task card ID

{{TASK_CARD_ID}}

## Discord thread link

{{THREAD_LINK}}

project: {{PROJECT_NAME}}
`;
const INDEX0 = `# Master index

| Project | Discord channel | Lead bot | Current entry | Main files and results |
| --- | --- | --- | --- | --- |
| Example Project | not a project channel (ID 100000000000000003) | Controller | [Project entry](projects/ExampleProject/PROJECT.md) | task records in x |

Not a project.
`;

function newRoot() {
  const root = mkdtempSync(join(tmpdir(), 'pf-en-'));
  mkdirSync(join(root, 'templates'), { recursive: true });
  writeFileSync(join(root, 'templates', 'project-entry.md'), ENTRY_TPL);
  writeFileSync(join(root, 'templates', 'task-record.md'), TASK_TPL);
  writeFileSync(join(root, 'INDEX.md'), INDEX0);
  mkdirSync(join(root, 'projects'), { recursive: true });
  return root;
}
const idx = (root) => join(root, 'INDEX.md');
const mk = (root, name = 'Demo', ch = '100000000000000173') => newProject({ dataRoot: root, indexPath: idx(root), name, channelId: ch, channelName: `${name} channel`, lead: 'Worker', goal: 'Make a demo' });

test('folder names', () => assert.deepEqual(SUBDIRS, ['tasks', 'outputs', 'history']));

test('new-project: builds projects/<name>/{tasks,outputs,history}, the entry and one index row — nothing Chinese is written', () => {
  const root = newRoot();
  try {
    const r = mk(root);
    assert.equal(r.ok, true, r.message);
    for (const d of ['tasks', 'outputs', 'history']) assert.ok(existsSync(join(root, 'projects', 'Demo', d)), d);
    assert.ok(!existsSync(join(root, '项目')));
    const entry = readFileSync(join(root, 'projects', 'Demo', 'PROJECT.md'), 'utf8');
    assert.ok(entry.includes('## Current results') && entry.includes('Make a demo') && entry.includes('Demo channel (ID 100000000000000173)'));
    assert.ok(!entry.includes('template note') && !entry.includes('{{'));
    assert.ok(!HAN.test(entry), entry);
    const index = readFileSync(idx(root), 'utf8');
    const row = index.split('\n').find((l) => l.startsWith('| Demo |'));
    assert.equal(row, '| Demo | Demo channel (ID 100000000000000173) | Worker | [Project entry](projects/Demo/PROJECT.md) | Task records in projects/Demo/tasks/, results in projects/Demo/outputs/, history in projects/Demo/history/ |');
    assert.ok(!HAN.test(row));
    const again = mk(root);
    assert.equal(again.existed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('parseIndex: first column "Project", "(ID digits)" and the entry link under projects/', () => {
  const p = parseIndex(INDEX0);
  assert.equal(p.ok, true);
  assert.equal(p.rows[0].channelId, '100000000000000003');
  assert.equal(p.rows[0].entryPath, 'projects/ExampleProject/PROJECT.md');
  assert.equal(p.rows[0].folder, 'ExampleProject');
  assert.equal(parseIndex('no table').ok, false);
  assert.equal(parseIndex(INDEX0.replace('| Project |', '| 项目 |')).ok, false, 'the Chinese header is not read in en');
  assert.equal(parseIndex(INDEX0.replace('(ID 100000000000000003)', '（编号 100000000000000003）')).rows[0].channelId, null, 'the Chinese ID writing is not read in en');
});

test('new-task without --goal and --card-id: English defaults, no Chinese anywhere in the record', () => {
  const root = newRoot();
  try {
    assert.equal(mk(root).ok, true);
    const r = newTask({ dataRoot: root, project: 'Demo', title: 'First task', threadLink: 'https://discord.com/channels/1/2', executor: 'Worker', quote: 'please do it\nsecond line', quoteDate: '2026-11-22' });
    assert.equal(r.ok, true, r.message);
    const text = readFileSync(join(root, 'projects', 'Demo', 'tasks', 'First-task.md'), 'utf8');
    assert.ok(text.startsWith('# Task record: First task'));
    assert.ok(text.includes('2026-11-22:\n> please do it\n> second line'), text);
    assert.ok(text.includes('<One sentence in plain words: what this task is meant to achieve.>'));
    assert.ok(text.includes('## Task card ID\n\nNone yet\n'));
    assert.ok(!HAN.test(text), text);
    assert.ok(!text.includes('{{') && !text.includes('template note'));
    assert.equal(newTask({ dataRoot: root, project: 'Demo', title: 'First task', threadLink: 'x', executor: 'W', quote: 'q' }).existed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('add-result changes only the "Current results" table and the "Current status" line', () => {
  const root = newRoot();
  try {
    mk(root);
    writeFileSync(join(root, 'projects', 'Demo', 'outputs', 'report.md'), 'x');
    const r = addResult({ dataRoot: root, project: 'Demo', name: 'Report', path: 'outputs/report.md', note: 'the report', now: Date.parse('2026-11-22T10:00:00Z') });
    assert.equal(r.ok, true, r.message);
    const entry = readFileSync(join(root, 'projects', 'Demo', 'PROJECT.md'), 'utf8');
    assert.ok(entry.includes('| Report | `outputs/report.md` | the report |'));
    assert.ok(!entry.includes(PLACEHOLDER));
    assert.match(entry, /\n2026-11-2\d: Report done, see the table below\n/);
    const bad = addResult({ dataRoot: root, project: 'Demo', name: 'X', path: '/etc/passwd', note: 'n' });
    assert.equal(bad.ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('check-project and the completion reminder (entryHintFor) are in English', () => {
  const root = newRoot();
  try {
    mk(root);
    const c = checkProject({ dataRoot: root, indexPath: idx(root), name: 'Demo' });
    assert.deepEqual(c.problems.map((p) => p.code), ['entry-placeholder']);
    assert.equal(c.problems[0].where, 'projects/Demo/PROJECT.md');
    const hint = entryHintFor({ dataRoot: root, indexPath: idx(root), channelId: '100000000000000173' });
    assert.equal(hint, 'The project entry has not caught up ("Current results" is not registered yet); please update it (the executor can use add-result; otherwise the project\'s lead bot keeps it)');
    assert.ok(!HAN.test(hint));
    // a finished task record newer than the entry status → the second part of the hint
    writeFileSync(join(root, 'projects', 'Demo', 'outputs', 'a.md'), 'x');
    addResult({ dataRoot: root, project: 'Demo', name: 'A', path: 'outputs/a.md', note: 'n', now: Date.parse('2026-11-01T00:00:00Z') });
    writeFileSync(join(root, 'projects', 'Demo', 'tasks', 't.md'), '# Task record: t\n\n## Current status\n\nStatus: Done | 2026-11-20 10:00\n');
    const hint2 = entryHintFor({ dataRoot: root, indexPath: idx(root), channelId: '100000000000000173' });
    assert.ok(hint2.includes('the "Current status" date is behind the task records'), hint2);
    assert.ok(!HAN.test(hint2));
    assert.equal(entryHintFor({ dataRoot: root, indexPath: idx(root), channelId: '999999999999999999' }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scan: data-root whitelist, run-logs folders, version words, diary names, English report', () => {
  const root = newRoot();
  try {
    mk(root);
    mkdirSync(join(root, 'run-logs', 'closing'), { recursive: true });
    mkdirSync(join(root, 'run-logs', 'mystery'), { recursive: true });
    mkdirSync(join(root, 'audit'), { recursive: true }); mkdirSync(join(root, 'trash'), { recursive: true });
    writeFileSync(join(root, 'decision-ledger.md'), 'x'); writeFileSync(join(root, 'owner-status.md'), 'x');
    writeFileSync(join(root, 'stray-test-file.txt'), 'x');
    writeFileSync(join(root, 'projects', 'Demo', 'outputs', 'report_final.md'), 'x');
    writeFileSync(join(root, 'projects', 'Demo', 'outputs', 'diary_20261101.md'), 'x');
    writeFileSync(join(root, 'projects', 'Demo', 'outputs', 'diary_20261101-pre-rerun-123.md'), 'x');
    writeFileSync(join(root, 'projects', 'Demo', 'outputs', 'diary_20261101-to-merge-x.md'), 'x');
    mkdirSync(join(root, 'projects', 'Orphan'), { recursive: true });
    const r = scan({ dataRoot: root, indexPath: idx(root), date: '2026-11-22', write: false });
    assert.equal(r.ok, true);
    const where = r.rows.map((x) => x.where);
    assert.ok(where.includes('stray-test-file.txt'));
    assert.ok(where.includes('run-logs/mystery'));
    assert.ok(!where.includes('run-logs/closing') && !where.includes('decision-ledger.md') && !where.includes('audit') && !where.includes('trash'));
    assert.ok(where.includes('projects/Demo/outputs/report_final.md'), 'version word "final"');
    assert.ok(!where.some((w) => w.includes('diary_')), 'English diary names (re-run and to-merge copies) are fine');
    assert.ok(where.includes('projects/Orphan'));
    assert.ok(r.report.startsWith('# File reconcile\nBusiness date: 2026-11-22\nFile reconcile: new 0, day 3 0, existing '), r.report.slice(0, 120));
    assert.equal(r.rows.find((x) => x.where === 'stray-test-file.txt').suggest.includes('trash'), true, 'looks like a test leftover');
    assert.ok(!existsSync(join(root, '运行记录')));
    // run twice: the second run counts today's findings as "new" (day 1)
    scan({ dataRoot: root, indexPath: idx(root), date: '2026-11-22' });
    const r2 = scan({ dataRoot: root, indexPath: idx(root), date: '2026-11-23' });
    assert.ok(r2.report.includes('File reconcile: new 0, day 3 0, existing'), r2.report.slice(0, 200));
    assert.ok(existsSync(join(root, 'run-logs', 'file-reconcile', '状态.json')), 'machine state file keeps its Chinese name (documented boundary)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stripTemplateNotes and nameProblems use the English words', () => {
  assert.equal(stripTemplateNotes('a\n<!-- template note begin -->\nnote\n<!-- template note end -->\nb\n'), 'a\nb\n');
  assert.equal(stripTemplateNotes('a\n<!-- 模板说明开始 -->\nnote\n<!-- 模板说明结束 -->\nb\n'), 'a\n<!-- 模板说明开始 -->\nnote\n<!-- 模板说明结束 -->\nb\n', 'the Chinese markers are not read in en');
  assert.ok(nameProblems('report_final.md').length > 0);
  assert.ok(nameProblems('report_latest.md').length > 0);
  assert.deepEqual(nameProblems('report.md'), []);
  assert.deepEqual(nameProblems('report_最新.md'), [], 'Chinese version words are not linted in en');
});
