// The English rules, templates and job instructions use the very same English words the programs match.
// 1. No Han characters are left in them (except the Chinese sensitive button words of the desktop role and the names of the machine-owned files).
// 2. Every word the programs match appears in the English text that has to use it (and the Chinese word in the Chinese text).
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/docs-consistency.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locale, lexicon } from '../../plugins/personal-inbox/lexicon.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const HAN = /[㐀-鿿＀-￯　-〿]+/g;

const EN_FILES = [
  'rules/shared-rules.md', 'rules/shared-tail.md',
  ...readdirSync(join(ROOT, 'rules/roles')).map((d) => `rules/roles/${d}/AGENTS.head.md`),
  'templates/task-record.md', 'templates/project-entry.md', 'templates/decision-ledger-header.md', 'templates/index-header.md', 'templates/rule-change-sheet-header.md',
  'jobs/daily-audit.md', 'jobs/weekly-audit.md', 'jobs/patrol.md', 'jobs/deep-review.md', 'jobs/diary.md', 'jobs/README.md',
  'config/crew.example.json',
];
// Han text that is allowed in the English files: (a) the Chinese sensitive button words (the list works in both languages at once);
// (b) the names of files and keys that a PROGRAM writes in Chinese (machine-owned; listed as a remaining boundary in docs/en/localization.md).
const SENSITIVE_ZH = ['提交', '发送', '支付', '购买', '删除', '安装', '上传', '转账', '订阅', '授权', '、'];
const MACHINE_OWNED = ['API额度', '状态.json', '暂停区间', '开始', '结束', '原因', 'bot编号表.json', '人设bot', '角色', '显示名', '账号名', 'Discord编号', '编号来源', '系统角色', '备注', '台账锁待核.log', '看护锁待核.log', '运行.log', '卡标签快照.json', '基线.json', '待补.json', '对应.json', '状态', '过期', '补跑结果待核', '叫起待核', '未送达', '待核'];
const ALLOWED = [...SENSITIVE_ZH, ...MACHINE_OWNED].sort((a, b) => b.length - a.length);

test('the English rules, templates and job instructions hold no Chinese (apart from the allowed names)', () => {
  const left = [];
  for (const f of EN_FILES) {
    read(f).split('\n').forEach((line, i) => {
      let l = line;
      for (const a of ALLOWED) l = l.split(a).join('');
      const m = l.match(HAN);
      if (m) left.push(`${f}:${i + 1}: ${[...new Set(m)].join(' ')}`);
    });
  }
  assert.deepEqual(left, []);
});

// word (from the lexicon) -> files that must contain it
const L = { en: lexicon('en'), zh: lexicon('zh-CN') };
const wordTable = (W) => {
  const lab = (w, loc) => (loc === 'en' ? `${w}:` : `${w}：`);
  return [
    ...W.progressOpeners.map((w) => [w, ['RULES']]),
    [W.sectionCurrentStatus, ['RULES', 'TEMPLATES']], [W.sectionWaitingForOwner, ['RULES', 'TEMPLATES']], [W.sectionResults, ['RULES', 'TEMPLATES']],
    [W.placeholderCell, ['TEMPLATES']],
    [W.auditLabelValues[0], ['MAIN', 'TEMPLATES']], [W.auditLabelValues[1], ['MAIN', 'TEMPLATES']], [W.auditLabelValues[2], ['TEMPLATES']],
    [W.auditBodyValues.task, ['TEMPLATES']], [W.auditBodyValues.independent, ['TEMPLATES']],
    [W.helpRequestMarker, ['DESKTOP', 'TASKAUDITOR']], [W.helpReplyMarker, ['DESKTOP', 'TASKAUDITOR']],
    ...W.queueSkipReasons.map((w) => [w, ['DESKTOP']]),
    [W.ledgerStatus.received, ['MAIN']], [W.ledgerStatus.decided, ['MAIN']], [W.ledgerSources.approvalExpired, ['MAIN']],
    [W.approvalReminderMarker, ['MAIN']], [W.quotaResumePrefix, ['RULES']],
    [W.reportVerdict.pass, ['TASKAUDITOR']], [W.reportVerdict.fail, ['TASKAUDITOR']], [W.reportVerdict.cannot, ['TASKAUDITOR', 'MAIN']],
    [W.submissionHead.pre.trim(), ['MAIN']], [W.submissionPaths, ['MAIN']], [W.submissionCard, ['MAIN']],
    [`${W.dataAlias}/`, ['TAIL']],
    [W.layout.ledgerFile, ['RULES']], [W.layout.ownerStatusFile, ['RULES']],
    [W.layout.projects, ['RULES']], [W.layout.outputs, ['RULES']], [W.layout.history, ['RULES']], [W.layout.trash, ['RULES']],
    [W.jobNames.deskQueue, ['PATROL']],
  ];
};
const GROUPS = (suffix, tpl) => ({
  RULES: [`rules/shared-rules${suffix}.md`],
  TAIL: [`rules/shared-tail${suffix}.md`],
  MAIN: [`rules/roles/main/AGENTS.head${suffix}.md`],
  DESKTOP: [`rules/roles/desktop/AGENTS.head${suffix}.md`],
  TASKAUDITOR: [`rules/roles/task-auditor/AGENTS.head${suffix}.md`],
  TEMPLATES: tpl,
  PATROL: [`jobs/patrol${suffix}.md`],
});
const GROUPS_EN = GROUPS('', ['templates/task-record.md', 'templates/project-entry.md']);
const GROUPS_ZH = GROUPS('.zh-CN', ['templates/task-record.zh-CN.md', 'templates/project-entry.zh-CN.md']);
const present = (groups, word, names) => names.some((n) => groups[n].some((f) => read(f).includes(word)));

test('every word the programs match in en appears in the English text that has to use it', () => {
  const missing = wordTable(L.en).filter(([w, names]) => !present(GROUPS_EN, w, names)).map(([w, n]) => `${w} (${n.join('/')})`);
  assert.deepEqual(missing, []);
});

test('the same check for the Chinese words and the Chinese text (the Chinese files stayed in step)', () => {
  // the Chinese rule text names the reminder marker without its last clause ("…程序加的】"); the program writes the longer form, so compare the shared beginning
  const missing = wordTable(L.zh).map(([w, n]) => [w === L.zh.approvalReminderMarker ? w.split('，')[0] : w, n]).filter(([w, names]) => !present(GROUPS_ZH, w, names)).map(([w, n]) => `${w} (${n.join('/')})`);
  assert.deepEqual(missing, []);
});

test('the English files do not use any Chinese program word as a literal any more', () => {
  const zhWords = [...L.zh.progressOpeners, L.zh.helpRequestMarker, L.zh.helpReplyMarker, L.zh.quotaResumePrefix, '【授权范围】', '【审计级别】', '我得：', '任务审计 ', '当前状态', '等主人拍板', '当前成果', '决定账本.md'];
  const offenders = [];
  for (const f of EN_FILES) { const t = read(f); for (const w of zhWords) if (t.includes(w)) offenders.push(`${f}: ${w}`); }
  assert.deepEqual(offenders, []);
});
