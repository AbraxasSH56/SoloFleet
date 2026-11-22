# templates/

Starting texts that the programs and the roles copy. Placeholders written as `{{...}}` are filled in by `plugins/personal-inbox/project-files.mjs` and must not be renamed; angle-bracket text such as `<NODE_BIN>` is for you to fill in.

| What | Chinese (default, used with its Chinese literals unchanged) | English guide |
|---|---|---|
| Task record (one per Discord thread) | `任务记录.md` (the file name the program reads; same text as `task-record.zh-CN.md`) | `task-record.md` |
| Project entry (`PROJECT.md`) | `项目入口.md` (the file name the program reads; same text as `project-entry.zh-CN.md`) | `project-entry.md` |
| Decision ledger header | `decision-ledger-header.zh-CN.md` | `decision-ledger-header.md` |
| Rule change sheet header | `rule-change-sheet-header.zh-CN.md` | `rule-change-sheet-header.md` |
| Master index header (`INDEX.md`) | `index-header.zh-CN.md` | `index-header.md` |

The programs match the Chinese section titles and labels word for word (for example `当前状态`, `等主人拍板`, `当前成果`, the `状态：` line, `暂无（待写）`, the first table column `项目`). The English files therefore keep those literals and explain them in English hints; both versions work with the programs. Text between `<!-- 模板说明开始 -->` and `<!-- 模板说明结束 -->` is a usage note that the programs remove when they create a file.

# templates/（中文）

程序和各角色照着复制的起始文本。`{{...}}` 是 `project-files.mjs` 要替换的占位，不能改名；尖括号里的（如 `<NODE_BIN>`）由你自己填。程序读的文件名是 `任务记录.md` 和 `项目入口.md`，它们和 `*.zh-CN.md` 内容相同。
