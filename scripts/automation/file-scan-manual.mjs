#!/usr/bin/env node
// Runs the file reconciliation once by hand with exactly the command the daily-audit trigger uses.
// 手动跑一次"文件对账"，命令和日审触发脚本里的完全相同（同样的 Node 完整路径、同样用 jq 从配置取"角色=工作区目录"对应表），
// 用于上线后验证和真实路径测试：先在造测试数据之前跑一次建好基线，造错之后再跑一次看"新增"。
// 注意：不要用"强制手动跑日审"代替——日审.md 写明那样会跳过触发脚本，根本不会做对账。
// Usage: node file-scan-manual.mjs --date 2026-11-22
// 它只做对账一件事，不写命令抽查文件；输出对账文件路径和结论那一行。真实 18:05 那一轮仍以触发消息里的"文件对账=已生成"为准。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { crew } from '../../plugins/personal-inbox/crew-config.mjs';
import { lexicon } from '../../plugins/personal-inbox/lexicon.mjs';
const W = lexicon(); // folder and file names follow config "locale"
import { join } from 'node:path';
const DATA_ROOT = crew.paths.dataRoot;
const PROJECT_ROOT = crew.paths.projectRoot;
const CONFIG_FILE = join(crew.paths.openclawHome, 'openclaw.json');
const NODE_BIN = crew.paths.nodeBin;
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// 必须和 command-spot-check-trigger.js 里的 scanCmd 逐字相同（tests/file-scan-manual.test.mjs 核这一点）
export function buildScanCommand({ dataRoot = DATA_ROOT, projectRoot = PROJECT_ROOT, configFile = CONFIG_FILE, nodeBin = NODE_BIN, bizDate }) {
  const out = `${dataRoot}/${W.layout.audit}/${W.layout.auditDaily}/${bizDate}-${W.layout.dailyFiles.fileReconcile}`;
  const jqWs = `jq -r '.agents.entries | to_entries | map("\\(.key)=\\(.value.workspace)") | join(",")' ${q(configFile)} 2>/dev/null`;
  return `WS=$(${jqWs}); OPENCLAW_DATA_ROOT=${q(dataRoot)} OPENCLAW_RUNTIME_ROOT=${q(projectRoot + '/runtime')} ${q(nodeBin)} ${q(projectRoot + '/scripts/automation/project-files.mjs')} scan --date ${bizDate} --out ${q(out)} --workspaces "$WS" >/dev/null 2>&1 && echo SCANOK || echo SCANFAIL`;
}

function main(argv) {
  const i = argv.indexOf('--date');
  const date = i >= 0 ? argv[i + 1] : null;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.log(JSON.stringify({ ok: false, message: '要写 --date YYYY-MM-DD（业务日期）' })); return 2; }
  const cmd = buildScanCommand({ bizDate: date });
  const r = execFileSync('/bin/bash', ['-c', cmd], { encoding: 'utf8' });
  const ok = /SCANOK/.test(r);
  const file = `${DATA_ROOT}/${W.layout.audit}/${W.layout.auditDaily}/${date}-${W.layout.dailyFiles.fileReconcile}`;
  let head = null;
  if (ok) { try { head = readFileSync(file, 'utf8').split('\n').slice(0, 3); } catch { /* 读不到就不带 */ } }
  console.log(JSON.stringify({ ok, 结果: ok ? 'SCANOK' : 'SCANFAIL', 文件: file, 头三行: head }, null, 1));
  return ok ? 0 : 1;
}
const a = process.argv[1];
if (a) {
  try { if (realpathSync(a) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2)); } catch { /* 被导入时不执行 */ }
}
