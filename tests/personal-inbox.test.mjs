// Offline tests for personal inbox: temporary directories and fake data only; nothing touches a real deployment.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import plugin from '../plugins/personal-inbox/index.mjs';
import { captureInbox, linkInboxCard, lookupInbox } from '../plugins/personal-inbox/store.mjs';
import { applySyncObligation, registerSyncObligation, verifySyncCard } from '../plugins/personal-inbox/sync.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const storeUrl = pathToFileURL(join(here, '../plugins/personal-inbox/store.mjs')).href;
const syncUrl = pathToFileURL(join(here, '../plugins/personal-inbox/sync.mjs')).href;

function withFixture(run) {
  const fixture = mkdtempSync(join(here, 'personal-inbox-fixture-'));
  const workspace = join(fixture, 'workspace');
  mkdirSync(workspace);
  try {
    return run({ fixture, workspace });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function childCapture(workspace, index) {
  const script = `import { captureInbox } from ${JSON.stringify(storeUrl)};
    const item = captureInbox({ workspaceDir: process.argv[1], kind: 'note', originalText: 'Concurrent note ' + process.argv[2], idempotencyKey: 'message-' + process.argv[2] });
    process.stdout.write(JSON.stringify(item));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, workspace, String(index)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
}

function childRegister(input) {
  const script = `import { registerSyncObligation } from ${JSON.stringify(syncUrl)};
    try { process.stdout.write(JSON.stringify({ ok: true, result: registerSyncObligation(JSON.parse(process.argv[1])) })); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error.message })); }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
}

test('concurrent processes capture distinct notes without lost rows or reused IDs', async () => {
  const fixture = mkdtempSync(join(here, 'personal-inbox-fixture-'));
  const workspace = join(fixture, 'workspace');
  mkdirSync(workspace);
  try {
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => childCapture(workspace, i)));
    assert.equal(new Set(results.map((entry) => entry.item.id)).size, 16);
    assert.ok(results.every((entry) => entry.created && entry.persisted));
    const found = lookupInbox({ workspaceDir: workspace, query: 'Concurrent note', limit: 50 });
    assert.equal(found.items.length, 16);
    assert.equal(new Set(found.items.map((item) => item.originalText)).size, 16);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('capture retries reuse one ID and reject changed content for the same key', () => withFixture(({ workspace }) => {
  const input = { workspaceDir: workspace, kind: 'note', originalText: 'Remember the actual wording', idempotencyKey: 'discord:42:0', sourceRef: 'discord:42' };
  const first = captureInbox(input);
  const repeated = captureInbox(input);
  assert.equal(first.item.id, repeated.item.id);
  assert.equal(repeated.created, false);
  assert.equal(repeated.item.originalText, input.originalText);
  assert.throws(() => captureInbox({ ...input, originalText: 'Different' }), /Idempotency key/);
  assert.equal(lookupInbox({ workspaceDir: workspace, query: 'actual wording' }).items.length, 1);
}));

test('consecutive items keep separate IDs and a missed segment is filled once on retry', () => withFixture(({ workspace }) => {
  const sourceRef = 'discord:channel:message-901';
  const segments = [
    { kind: 'note', originalText: '记下：优先整理桌面软件清单' },
    { kind: 'action', originalText: '下周跟进打印机报价' },
    { kind: 'note', originalText: '保留旧的设备照片' },
  ].map((entry, index) => ({ ...entry, workspaceDir: workspace, sourceRef, idempotencyKey: `${sourceRef}:${index}` }));

  const first = captureInbox(segments[0]);
  const third = captureInbox(segments[2]);
  assert.deepEqual([first.item.id, third.item.id], ['I-0001', 'I-0002']);
  assert.equal(lookupInbox({ workspaceDir: workspace, query: sourceRef }).items.length, 2);

  const repaired = segments.map(captureInbox);
  assert.deepEqual(repaired.map((entry) => entry.created), [false, true, false]);
  assert.deepEqual(repaired.map((entry) => entry.item.id), ['I-0001', 'I-0003', 'I-0002']);
  assert.ok(repaired.every((entry) => entry.persisted));
  assert.deepEqual(repaired.map((entry) => entry.item.originalText), segments.map((entry) => entry.originalText));
  assert.deepEqual(segments.map(captureInbox).map((entry) => entry.created), [false, false, false]);

  const linked = linkInboxCard({ workspaceDir: workspace, id: repaired[1].item.id, workboardCardId: 'test-card-901' });
  assert.equal(linked.linked, true);
  assert.equal(lookupInbox({ workspaceDir: workspace, id: 'I-0003' }).items[0].workboardCardId, 'test-card-901');
  const all = lookupInbox({ workspaceDir: workspace, query: sourceRef });
  assert.equal(all.items.length, 3);
  assert.equal(new Set(all.items.map((item) => item.id)).size, 3);
}));

test('action links only after capture and lookup keeps card progress unverified', () => withFixture(({ workspace }) => {
  const action = captureInbox({ workspaceDir: workspace, kind: 'action', originalText: 'Please follow up on the printer quote', idempotencyKey: 'discord:77:0' });
  const id = action.item.id;
  assert.equal(action.item.workboardCardId, null);
  const linked = linkInboxCard({ workspaceDir: workspace, id, workboardCardId: '7f4a2c10' });
  assert.equal(linked.linked, true);
  assert.equal(linked.cardExistenceVerification, 'unverified');
  assert.equal(linkInboxCard({ workspaceDir: workspace, id, workboardCardId: '7f4a2c10' }).linked, false);
  assert.throws(() => linkInboxCard({ workspaceDir: workspace, id, workboardCardId: '9e4b2c10' }), /already linked/);
  const byId = lookupInbox({ workspaceDir: workspace, id });
  const byWords = lookupInbox({ workspaceDir: workspace, query: 'printer quote' });
  assert.equal(byId.items[0].workboardCardId, '7f4a2c10');
  assert.equal(byWords.items[0].id, id);
  assert.equal(byId.items[0].progressVerification, 'unverified');
  const note = captureInbox({ workspaceDir: workspace, kind: 'note', originalText: 'A static note', idempotencyKey: 'discord:78:0' });
  assert.throws(() => linkInboxCard({ workspaceDir: workspace, id: note.item.id, workboardCardId: '7f4a2c10' }), /Only action/);
}));

test('storage refuses an inbox symlink and tools ignore a caller-supplied workspace path', () => withFixture(({ fixture, workspace }) => {
  const outside = join(fixture, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(workspace, '.inbox'));
  assert.throws(() => captureInbox({ workspaceDir: workspace, kind: 'note', originalText: 'secret', idempotencyKey: 'one' }), /Inbox directory/);
  assert.deepEqual(readdirSync(outside), []);

  const safeWorkspace = join(fixture, 'safe-workspace');
  mkdirSync(safeWorkspace);
  const registered = new Map();
  plugin.register({ registerTool(factory, options) { registered.set(options.name, factory); }, on() {}, registerService() {} });
  const capture = registered.get('personal_inbox_capture').create({ workspaceDir: safeWorkspace, assertInvocationCurrent() {} });
  const output = capture.execute('call-1', { workspaceDir: outside, kind: 'note', originalText: 'safe destination', idempotencyKey: 'two' });
  assert.equal(output.details.persisted, true);
  assert.ok(existsSync(join(safeWorkspace, '.inbox', 'items.sqlite')));
  assert.deepEqual(readdirSync(outside), []);
  const manifest = JSON.parse(readFileSync(join(here, '../plugins/personal-inbox/openclaw.plugin.json'), 'utf8'));
  assert.deepEqual([...registered.keys()], manifest.contracts.tools);
}));

test('document obligations use stable card IDs, compare versions, and read actual target before completion', () => withFixture(({ fixture, workspace }) => {
  const targetPath = join(fixture, 'decision.md');
  writeFileSync(targetPath, 'Before\nUnrelated\n');
  const options = { stateWorkspace: workspace, syncRoot: fixture, cardId: 'card-123456', obligationId: 'decision-update', targetPath, oldText: 'Before', newText: 'After' };
  const first = registerSyncObligation(options);
  assert.equal(first.revision, 1);
  assert.equal(registerSyncObligation(options).created, false);
  assert.equal(verifySyncCard({ stateWorkspace: workspace, syncRoot: fixture, cardId: options.cardId }).verified, false);
  assert.throws(() => applySyncObligation({ ...options, expectedRevision: 2 }), /revision conflict/);
  writeFileSync(targetPath, 'Changed elsewhere\nUnrelated\n');
  assert.throws(() => applySyncObligation({ ...options, expectedRevision: 1 }), /version conflict/);
  assert.equal(readFileSync(targetPath, 'utf8'), 'Changed elsewhere\nUnrelated\n');
  const revised = registerSyncObligation({ ...options, oldText: 'Changed elsewhere', expectedRevision: 1 });
  assert.equal(revised.revision, 2);
  assert.throws(() => registerSyncObligation({ ...options, oldText: 'Changed elsewhere', newText: 'Other', expectedRevision: 1 }), /revision conflict/);
  const applied = applySyncObligation({ ...options, expectedRevision: 2 });
  assert.equal(applied.verified, true);
  assert.equal(readFileSync(targetPath, 'utf8'), 'After\nUnrelated\n');
  const db = new DatabaseSync(join(workspace, '.inbox', 'sync.sqlite'), { readOnly: true });
  try {
    const saved = db.prepare('SELECT revision,base_bytes FROM sync_revisions WHERE card_id=? ORDER BY revision').all(options.cardId);
    assert.deepEqual(saved.map((row) => row.revision), [1, 2]);
    assert.deepEqual(saved.map((row) => Buffer.from(row.base_bytes).toString('utf8')), ['Before\nUnrelated\n', 'Changed elsewhere\nUnrelated\n']);
  } finally { db.close(); }
  assert.equal(verifySyncCard({ stateWorkspace: workspace, syncRoot: fixture, cardId: options.cardId }).verified, true);
  assert.equal(applySyncObligation({ ...options, expectedRevision: 2 }).applied, false);
  writeFileSync(targetPath, 'After\nUnrelated\nFurther edit\n');
  assert.equal(verifySyncCard({ stateWorkspace: workspace, syncRoot: fixture, cardId: options.cardId }).verified, false);
}));

test('competing processes cannot both register revision one for the same obligation', async () => {
  const fixture = mkdtempSync(join(here, 'personal-inbox-fixture-'));
  const workspace = join(fixture, 'workspace');
  mkdirSync(workspace);
  try {
    const targetPath = join(fixture, 'shared.md');
    writeFileSync(targetPath, 'Old');
    const common = { stateWorkspace: workspace, syncRoot: fixture, cardId: 'card-concurrent', obligationId: 'shared', targetPath, oldText: 'Old', expectedRevision: 0 };
    const results = await Promise.all([childRegister({ ...common, newText: 'New A' }), childRegister({ ...common, newText: 'New B' })]);
    assert.equal(results.filter((entry) => entry.ok).length, 1);
    assert.match(results.find((entry) => !entry.ok).error, /revision conflict/);
    const db = new DatabaseSync(join(workspace, '.inbox', 'sync.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_revisions').get().count, 1); }
    finally { db.close(); }
    assert.equal(readFileSync(targetPath, 'utf8'), 'Old');
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('document-sync tools remain without a completion gate', () => withFixture(({ fixture, workspace }) => {
  const targetPath = join(fixture, 'status.md');
  writeFileSync(targetPath, 'Pending\n');
  const hooks = [];
  const registered = new Map();
  plugin.register({
    config: { agents: { entries: { main: { workspace } } } },
    pluginConfig: { syncRoot: fixture },
    registerService() {}, // This fixture exercises tool registration, not Gateway service startup.
    registerTool(factory, options) { registered.set(options.name, factory); },
    on(name, handler, options) { hooks.push({ name, handler, options }); },
    registerService() {},   // the reply card is on by default and registers a service
  });
  const beforeToolCall = hooks.filter((entry) => entry.name === 'before_tool_call');
  assert.equal(beforeToolCall.some((entry) => entry.options?.registrationId === 'document-sync-completion-gate'), false);
  assert.equal(beforeToolCall.some((entry) => (entry.options?.matcher ?? []).includes('workboard_complete')), false);
  assert.equal(beforeToolCall.some((entry) => entry.options?.registrationId === 'controller-openclaw-delegation-only'), true);
  const register = registered.get('personal_inbox_sync_register').create({ workspaceDir: workspace, assertInvocationCurrent() {} });
  const apply = registered.get('personal_inbox_sync_apply').create({ workspaceDir: workspace, assertInvocationCurrent() {} });
  const verify = registered.get('personal_inbox_sync_verify').create({ workspaceDir: workspace, assertInvocationCurrent() {} });
  const args = { cardId: 'card-987654', obligationId: 'status', targetPath, oldText: 'Pending', newText: 'Done', expectedRevision: 0 };
  assert.equal(register.execute('register-1', args).details.revision, 1);
  assert.equal(verify.execute('verify-1', { cardId: args.cardId }).details.verified, false);
  assert.equal(apply.execute('apply-1', { cardId: args.cardId, obligationId: args.obligationId, expectedRevision: 1 }).details.verified, true);
  assert.equal(verify.execute('verify-2', { cardId: args.cardId }).details.verified, true);
}));

test('sync target uses the entire project root and resolves links without escaping it', () => withFixture(({ fixture, workspace }) => {
  const outside = join(here, 'personal-inbox.test.mjs');
  assert.throws(() => registerSyncObligation({ stateWorkspace: workspace, syncRoot: fixture, cardId: 'card-111111', obligationId: 'x', targetPath: outside, newText: 'No' }), /inside the configured project root/);
  const nested = join(fixture, 'worker-a');
  mkdirSync(nested);
  const nestedTarget = join(nested, 'result.md');
  writeFileSync(nestedTarget, 'Old');
  const nestedRegistration = registerSyncObligation({ stateWorkspace: workspace, syncRoot: fixture, cardId: 'card-111111', obligationId: 'worker-result', targetPath: nestedTarget, oldText: 'Old', newText: 'New' });
  assert.equal(nestedRegistration.revision, 1);
  assert.equal(applySyncObligation({ stateWorkspace: workspace, syncRoot: fixture, cardId: 'card-111111', obligationId: 'worker-result', expectedRevision: 1 }).verified, true);
  const real = join(fixture, 'real.md');
  const linked = join(fixture, 'linked.md');
  writeFileSync(real, 'Old');
  symlinkSync(real, linked);
  const registration = registerSyncObligation({ stateWorkspace: workspace, syncRoot: fixture, cardId: 'card-111111', obligationId: 'linked-in-root', targetPath: linked, oldText: 'Old', newText: 'New' });
  assert.equal(registration.revision, 1);
  assert.equal(applySyncObligation({ stateWorkspace: workspace, syncRoot: fixture, cardId: 'card-111111', obligationId: 'linked-in-root', expectedRevision: 1 }).verified, true);
  assert.equal(readFileSync(real, 'utf8'), 'New');
  assert.ok(existsSync(linked));
  symlinkSync(outside, join(fixture, 'linked-outside.md'));
  assert.throws(() => registerSyncObligation({ stateWorkspace: workspace, syncRoot: fixture, cardId: 'card-111111', obligationId: 'external-link', targetPath: join(fixture, 'linked-outside.md'), newText: 'No' }), /inside the configured project root/);
}));
