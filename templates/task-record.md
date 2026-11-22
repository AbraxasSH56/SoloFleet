# 任务记录：{{任务标题}}

<!-- 模板说明开始 -->
Task record (English guide; the headings and labels stay Chinese on purpose). Usage: one Discord thread has one task record, kept in `项目/<project name>/任务/` (the project's "tasks" folder), named after the task's natural title. **Create it with the fixed command** (`new-task`, written in the shared rules): it fills this template and pre-fills the project name, thread link, the owner's words and so on. If the command fails, build the record by hand from this template and put one sentence of the reason in your report. The bot that carries out the task keeps its own task record; anything the owner says aloud is written into it in that same round.
This template is used with its Chinese literals unchanged: the section titles, the "状态：" line and the other Chinese literals are matched by the programs word for word. Do not translate or rename them. The English hints below, in angle brackets, explain what to write.
<!-- 模板说明结束 -->

## 目标

{{目标}}

## 主人原话

{{原话}}

## 当前状态

<English hint: after each stretch of work, edit the four lines below in place; do not append. The word after "状态：" must match how the thread's progress sentence starts: 完成 (done) / 进行中 (in progress) / 没跑成 (failed to run) / 等主人 (waiting for the owner) / 卡住 (stuck).>

状态：进行中 ｜ {{日期时间}}
一句话：{{执行者}}已接手，刚开始。
在等什么：无
什么时候再看：无

## 等主人拍板

<English hint (section "waiting for the owner to decide"): write "无" (none) if nothing is open. For a request, write the five lines shown in the comment below. When the owner has answered, change the result line to "已定：选 X，日期，消息链接" (decided: option X, date, message link) and carry on; a decision that lasts goes into the decision ledger via the Controller. While this section is open, do not send a second request about the same matter.>

无

<!-- English hint, the five lines to use when you ask (template note, not content):
问的是：<one sentence: what you ask>
选项：<1 ... (what you do next if chosen); 2 ...; 3 ...>
推荐：<option number and one-sentence reason>
问在：<date, message link>
结果：<还没回 (no answer yet)>
-->

## 下一步

<English hint (next step): what is done next, and by whom.>

## 成果位置

暂无

## 收尾清单

<English hint (close-out checklist): do every item before closing the task card as done, and change `[ ]` to `[x]` as you go. The commands below are the real commands; `<NODE_BIN>` and `<PROJECT_ROOT>` are the full path of Node and the project install location from your config.>

- [ ] 上面"当前状态"改成"完成"，写明做完了什么、哪些验证过 (set the status above to 完成 and say what was done and what was verified)
- [ ] "成果位置"写清（路径或链接） (fill in the result location: path or link)
- [ ] 把成果登记进项目入口 (register the result in the project entry; one command that changes only the "当前成果" table and the "当前状态" line of the entry; wrap the result name and the one-sentence note in single quotes):
  - 有成果文件（放在 `项目/{{项目名}}/成果/` 里）(result file kept in the project's results folder):
    `<NODE_BIN> <PROJECT_ROOT>/scripts/automation/project-files.mjs add-result --project {{项目名}} --name <result name> --path 成果/<file name> --note <one sentence>`
  - 成果不在项目文件夹里 (the result is outside the project folder, e.g. you changed code or config elsewhere): replace `--path 成果/<file name>` with `--outside '<one sentence saying where the result is>'`
  - 命令报错、跑不动 (the command fails): edit the project entry by hand, put one sentence about the error in your report, and do not block the task
- [ ] 结案之前先检查项目入口跟上没有 (before closing, check that the project entry is up to date):
  `<NODE_BIN> <PROJECT_ROOT>/scripts/automation/project-files.mjs check-project --project {{项目名}}`
  If `problems` in the result is not empty (for example a result is not registered), fix it first (use `add-result` above) and then close. If the command fails, look at the entry by hand and mention the error in your report. After closing, if the program's "完成记录" line in the channel ends with "提醒：" (reminder), the entry is not up to date yet: report that honestly and do not say the program gave no reminder.
- [ ] 本任务自己生成、没人引用的临时文件，按垃圾桶规矩处理 (temporary files this task created and nobody refers to: handle them by the trash rule in the shared rules)
- [ ] 线程里发"完成："进度句 (post the "完成：" progress sentence in the thread)

## 任务卡号

{{任务卡号}}

## Discord 线程链接

{{线程链接}}

<!-- 模板说明开始 -->
## The two blocks on the task card (written when the task-board card is created; the Controller writes them, other bots only read and never edit them)

A task-board card has no custom fields, so these two blocks live in the card's labels and body. When the card is created, write the start of the body in this format (the Chinese words are matched by the programs):

```
【审计级别】单审（任务审计） ｜ 主人确认于 <date>

【授权范围】
目标：<one sentence>
允许做的：<one item per line>
要主人确认的：<one item per line>
停止条件：<one item per line>
```

- There are only three audit levels: 单审（任务审计） (single audit by the task auditor), 单审（独立审计） (single audit by an independent auditor: a task audit done by another vendor's model, not the system audit) and 串联 (both in sequence). The label is written to match: `审计:单审任务审计`, `审计:单审独立`, `审计:串联`.
- When the level is raised or lowered, the Controller changes the label and the first body line, and writes one comment on the card: "审计级别：A → B，主人于 <date> 确认，原因：……" (audit level A to B, confirmed by the owner on the date, reason).
- The authorization scope is written when the owner approves the first plan. To widen it, the owner must confirm again; the Controller then edits this block and writes one comment. After a session reset, a bot reads this block from the card with `workboard_read` and carries on.

## Timed tasks (write this when something must be done at a set time)

Write two lines in the card body ("暂无" if there is none):

```
定时任务编号：<job id, or 暂无>
到点时间：<ISO time, or 暂无>
```

- The Controller writes these two lines after creating a one-shot scheduled job.
- The daytime watch uses these two lines to check whether the timed task ran and whether the work was really done (run status ok only means the run finished, not that the work was done).
<!-- 模板说明结束 -->
