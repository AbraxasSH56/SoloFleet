# templates/

Starting texts that the programs and the roles copy. Placeholders written as `{{...}}` are filled in by `plugins/personal-inbox/project-files.mjs` and must not be renamed; angle-bracket text such as `<NODE_BIN>` is for you to fill in.

| What | zh-CN | en |
|---|---|---|
| Task record (one per Discord thread) | A zh-CN deployment copies `任务记录.md` (same content as `task-record.zh-CN.md`; the program reads this file name) | An en deployment copies `task-record.md` into `templates/` under the data root |
| Project entry (`PROJECT.md`) | A zh-CN deployment copies `项目入口.md` (same content as `project-entry.zh-CN.md`; the program reads this file name) | An en deployment copies `project-entry.md` into `templates/` under the data root |
| Decision ledger header | `decision-ledger-header.zh-CN.md` | `decision-ledger-header.md` |
| Rule change sheet header | `rule-change-sheet-header.zh-CN.md` | `rule-change-sheet-header.md` |
| Master index header (`INDEX.md`) | `index-header.zh-CN.md` | `index-header.md` |

The programs take their words by `locale`. The English templates use English words and English placeholders (for example `Current status`, `Waiting for the owner's decision`, `Current results`, the `Status:` line, `None yet (to be written)`, the first table column `Project`). Text between `<!-- template note begin -->` and `<!-- template note end -->` is a usage note that the programs remove when they create a file.

# templates/（中文）

程序和各角色照着复制的起始文本。`{{...}}` 是 `project-files.mjs` 要替换的占位，不能改名；尖括号里的（如 `<NODE_BIN>`）由你自己填。程序读的文件名是 `任务记录.md` 和 `项目入口.md`，它们和 `*.zh-CN.md` 内容相同。
