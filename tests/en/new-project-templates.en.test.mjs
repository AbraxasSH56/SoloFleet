// The shipped English templates work with the program: new-project, new-task, add-result and check-project fill every placeholder,
// and nothing Chinese is written. (project-files.en.test.mjs uses small inline templates; this test uses the real files.)
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/new-project-templates.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locale } from '../../plugins/personal-inbox/lexicon.mjs';
import { newProject, newTask, addResult, checkProject, entryHintFor } from '../../plugins/personal-inbox/project-files.mjs';
import { checkTaskRecord } from '../../scripts/automation/daily-format-check.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HAN = /[㐀-鿿＀-￯　-〿]/;

function newRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tpl-en-'));
  mkdirSync(join(root, 'templates'), { recursive: true });
  for (const f of ['task-record.md', 'project-entry.md']) copyFileSync(join(ROOT, 'templates', f), join(root, 'templates', f));
  // the master index is made from the shipped header template
  writeFileSync(join(root, 'INDEX.md'), readFileSync(join(ROOT, 'templates', 'index-header.md'), 'utf8'));
  mkdirSync(join(root, 'projects'), { recursive: true });
  return root;
}

test('the real English templates: new-project, new-task, add-result, check-project and the daily format check', () => {
  const root = newRoot();
  try {
    const idx = join(root, 'INDEX.md');
    const p = newProject({ dataRoot: root, indexPath: idx, name: 'Demo', channelId: '100000000000000173', channelName: 'Demo channel', lead: 'Worker', goal: 'Make a demo' });
    assert.equal(p.ok, true, p.message);
    const entry = readFileSync(join(root, 'projects', 'Demo', 'PROJECT.md'), 'utf8');
    assert.ok(!HAN.test(entry) && !entry.includes('{{') && !entry.includes('template note begin'), entry);
    assert.ok(entry.includes('Make a demo') && entry.includes('Demo channel (ID 100000000000000173)'));
    const row = readFileSync(idx, 'utf8').split('\n').find((l) => l.startsWith('| Demo |'));
    assert.ok(row && !HAN.test(row), row);

    const t = newTask({ dataRoot: root, project: 'Demo', title: 'First task', threadLink: 'https://discord.com/channels/1/2', executor: 'Worker', quote: 'please do it' });
    assert.equal(t.ok, true, t.message);
    const rec = readFileSync(t.path, 'utf8');
    assert.ok(!HAN.test(rec) && !rec.includes('{{') && !rec.includes('template note begin'), rec);
    assert.deepEqual(checkTaskRecord(rec), [], 'the record the template produces passes the daily format check');

    writeFileSync(join(root, 'projects', 'Demo', 'outputs', 'out.md'), 'x');
    const r = addResult({ dataRoot: root, project: 'Demo', name: 'Out', path: 'outputs/out.md', note: 'the output' });
    assert.equal(r.ok, true, r.message);
    const after = readFileSync(join(root, 'projects', 'Demo', 'PROJECT.md'), 'utf8');
    assert.ok(after.includes('| Out | `outputs/out.md` | the output |') && !after.includes('None yet (to be written)'));
    assert.deepEqual(checkProject({ dataRoot: root, indexPath: idx, name: 'Demo' }).problems, []);
    assert.equal(entryHintFor({ dataRoot: root, indexPath: idx, channelId: '100000000000000173' }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
