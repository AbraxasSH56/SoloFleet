// English (locale en) tests of the help-request texts, the help markers, the desktop queue texts and the approval reminder.
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/stuck-guard.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locale } from '../../plugins/personal-inbox/lexicon.mjs';
import { HELP_FORMAT, BLOCK_ASK_HELP, BLOCK_AFTER_HELP, isHelpRequestText, isHelpReplyText, TASK_AUDITOR_MENTION } from '../../plugins/personal-inbox/stuck-guard.mjs';
import { SKIP_WHY, notifyText, skipQueued } from '../../plugins/personal-inbox/desktop-lock.mjs';
import { reminderText } from '../../plugins/personal-inbox/approval-reminder.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const HAN = /[㐀-鿿＀-￯　-〿]/;

test('help request and reply markers', () => {
  assert.equal(isHelpRequestText(`${TASK_AUDITOR_MENTION} stuck`), true, 'a mention of the task auditor counts');
  assert.equal(isHelpRequestText('[Help request]\nSymptom: x'), true);
  assert.equal(isHelpRequestText('  [Help request] x'), true);
  assert.equal(isHelpRequestText('【求助】现象：x'), false, 'the Chinese marker is not read in en');
  assert.equal(isHelpReplyText('[Help reply] try again'), true);
  assert.equal(isHelpReplyText('[Help request] x'), false);
  assert.equal(isHelpReplyText('【求助回复】x'), false);
});

test('the instruction texts are English and carry the English marker', () => {
  for (const s of [HELP_FORMAT, BLOCK_ASK_HELP, BLOCK_AFTER_HELP]) assert.ok(!HAN.test(s), s);
  assert.ok(HELP_FORMAT.includes(TASK_AUDITOR_MENTION));
  assert.ok(HELP_FORMAT.includes('\n[Help request]\nSymptom:'));
  assert.ok(BLOCK_ASK_HELP.includes(HELP_FORMAT) && BLOCK_ASK_HELP.startsWith('The same step has now failed twice in a row.'));
  assert.ok(BLOCK_AFTER_HELP.includes('Write "Stuck:" in the thread'));
  assert.ok(isHelpRequestText(HELP_FORMAT.split('\n')[1]), 'the marker line inside the format is itself recognised');
});

test('queue skip reasons are English words without spaces', () => {
  assert.deepEqual(SKIP_WHY, ['not-needed', 'done', 'taken-over']);
  const dir = mkdtempSync(join(tmpdir(), 'dl-en-'));
  try {
    const lockPath = join(dir, 'screen.lock');
    const r = skipQueued({ lockPath, threadId: '100000000000000100', why: '不用了', settingsPath: join(dir, 's.json'), queuePath: join(dir, 'q.json') });
    assert.equal(r.ok, false);
    assert.equal(r.message, '--why must be one of "not-needed", "done", "taken-over". The list was not changed.');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('"your turn" notices to the desktop operator and to a requester are English and use the English words', () => {
  const hold = { requester: '100000000000000001', queuedAt: Date.parse('2026-11-22T10:00:00Z'), queueNo: 7, threadId: '100000000000000100' };
  const owner = notifyText(hold, 15);
  assert.ok(!HAN.test(owner), owner);
  assert.ok(owner.includes('skip --thread 100000000000000100 --why not-needed'), owner);
  assert.ok(owner.includes('do not mention the Controller'));
  const other = notifyText({ ...hold, requester: '100000000000000055' }, 15);
  assert.ok(!HAN.test(other), other);
  assert.ok(other.includes('"Current status"') && other.includes('say "not-needed"'), other);
  assert.ok(other.startsWith('<@100000000000000055> It is your turn'));
});

test('approval reminder inserted into the controller turn: English marker and instructions', () => {
  const t = reminderText([{ title: 'Close card 7', cardId: 'card-7', link: 'https://x/y' }, { title: 'Submit the form' }]);
  assert.ok(!HAN.test(t), t);
  const lines = t.split('\n');
  assert.equal(lines[0], "[Pending-approval reminder — added by the program, not the owner's words] There are 2 approvals that expired unapproved; those matters are still stopped:");
  assert.equal(lines[1], '1. Close card 7 (task card card-7), original thread https://x/y');
  assert.equal(lines[2], '2. Submit the form');
  assert.equal(lines.length, 6);
});
