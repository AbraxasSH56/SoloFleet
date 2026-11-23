# 配置一览

[English](../en/configuration.md) | 简体中文

能设什么、在哪设。文档和配置示例里的占位写成 `<这样>`；模板和规则里由程序填的占位写成 `{{这样}}`。

## 1. 中心文件 `config/crew.json`

把 `config/crew.example.json` 复制成 `config/crew.json`（已被 git 忽略）再改。所有 JavaScript 和 Python 程序找它的顺序相同：环境变量 `SOLOFLEET_CONFIG` 指的文件 → `config/crew.json` → `config/crew.example.json`。装好的插件要在网关的环境里设 `SOLOFLEET_CONFIG`。

| 字段 | 含义 | 默认 |
|---|---|---|
| `owner.userId` | 主人的 Discord 用户编号。只认这个账号的批准。 | – |
| `owner.title` | 规则里对主人的称呼（`{{OWNER_TITLE}}`）。 | `the owner` |
| `guildId` | Discord 服务器编号。 | – |
| `channels.workshop` / `.approval` / `.lounge` / `.diary` | 工坊、审批、闲聊、日记频道编号。 | – |
| `excludedChannels.completionNotice` | 程序不发"完成记录"那一行的频道；工坊永远排除。 | `[]` |
| `excludedChannels.approvalReminder` | 不加"待批提醒"的频道。 | `[]` |
| `bots.<agentId>.userId` | 各 bot 的 Discord 用户编号：`main`、`desktop`、`task-auditor`、`system-auditor`、`diary`、`standby-a`、`standby-b`、`worker-a`、`worker-b`… | – |
| `roles` | 可选，覆盖角色表（见第 3 节）。**目前只有 `scripts/sync-shared-rules.py` 会读它。** | 内置 |
| `timezone` | IANA 时区名。所有"今天""业务日期""本地钟点"都按它算。 | `UTC` |
| `locale` | `en` 或 `zh-CN`：程序认、写、发的协议词（进度句开头、任务记录和任务卡标签、报告首行、台账状态词、作业名等）、数据根里的文件夹和文件名、模板占位符、程序对 bot 说的指令句、回复附卡上的文字、英文过程话清理（只在 zh-CN 开）、审计守门用哪个语言的任务指令片段。建数据根之前先定好，以后不要改；见 [localization.md](localization.md)。 | `en` |
| `replyLanguage` | 填规则里的 `{{REPLY_LANGUAGE}}`：bot 回话用的语言。 | `English` |
| `paths.dataRoot` | 数据根：项目文件夹、`INDEX.md`、决定账本、台账和运行记录。 | – |
| `paths.workspaceRoot` | 各角色工作区的上一级：`<workspaceRoot>/<agentId>/`。 | – |
| `paths.projectRoot` | 本仓库装在哪。 | 仓库所在文件夹 |
| `paths.nodeBin` | `node` 的完整路径，规则里给 bot 的命令用它。 | `node` |
| `paths.openclawBin` | OpenClaw 命令行。 | `openclaw` |
| `paths.openclawHome` | OpenClaw 的状态文件夹。 | `~/.openclaw` |
| `paths.openclawInstallDir` | OpenClaw 的安装目录（周审的程序核对要拿它跟校验清单比）。 | 空 |
| `paths.claudeBin` | `claude` 命令行的路径（登录到期提醒用）。 | `~/.local/bin/claude` |
| `auditAreas.review` / `.roster` / `.backup` | 可选：每日盲区抽查要看有没有新增改动的文件夹，以及（`backup`，里面有 `consistent-checkpoints` 文件夹时）备份状态。空着或目录不在就跳过，写"未启用"，不算不完整。 | 空 |
| `paths.codexbarBin` | [CodexBar](https://github.com/steipete/CodexBar) 命令行路径（可选；只有打开额度那一行才用）。 | 该应用的默认位置 |
| `jobs.publishSelf.effectiveFrom` | 按任务（用你这个 `locale` 的任务名：zh-CN 是 `巡查`、`异常深审`、`周审`，en 是 `patrol`、`deep-review`、`weekly-audit`）：`publish-self.py` 从哪个业务日期起才可以发这个任务的摘要。**某个任务这里没写日期，脚本就拒发它。** 填你打开自发的那一天。 | 示例文件里是 `2030-01-01` |
| `jobs.<名字>.time` | 你给各任务排的钟点（`patrol`、`deepReview`、`weeklyAudit`、`dailyAudit`…）。真正的时间在 OpenClaw 的定时任务里设；`publish-self.py` 还会读 `patrol`、`deepReview`、`weeklyAudit` 当作各摘要的截止点。脚本里其余写死的钟点见第 5 节。 | – |
| `models` | 规则里模型别名的对照（"最新的 Opus"）。仅说明用。 | – |
| `attachCard.modelFamilies` | 回复附卡从型号引用（`claude-<族名>-…`）里认的模型族名；出现新族名时在这里加。 | `sonnet, opus, haiku, fable` |
| `attachCard.scopedWeeklyFamily` | 额度行里"周限额（总量/<族名>）"那个**单独有周限额**的模型族；换了族名就在这里改。 | `fable` |
| `attachCard.quotaSource` | 只是写明默认值；真正起作用的开关是插件选项 `executionRecord.quotaSource`（第 4 节）。 | `off` |

测试用的配置：`tests/fixtures/crew.test.json`，编号是假的，时区用 `Asia/Kolkata`（UTC+05:30、无夏令时），免得日期边界的测试碰巧是 UTC。

## 2. 同步脚本填的占位

`scripts/sync-shared-rules.py` 写某个角色的 `AGENTS.md` 时替换下面这些；配置里没有值的占位原样保留并报出来。

| 占位 | 取自 |
|---|---|
| `{{OWNER_TITLE}}`、`{{REPLY_LANGUAGE}}` | `owner.title`、`replyLanguage` |
| `<OWNER_USER_ID>`、`<GUILD_ID>` | `owner.userId`、`guildId` |
| `<WORKSHOP_CHANNEL_ID>`、`<APPROVAL_CHANNEL_ID>`、`<LOUNGE_CHANNEL_ID>`、`<DIARY_CHANNEL_ID>` | `channels.*` |
| `<MAIN_BOT_USER_ID>`、`<DESKTOP_BOT_USER_ID>`、`<TASK_AUDITOR_BOT_USER_ID>`、`<WORKER_A_BOT_USER_ID>`… | `bots.<agentId>.userId`（键名大写、`-` 换成 `_`） |
| `<DATA_ROOT>`、`<WORKSPACE_ROOT>`、`<PROJECT_ROOT>`、`<NODE_BIN>`、`<TIMEZONE>` | `paths.*`、`timezone` |

用过的值会记进基线，所以以后改配置不会被当成"有人手改了规则"。

## 3. 角色表

插件和脚本按**默认的 agentId** 工作（`main`、`desktop`、`task-auditor`、`system-auditor`、`diary`、`standby-a`、`standby-b`、`worker-…`，见 [roles.md](roles.md) 的表）。`crew.json` 里的 `roles` 对象（键 `controller`、`desktop`、`taskAuditor`、`systemAuditor`、`diary`、`standby`、`workerPrefix`）目前只有 `scripts/sync-shared-rules.py` 会读，用来找各角色的头部文件；插件和别的脚本**还不读它**，所以暂不支持改 agent 名字。`plugins/personal-inbox/roles.mjs` 保留了同样的默认值和判断函数，留给以后这一步用。

## 4. 插件选项（OpenClaw 里 `personal-inbox` 的插件配置）

| 选项 | 含义 |
|---|---|
| `syncRoot` | 文档同步目标的项目根；一般由 `paths.projectRoot` 得出。 |
| `executionRecord.enabled` | 回复附卡（模型、通路、档位、改动文件）。**默认开**，要关就设成 `false`。不需要 OpenClaw 的用量页脚设置。 |
| `executionRecord.quotaSource` | `off`（默认）：不显示剩余额度那一行，也不报错。`cli`：显示这一行，靠 [CodexBar](https://github.com/steipete/CodexBar) 命令行（要自己装的 macOS 应用）。`cache`：读额度小组件导出的文件。不装 CodexBar 这一行就是不显示，附卡其余部分照常。 |
| `executionRecord.credentialProfilePath` | 只有 `cli`、`cache` 才要：一个路径，当作 Claude 登录档案的非机密指纹；不读内容。 |
| `executionRecord.snapshotPath` | 只有 `cache` 才要：额度小组件导出的文件。 |

插件旁边的几个文件：

- `audit-guard-rules.json`：两个审计角色的允许清单（程序、选项、可写目录、固定片段）。片段文件相对 `paths.projectRoot`，可按语言分别写。`triggerJobs` 列出触发脚本可以跳过命令文字检查的定时任务编号，请换成你自己的；改完重启网关，并跑 `tests/audit-guard.test.mjs`。
- `sensitive-click.mjs` 靠锁文件的位置找 `sensitive-words.json`，假定目录布局是 `<projectRoot>/runtime/desktop/screen.lock`（从锁文件往上数三层）；插件自己会把精确路径传进去，所以这个假定只在你用别的布局手动跑这几个部件时才有影响。
- `sensitive-words.json`：让桌面 bot 的点击要出审批卡的按钮词。中文词和英文词**永远同时生效**。
- `channel-exclusions.json`：额外排除的频道编号，和配置里的 `excludedChannels` 合并。

## 5. 脚本里可能要改的常量

OpenClaw 在脚本沙箱里跑的触发脚本没法 import 配置文件，所以它们的常量要手动和 `crew.json` 保持一致：

| 文件 | 常量 |
|---|---|
| `scripts/automation/command-spot-check-trigger.js` | `DATA_ROOT`、`PROJECT_ROOT`、`WORKSPACE_ROOT`、`TIMEZONE`、`CLAUDE_ROOT`、`CONFIG_FILE`、`AGENTS_ROOT`、`NODE_BIN`、`LOCALE`（和 `locale` 填一样）、`CUT_H`／`CUT_M`（日审钟点） |
| `scripts/automation/deep-review-trigger.js` | `DATA_ROOT`、`TIMEZONE`、`LOCALE`（和 `locale` 填一样）、`CUT_HOUR` |
| `scripts/followups-trigger.js` | `TIMEZONE` |

普通脚本里的钟点（都是 `timezone` 的本地时间）：`scripts/automation/daily-format-check.mjs`（`CUT_H`、`CUT_M`）、`reset-notice.mjs`（`PRE_FROM`、`RESET_AT`、`POST_UNTIL`）、`timed-reminders.mjs`（`提醒小时`、提前天数、可选的复议日期 `复议日期`，写在 `<DATA_ROOT>/运行记录/提醒/配置.json`）、`api-quota-gate.mjs`（`EXPIRY_HOUR`，默认 7：API 额度周期按本地时间几点结束）。

环境变量：`SOLOFLEET_CONFIG`（配置文件）、`OPENCLAW_BIN`（覆盖 `paths.openclawBin`）、`OPENCLAW_DATA_ROOT`／`OPENCLAW_RUNTIME_ROOT`／`OPENCLAW_PROJECT_ROOT`（对账命令用，命令抽查触发脚本会设）、`OPENCLAW_SDK_TEXT_CHUNKING`（只有测试用）。

## 6. 命令行参数

参数名是英文，不随 `locale` 变。例：`ledger-watch.mjs add --date … --title … --quote … [--line …] [--test]`、`ledger-watch.mjs list [--all]`、`ledger-watch.mjs done <编号> --ledger-id D-0xx`、`project-files.mjs new-project --name … --channel-id … --channel-name … --lead … --goal …`、`api-quota-gate.mjs --resume [YYYY-MM-DD] | --status`、`sync-shared-rules.py --check | --apply | --generate [--lang en|zh-CN] [--config …]`。
