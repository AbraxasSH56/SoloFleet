// Offline tests for approval card: temporary directories and fake data only; nothing touches a real deployment.
// 审批卡说明截断、另发点名。运行：node --test tests/approval-card.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNER_MENTION, APPROVAL_CHANNEL_ID, APPROVAL_DESC_BUDGET, composeApprovalDescription, cpLength, notifyApprovalCard, plainApprovalText,
  resetApprovalNoticeState, sanitizedLength, NOTICE_DEDUP_MS, approvalNoticeText,
} from '../plugins/personal-inbox/approval-card.mjs';
import { OWNER_ID } from '../plugins/personal-inbox/pending-ledger.mjs';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

test('点名编号和 OWNER_ID 相同；审批频道编号和 openclaw.json 里那个一致（写死的常量）', () => {
  assert.equal(OWNER_MENTION, `<@${OWNER_ID}>`);
  assert.equal(APPROVAL_CHANNEL_ID, '100000000000000004');
  assert.equal(APPROVAL_DESC_BUDGET, 480);
});

test('会被官方清理放大的字符先换成普通空格：全角空格、制表符、不换行空格、零宽字符；换行保留', () => {
  const raw = '甲　乙\t丙 丁​戊\n己\u0007庚';
  const plain = plainApprovalText(raw);
  assert.equal(plain, '甲 乙 丙 丁 戊\n己 庚');
  assert.ok(sanitizedLength(raw) > cpLength(raw) * 2, '不先换，官方清理会放大很多');
  assert.equal(sanitizedLength(plain), cpLength(plain), '换过以后清理不再放大');
});

const bigSegments = (what, cards) => [
  { kind: 'keep', text: '什么事：' },
  { kind: 'var', order: 1, min: 20, text: what },
  { kind: 'keep', text: '。批的是什么：只放行桌面角色的这一次屏幕调用（用过就作废，下一项要重新记等确认、重新批）。申请的 bot：桌面角色。来自任务卡：' },
  { kind: 'var', order: 0, min: 20, text: cards },
  { kind: 'keep', text: '；原线程：https://discord.com/channels/100000000000000002/100000000000000122。' },
  { kind: 'tail', text: '桌面角色在线程 100000000000000122 里要继续动屏幕；之后要再做六类操作，桌面角色要先重新记“等确认”、重新批。' },
];

test('说明太长：先砍末尾提示 → 再截任务卡栏 → 再截“什么事”；固定栏（批的是什么、申请的 bot、原线程）始终在；清理后 ≤512', () => {
  const what = '提交'.repeat(150);
  const cards = `这个线程对应多张还没结束的卡（${Array.from({ length: 8 }, (_, i) => `c-${i}《卡名卡名${i}》`).join('、')}），没法确定是哪张（线程 100000000000000122）`;
  const d = composeApprovalDescription(bigSegments(what, cards));
  assert.ok(cpLength(d) <= 480, String(cpLength(d)));
  assert.ok(sanitizedLength(d) <= 512);
  for (const must of ['什么事：', '批的是什么：只放行桌面角色的这一次屏幕调用', '申请的 bot：桌面角色', '来自任务卡：', '原线程：https://discord.com/channels/100000000000000002/100000000000000122']) assert.ok(d.includes(must), must);
  assert.ok(!d.includes('之后要再做六类操作'), '末尾提示先砍');
});

test('不长就一个字不动', () => {
  const segs = bigSegments('提交测试表单', '12345《测试卡》');
  assert.equal(composeApprovalDescription(segs), segs.map((g) => g.text).join(''));
});

test('什么事里带 300 字全角空格、制表符：按官方清理规则算，清理后仍 ≤512 且栏目都在', () => {
  const what = ('提　交\t表 单').repeat(75); // 300 字，每 4 字带 3 个会被放大的字符
  const d = composeApprovalDescription(bigSegments(what, '12345《测试卡》'));
  assert.ok(sanitizedLength(d) <= 512, String(sanitizedLength(d)));
  assert.ok(d.includes('原线程：') && d.includes('批的是什么'));
  assert.equal(sanitizedLength(d), cpLength(d), '最终文字里没有会被放大的字符');
});

test('按码点算（代理对的字 1 个码点）', () => {
  const d = composeApprovalDescription(bigSegments('𠮷'.repeat(400), 'x'));
  assert.ok(cpLength(d) <= 480);
});

test('另发点名：账号 default、目标审批频道、含主人点名、带事由和任务卡号；不阻塞；10 分钟内同一张卡只发一次；换一张卡再发', async () => {
  resetApprovalNoticeState();
  const sent = []; const logs = [];
  const send = async (a) => { sent.push(a); return { ok: true }; };
  let t = 1_000_000;
  assert.equal(notifyApprovalCard({ dedupKey: 'k1', what: '提交测试表单', cardId: 'card-1', source: '桌面角色六类操作', now: () => t, send, log: (r) => logs.push(r) }), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].account, 'default'); assert.equal(sent[0].target, APPROVAL_CHANNEL_ID);
  assert.ok(sent[0].message.startsWith(OWNER_MENTION)); assert.match(sent[0].message, /桌面角色六类操作.*card-1.*提交测试表单/);
  assert.equal(notifyApprovalCard({ dedupKey: 'k1', what: '提交测试表单', cardId: 'card-1', source: '桌面角色六类操作', now: () => t + 1000, send, log: (r) => logs.push(r) }), false);
  assert.equal(sent.length, 1, '同一张卡不重复发');
  assert.equal(notifyApprovalCard({ dedupKey: 'k2', what: '另一项', cardId: 'card-2', source: '桌面角色六类操作', now: () => t + 1000, send }), true);
  assert.equal(notifyApprovalCard({ dedupKey: 'k1', what: '提交测试表单', cardId: 'card-1', source: '桌面角色六类操作', now: () => t + NOTICE_DEDUP_MS + 1, send }), true, '10 分钟后可再发');
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 3);
  assert.notEqual(approvalNoticeText({ what: 'a', cardId: '1', source: 's' }), approvalNoticeText({ what: 'b', cardId: '1', source: 's' }), '每次内容带事由，不会两次一模一样');
});

test('另发失败（返回失败、抛错、同步抛错）：不抛出、只记日志，卡不受影响', async () => {
  resetApprovalNoticeState();
  const logs = [];
  for (const [i, send] of [async () => { throw new Error('网络断了'); }, () => { throw new Error('同步炸了'); }, async () => ({ ok: false, error: '被拒' })].entries()) {
    assert.doesNotThrow(() => notifyApprovalCard({ dedupKey: `f${i}`, what: 'x', source: 's', send, log: (r) => logs.push(r) }));
  }
  await new Promise((r) => setImmediate(r));
  assert.ok(logs.length >= 3);
});

test('没配置另发函数时什么都不发（测试直接调门函数不会误发到真实频道）', () => {
  resetApprovalNoticeState();
  const logs = [];
  assert.equal(notifyApprovalCard({ dedupKey: 'z', what: 'x', source: 's', log: (r) => logs.push(r) }), false);
  assert.equal(logs[0].event, 'approval-notice-skipped');
});

test('接线：index.mjs 给两个门传了 realApprovalSend；P4 测试分支（audit-guard.mjs）没引用本模块', () => {
  const idx = readFileSync(fileURLToPath(new URL('../plugins/personal-inbox/index.mjs', import.meta.url)), 'utf8');
  assert.equal((idx.match(/sendApprovalNotice: realApprovalSend/g) ?? []).length, 2);
  const guard = readFileSync(fileURLToPath(new URL('../plugins/personal-inbox/audit-guard.mjs', import.meta.url)), 'utf8');
  assert.ok(!guard.includes('approval-card'));
});

test('审计②-3 加固：测试环境里（NODE_TEST_CONTEXT 有值）realApprovalSend 不真发，直接返回失败', async () => {
  const { realApprovalSend } = await import('../plugins/personal-inbox/approval-card.mjs');
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node 测试运行器给子进程设了这个变量');
  const r = await realApprovalSend({ account: 'default', target: '100000000000000004', message: '不应发出' });
  assert.equal(r.ok, false);
});

import { mkdtempSync, writeFileSync as _wf, rmSync as _rm } from 'node:fs';
import { tmpdir as _tmp } from 'node:os';
import { join as _join } from 'node:path';

test('去重记在文件里——内存表被清空（等于重新加载了一份模块）后，同一张卡 89 秒内仍只发一次；10 分钟后可再发；换一张卡照发', async () => {
  const dir = mkdtempSync(_join(_tmp(), 'dedup-')); const dedupPath = _join(dir, 'approval-notice-dedup.json');
  try {
    const sent = []; const send = async (a) => { sent.push(a); return { ok: true }; };
    const t = 5_000_000;
    resetApprovalNoticeState();
    assert.equal(notifyApprovalCard({ dedupKey: 'desktop:70ad800fa695b454', what: '提交表单', cardId: 'c1', source: '桌面角色六类操作', now: () => t, send, dedupPath }), true);
    resetApprovalNoticeState(); // 模拟“另一份模块”：内存表是空的
    assert.equal(notifyApprovalCard({ dedupKey: 'desktop:70ad800fa695b454', what: '提交表单', cardId: 'c1', source: '桌面角色六类操作', now: () => t + 89_000, send, dedupPath }), false, '89 秒后第二次：被文件里的记录拦下');
    assert.equal(notifyApprovalCard({ dedupKey: 'desktop:other', what: '另一项', cardId: 'c2', source: '桌面角色六类操作', now: () => t + 89_000, send, dedupPath }), true, '换一张卡照发');
    assert.equal(notifyApprovalCard({ dedupKey: 'desktop:70ad800fa695b454', what: '提交表单', cardId: 'c1', source: '桌面角色六类操作', now: () => t + NOTICE_DEDUP_MS + 1, send, dedupPath }), true, '10 分钟后可再发');
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 3);
  } finally { _rm(dir, { recursive: true, force: true }); }
});

test('去重文件读不懂当空表照发并重写；写不进去（目录不可写）也照发不报错；不给 dedupPath 仍用内存表', async () => {
  const dir = mkdtempSync(_join(_tmp(), 'dedup-')); const dedupPath = _join(dir, 'd.json');
  try {
    const sent = []; const send = async (a) => { sent.push(a); return { ok: true }; };
    _wf(dedupPath, '{坏的');
    assert.equal(notifyApprovalCard({ dedupKey: 'k', what: 'a', cardId: '1', source: 's', now: () => 1000, send, dedupPath }), true);
    assert.equal(notifyApprovalCard({ dedupKey: 'k', what: 'a', cardId: '1', source: 's', now: () => 2000, send, dedupPath }), false, '坏文件被重写后恢复去重');
    _wf(dedupPath, '[1,2]');
    assert.equal(notifyApprovalCard({ dedupKey: 'k9', what: 'a', cardId: '1', source: 's', now: () => 3000, send, dedupPath }), true, '内容不是对象也当空表');
    assert.doesNotThrow(() => notifyApprovalCard({ dedupKey: 'k10', what: 'a', cardId: '1', source: 's', now: () => 4000, send, dedupPath: '/proc/nonexistent/x.json' }));
    resetApprovalNoticeState();
    assert.equal(notifyApprovalCard({ dedupKey: 'm', what: 'a', cardId: '1', source: 's', now: () => 1000, send }), true);
    assert.equal(notifyApprovalCard({ dedupKey: 'm', what: 'a', cardId: '1', source: 's', now: () => 2000, send }), false, '没给 dedupPath：内存表照旧');
  } finally { _rm(dir, { recursive: true, force: true }); }
});
