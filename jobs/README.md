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

The programs still match Chinese literals (progress-sentence openers, "状态：", "等主人拍板", report headers, ledger status words and so on), so keep those words as they are (the default). The English files quote those Chinese literals as they are and explain them. The Chinese files are the reference version: the audit guard, the format spot-check and the other scripts are checked against them. Use the English file when you want to read the rules in English, or as the base for your own translation (see `docs/en/localization.md`).

## Deploying

1. Replace the all-caps angle-bracket placeholders (`<GUILD_ID>`, `<OWNER_USER_ID>`, `<LOUNGE_CHANNEL_ID>`, `<WORKSHOP_CHANNEL_ID>`, `<DIARY_CHANNEL_ID>`, `<TIMEZONE>`, `<OPENCLAW_INSTALL_DIR>`, `<DATA_ROOT>`, `<CODEXBAR_BIN>`) with your real values. Do **not** replace the Chinese placeholders such as `<资料根>` and `<项目根>`: the job gets them from the task message ("路径参数：…") on every run.
2. The three fixed snippets (business date, out-of-scope file check, weekly program check) are matched by the audit guard by their code lines. Put the real time zone name into the `TZN=` and `export TZ=` lines (same as config `timezone`) and the real paths into the `IR=` and `LD=` lines of the weekly program check. After that, point `snippets[].file` in `plugins/personal-inbox/audit-guard-rules.json` at the file you deploy. Do not edit any other code line of a snippet.
3. Create the cron jobs in OpenClaw with the file text as the task body and the agent from the table.

The jobs write under `<资料根>/审计/...` (Chinese folder names are used by the programs as they are).
