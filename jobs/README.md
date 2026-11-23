# jobs/ : scheduled-job instructions

These files are the prompts of the model-driven scheduled jobs. Each job has an English file and a Chinese file (`*.zh-CN.md`).

| Job | English | Chinese | Role (agentId) | Time from config |
|---|---|---|---|---|
| Daily audit | `daily-audit.md` | `daily-audit.zh-CN.md` | System auditor (`system-auditor`) | `jobs.dailyAudit.time` |
| Weekly audit | `weekly-audit.md` | `weekly-audit.zh-CN.md` | System auditor | `jobs.weeklyAudit.time` (Sunday) |
| Anomaly deep review | `deep-review.md` | `deep-review.zh-CN.md` | System auditor | `jobs.deepReview.time` |
| Patrol | `patrol.md` | `patrol.zh-CN.md` | Controller (`main`) | `jobs.patrol.time` |
| Diary (optional) | `diary.md` | `diary.zh-CN.md` | Diary keeper (`diary`) | `jobs.diary.time` |
| Daily follow-up (optional) | `followups-daily-job.example.json` | | Controller | `jobs.followups.time` |

## Which version to use

The programs take their words from the `locale` setting. With the English locale they use the English words, and the English job files (this folder's `*.md`) use the same English words. With the Chinese locale they use the Chinese words, and the Chinese job files (`*.zh-CN.md`) use the Chinese words. The programs and the job instructions always use one and the same set of words (progress-sentence openers, "Status:", "Waiting for the owner's decision", report headers, ledger status words and so on). Use the English file when you want to read the rules in English, or as the base for your own translation (see `docs/en/localization.md`).

## Deploying

1. Replace the all-caps angle-bracket placeholders (`<GUILD_ID>`, `<OWNER_USER_ID>`, `<LOUNGE_CHANNEL_ID>`, `<WORKSHOP_CHANNEL_ID>`, `<DIARY_CHANNEL_ID>`, `<TIMEZONE>`, `<OPENCLAW_INSTALL_DIR>`, `<DATA_ROOT>`, `<CODEXBAR_BIN>`) with your real values. The all-caps placeholders are the ones you replace with real values (for `<DATA_ROOT>` this applies to the `LD=` line of the weekly program check). In the instruction text, `<DATA_ROOT>` and `<PROJECT_ROOT>` are not replaced: the job gets the real paths from every task message as `Path parameters: DATA_ROOT=…; PROJECT_ROOT=…`.
2. The three fixed snippets (business date, out-of-scope file check, weekly program check) are matched by the audit guard by their code lines. Put the real time zone name into the `TZN=` and `export TZ=` lines (same as config `timezone`) and the real paths into the `IR=` and `LD=` lines of the weekly program check. After that, point `snippets[].file` in `plugins/personal-inbox/audit-guard-rules.json` at the file you deploy. Do not edit any other code line of a snippet.
3. Create the cron jobs in OpenClaw with the file text as the task body and the agent from the table.

The jobs write under `<DATA_ROOT>/audit/...` (the folder names come from the same word table that the programs use).
