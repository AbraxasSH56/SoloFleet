// Offline tests for channel exclusions: temporary directories and fake data only; nothing touches a real deployment.
// 排除频道配置位。运行：node --test tests/channel-exclusions.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChannelExclusions, isCompletionExcluded, isReminderExcluded, exclusionsPath, WORKSHOP_CHANNEL_ID } from '../plugins/personal-inbox/channel-exclusions.mjs';
import { WORKSHOP_CHANNEL } from '../plugins/personal-inbox/pending-ledger.mjs';

const withRoot = (content) => {
  const root = mkdtempSync(join(tmpdir(), 'excl-'));
  mkdirSync(join(root, 'plugins', 'personal-inbox'), { recursive: true });
  if (content !== undefined) writeFileSync(join(root, 'plugins', 'personal-inbox', 'channel-exclusions.json'), content);
  return root;
};

test('茶会编号和 pending-ledger 里那个一致；路径用 syncRoot 拼', () => {
  assert.equal(WORKSHOP_CHANNEL_ID, WORKSHOP_CHANNEL);
  assert.equal(exclusionsPath('/x/y'), '/x/y/plugins/personal-inbox/channel-exclusions.json');
  assert.equal(exclusionsPath(null), null);
});

test('读到文件：两个列表各自生效；完成记录里茶会永远排除；待批提醒列表可空', () => {
  const root = withRoot(JSON.stringify({ completionNotice: ['100000000000000133'], approvalReminder: ['100000000000000134'] }));
  try {
    assert.equal(isCompletionExcluded(root, '100000000000000133'), true);
    assert.equal(isCompletionExcluded(root, WORKSHOP_CHANNEL_ID), true, '茶会写死兜底');
    assert.equal(isCompletionExcluded(root, '100000000000000134'), false, '两个列表互不串');
    assert.equal(isReminderExcluded(root, '100000000000000134'), true);
    assert.equal(isReminderExcluded(root, '100000000000000133'), false);
    assert.equal(isReminderExcluded(root, WORKSHOP_CHANNEL_ID), false, '待批提醒这边先放空：茶会不排除');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('读不到、写坏、字段不对、syncRoot 缺失：按空表处理，完成记录仍排除茶会；每次重新读（改了立刻生效）', () => {
  const none = withRoot(undefined), bad = withRoot('{坏的'), wrong = withRoot(JSON.stringify({ completionNotice: '不是数组', approvalReminder: [1, 'abc', null, '100000000000000135'] }));
  try {
    for (const root of [none, bad, null, undefined]) {
      assert.equal(isCompletionExcluded(root, WORKSHOP_CHANNEL_ID), true);
      assert.equal(isCompletionExcluded(root, '100000000000000136'), false);
      assert.equal(isReminderExcluded(root, '100000000000000136'), false);
    }
    const w = loadChannelExclusions(wrong);
    assert.equal(w.reminder.has('100000000000000135'), true); assert.equal(w.reminder.has('abc'), false, 'numeric IDs only'); assert.equal(w.reminder.size, 2, 'file ID plus the lounge from config');
    writeFileSync(join(none, 'plugins', 'personal-inbox', 'channel-exclusions.json'), JSON.stringify({ approvalReminder: ['100000000000000137'] }));
    assert.equal(isReminderExcluded(none, '100000000000000137'), true, '不缓存');
  } finally { for (const r of [none, bad, wrong]) rmSync(r, { recursive: true, force: true }); }
});

test('shipped channel-exclusions.json is valid JSON with two (empty) lists', () => {
  const p = fileURLToPath(new URL('../plugins/personal-inbox/channel-exclusions.json', import.meta.url));
  const d = JSON.parse(readFileSync(p, 'utf8'));
  assert.deepEqual(d.completionNotice, []);
  assert.deepEqual(d.approvalReminder, []);
});

test('config excludedChannels apply even without a file; the workshop is always excluded from completion notices but not from reminders', () => {
  const CHAT = '100000000000000005';
  const none = withRoot(undefined);
  try {
    assert.equal(isCompletionExcluded(none, CHAT), true, 'lounge is listed in the test config');
    assert.equal(isReminderExcluded(none, CHAT), true);
    assert.equal(isCompletionExcluded(none, WORKSHOP_CHANNEL_ID), true);
    assert.equal(isReminderExcluded(none, WORKSHOP_CHANNEL_ID), false, 'the controller is reminded in the workshop');
  } finally { rmSync(none, { recursive: true, force: true }); }
});
