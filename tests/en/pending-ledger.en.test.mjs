// English (locale en) tests of the pending-decision ledger and its two tools: status words, source, kinds, deadline word.
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/pending-ledger.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locale } from '../../plugins/personal-inbox/lexicon.mjs';
import {
  OWNER_ID, APPROVAL_EXPIRED_SOURCE, APPROVAL_EXPIRY_MS, withLedger, registerItem, updateItem, readLedgerFile, buildTable, recordApprovalExpiry, recordApprovalReissue, isApprovalExpiry,
} from '../../plugins/personal-inbox/pending-ledger.mjs';
import { registerPendingTools, updateParameters, registerParameters } from '../../plugins/personal-inbox/pending-tools.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const T0 = Date.parse('2026-11-12T00:00:00Z');
const HAN = /[㐀-鿿＀-￯　-〿]/;
const mk = () => { const dir = mkdtempSync(join(tmpdir(), 'pend-en-')); return { dir, path: join(dir, 'ledger.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }; };
const reg = (t, extra = {}) => withLedger(t.path, (L) => ({ r: registerItem(L, { title: 'Option A or B?', suggestion: 'A', blocks: 'X', requestMessageId: `rq${Math.random()}`, requestLink: 'L', botId: '99', ...extra }, T0) }));

test('a new item starts as "no-reply"; "no deadline" means no deadline', async () => {
  const t = mk();
  const a = await reg(t, { deadline: 'no deadline' });
  assert.equal(a.r.item.status, 'no-reply');
  assert.equal(a.r.item.deadline, null);
  const b = await reg(t, { deadline: '2026-11-20T00:00:00Z' });
  assert.equal(b.r.item.deadline, '2026-11-20T00:00:00Z');
  t.cleanup();
});

test('update: received (with a date) / decided / revoked; the Chinese status words are refused in en', async () => {
  const t = mk();
  const { r } = await reg(t, { requestMessageId: 'M1', threadId: 'T1' });
  const msg = (id, content = 'a reply') => ({ id, authorId: OWNER_ID, replyToId: 'M1', channelId: 'T1', content });
  const upd = (args, message) => withLedger(t.path, (L) => { const res = updateItem(L, { id: r.item.id, source: message?.id ?? 'x', ...args }, message, T0 + 1000); return res.error ? { noWrite: true, error: res.error } : { item: res.item }; });
  const bad = await upd({ status: '收到' }, msg('m1'));
  assert.match(bad.error, /received／decided／revoked／no-reply/);
  const a = await upd({ status: 'received', recheckDate: '2026-11-19' }, msg('m1'));
  assert.equal(a.item.status, 'received'); assert.equal(a.item.recheckDate, '2026-11-19');
  const b = await upd({ status: 'decided', decision: 'go with A' }, msg('m2'));
  assert.equal(b.item.status, 'decided'); assert.equal(b.item.decision, 'go with A');
  const { r: r2 } = await reg(t, { requestMessageId: 'M2', threadId: 'T2' });
  const c = await withLedger(t.path, (L) => { const res = updateItem(L, { id: r2.item.id, status: 'revoked', source: 'm3' }, { id: 'm3', authorId: OWNER_ID, replyToId: null, channelId: 'T2', content: 'drop it' }, T0 + 2000); return res.error ? { noWrite: true, error: res.error } : { item: res.item }; });
  assert.equal(c.item.status, 'revoked');
  t.cleanup();
});

test('an auto-registered item: only "revoked" with a basis, and no owner message is needed', async () => {
  const t = mk();
  const { r } = await reg(t, { requestMessageId: 'M9', autoRegistered: true });
  const go = (args) => withLedger(t.path, (L) => { const res = updateItem(L, { id: r.item.id, source: 'none', ...args }, null, T0); return res.error ? { noWrite: true, error: res.error } : { item: res.item }; });
  assert.ok((await go({ status: 'revoked' })).error, 'basis is required');
  assert.ok((await go({ status: 'decided', decision: 'x', basis: 'b' })).error, 'cannot be used to decide');
  assert.equal((await go({ status: 'revoked', basis: 'he already clicked the button' })).item.status, 'revoked');
  t.cleanup();
});

test('approval expiry: source "approval-expired", kinds "closing-confirmation" / "desktop-six-actions", id prefix "approval:"', async () => {
  const t = mk();
  assert.equal(APPROVAL_EXPIRED_SOURCE, 'approval-expired');
  const info = (extra = {}) => ({ kind: 'desktop-six-actions', what: 'submit form: click "Submit" in Safari', cardId: 'card-9', threadId: '100000000000000100', link: 'https://x/y', ...extra });
  await recordApprovalExpiry(t.path, info(), { now: () => T0 });
  await recordApprovalExpiry(t.path, info({ kind: 'closing-confirmation', cardId: 'card-7', what: 'close', expiredAt: T0 + 5 }), { now: () => T0 });
  const items = readLedgerFile(t.path).items;
  assert.equal(items.length, 2);
  const [d, c] = items;
  assert.equal(d.source, 'approval-expired'); assert.equal(d.kind, 'desktop-six-actions'); assert.equal(d.status, 'no-reply'); assert.equal(d.deadlineAt, T0 + APPROVAL_EXPIRY_MS);
  assert.match(d.requestMessageId, /^approval:desktop:card-9:/);
  assert.match(c.requestMessageId, /^approval:closing:card-7:/);
  assert.ok(isApprovalExpiry(d));
  // a new approval card for the same thing closes the item as "decided"
  await recordApprovalReissue(t.path, { kind: 'closing-confirmation', cardId: 'card-7' }, { now: () => T0 + 10 });
  const after = readLedgerFile(t.path).items;
  assert.equal(after.find((i) => i.cardId === 'card-7').status, 'decided');
  assert.equal(after.find((i) => i.cardId === 'card-9').status, 'no-reply');
  t.cleanup();
});

test('master table text uses the English status word', async () => {
  const t = mk();
  const { r } = await reg(t, { requestMessageId: 'M1', threadId: 'T1' });
  await withLedger(t.path, (L) => { const res = updateItem(L, { id: r.item.id, status: 'received', recheckDate: '2026-11-19', source: 'm' }, { id: 'm', authorId: OWNER_ID, replyToId: 'M1', channelId: 'T1', content: 'ok' }, T0); return res.error ? { noWrite: true } : { item: res.item }; });
  const text = JSON.stringify(buildTable(readLedgerFile(t.path), T0));
  assert.ok(text.includes('received (2026-11-19 再看)') || text.includes('received（'), text.slice(0, 300));
  t.cleanup();
});

test('the two ledger tools: English descriptions, English status enum', () => {
  assert.deepEqual(updateParameters.properties.status.enum, ['received', 'decided', 'revoked', 'no-reply']);
  for (const p of [...Object.values(registerParameters.properties), ...Object.values(updateParameters.properties)]) if (p.description) assert.ok(!HAN.test(p.description), p.description);
  const tools = [];
  registerPendingTools({ registerTool: (def) => tools.push(def) }, { ledgerPath: null });
  const made = tools.map((d) => d.create({ agentId: 'main' }));
  assert.deepEqual(made.map((m) => m.name), ['pending_decision_register', 'pending_decision_update']);
  for (const m of made) assert.ok(!HAN.test(m.description), m.description);
  assert.ok(made[0].description.startsWith('Register a matter that needs the owner'));
  assert.ok(registerParameters.properties.deadline.description.includes('"no deadline"'));
  assert.ok(updateParameters.properties.source.description.includes('"(auto-registered)"'));
});
