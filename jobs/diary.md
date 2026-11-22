# Daily diary (每日日记) (once a day, Diary keeper role; run time follows the config `jobs.diary.time`)

> These rules are used together with their Chinese literals unchanged. The all-caps angle-bracket placeholders in the text (such as `<GUILD_ID>`, `<DIARY_CHANNEL_ID>`) are filled in once at deployment time; the Chinese placeholders such as `<资料根>` (data root) and `<项目根>` (project root) are taken from the task message on every run and must not be replaced. The programs and other steps still match Chinese literal strings, so the status values, header lines, file names and the notification and chat sentences sent to the channel are kept in Chinese, with an English gloss in parentheses (or after them); send the Chinese sentences exactly as written, not the English gloss. See `jobs/README.md` for details.

Applies to role: `diary`. This task is optional: if you do not need a diary, do not create this scheduled task. When enabled, it uses the API credit that comes with a subscription (if your subscription plan includes one; the model points to `anthropic-api/…`; for how to write the provider see `config/examples/api-credit-providers.example.json`), not the subscription.

## Parameters of this task
- Server ID: `<GUILD_ID>`
- Diary channel: `channel:<DIARY_CHANNEL_ID>` (the channel is named "日记" (diary))
- `<资料根>`, `<项目根>`: take the values only from the line in the task message that begins with "路径参数：" (path parameters:).
- Diary folder: `<资料根>/项目/日记/`; output: `<资料根>/项目/日记/成果/`; project entry (including the "频道权限" (channel permissions) table): `<资料根>/项目/日记/PROJECT.md`.

## Business date (decided once at the start of the task, never changed afterwards)
- The day boundary is 04:00 every day (local time in the configured time zone `timezone`). From the moment of this run, find the most recent 04:00 in the early morning; **the business date is the day before it**; the range is 04:00 on the business date to 04:00 the next day. To change the day boundary, change the 04:00 in this section (the task run time follows the config `jobs.diary.time`; it is recommended to schedule it after the day boundary). Example: a run at 11-11 04:15 has business date 11-10, with range 11-10 04:00 to 11-11 04:00.
- For a manual make-up run, if the message states the business date, use the stated day.
- File name: `日记_YYYYMMDD.md` (diary_YYYYMMDD.md); YYYYMMDD is the business date.

## Use only these tools
Use only the tools this task gives you (read, write, edit, message, workboard_list, workboard_read); run no commands. For what the tools cannot do, record it as it is in the status line (来源未读全 (sources not fully read) / 自检未过 (self-check failed)); do not think of other ways around it, and do not write temporary files.

## Steps

### Step 0: First check whether this day's file exists
Read `成果/日记_YYYYMMDD.md` (output/diary_YYYYMMDD.md):
- **Does not exist** -> start from step 1.
- Status "完成" (done) and notification "已发" (sent) -> do not touch it; say one sentence in the diary channel, "主人，<业务日期> 的日记已经有了" (Owner, the diary for <business date> already exists), and finish.
- Status "完成" and notification "未发" (not sent) -> do not rewrite the body. First use `message`, read-only, to look in the diary channel for a "已生成" (generated) notification from this account (`diary`) for the same business date: if found -> only write that message's ID into the "通知" (notification) line, and do not send again; if confirmed there is none -> jump to step 4 and send only the notification; if it cannot be determined (read failed, cannot page back to the bottom) -> do not send, keep the status line at "未发", say one sentence in the diary channel, "主人，<业务日期> 的通知查不清有没有发过，没重发" (Owner, I cannot tell whether the notification for <business date> was sent, so I did not resend), and finish.
- Status "写入中" (being written), "来源未读全" or "自检未过", or **no status line at all** -> this was left by a previous run; whether or not it looks like something you wrote, treat it as possibly edited by the owner:
  1. Do not change the original by a single character;
  2. First copy the original verbatim to `成果/日记_YYYYMMDD-重跑前副本-<本次运行时刻YYYYMMDDHHMMSS>.md` (before-rerun copy; <this run's time YYYYMMDDHHMMSS>): before writing, read this path to confirm it does not exist; if it exists, append `-2`, `-3` ... at the end to switch to an unused name; after copying, read it back, and continue only if it matches the original; if it does not match, stop and say one sentence in the diary channel;
  3. Follow steps 1 to 3 to read the sources again and regenerate, and write to `成果/日记_YYYYMMDD-待合并-<本次运行时刻>.md` (to-be-merged draft) (likewise first confirm the target does not exist; if the name is taken, switch to the next one);
  4. Send one sentence in the diary channel, "主人，<业务日期> 的日记上次没生成完，原件没动；副本在 <副本文件名>，这次新生成的放在 <待合并稿文件名>，怎么合并请您定" (Owner, the diary for <business date> was not finished last time and the original was not touched; the copy is at <copy file name>, and the newly generated one this time is at <to-be-merged draft file name>; please decide how to merge them), **do not send the "已生成" notification**, and finish.
- Only a draft that **you yourself just wrote in this round and have not yet handed over** (the one just written as "写入中" in step 2 of this round) may be continued to completion and have its status line changed.
- For a diary with status "完成", a rerun never overwrites the body.

### Step 1: Read the sources as the `diary` account, and record for each item whether it was read completely
1. **Channel list**: `message` with `channel list` (server `<GUILD_ID>`); record the count and IDs of all text channels you can see. Failure -> 来源未读全 (sources not fully read).
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
   - If any page errors -> 来源未读全;
   - **A channel whose first page is empty**: judge by the "频道权限" table in `PROJECT.md`. If both view and read-history are granted -> no messages that day; if not, if it cannot be determined, or if the channel is not in the table -> 来源未读全 (do not try to work around it).
4. **Task cards**: `workboard_list`, including archived, `limit 200`; by the returned creation, update and archive times, pick the cards with activity within the business date (including those archived that day); for cards with no update time, run `workboard_read` on each. **If exactly 200 are returned -> the list may be incomplete -> 来源未读全.**
5. **Task records**: the task record files linked from the cards above (`<资料根>/项目/*/任务/…`), read with `read`.
- Do not read: other bots' workspaces and memory, Claude Code sessions, the owner's personal folders. Read only messages within the business date range and the cards that were touched that day.
- **Read completely** = items 1 to 5 all succeeded; every channel and every active and archived thread was paged to the stop condition; every channel with an empty first page has a conclusion from the permissions table; the task cards did not reach 200. Being able to read some messages does not count as read completely.

### Step 2: Write the file, first as "写入中"
Write `成果/日记_YYYYMMDD.md` (when step 0 took the rerun branch, write the to-be-merged draft):
- **The first three lines** (these three header lines are literal; keep them in Chinese; glosses are given after each):
  - `业务日期：YYYY-MM-DD（YYYY-MM-DD 04:00 至次日 04:00）｜生成于 <时刻>` (business date: YYYY-MM-DD (YYYY-MM-DD 04:00 to 04:00 next day) | generated at <time>)
  - `来源：频道 N 个、活跃线程 M1 个、归档线程 M2 个、消息 K 条、任务卡 J 张；私有线程不在范围内；读全：是／否（没读全的：……）` (sources: N channels, M1 active threads, M2 archived threads, K messages, J task cards; private threads out of scope; read completely: yes / no (what was not fully read: ...))
  - `状态：写入中｜通知：未发` (status: being written | notification: not sent)
- **Each body entry starts on its own line**: `- HH:MM <发生了什么>（出处：<频道名> <消息链接> ／ 卡 <编号> ／ <文件路径>）` (- HH:MM <what happened> (source: <channel name> <message link> / card <number> / <file path>))
  - Write only things that have a record; do not make anything up; do not infer the owner's emotions or mental state (do not write things like "the owner seems tired", i.e. "主人似乎很累");
  - Write the body plainly as events: who, when, what was done, the result; no twists, no putting anyone down, no fishing for sympathy;
  - If the same matter appears in several channels or threads, merge it into one entry with all sources listed; do not write again what was already written the previous day and had no new progress that day;
  - If nothing happened that day, write it short; one or two lines of "今天没有记录到的事" (nothing was recorded today) also count as a diary.
- **One self-check line at the end**: `自检：日期 ✓／✗，出处 ✓／✗，去重 ✓／✗` (self-check: date ✓/✗, source ✓/✗, dedup ✓/✗)

### Step 3: Read back, self-check, change the status
- Read the file back and confirm it matches what you meant to write; check each entry one by one: the date is within the business date range, each entry has a source, and there are no duplicates.
- Sources read completely, read-back matches, all three items ✓ -> change the status to "完成"; sources not fully read -> "来源未读全"; any ✗ in the self-check -> "自检未过（<哪一项>）" (self-check failed (<which item>)).

### Step 4: Notification
- **Send only when the status is "完成"**: use `message`, account `diary`, target `channel:<DIARY_CHANNEL_ID>`, and send one sentence: `主人，<业务日期> 的日记已生成，共 N 条，存在 项目/日记/成果/日记_YYYYMMDD.md。` (Owner, the diary for <business date> has been generated, N entries in total, stored at 项目/日记/成果/日记_YYYYMMDD.md.) (You may add a little of your own tone, but do not write process talk like "let me read first", i.e. "我先读一下"; do not name anyone; do not paste the full text.)
- After sending, change the "通知" line to "已发（<消息编号>）" (sent (<message ID>)), then read it back.
- "来源未读全": send only `主人，<业务日期> 的日记来源没读全（<哪一处>），这份不算正式日记，待补跑` (Owner, the sources of the diary for <business date> were not fully read (<where>); this one does not count as an official diary and is to be re-run); "自检未过": send only `主人，<业务日期> 的日记自检没过（<哪一项>），这份不算正式日记，待补跑` (Owner, the self-check of the diary for <business date> did not pass (<which item>); this one does not count as an official diary and is to be re-run). In neither case send the "已生成" notification.
- If generation finished and only the notification cannot be sent: keep "完成" + "通知：未发", and the next make-up run only sends the notification.

### Step 5: Finish

## Failure
- If you cannot write the file or cannot send a message: leave the status line and the notification line as they truly are (if you cannot write the file, leave nothing), and only say one sentence in the diary channel, "主人，<业务日期> 的日记没生成完：<哪一步>" (Owner, the diary for <business date> was not finished: <which step>), and do not say it in any other channel. The next make-up run continues per step 0.
- Saying "not generated" is a normal ending; the scheduler will not report it as a failure; the result is determined by the file's status line.
