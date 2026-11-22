# Development process

English | [简体中文](../zh-CN/development-process.md)

This is the process used to change SoloFleet. What the architecture is and why it is built this way are covered in the [README](../../README.md) and [Why this design](why-this-design.md). This document covers only one thing: how to go about it when something has to change.

It is used on two occasions:

- **When building**: a person, working with a coding assistant, changes the system (rules, scripts, plugin, configuration).
- **When running**: a bot receives a new decision from the owner and acts on it.

Underneath there is one sentence: **the program layer keeps the basics; it does not rely on the model to remember.** Things that must happen (did the audit pass, was the result registered, was the request logged) are given to programs to check, block and back-fill. Things that need judgement (how far the effect reaches, whether something counts as a conflict, whether to raise the audit level) stay in the rules, for the model to judge, and an audit samples them afterwards.

The process has seven steps:

**New decision → judge the reach → find and fix conflicting entries → do the work → independent audit → check against the originals → write the records through**

**When to follow the seven steps**: when the owner has decided something new, or changed their mind, in a way that makes things already written down wrong.

**When not to**: small matters where the object, result and place are all clear, and questions that end when answered, are simply done. Nothing in the Lounge goes through this; only when the owner says to turn it into real work does it go to the Controller. Read-only auditors, the diary role and the standby bots do not run the steps; if they hear a decision that reaches elsewhere, they do one thing, which is tell the Controller.

**Audit is not done at every step.** It is done at points chosen in advance, where gaps tend to appear. See section 3.

---

## 1. Roles, by duty

| When | Role | What it does |
|---|---|---|
| Running | Owner | The one who decides. Appears only where the decision is really theirs |
| Running | Controller | Understands requests, records decisions, hands out work, submits for audit, checks, reports |
| Running | Worker | Does the task and keeps its own task record |
| Running | Task auditor | Audits what a worker hands in. Read-only |
| Running | System auditor | Audits the system itself on a schedule (daily, weekly, on anomalies). Read-only |
| Running | Desktop operator | The only bot that operates the screen |
| Building | Coordinator | Coordinates and does not build: records decisions, issues instructions, checks against the originals |
| Building | Builder | The coding-assistant session that changes the system |
| Building | Auditor | Independent audit, read-only. **At least one audit comes from another vendor's model** |
| Building | Document cleaner | Read-only screening: which older statements has a new decision made obsolete |

When hands are few, one person or one assistant may take several roles in turn. Two things cannot be dropped: **whoever built it does not audit it**, and **at least one audit comes from another vendor's model**, because models from the same family persuade each other easily.

---

## 2. The seven steps

Each step has three blocks: what to do, what backs it, and its limits. Wherever the backing is a program, its place in the repository is given.

### Step 1. New decision

**What to do**
- A decision the owner states is written into the record in the turn it is stated. It is not saved up and not left to memory.
- When building: the Coordinator writes it into the decision log (date, who decided, content, reason, original words; append-only, with replaced entries marked as replaced by which one).
- When running: a decision that concerns one project is written into that project's entry by its lead bot. A decision that reaches several projects, or is of the "from now on" kind, is written into the decision ledger by the Controller (each entry has a title, a date and scope, the original words, and what it replaces; conclusions only, no process). **A worker that hears such a decision tells the Controller, with the original words, and does not write the ledger itself.**

**What backs it**
- Program (building): a closing gate. At the end of each of the Coordinator's turns it compares several records; if one changed and another that should follow did not, it stops once and asks for confirmation. A small record-writing tool takes the time itself so timestamps cannot be mistyped. *These two are small tools on the builder's own machine and are not in the repository.*
- Program (running): `scripts/automation/ledger-watch.mjs` keeps a list of decisions not yet entered, checks on a schedule, and wakes the Controller when one has been waiting more than a day.
- Program (running): `scripts/automation/daily-format-check.mjs` checks every day that each ledger entry has a date and the original words.
- Rule plus sampling: no program checks on the spot whether what the owner said was recorded. The system audit checks daily, and a miss counts as an anomaly that must be reviewed in depth.

**Limits**
- The gate sees only whether files changed, not whether they should have. So it stops once and only reminds.
- Adding an item to the "not yet entered" list still depends on someone remembering to do it.

### Step 2. Judge the reach

**What to do**
- Ask one question first: which things already written down does this decision make wrong?
- When building, look at: rule files, designs and change plans, scheduled-job prompts, templates, memories, each of the records, and default values and examples inside scripts.
- When running, look at: older ledger entries, the owner's current-situation note, project entries, the authorized scope on task cards, plans in progress, timed tasks already set, open requests, and rule files.
- Note which places were checked and which conflict, on the task card or task record for this matter. If there is no card, mention it when replying to the owner. It does not go into the decision ledger.

**What backs it**
- **The rule alone.** This step is judgement. A program cannot do it.

**Limits**
- This is the step that depends most on diligence. The screening in step 3 and the look back in step 7 are its remedies.

### Step 3. Find and fix conflicting entries

**What to do**
- Within the range drawn in step 2, find each entry that no longer matches the new decision and fix it. **Not just one place.**
- When building: each time the owner adds a decision, the Document cleaner does a read-only screening in that same turn. It does one more when a whole batch is finished and one before the Coordinator compacts its context. Besides checking the new entry, it looks for older statements the decision has made obsolete. What it finds in the Coordinator's own files is fixed that turn; what it finds in rules and programs goes into the next change instruction.
- When running:
  - Records a bot maintains itself are fixed in that turn. For records someone else maintains, the bot tells the maintainer and does not fix them on their behalf. A project entry is fixed by that project's lead bot; the Controller does not fix other projects' entries either.
  - Authorized scope on a task card: narrowing it to match the new decision can be done in that turn. Widening it waits for the owner to confirm again.
  - **Rules, scope documents, permissions, scheduled jobs: bots do not change these themselves.** The Controller records "which file, which sentence, where it conflicts, what it should become" on a rule-change list (a file at a fixed place, each row with a status), asks the owner under the "always wait" tier, and logs it on the pending-decisions ledger. Once the owner approves, whoever maintains the system makes the change from the list. Afterwards the Controller reads the rule back and marks the row "changed" only if it matches.
  - No task card is created for this kind of matter. It does not go through the running-time task audit, and a card would never pass the completion gate. The rule-change list and the ledger entry are its record.

**What backs it**
- Program (building): when the closing gate sees a new entry in the decision log, it reminds once that the Document cleaner should be called.
- Program (building): `scripts/sync-shared-rules.py`. A change to the shared rules is checked, written, fingerprinted and pushed to every role, with none missed and none scrambled.
- Program (running): `scripts/automation/audit-blindspots.mjs` fingerprints the rule files under each role's directory every day and lists any that changed, with the latest commit, for the system audit to judge. It does not cover the shared-rules source, the scope document, the scheduled-job prompts or the templates.
- Program (running): back-fill for requests. `plugins/personal-inbox/request-watch.mjs` notes each request with buttons that a bot sent; `scripts/automation/pending-decisions.mjs` later adds a ledger row if none was logged. Ledger writes go through `plugins/personal-inbox/pending-ledger.mjs`, under a lock.
- Program (running): `plugins/personal-inbox/approval-reminder.mjs`. When an approval has expired unapproved, the program has the Controller mention it the next time the owner talks to it, and not again for some hours.
- Rule plus sampling: the weekly system audit looks for duplicated or contradictory rules and outdated documents, and produces a list only.

**Limits**
- "Which entry counts as a conflict" is judgement. Programs only remind and look afterwards.
- There is no dedicated Document cleaner at running time. It rests on the Controller looking, with the weekly audit behind it.
- Back-fill recognizes only requests sent with buttons.
- How the maintainer gets to see the rule-change list regularly has to be agreed separately. Without that, it depends on the owner passing the word.

### Step 4. Do the work

**What to do**
- When building:
  - A new batch of work gets a new session. There is a cap on batches in progress at once. Instructions are always given in full, never as patches to earlier instructions.
  - Before changing a file that is the only original, keep a copy that can be restored. Text already tracked by version control is not copied again, and things that can be reinstalled or regenerated are not kept.
  - **Hard stop conditions.** On meeting one, stop and ask the owner: installing new software; changing the source of OpenClaw itself, its Discord plugin, or other third-party software; creating a module, job or mechanism that is not in the plan; three failed attempts along the same route; an hour with no real progress on the same obstacle.
  - Matters for the owner to approve are gathered and asked together, each with five things written out: what you want to do, which problem it solves, what happens if it is not done, the cost, and your recommendation.
  - Tests follow the path the owner will really use later. Test messages carry a marker, are sent only in test channels, and are deleted in pairs afterwards.
  - If a permission blocks you, stop. Do not find another way round.
- When running: complicated or irreversible work is restated first and waits for confirmation; projects and task records are created with fixed commands; a new card states its audit level and authorized scope; a progress line with a fixed opening is left after each stretch; matters for the owner go with a recommendation and options and are logged at the same time; when stuck, stop and say so.

**What backs it**
- Program does it: `scripts/automation/project-files.mjs` (`new-project`, `new-task`). Project folder, entry, index row and task record are created correctly in one go, and a non-conforming name is refused. Creating a project also runs `scripts/automation/lead-free.mjs`, which lets only the lead bot answer without a mention in that channel.
- Program samples: `scripts/automation/daily-format-check.mjs` checks the status line of task records, whether requests were written into the record, the audit level and authorized scope on task cards, and the number of bot-to-bot mentions per thread (a high count is only a lead; the audit judges whether it is going in circles).
- Program blocks: `plugins/personal-inbox/delegation.mjs`. Bots can only delegate through the system's own tools.
- Program blocks: `plugins/personal-inbox/desktop-lock.mjs` and `sensitive-click.mjs`. Before payment, sending to outside parties, permanent deletion, form submission, upload and installation, the Desktop operator stops and waits for the owner's own confirmation. The program reads the words on the control itself in the cases it can, and does not rely only on the bot reporting. `desktop-lock.mjs` also blocks the Desktop operator from driving the screen through the command line. What it can and cannot recognize is set out in [Safety](safety.md).
- Program blocks: `plugins/personal-inbox/stuck-guard.mjs`. After two failures in a row on the same step, the Desktop operator is stopped and required to ask for help.
- Program does it: `scripts/automation/quota-resume.mjs`. Work that stopped half-way on a quota limit is woken by the program after the limit resets and continues, without resending or redoing.
- Program does it: `scripts/automation/reset-notice.mjs`. A fixed notice before and after each daily session reset. After the reset, bots continue from the task record.
- Program blocks (building, for "changing the program itself" only): the program directory is set as not writable in the coding assistant's permission settings. *A local setting, not in the repository; set the same in your own assistant.*
- Program reminds (building): after work is handed out, a reminder to set a fallback check and not wait idle. *A local hook, not in the repository.*
- The rest rests on rules.

**Limits**
- The fixed commands have to be called by the bot. So the daily reconciliation checks the result, and doing it right by hand also counts.
- Where bots write files is not blocked by a program (auditor roles excepted). It rests on rules plus daily reconciliation. This is a deliberate trade: blocking at write time tends to stop normal work.

### Step 5. Independent audit

**What to do**
- The auditor is given three things only: the goal and acceptance criteria, the owner's relevant original words, and the paths of the originals to check. It is not given the builder's account of the process, nor the Coordinator's own judgement, so it is not led.
- Every audit conclusion comes with its basis (path and line of the original, the command and its output, the steps it reproduced). A conclusion without a basis may only be written as "inferred" or "not verified". **A "must fix" with no basis blocks the next step only after the Coordinator has verified it.**
- Conclusions are sorted into three classes: ① must fix, something will really go wrong; ② stating the limit is enough; ③ wording. **Only ① blocks the next step.** The Coordinator may raise a ② to must-fix. When the same problem has been fixed for two rounds and only ② and ③ remain, close it.
- Do not add protection for things nobody uses. Old leftovers from trial runs and temporary by-products outside the plan, when an audit asks to protect them, are handled as ③ or not adopted.
- When choosing between fixing, withdrawing one item and rolling back the whole, or when the consequence is large and there is no basis: discuss it back and forth with another vendor's model until it is talked through. Do not decide alone.

**What backs it**
- Program blocks (running): `plugins/personal-inbox/audit-gate.mjs`. Before a task card becomes "done", it checks in turn the audit label, whether there is a submission record, whether the report is a pass, and whether the result changed after submission. Not submitted or not passed, it cannot turn over. The owner's approval does not override a "fail".
- Program blocks (running): `plugins/personal-inbox/audit-guard.mjs`. Auditor roles may only read, and may only write to listed places.
- Program reconciles afterwards (running): `scripts/automation/day-watch.mjs`. If someone goes round the gate and writes a card as done directly, it can be found afterwards.
- Program does it (running): `scripts/automation/command-spot-check-trigger.js`. Before the daily system audit starts, it samples the commands each role ran, without calling a model, and runs the file reconciliation along the way.
- Program does it (running): `scripts/automation/api-quota-gate.mjs`, `timed-reminders.mjs`, `quota-catchup.mjs`. When the credits used by the system-audit jobs run out, the jobs stop quietly and resume when credits return, with a reminder before the credits lapse; an audit job that hit a quota limit is rerun once after recovery.
- Program does it (building): an audit-invocation script. Every audit instruction automatically gets three paragraphs added: "conclusions must carry their basis", "sort into three classes", "no dangerous version-control commands". It defaults to the everyday audit tier and runs read-only. *A simplified example is in `builder-tools/cross-vendor-review/`.*
- Whether to audit, and at which tier: **the rule alone**. See section 3.

**Limits**
- The gate cannot stop "write a script that edits the Workboard database directly". That is left to the reconciliation afterwards.

### Step 6. Check against the originals

**What to do**
- When something is handed back, first read the result itself against the owner's words and the acceptance criteria, then pass it on. Do not pass on the word "done".
- Before saying "there is none" or "it can't be done", check the originals and try another way. When someone else says so, ask what they tried.
- This is a second check beside the audit. It does not replace the audit.

**What backs it**
- Mostly the rule.
- Program reminds (running): `project-files.mjs check-project` checks before closing whether the project entry has kept up. If it has not, `plugins/personal-inbox/completion-notice.mjs` adds a reminder to the end of the completion record after closing. It does not block.
- A small part blocked by program: the result fingerprint in `audit-gate.mjs` (as in step 5).

**Limits**
- When building, this step rests entirely on the Coordinator's diligence.

### Step 7. Write the records through

**What to do**
- When running: set the state to "done", write the result's location clearly, register the result in the project entry, put temporary files where they belong, send the progress line for completion.
- When building: go over the records before closing each turn; list leftover temporary things on the cleanup list; archive the session when it is finished.
- In both: go back over the range drawn in step 2. Each place has either been changed, or is recorded as outstanding (on the rule-change list or the ledger).

**What backs it**
- Program does it: `project-files.mjs add-result`. One command registers a result in the project entry.
- Program reconciles daily: `project-files.mjs scan`. It runs once a day before the system audit starts, without calling a model, and checks the data root, the project structure, whether entries have kept up, whether names conform, and anything new in the bots' workspaces.
- Program does it: `completion-notice.mjs` and `small-job-notice.mjs` each add a one-line record, for closed cards and for small jobs that had no card. `card-thread-map.mjs` matches task cards to threads automatically.
- Program reminds (building): the closing gate (as in step 1).
- The rest rests on rules.

**Limits**
- Reconciliation only reports and suggests. It does not move files.

---

## 3. Where an audit is required

### When building

| Situation | What to do |
|---|---|
| A design or change plan, before starting | Send it to the everyday audit for a pre-review; start only when it stands |
| A batch that changes the live system or the program layer, before going live | Two models audit it, one report each (at least one from another vendor); disagreements are taken up and discussed back and forth |
| After a batch has gone live and been tested | Result audit, as above |
| After an audit gave ① and the rework is done | Re-check |
| A batch that changed programs or bot behaviour | Independent verification is folded into the result audit: the auditor of the result reads the code, reruns the offline tests, and checks the evidence left by the builder's real tests (screenshots, read-backs, ledgers). Tests on the real chat platform are still done by the builder. No separate verification session is opened |
| Choosing between fix, withdraw and roll back; large consequence and unsure | Discuss back and forth with another vendor's model |
| Scheduled jobs and naturally triggered scripts, where a real trigger cannot be produced on the spot | Close first; after it has run naturally once, the Coordinator reads the raw log; if it does not match, handle as ① |
| Closing edits that only change documents | Not audited separately; folded into the next result audit (not skipped, only merged) |
| A fix where the cause is clear, the change is direct, only new code from this stretch is touched, and the consequence is small | Fix directly; the next result audit looks at it together |
| Withdrawing to a version that was already audited | No new audit; the Coordinator checks the diff and the evidence |
| What remains is specific mechanical problems, line-level checks | After they are fixed, the Coordinator checks against the originals and closes if they pass |
| The same problem has been audited three rounds with no ① | Close; no more re-checks |
| A small change that touches no secrets and can be reverted at any time | With the owner's approval it may be done first and audited afterwards |
| Purely subjective "does it feel right" | Not sent to audit; the owner judges |
| The change plan already says what to do and the consequence is small | Follow the change plan |
| A detail where the direction is obvious and the consequence small | Decide as recommended, write it in the record, mention it in the report |
| Damage is happening now and cannot wait | Do the minimum to stop the damage first, then report |

A few lines on choosing models for the auditor: always use a high reasoning tier; a model that has been retired is not kept as a fallback; the order of fallbacks is fixed in advance, and each time a fallback is used, note who stood in and why.

### When running

| Situation | What to do |
|---|---|
| Work with a task card | Always goes through task audit; it counts as done only on a pass; there is no skip-audit tier. The same holds when the result is itself a document |
| Scope beyond the plan, usage over half the budget, the result is going outside, another bot was added on the way, the worker says it is unsure | The Controller proposes raising the audit level; the owner confirms |
| The audit did not pass | One rework. If it fails a second time, it goes to the owner |
| The Task auditor says plainly it cannot review this (the model declined) | Only then is another model used for the review. Out of quota or an error does not count |
| The Task auditor gave advice on this work | When submitting, the Controller considers sending it to a different auditor |
| Questions that end when answered, chat, small jobs done within the turn | No card, no audit |
| Editing one's own task record, or the state in a project entry one leads, to align with a new decision | No separate card and no separate audit. If the matter already had a card, the card goes through audit as usual |
| The system itself | One light audit a day, one deep audit a week, one more when a serious anomaly appears |
| The Lounge | The system audit checks two things only: whether work that should have been a project was done in the Lounge; whether a bot that was not called spoke up or pulled in another bot |
| Many handoffs back and forth between bots | Only a lead. It goes in the report only if the work is really going in circles, and is not a serious anomaly |
| The six action classes, spending money, adding people or widening the data shared, deleting real data, changing direction, rules or permissions | Always wait for the owner in person |

---

## 4. Programs in the repository

| Program | Step | What it does |
|---|---|---|
| `scripts/automation/ledger-watch.mjs` | 1 | List of decisions not yet in the ledger; wakes the Controller when overdue |
| `scripts/automation/daily-format-check.mjs` | 1, 4 | Daily format check; counts mentions |
| `scripts/sync-shared-rules.py` | 3 | Syncs the shared rules to every role |
| `scripts/automation/audit-blindspots.mjs` | 3 | Whether any role's rule file changed, rework counts, and other corners the audit cannot see |
| `plugins/personal-inbox/request-watch.mjs`, `pending-ledger.mjs`; `scripts/automation/pending-decisions.mjs` | 3, 4 | The pending-decisions ledger and its back-fill |
| `plugins/personal-inbox/approval-reminder.mjs` | 3 | Reminds, a limited number of times, about approvals that expired unapproved |
| `scripts/automation/project-files.mjs` (core in `plugins/personal-inbox/project-files.mjs`) | 4, 6, 7 | Create projects and task records, register results, check entries, daily reconciliation |
| `scripts/automation/lead-free.mjs` | 4 | On creating a project, lets only the lead bot answer without a mention in that channel |
| `plugins/personal-inbox/delegation.mjs` | 4 | Only the system's own delegation is allowed |
| `plugins/personal-inbox/desktop-lock.mjs`, `sensitive-click.mjs`, `stuck-guard.mjs` | 4 | The Desktop operator's exclusive lock, confirmation of the six action classes, no driving the screen by command line, and help when stuck |
| `scripts/automation/quota-resume.mjs`; `plugins/personal-inbox/quota-recovery.mjs` | 4 | Records quota hits and continues the work after recovery |
| `scripts/automation/reset-notice.mjs` | 4 | Fixed notices before and after the daily session reset |
| `plugins/personal-inbox/audit-gate.mjs` | 5, 6 | Not submitted or not passed, a card cannot become done |
| `plugins/personal-inbox/audit-guard.mjs` | 5 | Auditor roles are read-only |
| `scripts/automation/day-watch.mjs` | 5 | Daytime watch: reconciles afterwards and starts the daily sampling scripts |
| `scripts/automation/command-spot-check-trigger.js` | 5 | Command sampling before the daily system audit |
| `scripts/automation/api-quota-gate.mjs`, `timed-reminders.mjs`, `quota-catchup.mjs` | 5 | Pause and resume of the system-audit jobs when credits run out, timed reminders, one rerun after a quota hit |
| `plugins/personal-inbox/completion-notice.mjs`, `small-job-notice.mjs`, `card-thread-map.mjs` | 6, 7 | A one-line record for closed cards and small jobs, with a reminder when the entry has not kept up; cards matched to threads |

For the builder's side, the repository includes two optional things under `builder-tools/`: a simplified cross-vendor review script (`builder-tools/cross-vendor-review/`) and the two writing and collaboration skills used when writing documents and designing how the bots work together (`builder-tools/skills/`).

Not in the repository, and currently small tools on the builder's own machine: the Coordinator's closing gate and record-writing tool, and the reminder hook after handing out work. The "program directory not writable" protection is a permission setting in the coding assistant; set it in yours. Without these, the matching steps fall back to the rule alone.

---

## 5. Steps that rest on rules only

Programs cannot do these. Write them into the rules, and have a person or an audit sample them afterwards:

1. Judging the reach (step 2).
2. Which entry counts as a conflict, and how to fix it (step 3).
3. Whether to audit, at which tier, and which class an audit conclusion falls in (step 5).
4. Choosing between fix, withdraw and roll back (step 5).
5. Judging right or wrong after reading the originals (step 6).
6. Deciding a detail directly or asking the owner.

One line to hold to when writing such rules: **a program may at most "remind once" or "check whether it was done". It does not judge for the model.** Let a program judge and it will only block by mistake.

---

## 6. What to change for your own setup

- What the owner is called, and what bots call each other.
- The language for speaking and for documents (see section 7).
- Which vendor's models you subscribe to, which tier each role uses, which vendor the auditor uses, and the fallback order.
- The pause line when quota is nearly used up.
- When each scheduled job runs and in which time zone ("daily" and "weekly" above follow your own routine).
- Channel and account IDs.
- Numbers such as the cap on batches in progress and reminder intervals.

All deployment-specific values are gathered in one configuration file. See [Configuration](configuration.md).

---

## 7. Changing language

These programs were first made in a Chinese-language setting, and several of them recognize fixed wording literally: the opening words of progress lines, section headings in task records, labels and headings on task cards, the first line of an audit report, markers the programs send, and the sensitive-word list used by the Desktop operator. Translating the documents alone is not enough; the wording the programs match has to change with them.

Where the repository stands today: a `locale` setting (`en` by default) switches the text on the reply card and which language version of the job prompts the auditor guard checks against. The fixed words the programs match (progress openers, card labels, report first lines, folder names) are still the Chinese ones whatever the locale; an English set exists in `plugins/personal-inbox/lexicon.mjs` as a draft and is not wired in yet. The bots can still talk to you in English, through the reply-language setting. The Desktop operator's sensitive-word list keeps both its English and Chinese sets active at all times because it is a safety gate. The full list of what switches, what does not, and what to add for a third language is in [Localization](localization.md).

A few terms and how they are meant:

- **Owner**: the person who decides.
- **Write-through**: what is said gets written into the record in the same turn.
- **Change plan**: the plan for a change, written before starting.
- **Audit classes ①②③**: must fix; stating the limit is enough; wording.
- **Request tiers**: just do it; ask once and follow the default when the time comes; always wait for the owner.

Some capabilities depend on the platform: screen operation, the system trash, local hooks and the audit-invocation tool were all made on macOS with one particular coding assistant. Treat them as one reference implementation of a general method.

Role-play is optional. Giving bots personas is one way to enjoy this, and everything works without them.
