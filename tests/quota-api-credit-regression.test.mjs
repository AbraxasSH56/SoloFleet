// Offline tests for quota api credit regression: temporary directories and fake data only; nothing touches a real deployment.
// 备用 bot 批 L7 回归测试：API 额度用完（官方账单类原句）不会被"额度补跑"当成订阅额度问题去补跑；订阅额度原句仍照常触发。
// 离线：只喂句子和假的官方命令输出，不碰真实任务、不发任何消息。运行：node --test tests/quota-api-credit-regression.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isQuotaSentence } from '../plugins/personal-inbox/quota-recovery.mjs';
import { classify, runCatchup } from '../scripts/automation/quota-catchup.mjs';

const BR = (s) => Date.parse(`${s}+05:30`);
const JOB = '00000000-0000-4000-8000-000000000001';
const OWN = 'aaaaaaaa-0000-0000-0000-000000000001';
const SCHEDULE = { kind: 'cron', expr: '5 18 * * *', tz: 'Asia/Kolkata', staggerMs: 0 };
const API_CREDIT = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
const SUBSCRIPTION = "You've hit your 5-hour limit · resets 11pm (Asia/Kolkata)";

test('识别函数：API 余额用完原句不是订阅额度句；订阅原句仍是', () => {
  assert.equal(isQuotaSentence(API_CREDIT), false);
  assert.equal(isQuotaSentence(`rate limited: ${API_CREDIT}`), false);
  assert.equal(isQuotaSentence(SUBSCRIPTION), true);
  assert.equal(isQuotaSentence(null), false);
});

test('classify：API 余额用完的失败（不管官方归成 billing 还是 rate_limit）算"别的原因"，不算 quota；订阅原句算 quota', () => {
  for (const errorReason of ['billing', 'rate_limit']) {
    const r = classify({ status: 'error', error: API_CREDIT, errorReason, runId: 'x' });
    assert.equal(r.kind, 'other', errorReason);
  }
  assert.equal(classify({ status: 'error', error: SUBSCRIPTION, errorReason: 'rate_limit', runId: 'x' }).kind, 'quota');
});

function world(error) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'catchup-api-'));
  const w = { dataRoot, t: BR('2026-11-10T23:01:00'), calls: [] };
  w.deps = {
    now: () => w.t,
    listJobs: () => [
      { id: JOB, name: '日审', enabled: true, schedule: SCHEDULE, payload: { model: 'anthropic-api/claude-sonnet-5-5' }, state: { nextRunAtMs: BR('2026-11-11T18:05:00'), runningAtMs: null } },
      { id: OWN, name: '额度补跑', enabled: true, schedule: { kind: 'every', everyMs: 600000 }, payload: {}, state: { runningAtMs: null } },
    ],
    listRuns: (id) => (id === JOB ? [w.failure] : []),
    runJob: (id) => { w.calls.push(id); return JSON.stringify({ ok: true, runId: `cron:${id}:${w.t}:slot` }); },
    codexbar: () => null,
  };
  const failMs = BR('2026-11-10T18:05:00');
  w.failure = { ts: failMs + 60000, jobId: JOB, action: 'finished', status: 'error', error, runId: `cron:${JOB}:${failMs}:slot`, runAtMs: failMs, durationMs: 60000, errorReason: 'billing', model: 'claude-sonnet-5-5' };
  mkdirSync(join(dataRoot, '运行记录', '额度', '计划存档'), { recursive: true });
  writeFileSync(join(dataRoot, '运行记录', '额度', '计划存档', `${JOB}-${failMs}.json`), JSON.stringify({ 任务编号: JOB, 任务名: '日审', 开始时间毫秒: failMs, 计划: SCHEDULE }));
  w.done = () => rmSync(dataRoot, { recursive: true, force: true });
  return w;
}

test('额度补跑整条流程：任务因 API 余额用完失败 → 不发起补跑、不建补跑账、不通知；同样的情形换成订阅原句 → 照常发起一次', () => {
  const api = world(API_CREDIT);
  try {
    assert.deepEqual(runCatchup({ dataRoot: api.dataRoot, deps: api.deps }), []);
    api.t += 1800000;
    assert.deepEqual(runCatchup({ dataRoot: api.dataRoot, deps: api.deps }), []);
    assert.equal(api.calls.length, 0, 'API 余额用完不补跑');
    assert.equal(existsSync(join(api.dataRoot, '运行记录', '补跑', '日审-2026-11-10.json')), false, '不建补跑账');
  } finally { api.done(); }
  const sub = world(SUBSCRIPTION);
  try {
    runCatchup({ dataRoot: sub.dataRoot, deps: sub.deps });
    assert.equal(sub.calls.length, 1, '订阅额度句仍触发一次补跑');
  } finally { sub.done(); }
});
