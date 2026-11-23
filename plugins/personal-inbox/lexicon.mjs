// Lexicon: the literal words the programs match or write (progress-sentence openers, card labels,
// report headers, ledger status words, folder and file names ...). Selected by config "locale"
// ("en" is the default, "zh-CN" is what the reference deployment ran on).
// Both sets have exactly the same keys (tests/en/lexicon-parity.en.test.mjs), the rule files, the
// templates and the job instructions use the same words (tests/en/docs-consistency.en.test.mjs),
// and every zh-CN value is byte-identical to the literal the programs matched before the
// lexicon existed (tests/lexicon-zh-snapshot.test.mjs).
// Words that take a colon are stored as a bare word; labelText() writes the colon and labelRe() matches it
// (zh-CN keeps accepting both the full-width and the half-width colon, en accepts the half-width colon and optional spaces).
// The desktop sensitive-word list is the exception: Chinese and English words are ALWAYS both active (it guards payments, sends and deletions).
// The remaining places that still hold Chinese on purpose are listed in docs/*/localization.md ("Remaining boundary").
import { crew } from './crew-config.mjs';

export const LOCALES = ['en', 'zh-CN'];
export const locale = () => (LOCALES.includes(crew.locale) ? crew.locale : 'en');

const OWNER = () => crew.owner?.title ? crew.owner.title : 'the owner';

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Text to write for a label word: zh-CN "状态：", en "Status: ". */
export const labelText = (word, loc = locale()) => (loc === 'en' ? `${word}: ` : `${word}：`);
/** Pattern source to match a label word followed by its colon and the given whitespace pattern (default \s*). */
export const labelRe = (word, ws = '\\s*', loc = locale()) => `${escapeRe(word)}${loc === 'en' ? ':' : '[：:]'}${ws}`;
/** Bracketed tag around a word: zh-CN "【授权范围】", en "[Authorization scope]". */
export const tagText = (word, loc = locale()) => (loc === 'en' ? `[${word}]` : `【${word}】`);
/** Pattern source that closes a tag word: zh-CN accepts "】", "：" or ":" after the word; en accepts "]" or ":". */
export const tagCloseRe = (loc = locale()) => (loc === 'en' ? '(?:\\]|:)' : '[】：:]');

const ZH = {
  // ---- progress sentences, task record layout ----
  progressOpeners: ['完成：', '进行中：', '没跑成：', '等主人：', '卡住：'],
  statusHeads: ['完成', '进行中', '没跑成', '等主人', '卡住'],
  statusLabel: '状态',
  sectionCurrentStatus: '当前状态',
  sectionWaitingForOwner: '等主人拍板',
  sectionResults: '当前成果',
  noneWord: '无',
  placeholderCell: '暂无（待写）',
  placeholderCells: ['暂无（待写）', '（待写）', '暂无', '<名称>'],
  placeholderFragment: '待写',
  indexProjectHeader: '项目',
  idLabel: '编号',
  projectEntryLinkText: '项目入口',
  taskRecordTitle: '任务记录',
  resultTableHead: ['成果', '当前位置', '说明'],
  noteStart: '<!-- 模板说明开始 -->',
  noteEnd: '<!-- 模板说明结束 -->',
  placeholders: {
    projectEntry: { projectName: '项目名', goal: '一句话目标', channel: '频道', leadBot: '主责bot', date: '日期' },
    taskRecord: { taskTitle: '任务标题', projectName: '项目名', goal: '目标', quote: '原话', datetime: '日期时间', executor: '执行者', cardId: '任务卡号', threadLink: '线程链接' },
  },
  // ---- task card, audit ----
  auditLabelPrefix: '审计:',
  auditLabelValues: ['单审任务审计', '单审独立', '串联'],
  auditLevelWord: '审计级别',
  authorizationWord: '授权范围',
  authorizationLines: ['目标', '允许做的', '要主人确认的', '停止条件'],
  ownerWord: '主人',
  confirmWords: ['确认', '批准'],
  auditBodyValues: { task: '单审（任务审计）', independent: '单审（独立审计）', chained: '串联' },
  auditBodyToLabel: { '单审任务审计': '单审任务审计', '单审（任务审计）': '单审任务审计', '单审独立审计': '单审独立', '单审（独立审计）': '单审独立', '串联': '串联' },
  submissionHead: { pre: '任务审计 ', mid: ' 请审：', roundOpen: '（第 ', roundClose: ' 次）' },
  submissionCard: '任务卡',
  submissionPaths: '成果位置',
  auditThreadWord: '审计',
  reportLead: '我得',
  reportVerdict: { pass: '我得：通过', fail: '我得：不通过', cannot: '我得：审不了' },
  reportVerdictWord: { pass: '通过', fail: '不通过', cannot: '审不了' },
  // ---- help requests, desktop queue, pending-decision ledger ----
  helpRequestMarker: '【求助】',
  helpReplyMarker: '【求助回复】',
  queueSkipReasons: ['不用了', '完成', '被接手'],
  ledgerStatus: { received: '收到', decided: '已定', revoked: '撤销', noReply: '没回', judging: '待判' },
  ledgerSources: { approvalExpired: '审批过期' },
  ledgerKinds: { closing: '结案确认', desktop: '桌面角色六类操作' },
  ledgerKindKeys: { closing: '结案', desktop: '桌面角色' },
  approvalIdPrefix: '审批',
  autoRegisterPrefix: '（程序补登记）',
  noDeadline: '没截止',
  testMarker: '【测试】',
  approvalReminderMarker: '【待批提醒——程序加的，不是主人说的话】',
  quotaResumePrefix: '【额度恢复·程序代发】',
  // ---- completion record, decision ledger ----
  reminderWord: '提醒',
  unknownWord: '未知',
  ledgerQuoteLabel: '原话',
  ledgerDateLabel: '日期',
  ledgerScopeLabel: '适用范围',
  ledgerReplacesLabel: '取代关系',
  ledgerSections: ['一、有效的决定', '二、已被取代的决定'],
  // ---- generated reports ----
  businessDateLabel: '业务日期',
  reportComplete: '完整',
  reportIncomplete: '不完整',
  reportUnfinished: '未完成',
  waitingLabels: ['等确认', '等主人确认', '已取消'],
  timedJobLabels: { id: '定时任务编号', due: '到点时间' },
  // ---- names that follow the locale ----
  mainRoleDisplayName: '总控',
  dataAlias: '资料',
  jobNames: { daily: '日审', patrol: '巡查', deepReview: '异常深审', weekly: '周审', quotaCatchup: '额度补跑', deskQueue: '桌面排队推进' },
  fileNameLint: { versionWords: ['当前', '最新', '新版', '旧版', '草案', '副本', '临时', '定稿', '终稿'], versionNumberRe: '第[一二三四五六七八九十\\d]+版', testLike: ['测试', 'test', 'tmp', 'selftest'] },
  // ---- data-root folder and file names ----
  layout: {
    projects: '项目', tasks: '任务', outputs: '成果', history: '历史', templates: '模板', trash: '垃圾桶',
    audit: '审计', auditDaily: '日审', auditWeekly: '周审', auditPatrol: '巡查', auditDeep: '异常深审', auditFlags: '异常标记',
    auditAwaiting: '等你定', awaitingLedgerFile: '台账.json', auditChecksums: '程序校验清单', auditQuota: '额度读数', auditPublish: '发布', auditReceipts: '凭据',
    runLogs: '运行记录', scratch: '临时', diaryProject: '日记',
    ledgerFile: '决定账本.md', ownerStatusFile: '主人现况.md', ruleChangeSheet: '规则改法单.md',
    taskRecordTemplate: '任务记录.md', projectEntryTemplate: '项目入口.md',
    diaryFilePrefix: '日记_', diaryRerunSuffixes: ['重跑前副本', '待合并'],
    dailyFiles: { formatCheck: '格式抽查.md', blindspot: '盲区抽查.md', commandCheck: '命令抽查.md', fileReconcile: '文件对账.md', botRoster: 'bot编号表.json' },
    runLogDirs: {
      closing: '结案', gate: '守门', cardThreads: '卡线程', requestWatch: '请示待核', ledgerBacklog: '账本待补', apiQuota: 'API额度', quota: '额度',
      quotaResume: '接续', quotaPlanArchive: '计划存档', watch: '看护', formatCheck: '格式抽查', blindspot: '盲区抽查', fileReconcile: '文件对账',
      englishCleanupRaw: '英文清理原文', reminders: '提醒', catchup: '补跑', publish: '发布',
    },
  },
};

const EN = {
  progressOpeners: ['Done:', 'In progress:', 'Did not run:', 'Waiting on owner:', 'Stuck:'],
  statusHeads: ['Done', 'In progress', 'Did not run', 'Waiting on owner', 'Stuck'],
  statusLabel: 'Status',
  sectionCurrentStatus: 'Current status',
  sectionWaitingForOwner: "Waiting for the owner's decision",
  sectionResults: 'Current results',
  noneWord: 'None',
  placeholderCell: 'None yet (to be written)',
  placeholderCells: ['None yet (to be written)', '(to be written)', 'None yet', '<name>'],
  placeholderFragment: 'to be written',
  indexProjectHeader: 'Project',
  idLabel: 'ID',
  projectEntryLinkText: 'Project entry',
  taskRecordTitle: 'Task record',
  resultTableHead: ['Result', 'Location', 'Note'],
  noteStart: '<!-- template note begin -->',
  noteEnd: '<!-- template note end -->',
  placeholders: {
    projectEntry: { projectName: 'PROJECT_NAME', goal: 'ONE_LINE_GOAL', channel: 'CHANNEL', leadBot: 'LEAD_BOT', date: 'DATE' },
    taskRecord: { taskTitle: 'TASK_TITLE', projectName: 'PROJECT_NAME', goal: 'GOAL', quote: 'OWNER_QUOTE', datetime: 'DATETIME', executor: 'EXECUTOR', cardId: 'TASK_CARD_ID', threadLink: 'THREAD_LINK' },
  },
  auditLabelPrefix: 'audit:',
  auditLabelValues: ['single-task', 'single-independent', 'chained'],
  auditLevelWord: 'Audit level',
  authorizationWord: 'Authorization scope',
  authorizationLines: ['Goal', 'Allowed', 'Needs owner confirmation', 'Stop conditions'],
  ownerWord: 'owner',
  confirmWords: ['confirmed', 'approved'],
  auditBodyValues: { task: 'Single (task audit)', independent: 'Single (independent audit)', chained: 'Chained' },
  auditBodyToLabel: { 'Single (task audit)': 'single-task', 'Single (independent audit)': 'single-independent', 'Chained': 'chained' },
  submissionHead: { pre: 'Task audit ', mid: ' please review: ', roundOpen: ' (round ', roundClose: ')' },
  submissionCard: 'Task card',
  submissionPaths: 'Result location',
  auditThreadWord: 'Audit',
  reportLead: 'Verdict',
  reportVerdict: { pass: 'Verdict: pass', fail: 'Verdict: fail', cannot: 'Verdict: cannot audit' },
  reportVerdictWord: { pass: 'pass', fail: 'fail', cannot: 'cannot audit' },
  helpRequestMarker: '[Help request]',
  helpReplyMarker: '[Help reply]',
  queueSkipReasons: ['not-needed', 'done', 'taken-over'],
  ledgerStatus: { received: 'received', decided: 'decided', revoked: 'revoked', noReply: 'no-reply', judging: 'to-judge' },
  ledgerSources: { approvalExpired: 'approval-expired' },
  ledgerKinds: { closing: 'closing-confirmation', desktop: 'desktop-six-actions' },
  ledgerKindKeys: { closing: 'closing', desktop: 'desktop' },
  approvalIdPrefix: 'approval',
  autoRegisterPrefix: '(auto-registered) ',
  noDeadline: 'no deadline',
  testMarker: '[test]',
  approvalReminderMarker: "[Pending-approval reminder — added by the program, not the owner's words]",
  quotaResumePrefix: '[Quota restored · sent by program]',
  reminderWord: 'Reminder',
  unknownWord: 'unknown',
  ledgerQuoteLabel: 'Quote',
  ledgerDateLabel: 'Date',
  ledgerScopeLabel: 'Scope',
  ledgerReplacesLabel: 'Replaces',
  ledgerSections: ['1. Active decisions', '2. Superseded decisions'],
  businessDateLabel: 'Business date',
  reportComplete: 'complete',
  reportIncomplete: 'incomplete',
  reportUnfinished: 'unfinished',
  waitingLabels: ['waiting-confirm', 'waiting-owner-confirm', 'cancelled'],
  timedJobLabels: { id: 'Timed job ID', due: 'Due time' },
  mainRoleDisplayName: 'Controller',
  dataAlias: 'dataroot',
  jobNames: { daily: 'daily-audit', patrol: 'patrol', deepReview: 'deep-review', weekly: 'weekly-audit', quotaCatchup: 'quota-catchup', deskQueue: 'desktop-queue-advance' },
  fileNameLint: { versionWords: ['current', 'latest', 'new', 'old', 'draft', 'copy', 'temp', 'final', 'revised'], versionNumberRe: 'v\\d+', testLike: ['test', 'tmp', 'selftest', 'dummy'] },
  layout: {
    projects: 'projects', tasks: 'tasks', outputs: 'outputs', history: 'history', templates: 'templates', trash: 'trash',
    audit: 'audit', auditDaily: 'daily', auditWeekly: 'weekly', auditPatrol: 'patrol', auditDeep: 'deep-review', auditFlags: 'anomaly-flags',
    auditAwaiting: 'awaiting-decision', awaitingLedgerFile: 'ledger.json', auditChecksums: 'program-checksums', auditQuota: 'quota-readings', auditPublish: 'publish', auditReceipts: 'receipts',
    runLogs: 'run-logs', scratch: 'scratch', diaryProject: 'diary',
    ledgerFile: 'decision-ledger.md', ownerStatusFile: 'owner-status.md', ruleChangeSheet: 'rule-change-sheet.md',
    taskRecordTemplate: 'task-record.md', projectEntryTemplate: 'project-entry.md',
    diaryFilePrefix: 'diary_', diaryRerunSuffixes: ['pre-rerun', 'to-merge'],
    dailyFiles: { formatCheck: 'format-check.md', blindspot: 'blindspot-check.md', commandCheck: 'command-check.md', fileReconcile: 'file-reconcile.md', botRoster: 'bot-roster.json' },
    runLogDirs: {
      closing: 'closing', gate: 'gate', cardThreads: 'card-threads', requestWatch: 'request-watch', ledgerBacklog: 'ledger-backlog', apiQuota: 'api-quota', quota: 'quota',
      quotaResume: 'resume', quotaPlanArchive: 'plan-archive', watch: 'watch', formatCheck: 'format-check', blindspot: 'blindspot-check', fileReconcile: 'file-reconcile',
      englishCleanupRaw: 'english-cleanup-raw', reminders: 'reminders', catchup: 'catchup', publish: 'publish',
    },
  },
};

export const lexicon = (loc = locale()) => (loc === 'en' ? EN : ZH);
export const ownerTitle = OWNER;

/** Desktop sensitive-button words: both languages are always active. */
export const SENSITIVE_WORDS_EN = ['submit', 'send', 'pay', 'purchase', 'buy', 'placeorder', 'checkout', 'delete', 'remove', 'install', 'upload', 'confirmpurchase', 'transfer', 'subscribe', 'authorize']; // same list as the English words in sensitive-words.json (spaces removed, lower case)

// ---- Text shown on the reply card (execution-record.mjs) and the two replacement sentences. Both sets are complete. ----
const CARD_ZH = {
  modelUnknown: '模型未知', modelUnrecognized: '模型未识别', routeUnknown: '入口未知', labelUnknown: '型号未知', effortUnknown: '档位未知',
  modelAndEffortUnknown: '模型和档位：未知（本轮没有拿到用量状态）',
  messageOther: { edit: ['编辑了消息', '编辑消息'], unsend: ['撤回了消息', '撤回消息'], delete: ['删除了消息', '删除消息'], react: ['加了反应', '加反应'],
    pin: ['置顶了消息', '置顶消息'], unpin: ['取消了置顶', '取消置顶'], poll: ['发了投票', '发投票'], poll_vote: ['投了票', '投票'], thread_create: ['建了消息线程', '建消息线程'] },
  changeLabel: '修改：', unlisted: '未列', unlistedTools: (inner) => `未列（工具记录：${inner}）`, none: '无',
  listSep: '、', segSep: '；', more: (n) => ` 等 ${n} 个`,
  hiddenN: (n) => `${n} 个名称隐藏`, outsideN: (n) => `${n} 个范围外文件`, also: (c) => `另有 ${c}`,
  leaked: (n, names) => `另有 ${n} 个漏列：${names}`, leakedHidden: (n) => `另有 ${n} 个漏列，名称隐藏`, leakedOutside: (n) => `另有 ${n} 个漏列，在范围外`,
  wrap: (inner) => `（${inner}）`, withExtra: (inner, extra) => `${inner}；另有 ${extra}`,
  quotaUnknown: '未知', quotaResetPassed: '已到重置点，待新读数', quotaRemaining: (p) => `余 ${p}%`,
  quotaApi: '额度：API 额度（用完即停，余额看 Console）', quotaLine: (s, w, f, fam = 'fable') => `额度：5h ${s} · 周限额（总量/${fam}）：${w}/${f}`,
  sampleCli: 'CodexBar 命令行采样', sampleCache: 'CodexBar 缓存',
  sampleNote: (src, at, mins, failed) => `（${src} ${at}，距今 ${mins} 分钟${failed ? '，刷新失败，保留旧值' : ''}）`,
  quotaUnavailable: '额度：暂时取不到',
  emptyReplyReplacement: '⚠️ 这一轮我没有生成可发的内容，请再叫我一次。',
  unconfirmedReplacement: '上一条回复我没法确认是否送到，不会自动重发，缺什么请再问我。',
};
const CARD_EN = {
  modelUnknown: 'model unknown', modelUnrecognized: 'model not recognized', routeUnknown: 'route unknown', labelUnknown: 'model unknown', effortUnknown: 'effort unknown',
  modelAndEffortUnknown: 'Model and effort: unknown (no usage state this turn)',
  messageOther: { edit: ['edited a message', 'edit message'], unsend: ['unsent a message', 'unsend message'], delete: ['deleted a message', 'delete message'], react: ['added a reaction', 'add reaction'],
    pin: ['pinned a message', 'pin message'], unpin: ['unpinned a message', 'unpin message'], poll: ['posted a poll', 'post poll'], poll_vote: ['voted in a poll', 'vote in poll'], thread_create: ['created a thread', 'create thread'] },
  changeLabel: 'Changed: ', unlisted: 'not listed', unlistedTools: (inner) => `not listed (tool log: ${inner})`, none: 'none',
  listSep: ', ', segSep: '; ', more: (n) => ` and ${n} more`,
  hiddenN: (n) => `${n} with hidden names`, outsideN: (n) => `${n} outside the scope`, also: (c) => `also ${c}`,
  leaked: (n, names) => `${n} more not listed: ${names}`, leakedHidden: (n) => `${n} more not listed, names hidden`, leakedOutside: (n) => `${n} more not listed, outside the scope`,
  wrap: (inner) => ` (${inner})`, withExtra: (inner, extra) => `${inner}; also ${extra}`,
  quotaUnknown: 'unknown', quotaResetPassed: 'reset passed, waiting for a new reading', quotaRemaining: (p) => `${p}% left`,
  quotaApi: 'Quota: API credit (stops when used up; see the Console for the balance)', quotaLine: (s, w, f, fam = 'fable') => `Quota: 5h ${s} · weekly (total/${fam}): ${w}/${f}`,
  sampleCli: 'CodexBar CLI sample', sampleCache: 'CodexBar cache',
  sampleNote: (src, at, mins, failed) => `(${src} ${at}, ${mins} min ago${failed ? ', refresh failed, keeping the old value' : ''})`,
  quotaUnavailable: 'Quota: not available right now',
  emptyReplyReplacement: '⚠️ I produced nothing to send this turn. Please call me again.',
  unconfirmedReplacement: "I could not confirm that my previous reply arrived, and I will not resend it automatically. Ask me again for anything that is missing.",
};
export const cardText = (loc = locale()) => (loc === 'en' ? CARD_EN : CARD_ZH);
export const cardTextAll = (key) => [CARD_EN[key], CARD_ZH[key]];
/** The English-process-paragraph cleanup was written for deployments whose rules say "always reply in Chinese": it only runs for zh-CN. */
export const englishCleanupEnabled = (loc = locale()) => loc === 'zh-CN';
