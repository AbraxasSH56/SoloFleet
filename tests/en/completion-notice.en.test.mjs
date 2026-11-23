// English (locale en) tests of the completion record and the small-job record.
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/completion-notice.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locale } from '../../plugins/personal-inbox/lexicon.mjs';
import { createCompletionNotice, completionText, roleNameFromTable } from '../../plugins/personal-inbox/completion-notice.mjs';
import { smallJobText } from '../../plugins/personal-inbox/small-job-notice.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const THREAD = '100000000000000100'; const PROJECT_CH = '100000000000000166';
const SK = `agent:worker-a:discord:channel:${THREAD}`;
const HAN = /[㐀-鿿＀-￯　-〿]/;

const mkNotice = (extra = {}) => {
  const sent = [];
  const n = createCompletionNotice({ syncRoot: null, dataRoot: null, getCard: async () => ({ title: 'test card' }), parentChannelOf: async () => PROJECT_CH, send: async (a) => { sent.push(a); return { ok: true }; }, roleName: () => 'Worker A', log: () => {}, ...extra });
  return { n, sent };
};

test('completion record text: no mention, card title, executor, thread link', () => {
  const t = completionText({ title: 'x'.repeat(200), executor: 'Worker A', threadLink: 'https://discord.com/channels/1/2' });
  assert.equal(t, `Completion record: "${'x'.repeat(80)}", executor: Worker A, thread: https://discord.com/channels/1/2`);
  assert.ok(!t.includes('<@'));
  assert.equal(completionText({ threadLink: 'l' }), 'Completion record: "(no card name)", executor: unknown, thread: l');
});

test('completion record is sent after a successful close; the reminder from the project entry is appended in English', async () => {
  const a = mkNotice();
  a.n.arm('c1', { cardId: 'card-1', agentId: 'worker-a', sessionKey: SK });
  assert.equal((await a.n.settle({ toolCallId: 'c1', result: { ok: true } })).sent, true);
  assert.match(a.sent[0].message, /^Completion record: "test card", executor: Worker A, thread: https:\/\/discord\.com\/channels\/\d+\/100000000000000100$/);
  const hint = 'The project entry has not caught up ("Current results" is not registered yet); please update it';
  const b = mkNotice({ entryHint: async () => hint });
  b.n.arm('c1', { cardId: 'card-1', agentId: 'worker-a', sessionKey: SK });
  await b.n.settle({ toolCallId: 'c1', result: { ok: true } });
  assert.equal(b.sent[0].message.split('; Reminder: ')[1], hint);
  assert.ok(!HAN.test(b.sent[0].message), b.sent[0].message);
});

test('executor name: read from audit/daily/bot-roster.json, else the role ID; "unknown" without a role', () => {
  const root = mkdtempSync(join(tmpdir(), 'cn-en-')); mkdirSync(join(root, 'audit', 'daily'), { recursive: true });
  writeFileSync(join(root, 'audit', 'daily', 'bot-roster.json'), JSON.stringify({ 人设bot: [{ 角色: 'main', 显示名: 'Controller' }] }));
  try {
    assert.equal(roleNameFromTable(root, 'main'), 'Controller');
    assert.equal(roleNameFromTable(root, 'worker-zz'), 'worker-zz');
    assert.equal(roleNameFromTable('/does-not-exist', undefined), 'unknown');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('small-job record text', () => {
  const t = smallJobText({ executor: 'Worker A', threadLink: 'https://x/y', files: ['/a/b/hy.txt', '/c/hy.txt', 'z.md'] });
  assert.equal(t, 'Completion record (small job): Worker A finished one item in thread https://x/y, changed: hy.txt, z.md');
  const many = smallJobText({ executor: 'x', threadLink: 'l', files: Array.from({ length: 9 }, (_, i) => `f${i}.md`) });
  assert.match(many, /changed: f0\.md, f1\.md, f2\.md, f3\.md, f4\.md, f5\.md and 9 more$/);
  assert.ok(!HAN.test(many));
});
