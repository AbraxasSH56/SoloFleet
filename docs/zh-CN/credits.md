# 致谢

[English](../en/credits.md) | 简体中文

SoloFleet 做的主要是"摆放"。地基和很多想法是别人的。这一页列的是真正借来的东西，和它们各自的来处。

只是拿来对照过的项目，放在[为什么这样搭](why-this-design.md)里讲，不列在这里——对照过不等于借鉴了。

## 想法从哪来

这个项目是被两份别人的工作带起来的。

**《Exploring Super-agent Design: Towards a More Autonomous Agent System》**，DeepSeek Harness 团队的文章，配套的开源原型是 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT）。它的主张是：单个任务的上限在模型，同时做很多任务的上限在跟进它们的那个人的注意力。这个项目要解决的第二个问题就是从这个说法来的，"把主人的注意力当成最稀缺的东西"是同一个想法落成了规则。标题照原型仓库 README 里的写法；文章本身我们没找到公开的网址，所以链接给的是仓库。

**[agent-autoloop](https://github.com/KKKKhazix/agent-autoloop)**（MIT），"数字生命卡兹克"公开的 Agent 自动化系统，以及作者围绕这套系统写的文章。它的想法是：让 agent 在后台自己接活、平时不来烦你，拿不准的时候才发一张卡片找你拍板。这里的任务记录带"当前状态"和"等主人拍板"两节、让活能不重问就接上，走的就是这条思路。具体是作者后续的哪一篇文章，我们没能查到，所以只链了项目。

从这两处拿来的是看问题的角度。这个仓库里的规则、插件和脚本是另外写的，其中的错处算我们的。

## 站在什么上面

| 什么 | SoloFleet 拿它做什么 | 链接 |
|---|---|---|
| **OpenClaw** | 一切的底座：多 agent 和多个 Discord 账号、只接受点名和防循环、任务板、子任务会话、定时任务、会话重置、插件钩子和审批卡、`computer` 工具、用量页脚、记忆。这个仓库在上面加了规则、一个插件和一些脚本，不带任何修改 OpenClaw 程序本体的补丁。 | https://github.com/openclaw/openclaw · https://docs.openclaw.ai |
| **Discord** | 整个界面：工坊、项目频道、任务线程、闲聊频道、审批频道，都是用频道、线程、点名和按钮搭出来的。 | https://discord.com |
| **Claude Code 的命令行** | 订阅是这样接上的：OpenClaw 把每一轮交给登录好的 `claude` 命令行；`claude -p` 是它的非交互模式。 | https://code.claude.com/docs/en/headless |
| **CodexBar** | 回复附卡上"剩余额度"那一行由它的命令行提供。它是一个要另外装的 macOS 应用；没装的话，卡上除了这一行都照常显示。 | https://github.com/steipete/CodexBar |
| **Peekaboo** | OpenClaw 的 `computer` 工具在 macOS 上默认使用的屏幕自动化工具包。 | https://github.com/openclaw/Peekaboo |
| **Artificial Analysis** | 总控派活前要读的模型能力表，主要依据是它的公开测评。 | https://artificialanalysis.ai |

## 文档怎么写

规则和记录力求简短、直接、术语前后一致，并把事实、建议、决定和实际进度分开。这种写法参照的是 **ASD-STE100 简化技术英语**（第 9 版）的原则。这份标准是为英文技术手册写的；这里用的是把它的原则搬到中英文过程文档上的一种适配，不是标准本身。

- ASD-STE100：https://www.asd-ste100.org
- 适配的写法在 `builder-tools/skills/ste-document-maintenance/`。

## bot 怎么分工

职责、授权和检查怎么分，参考了几本管理学的书。读的只是相关章节，拿来的是一种方法，再转用到 agent 上。它对 agent 管不管用，要在使用里验证，书并没有这样许诺。

| 来源 | 拿来了什么 |
|---|---|
| Andrew S. Grove《High Output Management》（管理杠杆、任务相关成熟度两章）· [出版社页面](https://penguinrandomhousehighereducation.com/book/?isbn=9780679762881) | 按产出评价管理。把活派出去，对结果的责任并没有派出去。尽早检查成本低的中间结果，监督的松紧跟着这件具体任务的表现调。 |
| Stanley McChrystal 等《Team of Teams》· [出版社页面](https://penguinrandomhousehighereducation.com/book/?isbn=9780698178519) | 有共同的目标、共享的态势，干活的人才能凭自己的授权行动。带头的人负责改善信息和条件。 |
| Atul Gawande《The Checklist Manifesto》· [作者页面](https://atulgawande.com/book/the-checklist-manifesto/) | 在容易漏的节点放一份短清单，并照真实使用去修订它。 |
| Henry Mintzberg《A Typology of Organizational Structure》· [PDF](https://mintzberg.org/sites/default/files/article/download/hm_a_typology_of_organizational_structure.pdf) | 协调办法跟着任务选。组织结构、信息怎么流、谁来决定，是三个分开想的问题。 |
| Herbert A. Simon《Administrative Behavior》· [出版社页面](https://www.simonandschuster.com/books/Administrative-Behavior-4th-Edition/Herbert-A-Simon/9781439136065) | 子目标是为整体目的服务的，要把那个目的一起带上。选目标和查事实分开。 |
| Donella H. Meadows《Thinking in Systems》和《Leverage Points》· [节选](https://donellameadows.org/wp-content/userfiles/bathtubs101.pdf) | 看积压、流量和延迟。发现问题要和纠正问题连起来。 |
| OpenStax《Principles of Management》· [图书页面](https://openstax.org/details/books/principles-management) | 能重复、能判定的事，和新的、模糊的事，分开对待。 |

同一份笔记还从几个开源项目里借了具体的、局部的设计想法。在这里点名，是感谢这些想法，不是对这些项目整体的评价。

| 项目 | 借来的想法 |
|---|---|
| [ClawFu skills](https://github.com/guia-matthieu/clawfu-skills) | 按产出评价；一个决定要查多细，看它的影响和能不能撤回；给最少的相关上下文。 |
| [Agent Flow](https://github.com/svishniakov/agent-flow) | 一份角色定义用在许多个任务实例上，职责、交接和检查分开安排。 |
| [Hive](https://github.com/hanuele/hive) | 按不确定性、影响和依赖来选临时协作的方式，并保留独立的看法。 |
| [PM Skills](https://github.com/phuryn/pm-skills)（事前验尸） | 动手之前先过一遍可能怎么失败、已经有什么在防着，把重要的风险变成动作。 |
| [Agent Orchestration](https://github.com/madebyaris/agent-orchestration) | 共享队列、资源占用和依赖检查。 |

把这些提炼成条的笔记在 `builder-tools/skills/flat-agent-management/`。其中有一句话贯穿了整个仓库：判定条件明确的事交给工具，意思上的判断留给模型。

## 搭建的时候

搭建期间用过别家厂商的模型做独立审计，理由是同一家的模型容易互相说服。它们是搭这套系统时用的工具，不属于 bot 架构。

## 如果漏了谁

如果你在这里看到了自己的想法却没看到自己的名字，那是疏漏。请开个 issue，会补上。
