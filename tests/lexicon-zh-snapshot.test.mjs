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
