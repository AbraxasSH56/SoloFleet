// English (locale en) tests of the audit guard's per-locale folder lists and publish task names, and of the two trigger scripts under the guard.
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/audit-guard.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeCommand, judgeWrite, effectiveRules, loadSnippets } from '../../plugins/personal-inbox/audit-guard.mjs';
import { locale } from '../../plugins/personal-inbox/lexicon.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const rules = JSON.parse(readFileSync(join(ROOT, 'plugins/personal-inbox/audit-guard-rules.json'), 'utf8'));
rules.paths.projectRoot = ROOT;
const DATA = mkdtempSync(join(tmpdir(), 'guard-en-'));
test.after(() => rmSync(DATA, { recursive: true, force: true }));
const EN = rules.localeOverrides.en;
for (const d of [...EN.writeDirs, ...EN.denyWriteDirs, 'projects/P/tasks']) mkdirSync(join(DATA, d), { recursive: true });
for (const d of [...rules.writeDirs, ...rules.denyWriteDirs]) mkdirSync(join(DATA, d), { recursive: true });
rules.paths.dataRoot = DATA;
const PR = ROOT;
const w = (role, toolName, path) => judgeWrite({ role, toolName, params: { path }, rules });
const ok = (v, msg) => assert.equal(v.allow, true, `${msg ?? ''} ${JSON.stringify(v)}`);
const no = (v, msg) => assert.equal(v.allow, false, `should be blocked: ${msg ?? ''}`);

test('effectiveRules never changes the rules object it is given, and zh-style objects without an overlay are returned as they are', () => {
  const before = JSON.stringify(rules);
  const eff = effectiveRules(rules);
  assert.notEqual(eff, rules);
  assert.deepEqual(eff.writeDirs, EN.writeDirs);
  assert.deepEqual(eff.denyWriteDirs, EN.denyWriteDirs);
  assert.deepEqual(eff.editExtra, EN.editExtra);
  assert.deepEqual(eff.roles['system-auditor'].publish.tasks, ['deep-review', 'weekly-audit']);
  assert.equal(JSON.stringify(rules), before, 'the given rules object is untouched');
  const plain = { writeDirs: ['x'], roles: { 'system-auditor': { publish: { tasks: ['a'] } } } };
  assert.equal(effectiveRules(plain), plain, 'a rules object without localeOverrides is used as it is');
});

test('write rules in en: English audit folders allowed, the Chinese ones are not; receipts folder is denied', () => {
  ok(w('system-auditor', 'write', join(DATA, 'audit/daily/x.md')), 'daily');
  ok(w('system-auditor', 'write', join(DATA, 'audit/deep-review/1.md')), 'deep review');
  ok(w('system-auditor', 'write', join(DATA, 'audit/weekly/1.md')), 'weekly');
  ok(w('system-auditor', 'write', join(DATA, 'audit/anomaly-flags/f.json')), 'flags');
  ok(w('system-auditor', 'write', join(DATA, 'audit/quota-readings/r.json')), 'quota readings');
  no(w('system-auditor', 'write', join(DATA, 'audit/publish/receipts/x.json')), 'receipts are written by the publish script only');
  no(w('system-auditor', 'write', join(DATA, '审计/日审/x.md')), 'the Chinese folder is not an audit folder in en');
  no(w('system-auditor', 'write', join(DATA, 'projects/P/tasks/a.md')), 'a whole-file write outside the audit folders');
  ok(w('system-auditor', 'edit', join(DATA, 'projects/P/tasks/a.md')), 'an exact edit of a task record is allowed');
  ok(w('system-auditor', 'edit', join(DATA, 'projects/P/PROJECT.md')), 'an exact edit of PROJECT.md is allowed');
  no(w('task-auditor', 'write', join(DATA, 'audit/daily/x.md')), 'the task auditor writes nothing');
});

test('publish script task names in en: deep-review and weekly-audit; the Chinese names and patrol are refused', () => {
  const cmd = (task) => judgeCommand({ role: 'system-auditor', command: `/usr/bin/python3 -I ${PR}/scripts/automation/publish-self.py ${task} 2026-11-15`, params: {}, rules, snippets: [] });
  ok(cmd('weekly-audit'), 'weekly-audit');
  ok(cmd('deep-review'), 'deep-review');
  no(cmd('周审'), 'Chinese name');
  no(cmd('patrol'), 'patrol is not published');
  const r = cmd('patrol');
  assert.ok(String(r.reason ?? JSON.stringify(r)).includes('deep-review／weekly-audit'), JSON.stringify(r));
});

test('the English fixed snippets are read from the English job files', () => {
  const { snippets, problems } = loadSnippets(rules);
  assert.deepEqual(problems, []);
  assert.equal(snippets.length, 3);
});
