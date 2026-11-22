# 角色

[English](../en/roles.md) | 简体中文

每个 bot 只有一个职责。职责决定它的规则文件、工具，以及程序允许它做什么。人设（一种角色口吻）是可选的，叠在职责上面。

## 各职责

| 职责 | agentId | 做什么 | 规则头部 |
|---|---|---|---|
| 总控 | `main` | 听懂需求、记录决定和任务卡、派活、送审、对照主人原话核对成果、汇报。建项目、维护总索引和决定账本。平时安静，被点名才出声。 | `rules/roles/main/` |
| 桌面操作 | `desktop` | 唯一碰屏幕的 bot。先拿屏幕锁，在点名它的线程里干活；付款、对外发送、永久删除、提交表单、上传、安装这六类要停下等主人。 | `rules/roles/desktop/` |
| 任务审计 | `task-auditor` | 只读地审执行者交的活，对照主人原话和验收标准；桌面 bot 卡住时给文字建议（不算审计）。 | `rules/roles/task-auditor/` |
| 系统审计 | `system-auditor` | 定时审系统本身（每天、每周、出异常时），除了自己的报告文件夹，全是只读。 | `rules/roles/system-auditor/` |
| 日记 | `diary` | 根据当天的记录替主人写每日日记。可选。 | `rules/roles/diary/` |
| 执行 | `worker-a`、`worker-b`… | 在项目线程里干具体的活，维护自己的任务记录。程序靠 `worker-` 前缀认执行者。 | `rules/roles/worker/` |
| 备用 | `standby-a`、`standby-b` | 平时不出场，主人明说才叫。走订阅附送的 API 额度池（如果有），不接任务卡，额度用完就停。头部和执行者共用。 | `rules/roles/worker/` |

程序按上面表里的 agentId 工作，`config/crew.json` 里 `bots` 的键说明你的部署里有哪几个（暂不支持改 agent 名字，见 [configuration.md](configuration.md) 第 3 节）。加执行者：在 `bots`、OpenClaw 的 agent 列表和 Discord 绑定里加 `worker-c`…，再跑 `scripts/sync-shared-rules.py --generate`。

## 生成的是什么

每个角色的 `AGENTS.md` ＝ 角色头部（`rules/roles/<目录>/AGENTS.head.md`）＋ 共用规则（`rules/shared-rules.md`，套上 `rules/shared-rules-overrides.json` 里的差异：桌面 bot 没有"桌面"小节，系统审计没有尾部）＋ 尾部（`rules/shared-tail.md`，回复附卡读的"本轮改动名单"标记）。中文版是 `*.zh-CN.md`。命令见 [setup.md](setup.md)。

## 可选的人设

人设给 bot 一种口吻：怎么说话、怎么称呼主人、一些小习惯。规则从不依赖它，只写"配了人设就照人设，但不能因此把话说得含糊"。

- `personas/TEMPLATE/` 是空的 `SOUL.md` 和 `IDENTITY.md`，带写法说明（一句话性格、表面和深层、说话方式、称呼、角色之间的规矩）。
- `personas/example/` 是一个原创的短示例角色。
- 要用的话，把它的 `SOUL.md` / `IDENTITY.md` 放进该角色的工作区、`AGENTS.md` 旁边（`<workspaceRoot>/<agentId>/`）。
- 不要把游戏、影视、书里的台词、头像、美术拷进公开仓库。游戏角色是别人的作品：自己写一个，或者把私人人设放在仓库之外。

### 参考部署用过哪些角色（可选对照表）

参考部署给各职责配的是电子游戏里的角色口吻。列在这里只是让你看到"一个职责可以对上怎样的角色"，这里不含它们的任何文字、美术和台词。

| 职责 | 当时用的角色 | 作品 |
|---|---|---|
| 总控 | Sandrone | 《原神》 |
| 桌面操作 | Silver Wolf | 《崩坏：星穹铁道》 |
| 任务审计 | Nous | 《崩坏：星穹铁道》 |
| 日记 | Fairy | 《绝区零》 |
| 备用 | Kafka、Firefly | 《崩坏：星穹铁道》 |
| 执行 | 同样三款游戏里的一批角色 | – |

（角色名用游戏英文版的写法；这张表只是说明，不代表版权方的认可。）
