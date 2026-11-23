// Regression for the daily follow-up trigger script (zh-CN): it fires with the old Chinese sentence and stays quiet when nothing is due.
// The script cannot import the config, so the test hands it the test config's locale.
// 每日跟进触发脚本（zh-CN）的回归。运行：SOLOFLEET_CONFIG=tests/fixtures/crew.test.json node --test tests/followups-trigger.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locale } from '../plugins/personal-inbox/lexicon.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const SRC = readFileSync(join(ROOT, 'scripts/followups-trigger.js'), 'utf8').replace(/const LOCALE = "[^"]*";/, `const LOCALE = ${JSON.stringify(locale())};`);
const list = (items) => ({ isError: false, kind: 'text', content: '```json\n' + JSON.stringify({ items }) + '\n```' });
const item = (id, nextReview, extra = {}) => ({ id, nextReview, lastMentionedDate: null, status: 'active', withoutDeadline: false, ...extra });
const run = (items) => new AsyncFunction('read', SRC)(async () => list(items));

test('到期的跟进：叫醒，消息是原来的中文句子', async () => {
  const r = await run([item('F-1', '2020-01-01'), item('F-2', '2020-01-02')]);
  assert.equal(r.fire, true);
  assert.match(r.message, /^FOLLOWUPS\.md 到期候选 2 项（\d{4}-\d{2}-\d{2} UTC）：F-1、F-2。请回读清单并判断提醒价值。$/);
});

test('没有到期的：不叫醒', async () => {
  assert.deepEqual(await run([item('F-1', '2999-01-01')]), { fire: false });
});
