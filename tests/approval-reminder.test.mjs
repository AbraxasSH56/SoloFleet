// Offline tests for approval reminder: temporary directories and fake data only; nothing touches a real deployment.
// 总控提醒待批（before_prompt_build）。运行：node --test tests/approval-reminder.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApprovalReminder, registerApprovalReminder, REMIND_INTERVAL_MS, remindStatePathOf, reminderText } from '../plugins/personal-inbox/approval-reminder.mjs';
import { withLedger, registerApprovalExpiry, registerItem, OWNER_ID, WORKSHOP_CHANNEL } from '../plugins/personal-inbox/pending-ledger.mjs';

const T0 = Date.parse('2026-11-18T00:00:00Z'); const H = 3600000;
const CTX = { agentId: 'main', trigger: 'user', channelId: WORKSHOP_CHANNEL, senderId: OWNER_ID };
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'remind-')); const ledgerPath = join(dir, '审计', '等你定', '台账.json');
  await withLedger(ledgerPath, (L) => registerApprovalExpiry(L, { kind: '桌面角色六类操作', what: '提交表单', cardId: 'card-1', threadId: '100000000000000114', link: 'https://discord.com/channels/1/100000000000000114', expiredAt: T0 }, T0), { now: () => T0 });
  return { dir, ledgerPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('有待批 → 返回 appendContext（含标题、任务卡、原线程）并写提醒记录；6 小时内第二次不返回；满 6 小时再返回', async () => {
  const s = await setup(); let t = T0 + H;
  try {
    const hook = createApprovalReminder({ ledgerPath: s.ledgerPath, now: () => t });
    const r1 = hook({}, CTX);
    assert.ok(r1?.appendContext); assert.match(r1.appendContext, /1 件审批过期没批/); assert.match(r1.appendContext, /提交表单/); assert.match(r1.appendContext, /card-1/); assert.match(r1.appendContext, /100000000000000114/);
    assert.match(r1.appendContext, /不要单独发消息/); assert.match(r1.appendContext, /知道了/);
    assert.ok(existsSync(remindStatePathOf(s.ledgerPath)));
    t += 5 * H; assert.equal(hook({}, CTX), undefined, '6 小时内不再塞');
    t += H + 1; assert.ok(hook({}, CTX)?.appendContext, '满 6 小时再塞');
    assert.equal(REMIND_INTERVAL_MS, 6 * H);
  } finally { s.cleanup(); }
});

test('新增一件 → 只带新件；没有待批 → 空；已撤销／已定／已过截止的不算', async () => {
  const s = await setup(); let t = T0 + H;
  try {
    const hook = createApprovalReminder({ ledgerPath: s.ledgerPath, now: () => t });
    assert.ok(hook({}, CTX)); t += 2 * H;
    await withLedger(s.ledgerPath, (L) => registerApprovalExpiry(L, { kind: '结案确认', what: '结案', cardId: 'card-2', threadId: '1', expiredAt: t }, t), { now: () => t });
    const r = hook({}, CTX);
    assert.match(r.appendContext, /1 件审批过期没批/); assert.match(r.appendContext, /card-2/); assert.ok(!r.appendContext.includes('card-1'), '旧的那件 6 小时内不重复');
    await withLedger(s.ledgerPath, (L) => { for (const it of L.items) it.status = '已定'; }, { now: () => t });
    t += 7 * H; assert.equal(hook({}, CTX), undefined, '都已定：空');
    await withLedger(s.ledgerPath, (L) => { L.items[0].status = '没回'; L.items[0].deadlineAt = t - 1; }, { now: () => t });
    assert.equal(hook({}, CTX), undefined, '过了截止的不算');
  } finally { s.cleanup(); }
});

test('条件写死——非总控、非用户触发、非茶会（含线程）、发话人不是主人、频道在排除列表 → 空；没有发话人字段 → 放行', async () => {
  const s = await setup();
  try {
    const hook = createApprovalReminder({ ledgerPath: s.ledgerPath, now: () => T0 + H });
    for (const bad of [{ agentId: 'worker-a' }, { trigger: 'cron' }, { trigger: 'heartbeat' }, { channelId: '100000000000000114' }, { channelId: undefined }, { senderId: '100000000000000012' }]) {
      assert.equal(hook({}, { ...CTX, ...bad }), undefined, JSON.stringify(bad));
    }
    assert.ok(hook({}, { ...CTX, senderId: undefined }), '没有发话人字段：放行');
    // 排除列表
    const root = mkdtempSync(join(tmpdir(), 'remind-root-')); mkdirSync(join(root, 'plugins', 'personal-inbox'), { recursive: true });
    writeFileSync(join(root, 'plugins', 'personal-inbox', 'channel-exclusions.json'), JSON.stringify({ approvalReminder: [WORKSHOP_CHANNEL] }));
    try {
      const h2 = createApprovalReminder({ ledgerPath: s.ledgerPath, syncRoot: root, now: () => T0 + H, statePath: join(s.dir, 'state2.json') });
      assert.equal(h2({}, CTX), undefined, '排除列表里的频道不塞');
    } finally { rmSync(root, { recursive: true, force: true }); }
  } finally { s.cleanup(); }
});

test('出错全吞（台账读不了、提醒记录写不了）→ 返回空不抛错；普通"等你定"条目不触发提醒；没有 ledgerPath 什么都不做', async () => {
  const s = await setup(); const logs = [];
  try {
    const bad = createApprovalReminder({ ledgerPath: s.ledgerPath, now: () => T0 + H, readLedger: () => { throw new Error('台账坏了'); }, log: (r) => logs.push(r) });
    assert.doesNotThrow(() => bad({}, CTX)); assert.equal(bad({}, CTX), undefined); assert.ok(logs.some((l) => l.event === 'approval-reminder-error'));
    const noWrite = createApprovalReminder({ ledgerPath: s.ledgerPath, now: () => T0 + H, statePath: '/proc/nonexistent/x.json' });
    assert.equal(noWrite({}, CTX), undefined, '提醒记录写不了：不抛错（这一轮不塞，宁可少塞不乱塞）');
    await withLedger(s.ledgerPath, (L) => { L.items[0].status = '已定'; registerItem(L, { title: '普通一件', suggestion: 's', blocks: 'b', requestMessageId: 'N1' }, T0); }, { now: () => T0 });
    const hook = createApprovalReminder({ ledgerPath: s.ledgerPath, now: () => T0 + H });
    assert.equal(hook({}, CTX), undefined, '普通等你定条目不触发这个提醒');
    assert.equal(createApprovalReminder({ ledgerPath: null })({}, CTX), undefined);
  } finally { s.cleanup(); }
});

test('注册——before_prompt_build、registrationId approval-reminder；没有台账路径就不注册；提醒文字不让她替他批', () => {
  const regs = []; const api = { on: (name, fn, opts) => regs.push({ name, fn, opts }) };
  registerApprovalReminder(api, { ledgerPath: '/x/台账.json' });
  assert.equal(regs.length, 1); assert.equal(regs[0].name, 'before_prompt_build'); assert.equal(regs[0].opts.registrationId, 'approval-reminder');
  registerApprovalReminder(api, {}); assert.equal(regs.length, 1);
  assert.match(reminderText([{ title: 't' }]), /你不要替他批/);
});

test('S0 记录：注入时日志里记发话人字段有没有值和 inputProvenance', async () => {
  const s = await setup(); const logs = [];
  try {
    const hook = createApprovalReminder({ ledgerPath: s.ledgerPath, now: () => T0 + H, log: (r) => logs.push(r) });
    hook({}, { ...CTX, inputProvenance: { kind: 'external_user' } });
    assert.equal(logs[0].senderIdPresent, true); assert.equal(logs[0].senderIsOwner, true); assert.equal(logs[0].trigger, 'user'); assert.match(logs[0].inputProvenance, /external_user/);
    const s2 = createApprovalReminder({ ledgerPath: s.ledgerPath, now: () => T0 + 8 * H, log: (r) => logs.push(r) });
    s2({}, { ...CTX, senderId: undefined });
    assert.equal(logs.at(-1).senderIdPresent, false); assert.equal(logs.at(-1).senderIsOwner, null);
  } finally { s.cleanup(); }
});
