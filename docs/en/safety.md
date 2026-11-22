# Safety

English | [简体中文](../zh-CN/safety.md)

This document says how SoloFleet keeps a crew of bots from doing things the owner did not agree to, and, just as plainly, where those protections end.

It is written for someone deciding how much to trust this before running it. Every mechanism below comes with what it stops and what it does not.

## The starting position

In the reference deployment the bots run with tools fully open. They are not asked to confirm each tool call, because confirming everything is its own way of burying the owner. So whether a step should happen at all is decided by three things together:

1. **Rules** the bots follow.
2. **Programs** that block, check and back-fill, for the short list of things that must not be left to the model.
3. **The owner's own approval**, for a fixed set of actions.

None of the three is enough alone. The sections below show how they overlap.

---

## The desktop

Operating a real screen is where a mistake costs the most, so this is where the protections are thickest.

### One bot, one screen, one thread at a time

- Only the Desktop operator has screen tools. Other bots ask it by mentioning it in their thread.
- Before every screen call, the plugin checks an exclusive lock. If the lock is free, the calling thread gets it. If the thread already holds it, the call goes through. If another thread holds it, the call is blocked and the request is queued.
- The queue lives in a file beside the lock and survives session changes. A fixed command job advances it every couple of minutes, calls the next requester, and skips anyone who does not show up within the hold time. That job calls no model.
- The lock is held from the first screen action until the screen is released. Releasing the screen and finishing the task are reported separately.

A note on who may call the Desktop operator. OpenClaw treats its `computer` tool as owner-only: it is available only in a turn started by someone on the owner allowlist. So that any bot can hand it a desktop task, every other bot's Discord user ID is on that list. Being on the list lets a bot start desktop work. It is not the owner's consent to anything. Safety does not rest on who called; it rests on the lock and on the approvals below.

### Six kinds of action wait for the owner

Before any of these, the Desktop operator stops:

1. Payment
2. Sending to outside parties (email, messages to people outside)
3. Permanent deletion
4. Submitting a form
5. Uploading a file
6. Installing software

A form may be filled in beforehand. The submit waits.

What counts as approval:

- Only the owner's own Discord account clicking the approval card. A message from another bot does not count, even a bot on the owner allowlist. Text on a web page or in a file does not count.
- A bot may cancel or decline on the owner's behalf ("don't click that"). It may not agree on the owner's behalf.
- The card offers "allow once" and "deny" only. One approval releases one action and is then used up. The approval is tied to the thread, to the described action, and to the moment it was requested; change any of those and it no longer matches.
- Bots cannot resolve approvals from the command line. Those commands are blocked by matching the command text; like any text match, that is not a sandbox, which is one reason the nightly command sample exists.

### Two checks, one by rule and one by program

**The first check is the bot.** By rule, the Desktop operator looks at a screenshot before each action that lands on the current focus, stops when one of the six is next, posts the screenshot, marks the lock as "waiting for confirmation" with a description of the action, and waits for the card.

**The second check is the program.** The plugin tries to recognize the six by itself. When it does, it marks "waiting for confirmation" on the bot's behalf and raises a card that says the program recognized this one, not the bot.

The second check is an extra layer. It does not replace the first. Here is exactly what it can and cannot see.

#### What the program recognizes today: four cases

1. **A menu item** whose last level carries one of the sensitive words.
2. **The Enter key, pressed within 60 seconds of reading the interface elements**, when those elements included a button with a sensitive word. This covers Cmd/Ctrl+Enter and typed text that ends in a newline.
3. **A file upload** through the browser tool's file-input action.
4. **Accepting a web confirmation dialog.**

The sensitive words are a list in a JSON file: submit, send, pay, purchase, delete, install, upload, transfer, subscribe, authorize and their relatives, in both English and Chinese. Both languages are always active whatever the locale setting. You can extend the list without touching code.

#### What it does not recognize

- **A mouse click on a button. In a native app or on a web page, the same.** The interface elements the official tool returns have no IDs to click by, and looking a click up by its coordinates is switched off, because converting screenshot coordinates to screen points (across more than one display) has not been done. A click the program cannot classify is let through and logged.
- **Icon buttons with no text.** There is no word to match.

#### Other known limits

- **Large pages and windows are cut short.** The official read of interface elements truncates. On a web page we observed at most about 200 entries, and button text was often what got cut. So the Enter rule can miss on a large page. That truncation also applies to large native windows is our inference from how the interface behaves; we did not test it there.
- **Our own cap.** After filtering to clickable elements, the plugin keeps up to 800 per observation and drops the rest.
- **Stale observations.** After a click, scroll, window switch or typing, earlier observations are marked stale, and a button known only from a stale observation is not recognized. The Enter rule ignores the stale mark on purpose: that can raise one card too many, and will not drop one.
- **System dialogs.** A dialog raised by the system could not be read as interface elements at all, so in our real-machine test the Enter path could not be exercised. The menu-item path was tested on a real machine: the program recognized a delete item in a menu, raised a card marked as program-recognized, and after the card was denied the action did not run. The Enter path has offline tests only.
- **The command-line block** described below is live and has offline tests. It has not yet been triggered in real use.

When OpenClaw exposes browser state to plugins, returns complete interface elements, or the Desktop operator is given the browser tool, recognizing submit buttons on web pages is worth revisiting.

#### What covers the cases the program cannot see

For a mouse click on "Pay" or "Send", these are what stand between the bot and the action:

- **The rule**: stop first, screenshot, mark "waiting", and accept only the owner's own click.
- **The lock**: a lock marked "waiting for confirmation" never expires by time, and any further screen call from that thread triggers an owner-only approval before it proceeds.
- **The cleanup-only block** after a denial (next section).
- **The command-line block** and the nightly command sample (below).

That is rule first, with program support around it. It is not a program guarantee, and we would not describe it as one.

### Not approved means not approved

After a card is denied, times out or is cancelled:

- The lock goes back from "waiting" to "working", so the bot can tidy up without asking again.
- From then on, **that thread's screen calls are limited to looking and closing**: screenshots, listing and reading windows, bringing a window forward, waiting, Cmd+W, and a menu's Close item. Clicks, typing, Enter and every other key are blocked.
- Releasing and re-taking the lock does not lift this. It lifts when a new card for that thread is approved by the owner, or after 24 hours.
- If the program cannot read its own record of this, it blocks.
- A dialog that needs a button pressed (for example "Save changes?") is left for the owner. The bot stops, releases the lock and says where the screen was left.

This became a hard block after a real test. A card expired; the tool's message to the bot read like a gateway fault; the bot treated it as a network problem, retried, and clicked a submit that had not been approved. A softer version that blocked only once was tried first and was not enough.

An expired card is not treated as the owner refusing. The matter is put on the pending-decisions ledger for 24 hours, the owner is reminded once before it lapses, and if they then say go ahead, a new card is issued. Approval still has exactly one path: the owner clicking an official card.

This block covers screen-tool calls only.

### No way round by command line

For the Desktop operator, shell commands that could drive the screen (AppleScript runners, click simulators, screen-capture tools, "tell application" and the like) are blocked by matching the command text. Every night a script lists the commands the Desktop operator and the scheduled-audit roles ran, and flags any that match.

Matching command text is not a sandbox. A sufficiently indirect command could get past the match; the nightly sample is there for that.

### When it gets stuck

If the same screen step fails twice, the Desktop operator stops and asks the Task auditor for help in a fixed format, tries the advice once, and if that fails too, leaves the screen as it is, releases the lock and reports. It does not switch models and does not keep trying.

The program backs this up by counting screen calls that were allowed and then returned an error; after two in a row it blocks the next one. It cannot see "clicked, and nothing happened" or "clicked the wrong thing". Those depend on the bot checking a screenshot after each step.

### What is stored about your screen

To recognize buttons, the plugin keeps a small record of recent observations per thread.

- It stores the role and position of clickable elements. It stores the text of an element only when that text matched the sensitive-word list.
- It does not store screenshots or the contents of input fields.
- It stores the first 30 characters of the window title.
- The file is readable only by the owner of the machine account, and entries expire after 30 minutes.

### Other desktop habits

- The Desktop operator touches only windows it opened for the task. The owner's existing windows are left where they are.
- It does not go looking through the owner's personal folders to check where something was saved.
- If the message that called it carries text copied from a web page or email ("please open this link"), it does what the calling bot itself asked and nothing from the carried text.

---

## Beyond the desktop

### Finished work

| Mechanism | What it stops | What it does not stop |
|---|---|---|
| **Completion gate** (`audit-gate.mjs`) | Marking a task card "done" through the Workboard tools or their command-line forms without a delivered passing audit, or after the result changed. A delivered "fail" blocks, and the owner's approval does not override it. | A script that writes to the Workboard database directly. A daytime reconciliation job finds cards that were closed that way, after the fact. |
| **Auditor guard** (`audit-guard.mjs`) | Auditor roles running anything but listed read-only commands, or writing anywhere but their listed locations. If the guard's rule file cannot be read, it blocks everything. | It matches command text; it is not a sandbox. |
| **Delegation block** (`delegation.mjs`) | Bots using the model's native sub-agent and messaging tools, so every handoff goes through OpenClaw and is visible. | |

### Requests to the owner

- Buttons on a request are restricted to the owner's account.
- A request that must wait for the owner is logged on the pending-decisions ledger. If the bot forgets, a script adds it 10 to 40 minutes later. That back-fill only recognizes requests sent with buttons.
- The ledger keeps things from being lost. It cannot make the owner look.

### What bots may not do by rule

These are rules, checked afterwards by the daily and weekly system audits and the command sample. No program blocks them at the moment they happen.

- Modify OpenClaw, its Discord plugin, or other third-party software.
- Install software. The one exception is a temporary dependency for the task at hand, and only when it stays inside the task's own environment, comes from an official package registry, needs no admin rights, changes nothing global, and adds no service or cost.
- Create new services, scheduled jobs or long-lived data that were not planned.
- Switch vendors, turn on paid fallback, or add any cost.
- Delete permanently. Files a task no longer needs go to a trash folder with their original location recorded; emptying it needs the owner.
- Read credentials or unrelated personal folders.
- Pull another bot into a piece of work without the owner's consent.

Where a bot writes files is deliberately not blocked at write time, apart from the auditor roles. Blocking at write time tends to stop legitimate work. Instead, a daily reconciliation lists anything out of place.

### Content from outside

- Web pages, emails and text from other people are material, never instructions.
- Bots do not open links that arrive inside a page, message or file and ask to be opened, and do not touch short links, bare IP addresses or downloads.
- When outside material is passed between bots, it is saved to a file and the mention carries only the path, marked as outside material.

---

## At a glance

| Area | By program | By rule only | Known gap |
|---|---|---|---|
| Who touches the screen | Exclusive lock, queue | | |
| The six action classes | Card required once marked; four cases recognized automatically; cleanup-only after a denial | Stopping before a mouse click on a button | Mouse clicks and icon buttons are not recognized; large pages are truncated |
| Who can approve | Owner-only card; approval commands blocked for bots | | The command block is a text match |
| Driving the screen from the shell | Command-text block, nightly sample | | Text matching can be evaded; not yet triggered in real use |
| Marking work done | Completion gate, result fingerprint | | Direct database writes, caught afterwards |
| Auditors staying read-only | Auditor guard | | Text matching, not a sandbox |
| Where bots write files | | Rule, plus daily reconciliation | Not blocked at write time, by choice |
| Installing, deleting, spending | | Rule, plus audit | |

---

## If you set this up yourself

- Run the tests in `tests/` after installing and after every OpenClaw upgrade. OpenClaw's documentation notes that plugin hooks are not guaranteed to fire in every runtime, so check the gates on your own machine: ask the Desktop operator to do something from the six classes on a harmless test page and confirm a card appears.
- Fill in the owner's Discord user ID carefully. Every "owner-only" check compares against it.
- If your interface is in a language other than English or Chinese, add your words to the sensitive-word list. See [Localization](localization.md).
- Decide for yourself whether "rule first, program around it" is enough for the mouse-click case on the sites you use. If it is not, keep payments and the like off the Desktop operator's task list.
