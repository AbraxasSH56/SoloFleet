# 决定账本

(Decision ledger. The title and the labels stay Chinese because the programs read them; the English hints explain them.)

This ledger holds only the owner's decisions and the things decided NOT to be done. Decisions inside one project go in that project's `PROJECT.md`, not here.
Created: <YYYY-MM-DD>. Only the Controller writes; every bot reads.
Each entry has: title, date and scope, the owner's own words (if there are no verbatim words, write "转述，出处：……", meaning "paraphrase, source: ..."), and what it replaces. The 【授权范围】 block of a task card may say "依据 D-xxx" (based on D-xxx).
Always write models as aliases such as "latest Opus / Sonnet", never as version numbers; which version each alias means now is in the model table in your configuration.
An old approval does not turn into a standing permission by itself.
A quote marked "转录" (transcribed) was copied from a decision record and was not checked against the original message.

Entry format (the programs check it: the title line is `### D-<three-digit number> <title>`, each entry needs a "日期：" (date) line and an "原话：" (the owner's words) line, and numbers run without gaps):

```
### D-001 <title>
日期：YYYY-MM-DD；适用范围：<which tasks or roles>
原话：<the owner's words, verbatim; if none, 转述，出处：……>
取代关系：<无 (none), or 取代 D-0xx (replaces D-0xx)>
```

## 一、有效的决定

## 二、已被取代的决定

---
