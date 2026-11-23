# Overview

English | [简体中文](../zh-CN/overview.md)

This document describes the whole system: who does what, where things happen in Discord, which parts are rules and which parts are programs, and what gets written down.

For the reasons behind the choices, read [Why this design](why-this-design.md). For how it feels to use, read [Daily use](daily-use.md).

## In one paragraph

A single [OpenClaw](https://github.com/openclaw/openclaw) gateway runs on one machine. It hosts a dozen or so agents. Each agent has its own Discord bot account and its own workspace, and each has one duty. The owner talks to them in a Discord server. All of them run on one Claude subscription. A plugin and a set of scheduled scripts check the things that must happen; a set of plain-language rules covers the things that need judgement.

## Duties

Bots are named by duty throughout this repository. If you give them personas, see [Roles](roles.md).

| Duty | What it does | What it does not do |
|---|---|---|
| **Owner** | Decides. Appears only where a decision is really theirs. | |
| **Controller** | Understands requests, records decisions, hands out work, sends work for audit, checks results against the owner's words, reports. | Does not audit itself. Stays quiet while others work. |
| **Worker** | Does the actual task in its own thread and keeps the task record up to date. | Does not widen its own scope. Does not mark its own work as audited. |
| **Desktop operator** | The only bot that operates the screen. Works in whichever thread called it. | Does not perform the six action classes without the owner's own approval. |
| **Task auditor** | Audits what a worker hands in, against the owner's words and the acceptance criteria. Read-only. | Does not fix the work, hand out work, or act as referee. |
| **System auditor** | Audits the system itself on a schedule: once a day, once a week, and once more when something serious turns up. Read-only apart from its own reports. | Does not audit individual tasks. |
| **Diary keeper** | Writes the owner's daily diary from the records. | Takes no other work. |
| **Standby** | Spare bots that run on the included API credits. Called only when the owner asks for them by name. | Take no task cards and no scheduled work. |

The agent IDs used in the configuration are listed in [Configuration](configuration.md).

## Where things happen in Discord

| Place | What it is for |
|---|---|
| **Workshop** | Where the owner and the Controller talk. No threads underneath. Other bots do not speak here. |
| **Project channels** | One channel per project. The main area takes the owner's words and gets results reported back. Each project has one lead bot that answers when the owner speaks without mentioning anyone. |
| **Task threads** | One thread per task, under its project channel. The work and its details live here. |
| **Lounge** | For chatting. A bot the owner mentions opens a thread and keeps them company. No project work is done here; if a chat turns into real work, the owner says so and the Controller turns it into a project. |
| **Approval channel** | Where approval cards and their reminders appear. |

A few rules hold the structure together:

- Bots must mention each other to talk, and a bot that was not mentioned does not respond. This uses OpenClaw's own "mentions only" setting and its built-in loop protection; nothing custom.
- A new bot joins a piece of work only after the owner agrees. The first plan lists who executes and who audits; one approval covers it.
- Nothing shown to the owner uses internal IDs. Natural titles only.

## Two pools of one subscription

| Pool | Who uses it | What happens when it runs out |
|---|---|---|
| **Subscription** | Everyday conversation and task work, for every regular bot. OpenClaw hands each turn to the official `claude` command line signed in on the same machine (`claude -p` is the non-interactive form of that path). | The turn fails with the vendor's limit message. A script notes it and, once the limit resets, wakes the same session to continue. |
| **Included API credits** (if your plan has them) | The scheduled system audits, the daily patrol, and the standby bots. Each goes through its own provider entry with its own key and no fallback. | The jobs are paused quietly and resume when credits return. Nothing rolls over to paid usage or back onto the subscription. |

Every reply carries a small card underneath it, on by default, showing the model, which pool it went through, the reasoning effort, and the files changed in that turn. Want the remaining-quota line too? Install the [CodexBar](https://github.com/steipete/CodexBar) command line (a macOS app) and set two plugin options; the steps are in the [Setup guide](setup.md#6-external-dependencies-and-what-happens-without-them). Until then the rest of the card shows as usual.

How to wire this up is in the [Setup guide](setup.md).

## Rule layer and program layer

The system is built on one sentence: **the program layer keeps the basics; it does not rely on the model to remember.**

Things are sorted into two kinds.

- **Things that must happen.** Was the work audited? Was the result registered? Was the request to the owner logged? Is only one bot touching the screen? These go to programs, which block, check daily, or fill in what was missed.
- **Things that need judgement.** How far does a new decision reach? Does this count as a conflict? Should the audit level go up? These stay in the rules, for the model to decide, and the system audit samples them afterwards.

### The rule layer

- `rules/shared-rules.md` is the one set of rules every bot follows: verify before you claim, how to work, what to do when the owner decides something new, how to speak, how to spare the owner's attention, hard limits, channels and mentions, where records go, what to do when the quota runs out.
- `rules/roles/` holds the short part that is specific to each duty.
- A sync script joins the two into each bot's `AGENTS.md`, so a change to the shared rules reaches every bot.

In the rules given to the bots, each step says what backs it: a hard block, a daily check, or the rule alone.

### The program layer

One plugin, `plugins/personal-inbox/`, hooks into OpenClaw's official plugin interface. Scheduled scripts under `scripts/automation/` run as command jobs and call no model.

| What it guarantees | How | Where |
|---|---|---|
| A task card cannot become "done" without a passed audit, and the result must be unchanged since it was submitted | Blocks the transition | `plugins/personal-inbox/audit-gate.mjs` |
| Auditors only read, and only write their own reports | Checks each command and each write | `plugins/personal-inbox/audit-guard.mjs` |
| One thread at a time on the screen; others queue | Lock checked before every screen call | `plugins/personal-inbox/desktop-lock.mjs` |
| The six action classes wait for the owner's own approval | Approval card; program recognizes some cases itself | `desktop-lock.mjs`, `sensitive-click.mjs` |
| Bots delegate only through OpenClaw's own tools | Blocks the model's native delegation tools | `plugins/personal-inbox/delegation.mjs` |
| A request to the owner is on the ledger even if the bot forgot to log it | Back-fills a row | `request-watch.mjs`, `scripts/automation/pending-decisions.mjs` |
| Formats are kept; mentions between bots are counted | Daily check | `scripts/automation/daily-format-check.mjs` |
| Project folders, entries and the index agree | Daily reconciliation, report only | `scripts/automation/project-files.mjs scan` |
| Work that stopped on a quota limit continues | Wakes the same session after the reset | `scripts/automation/quota-resume.mjs` |
| Commands run by the bots are sampled every day | Runs before the daily system audit | `scripts/automation/command-spot-check-trigger.js` |

The full list, step by step, is in [Development process](development-process.md). What each gate can and cannot stop is in [Safety](safety.md).

### What OpenClaw already provides

Nothing in this repository modifies the OpenClaw program. It uses what is there: multiple agents and Discord accounts, mention-only bot messages and loop protection, the Workboard, sub-agent sessions, scheduled jobs, session reset, plugin hooks and approval cards, the `computer` tool, the per-turn usage state, and memory. The plugin and scripts add the parts described above on top.

## What gets written down

The system continues from records, not from chat memory.

| Record | What it holds | Who writes it |
|---|---|---|
| **Task card** (on the Workboard) | The task, its audit level, and its authorized scope: goal, what is allowed, what needs the owner, when to stop | Controller |
| **Task record** (one per thread) | The owner's original words, current state, anything waiting on the owner, results | The worker doing the task |
| **Project entry** (one per project) | Current goal, state, next step, and a table of current results | The project's lead bot |
| **Master index** | One row per project: channel, lead bot, entry | Controller |
| **Decision ledger** | What the owner has decided and what they have decided not to do. Each entry has a title, date and scope, the original words, and what it replaces | Controller only; every bot reads it |
| **Pending-decisions ledger** | Every open request that must wait for the owner: what to decide, the recommendation, what it blocks, the deadline | Programs and the bots' logging tool; the Controller marks them received or decided |
| **Rule-change list** | Places where a rule no longer matches a new decision, each with a proposed wording and a status | Controller. The rules themselves are changed by whoever maintains the system, after the owner approves |

Two habits make these work:

- **Write-through.** What the owner says is written into the record in the same turn. If it is a task that will continue, the card is created in that turn too.
- **Daily reset.** Sessions are cleared every day using OpenClaw's own reset. A bot that picks a task back up reads the task record and the authorized scope on the card, and carries on.

Templates for all of these are in `templates/`.

## Two kinds of audit

- **Task audit** looks at what a bot handed in. Every task that has a card goes through it; there is no "skip audit" level. The auditor starts from a fresh context and gets only the submission slip and the result files. It does not read the worker's explanations.
- **System audit** looks at the system. A light pass every day, a deep pass every week, and a deep review when one of a short list of serious signs appears, such as a bot being pulled in without the owner's consent, or something the owner said not being recorded. It only looks at what changed since last time, so the cost does not grow with history.

The mechanical parts of both, such as counting, checking formats and comparing fingerprints, are done by scripts. The auditors read the results and judge.

## Scheduled jobs

| Job | Kind | What it does |
|---|---|---|
| Daily system audit | Model | Light audit and document upkeep |
| Daily patrol | Model | The Controller gathers the day into one report for the owner |
| Weekly system audit | Model | Deep audit |
| Anomaly deep review | Model | Runs only when a serious sign was recorded |
| Diary | Model | The Diary keeper writes the day's entry |
| Checks, reconciliation, reminders, quota handling, desktop queue | Command, no model | The scripts in `scripts/automation/` |

Prompts for the model jobs are in `jobs/`. Times and time zone are set in the configuration.

## How one task flows

1. The owner says what they want. The Controller writes it down in that turn.
2. If the task is new and complicated, the Controller restates it and proposes who does it and how it is audited. The owner agrees once.
3. The Controller creates the project (if needed), the task card with audit level and authorized scope, and the thread.
4. The worker does the work in the thread, leaves a progress line after each stretch, and keeps the task record current.
5. If a decision is needed, the worker asks with a recommendation and options, logs it on the pending-decisions ledger, and carries on with whatever does not depend on the answer.
6. When finished, the worker checks its own result and asks for audit. The Controller opens an audit thread with a submission slip.
7. The Task auditor reports. If it passes, the worker completes the card; the program checks the audit and the result fingerprint before letting it through.
8. The worker reports the result in the project channel's main area. A one-line completion record follows automatically.
9. In the evening, the patrol report tells the owner what moved, what is waiting on them, and what the system audit found.
