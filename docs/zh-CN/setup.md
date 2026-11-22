# 搭建指南

[English](../en/setup.md) | 简体中文

这份指南带你从一台空 Mac 搭到一支能在 Discord 里答话的 bot 小队。照的是参考部署的搭法，按自己的情况取舍。下面所有编号、路径、名字都是占位，比如 `<OWNER_USER_ID>`。

先知道两件事：

- 程序读同一份中心配置 `config/crew.json`（复制 `config/crew.example.json` 得到）。所有编号、路径、时区、语言都在这里设，代码里不写你自己的部署信息。
- 程序目前还要认一些**中文字面词**（进度句开头、任务卡标签、报告首行、文件夹名）。英文版规则把这些词原样引出；配置里的 `locale`（默认 `en`）目前只管回复附卡的文字和几个跟语言有关的小功能。怎么处理见 [localization.md](localization.md)。

## 1. 需要什么

| 需要 | 说明 |
|---|---|
| 一台常开的 Mac | 桌面 bot 和桌面锁只在 macOS 上验过（锁用到 macOS 的文件独占锁）。其余部分是普通 Node 和 Python，别的系统理论上能跑，没验过。 |
| OpenClaw | 参考部署用 2026.10.x；插件声明 `pluginApi >= 2026.10.4`。 |
| Node.js ≥ 24.16 | 只用内置模块（`node:sqlite`、`node:test`），不用 `npm install`。 |
| Python 3 | 只用标准库；`scripts/sync-shared-rules.py` 和 `scripts/automation/publish-self.py` 要用。 |
| Discord 应用和 bot 账号 | 每个角色一个账号，点名和头像才分得开；见 `config/examples/discord-integration.example.json`。 |
| 一份 Claude 订阅 | 所有 bot 都走它。 |
| 已登录的 `claude` 命令行 | 经 `claude -p` 使用（见第 2 步）；登录到期提醒还会用 `claude auth status`。 |

可选：[CodexBar](https://github.com/steipete/CodexBar) 命令行（要另外装的 macOS 应用，给回复附卡加上剩余额度那一行，见第 6 节）、Peekaboo（OpenClaw 默认的屏幕读取提供方，桌面 bot 用）。

## 2. 接订阅

OpenClaw 用非交互模式（`claude -p`）把对话交给 Claude 命令行，所以 bot 走你的订阅，不是按量付费的接口密钥。按 OpenClaw 自己的文档配好 Claude 命令行后端，在网关所在的机器上登录一次。

有的订阅方案附送一份 API 额度，算同一份订阅的第二个池子。如果你的方案有，定时审计和备用 bot 可以用它：分别定义 `anthropic-api`、`anthropic-standby-a`、`anthropic-standby-b` 三个提供商，各用各的密钥变量，**不设回退**，用完就停，不会转去付费密钥。模板在 `config/examples/api-credit-providers.example.json`。方案没有这份额度的，就不要建这几个 API 任务，也不用备用 bot。

提醒一句：不要用 Google 订阅账号登录 OpenClaw，对方条款写明这算违约。

订阅额度用完时，`claude -p` 返回的是英文报错句。`plugins/personal-inbox/quota-recovery.mjs` 认这句话，好在额度回来后接着做被打断的活。这句话不翻译。

## 3. 配 Discord

建议的结构（程序和规则都照它）：

- **工坊**：主人只跟总控说话的频道，下面不开线程。
- **每个项目一个频道，每个任务一个线程**。主人在频道主区域说话，总控开线程派活。
- **闲聊频道**：聊天用，不建任务卡、不写记录、不送审。
- **审批频道**：插件的审批卡发到这里，只有主人本人能批。
- **日记频道**（可选）：日记 bot 在这里写。

程序和共用规则依赖的几条：

- bot 之间**只靠明确点名**说话（写 `<@BOT_USER_ID>`，只写名字没用）。除了项目频道的主责 bot 和日记频道，bot 只在被点名时回话。
- 项目频道的**主责 bot** 在本频道不点名也能回；建项目时 `scripts/automation/lead-free.mjs` 给它开，别的 bot 都不开。
- 防循环：每个线程里 bot 点名 bot 的条数由 `daily-format-check.mjs` 每天数一遍；数多了只是给审计的线索，不会自动停。

创建应用后，把 bot 令牌放进环境变量（`DISCORD_BOT_TOKEN_<角色>`）。不要把令牌写进任何文件。

## 4. 填配置、装插件、放规则

1. `cp config/crew.example.json config/crew.json`，填主人编号、服务器编号、频道编号、各 bot 用户编号、`timezone`、`paths`（`dataRoot`、`workspaceRoot`、`projectRoot`、`nodeBin`、`openclawBin`、`openclawInstallDir`）。逐项说明见 [configuration.md](configuration.md)。`config/crew.json` 已被 git 忽略。
2. 在网关的环境里设 `SOLOFLEET_CONFIG=<PROJECT_ROOT>/config/crew.json`。OpenClaw 会把装好的插件复制到临时目录加载，插件没法按自己的位置找到配置文件。
3. 把 `config/examples/` 里的片段合并进你的 OpenClaw 配置（agent、Discord 账号和绑定、工具清单、审批路由）。字段名要照你的 OpenClaw 版本核对，示例按 2026.10.x 写的。`inbox-integration.example.json` 负责加载并启用插件。
4. 准备数据根（`paths.dataRoot`）：把 `templates/任务记录.md` 和 `templates/项目入口.md` 复制到 `<DATA_ROOT>/模板/`（程序按这两个名字读），再用 `templates/*-header*` 建出 `INDEX.md` 和 `决定账本.md`。
5. 从仓库里的规则生成各角色的 `AGENTS.md`：

   ```bash
   python3 -I scripts/sync-shared-rules.py --generate --lang zh-CN --config config/crew.json
   ```

   （要英文规则就改传 `--lang en`。）

   它给 `bots` 里每个还没有 `AGENTS.md` 的角色（位置 `<workspaceRoot>/<agentId>/`）拼出"头部＋共用段（套差异表）＋尾部"，并按你的配置填占位（`{{OWNER_TITLE}}`、编号、路径）。`--dry-run` 只显示会写什么。以后改 `rules/`，先 `--check` 再 `--apply`：共用规则改一处推到全部角色，谁手改了自己那份也会被报出来。
6. **回复附卡（默认开）。** 每条 bot 回复下面会带一张小卡：模型、通路、思考档位和改了哪些文件。什么都不用配，而且它**不需要** OpenClaw 的用量页脚设置（`messages.responseUsage`、`messages.usageTemplate`）：插件直接读宿主给的这一轮用量状态里的模型和档位。`messages.responseUsage` 保持默认（`off`）即可。`config/examples/inbox-integration.example.json` 把默认值写明了（`executionRecord.enabled: true`、`quotaSource: "off"`），要关附卡就把 `enabled` 改成 `false`。剩余额度那一行是另一回事，**不装** CodexBar 命令行就不显示（见第 6 节）。
7. 重启网关，在工坊点名总控发一句话。

人设是可选的，见 [roles.md](roles.md)；不配人设 bot 也完全能用。

## 5. 定时任务

`jobs/` 放着各定时任务的指令全文（日审、周审、异常深审、巡查、日记）和 `followups-daily-job.example.json`。把每一份建成 OpenClaw 的定时任务，挂在对应的角色上、选你要的钟点（配置里的 `jobs.<名字>.time` 只是记录，真正的时间在 OpenClaw 的定时任务里设）。指令里有几处部署时要填的占位（`<TIMEZONE>`、`<DATA_ROOT>`、`<OPENCLAW_INSTALL_DIR>`）；审计守门在算片段指纹前会按 `config/crew.json` 把它们填上，所以任务正文和配置要保持一致。`scripts/automation/` 里的命令型脚本（额度闸、提醒、白天看护、重置通知等）是给 OpenClaw 命令型定时任务用的，每个脚本开头的注释写了多久跑一次。

每日摘要的自发（`scripts/automation/publish-self.py`）要在配置里给每个任务设好 `jobs.publishSelf.effectiveFrom` 才会发（见 [configuration.md](configuration.md)）；各摘要的截止点就是该任务的 `jobs.<名字>.time`。

## 6. 外部依赖，缺了会怎样

| 依赖 | 用来 | 缺了会怎样 |
|---|---|---|
| [CodexBar](https://github.com/steipete/CodexBar) 命令行（要自己装的 macOS 应用） | 回复附卡上的剩余额度那一行：插件选项 `executionRecord.quotaSource: "cli"`，再给 `executionRecord.credentialProfilePath` | 这一行就是不显示，也不报错；附卡照常写模型、通路、档位和改动文件。默认就是这样（`quotaSource: "off"`）。 |
| OpenClaw 任务板数据库 | 几处只读查表（卡标题、状态、标签） | 结案关口退回用 OpenClaw 命令行查。 |
| `claude auth status` | 登录到期提醒 | 提醒里写"读不到状态"。 |
| `claude -p` 的英文额度报错句 | 额度停了以后接着做 | 接续不会触发；活没丢，要手动重来。 |
| `jq`、`sqlite3`、`git` | 命令抽查和对账脚本 | 受影响那一节写"记录不足"，不会崩。 |
| Peekaboo | 桌面 bot 读屏幕 | 桌面 bot 看不见屏幕。 |

## 7. 跑测试

```bash
SOLOFLEET_CONFIG=tests/fixtures/crew.test.json node --test tests/*.test.mjs
python3 -I -m unittest discover -s tests -p "test_*.py"
python3 -I scripts/automation/publish-self-test.py
```

测试全都用临时文件夹和假数据，不碰真实部署、Discord 和网络。`node` 要在 `PATH` 里。有一个用例（`execution-record-changes` 里的 T14）只有设了 `OPENCLAW_SDK_TEXT_CHUNKING`（指向已安装的 `plugin-sdk/text-chunking.js`）才会跑，其余都不需要真实 OpenClaw。

## 8. 接下来读什么

- 全部设置：[configuration.md](configuration.md)
- 换语言：[localization.md](localization.md)
- 角色和可选人设：[roles.md](roles.md)
- 安全设计和已知边界：[safety.md](safety.md)
