# Why this design

English | [简体中文](../zh-CN/why-this-design.md)

This document explains the choices behind SoloFleet and sets them next to what others are doing. It goes from the whole to the parts.

One thing first, so the rest reads in the right light. **Almost every piece here has a precedent somewhere.** People run agents on a subscription. People build approval inboxes, review steps, screen locks. We looked at several dozen projects and products while writing this, and where someone got there first, this document says so. What we did not find is the pieces fitted together around one question: how does one person run a crew of bots every day without losing track of the bill or of their own attention?

So each point below is marked one of two ways:

- **Not seen elsewhere**: we looked and did not find it. That is a statement about where we looked, not about the world.
- **Done elsewhere, taken a step further**: others do this too; here is the extra step.

Each point also says where to look in this repository, so you can check the claim against the files. What is said about other projects comes from their own documentation as we read it at the time of writing; if we got one wrong, tell us.

---

## The two problems

**The bill.** Most multi-agent frameworks have each agent call a model API with its own key. That is flexible, and the cost is visible only afterwards, in a console, as a total. With a dozen agents it is hard to say which sentence cost what.

**Attention.** The more capable the agents, the more of them you run, and the more they need from you: approvals, clarifications, "is this what you meant?". Each question is fair. The sum is not something one person can keep up with. Products that put many agents behind one prompt face this from the other side: the user cannot see what is going on inside.

Everything below comes back to one of these two.

---

## The whole

### 1. One subscription for the whole crew

*Done elsewhere, taken a step further. The two-pool arrangement: not seen elsewhere.*

Every regular bot runs on the same Claude subscription. OpenClaw hands each turn to the official `claude` command line that is signed in on the same machine; `claude -p` is the non-interactive form of that path. The login stays with the official command line. Nothing here reads, stores or forwards it.

If the subscription plan includes API credits, they are treated as the second pool of the same subscription. The scheduled system audits and the standby bots use them, each through its own provider entry and key, with no fallback. When the credits are gone, those jobs pause quietly and resume when credits return. Nothing rolls over to paid usage.

**Others.** Running agents on a subscription is not new. Claude Code's own multi-agent features share one subscription across a team, and several bridges that bring Claude Code into Discord reuse the local login. Most general frameworks have each agent bring its own key and pay per use. What we added is a standing, role-divided crew on one subscription, and a clear split of work between its two pools.

**In daily use.** You know what the month costs before it starts. Sending ten bots to work costs the same as sending one.

**Where to look.** `config/examples/api-credit-providers.example.json` for the second pool's provider entries; `scripts/automation/api-quota-gate.mjs` for the quiet pause.

One caveat worth a sentence: whether a subscription covers this kind of use is the vendor's decision and it has shifted before, so read [Anthropic's current help page](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) before you build on it.

### 2. Every reply shows what it used

*Done elsewhere, taken a step further. Remaining quota and changed files on the card: not seen elsewhere.*

Under every reply there is a small card, on by default: the model, which pool the reply went through, the reasoning effort, and the files changed in that turn. One further line, how much of the subscription is left, comes from the [CodexBar](https://github.com/steipete/CodexBar) command line (a macOS app): install it, set two plugin options as described in the [Setup guide](setup.md#6-external-dependencies-and-what-happens-without-them), and the line appears. Leave it out and the rest of the card is unchanged.

**Others.** OpenClaw itself ships a usage footer that can show model, context and cost after each reply. Claude Code's status line has the model, effort and quota percentages, at the bottom of a terminal. Projects that show usage mostly price it at API rates, per task or on a dashboard. What we added to the official footer is the pool, the files changed, and, with CodexBar, the subscription remaining.

**In daily use.** No console to open. A glance at the card tells you who answered, with what, and what they touched; with CodexBar installed, also how much is left.

**Where to look.** `plugins/personal-inbox/execution-record.mjs`, `trailing-card.mjs` and `change-scan.mjs`.

### 3. Designed around one person's attention

*The pieces: done elsewhere. The set: not seen elsewhere.*

The owner's attention is treated as the scarcest resource in the system, and the rules are written from that starting point.

- What a bot can look up, do and check by itself, it does not ask about.
- What it must ask is merged into one message, with a recommendation and two or three numbered options. The buttons can only be pressed by the owner. A typed number counts too.
- Requests fall into three tiers that the owner approved in advance, so bots do not judge case by case what is "small":
  - **Just do it**, and mention it in the routine report.
  - **Ask once.** If there is no answer by the stated time, do the stated default. If the owner later says "undo", undo it.
  - **Always wait.** The six action classes, spending money, adding people or widening what data is shared, deleting real data, changing direction, rules or permissions.
- Everything in the third tier goes on a pending-decisions ledger, with a pinned summary. If a bot forgets to log a request, a script adds the row a little later.
- Reminders are restrained: one mention at first, then a merged reminder every few days with a cap on how many items, oldest first. "I'll look at the weekend" is taken at its word.
- The owner gets one report a day. Urgent things do not wait for it; the bot doing the work mentions the owner directly.
- Bots that were not addressed do not answer. In a project channel the lead bot picks up what the owner says, moves it to the right thread, and reports the result back in the main area. The owner does not have to open threads.
- Each week the system audit counts which interruptions could have been avoided and proposes a rule change.

**Others.** The closest thing we found is LangChain's writing on [ambient agents](https://www.langchain.com/blog/introducing-ambient-agents) and its Agent Inbox: it sorts "reaching the human" into notify, question and review, and queues them in one place. Gas Town filters escalations through several levels before they reach a person. An OpenClaw community project, opencrew, sorts actions into autonomy levels by reversibility. Several frameworks can halt at a marked tool and wait for approval. These are real precedents. We did not find the middle tier ("ask once, then default"), the ledger with back-fill, the capped reminders, the daily report and the weekly review put together.

**In daily use.** You are called a few times a day, and each call comes with a suggestion. You answer "2" and things move. If you do not answer, nothing is lost; the ledger holds it. The honest limit: this spares you remembering, but it cannot make you look. Something only you can decide will wait until you do.

**Where to look.** The "Sparing the owner's attention" section of `rules/shared-rules.md`; `plugins/personal-inbox/pending-ledger.mjs` and `request-watch.mjs`; `scripts/automation/pending-decisions.mjs`.

### 4. The program layer keeps the basics

*Done elsewhere, taken a step further. Daily model-free reconciliation: not seen elsewhere.*

In most agent setups, roles, reviews and handoffs are written into prompts and the model is trusted to follow them. That works until the day it does not.

Here, the things that must happen are listed and each is given to a program:

- A task card cannot become "done" unless an independent audit passed and the result is unchanged since submission.
- Auditors can only read, and can only write their own reports.
- Bots can only delegate through OpenClaw's own tools, so every handoff is visible on the Workboard and in threads.
- A request to the owner that was not logged gets logged.
- Every day, scripts that call no model check formats, reconcile project folders against their entries and the index, fingerprint the rule files, and list the commands the bots ran.

Things that need judgement stay in the rules. The rules given to the bots say, for each step, whether it is backed by a hard block, a daily check, or the rule alone. Programs are kept to "remind once" and "check that it happened". They do not judge; a program that judges ends up blocking normal work.

**Others.** The stance is not new. [12-factor agents](https://github.com/humanlayer/12-factor-agents) argues for keeping control flow in your own code. Claude Code has hooks that can stop a task from being marked complete, and you write what they check. What we did is go through the "must happen" list item by item, attach a program to each, and say in the rules which kind of backing each step has.

**In daily use.** "Done" from a bot is not the end of it; whether the card turns over is decided by a program. The rules do not stop working because a model had an off day.

**Where to look.** `plugins/personal-inbox/index.mjs` registers every gate; `scripts/automation/`; the tests in `tests/`. The step-by-step map is in [Development process](development-process.md).

### 5. Finished is not the same as done

*Done elsewhere, taken a step further. The "unchanged since submission" check: not seen elsewhere.*

Every task with a card goes to a task audit. There is no "skip" level. The auditor works from a fresh context and receives a submission slip and the result files. It does not read the worker's account of what happened, and it does not re-solve the task; it checks the result against the owner's words and the acceptance criteria, item by item.

When a card is about to become "done", the program checks, in order: the audit label, the submission record, whether there is a delivered "fail" (which blocks, and the owner's approval does not override it), whether there is a valid "pass", and whether the fingerprint of the result still matches what was submitted.

**Others.** OpenClaw's Workboard documentation says outright that completion proof is reported by the worker and that verification notes do not affect completion. This gate fills exactly that gap. Other projects have review steps; one of them, ccswarm, notes in its own README that it cannot yet tie a gate result to the version that was reviewed. Devin's review can be made a required check but is advisory by default.

**In daily use.** A "done" that reaches you has been checked by another bot against what you actually said, and has not been edited since.

**Where to look.** `plugins/personal-inbox/audit-gate.mjs`; `audit-guard.mjs`; the Task auditor's rules under `rules/roles/task-auditor/`.

### 6. Write-through, then reset every day

*Done elsewhere, taken a step further.*

What the owner says is written into the record in the turn they say it. A task that will continue gets its card in the same turn. With that in place, sessions are simply reset every day with OpenClaw's own setting. No handover is written. After a reset, a bot reads the task record and the authorized scope on the card and continues. The owner does not explain anything twice.

When a bot hits the subscription limit mid-task, a script notes it and wakes the same session once the limit resets. The bot first checks what it already did, and does not redo or resend it.

**Others.** Keeping state outside the conversation is a known idea. Gas Town keeps work state in a task store inside the repository; 12-factor agents argues for rebuilding the agent from records each time. Most frameworks lean on checkpoints, summaries or vector memory. The step here is making "write it down in the same turn" a hard precondition and then clearing sessions daily without worry.

**In daily use.** Context does not grow and grow. You come back the next day, say "continue", and the bot reads its notes and carries on.

**Where to look.** The "How to work" and "Where records go" sections of `rules/shared-rules.md`; `templates/`; `scripts/automation/quota-resume.mjs` and `reset-notice.mjs`.

### 7. The repository carries no patches to OpenClaw

*Done elsewhere, taken a step further.*

This repository uses only official settings, the official plugin interface and one plugin of its own. It carries no patches that modify the OpenClaw program itself. Where OpenClaw already has the feature (mention-only bot messages, loop protection, the Workboard, approval cards, session reset, the `computer` tool), it is used as is.

**In daily use.** When OpenClaw ships a new version, there is no stack of patches in this repository to carry forward. After an upgrade, re-run the tests and re-check the gates on your own machine; the official docs note that plugin hooks are not guaranteed to fire in every runtime.

**Where to look.** [Overview](overview.md) lists what comes from OpenClaw and what this repository adds.

### 8. Boundaries are written down

*Done elsewhere, taken a step further.*

Each mechanism is documented with what it stops and what it does not. Things that were tested on a real machine say so; things that were not say that too. The desktop safety document lists the four cases the program recognizes and, in the same breath, the cases it cannot. The completion gate says it cannot stop a script that writes to the Workboard database directly, and that a daily reconciliation catches that afterwards.

**In daily use.** If you set this up yourself, you know which parts you can leave to the program and which still need a rule and an occasional look.

**Where to look.** [Safety](safety.md); the "Limits" block under each step in [Development process](development-process.md).

### 9. The way the system gets changed is published too

*Not seen elsewhere, as far as we looked.*

A system like this is never finished. This repository includes the process used to change it: seven steps, shared by the person maintaining the system with a coding assistant and by the bots themselves when the owner decides something new. It comes with a table of where an audit is required and where it is not, and one rule we would recommend to anyone: at least one audit should come from a different vendor's model, because models from the same family talk each other into things.

**Where to look.** [Development process](development-process.md); `builder-tools/`.

---

## The parts

### The desktop

One bot operates the screen. The rest ask it.

- **A lock and a queue.** One machine, one screen, one thread at a time. A request that cannot get the lock is queued in a file, survives session changes, and is called when its turn comes. Claude Code's command-line computer use also allows one session at a time; a second one gets an error. The queue is the extra step.
- **Six action classes wait for the owner.** Payment, sending to outside parties, permanent deletion, form submission, file upload, software installation. Approval counts only when the owner's own account clicks the card. Another bot may decline on the owner's behalf; it may not agree on their behalf. Each approval releases one action and is then spent. OpenClaw's `computer` tool has no per-action confirmation of its own; this is added on top, using the official approval card with only "allow once" and "deny" offered.
- **Two checks.** The Desktop operator stops by rule when it sees one of the six coming. The program also recognizes some of them and forces a card. Today it recognizes four cases and cannot recognize a mouse click on a button. [Safety](safety.md) lists both, fully.
- **Not approved means not approved.** After a card is denied, expires or is cancelled, that thread may only look and close windows until a new card is approved. We did not find this elsewhere. It was made a hard block after a real test in which the bot read an expired card as a network fault and retried.
- **No way round by command line.** Shell commands that would drive the screen are blocked for the Desktop operator and sampled nightly.

### Audit

- Task audit and system audit are separate and do not review themselves or each other's remit.
- Serious signs that trigger a deep review are a short fixed list. Typos, dead links and one-off failures that recovered are fixed or noted, and nobody is disturbed.
- Audits look only at what changed since the last round.
- If the Task auditor gave advice on a piece of work, the Controller considers sending it to a different auditor.

### Decisions and records

- A **decision ledger** that every bot reads, written only by the Controller. Old approvals do not quietly become standing permissions.
- When the owner decides something that makes existing text wrong, bots follow seven steps. They fix their own records in the same turn, tell whoever maintains the others, and never edit the rules themselves; those go on a rule-change list for the owner to approve.
- When something needs the owner's judgement, the owner's original words travel with it. Paraphrase is where meaning gets lost.
- "Done", "can't be done" and "not found" are checked against the actual result before they are passed on, including when another bot says them.

### Files and projects

- One project, one channel, one folder. One task, one thread, one record. Fixed commands create them so names and places are right the first time.
- A daily reconciliation reports mismatches and moves nothing. Where a bot writes is deliberately not blocked at write time; blocking there tends to stop legitimate work.
- A trash folder is a holding area, not deletion. Emptying it needs the owner.

### Quota

- When a bot hits the subscription limit in the middle of a task, a script records it and wakes the same session after the limit resets, a limited number of times. The bot checks what it already did before continuing. A scheduled job that hit the limit is rerun once, not several times.
- The jobs that run on included API credits pause quietly when the credits are gone and resume when they return, with a reminder before the credits lapse. Running the scheduled audits on a second pool is something we did not find elsewhere.

### How Discord is laid out

- Four kinds of place, each with one use: the Workshop, project channels with a main area and task threads, the Lounge, and the Approval channel. A chat becomes a project only when the owner says so. "A channel is a post, a thread is a task" has been done in the OpenClaw community; the split between main area and threads, chat kept apart from work, and a separate approval channel are the extra steps.
- Bots must mention each other, and a bot that was not addressed stays silent. This is OpenClaw's own mention-only setting and loop protection, a common community configuration. The extra step is that a new bot joins only after the owner agrees, and the daily audit checks for joins that were not agreed.
- Progress lines open with one of five fixed words, and nothing shown to the owner uses internal IDs.

### Choosing who does what

- The Controller picks the bot and the effort level by the nature of the work, and says why in one sentence. Not everything goes to the strongest model, and not everything defaults to the cheapest.
- Records say "the latest" model of a family, never a version number. When a new version comes out, the configuration is changed in one place and each bot runs a small test.

### Role-play

Bots can be given personas. A persona shapes how a bot talks. Conclusions, numbers and decisions must stay clear whatever the voice. It is optional, and kept apart from the working rules. See [Roles](roles.md).

---

## What we would like to hear

If you have solved one of these differently, or you know a project that already does something we marked "not seen elsewhere", please open an issue. That is the point of putting this out.
