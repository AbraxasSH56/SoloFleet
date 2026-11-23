# Task record: {{TASK_TITLE}}

<!-- template note begin -->
Usage: one Discord thread has one task record, kept in `projects/<project name>/tasks/`, named after the task's natural title. **Create it with the fixed command** (`new-task`, written in the shared rules): it fills this template and pre-fills the project name, thread link, the owner's words and so on. If the command fails, build the record by hand from this template and put one sentence of the reason in your report. The bot that carries out the task keeps its own task record; anything the owner says aloud is written into it in that same round.
Use the English words of this template exactly as written. The section titles, the "Status:" line and the other labels are the exact words the programs match. Do not rename them. The hints below, in angle brackets, explain what to write.
<!-- template note end -->

## Goal

{{GOAL}}

## Owner's words

{{OWNER_QUOTE}}

## Current status

<After each stretch of work, edit the four lines below in place; do not append. The word after "Status:" must match how the thread's progress sentence starts: Done / In progress / Did not run / Waiting on owner / Stuck.>

Status: In progress | {{DATETIME}}
One sentence: {{EXECUTOR}} has taken over and just started.
Waiting for: None
When to look again: None

## Waiting for the owner's decision

<Write "None" if nothing is open. For a request, write the five lines shown in the comment below. When the owner has answered, change the Result line to "Decided: option X, date, message link" and carry on; a decision that lasts goes into the decision ledger via the Controller. While this section is open, do not send a second request about the same matter.>

None

<!-- The five lines to use when you ask (template note, not content):
Asked: <one sentence: what you ask>
Options: <1 ... (what you do next if chosen); 2 ...; 3 ...>
Recommended: <option number and one-sentence reason>
Asked at: <date, message link>
Result: <No reply yet>
-->

## Next step

<What is done next, and by whom.>

## Result location

None yet

## Close-out checklist

<Do every item before closing the task card as done, and change `[ ]` to `[x]` as you go. The commands below are the real commands; `<NODE_BIN>` and `<PROJECT_ROOT>` are the full path of Node and the project install location from your config.>

- [ ] Set "Current status" above to Done, and say what was done and what was verified
- [ ] Fill in "Result location" (path or link)
- [ ] Register the result in the project entry (one command that changes only the "Current results" table and the "Current status" line of the entry; wrap the result name and the one-sentence note in single quotes):
  - Result file kept in `projects/{{PROJECT_NAME}}/outputs/`:
    `<NODE_BIN> <PROJECT_ROOT>/scripts/automation/project-files.mjs add-result --project {{PROJECT_NAME}} --name <result name> --path outputs/<file name> --note <one sentence>`
  - The result is outside the project folder (for example you changed code or config elsewhere): replace `--path outputs/<file name>` with `--outside '<one sentence saying where the result is>'`
  - The command fails: edit the project entry by hand, put one sentence about the error in your report, and do not block the task
- [ ] Before closing, check that the project entry is up to date:
  `<NODE_BIN> <PROJECT_ROOT>/scripts/automation/project-files.mjs check-project --project {{PROJECT_NAME}}`
  If `problems` in the result is not empty (for example a result is not registered), fix it first (use `add-result` above) and then close. If the command fails, look at the entry by hand and mention the error in your report. After closing, if the program's "Completion record:" line in the channel ends with "Reminder:", the entry is not up to date yet: report that honestly and do not say the program gave no reminder.
- [ ] Handle the temporary files this task created and nobody refers to by the trash rule in the shared rules
- [ ] Post the "Done:" progress sentence in the thread

## Task card ID

{{TASK_CARD_ID}}

## Discord thread link

{{THREAD_LINK}}

<!-- template note begin -->
## The two blocks on the task card (written when the task-board card is created; the Controller writes them, other bots only read and never edit them)

A task-board card has no custom fields, so these two blocks live in the card's labels and body. When the card is created, write the start of the body in this format (these English words are the exact words the programs match):

```
[Audit level] Single (task audit) | owner confirmed on <date>

[Authorization scope]
Goal: <one sentence>
Allowed: <one item per line>
Needs owner confirmation: <one item per line>
Stop conditions: <one item per line>
```

- There are only three audit levels: Single (task audit) (single audit by the task auditor), Single (independent audit) (single audit by an independent auditor: a task audit done by another vendor's model, not the system audit) and Chained (both in sequence). The label is written to match: `audit:single-task`, `audit:single-independent`, `audit:chained`.
- When the level is raised or lowered, the Controller changes the label and the first body line, and writes one comment on the card: "Audit level: A → B, owner confirmed on <date>, reason: …".
- The authorization scope is written when the owner approves the first plan. To widen it, the owner must confirm again; the Controller then edits this block and writes one comment. After a session reset, a bot reads this block from the card with `workboard_read` and carries on.

## Timed tasks (write this when something must be done at a set time)

Write two lines in the card body ("None yet" if there is none):

```
Timed job ID: <job id, or None yet>
Due time: <ISO time, or None yet>
```

- The Controller writes these two lines after creating a one-shot scheduled job.
- The daytime watch uses these two lines to check whether the timed task ran and whether the work was really done (run status ok only means the run finished, not that the work was done).
<!-- template note end -->
