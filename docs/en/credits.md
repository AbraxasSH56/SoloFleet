# Credits

English | [简体中文](../zh-CN/credits.md)

SoloFleet is mostly arrangement. The foundations and many of the ideas belong to other people. This page lists what was actually borrowed and from whom.

Projects we only compared ourselves against are in [Why this design](why-this-design.md), not here.

## Where the idea came from

Two pieces of other people's work set this project going.

**"Exploring Super-agent Design: Towards a More Autonomous Agent System"**, by the DeepSeek Harness team, with its open-source prototype [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT). Its argument is that one task is limited by the model, but many tasks at once are limited by the attention of the person following them. That framing is where the second problem this project sets out to solve comes from, and "treat the owner's attention as the scarcest thing" is the same thought turned into rules. (The title is as in the prototype's README; no public link to the article itself was found, so the link goes to the repository.)

**[agent-autoloop](https://github.com/KKKKhazix/agent-autoloop)** (MIT), the agent automation system published under the name 数字生命卡兹克 (Khazix), together with the author's writing about it. Its idea is an agent that takes work on in the background, stays out of your way, and comes to you with a card only when it is unsure. The task record used here, with its "current state" and "waiting on the owner" sections so that work can be picked up without asking again, follows that line of thinking. (We could not find the specific follow-up article, so only the project is linked.)

Both gave us a way of looking at the problem; the rules, the plugin and the scripts here were written afterwards.

## What it stands on

| What | How SoloFleet uses it | Link |
|---|---|---|
| **OpenClaw** | The base for everything: multiple agents and Discord accounts, mention-only bot messages and loop protection, the Workboard, sub-agent sessions, scheduled jobs, session reset, plugin hooks and approval cards, the `computer` tool, the per-turn usage state, memory. This repository adds rules, one plugin and some scripts on top, and carries no patches to the OpenClaw program. | https://github.com/openclaw/openclaw · https://docs.openclaw.ai |
| **Discord** | The whole interface: channels, threads, mentions and buttons are what the Workshop, project channels, task threads, Lounge and Approval channel are made of. | https://discord.com |
| **Claude Code's command line** | How the subscription is connected. OpenClaw hands each turn to the signed-in `claude` command line; `claude -p` is its non-interactive mode. | https://code.claude.com/docs/en/headless |
| **CodexBar** | Its command line supplies the "remaining quota" line on the reply card. It is a macOS app installed separately; without it the card shows everything except that line. | https://github.com/steipete/CodexBar |
| **Peekaboo** | The screen-automation toolkit OpenClaw's `computer` tool uses by default on macOS. | https://github.com/openclaw/Peekaboo |
| **Artificial Analysis** | Its public benchmarks are the main basis for the model capability sheet the Controller reads before handing out work. | https://artificialanalysis.ai |

## How the documents are written

The rules and records aim to be short, direct and consistent in their terms, and to keep facts, suggestions, decisions and actual progress apart. That way of writing follows the principles of **ASD-STE100 Simplified Technical English** (Issue 9). The standard is written for English technical manuals; what is used here is an adaptation of its principles to process documents in both English and Chinese, not the standard itself.

- ASD-STE100: https://www.asd-ste100.org
- The adaptation is in `builder-tools/skills/ste-document-maintenance/`.

## How the bots are organized

The way duties, authority and checking are divided draws on the relevant chapters of a handful of management books, carried over to agents.

| Source | What was taken |
|---|---|
| Andrew S. Grove, *High Output Management* (the chapters on managerial leverage and task-relevant maturity) · [publisher page](https://penguinrandomhousehighereducation.com/book/?isbn=9780679762881) | Judge management by output. Delegating does not hand off responsibility for the result. Check cheap intermediate results early, and adjust supervision to how this particular task is going. |
| Stanley McChrystal and others, *Team of Teams* · [publisher page](https://penguinrandomhousehighereducation.com/book/?isbn=9780698178519) | A shared goal and shared awareness let those doing the work act on their own authority. The lead improves information and conditions. |
| Atul Gawande, *The Checklist Manifesto* · [author page](https://atulgawande.com/book/the-checklist-manifesto/) | Put a short checklist at the points that are easy to miss, and revise it from real use. |
| Henry Mintzberg, "A Typology of Organizational Structure" · [PDF](https://mintzberg.org/sites/default/files/article/download/hm_a_typology_of_organizational_structure.pdf) | Pick the coordination mechanism to fit the task. Think about structure, information flow and who decides as separate questions. |
| Herbert A. Simon, *Administrative Behavior* · [publisher page](https://www.simonandschuster.com/books/Administrative-Behavior-4th-Edition/Herbert-A-Simon/9781439136065) | A sub-goal serves the larger purpose and should carry it along. Separate choosing goals from establishing facts. |
| Donella H. Meadows, *Thinking in Systems* and "Leverage Points" · [excerpt](https://donellameadows.org/wp-content/userfiles/bathtubs101.pdf) | Look at backlog, flow and delay. Detection has to be connected to correction. |
| OpenStax, *Principles of Management* · [book page](https://openstax.org/details/books/principles-management) | Treat repeatable, decidable matters differently from new and ambiguous ones. |

The same notes also borrowed a few local design ideas from these open-source projects:

| Project | The idea taken |
|---|---|
| [ClawFu skills](https://github.com/guia-matthieu/clawfu-skills) | Evaluate by output; set how much checking a decision gets by its impact and reversibility; give the smallest relevant context. |
| [Agent Flow](https://github.com/svishniakov/agent-flow) | One role definition reused across many task instances, with duties, handoffs and checks arranged separately. |
| [Hive](https://github.com/hanuele/hive) | Choose temporary collaboration by uncertainty, impact and dependency, and keep independent views. |
| [PM Skills](https://github.com/phuryn/pm-skills) (pre-mortem) | Before a change, go through how it could fail and what already guards against that, and turn the important risks into actions. |
| [Agent Orchestration](https://github.com/madebyaris/agent-orchestration) | Shared queue, resource holds and dependency checks. |

The notes that distil these are in `builder-tools/skills/flat-agent-management/`. One line from them runs through this whole repository: hand clear-cut conditions to tools, and leave judgement of meaning to the model.

## While building

During construction, models from other vendors were used as independent auditors, on the reasoning that models from one family persuade each other easily. They were tools for building the system and are not part of the bot architecture.

## If something is missing

If you see an idea of yours here without your name on it, that is an oversight. Please open an issue and it will be added.
