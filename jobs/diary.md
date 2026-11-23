# Daily diary (once a day, Diary keeper role; run time follows the config `jobs.diary.time`)

> The words in code spans and quotation marks in these rules (status values, header lines, file names and the notification and chat sentences sent to the channel) are the exact words the programs and the other steps match; write them exactly as shown. The all-caps angle-bracket placeholders in the text (such as `<GUILD_ID>`, `<DIARY_CHANNEL_ID>`) are filled in once at deployment time; the placeholders `<DATA_ROOT>` (data root) and `<PROJECT_ROOT>` (project root) are taken from the task message on every run and must not be replaced. See `jobs/README.md` for details.

Applies to role: `diary`. This task is optional: if you do not need a diary, do not create this scheduled task. When enabled, it uses the API credit that comes with a subscription (if your subscription plan includes one; the model points to `anthropic-api/…`; for how to write the provider see `config/examples/api-credit-providers.example.json`), not the subscription.

## Parameters of this task
- Server ID: `<GUILD_ID>`
- Diary channel: `channel:<DIARY_CHANNEL_ID>` (the channel is named "diary")
- `<DATA_ROOT>`, `<PROJECT_ROOT>`: take the values only from the line in the task message that begins with "Path parameters:".
- Diary folder: `<DATA_ROOT>/projects/diary/`; output: `<DATA_ROOT>/projects/diary/outputs/`; project entry (including the "Channel permissions" table): `<DATA_ROOT>/projects/diary/PROJECT.md`.

## Business date (decided once at the start of the task, never changed afterwards)
- The day boundary is 04:00 every day (local time in the configured time zone `timezone`). From the moment of this run, find the most recent 04:00 in the early morning; **the business date is the day before it**; the range is 04:00 on the business date to 04:00 the next day. To change the day boundary, change the 04:00 in this section (the task run time follows the config `jobs.diary.time`; it is recommended to schedule it after the day boundary). Example: a run at 11-11 04:15 has business date 11-10, with range 11-10 04:00 to 11-11 04:00.
- For a manual make-up run, if the message states the business date, use the stated day.
- File name: `diary_YYYYMMDD.md`; YYYYMMDD is the business date.

## Use only these tools
Use only the tools this task gives you (read, write, edit, message, workboard_list, workboard_read); run no commands. For what the tools cannot do, record it as it is in the status line ("sources not fully read" / "self-check failed"); do not think of other ways around it, and do not write temporary files.

## Steps

### Step 0: First check whether this day's file exists
Read `outputs/diary_YYYYMMDD.md`:
- **Does not exist** -> start from step 1.
- Status "done" and notification "sent" -> do not touch it; say one sentence in the diary channel, "Owner, the diary for <BUSINESS_DATE> already exists", and finish.
- Status "done" and notification "not sent" -> do not rewrite the body. First use `message`, read-only, to look in the diary channel for a "generated" notification from this account (`diary`) for the same business date: if found -> only write that message's ID into the "Notification" line, and do not send again; if confirmed there is none -> jump to step 4 and send only the notification; if it cannot be determined (read failed, cannot page back to the bottom) -> do not send, keep the notification line at "not sent", say one sentence in the diary channel, "Owner, I cannot tell whether the notification for <BUSINESS_DATE> was sent, so I did not resend", and finish.
- Status "writing", "sources not fully read" or "self-check failed", or **no status line at all** -> this was left by a previous run; whether or not it looks like something you wrote, treat it as possibly edited by the owner:
  1. Do not change the original by a single character;
  2. First copy the original verbatim to `outputs/diary_YYYYMMDD-pre-rerun-<run time YYYYMMDDHHMMSS>.md` (before-rerun copy): before writing, read this path to confirm it does not exist; if it exists, append `-2`, `-3` ... at the end to switch to an unused name; after copying, read it back, and continue only if it matches the original; if it does not match, stop and say one sentence in the diary channel;
  3. Follow steps 1 to 3 to read the sources again and regenerate, and write to `outputs/diary_YYYYMMDD-to-merge-<run time>.md` (to-be-merged draft) (likewise first confirm the target does not exist; if the name is taken, switch to the next one);
  4. Send one sentence in the diary channel, "Owner, the diary for <BUSINESS_DATE> was not finished last time and the original was not touched; the copy is at <copy file name>, and the newly generated one this time is at <to-be-merged draft file name>; please decide how to merge them", **do not send the "generated" notification**, and finish.
- Only a draft that **you yourself just wrote in this round and have not yet handed over** (the one just written as "writing" in step 2 of this round) may be continued to completion and have its status line changed.
- For a diary with status "done", a rerun never overwrites the body.

### Step 1: Read the sources as the `diary` account, and record for each item whether it was read completely
1. **Channel list**: `message` with `channel list` (server `<GUILD_ID>`); record the count and IDs of all text channels you can see. Failure -> sources not fully read.
2. **List threads in two ways**:
   - Active threads: list them all at once with `thread list` (server ID);
   - Archived public threads: for each channel, run `thread list` (with the channel ID, including archived), and use the returned `nextBefore` as the `before` of the next page, paging on until the response says there is no next page; **the only case in which you may stop early**: the archive time of the latest thread on this page is already earlier than the start of the business date. **Do not exclude threads by creation time**: a thread created long ago may also have messages on that day.
   - You cannot see private threads; they are out of scope; say so as it is at the start of the file.
3. **Read messages page by page** (for every channel, every active thread, and every archived thread listed in the previous step):
   - Page only backwards with `before`; do not use `after` or `around`;
   - First page: `read`, target `channel:<ID>`, `limit 100`, without `before`;
   - Next page: use the **ID of the oldest message on this page** as `before`, `limit 100`;
   - Trimming: by each message's own actual time, keep only those between 04:00 on the business date and 04:00 the next day;
   - Stop: when the oldest message on this page is already earlier than the start of the business date; or when fewer than 100 are returned;
   - If any page errors -> sources not fully read;
   - **A channel whose first page is empty**: judge by the "Channel permissions" table in `PROJECT.md`. If both view and read-history are granted -> no messages that day; if not, if it cannot be determined, or if the channel is not in the table -> sources not fully read (do not try to work around it).
4. **Task cards**: `workboard_list`, including archived, `limit 200`; by the returned creation, update and archive times, pick the cards with activity within the business date (including those archived that day); for cards with no update time, run `workboard_read` on each. **If exactly 200 are returned -> the list may be incomplete -> sources not fully read.**
5. **Task records**: the task record files linked from the cards above (`<DATA_ROOT>/projects/*/tasks/…`), read with `read`.
- Do not read: other bots' workspaces and memory, Claude Code sessions, the owner's personal folders. Read only messages within the business date range and the cards that were touched that day.
- **Read completely** = items 1 to 5 all succeeded; every channel and every active and archived thread was paged to the stop condition; every channel with an empty first page has a conclusion from the permissions table; the task cards did not reach 200. Being able to read some messages does not count as read completely.

### Step 2: Write the file, first as "writing"
Write `outputs/diary_YYYYMMDD.md` (when step 0 took the rerun branch, write the to-be-merged draft):
- **The first three lines** (write these three header lines exactly as shown):
  - `Business date: YYYY-MM-DD (YYYY-MM-DD 04:00 to 04:00 next day) | generated at <time>`
  - `Sources: N channels, M1 active threads, M2 archived threads, K messages, J task cards; private threads out of scope; read completely: yes/no (not fully read: ...)`
  - `Status: writing | Notification: not sent`
- **Each body entry starts on its own line**: `- HH:MM <what happened> (source: <channel name> <message link> / card <ID> / <file path>)`
  - Write only things that have a record; do not make anything up; do not infer the owner's emotions or mental state (do not write things like "the owner seems tired");
  - Write the body plainly as events: who, when, what was done, the result; no twists, no putting anyone down, no fishing for sympathy;
  - If the same matter appears in several channels or threads, merge it into one entry with all sources listed; do not write again what was already written the previous day and had no new progress that day;
  - If nothing happened that day, write it short; one or two lines of "Nothing was recorded today" also count as a diary.
- **One self-check line at the end**: `Self-check: date ✓/✗, source ✓/✗, dedup ✓/✗`

### Step 3: Read back, self-check, change the status
- Read the file back and confirm it matches what you meant to write; check each entry one by one: the date is within the business date range, each entry has a source, and there are no duplicates.
- Sources read completely, read-back matches, all three items ✓ -> change the status to "done"; sources not fully read -> "sources not fully read"; any ✗ in the self-check -> "self-check failed (<which item>)".

### Step 4: Notification
- **Send only when the status is "done"**: use `message`, account `diary`, target `channel:<DIARY_CHANNEL_ID>`, and send one sentence: `Owner, the diary for <BUSINESS_DATE> has been generated, N entries in total, stored at projects/diary/outputs/diary_YYYYMMDD.md.` (You may add a little of your own tone, but do not write process talk like "let me read first"; do not name anyone; do not paste the full text.)
- After sending, change the "Notification" line to "sent (<message ID>)", then read it back.
- "sources not fully read": send only `Owner, the sources of the diary for <BUSINESS_DATE> were not fully read (<where>); this one does not count as an official diary and is to be re-run`; "self-check failed": send only `Owner, the self-check of the diary for <BUSINESS_DATE> did not pass (<which item>); this one does not count as an official diary and is to be re-run`. In neither case send the "generated" notification.
- If generation finished and only the notification cannot be sent: keep "done" + "Notification: not sent", and the next make-up run only sends the notification.

### Step 5: Finish

## Failure
- If you cannot write the file or cannot send a message: leave the status line and the notification line as they truly are (if you cannot write the file, leave nothing), and only say one sentence in the diary channel, "Owner, the diary for <BUSINESS_DATE> was not finished: <which step>", and do not say it in any other channel. The next make-up run continues per step 0.
- Saying "not generated" is a normal ending; the scheduler will not report it as a failure; the result is determined by the file's status line.
