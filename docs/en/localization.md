# Localization: what to change to run in another language

English | [简体中文](../zh-CN/localization.md)

The reference deployment was built in Chinese. The programs, the rule files and the folder layout therefore match some **Chinese literal words**. Translating the documents is not enough: this page lists every place that matches a literal, so you can decide.

## Current state

The shared rules, role heads, templates and job instructions are available in English and in Chinese (`*.zh-CN.md`). `locale` (`en` by default, or `zh-CN`) currently controls three things:

- the **text on the reply card** (model line, changed-files line, quota line) and the two replacement sentences for the fixed system messages, both fully in `lexicon.mjs` in English and Chinese;
- the **English-process-paragraph cleanup** (deleting English "thinking out loud" paragraphs in front of a Chinese reply): it was written for deployments whose rules say "always reply in Chinese", so it runs only when `locale` is `zh-CN` and is off for `en`;
- which language version of the **job-instruction snippets** the audit guard fingerprints (`jobs/*.md` or `jobs/*.zh-CN.md`).

What `locale` does **not** change yet: the literal words listed in section 1 (progress openers, card labels, report headers, folder names). `lexicon.mjs` has a draft English set for those, but **the programs still match the Chinese words directly**, whatever `locale` says. So:

- keep the Chinese literals as they are (the English rule files quote them);
- you can still have the bots talk to you in English: set `replyLanguage` (default `English`). The English rules tell the bots to reply in `{{REPLY_LANGUAGE}}` and to keep the literal Chinese words listed below when the programs need them (a progress sentence starts with `完成：`, for example);
- or use the Chinese rule files and reply language and nothing needs translating.

If you want a fully English deployment you must change the words in the code (list below) and in the rule/template/job files together, then update the tests. Each item names the file that matches it.

## 1. Words the programs match

| Group | Literal words (zh-CN) | Where matched |
|---|---|---|
| Progress-sentence openers | `完成：` `进行中：` `没跑成：` `等主人：` `卡住：` | `scripts/automation/daily-format-check.mjs` (`STATUS_HEADS`), rules |
| Task record layout | the status line `状态：`, sections `当前状态`, `等主人拍板`, `当前成果`, `暂无（待写）` | `plugins/personal-inbox/project-files.mjs`, `daily-format-check.mjs`, `templates/任务记录.md`, `templates/项目入口.md` |
| Task card labels | `【审计级别】`, `【授权范围】` and its four lines (`目标：` `允许做的：` `要主人确认的：` `停止条件：`), the comment form `审计级别：A → B`; the card's own label `审计:` (half-width colon) | `daily-format-check.mjs`, `audit-gate.mjs` |
| Audit level values | on the card **label** after `审计:`: `单审任务审计`, `单审独立`, `串联`; in the **first line of the card body** (`【审计级别】…`): `单审（任务审计）`, `单审（独立审计）`, `串联` | `audit-gate.mjs`, `templates/任务记录.md`, rule files |
| Submission sheet and report | first line `任务审计 <@id> 请审：…（第 N 次）`, `任务卡：`, `成果位置：`, `任务类型：`; report first line `我得：通过` / `我得：不通过（① N 项）` / `我得：审不了（这类内容审不了）`; audit thread title prefix `审计：` | `audit-gate.mjs`, `completion-notice.mjs`, rules |
| Desktop help | `【求助】`, `【求助回复】` | `stuck-guard.mjs`, `desktop-lock.mjs` |
| Ledger states | `收到` `已定` `撤销` `没回`, source `审批过期`, the auto-registration prefix `（程序补登记）`, `没截止` | `pending-ledger.mjs`, `pending-tools.mjs`, `request-watch.mjs` |
| Desktop queue skip reasons | `不用了` `完成` `被接手` (argument of `desktop-lock.mjs skip --why`) | `desktop-lock.mjs` |
| Quota resume | the opener `【额度恢复·程序代发】`, the closing-record tail `提醒：` | `quota-resume.mjs`, `completion-notice.mjs` |
| Decision ledger | the word `原话` (quote), field names in the pending list | `ledger-watch.mjs`, `daily-format-check.mjs` |
| Task names of the published summaries | `巡查` `异常深审` `周审` | `scripts/automation/publish-self.py`, `plugins/personal-inbox/audit-guard-rules.json` |

**Desktop sensitive words** (`plugins/personal-inbox/sensitive-words.json`) do not follow `locale`: Chinese and English words are always both active, because the list guards payments, sends, deletions and installs. Add words for your own interface language here; this is the item to review first when you change languages.

Not translated on purpose: the English error sentence of `claude -p` when a quota is used up (`quota-recovery.mjs` matches it as is).

## 2. Folder and file names

The data root uses Chinese names that the programs build paths from:

- project folders: `项目/<name>/{任务,成果,历史}`, entry `PROJECT.md`, task records in `任务/`; top files `INDEX.md`, `决定账本.md`, `模板/`, `垃圾桶/`;
- audit reports: `审计/{日审,周审,巡查,异常深审,异常标记,等你定,程序校验清单,发布/凭据}`;
- run records: `运行记录/{结案,守门,卡线程,请示待核,账本待补,API额度,额度,看护,格式抽查,盲区抽查,文件对账,英文清理原文,提醒}`;
- JSON state files use Chinese keys (for example `日期`, `标题`, `原话`, `状态` in the ledger waiting list).

They are created by the programs and the templates; you normally only meet them in the data root.

## 3. Command-line parameter names

Already English and not affected by `locale`: see [configuration.md](configuration.md), section 6.

## 4. Time zone and clock times

Not a language question but the other place that was fixed in the original: all dates come from `timezone` in `config/crew.json`; clock times inside scripts are listed in [configuration.md](configuration.md), section 5.

## 5. How the roles talk

Personas are optional ([roles.md](roles.md)). The rule files say "if a persona is configured, follow it", so a persona's catchphrases and the language they speak belong to the persona, not to the rules. The `replyLanguage` setting only controls the default language of replies.

## 6. A suggested way to localize

1. Pick the language of the bots' replies (`replyLanguage`); keep the Chinese literals as they are.
2. Add your sensitive button words to `sensitive-words.json`.
3. If you need the status words in your language, change them in the table in section 1 **together** in code, templates, rules and tests (search for the Chinese word; each word occurs in a small number of files), then run the whole test suite.
4. Tell us (an issue or a pull request) which words you changed; a real `en` word set in `lexicon.mjs` is the next step of this project.
