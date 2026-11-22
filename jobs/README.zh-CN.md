# jobs/：定时任务指令

这些文件是调模型的定时任务的指令。每个任务有英文版和中文版（`*.zh-CN.md`）。

| 任务 | 英文版 | 中文版 | 角色（agentId） | 钟点（读配置） |
|---|---|---|---|---|
| 日审 | `daily-audit.md` | `daily-audit.zh-CN.md` | 系统审计（`system-auditor`） | `jobs.dailyAudit.time` |
| 周审 | `weekly-audit.md` | `weekly-audit.zh-CN.md` | 系统审计 | `jobs.weeklyAudit.time`（周日） |
| 异常深审 | `deep-review.md` | `deep-review.zh-CN.md` | 系统审计 | `jobs.deepReview.time` |
| 巡查 | `patrol.md` | `patrol.zh-CN.md` | 总控（`main`） | `jobs.patrol.time` |
| 日记（可选） | `diary.md` | `diary.zh-CN.md` | 日记（`diary`） | `jobs.diary.time` |
| 每日跟进（可选） | `followups-daily-job.example.json` | | 总控 | `jobs.followups.time` |

## 用哪一版

程序现在仍按中文字面认词（进度句开头、"状态："、"等主人拍板"、报告首行、台账状态词等），所以这些词要原样保留。英文版把这些中文字面原样引出并解释；中文版是基准版：审计守门、格式抽查等脚本按它校验。想读英文规则、或以它为底做自己的翻译（见 `docs/zh-CN/localization.md`），用英文版。

## 部署

1. 把全大写的尖括号占位（`<GUILD_ID>`、`<OWNER_USER_ID>`、`<LOUNGE_CHANNEL_ID>`、`<WORKSHOP_CHANNEL_ID>`、`<DIARY_CHANNEL_ID>`、`<TIMEZONE>`、`<OPENCLAW_INSTALL_DIR>`、`<DATA_ROOT>`、`<CODEXBAR_BIN>`）换成你的真实值。`<资料根>`、`<项目根>` 这类中文占位**不要换**：任务每次运行从任务消息（"路径参数：…"）里取。
2. 三段固定片段（业务日期、范围外文件查法、周审程序核对）由审计守门按代码行比对。把时区名填进 `TZN=` 和 `export TZ=` 两行（和配置 `timezone` 一致），把真实路径填进周审程序核对的 `IR=`、`LD=` 两行；然后让 `plugins/personal-inbox/audit-guard-rules.json` 里 `snippets[].file` 指向你部署的那份文件。片段里别的代码行不要改。
3. 在 OpenClaw 里建定时任务：任务正文用文件内容，角色按上表。

任务写的目录在 `<资料根>/审计/…` 下（中文目录名程序按原样用）。
