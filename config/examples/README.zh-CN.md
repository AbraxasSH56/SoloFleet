# config/examples/（中文说明）

OpenClaw 配置片段示例。所有编号、路径、型号都是占位，把 `<这样的>` 换成你自己的。密钥不写在文件里，只写存放它的环境变量名（如 `DISCORD_BOT_TOKEN_MAIN`）。主人、频道、bot 编号、时区、路径这些全局值放在 `config/crew.example.json`（复制成 `config/crew.json`），这里用同一套值。

每个文件开头有 `_readme`（一句英文说明用途），有的还带 `_notes`、`_groups` 说明字段：合进真实配置前把下划线开头的字段删掉。

| 文件 | 作用 |
|---|---|
| `discord-integration.example.json` | Discord 接入：每个 bot 一个应用和账号，每个角色一条绑定，只认主人，提及规则，线程绑定。令牌来自环境变量 `DISCORD_BOT_TOKEN_<角色>` |
| `agents-and-workers.example.json` | 各角色（总控 `main`、`desktop`、`task-auditor`、`system-auditor`、`diary`、`standby-a`、`standby-b`、`worker-a`、`worker-b`）的工作区、模型，以及谁能派谁。要更多执行者就复制一条 `worker-*` |
| `agent-tools.example.json` | 各角色的工具清单，按功能分组（任务板、收件箱和跟进工具、网页搜索与抓取、文档同步、命令权限、桌面操作用的 `computer`） |
| `desktop-agent.example.json` | 桌面操作角色：用 OpenClaw 原生 `computer` 工具（读屏幕装 Peekaboo） |
| `approval-routing.example.json` | 插件的审批卡发到单独的审批频道，只有主人能批 |
| `claude-full-access.example.json` | 只用 Claude 模型、不设回退；网关机器上 `exec` 用 full 模式。先读 `docs/zh-CN/safety.md` |
| `continuation.example.json` | `commands.ownerAllowFrom`（主人和除桌面外所有 bot），让续跑任务在额度用完恢复后叫醒原会话 |
| `inbox-integration.example.json` | 加载并启用 `plugins/personal-inbox`，并把回复附卡的默认值写明（附卡默认开、额度行默认关、不需要用量页脚设置） |
| `bot-mentions-and-session-reset.example.json` | bot 之间只在被点名时才互相回话（`allowBots: "mentions"`），并打开 OpenClaw 自带的防循环；会话每天在固定的本地钟点重置，线程则闲置 24 小时才重置（`session.reset`、`resetByType.thread`）。 |
| `api-credit-providers.example.json` | 三个单独的 API 提供商（`anthropic-api`、`anthropic-standby-a`、`anthropic-standby-b`），各用各的密钥变量，不设回退；用于部分订阅附送的 API 额度 |

合并顺序不限，但 `commands.ownerAllowFrom` 只在 `continuation.example.json` 里设一次。应用前请对照你的 OpenClaw 版本核对字段名：这里的写法照参考部署（OpenClaw 2026.10.x）。
