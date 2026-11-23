// Offline tests for file scan manual: temporary directories and fake data only; nothing touches a real deployment.
// 手动对账命令和日审触发脚本里的对账命令必须逐字相同。运行：node --test tests/file-scan-manual.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crew } from '../plugins/personal-inbox/crew-config.mjs';
import { buildScanCommand } from '../scripts/automation/file-scan-manual.mjs';
import { locale } from '../plugins/personal-inbox/lexicon.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAGED = join(ROOT, 'scripts', 'automation', 'command-spot-check-trigger.js');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let src = readFileSync(join(ROOT, 'scripts/automation/command-spot-check-trigger.js'), 'utf8');
if (!src.includes('scanCmd') && existsSync(STAGED)) src = readFileSync(STAGED, 'utf8'); // 触发脚本还没上线时，用待上线那份
src = src.replace(/const TIMEZONE = "[^"]*";/, 'const TIMEZONE = "Asia/Kolkata";').replace(/const NODE_BIN = "[^"]*";/, `const NODE_BIN = ${JSON.stringify(crew.paths.nodeBin)};`).replace(/const CONFIG_FILE = "[^"]*";/, `const CONFIG_FILE = ${JSON.stringify(join(crew.paths.openclawHome, 'openclaw.json'))};`).replace(/const LOCALE = "[^"]*";/, `const LOCALE = ${JSON.stringify(locale())};`); // the trigger's constants must match config/crew.json
const cfgOut = 'main\t/opt/solofleet/runtime/main\n=====ROUNDS\n=====END\n';

test('手动对账命令 === 触发脚本发出的对账命令（同一个业务日期）', async () => {
  let writeCmd = null;
  const NOW = '2026-11-12T12:35:00Z';
  await new AsyncFunction('exec', 'json', 'FAKE_NOW', src)(async ({ command }) => {
    if (command.includes('=====ROUNDS')) return { isError: false, aggregated: cfgOut };
    if (command.includes('base64')) { writeCmd = command; return { isError: false, aggregated: 'WROTE\nSCANOK\n' }; }
    return { isError: false, aggregated: '=====BEGIN\n=====END\n' };
  }, (o) => o, NOW);
  assert.ok(writeCmd, '触发脚本发出了写文件的命令');
  const scanPart = writeCmd.slice(writeCmd.indexOf('echo WROTE') + 'echo WROTE'.length).replace(/^\n/, '');
  assert.equal(scanPart, buildScanCommand({ bizDate: '2026-11-12' }));
});
test('手动对账：日期格式不对 → 拒绝', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/automation/file-scan-manual.mjs'), '--date', '十一月'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
