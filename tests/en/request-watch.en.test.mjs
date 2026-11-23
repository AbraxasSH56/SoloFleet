// English (locale en) tests of the request watch: "[test]" marker, "(auto-registered) " title, "no deadline".
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/request-watch.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locale } from '../../plugins/personal-inbox/lexicon.mjs';
import { extractRequest, reconcileRequests, AUTO_PREFIX, requestDir, isClickEvent } from '../../plugins/personal-inbox/request-watch.mjs';
import { OWNER_ID } from '../../plugins/personal-inbox/pending-ledger.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const SAFE_ROOT = mkdtempSync(join(tmpdir(), 'rw-en-safe-'));
process.env.OPENCLAW_DATA_ROOT = SAFE_ROOT;
test.after(() => { rmSync(SAFE_ROOT, { recursive: true, force: true }); });
const HAN = /[㐀-鿿＀-￯　-〿]/;
const T0 = Date.parse('2026-11-22T03:00:00Z');
const evt = (message) => ({
  toolName: 'message',
  params: { action: 'send', target: 'channel:2001', message, presentation: { blocks: [{ type: 'buttons', buttons: [{ type: 'button', label: 'Pick 1', allowedUsers: [OWNER_ID] }] }] } },
  result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, messageId: '9001', channelId: '2001' }) }] },
});

test('a request whose first line starts with "[test]" is a test item; the Chinese marker is not read in en', () => {
  assert.equal(extractRequest(evt('[test] Which one?'), { agentId: 'worker-a' }).isTest, true);
  assert.equal(extractRequest(evt('Which one?'), { agentId: 'worker-a' }).isTest, false);
  assert.equal(extractRequest(evt('【测试】选哪个？'), { agentId: 'worker-a' }).isTest, false);
});

test('click words: an inbound text starting with a click word is read as a click, in either language (they identify a button click, so they stay bilingual)', () => {
  assert.equal(AUTO_PREFIX, '(auto-registered) ');
  for (const text of ['clicked: Pick 1', 'selected 2', '点击：选 1', '选择了 1']) assert.equal(isClickEvent({ content: text }, {}), true, text);
  assert.equal(isClickEvent({ content: 'hello there' }, {}), false);
});

test('reconcile: a request nobody registered is registered with the English prefix, "no deadline" and English texts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rw-en-'));
  try {
    const ledger = join(root, 'ledger.json');
    const st = { clock: T0 + 3600 * 1000 };
    const discord = { channelInfo: async () => ({ type: 0, parentId: null }) };
    mkdirSync(requestDir(root), { recursive: true });
    const day = new Date(T0 + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    writeFileSync(join(requestDir(root), `${day}.jsonl`), `${JSON.stringify({ agentId: 'worker-a', text: 'Which one should I pick?', isTest: false, messageId: '9001', channelId: '2001', sentAt: T0 })}\n`);
    const r = await reconcileRequests({ dataRoot: root, ledgerPath: ledger, discord, now: () => st.clock });
    assert.equal(r.registered, 1);
    const it = JSON.parse(readFileSync(ledger, 'utf8')).items[0];
    assert.equal(it.autoRegistered, true);
    assert.equal(it.title, '(auto-registered) Which one should I pick?');
    assert.equal(it.status, 'no-reply');
    assert.equal(it.deadline, null);
    assert.ok(!HAN.test(it.suggestion) && !HAN.test(it.blocks), `${it.suggestion} / ${it.blocks}`);
    assert.ok(it.suggestion.startsWith('(auto-registered by the program'));
    // a button request with no text gets the English default title
    writeFileSync(join(requestDir(root), `${day}.jsonl`), `${JSON.stringify({ agentId: 'worker-a', text: '', isTest: true, messageId: '9002', channelId: '2001', sentAt: T0 })}\n`, { flag: 'a' });
    await reconcileRequests({ dataRoot: root, ledgerPath: ledger, discord, now: () => st.clock });
    const second = JSON.parse(readFileSync(ledger, 'utf8')).items.find((i) => i.requestMessageId === '9002');
    assert.equal(second.title, '(auto-registered) Request with buttons');
    assert.equal(second.isTest, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
