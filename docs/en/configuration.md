# Configuration reference

English | [简体中文](../zh-CN/configuration.md)

Everything you can set, and where. Placeholders in files look like `<LIKE_THIS>` (documents and config examples) or `{{LIKE_THIS}}` (templates and rules that a program fills in).

## 1. The central file: `config/crew.json`

Copy `config/crew.example.json` to `config/crew.json` (git-ignored) and edit. Lookup order, same for every JavaScript and Python program: the file named by the environment variable `SOLOFLEET_CONFIG`, then `config/crew.json`, then `config/crew.example.json`. For the installed plugin, set `SOLOFLEET_CONFIG` in the gateway's environment.

| Field | Meaning | Default |
|---|---|---|
| `owner.userId` | Discord user ID of the owner. Only this account's approvals count. | – |
| `owner.title` | How the rules call the owner (`{{OWNER_TITLE}}`). | `the owner` |
| `guildId` | Discord server ID. | – |
| `channels.workshop` / `.approval` / `.lounge` / `.diary` | Channel IDs of the workshop, the approval channel, the casual lounge and the diary channel. | – |
| `excludedChannels.completionNotice` | Channels where the program must not post the "completion record" line. The workshop is always excluded. | `[]` |
| `excludedChannels.approvalReminder` | Channels where the pending-approval reminder is not added. | `[]` |
| `bots.<agentId>.userId` | Discord user ID of each bot: `main`, `desktop`, `task-auditor`, `system-auditor`, `diary`, `standby-a`, `standby-b`, `worker-a`, `worker-b`, … | – |
| `roles` | Optional override of the role table (see section 3). **Today only `scripts/sync-shared-rules.py` reads it.** | built-in |
| `timezone` | IANA time zone. Every "today", business date and local clock time is computed in it. | `UTC` |
| `locale` | `en` or `zh-CN`: the protocol words the programs match, write and send (progress openers, task-record and card labels, report first lines, ledger status words, job names ...), the folder and file names under the data root, the template placeholders, the instruction texts for the bots, the reply-card text, the English-process-paragraph cleanup (zh-CN only) and which language of the job snippets the audit guard uses. Choose it before you create the data root and do not change it later; see [localization.md](localization.md). | `en` |
| `replyLanguage` | Fills `{{REPLY_LANGUAGE}}` in the rules: the language bots reply in. | `English` |
| `paths.dataRoot` | Data root: project folders, `INDEX.md`, the decision ledger, ledgers and run records. | – |
| `paths.workspaceRoot` | Parent folder of the role workspaces: `<workspaceRoot>/<agentId>/`. | – |
| `paths.projectRoot` | Where this repository is installed. | the repo folder |
| `paths.nodeBin` | Full path of `node`, used in commands the rules give to bots. | `node` |
| `paths.openclawBin` | OpenClaw command line. | `openclaw` |
| `paths.openclawHome` | OpenClaw's state folder. | `~/.openclaw` |
| `paths.openclawInstallDir` | OpenClaw's installation folder (the weekly program check compares it with a checksum list). | empty |
| `paths.claudeBin` | Path of the `claude` command line (used by the login-expiry reminder). | `~/.local/bin/claude` |
| `auditAreas.review` / `.roster` / `.backup` | Optional folders the daily blind-spot check watches for new or changed files and (for `backup`, if it holds a `consistent-checkpoints` folder) backup status. Empty or missing = skipped and reported as "not enabled", never as incomplete. | empty |
| `paths.codexbarBin` | Path of the [CodexBar](https://github.com/steipete/CodexBar) command line (optional; only used when the quota line is switched on). | the app's default location |
| `jobs.publishSelf.effectiveFrom` | Per task (the task names of your `locale`: `patrol`, `deep-review`, `weekly-audit` in en; `巡查`, `异常深审`, `周审` in zh-CN): the first business date `publish-self.py` may post that task's summary. **If a task has no date here, the script refuses to publish it.** Set it to the day you switch self-publishing on. | example file: `2030-01-01` |
| `jobs.<name>.time` | The time you scheduled each job (`patrol`, `deepReview`, `weeklyAudit`, `dailyAudit`…). The real schedule is set in OpenClaw automations; `publish-self.py` also reads `patrol`, `deepReview` and `weeklyAudit` as the cut-off time of each summary. The other clock times inside scripts are listed in section 5. | – |
| `models` | Alias table for model names used in rules ("latest Opus"). Documentation. | – |
| `attachCard.modelFamilies` | Model family names the reply card recognises in a model reference (`claude-<family>-…`). Add a family here when a new one appears. | `sonnet, opus, haiku, fable` |
| `attachCard.scopedWeeklyFamily` | The family that has its **own weekly cap** shown on the quota line ("weekly (total/<family>)"). Change it if another family gets the separate cap. | `fable` |
| `attachCard.quotaSource` | Documentation of the default only; the switch that works is the plugin option `executionRecord.quotaSource` (section 4). | `off` |

Test configuration: `tests/fixtures/crew.test.json` has fake IDs and `Asia/Kolkata` (UTC+05:30, no daylight saving) so that date-boundary tests are not accidentally UTC.

## 2. Placeholders the rules sync script fills

`scripts/sync-shared-rules.py` replaces these in the rule text when it writes a role's `AGENTS.md`; a placeholder without a value in your config is left as written and reported.

| Placeholder | Taken from |
|---|---|
| `{{OWNER_TITLE}}`, `{{REPLY_LANGUAGE}}` | `owner.title`, `replyLanguage` |
| `<OWNER_USER_ID>`, `<GUILD_ID>` | `owner.userId`, `guildId` |
| `<WORKSHOP_CHANNEL_ID>`, `<APPROVAL_CHANNEL_ID>`, `<LOUNGE_CHANNEL_ID>`, `<DIARY_CHANNEL_ID>` | `channels.*` |
| `<MAIN_BOT_USER_ID>`, `<DESKTOP_BOT_USER_ID>`, `<TASK_AUDITOR_BOT_USER_ID>`, `<WORKER_A_BOT_USER_ID>` … | `bots.<agentId>.userId` (key upper-cased, `-` becomes `_`) |
| `<DATA_ROOT>`, `<WORKSPACE_ROOT>`, `<PROJECT_ROOT>`, `<NODE_BIN>`, `<TIMEZONE>` | `paths.*`, `timezone` |

The values used are stored in the baseline, so changing the config later is not mistaken for a hand-edit of a rule.

## 3. Role table

The plugin and the scripts work with the **default agent IDs** (`main`, `desktop`, `task-auditor`, `system-auditor`, `diary`, `standby-a`, `standby-b`, and `worker-…`; see the table in [roles.md](roles.md)). A `roles` object in `crew.json` (keys `controller`, `desktop`, `taskAuditor`, `systemAuditor`, `diary`, `standby`, `workerPrefix`) is currently read only by `scripts/sync-shared-rules.py`, to find each role's head file; the plugin and the other scripts do **not** use it yet, so renaming agents is not supported. `plugins/personal-inbox/roles.mjs` keeps the same defaults and helper functions for that future step.

## 4. Plugin options (OpenClaw plugin config for `personal-inbox`)

| Option | Meaning |
|---|---|
| `syncRoot` | Project root for document-sync targets; normally derived from `paths.projectRoot`. |
| `executionRecord.enabled` | The reply card (model, route, effort, changed files). **On by default**; set `false` to turn it off. It needs no OpenClaw usage-footer setting. |
| `executionRecord.quotaSource` | `off` (default): no remaining-quota line, no error. `cli`: show the line, using the [CodexBar](https://github.com/steipete/CodexBar) command line (a macOS app you install yourself). `cache`: read a widget export file. Without CodexBar the line is simply not shown and the rest of the card is unchanged. |
| `executionRecord.credentialProfilePath` | Only for `cli` or `cache`: a path used as a non-secret fingerprint of the Claude profile; contents are never read. |
| `executionRecord.snapshotPath` | Only for `cache`: the widget's quota export file. |

Files next to the plugin:

- `audit-guard-rules.json`: the allow-list of the two audit roles (programs, options, write folders, fixed snippets). Snippet files are relative to `paths.projectRoot` and can be given per locale. `triggerJobs` lists the scheduled-job IDs whose trigger scripts may skip the command-text check; replace the placeholder IDs with your own. Edit it, restart the gateway, and run `tests/audit-guard.test.mjs`.
- `sensitive-click.mjs` finds `sensitive-words.json` from the lock file's location by assuming the layout `<projectRoot>/runtime/desktop/screen.lock` (three folders up from the lock file); the plugin passes the exact path itself, so this guess only matters if you run the pieces by hand with a different layout.
- `sensitive-words.json`: the button words that make the desktop operator's click need an approval card. The Chinese and English words are **both** always active.
- `channel-exclusions.json`: extra excluded channel IDs, merged with `excludedChannels` from the config.

## 5. Constants inside scripts you may need to edit

Trigger scripts that OpenClaw runs in its script sandbox cannot import the config file, so their constants must be kept equal to `crew.json` by hand:

| File | Constants |
|---|---|
| `scripts/automation/command-spot-check-trigger.js` | `DATA_ROOT`, `PROJECT_ROOT`, `WORKSPACE_ROOT`, `TIMEZONE`, `CLAUDE_ROOT`, `CONFIG_FILE`, `AGENTS_ROOT`, `NODE_BIN`, `LOCALE` (same value as `locale`), `CUT_H`/`CUT_M` (daily audit time) |
| `scripts/automation/deep-review-trigger.js` | `DATA_ROOT`, `TIMEZONE`, `LOCALE` (same value as `locale`), `CUT_HOUR` |
| `scripts/followups-trigger.js` | `TIMEZONE` |

Clock times in regular scripts (all in local time of `timezone`): `scripts/automation/daily-format-check.mjs` (`CUT_H`, `CUT_M`), `reset-notice.mjs` (`PRE_FROM`, `RESET_AT`, `POST_UNTIL`), `timed-reminders.mjs` (`提醒小时` = reminder hour, reminder lead days, optional review date `复议日期`, set in `<DATA_ROOT>/run-logs/reminders/配置.json`; the file name `配置.json` and these three key names are Chinese on purpose: only the program reads them, so they are not translated), `api-quota-gate.mjs` (`EXPIRY_HOUR`, default 7: the local hour at which an API credit period ends).

Environment variables: `SOLOFLEET_CONFIG` (config file), `OPENCLAW_BIN` (override of `paths.openclawBin`), `OPENCLAW_DATA_ROOT` / `OPENCLAW_RUNTIME_ROOT` / `OPENCLAW_PROJECT_ROOT` (used by the reconciliation command; the spot-check trigger sets them), `OPENCLAW_SDK_TEXT_CHUNKING` (tests only).

## 6. Command-line parameters

Parameter names are English and do not change with `locale`. Examples: `ledger-watch.mjs add --date … --title … --quote … [--line …] [--test]`, `ledger-watch.mjs list [--all]`, `ledger-watch.mjs done <id> --ledger-id D-0xx`, `project-files.mjs new-project --name … --channel-id … --channel-name … --lead … --goal …`, `api-quota-gate.mjs --resume [YYYY-MM-DD] | --status`, `sync-shared-rules.py --check | --apply | --generate [--lang en|zh-CN] [--config …]`.
