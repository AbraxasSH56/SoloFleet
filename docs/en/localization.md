# Changing the language

English | [简体中文](../zh-CN/localization.md)

The reference deployment was built in Chinese. Today the **words the programs match, write and send follow the `locale` setting** (`en` by default, or `zh-CN`). The shared rules, the role heads, the templates and the job instructions come in two versions, one per language (`*.zh-CN.md` is the Chinese one); in each language all four and the programs use the same set of words.

## What `locale` controls

- **Protocol words**: the openers of progress lines, the section titles and labels of task records, the labels on task cards, the first lines of submission sheets and audit reports, help markers, queue skip reasons, ledger status words, job names and so on. Section 1 lists every one of them, with the files that match them.
- **Folder and file names under the data root**, and the names of the template files (`projects/<name>/{tasks,outputs,history}`, `decision-ledger.md`, `templates/`, `audit/...`, `run-logs/...`). Section 2 lists them.
- **Placeholders in the templates** (`{{PROJECT_NAME}}` in en, `{{项目名}}` in zh-CN).
- **Instruction texts** that the programs give the bots: the help request format, the desktop queue notices, the reminder inserted into the controller turn, the quota-resume wake text, the descriptions of the two ledger tools, and the completion records.
- **Fixed reminders and card texts for the owner** (approval cards, the master list and its reminders, the daily reset notice, the API-credit and login reminders, the daytime-watch alerts, section 1.7), with dates written the way the language does.
- **Reply-card text** (model line, changed-files line, quota line) and the two fixed system sentences.
- The **English-process-paragraph cleanup** runs only for `zh-CN` (it was written for deployments whose rules say "always reply in Chinese").
- Which **language of the job snippets** the audit guard compares against.

`locale` does not change: the desktop sensitive-word list (Chinese and English words are always both active, because the list guards payments, sends and deletions), the English error sentence of `claude -p` when the quota is used up (`quota-recovery.mjs` matches it as it is), command-line parameter names, and the list under "Remaining boundary" below.

**Choose `locale` before you create the data root, and do not change it later.** The ledgers and state files keep the words of the locale they were written in (for example the status `no-reply` or `没回`). Switching an existing data root from one locale to the other does not migrate anything; start a new data root for the other language. Existing zh-CN deployments keep working exactly as before.

The sandbox trigger scripts (`scripts/automation/command-spot-check-trigger.js`, `scripts/automation/deep-review-trigger.js`, `scripts/followups-trigger.js`) run inside OpenClaw's script sandbox and cannot read `config/crew.json`. Each has a hand-filled constant `const LOCALE = "en";` at the top (see [configuration.md](configuration.md), section 5): set it to the same value as `locale`. Each also carries a small table with the words it needs; `tests/trigger-literals-consistency.test.mjs` keeps those tables in step with `lexicon.mjs`. `scripts/automation/publish-self.py` reads `locale` from the config and carries its own table too (`tests/publish-table-consistency.test.mjs`).

## 1. Words the programs match or write

The master list is `plugins/personal-inbox/lexicon.mjs` (one entry per word, the same keys for both languages). Words that take a colon are stored without it: zh-CN writes the full-width colon `：` and reads both colons; en writes `: ` and reads the half-width colon with optional spaces after it.

### 1.1 Progress sentences, task records, index

| Key | zh-CN | en | Used by |
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

The five openers are written at the start of a progress line in the thread, followed by a colon (`Done:`, `完成：`). In the status line of a task record the word comes after the label (`Status: Done`).

### 1.2 Task cards, submission sheets, audit reports

| Key | zh-CN | en | Used by |
|---|---|---|---|
| `auditLabelPrefix` | `审计:` | `audit:` | scripts/automation/daily-format-check.mjs, plugins/personal-inbox/audit-gate.mjs |
| `auditLabelValues` | `单审任务审计` / `单审独立` / `串联` | `single-task` / `single-independent` / `chained` | plugins/personal-inbox/audit-gate.mjs, templates, rules |
| `auditLevelWord` | `审计级别` | `Audit level` | scripts/automation/daily-format-check.mjs, plugins/personal-inbox/audit-gate.mjs (the tag [Audit level] and the comment label) |
| `auditBodyValues` | `单审（任务审计）` / `单审（独立审计）` / `串联` | `Single (task audit)` / `Single (independent audit)` / `Chained` | plugins/personal-inbox/audit-gate.mjs (first line of the card body), templates |
| `authorizationWord` | `授权范围` | `Authorization scope` | scripts/automation/daily-format-check.mjs (the tag [Authorization scope]), rules |
| `authorizationLines` | `目标` / `允许做的` / `要主人确认的` / `停止条件` | `Goal` / `Allowed` / `Needs owner confirmation` / `Stop conditions` | scripts/automation/daily-format-check.mjs |
| `ownerWord` | `主人` | `owner` | scripts/automation/daily-format-check.mjs (owner … confirmed / approved) |
| `confirmWords` | `确认` / `批准` | `confirmed` / `approved` | scripts/automation/daily-format-check.mjs |
| `submissionHead` | `任务审计 ` + card number + ` 请审：` (+ `（第 N 次）` on a re-review) (pieces `pre` / `mid` / `roundOpen` / `roundClose`: `任务审计 ` / ` 请审：` / `（第 ` / ` 次）`) | `Task audit ` + card number + ` please review: ` (+ ` (round N)` on a re-review) (pieces `pre` / `mid` / `roundOpen` / `roundClose`: `Task audit ` / ` please review: ` / ` (round ` / `)`) | plugins/personal-inbox/audit-gate.mjs (first line of a submission sheet) |
| `submissionCard` | `任务卡` | `Task card` | plugins/personal-inbox/audit-gate.mjs (second line) |
| `submissionPaths` | `成果位置` | `Result location` | plugins/personal-inbox/audit-gate.mjs (the block that lists the result paths) |
| `reportVerdict` | `我得：通过` / `我得：不通过` / `我得：审不了` | `Verdict: pass` / `Verdict: fail` / `Verdict: cannot audit` | plugins/personal-inbox/audit-gate.mjs (first line of an audit report), task auditor rules |

Other labels that the rules quote but no program matches (`Owner's words:`, `Acceptance criteria:`, `Task type:`, `Executor:`, `Previous report:`, `Checked against:`, `Evidence:`, `Severity:`) are written in the same language as the rest of the text.

### 1.3 Help requests and the desktop queue

| Key | zh-CN | en | Used by |
|---|---|---|---|
| `helpRequestMarker` | `【求助】` | `[Help request]` | plugins/personal-inbox/stuck-guard.mjs, plugins/personal-inbox/desktop-lock.mjs, rules |
| `helpReplyMarker` | `【求助回复】` | `[Help reply]` | plugins/personal-inbox/stuck-guard.mjs, rules |
| `queueSkipReasons` | `不用了` / `完成` / `被接手` | `not-needed` / `done` / `taken-over` | plugins/personal-inbox/desktop-lock.mjs (skip --why), rules |

### 1.4 Pending-decision ledger and program-sent markers

| Key | zh-CN | en | Used by |
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

### 1.5 Completion records, decision ledger, generated reports, names

| Key | zh-CN | en | Used by |
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

### 1.6 Job names, audit run records, anomaly flags, publish receipts

| Key | zh-CN | en | Used by |
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

The job names are also the names of the cron jobs in OpenClaw: if you rename a cron job, change the matching word in `lexicon.mjs`. `jobs.publishSelf.effectiveFrom` in `config/crew.json` is keyed by the task names of your locale (`patrol`, `deep-review`, `weekly-audit` in en; `巡查`, `异常深审`, `周审` in zh-CN). The round records, anomaly flags and publish receipts are JSON files whose keys and values are written by the models (following the job instructions) or by `publish-self.py`; the keys and values are in `lexicon.mjs` (`auditRecordKeys`, `auditRecordValues`, `flagKeys`, `flagStates`, `receiptKeys`, `publishStates`, `publishFiles`).

### 1.7 Fixed sentences for the owner

The fixed Discord messages and approval-card texts that the programs send or show to the owner are the `notices` group of `lexicon.mjs`: one function per sentence, in both languages, with the same names. They are used by `approval-card.mjs`, `audit-gate.mjs` (closing confirmation card), `sensitive-click.mjs` (the reasons of the cases the program recognizes itself), `desktop-lock.mjs` (six-kinds-of-action card, "stuck" and "passed over" notices), `pending-ledger.mjs` (master list, reminders, approval-expiry texts), `reset-notice.mjs`, `timed-reminders.mjs`, `api-quota-gate.mjs`, `day-watch.mjs` (anomaly sentences and the titles of the ledger entries it registers), `quota-catchup.mjs`, `quota-resume.mjs` and `ledger-watch.mjs` and `audit-guard.mjs` (the P4 test card). Dates inside them follow the language too (`Nov 22 09:30` in en, `11 月 22 日 09:30` in zh-CN). To change a sentence, edit it in both sets; `tests/en/notices.en.test.mjs` pins every English sentence, `tests/en/notices-assembled.en.test.mjs` checks the messages and cards that the real entry points build, and `tests/lexicon-zh-snapshot.test.mjs` pins every Chinese one.

## 2. Folders and file names under the data root

| Key | zh-CN | en |
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

`dataroot/` in the changed-files list (`rules/shared-tail.md`) is only a short alias of the data root: the program maps it to the real data-root path. **Do not create a folder called `dataroot`.** In zh-CN the alias is `资料/`.

The master index `INDEX.md` and the project entry `PROJECT.md` keep their names. The project table in `INDEX.md` starts with the column `Project` (zh-CN: `项目`); the channel cell is written `<channel name> (ID <digits>)` (zh-CN: `（编号 <数字>）`) and the entry cell `[Project entry](projects/<name>/PROJECT.md)` (zh-CN: `[项目入口](项目/<名>/PROJECT.md)`).

In an English deployment, copy `templates/task-record.md` and `templates/project-entry.md` into `<DATA_ROOT>/templates/`, and create `INDEX.md` and `decision-ledger.md` from the `*-header` templates. In a zh-CN deployment, copy `templates/任务记录.md` and `templates/项目入口.md` into `<DATA_ROOT>/模板/`.

## 3. Command-line parameters

Already English; they do not change with `locale`. See [configuration.md](configuration.md), section 6.

## 4. Time zone and clock times

Not a language question, but also fixed in the reference deployment: all dates are computed in the `timezone` of `config/crew.json`; the clock times inside scripts are listed in [configuration.md](configuration.md), section 5.

## 5. How the bots speak

Personas are optional (see [roles.md](roles.md)). The rule files only say "follow the persona if one is set", so catchphrases and the language of a persona belong to the persona, not to the rules. `replyLanguage` only sets the default language of replies.

## 6. Remaining boundary (not translated on purpose)

These places still hold Chinese in an English deployment. None of them is a word that a program writes and a bot, a rule or a program of the other language is expected to match by its letters. The few words that two of our own programs write and match between themselves (the states of the catch-up ledger `待核`, `补跑结果待核`, `未送达`, and the state `叫起待核` of the wake record) stay Chinese in both locales on purpose, so that the two ends can never drift apart; where a wake sentence or a job has to show one of them to a bot, it quotes the word in backticks.

- **Machine-owned JSON keys and file names.** Files that only the programs read and write keep their Chinese names and keys: the state and ledger files inside the run-log folders (for example the quota-resume ledger, the catch-up ledger, `待补.json` of the ledger backlog, `状态.json` of the API-credit gate, `卡标签快照.json`, `基线.json`, the lock and log files), the keys of the roster file `bot-roster.json` (`人设bot`, `角色`, `显示名`, `Discord编号`, ...), and the internal states of the ledger notices. The rules and jobs quote such a name in backticks where a bot has to read it.
- **Internal messages and logs.** Error messages, log lines, diagnostics and the reasons the audit guard gives when it refuses a command; the detail sentences inside the blind-spot check report (the rework definition, the backup lines, the rule-file lines) and the file reconcile report; the `ledger-verify.mjs` messages and the error messages of `project-files.mjs` tools (the headings, labels, verdicts and fixed lines of the format check, the command check and the blind-spot check, and the `Business date:` and `Status: complete` marks, are translated); the output lines of `publish-self.py` (its exit code is what counts). The daytime-watch alerts quote the machine-owned file names as they are (for example the Chinese log file name of a stale lock) inside backticks.
- `builder-tools/` and `personas/` are not part of a deployment and are not translated.

## 7. Suggested way to run it

1. Pick the language of the bots' replies (`replyLanguage`) and set `locale` to match your rules. Create the data root after that.
2. Put the sensitive button words of your interface language into `plugins/personal-inbox/sensitive-words.json` (English and Chinese are always both active).
3. If you want a third language, copy one of the two sets in `lexicon.mjs`, add the locale to `LOCALES`, translate the rule, template and job files, and run the whole test suite (`tests/en/lexicon-parity.en.test.mjs` shows how the two sets are kept in step).
4. Tell us (issue or pull request) which words you changed.
