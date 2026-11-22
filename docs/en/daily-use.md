# Daily use

English | [简体中文](../zh-CN/daily-use.md)

This is what a day with the crew looks like from the owner's seat. It is written as a walk-through, because the design only makes sense in use.

## Morning: you say what you want

You open Discord and type in the **Workshop**, in plain words, to the Controller. No mention needed there.

- If it is something small and clear ("fix the typo in the title", "what did we decide about X?"), the Controller just does it, reads the result back, and tells you.
- If it is new and complicated, the Controller first says back what it understood: what you want, what the result will be, where it will be put, who it suggests for the work and how it should be audited. Then it asks whether to start.

You say yes once. That one yes covers the executor, the auditor and the steps of the plan. You are not asked again for each step.

What you said is written down in that same turn: into the records, and onto a task card if the work will continue. You will not need to say it twice.

## The work moves to a project channel

Each project has its own channel. Each task has a thread under it. The Controller sets these up and brings in the bots you agreed to.

From here on you can ignore the threads. If you want to add something, say it in the project channel's **main area**. The project's lead bot picks it up without being mentioned, takes it to the right thread, and comes back to the main area with the result. Other bots answer only when you mention them.

While a bot works, anything you send in its thread joins the turn it is in. If it is a correction to the current task, it is folded in. If it is a new matter, it is treated as a new matter.

Bots leave a short progress line after each stretch of work. Each line starts with one of five fixed openers, so both you and the evening patrol can skim them: done, in progress, didn't run, waiting on the owner, stuck. The daily check currently matches the Chinese openers literally (`完成：` `进行中：` `没跑成：` `等主人：` `卡住：`), whatever language the rest of the reply is in; see [Localization](localization.md).

## When a bot needs you

Most of the time it does not. Bots look things up, use sensible defaults and tell you afterwards which default they used.

When one does need you, the message is built so you can answer without remembering the background:

- one or two sentences on what this is about and why it is stuck;
- two or three numbered options, each with what will actually happen if you pick it;
- the bot's recommendation;
- what happens if you do not decide.

There are buttons, and only you can press them. You can also just type the number. Once you answer, the bot carries on; it does not ask "are you sure?".

While it waits, the bot keeps working on whatever does not depend on your answer, and prepares the option it recommended, as long as that preparation can be undone.

### Three tiers

How a bot behaves when you have not answered depends on which tier the matter is in. You approved the tiers in advance, so the bot does not decide by itself what counts as minor.

| Tier | What the bot does | Examples |
|---|---|---|
| **Just do it** | Does it and mentions it in the routine report | Archiving finished cards and threads; moving its own unused temp files to the project trash; picking an interrupted task back up by the approved method |
| **Ask once** | Asks, states the default and the time. If you have not answered by then, it does the default. If you later say "undo", it undoes it | Kept narrow on purpose. New kinds are added one at a time, by you |
| **Always wait** | Waits for you, however long | The six desktop action classes; spending money; bringing in new people or widening what is shared; deleting real data; changing direction, rules or permissions |

### The ledger

Everything in the "always wait" tier is logged on a **pending-decisions ledger**. A pinned summary in the Workshop lists each open item: what to decide, the recommendation, what it is blocking, the deadline, and a link back to the original request.

- You are mentioned once when the item is first raised.
- After that, open items are gathered into one reminder every few days, a few at a time, oldest first.
- If you say "I'll look at the weekend", you are left alone until then.
- "Got it" and "decided" are recorded separately.
- If a bot sent you a request with buttons and forgot to log it, a script logs it a little later.

This means you do not have to remember, and things are hard to lose. It cannot make you look. A matter only you can settle will stay open until you settle it.

## When the screen is involved

Only the **Desktop operator** touches the screen. Any bot that needs something done on the desktop mentions it in the thread where the need came up.

- If the screen is free, it starts. It says what it is about to do, does it, and posts the result with a screenshot.
- If the screen is busy elsewhere, it answers that the request is queued and how many are ahead. Nobody has to ask again; when the turn comes, the program calls the requester.
- Before any of six kinds of action (paying, sending something to an outside party, deleting permanently, submitting a form, uploading a file, installing software) it stops. It posts a screenshot, says what it is about to do, and an approval card appears in the **Approval channel**.

Only your own click on the card lets that one action through. A form can be filled in ahead of time; the submit waits for you. If you do not get to the card in time, it expires. That is not counted as a refusal: the matter moves to the ledger, you are reminded before it lapses, and if you say "go ahead" later, a fresh card is issued.

When it has finished, the Desktop operator moves the windows it opened back where they belong and leaves your own windows alone.

More in [Safety](safety.md).

## When work is finished

A worker that finishes checks its own result, then asks for audit. The Controller opens an audit thread; the Task auditor reads the result files against your words and the acceptance criteria and posts a verdict.

- **Pass**: the worker completes the card, and a program confirms the audit and that nothing changed since.
- **Fail**: the worker gets a list of problems and reworks once. If it fails a second time, it comes to you.

Either way, whoever took your request reports the result in the main area, in their own words: what was done and what came of it. If the card is not closed yet, they say so. A one-line completion record follows automatically once it is.

Small jobs that were done in one turn get no card and no audit. They are simply reported.

## Evening: one report

Once a day the Controller patrols. It reads the day's system audit, skims the progress lines across all projects, and gives you one report in the Workshop:

- what moved in each project, who it was given to, who was brought in;
- what is waiting on you;
- what the system audit found, if anything.

That is the only routine message of the day. If the audit recorded something serious, a separate deep-review note follows. Ask "where are we?" at any time and you get the same sweep on the spot.

## Overnight: sessions reset

Sessions are cleared once a day, at a time you are not using them. A fixed notice is posted before and after.

The next morning you can say "continue" in a task thread. The bot reads the task record and the authorized scope on the card, says where it left off, and carries on. You can also ask in a project channel "what did I tell you yesterday?" and get the right answer, read from the project entry.

## When the quota runs out

If a bot hits the subscription limit in the middle of something, its turn fails and a short vendor error shows in the thread. A script records it. After the limit resets, the script wakes the same session. The bot first checks what it had already done, states it, and continues without redoing or resending anything. If you have already picked the thread up yourself, the script stays out of it.

The scheduled audits that run on included API credits behave differently: when the credits are gone they pause quietly instead of failing every day, and start again when credits return.

## Stopping things

- `/stop` halts the current turn of the current session. It does not undo files already written or messages already sent.
- To stop the Desktop operator at once, pick its own stop command from Discord's slash menu. To stop it gently, mention it and say "stop"; it will tidy up and release the screen.

## The Lounge

The Lounge is for talking. Mention a bot there and it opens a thread and chats with you. It will answer questions and look things up, and it will not change project files, operate the desktop or start long jobs.

If the chat turns into something that should be done properly, the bot says "this should be a project" and does nothing further. Say the word, mention the Controller, and it reads the whole thread, restates the task and sets the project up.

## What you do not have to do

- Relay messages between bots. They mention each other.
- Open threads to follow progress. Results come to the main area and the evening report.
- Remember what is waiting on you. The ledger does.
- Re-explain after a reset. The records do.
- Check the bill in a console. The card under each reply shows the model, the pool and the files changed.
- Wonder whether "done" means done. A card cannot close without an audit.
