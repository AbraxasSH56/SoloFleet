// Verbatim check of decision-ledger back-fills (read-only, never touches git).
// 检查：①账本里原样有清单的新增段；②编号连续；④没有写死的模型版本号、没有邮箱
//      ⑤三处订正的句子原样在；⑥补写前账本的每一行都还在（要么原样，要么只是末尾追加了字）。
import { readFileSync } from 'node:fs';

export const BEGIN = '<<<BEGIN>>>';
export const END = '<<<END>>>';

export function extractBlock(listText) {
  const a = listText.indexOf(`\n${BEGIN}\n`); const b = listText.indexOf(`\n${END}\n`);
  if (a < 0 || b < 0 || b < a) return null;
  return listText.slice(a + BEGIN.length + 2, b + 1).replace(/\s+$/, '');
}

export function verifyLedger({ listText, ledgerText, recordText, baselineText, firstNo = 35 }) {
  const problems = [];
  const block = extractBlock(listText);
  if (!block) { return ['清单里找不到 <<<BEGIN>>> ／ <<<END>>> 标记']; }
  // ① 新增段原样在账本里，并且在“## 二、已被取代的决定”之前
  const at = ledgerText.indexOf(block);
  if (at < 0) problems.push('账本里找不到清单的新增段（有字被改动、漏抄或多抄）');
  else {
    const sec2 = ledgerText.indexOf('## 二、已被取代的决定');
    if (sec2 >= 0 && at > sec2) problems.push('新增段放到“二、已被取代的决定”后面去了');
    if (ledgerText.indexOf(block, at + 1) >= 0) problems.push('新增段在账本里出现了两遍');
  }
  // ② 编号连续
  const heads = [...block.matchAll(/^### D-(\d{3}) /gm)].map((m) => Number(m[1]));
  heads.forEach((n, i) => { if (n !== firstNo + i) problems.push(`编号不连续：第 ${i + 1} 条应是 D-${String(firstNo + i).padStart(3, '0')}，清单里是 D-${String(n).padStart(3, '0')}`); });
  if (!heads.length) problems.push('清单里没有任何 ### D-0xx 条目');
  // 账本里这些编号也各只出现一次
  for (const n of heads) {
    const c = [...ledgerText.matchAll(new RegExp(`^### D-${String(n).padStart(3, '0')} `, 'gm'))].length;
    if (c !== 1) problems.push(`账本里 D-${String(n).padStart(3, '0')} 出现 ${c} 次`);
  }
  for (const m of block.matchAll(/「([^」]+)」/g)) {
    if (!recordText.includes(m[1])) problems.push(`原话在原始记录里找不到（逐字不符）：「${m[1].slice(0, 40)}${m[1].length > 40 ? '…' : ''}」`);
  }
  // ④ 文件头规矩
// 只认模型名后面直接跟数字
  if (/(opus|sonnet|fable|haiku|claude)\s*[-]?\s*\d/i.test(block)) problems.push('新增段里有写死的模型版本号');
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(block)) problems.push('新增段里有邮箱样式的文字');
  // ⑤ 订正句子
  const fixes = [...listText.matchAll(/^`(（\d{1,2}-\d{1,2} 订正[^`\n]*）)`$/gm)].map((m) => m[1]);
  if (fixes.length !== 3) problems.push(`清单里应有 3 句订正，找到 ${fixes.length} 句`);
  for (const f of fixes) {
    const c = ledgerText.split(f).length - 1;
    if (c !== 1) problems.push(`订正句在账本里出现 ${c} 次（应 1 次）：${f.slice(0, 24)}…`);
  }
  // ⑥ 补写前的每一行还在（原样，或只是末尾追加）
  if (baselineText != null) {
    const newLines = ledgerText.split('\n'); const set = new Set(newLines);
    baselineText.split('\n').forEach((ln, i) => {
      if (ln === '' || set.has(ln)) return;
      if (newLines.some((nl) => nl.startsWith(ln))) return;
      problems.push(`补写前账本第 ${i + 1} 行被改动或删除：${ln.slice(0, 30)}…`);
    });
  }
  return problems;
}

export function main(argv) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const need = ['--list', '--ledger', '--record'];
  for (const k of need) if (!get(k)) { console.log(`缺参数 ${k}`); return 2; }
  const rd = (p) => readFileSync(p, 'utf8');
  const problems = verifyLedger({ listText: rd(get('--list')), ledgerText: rd(get('--ledger')), recordText: rd(get('--record')), baselineText: get('--baseline') ? rd(get('--baseline')) : null });
  if (!problems.length) { console.log('核对通过：新增段原样在账本里、编号连续、原话逐字对得上、没有版本号、订正句在、旧内容没少。'); return 0; }
  console.log(`核对不通过，${problems.length} 个问题：\n` + problems.map((p) => `- ${p}`).join('\n'));
  return 1;
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) process.exitCode = main(process.argv.slice(2));
