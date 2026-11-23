// Snapshot: every zh-CN word is byte-identical to the literal the programs matched before the lexicon existed.
// If this test fails the Chinese behaviour has changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lexicon, labelText, labelRe } from '../plugins/personal-inbox/lexicon.mjs';

const Z = lexicon('zh-CN');

test('progress openers, status line and task-record sections', () => {
  assert.deepEqual(Z.progressOpeners, ['完成：', '进行中：', '没跑成：', '等主人：', '卡住：']);
  assert.deepEqual(Z.statusHeads, ['完成', '进行中', '没跑成', '等主人', '卡住']);
  assert.equal(labelText(Z.statusLabel, 'zh-CN'), '状态：');
  assert.equal(Z.sectionCurrentStatus, '当前状态');
  assert.equal(Z.sectionWaitingForOwner, '等主人拍板');
  assert.equal(Z.sectionResults, '当前成果');
  assert.equal(Z.noneWord, '无');
  assert.equal(Z.placeholderCell, '暂无（待写）');
  assert.deepEqual(Z.placeholderCells, ['暂无（待写）', '（待写）', '暂无', '<名称>']);
  assert.equal(Z.placeholderFragment, '待写');
  assert.equal(Z.indexProjectHeader, '项目');
  assert.equal(Z.noteStart, '<!-- 模板说明开始 -->');
  assert.equal(Z.noteEnd, '<!-- 模板说明结束 -->');
  assert.deepEqual(Z.placeholders.projectEntry, { projectName: '项目名', goal: '一句话目标', channel: '频道', leadBot: '主责bot', date: '日期' });
  assert.deepEqual(Z.placeholders.taskRecord, { taskTitle: '任务标题', projectName: '项目名', goal: '目标', quote: '原话', datetime: '日期时间', executor: '执行者', cardId: '任务卡号', threadLink: '线程链接' });
});

test('card, audit and report words', () => {
  assert.equal(Z.auditLabelPrefix, '审计:');
  assert.deepEqual(Z.auditLabelValues, ['单审任务审计', '单审独立', '串联']);
  assert.equal(`【${Z.auditLevelWord}】`, '【审计级别】');
  assert.equal(`【${Z.authorizationWord}】`, '【授权范围】');
  assert.deepEqual(Z.authorizationLines, ['目标', '允许做的', '要主人确认的', '停止条件']);
  assert.equal(Z.ownerWord, '主人');
  assert.deepEqual(Z.confirmWords, ['确认', '批准']);
  assert.deepEqual(Z.auditBodyValues, { task: '单审（任务审计）', independent: '单审（独立审计）', chained: '串联' });
  assert.deepEqual(Z.submissionHead, { pre: '任务审计 ', mid: ' 请审：', roundOpen: '（第 ', roundClose: ' 次）' });
  assert.equal(Z.submissionCard, '任务卡');
  assert.equal(Z.submissionPaths, '成果位置');
  assert.equal(`${Z.auditThreadWord}：`, '审计：');
  assert.deepEqual(Z.reportVerdict, { pass: '我得：通过', fail: '我得：不通过', cannot: '我得：审不了' });
  assert.deepEqual(Z.reportVerdictWord, { pass: '通过', fail: '不通过', cannot: '审不了' });
});

test('help, queue, pending-decision ledger and quota words', () => {
  assert.equal(Z.helpRequestMarker, '【求助】');
  assert.equal(Z.helpReplyMarker, '【求助回复】');
  assert.deepEqual(Z.queueSkipReasons, ['不用了', '完成', '被接手']);
  assert.deepEqual(Z.ledgerStatus, { received: '收到', decided: '已定', revoked: '撤销', noReply: '没回', judging: '待判' });
  assert.equal(Z.ledgerSources.approvalExpired, '审批过期');
  assert.deepEqual(Z.ledgerKinds, { closing: '结案确认', desktop: '桌面角色六类操作' });
  assert.equal(Z.autoRegisterPrefix, '（程序补登记）');
  assert.equal(Z.noDeadline, '没截止');
  assert.equal(Z.testMarker, '【测试】');
  assert.equal(Z.approvalReminderMarker, '【待批提醒——程序加的，不是主人说的话】');
  assert.equal(Z.quotaResumePrefix, '【额度恢复·程序代发】');
  assert.equal(`${Z.reminderWord}：`, '提醒：');
  assert.equal(Z.unknownWord, '未知');
  assert.equal(Z.ledgerQuoteLabel, '原话');
  assert.deepEqual(Z.ledgerSections, ['一、有效的决定', '二、已被取代的决定']);
  assert.equal(Z.mainRoleDisplayName, '总控');
  assert.equal(Z.dataAlias, '资料');
  assert.deepEqual(Z.jobNames, { daily: '日审', patrol: '巡查', deepReview: '异常深审', weekly: '周审', quotaCatchup: '额度补跑', deskQueue: '桌面排队推进' });
  assert.deepEqual(Z.waitingLabels, ['等确认', '等主人确认', '已取消']);
  assert.deepEqual(Z.timedJobLabels, { id: '定时任务编号', due: '到点时间' });
});

test('data-root folder and file names', () => {
  const L = Z.layout;
  assert.deepEqual([L.projects, L.tasks, L.outputs, L.history, L.templates, L.trash], ['项目', '任务', '成果', '历史', '模板', '垃圾桶']);
  assert.deepEqual([L.audit, L.auditDaily, L.auditWeekly, L.auditPatrol, L.auditDeep, L.auditFlags], ['审计', '日审', '周审', '巡查', '异常深审', '异常标记']);
  assert.deepEqual([L.auditAwaiting, L.awaitingLedgerFile, L.auditChecksums, L.auditQuota, L.auditPublish, L.auditReceipts], ['等你定', '台账.json', '程序校验清单', '额度读数', '发布', '凭据']);
  assert.deepEqual([L.runLogs, L.scratch, L.diaryProject], ['运行记录', '临时', '日记']);
  assert.deepEqual([L.ledgerFile, L.ownerStatusFile, L.ruleChangeSheet, L.taskRecordTemplate, L.projectEntryTemplate], ['决定账本.md', '主人现况.md', '规则改法单.md', '任务记录.md', '项目入口.md']);
  assert.equal(L.diaryFilePrefix, '日记_');
  assert.deepEqual(L.diaryRerunSuffixes, ['重跑前副本', '待合并']);
  assert.deepEqual(L.dailyFiles, { formatCheck: '格式抽查.md', blindspot: '盲区抽查.md', commandCheck: '命令抽查.md', fileReconcile: '文件对账.md', botRoster: 'bot编号表.json' });
  // the run-log folder list the file-reconcile whitelist used before (plus the two folders that live under 额度)
  const old = ['卡线程', '守门', '看护', '结案', '英文清理原文', '补跑', '额度', '发布', '文件对账', 'API额度', '提醒', '账本待补', '格式抽查', '请示待核', '盲区抽查'];
  const R = L.runLogDirs;
  const top = [R.cardThreads, R.gate, R.watch, R.closing, R.englishCleanupRaw, R.catchup, R.quota, R.publish, R.fileReconcile, R.apiQuota, R.reminders, R.ledgerBacklog, R.formatCheck, R.requestWatch, R.blindspot];
  assert.deepEqual([...top].sort(), [...old].sort());
  assert.deepEqual([R.quotaResume, R.quotaPlanArchive], ['接续', '计划存档']);
});

test('file-name lint words', () => {
  assert.deepEqual(Z.fileNameLint.versionWords, ['当前', '最新', '新版', '旧版', '草案', '副本', '临时', '定稿', '终稿']);
  assert.equal(Z.fileNameLint.versionNumberRe, '第[一二三四五六七八九十\\d]+版');
  assert.deepEqual(Z.fileNameLint.testLike, ['测试', 'test', 'tmp', 'selftest']);
});

test('labelRe in zh-CN keeps the old full-width/half-width tolerance', () => {
  assert.equal(labelRe('状态', '\\s*', 'zh-CN'), '状态[：:]\\s*');
  assert.equal(labelRe('日期', '[ \\t]*', 'zh-CN'), '日期[：:][ \\t]*');
});

test('sentences written into files or sent (zh-CN text is the old text)', () => {
  assert.equal(Z.placeholderNone, '暂无');
  assert.equal(Z.defaultGoalHint, '<一句话，用大白话写这个任务要达成什么。>');
  assert.equal(Z.channelCell('频道A', '100'), '频道A（编号 100）');
  assert.equal(Z.indexLocationsCell('P'), '任务记录在 项目/P/任务/，成果在 项目/P/成果/，历史在 项目/P/历史/');
  assert.equal(Z.resultStatusLine('2026-11-22', 'N'), '2026-11-22：N 已完成，见下表');
  assert.deepEqual(Z.entryHintParts, { results: '"当前成果"还没登记', status: '"当前状态"日期落后于任务记录' });
  assert.equal(Z.entryHint('甲、乙'), '项目入口还没跟上（甲、乙），请更新（执行者可用 add-result，其余由项目主责维护）');
  assert.equal(Z.listSep, '、');
  assert.equal(Z.completionRecord('T', 'E', 'L'), '完成记录：《T》，执行：E，线程：L');
  assert.equal(Z.noCardName, '（没有卡名）');
  assert.equal(Z.reminderSep, '；提醒：');
  assert.equal(Z.smallJobRecord('E', 'L', 'a、b', '等 9 个'), '完成记录（小活）：E在线程 L 做完一件，改了：a、b等 9 个');
  assert.equal(Z.smallJobMore(9), '等 9 个');
  assert.equal(Z.fileReconcile.header(1, 2, 3), '文件对账：新增 1、满 3 天 2、存量 3');
  assert.deepEqual(Z.fileReconcile.kinds, { new: '新增', day3: '满3天', existing: '存量' });
  assert.deepEqual(Z.fileReconcile.sections, { new: '新增', day3: '满 3 天', existing: '存量' });
  assert.equal(Z.fileReconcile.title, '文件对账');
});

test('instruction texts to the bots (zh-CN text is the old text)', () => {
  assert.equal(Z.helpFormat('<@M>'), '按这个格式在当前线程点名任务审计 <@M>，一条消息写完：\n【求助】\n现象：（卡在哪一步，想做什么）\n我做过什么：（两次各用了什么办法）\n屏幕上现在是什么：（用文字描述，看到了什么窗口、按钮、提示）\n报错原文：（工具返回的原文，没有就写“没有”）');
  assert.equal(Z.blockAskHelp('F'), '同一步已经连续失败两次，先停，不要试第三次，也不要再动屏幕。F\n发出去以后等任务审计回复，照她的建议再试一次。');
  assert.equal(Z.blockAfterHelp, '求助以后照建议再试，又连续失败了两次：停下，不要再动屏幕、也不要收尾，保持屏幕原样。在线程里写“卡住：”，说清屏幕现在的样子和试过什么，放锁，点名总控，由她报主人，等主人定。不要换模型、不要继续试。');
  const Q = Z.queueText;
  assert.equal(Q.lockHead(true, 'H'), '桌面正被另一个线程占用（那边屏幕上留着等主人确认的东西）。H。');
  assert.equal(Q.lockHead(false, 'H'), '桌面正被另一个线程占用。H。');
  assert.equal(Q.holdHead(3), '屏幕留给排在前面的那位了（排队号 3，它被点名后来接）。');
  assert.equal(Q.lineHead, '前面还有人在等，屏幕要按先后排给排第一的那位（程序两分钟左右会去叫它）。');
  assert.equal(Q.including, '（含正在做的那件）');
  assert.equal(Q.requesterKnown('5', true), '：这次叫你的是 <@5>（主人本人），点名它就把 <@5> 原样写进回话里');
  assert.equal(Q.requesterUnknown, '（一般是总控或别的 bot）');
  assert.equal(Q.body('头', 2, '（含）', '请求方'), '头已按先来后到把这个线程记进等候名单，前面还有 2 件（含）。请在当前线程点名请求方请求方，回一句“我在别处忙，排上了，前面还有 2 件，轮到你我来叫你，不用再叫我”，然后结束这一轮。不要等、不要重试、不要绕开这个检查。');
  assert.equal(Q.noteLead, '回话之前先照原样跑一次这条命令（补记是谁、哪条消息叫的你，把尖括号换成编号）：');
  assert.equal(Q.stall, '排队推进好像停了：回话时顺带点名主人说一句。');
  assert.equal(Q.holderText('W', 'R', 'S', 'L'), '持锁线程：W；请求方：R；开始：S；最后一次动屏幕：L');
  assert.equal(Q.notRecorded, '未记录（系统没给出）');
  assert.equal(Q.notifyOwnerJob('D', 'T', 7, 'TH', '不用了', 15), '<@D> 轮到你了：主人 T 在这个线程叫你做的事，现在屏幕空了（排队号 7）。先读这个线程，确认他的原话还在、之后他没说过取消，就直接按他的原话动手，不用他再说一遍；他说过取消的，跑 skip --thread TH --why 不用了 划掉这一件。这是程序发的通知，不用回复、不要点名总控；做完只点名主人报结果。六类操作（付款、对外发送、永久删除、提交表单、上传文件、安装软件）照旧停下等他，这条通知不是新授权。给你留 15 分钟，过了就让给下一位。');
  assert.equal(Q.notifyRequesterJob('R', 'T', 7, '当前状态', '不用了', 15), '<@R> 轮到你了：你 T 在这里叫我做的事，现在屏幕空了（排队号 7）。先重读任务记录的“当前状态”，还要做就在这个线程重新点名我、把事情再说一遍；不用了就点名我说“不用了”。给你留 15 分钟，过了就让给下一位，之后还要做再叫我、重新排。这只是通知，不是新授权。');
  assert.equal(Q.whyInvalid(['不用了', '完成', '被接手']), '--why 只能是“不用了”“完成”“被接手”之一。名单没动。');
  assert.equal(Z.clockLocale, 'zh-CN');
});

test('approval reminder and auto-registered texts', () => {
  const R = Z.approvalReminder;
  assert.equal(R.item(1, '标题', 'c7', 'L'), '1. 标题（任务卡 c7），原线程 L');
  assert.equal(R.item(2, '标题', null, null), '2. 标题');
  assert.deepEqual(R.lines(Z.approvalReminderMarker, 2), ['【待批提醒——程序加的，不是主人说的话】有 2 件审批过期没批，那几件事还停着：']);
  assert.deepEqual(R.tail, ['回答完他这一轮问的事之后，在末尾加一句话提醒他这几件还没批；不要单独发消息。', '他要是说“知道了”或“先放着”，这一轮之后就不用再单独提了（程序 6 小时内也不会再让你提）。', '他要是说“批”或“重新申请”，到原线程点名那个 bot 让它重新申请，新的审批卡会弹出来，他再点“允许”；你不要替他批。']);
  assert.deepEqual(Z.autoRegisterTexts, { title: '带按钮的请示', suggestion: '（程序补登记：bot 没登记；建议和选项见原消息）', blocks: '（程序补登记：不定会卡住什么，见原消息）' });
});

test('pending-decision tool texts', () => {
  const T = Z.pendingTools;
  assert.equal(T.deadline, '截止时间（ISO 时间），没有就写“没截止”。');
  assert.equal(T.recheckDate, '“收到”时约定的复查日 YYYY-MM-DD；没约定就不写，默认 7 天后。');
  assert.equal(T.decision, '“已定”时的结论一句话。');
  assert.equal(T.registerDescription, '把一件要主人定的事登记到“等你定”台账（丙档请示发出的同时调用）。同一原请示消息编号重复登记直接返回已有那行。只写台账，不发消息。');
  assert.ok(T.updateDescription.startsWith('判定主人对某件“等你定”的回应：收到（带约定日期）／已定（带结论）／撤销。'));
  assert.ok(T.updateDescription.endsWith('source 随便填一个编号或“无”。'));
});

test('quota wake text, ledger backlog view and commit messages', () => {
  assert.equal(Z.quotaResumeWakeText('【额度恢复·程序代发】'), '【额度恢复·程序代发】你上一轮因额度用完中断了。等同于主人说了“继续”：先读你的任务记录和这个线程，在线程里说一句已完成到哪里，再接着做；不要重做已经完成的步骤，不要重复发过的消息。如果任务其实已经做完，说一句“已完成”就行。');
  const B = Z.ledgerBacklog;
  assert.equal(B.title, '账本待补清单');
  assert.equal(B.note('T', 1, 2), '（脚本自动生成，别手改；T 更新。待补 1 条，已入账 2 条。）');
  assert.equal(B.pendingHead, '## 待补（请写进 `资料/决定账本.md`：短版、带原话；写好后对每条跑 `done`）');
  assert.equal(B.none, '（没有）');
  assert.equal(B.entryHead(3, true, '标题'), '### 待补 3 【测试】：标题');
  assert.equal(B.entryHead(3, false, '标题'), '### 待补 3：标题');
  assert.deepEqual([B.date('D'), B.quote('Q'), B.position('P'), B.added('A')], ['- 日期：D', '- 主人原话：Q', '- 记录位置：P', '- 登记时间：A']);
  assert.equal(B.doneHead, '## 已入账（最近 20 条）');
  assert.equal(B.doneLine(2, '标题', 'D-052', 'T'), '- 2 标题 → D-052（T）');
  assert.equal(B.commitWithIds('2026-11-22', '3、4'), '决定账本：程序自动提交（总控补写，2026-11-22，待补编号 3、4）');
  assert.equal(B.commitFallback('2026-11-22'), '决定账本：程序自动提交（2026-11-22，定时兜底）');
});

test('audit round record, anomaly flag, publish receipt and deep-review trigger words', () => {
  assert.deepEqual(Z.auditRecordKeys, { task: '任务', businessDate: '业务日期', cutoff: '截止点', previousCutoff: '上一截止点', execution: '执行', done: '已做', updatedAt: '更新时间' });
  assert.deepEqual(Z.auditRecordValues, { inProgress: '进行中', done: '完成', finished: '已完成' });
  assert.deepEqual(Z.flagKeys, { status: '状态', foundAt: '发现时间' });
  assert.deepEqual(Z.flagStates, { toReview: '待深审', reviewing: '深审中', reviewed: '已深审' });
  assert.deepEqual(Z.publishTasks, {
    patrol: { label: '【巡查 · {d}】', reportLine: '完整报告：资料/审计/巡查/{d}-报告.md', reportFile: '{d}-报告.md' },
    deepReview: { label: '【审计 · 异常深审 · {d}】', reportLine: '完整报告：资料/审计/异常深审/{d}.md', reportFile: '{d}.md' },
    weekly: { label: '【审计 · 周审 · {d}】', reportLine: '完整报告：资料/审计/周审/{d}.md', reportFile: '{d}.md' },
  });
  assert.deepEqual(Z.publishFiles, { summary: '-摘要.txt', receipt: '.回执.txt', failed: '.校验失败.json' });
  assert.deepEqual(Z.publishStates, { sending: '发送中', delivered: '已送达', toVerify: '待核', deliveryToVerify: '送达待核' });
  assert.deepEqual(Z.receiptKeys, { task: '任务', businessDate: '业务日期', account: '账号', channel: '频道', target: '目标', state: '状态', messageId: '消息编号', digest: '摘要指纹', receiptFile: '回执文件', receiptTime: '回执时间', reason: '原因', time: '时间', unconfirmedId: '回执里的编号_未确认' });
  assert.deepEqual(Z.deepTrigger, { businessDate: '业务日期=', cutoff: '截止点=', toReview: '待审=', toContinue: '待接=', none: '无', finishOnly: '只补收尾（本轮已完成，不重审内容）', continueReview: '接着审（本轮记录不是完成）', cannotTell: '未能判断（读不到那一天的本轮记录，请深审自己查）' });
});

test('rework additions: wake sentences, task-record sections and desktop queue texts are the old Chinese texts', () => {
  assert.deepEqual(Z.taskRecordSections, { cardId: '任务卡号', threadLink: 'Discord 线程链接' });
  assert.equal(Z.wake.pendingJudge('P-1', '标题', 'R9', 'L1'), '主人回了“等你定”台账里的一件（台账编号 P-1：标题）：他的回应消息编号 R9（原请示 L1）。请用 pending_decision_update 判：“周末再看／收到”→状态“收到”并写约定日期（没约定不写）；给了答案→“已定”并写结论一句；source 填 R9；判不准就在原线程点名主人，不猜。只做这一件事，不发别的消息。');
  assert.equal(Z.wake.pendingJudgeJob, '等你定叫起-');
  assert.equal(Z.wake.ledgerBacklog(2, 'N', 'S'), '账本待补：有 2 条主人的决定还没写进 资料/决定账本.md。\n1. 先运行 `N S list` 看清单（每条带日期、短标题和主人原话）。\n2. 照账本现有写法补写：短版、带原话、编号接着最后一条；原话一个字都不要改。\n3. 写好一条就运行 `N S done <待补编号> --ledger-id D-0xx`。\n只改 决定账本.md；不要改 运行记录 里的任何文件；不要运行 git。写不了就在工坊说一句，不要硬写。');
  assert.equal(Z.wake.ledgerBacklogTest('B'), '【这是测试，不要改决定账本.md】只回一句“收到测试”即可，或只写一个临时测试文件。\n\nB');
  assert.equal(Z.wake.ledgerBacklogJob, '账本待补叫起-');
  assert.equal(Z.wake.watchMarker('fp'), '〔看护·fp〕');
  assert.equal(Z.wake.watchBody('M', 'T'), 'M异常清单原样：T\n按规则核实；需要就在对应线程点名相关 bot；要主人定的照丙档登记台账（pending_decision_register）。');
  assert.equal(Z.wake.watchJob, '白天看护叫起-');
  assert.deepEqual(Z.queueStatusText, { waiting: '等候', pending: '待通知', notified: '已通知', taken: '已接', cancelled: '划掉', expired: '过号', 'notify-failed': '通知失败', 'notify-unknown': '通知结果未定', 'needs-info': '待补资料' });
  assert.equal(Z.queueSummary.settingsOk(30, false), '设置有效（留位 30 分钟）；暂停：否');
  assert.equal(Z.queueSummary.settingsBad('x'), '设置无效（x）');
  assert.equal(Z.queueSummary.hold('3', '等候', 'T'), '留位：3（等候，线程 T）');
  assert.equal(Z.queueSummary.noHold, '留位：没有');
  assert.equal(Z.queueSummary.line(1, 'H', 'S', false), '排队：占队列 1 件；H；S；现场待检查标记：没有');
});

test('rework additions: format-check and blind-spot report lines are the old Chinese lines', () => {
  const F = Z.fc, B = Z.bs;
  assert.equal(F.title('2026-11-22'), '# 格式抽查 · 2026-11-22');
  assert.deepEqual([F.secRecords, F.secCards, F.secLedger, F.secNotChecked], ['## 任务记录（F1、F2）', '## 任务卡（F3）', '## 决定账本（F4）', '## 未能检查']);
  assert.equal(F.secHandoff(8), '## 转手条数（H1；点名 8 条以上标“交日审判断”，其余日审不必读全文）');
  assert.equal(F.cannotCheck('决定账本', 'E'), '未能检查：决定账本（E）');
  assert.equal(F.cardNoLabel('审计:'), '没有 审计:… 标签');
  assert.equal(F.ledgerAllOk(3, '原话'), '- 查了 3 条，都有日期和“原话：”');
  assert.equal(F.ledgerUnchanged, '- 自上一轮以来账本文件没改过，没查');
  assert.equal(F.rowOk('a', 'b', 9, 9, 8), '| a | b | 9 | 9 | **交日审判断** |');
  assert.equal(F.rowOk('a', 'b', 7, 7, 8), '| a | b | 7 | 7 | <8，脚本数，不必读 |');
  assert.equal(F.eTooMany(5), '消息太多，只读了最近 5 条');
  assert.equal(F.tooManyRe, '^消息太多');
  assert.deepEqual([B.secClues, B.secRework, B.secOutside, B.secRules, B.secBackup], ['## 线索汇总', '## 一、返工次数', '## 二、范围外文件（补文件管理那份没盖的）', '### A 规则文件被改', '## 三、备份状态']);
  assert.equal(B.secLock, '### B2 桌面角色提交类点击识别的运行情况（来自屏幕锁日志）');
  assert.equal(B.title('2026-11-22'), '# 盲区抽查 · 2026-11-22');
  assert.equal(B.cannotCheck('返工次数', 'E'), '未能检查：返工次数（E）');
  assert.equal(B.cannotWord, '未能检查');
});

test('rework additions: every fixed sentence for the owner (notices) is the old Chinese sentence', () => {
  // [path in notices, arguments, the exact text the programs sent before the lexicon existed]
  const SENTENCES = [
    ["dateMD", [11, 22], "11 月 22 日"],
    ["dateTime", [11, 22, "09", "30"], "11 月 22 日 09:30"],
    ["titleQuote", ["<t>"], "《<t>》"],
    ["approvalCard.noReason", null, "（没写事由）"],
    ["approvalCard.newCard", ["<@100000000000000001>", "<source>", "C-1", "<one>"], "<@100000000000000001> 审批频道有一张新审批卡：<source>（任务卡 C-1）——<one>"],
    ["closing.source", null, "结案确认"],
    ["closing.title", null, "结案确认"],
    ["closing.jn", null, "、"],
    ["closing.reasons.duplicate", null, "送审重复，待核"],
    ["closing.reasons.unverifiable", null, "成果无法核对"],
    ["closing.reasons.unbound", null, "补审绑定核不了"],
    ["closing.description", ["C-1", 3, "<reasons>"], "卡 C-1、送审第 3 次：<reasons>，需要主人本人批准才能完成。批准只对这一张卡这一次结案有效。"],
    ["closing.botLine", ["<agent>", "C-1"], "\n——申请的 bot：<agent>；任务卡：C-1"],
    ["closing.threadLine", ["L-1"], "；原线程：L-1。批准只放行这一张卡这一次结案。"],
    ["closing.sessionFallback", ["<key>"], "（会话 <key>）"],
    ["closing.timeoutReason", null, "没有批准，结案没有进行"],
    ["desktopApproval.source", null, "桌面角色六类操作"],
    ["desktopApproval.title", null, "六类操作确认"],
    ["desktopApproval.timeoutReason", null, "没有批准，屏幕上的东西没有被动"],
    ["desktopApproval.jn", null, "、"],
    ["desktopApproval.whatHead", null, "什么事："],
    ["desktopApproval.whatMissing", null, "（没有记下是哪件事）"],
    ["desktopApproval.programNote", null, "这一项是程序认出来的，不是桌面角色自己报的。"],
    ["desktopApproval.approved", ["<programNote>"], "。批的是什么：只放行桌面角色的这一次屏幕调用（用过就作废，下一项要重新记等确认、重新批）。<programNote>申请的 bot：桌面角色。来自任务卡："],
    ["desktopApproval.linkTail", ["L-1"], "；原线程：L-1。"],
    ["desktopApproval.tail", ["<tid>"], "桌面角色在线程 <tid> 里要继续动屏幕；之后要再做六类操作，桌面角色要先重新记“等确认”、重新批。"],
    ["desktopApproval.ambiguous", ["<list>", "<tid>"], "这个线程对应多张还没结束的卡（<list>），没法确定是哪张（线程 <tid>）"],
    ["desktopApproval.ambiguousMore", [3], "等 3 张"],
    ["desktopApproval.noCard", ["<tid>"], "没查到关联任务卡（线程 <tid>）"],
    ["desktopApproval.selfCheckMarker", ["<t>"], "（自检号 S<t>）"],
    ["desktopApproval.recognized.upload", null, "（程序认出）选择要上传的文件"],
    ["desktopApproval.recognized.dialog", null, "（程序认出）在网页弹出的确认框里点“确定”"],
    ["desktopApproval.recognized.click", ["<label>", "<role>", "<win>"], "（程序认出）点击「<label>」（<role>），窗口《<win>》"],
    ["desktopApproval.recognized.menu", ["<path>"], "（程序认出）选择菜单「<path>」"],
    ["desktopApproval.recognized.enter", ["<label>", "<win>"], "（程序认出）按回车键（或带换行的输入）；屏幕上有「<label>」按钮，可能就是在点它，窗口《<win>》"],
    ["desktopApproval.expired", ["<@100000000000000001>", 7], "<@100000000000000001> 桌面角色这一轮没接上（排队号 7），你那件事先让给下一位了；还要做就在这个线程再叫她一次。"],
    ["desktopApproval.selfCheck", ["<marker>"], "桌面角色排队自检（不是点名）<marker>"],
    ["desktopApproval.stuck", ["<@100000000000000001>", "L-1"], "<@100000000000000001> 桌面角色在线程 L-1 卡住了，点名任务审计求助，已经超过 20 分钟没有收到她的“【求助回复】”。桌面角色不会再自己动屏幕，屏幕停在卡住的地方。你可以去那个线程说一声怎么办，或者叫任务审计再看一眼。"],
    ["ledger.tableTitle", null, "**等你定的事（总表）**"],
    ["ledger.tableNote", null, "只列还没定的；点链接回到原请示，在原请示下回复或在那件的线程里回才算数。"],
    ["ledger.tag", ["<fp>"], "〔等你定·<fp>〕"],
    ["ledger.updatedLabel", null, "上次整理："],
    ["ledger.updated", ["<t>"], "上次整理：<t> UTC"],
    ["ledger.none", null, "（现在没有）"],
    ["ledger.tooLong", null, "…（太长，其余见台账）"],
    ["ledger.itemFull", [3, "<title>", "<suggestion>", "<blocks>", "<deadline>", "<st>", "F", "L-1"], ["3. <title>（建议：<suggestion>；不定会卡住：<blocks>；截止：<deadline>；状态：<st>；F）", "   原请示：L-1"]],
    ["ledger.itemOne", [3, "<title>", "<st>", "L-1"], "3. <title>（<st>）原请示 L-1"],
    ["ledger.itemTitle", [3, "<title>", "<st>"], "3. <title>（<st>）"],
    ["ledger.linkFallback", ["<mid>"], "消息 <mid>"],
    ["ledger.flagJoin", null, "；"],
    ["ledger.flagPossible", ["<mid>"], "你可能回过（消息 <mid>），bot 还没对上"],
    ["ledger.flagUnknown", ["<x>"], "回应：未知（<x>）"],
    ["ledger.readFailed", ["<hhmm>"], "读取失败，<hhmm>"],
    ["ledger.received", ["<word>", true, "<date>"], "<word>（未约定日期，默认<date> 再看）"],
    ["ledger.judgeTimeoutNote", null, "你回过，bot 没判出，请看一眼"],
    ["ledger.batchAsk", ["<@100000000000000001>", 3, "<list>"], "<@100000000000000001> 搭建期遗留的 3 件还要你定，总表置顶在这里：\n<list>"],
    ["ledger.batchLine", ["<k>", "<title>", "L-1"], "<k>. <title>（原请示 L-1）"],
    ["ledger.newAsk", ["<@100000000000000001>", "<title>", "L-1"], "<@100000000000000001> 新的一件等你定：<title>，原请示 L-1"],
    ["ledger.mergedExtra", null, "\n（读不到 Discord，以下几件状态未知）"],
    ["ledger.mergedLine", ["<k>", "<title>", true, "L-1"], "<k>. <title>（你可能回过，bot 还没对上；原请示 L-1）"],
    ["ledger.mergedBody", ["<@100000000000000001>", "<extra>", "<lines>"], "<@100000000000000001> 合并提醒：这几件还在等你定<extra>\n<lines>\n全表在置顶。"],
    ["ledger.deadlineAsk", ["<@100000000000000001>", "<deadline>", "<title>", "L-1"], "<@100000000000000001> 快到截止了（<deadline>）：<title>，原请示 L-1"],
    ["ledger.expiryNoReason", null, "（没写事由）"],
    ["ledger.expiryTitle", ["<kind>", "<one>"], "审批过期没批：<kind>——<one>"],
    ["ledger.expirySuggestion", null, "要做就告诉总控，她会让那个 bot 重新申请，新卡弹出你再点允许；不管就按没批处理"],
    ["ledger.expiryBlocks", ["<kind>"], "<kind>那件事没有做"],
    ["ledger.expiryReminder", ["<@100000000000000001>", "<deadline>", "<title>", "C-1", "L-1"], "<@100000000000000001> 有一件审批过期没批，快到 24 小时了（<deadline>）：<title>（任务卡 C-1），原线程 L-1。要做的话告诉总控，她会让那个 bot 重新申请，新卡弹出你再点允许；不管就按没批处理。"],
    ["ledger.expiryThread", null, "这件审批过期了（超过 24 小时没批），按没批处理；要做请再叫我。"],
    ["reset.pre", null, "【每日重置提醒】18:00 整，工坊和各项目频道主区域的会话会重置：之后各 bot 在主区域的第一句话会开新会话，靠任务记录接着做，你不用重新解释。任务线程不受影响（闲置满 24 小时才重置）。有话没说完的话，18:00 前说完最稳。"],
    ["reset.post", null, "【每日重置】18:00 已过。从现在起各 bot 在主区域的下一句话会用新会话；做到一半的活靠任务记录接着做。如果哪个 bot 不记得上文，叫它先读任务记录。"],
    ["reminders.apiFirst", ["<when>", 22], "这一期 API 额度 <when> 到期，还剩 22 天。"],
    ["reminders.apiUsedLong", ["<@100000000000000001>", "<first>"], "【API 额度提醒】<@100000000000000001> 额度已经用完，日审、巡查、异常深审、周审已经停了；<first>请去 Anthropic Console 的 Billing 页看有没有下一期可领。"],
    ["reminders.apiLong", ["<@100000000000000001>", "<first>"], "【API 额度提醒】<@100000000000000001> <first>请去 Anthropic Console 的 Billing 页看有没有下一期可领；这期用不完的话，可以叫总控调备用A、备用B多用一点。"],
    ["reminders.apiUsedShort", ["<@100000000000000001>", "<first>"], "【API 额度提醒】<@100000000000000001> 额度已经用完，日审、巡查、异常深审、周审已经停了；<first>下一期领了吗？领了回总控一句“新一期到 X 月 X 日到期”。"],
    ["reminders.apiTomorrow", ["<@100000000000000001>", "<when>"], "【API 额度提醒】<@100000000000000001> 明天（<when>）这一期 API 额度到期。领了下一期的话，回总控一句“新一期到 X 月 X 日到期”；没领到的话，到点后四个审计任务会自动暂停。这期还有用不完的额度，可以叫总控今天调备用A、备用B用掉。"],
    ["reminders.apiStopped", ["<@100000000000000001>", 2, "<reason>"], "【API 额度提醒】<@100000000000000001> 日审、巡查、异常深审、周审已经停了 2 天（<reason>）。下一期领了吗？领了回总控一句“新一期到 X 月 X 日到期”，我就恢复。"],
    ["reminders.pauseReason", ["<r>"], "<r>"],
    ["reminders.apiNoExpiry", ["<@100000000000000001>"], "【API 额度提醒】<@100000000000000001> 我没记着下一期 API 额度的到期日。请去 Console 看一下，回总控一句“新一期到 X 月 X 日到期”。"],
    ["reminders.apiNoGate", ["<@100000000000000001>"], "【API 额度提醒】<@100000000000000001> 我这边读不到额度闸的状态，也就不知道下一期到期日。请去 Console 看一下，回总控一句“新一期到 X 月 X 日到期”。"],
    ["reminders.reviewNoGate", null, "额度闸的记录我这次读不到，审计任务停过几次不清楚。"],
    ["reminders.reviewZones", [3, 2], "这段时间审计任务共停过 3 次，约 2 天。"],
    ["reminders.reviewNone", null, "这段时间审计任务没因额度停过。"],
    ["reminders.review", ["<@100000000000000001>", "<hist>"], "【API 额度·复议】<@100000000000000001> 当初约好这个时候复议，现在该定了：①继续“用完即停” ②改成“用完转订阅” ③撤回订阅，三选一。<hist>用量请再去 Console 看一眼。"],
    ["reminders.loginOut", ["<@100000000000000001>"], "【Claude 登录】<@100000000000000001> 本机的 Claude 已经退出登录了。所有走 Claude 订阅的 bot 现在可能都不能回话。重新登录：打开「终端」→ 输入 `~/.local/bin/claude auth login` 回车 → 浏览器里按平时登 Claude 的方式登录并同意授权。"],
    ["reminders.loginCaveat", null, "（按记录的到期日，没能向 Claude 核实）"],
    ["reminders.loginRenewed", ["<@100000000000000001>", "<when>"], "【Claude 登录】<@100000000000000001> 登录已更新，新的到期日是 <when>。旧的提醒作废。"],
    ["reminders.loginBody", ["<when>", 3, "<caveat>"], "本机的 Claude 登录 **<when>** 到期（还剩 3 天）<caveat>。到期后**所有走 Claude 订阅的 bot 会同时不能回话**（走 API 额度的备用A、备用B和四个审计任务不受这个影响）。重新登录大约 2 分钟：\n1. 打开 Mac 上的「终端」。\n2. 输入 `~/.local/bin/claude auth login` 然后回车。（直接敲 `claude` 会提示找不到命令。）\n3. 浏览器会自动弹出 Claude 的登录页，按平时登 Claude 的方式登，出现授权就点同意。\n4. 回到终端，看到登录成功就行。\n登完不用做别的：这条提醒下次会自动发现新到期日并停发。"],
    ["reminders.loginSoon", ["<@100000000000000001>", "<body>"], "【Claude 登录快到期】<@100000000000000001>：<body>"],
    ["reminders.loginExpired", ["<@100000000000000001>", "<when>", "<caveat>"], "【Claude 登录已过期】<@100000000000000001> 本机的 Claude 登录已经过期（<when>）<caveat>。所有走 Claude 订阅的 bot 现在应该都不能回话。请尽快重新登录：打开「终端」→ 输入 `~/.local/bin/claude auth login` 回车 → 浏览器里登录并同意授权。"],
    ["quotaGate.pauseWhyExpired", ["<when>"], "本期额度已到期（<when>）"],
    ["quotaGate.pauseWhyExpiredFallback", null, "到期日"],
    ["quotaGate.pauseWhyManual", null, "API 额度被手动暂停"],
    ["quotaGate.pauseWhyUsed", null, "API 额度用完了（官方回的是“钱不够”）"],
    ["quotaGate.pause", ["<why>", "<at>"], "【API 额度】<why>。已暂停日审、巡查、异常深审、周审，不再每天往工坊报失败。\n暂停期间：这四个任务都不跑；挂在日审触发脚本上的每日命令抽查和文件对账也会一起停；没人每天巡检系统，“白天看护”照常跑。备用A、备用B和走订阅的 bot 不受影响。\n恢复办法：额度回来后我会自动试探并恢复；也可以告诉总控“新一期到 X 月 X 日到期”。（<at> 记）"],
    ["quotaGate.resumeHeadManual", null, "已按指令恢复"],
    ["quotaGate.resumeHeadAuto", null, "额度回来了，已自动恢复"],
    ["quotaGate.resumeExp", ["<when>"], "新一期记到 <when> 到期。"],
    ["quotaGate.resumeNoExp", null, "请告诉我新一期的到期日（回总控一句“新一期到 X 月 X 日到期”），不然我不知道下次什么时候停。"],
    ["quotaGate.resume", ["<head>", 2, "<exp>"], "【API 额度】<head>日审、巡查、异常深审、周审（停了约 2 天）。<exp>\n提醒：恢复后第一次日审要补审暂停这几天，可能比平时久。"],
    ["quotaGate.verbStop", null, "没停成"],
    ["quotaGate.verbEnable", null, "没启用成"],
    ["quotaGate.jn", null, "、"],
    ["quotaGate.partial", ["<failed>", 3, "<verb>"], "【API 额度】<failed> 3 个<verb>，我会每 30 分钟继续试。"],
    ["quotaGate.stuck", ["<failed>", "<verb>"], "【API 额度】<failed> 连着 3 轮都<verb>，请人看一下（可在终端用 openclaw cron list --all 查）。"],
    ["dayWatch.stateWord", ["<s>"], "<s>"],
    ["dayWatch.discordResume", [3], "最近 1 小时 Discord 有 3 次重连没能续上原来的连接（resume=false），可能丢了这几秒的消息"],
    ["dayWatch.discordHeartbeat", [3], "最近 1 小时 Discord 心跳没回 3 次（平时一天约 1 次）"],
    ["dayWatch.catchupState", ["<name>", "<st>"], "补跑账“<name>”状态是“<st>”（第一段补跑留下的，要人看一眼）"],
    ["dayWatch.catchupNotice", ["<name>", "<ns>"], "补跑账“<name>”的通知<ns>（工坊可能没收到）"],
    ["dayWatch.catchupStuck", ["<day>"], "补跑检查卡住过（<day>，锁比时限的两倍还老，没有抢锁）"],
    ["dayWatch.quotaHit", ["<role>", "<job>", "<snippet>", "<resumeAt>"], "额度用完停下：<role><job>，<snippet>恢复时间 <resumeAt>；不是补跑管的那四个任务，请判断要不要接着做"],
    ["dayWatch.quotaRoleUnknown", null, "未知角色"],
    ["dayWatch.quotaJob", ["<id>"], "（定时任务 <id>）"],
    ["dayWatch.quotaChat", null, "（对话里）"],
    ["dayWatch.quotaSnippet", ["<s>"], "“<s>”，"],
    ["dayWatch.quotaResumeUnknown", null, "未知"],
    ["dayWatch.lockWhatLedger", null, "“等你定”台账锁太老"],
    ["dayWatch.lockWhatWatch", null, "白天看护锁太老"],
    ["dayWatch.lockStale", ["<what>", "<name>", "<at>"], "<what>，没有抢锁（日志 <name>，最后一次 <at>），要人处理"],
    ["dayWatch.boardUnreadable", [11], "读不到任务板：11"],
    ["dayWatch.cardStale", ["<title>", "<id>", 12], "任务卡“<title>”（<id>）运行中，12 分钟没动"],
    ["dayWatch.oneshotMissed", ["<title>", "<job>"], "卡“<title>”的到点任务 <job> 时间已过，没有运行记录"],
    ["dayWatch.oneshotFailed", ["<title>", "<job>", "<status>"], "卡“<title>”的到点任务 <job> 运行状态是 <status>"],
    ["dayWatch.oneshotOkNotDone", ["<title>", "<job>"], "卡“<title>”的到点任务 <job> 跑完了（ok），但卡还没完成：核实事情是不是真做成了"],
    ["dayWatch.closingUnlogged", ["<title>", "<id>"], "卡“<title>”（<id>）完成了，但结案关口没有放行记录（可能是你本人在控制台改的，也可能走了绕法）"],
    ["dayWatch.ledgerTitle", ["<text>"], "白天看护：<text>"],
    ["dayWatch.suggestionEscalate", null, "停用这项看护或人工处理"],
    ["dayWatch.suggestionLook", null, "看一眼这张卡是不是你本人改的；不是就让总控查"],
    ["dayWatch.blocks", null, "这件异常目前没人处理，会一直重复出现"],
    ["catchup.lockStuck", null, "补跑检查卡住，待核（锁文件比时限的两倍还老，没有抢锁）"],
    ["catchup.failedTwice", ["<task>", "<date>"], "补跑失败：<task>（<date>）额度两次未恢复，不再试"],
    ["catchup.skipped", ["<task>", "<date>"], "已跳过：<task>（<date>）离下一轮太近，不补了"],
    ["catchup.uncertainMany", ["<task>", "<date>"], "补跑待核：<task>（<date>），发起后出现了不止一条运行，不再自动发起"],
    ["catchup.uncertainNoRecord", ["<task>", "<date>"], "补跑待核：<task>（<date>），没找到发起记录，不再自动发起"],
    ["catchup.resultQueue", ["<task>", "<date>"], "补跑结果待核：<task>（<date>），排队太久查不到结果，不再追加请求"],
    ["catchup.resultUnclear", ["<task>", "<date>"], "补跑结果待核：<task>（<date>），查不清这条运行属于哪一轮，不再追加请求"],
    ["catchup.done", ["<task>", "<date>"], "已补跑：<task>（<date>）"],
    ["catchup.resultUnverified", ["<task>", "<date>"], "补跑结果待核：<task>（<date>），运行成功但本轮记录或发送凭据没核过"],
    ["catchup.failedWithReason", ["<task>", "<date>", "<reason>"], "补跑失败：<task>（<date>）<reason>，不再试"],
    ["quotaResume.resumed", [3, "<links>"], "额度恢复，已让 3 件停在半路的活接着做：<links>"],
    ["quotaResume.stuck", [3, "<items>"], "有 3 件没接上或没法确认，请你在这些线程里说“继续”：<items>"],
    ["quotaResume.item", ["L-1", "type"], "L-1（type）"],
    ["quotaResume.jn", null, "、"],
    ["quotaResume.typeWord", ["<t>"], "<t>"],
    ["auditGuard.p4Title", null, "P4 转发测试"],
    ["auditGuard.p4Description", null, "这是插件审批转发测试：请点“拒绝”。通过与否都不会改动任何东西。"],
    ["ledgerWatch.gaveUp", [3, 3], "【账本待补】还有 3 条决定没写进账本，已经叫过总控 3 次没补上，请人看一下。"],
    ["ledgerWatch.old", [3, 2], "【账本待补】账本还有 3 条决定没补，最早一条已经 2 天了，请看一下。"],
  ];
  const get = (o, p) => p.split('.').reduce((a, k) => a[k], o);
  for (const [path, args, want] of SENTENCES) {
    const v = get(Z.notices, path);
    assert.deepEqual(args === null ? v : v(...args), want, path);
  }
  const all = [];
  const walk = (o, base) => { for (const [k, v] of Object.entries(o)) { const p = base ? `${base}.${k}` : k; if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p); else all.push(p); } };
  walk(Z.notices, '');
  assert.equal(all.length, SENTENCES.length, 'a sentence has no assertion');
});
