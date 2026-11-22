// Offline tests for the reply card's default state: on, with the quota line off. Fake plugin API and fake data only; nothing touches a real deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerExecutionRecord } from '../plugins/personal-inbox/execution-record.mjs';
import { cardText } from '../plugins/personal-inbox/lexicon.mjs';

function fakeApi(pluginConfig) {
  const hooks = {}, services = [];
  const api = {
    ...(pluginConfig === undefined ? {} : { pluginConfig }),
    config: { agents: { entries: {} } },
    on: (name, fn) => { hooks[name] = fn; },
    registerService: s => services.push(s),
    runtime: { events: { onAgentEvent: () => () => {} } },
  };
  return { api, hooks, services };
}
const boom = () => { throw new Error('quota source must not be created when quotaSource is off'); };
const reply = (runId, usageState, text = 'All done.') => ({ channel: 'discord', kind: 'final', runId, payload: { text }, usageState });
const descOf = res => res.payload.channelData.discord.embeds.at(-1).description;

test('default: no executionRecord config at all → the card is on and quota is off (no CodexBar, no credential path)', async () => {
  const f = fakeApi();                       // no pluginConfig whatsoever
  registerExecutionRecord(f.api, { makeCliQuotaSource: boom });
  assert.equal(typeof f.hooks.reply_payload_sending, 'function');
  const res = await f.hooks.reply_payload_sending(reply('default-1', { resolvedRef: 'claude-cli/claude-sonnet-5-5', reasoningEffort: 'high' }), { agentId: 'main' });
  assert(res, 'the card is attached by default');
  const lines = descOf(res).split('\n');
  assert.equal(lines.length, 2, `model line + change line only, got: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /Sonnet/);
  assert.match(lines[0], /high/);
  assert.match(lines[1], new RegExp(cardText().changeLabel.trim().slice(0, 4)));
  const T = cardText();
  assert.doesNotMatch(descOf(res), new RegExp(T.quotaUnavailable.slice(0, 6)));
  for (const w of ['Quota', '额度', 'CodexBar']) assert.equal(descOf(res).includes(w), false, `no quota text (${w}) in the default card`);
  await f.services[0]?.start?.();
  await f.services[0]?.stop?.();
});

test('default with an empty executionRecord object (only options given): still on, quota still off', async () => {
  const f = fakeApi({ executionRecord: {} });
  registerExecutionRecord(f.api, { makeCliQuotaSource: boom });
  const res = await f.hooks.reply_payload_sending(reply('default-2', { resolvedRef: 'claude-cli/claude-opus-5-5', reasoningEffort: 'medium' }), {});
  assert(res);
  assert.equal(descOf(res).split('\n').length, 2);
});

test('explicit quotaSource off, or cli without a credential path, behaves the same: no quota line, no error', async () => {
  for (const executionRecord of [{ enabled: true, quotaSource: 'off' }, { quotaSource: 'cli' }]) {
    const f = fakeApi({ executionRecord });
    registerExecutionRecord(f.api, { makeCliQuotaSource: boom });
    const res = await f.hooks.reply_payload_sending(reply(`explicit-${JSON.stringify(executionRecord)}`, { resolvedRef: 'claude-cli/claude-sonnet-5-5', reasoningEffort: 'low' }), {});
    assert(res);
    assert.equal(descOf(res).split('\n').length, 2);
  }
});

test('the card still shows model and effort as unknown (not an error) when the host sends no usage state', async () => {
  const f = fakeApi();
  registerExecutionRecord(f.api, { makeCliQuotaSource: boom });
  const res = await f.hooks.reply_payload_sending(reply('default-3', undefined), {});
  assert(res);
  assert.equal(descOf(res).split('\n').length, 2);
});

test('opt-out: executionRecord.enabled=false registers nothing', () => {
  const f = fakeApi({ executionRecord: { enabled: false } });
  registerExecutionRecord(f.api, { makeCliQuotaSource: boom });
  assert.deepEqual(Object.keys(f.hooks), []);
  assert.equal(f.services.length, 0);
});

test('API-credit route with quota off: the route note stays (it is route info, not a CodexBar reading)', async () => {
  const f = fakeApi();
  registerExecutionRecord(f.api, { makeCliQuotaSource: boom });
  const res = await f.hooks.reply_payload_sending(reply('default-4', { resolvedRef: 'anthropic-api/claude-sonnet-5-5', reasoningEffort: 'high' }), {});
  assert(res);
  assert.match(descOf(res), new RegExp(cardText().quotaApi.slice(0, 6)));
});
