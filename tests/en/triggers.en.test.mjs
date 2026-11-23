// English (locale en) tests of the two sandbox trigger scripts and the manual file-scan command.
// The trigger scripts cannot import the config: they carry a hand-filled LOCALE constant; here it is the shipped default "en".
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/triggers.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locale } from '../../plugins/personal-inbox/lexicon.mjs';
import { crew } from '../../plugins/personal-inbox/crew-config.mjs';
import { buildScanCommand } from '../../scripts/automation/file-scan-manual.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const HAN = /[㐀-鿿＀-￯　-〿]/;
const NOW = '2026-11-12T12:35:00Z';
const load = (file) => readFileSync(join(ROOT, 'scripts/automation', file), 'utf8').replace(/const TIMEZONE = "[^"]*";/, 'const TIMEZONE = "Asia/Kolkata";')
  .replace(/const NODE_BIN = "[^"]*";/, `const NODE_BIN = ${JSON.stringify(crew.paths.nodeBin)};`).replace(/const CONFIG_FILE = "[^"]*";/, `const CONFIG_FILE = ${JSON.stringify(join(crew.paths.openclawHome, 'openclaw.json'))};`);
async function run(src, exec) {
  let result; const calls = [];
  await new AsyncFunction('exec', 'json', 'FAKE_NOW', src)(async (a) => { calls.push(a.command); return exec(a, calls.length); }, (o) => { result = o; return o; }, NOW);
  return { result, calls };
}
const decodeWrite = (cmd) => Buffer.from(cmd.match(/printf %s '([A-Za-z0-9+/=]*)'/)[1], 'base64').toString('utf8');

test('the shipped trigger scripts default to LOCALE "en"', () => {
  for (const f of ['command-spot-check-trigger.js', 'deep-review-trigger.js']) assert.match(readFileSync(join(ROOT, 'scripts/automation', f), 'utf8'), /^const LOCALE = "en";/m, f);
});

test('command spot-check trigger: result file under audit/daily with English name and header; scan command; brief message', async () => {
  const src = load('command-spot-check-trigger.js');
  let written = null;
  const DR = '/opt/solofleet-data';
  const { result, calls } = await run(src, ({ command }) => {
    if (command.includes('=====ROUNDS')) return { isError: false, aggregated: 'main\t/opt/solofleet/runtime/main\n=====ROUNDS\n=====END\n' };
    if (command.includes('base64')) { written = command; return { isError: false, aggregated: 'WROTE\nSCANOK\n' }; }
    return { isError: false, aggregated: '=====BEGIN\n=====ROLE main\n=====NODIR\n=====AUDIT main arr=1 total=0 known=0 n=0\n=====END\n' };
  });
  assert.equal(result.fire, true);
  assert.ok(calls.some((c) => c.includes(`${DR}/audit/daily`) && c.includes('=====ROUNDS')), 'the daily-audit record folder is read from audit/daily');
  const text = decodeWrite(written);
  assert.ok(text.startsWith('# Command check · 2026-11-12\n\nBusiness date: 2026-11-12\n'), text.slice(0, 80));
  assert.ok(written.includes(`${DR}/audit/daily/2026-11-12-command-check.md`));
  const scanPart = written.slice(written.indexOf('echo WROTE') + 'echo WROTE'.length).replace(/^\n/, '');
  assert.ok(scanPart.includes(`${DR}/audit/daily/2026-11-12-file-reconcile.md`));
  assert.equal(scanPart, buildScanCommand({ bizDate: '2026-11-12' }), 'the manual command is the trigger command, word for word');
  assert.match(result.message, /^command-check file=\/opt\/solofleet-data\/audit\/daily\/2026-11-12-command-check\.md; .*; file-reconcile=generated$/);
});

test('command spot-check trigger: when the result file cannot be written the message says so in English', async () => {
  const src = load('command-spot-check-trigger.js');
  const { result } = await run(src, ({ command }) => {
    if (command.includes('=====ROUNDS')) return { isError: false, aggregated: 'main\t/opt/solofleet/runtime/main\n=====ROUNDS\n=====END\n' };
    if (command.includes('base64')) return { isError: false, aggregated: 'nothing\n' };
    return { isError: false, aggregated: '=====BEGIN\n=====END\n' };
  });
  assert.ok(result.message.startsWith('Command spot-check script: the result file could not be written (/opt/solofleet-data/audit/daily/2026-11-12-command-check.md); '), result.message);
  assert.ok(result.message.endsWith('file-reconcile=not generated; in the daily audit write "command check: records insufficient (the script did not generate it)"'), result.message);
});

test('deep-review trigger: reads audit/anomaly-flags and audit/deep-review', async () => {
  const src = load('deep-review-trigger.js');
  const none = await run(src, () => ({ isError: false, aggregated: 'TOTAL=0\nNONDONE=0\n=====END\n' }));
  assert.deepEqual(none.result, { fire: false });
  assert.ok(none.calls[0].includes('/opt/solofleet-data/audit/anomaly-flags'), none.calls[0]);
  const carry = await run(src, ({ command }) => ({ isError: false, aggregated: command.includes('=====REC') ? '=====REC 2026-11-10\n{"执行":"完成"}\n=====END\n' : 'TOTAL=1\nNONDONE=1\n=====FILE a.json\n{"状态":"深审中 2026-11-10"}\n\n=====END\n' }));
  assert.equal(carry.result.fire, true);
  assert.ok(carry.calls[1].includes('/opt/solofleet-data/audit/deep-review/2026-11-10.json'), carry.calls[1]);
});

test('manual file-scan command: the English path and file name', () => {
  const c = buildScanCommand({ bizDate: '2026-11-12' });
  assert.ok(c.includes('/audit/daily/2026-11-12-file-reconcile.md'));
  assert.ok(!HAN.test(c));
});
