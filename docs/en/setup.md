# Setup guide

English | [简体中文](../zh-CN/setup.md)

This guide takes you from an empty Mac to a crew that answers in Discord. It is the way the reference deployment was built; adapt what you need. All IDs, paths and names below are placeholders such as `<OWNER_USER_ID>`.

Two things to know first:

- The programs read one central file, `config/crew.json` (copy of `config/crew.example.json`). Every ID, path, time zone and language is set there. Nothing about your own deployment is written into the code.
- `locale` (default `en`, or `zh-CN`) decides the words the programs match and write (progress openers, card labels, report headers), the folder names under the data root, the texts the programs give the bots and the fixed reminders they send to the owner; the rule files, templates and job instructions come in a matching English and Chinese version. Choose it before you create the data root and do not change it later. See [localization.md](localization.md).

## 1. What you need

| Need | Notes |
|---|---|
| A Mac that stays on | The desktop operator and the desktop lock were verified on macOS only (the lock uses macOS file locking). The rest is plain Node and Python and should run elsewhere, but is untested there. |
| OpenClaw | The reference deployment used OpenClaw 2026.10.x. The plugin declares `pluginApi >= 2026.10.4`. |
| Node.js ≥ 24.16 | Built-in modules only (`node:sqlite`, `node:test`); there is no `npm install`. |
| Python 3 | Standard library only. Used by `scripts/sync-shared-rules.py` and `scripts/automation/publish-self.py`. |
| A Discord application and bot account per bot you want | One account per role keeps mentions and avatars separate. See `config/examples/discord-integration.example.json`. |
| A Claude subscription | All bots run on it. |
| The `claude` command line, logged in | Used through `claude -p` (see step 2). `claude auth status` is also used by the login reminder. |

Optional: the [CodexBar](https://github.com/steipete/CodexBar) command line (a separate macOS app; it adds the remaining-quota line to the reply card, see section 6), Peekaboo (OpenClaw's default screen-reading provider for the desktop operator).

## 2. Connect the subscription

OpenClaw hands a conversation to the Claude command line in non-interactive mode (`claude -p`), so the bots use your subscription instead of a metered API key. Follow OpenClaw's own documentation for the Claude CLI backend and log in once on the gateway machine.

Some subscriptions include an API credit as a second pool. If yours does, the scheduled audits and the standby bots can use it: define separate providers (`anthropic-api`, `anthropic-standby-a`, `anthropic-standby-b`), each with its own key variable and **no fallback**, so they stop when the credit is used up instead of falling back to a paid key. A template is in `config/examples/api-credit-providers.example.json`. If your plan has no such credit, skip the API jobs and the standby bots.

One practical note: do not log OpenClaw in with a Google subscription account. The provider's terms say it counts as a violation.

When a subscription window is used up, `claude -p` returns an English error sentence. `plugins/personal-inbox/quota-recovery.mjs` recognises that sentence to resume the interrupted work after the quota returns. It is not translated.

## 3. Set up Discord

Suggested structure (the programs assume it):

- **Workshop**: one channel where the owner talks to the Controller only. No threads under it.
- **One channel per project**, one thread per task. The owner speaks in the channel's main area; the Controller opens a thread and hands the task out.
- **Lounge**: a casual channel. Bots chat here, but no task cards, records or audits.
- **Approval**: a channel for plugin approval cards. Only the owner can approve.
- **Diary** (optional): the diary keeper writes here.

Rules the programs and the shared rules rely on:

- Bots talk to each other **only by explicit mention** (`<@BOT_USER_ID>`; plain names do nothing). A bot answers only when mentioned, except the lead bot of a project channel (see below) and the diary channel.
- The **lead bot** of a project channel may answer without being mentioned there. `scripts/automation/lead-free.mjs` sets this when a project is created; no other bot gets it.
- Loop guard: real-time protection is OpenClaw's own bot-loop protection (see `config/examples/bot-mentions-and-session-reset.example.json`). In addition, `daily-format-check.mjs` counts bot-to-bot mentions per thread once a day; a high count is only a clue for the audit and does not stop anything.

Create the applications and put the bot tokens in environment variables (`DISCORD_BOT_TOKEN_<ROLE>`). Never write tokens into files.

## 4. Fill the config, install the plugin, place the rules

1. `cp config/crew.example.json config/crew.json` and fill in the owner ID, server ID, channel IDs, bot user IDs, `timezone`, `paths` (`dataRoot`, `workspaceRoot`, `projectRoot`, `nodeBin`, `openclawBin`, `openclawInstallDir`). Field by field: [configuration.md](configuration.md). `config/crew.json` is git-ignored.
2. Set `SOLOFLEET_CONFIG=<PROJECT_ROOT>/config/crew.json` in the gateway's environment. OpenClaw copies installed plugins to a temporary folder, so the plugin cannot find the file by its own location.
3. Merge the fragments in `config/examples/` into your OpenClaw configuration (agents, Discord accounts and bindings, tool lists, approval routing). Check field names against your OpenClaw version; the examples follow 2026.10.x. `inbox-integration.example.json` loads and enables the plugin.
4. Prepare the data root (`paths.dataRoot`): copy `templates/task-record.md` and `templates/project-entry.md` into `<DATA_ROOT>/templates/` (the programs read them under those names), and create `INDEX.md` and `decision-ledger.md` from the `*-header` templates (`templates/index-header.md`, `templates/decision-ledger-header.md`). For `locale: zh-CN` copy `templates/任务记录.md` and `templates/项目入口.md` into `<DATA_ROOT>/模板/` and use `templates/index-header.zh-CN.md` and `templates/decision-ledger-header.zh-CN.md` (the file is `决定账本.md`).
5. Generate each role's `AGENTS.md` from the repository rules:

   ```bash
   python3 -I scripts/sync-shared-rules.py --generate --lang en --config config/crew.json
   ```

   (Pass `--lang zh-CN` instead if you want the Chinese rule files.)

   It writes a rules file for every bot in `bots` that has no `AGENTS.md` yet under `<workspaceRoot>/<agentId>/`: role head + shared rules (trimmed by the overrides table) + tail, with the placeholders (`{{OWNER_TITLE}}`, IDs, paths) filled from your config. Run `--dry-run` first to preview. Later, after editing `rules/`, run `--check` and then `--apply`: one change to the shared rules reaches every role, and a hand-edit to a role's copy is reported.
6. **Reply card (on by default).** Every bot reply gets a small card under it showing the model, route, reasoning effort and the files changed this turn. It reads the host's per-turn usage state, so it needs **none** of OpenClaw's usage-footer settings: leave `messages.responseUsage` at its default (`off`) and do not set `messages.usageTemplate`. The defaults are spelled out in `config/examples/inbox-integration.example.json` (`executionRecord.enabled: true`, `quotaSource: "off"`); set `enabled` to `false` to turn the card off. For an extra "remaining quota" line, install the CodexBar command line; without it that line is simply not shown (section 6).
7. Restart the gateway and send a message that mentions the Controller in the workshop.

Optional personas: see [roles.md](roles.md). A bot works without any persona.

## 5. Scheduled jobs

- **Jobs that call a model.** `jobs/` holds the instruction texts of the daily audit, weekly audit, anomaly deep review, patrol and diary, plus `followups-daily-job.example.json`. Create each as an OpenClaw automation on the right agent at the time you want (`jobs.<name>.time` in the config only documents it; the time itself is set in OpenClaw). The instruction files contain deploy-time placeholders (`<TIMEZONE>`, `<DATA_ROOT>`, `<OPENCLAW_INSTALL_DIR>`); the audit guard fills them from `config/crew.json` before it fingerprints a snippet, so keep the job text and the config in step.
- **Scripts that do not call a model.** The scripts under `scripts/automation/` (quota gate, reminders, day watch, reset notice, and so on) are meant to be scheduled as OpenClaw command jobs; the header comment of each says how often.

Self-publishing of the daily summaries (`scripts/automation/publish-self.py`) is off until you set `jobs.publishSelf.effectiveFrom` for each task (see [configuration.md](configuration.md)); the cut-off time of each summary is the job's `jobs.<name>.time`.

## 6. External dependencies and what happens without them

| Dependency | Used for | If missing |
|---|---|---|
| [CodexBar](https://github.com/steipete/CodexBar) command line (a macOS app you install yourself) | The remaining-quota line on the reply card: plugin option `executionRecord.quotaSource: "cli"` plus `executionRecord.credentialProfilePath` | The line is simply not shown, with no error; the card still shows model, route, effort and changed files. This is the default (`quotaSource: "off"`). |
| OpenClaw task-board database | A few read-only table lookups (card title, status, labels) | The completion gate falls back to the OpenClaw command line. |
| `claude auth status` | Login-expiry reminder | The reminder says it cannot read the status. |
| The English quota-error sentence of `claude -p` | Resuming work after a quota stop | Resume does not trigger; work is not lost but must be restarted by hand. |
| `jq`, `sqlite3`, `git` | The command spot-check and reconciliation scripts | The affected section reports "not enough record" instead of failing. |
| Peekaboo | Screen reading of the desktop operator | The desktop operator cannot see the screen. |

## 7. Run the tests

```bash
SOLOFLEET_CONFIG=tests/fixtures/crew.test.json node --test tests/*.test.mjs
python3 -I -m unittest discover -s tests -p "test_*.py"
SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/*.test.mjs
SOLOFLEET_CONFIG=tests/fixtures/crew.test.json python3 -I scripts/automation/publish-self-test.py
SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json python3 -I scripts/automation/publish-self-test.py
```

All tests use temporary folders and fake data; none touches a real deployment, Discord or the network. `node` must be on `PATH`. One test (T14 in `execution-record-changes`) is skipped unless the real OpenClaw SDK is available (set `OPENCLAW_SDK_TEXT_CHUNKING` to the installed `plugin-sdk/text-chunking.js`).

## 8. Where to read next

- All settings: [configuration.md](configuration.md)
- Changing the language of the programs: [localization.md](localization.md)
- Roles and optional personas: [roles.md](roles.md)
- Safety design and its known limits: [safety.md](safety.md)
