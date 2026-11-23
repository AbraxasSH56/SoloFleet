# 换语言要改的地方

[English](../en/localization.md) | 简体中文

参考部署是用中文搭的。现在，**程序认的、写的、发的协议词都跟 `locale` 走**（默认 `en`，或 `zh-CN`）。共用规则、角色头部、模板和定时任务指令都有两个版本，各一种语言（`*.zh-CN.md` 是中文版）；每种语言里，这四样和程序用的是同一套词。

## `locale` 管什么

- **协议词**：进度句开头、任务记录的小节标题和标签、任务卡上的标签、送审单和审计报告的首行、求助标记、排队划掉的原因、台账状态词、作业名等等。第 1 节逐个列出，并写明在哪些文件里认。
- **数据根里的文件夹和文件名**，以及模板文件名（`项目/<名>/{任务,成果,历史}`、`决定账本.md`、`模板/`、`审计/...`、`运行记录/...`）。第 2 节列出。
- **模板里的占位符**（en 用 `{{PROJECT_NAME}}`，zh-CN 用 `{{项目名}}`）。
- **程序对 bot 说的指令句**：求助格式、桌面排队通知、塞进总控这一轮的待批提醒、额度恢复的唤醒句、两个台账工具的说明、完成记录。
- **回复附卡上的文字**（型号行、修改行、额度行）和两句固定系统消息的替换句。
- **英文过程话清理**只在 `zh-CN` 时开（它是配合"一律说中文"的部署写的）。
- 审计守门拿哪个语言的**任务指令片段**算指纹。

`locale` **不管**的：桌面敏感词表（中文词和英文词永远同时生效，因为这张表管付款、发送、删除和安装）、`claude -p` 额度用完时的英文报错句（`quota-recovery.mjs` 按原句认）、命令行参数名，以及下面"剩余边界"那一节列的东西。

**建数据根之前先定好 `locale`，以后不要改。** 台账和状态文件里存的是写入时那个语言的词（比如状态 `没回` 或 `no-reply`）。把已有的数据根从一种 locale 改成另一种，程序不会帮你迁移；换语言就新建一个数据根。已经在跑的中文部署照旧，行为不变。

两个沙箱触发脚本（`scripts/automation/command-spot-check-trigger.js`、`scripts/automation/deep-review-trigger.js`）跑在 OpenClaw 的脚本沙箱里，读不了 `config/crew.json`。每个脚本顶部有一行手填常量 `const LOCALE = "en";`（见 [configuration.md](configuration.md) 第 5 节），要和 `locale` 填成一样；每个脚本里还带着一张自己要用的小词表，`tests/trigger-literals-consistency.test.mjs` 保证它和 `lexicon.mjs` 一致。`scripts/automation/publish-self.py` 从配置里读 `locale`，也自带一张表（`tests/publish-table-consistency.test.mjs` 核对）。

## 1. 程序按字面认或写的词

总表是 `plugins/personal-inbox/lexicon.mjs`（一个词一个键，两种语言键完全相同）。带冒号的词存的时候不带冒号：zh-CN 写全角冒号 `：`、两种冒号都认；en 写 `: `、认半角冒号和冒号后的空格。

### 1.1 进度句、任务记录、总索引

| 键名 | zh-CN | en | 在哪些文件用到 |
|---|---|---|---|
| `progressOpeners` | `完成：` / `进行中：` / `没跑成：` / `等主人：` / `卡住：` | `Done:` / `In progress:` / `Did not run:` / `Waiting on owner:` / `Stuck:` | scripts/automation/daily-format-check.mjs (status word of the record), rules |
| `statusLabel` | `状态` | `Status` | scripts/automation/daily-format-check.mjs, plugins/personal-inbox/project-files.mjs, templates (label word; the colon is written by the program) |
| `sectionCurrentStatus` | `当前状态` | `Current status` | scripts/automation/daily-format-check.mjs, plugins/personal-inbox/project-files.mjs, templates |
| `sectionWaitingForOwner` | `等主人拍板` | `Waiting for the owner's decision` | scripts/automation/daily-format-check.mjs, templates, rules |
| `sectionResults` | `当前成果` | `Current results` | plugins/personal-inbox/project-files.mjs, templates, rules |
| `noneWord` | `无` | `None` | scripts/automation/daily-format-check.mjs |
| `placeholderCell` | `暂无（待写）` | `None yet (to be written)` | plugins/personal-inbox/project-files.mjs, templates |
| `indexProjectHeader` | `项目` | `Project` | plugins/personal-inbox/project-files.mjs (first column of the project table in INDEX.md) |
| `idLabel` | `编号` | `ID` | plugins/personal-inbox/project-files.mjs, scripts/automation/lead-free.mjs (channel cell: name (ID digits)) |
| `projectEntryLinkText` | `项目入口` | `Project entry` | plugins/personal-inbox/project-files.mjs (entry column of INDEX.md) |
| `taskRecordTitle` | `任务记录` | `Task record` | plugins/personal-inbox/project-files.mjs, templates (title line of a task record) |
| `noteStart` | `<!-- 模板说明开始 -->` | `<!-- template note begin -->` | plugins/personal-inbox/project-files.mjs, templates (usage note removed when a file is created) |

五个开头写在线程里进度句的最前面，后面跟冒号（`Done:`、`完成：`）。任务记录里的状态行是标签加词（`状态：完成`）。

### 1.2 任务卡、送审单、审计报告

| 键名 | zh-CN | en | 在哪些文件用到 |
|---|---|---|---|
| `auditLabelPrefix` | `审计:` | `audit:` | scripts/automation/daily-format-check.mjs, plugins/personal-inbox/audit-gate.mjs |
| `auditLabelValues` | `单审任务审计` / `单审独立` / `串联` | `single-task` / `single-independent` / `chained` | plugins/personal-inbox/audit-gate.mjs, templates, rules |
| `auditLevelWord` | `审计级别` | `Audit level` | scripts/automation/daily-format-check.mjs, plugins/personal-inbox/audit-gate.mjs (the tag [Audit level] and the comment label) |
| `auditBodyValues` | `[object Object]` | `[object Object]` | plugins/personal-inbox/audit-gate.mjs (first line of the card body), templates |
| `authorizationWord` | `授权范围` | `Authorization scope` | scripts/automation/daily-format-check.mjs (the tag [Authorization scope]), rules |
| `authorizationLines` | `目标` / `允许做的` / `要主人确认的` / `停止条件` | `Goal` / `Allowed` / `Needs owner confirmation` / `Stop conditions` | scripts/automation/daily-format-check.mjs |
| `ownerWord` | `主人` | `owner` | scripts/automation/daily-format-check.mjs (owner … confirmed / approved) |
| `confirmWords` | `确认` / `批准` | `confirmed` / `approved` | scripts/automation/daily-format-check.mjs |
| `submissionHead` | `[object Object]` | `[object Object]` | plugins/personal-inbox/audit-gate.mjs (first line of a submission sheet) |
| `submissionCard` | `任务卡` | `Task card` | plugins/personal-inbox/audit-gate.mjs (second line) |
| `submissionPaths` | `成果位置` | `Result location` | plugins/personal-inbox/audit-gate.mjs (the block that lists the result paths) |
| `reportVerdict` | `[object Object]` | `[object Object]` | plugins/personal-inbox/audit-gate.mjs (first line of an audit report), task auditor rules |

规则里还引了几个标签，但没有程序按它们匹配（`主人原话：`、`验收标准：`、`任务类型：`、`执行者：`、`上次报告：`、`我问：`、`证据：`、`严重程度：`）；它们跟着正文用同一种语言写。

### 1.3 求助和桌面排队

| 键名 | zh-CN | en | 在哪些文件用到 |
|---|---|---|---|
| `helpRequestMarker` | `【求助】` | `[Help request]` | plugins/personal-inbox/stuck-guard.mjs, plugins/personal-inbox/desktop-lock.mjs, rules |
| `helpReplyMarker` | `【求助回复】` | `[Help reply]` | plugins/personal-inbox/stuck-guard.mjs, rules |
| `queueSkipReasons` | `不用了` / `完成` / `被接手` | `not-needed` / `done` / `taken-over` | plugins/personal-inbox/desktop-lock.mjs (skip --why), rules |

### 1.4 "等你定"台账和程序代发的标记

| 键名 | zh-CN | en | 在哪些文件用到 |
|---|---|---|---|
| `ledgerStatus.received` | `收到` | `received` | plugins/personal-inbox/pending-ledger.mjs, plugins/personal-inbox/pending-tools.mjs, rules |
| `ledgerStatus.decided` | `已定` | `decided` | same |
| `ledgerStatus.revoked` | `撤销` | `revoked` | same |
| `ledgerStatus.noReply` | `没回` | `no-reply` | same |
| `ledgerStatus.judging` | `待判` | `to-judge` | plugins/personal-inbox/pending-ledger.mjs (internal state) |
| `ledgerSources.approvalExpired` | `审批过期` | `approval-expired` | plugins/personal-inbox/pending-ledger.mjs, rules |
| `ledgerKinds.closing` | `结案确认` | `closing-confirmation` | plugins/personal-inbox/audit-gate.mjs, plugins/personal-inbox/pending-ledger.mjs |
| `ledgerKinds.desktop` | `桌面角色六类操作` | `desktop-six-actions` | plugins/personal-inbox/desktop-lock.mjs, plugins/personal-inbox/pending-ledger.mjs |
| `autoRegisterPrefix` | `（程序补登记）` | `(auto-registered) ` | plugins/personal-inbox/request-watch.mjs, plugins/personal-inbox/pending-tools.mjs |
| `noDeadline` | `没截止` | `no deadline` | plugins/personal-inbox/pending-ledger.mjs, plugins/personal-inbox/pending-tools.mjs, plugins/personal-inbox/request-watch.mjs |
| `testMarker` | `【测试】` | `[test]` | plugins/personal-inbox/request-watch.mjs, scripts/automation/ledger-watch.mjs |
| `approvalReminderMarker` | `【待批提醒——程序加的，不是主人说的话】` | `[Pending-approval reminder — added by the program, not the owner's words]` | plugins/personal-inbox/approval-reminder.mjs, rules |
| `quotaResumePrefix` | `【额度恢复·程序代发】` | `[Quota restored · sent by program]` | scripts/automation/quota-resume.mjs, rules |

### 1.5 完成记录、决定账本、生成的报告、名字

| 键名 | zh-CN | en | 在哪些文件用到 |
|---|---|---|---|
| `reminderWord` | `提醒` | `Reminder` | plugins/personal-inbox/completion-notice.mjs (the reminder at the end of a completion record), rules |
| `ledgerQuoteLabel` | `原话` | `Quote` | scripts/automation/daily-format-check.mjs, scripts/automation/ledger-watch.mjs, templates |
| `ledgerDateLabel` | `日期` | `Date` | scripts/automation/daily-format-check.mjs, templates |
| `ledgerSections` | `一、有效的决定` / `二、已被取代的决定` | `1. Active decisions` / `2. Superseded decisions` | scripts/automation/ledger-verify.mjs, templates |
| `businessDateLabel` | `业务日期` | `Business date` | report files written by the checks; scripts/automation/day-watch.mjs reads them |
| `reportComplete` | `完整` | `complete` | scripts/automation/day-watch.mjs (the line "Status: complete") |
| `timedJobLabels.id` | `定时任务编号` | `Timed job ID` | scripts/automation/day-watch.mjs (card body) |
| `timedJobLabels.due` | `到点时间` | `Due time` | scripts/automation/day-watch.mjs (card body) |
| `waitingLabels` | `等确认` / `等主人确认` / `已取消` | `waiting-confirm` / `waiting-owner-confirm` / `cancelled` | scripts/automation/day-watch.mjs (card labels) |
| `mainRoleDisplayName` | `总控` | `Controller` | scripts/automation/bot-roster.mjs, scripts/automation/lead-free.mjs |
| `dataAlias` | `资料` | `dataroot` | plugins/personal-inbox/execution-record.mjs (changed-files list), rules |

### 1.6 作业名、审计本轮记录、异常标记、发布回执

| 键名 | zh-CN | en | 在哪些文件用到 |
|---|---|---|---|
| `jobNames.daily` | `日审` | `daily-audit` | scripts/automation/quota-catchup.mjs, scripts/automation/api-quota-gate.mjs, plugins/personal-inbox/quota-recovery.mjs, jobs |
| `jobNames.patrol` | `巡查` | `patrol` | same, scripts/automation/publish-self.py |
| `jobNames.deepReview` | `异常深审` | `deep-review` | same |
| `jobNames.weekly` | `周审` | `weekly-audit` | same |
| `jobNames.quotaCatchup` | `额度补跑` | `quota-catchup` | scripts/automation/quota-catchup.mjs (its own cron job) |
| `jobNames.deskQueue` | `桌面排队推进` | `desktop-queue-advance` | jobs/patrol.md |
| `auditRecordKeys.execution` | `执行` | `execution` | round record written by the job; read by scripts/automation/daily-format-check.mjs, scripts/automation/quota-catchup.mjs, scripts/automation/publish-self.py |
| `auditRecordValues.done` | `完成` | `done` | same |
| `flagKeys.status` | `状态` | `status` | anomaly flags; scripts/automation/deep-review-trigger.js |
| `flagStates.reviewed` | `已深审` | `reviewed` | same |
| `receiptKeys.state` | `状态` | `state` | publish receipts; scripts/automation/publish-self.py, scripts/automation/quota-catchup.mjs |
| `publishStates.delivered` | `已送达` | `delivered` | same |

作业名同时是 OpenClaw 里定时任务的名字：改了 cron 任务的名字，要同步改 `lexicon.mjs` 里对应的词。`config/crew.json` 的 `jobs.publishSelf.effectiveFrom` 按你这个 locale 的任务名写键（en：`patrol`、`deep-review`、`weekly-audit`；zh-CN：`巡查`、`异常深审`、`周审`）。本轮记录、异常标记和发布回执是 JSON 文件，键和值由模型（照任务指令）或 `publish-self.py` 写；它们都在 `lexicon.mjs` 里（`auditRecordKeys`、`auditRecordValues`、`flagKeys`、`flagStates`、`receiptKeys`、`publishStates`、`publishFiles`）。

## 2. 数据根里的文件夹和文件名

| 键名 | zh-CN | en |
|---|---|---|
| `layout.projects` | `项目` | `projects` |
| `layout.tasks` | `任务` | `tasks` |
| `layout.outputs` | `成果` | `outputs` |
| `layout.history` | `历史` | `history` |
| `layout.templates` | `模板` | `templates` |
| `layout.trash` | `垃圾桶` | `trash` |
| `layout.audit` | `审计` | `audit` |
| `layout.auditDaily` | `日审` | `daily` |
| `layout.auditWeekly` | `周审` | `weekly` |
| `layout.auditPatrol` | `巡查` | `patrol` |
| `layout.auditDeep` | `异常深审` | `deep-review` |
| `layout.auditFlags` | `异常标记` | `anomaly-flags` |
| `layout.auditAwaiting` | `等你定` | `awaiting-decision` |
| `layout.awaitingLedgerFile` | `台账.json` | `ledger.json` |
| `layout.auditChecksums` | `程序校验清单` | `program-checksums` |
| `layout.auditQuota` | `额度读数` | `quota-readings` |
| `layout.auditPublish` | `发布` | `publish` |
| `layout.auditReceipts` | `凭据` | `receipts` |
| `layout.runLogs` | `运行记录` | `run-logs` |
| `layout.scratch` | `临时` | `scratch` |
| `layout.diaryProject` | `日记` | `diary` |
| `layout.ledgerFile` | `决定账本.md` | `decision-ledger.md` |
| `layout.ownerStatusFile` | `主人现况.md` | `owner-status.md` |
| `layout.ruleChangeSheet` | `规则改法单.md` | `rule-change-sheet.md` |
| `layout.taskRecordTemplate` | `任务记录.md` | `task-record.md` |
| `layout.projectEntryTemplate` | `项目入口.md` | `project-entry.md` |
| `layout.diaryFilePrefix` | `日记_` | `diary_` |
| `layout.diaryRerunSuffixes` | `重跑前副本` / `待合并` | `pre-rerun` / `to-merge` |
| `layout.dailyFiles.formatCheck` | `格式抽查.md` | `format-check.md` |
| `layout.dailyFiles.blindspot` | `盲区抽查.md` | `blindspot-check.md` |
| `layout.dailyFiles.commandCheck` | `命令抽查.md` | `command-check.md` |
| `layout.dailyFiles.fileReconcile` | `文件对账.md` | `file-reconcile.md` |
| `layout.dailyFiles.botRoster` | `bot编号表.json` | `bot-roster.json` |
| `layout.runLogDirs.closing` | `结案` | `closing` |
| `layout.runLogDirs.gate` | `守门` | `gate` |
| `layout.runLogDirs.cardThreads` | `卡线程` | `card-threads` |
| `layout.runLogDirs.requestWatch` | `请示待核` | `request-watch` |
| `layout.runLogDirs.ledgerBacklog` | `账本待补` | `ledger-backlog` |
| `layout.runLogDirs.apiQuota` | `API额度` | `api-quota` |
| `layout.runLogDirs.quota` | `额度` | `quota` |
| `layout.runLogDirs.quotaResume` | `接续` | `resume` |
| `layout.runLogDirs.quotaPlanArchive` | `计划存档` | `plan-archive` |
| `layout.runLogDirs.watch` | `看护` | `watch` |
| `layout.runLogDirs.formatCheck` | `格式抽查` | `format-check` |
| `layout.runLogDirs.blindspot` | `盲区抽查` | `blindspot-check` |
| `layout.runLogDirs.fileReconcile` | `文件对账` | `file-reconcile` |
| `layout.runLogDirs.englishCleanupRaw` | `英文清理原文` | `english-cleanup-raw` |
| `layout.runLogDirs.reminders` | `提醒` | `reminders` |
| `layout.runLogDirs.catchup` | `补跑` | `catchup` |
| `layout.runLogDirs.publish` | `发布` | `publish` |

改动名单里的 `资料/`（en 是 `dataroot/`，见 `rules/shared-tail.md`）**只是数据根路径的短别名**：程序把它映射成真实的数据根路径。**不要真去建一个叫 `dataroot` 的文件夹。**

总索引 `INDEX.md` 和项目入口 `PROJECT.md` 的名字不变。`INDEX.md` 的项目表第一列是 `项目`（en：`Project`）；频道一栏写成 `<频道名>（编号 <数字>）`（en：`<channel name> (ID <digits>)`），入口一栏写成 `[项目入口](项目/<名>/PROJECT.md)`（en：`[Project entry](projects/<name>/PROJECT.md)`）。

中文部署：把 `templates/任务记录.md` 和 `templates/项目入口.md` 复制到 `<数据根>/模板/`。英文部署：把 `templates/task-record.md` 和 `templates/project-entry.md` 复制到 `<数据根>/templates/`，并用 `*-header` 模板建 `INDEX.md` 和 `decision-ledger.md`。

## 3. 命令行参数名

已经是英文，不随 `locale` 变：见 [configuration.md](configuration.md) 第 6 节。

## 4. 时区和钟点

不是语言问题，但也是原部署里写死的另一处：所有日期都按 `config/crew.json` 的 `timezone` 算；脚本里的钟点见 [configuration.md](configuration.md) 第 5 节。

## 5. bot 怎么说话

人设是可选的（见 [roles.md](roles.md)）。规则文件只说"配了人设就照人设"，所以口头禅和人设说的语言属于人设，不属于规则。`replyLanguage` 只管回话的默认语言。

## 6. 剩余边界（有意没翻）

下面这些地方在英文部署里仍然是中文。它们都不是"一个程序写、另一个程序或规则按字面认"的词。

- **机器自己读写的 JSON 键名和文件名。** 只有程序读写的文件保留中文名和键：运行记录文件夹里的状态和账本文件（比如额度接续账、补跑账、账本待补的 `待补.json`、API 额度闸的 `状态.json`、`卡标签快照.json`、`基线.json`、锁文件和日志文件），名册文件 `bot编号表.json`（en：`bot-roster.json`）里的键（`人设bot`、`角色`、`显示名`、`Discord编号` 等），以及提醒通知的内部状态。规则和任务指令里要 bot 读到这样的名字时，用反引号原样引出。
- **内部提示和日志。** 报错、日志行、诊断说明、审计守门拒绝命令时给的原因；格式抽查、盲区抽查、命令抽查、文件对账写出的报告里的说明文字（`业务日期：`、`状态：完整` 这类标记是跟 locale 走的）；`publish-self.py` 打印的输出行（要看的是它的退出码）。
- **往 Discord 发给主人的固定通知**（每日重置通知、API 额度提醒、登录提醒、审批卡的另发通知和它的标题与来源、"等你定"总表、给主人看的排队和求助提醒、白天看护的告警）。这些句子目前在各种 locale 下都是中文。
- `builder-tools/` 和 `personas/` 不属于部署，没翻。

## 7. 建议的做法

1. 选好 bot 回话的语言（`replyLanguage`），并让 `locale` 和你用的规则一致；再建数据根。
2. 把你界面语言里的敏感按钮词加进 `plugins/personal-inbox/sensitive-words.json`（中英文永远同时生效）。
3. 想加第三种语言：复制 `lexicon.mjs` 里的一套词，在 `LOCALES` 里加上，翻译规则、模板和任务指令文件，再把整套测试跑一遍（`tests/en/lexicon-parity.en.test.mjs` 展示了两套词怎么保持一致）。
4. 欢迎告诉我们（提 issue 或 PR）你改了哪些词。
