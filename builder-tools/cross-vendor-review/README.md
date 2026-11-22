# Cross-vendor review (example)

[中文](README.zh-CN.md)

A small, generic example of a wrapper that runs **another vendor's command-line audit tool in read-only mode** on your work, with guard rails. It is optional and is not used by the SoloFleet runtime.

## Why it exists

The development process asks for at least one audit that comes from a different vendor than the model that wrote the work. A model tends to share blind spots with its own family; a second family catches different mistakes. Calling that second tool by hand each time is easy to get wrong (forgetting to restrict it, forgetting to ask for evidence, letting it write into the repo). This wrapper makes the safe way the default.

## What it does

`review.py` (Python 3, standard library only):

1. **Checks the deny list before it runs.** The deny list is a text file of paths the auditor must never read. The script walks the working tree and stops (exit 4) if any secret-looking file is not covered: by name (`.env`, `*.pem`, `*secret*` ...), by permissions (owner-only files), by content (private key blocks, token-like strings; only the file name and kind are printed, never the matched text) or because it is too large to scan. Symlinks pointing outside the folder are flagged too.
2. **Appends three standard paragraphs** to your instruction if it does not already contain them:
   - every conclusion must come with its evidence (file and line, command and output);
   - grade each finding in three classes: **Class 1** must fix, **Class 2** writing down the boundary is enough, **Class 3** wording fix; only Class 1 blocks the next step;
   - never run dangerous version-control commands (`git clean`, `git reset --hard`, discarding `checkout`/`restore`, `stash`, `commit`, `push`, or anything that writes).
3. **Runs the audit tool** with a time limit. The tool's final message is taken as the report.
4. **Checks the result.** It compares the working tree before and after (modification times, and `git status` if the folder is a git repository) and warns if anything changed outside the report folder (exit 6). It checks that the report has an overall verdict and grading labels; if not, the report is still saved but starts with an INCOMPLETE banner (exit 7).
5. **Writes the report only inside `REPORT_DIR`.** The path is resolved first; symlinks and paths outside the folder are refused. An existing report is only overwritten with `--replace`, and the old one is copied to `REPORT_DIR/.replaced/` first.

## What you must set up

| Placeholder | Meaning |
|---|---|
| `<AUDIT_CLI>` | The command line of your other-vendor audit tool, in its read-only / no-write mode. **The example command in `review.py` (`AUDIT_CMD`) is not a real tool.** Replace it with your tool's real flags. The script refuses to run while `<AUDIT_CLI>` is still there. |
| `<REPORT_DIR>` | The only folder reports may be written to (`REPORT_DIR`). |
| `<DENY_LIST_FILE>` | Your deny list, one path or glob per line (`DENY_LIST_FILE`). See `deny-list.example.txt`. |

Optional: `AUDIT_WORKDIR` (folder to audit, default: current folder), `AUDIT_TIMEOUT_SEC`, `AUDIT_APPEND_LANG` (`en` or `zh`), and `AUDIT_CLI_CONFIG` + `AUDIT_CLI_CONFIG_SHA256` (your audit tool's own settings file and its expected hash; the script checks it is unchanged before and after the run).

**Important:** this script is a guard rail, not a sandbox. The real read-only guarantee must come from your audit tool's own permission settings. Make that tool deny writes and deny reading everything on the deny list, and use the same list here so the script can check coverage. Test the setup with harmless dummy files first.

## Usage

```bash
export AUDIT_WORKDIR=/path/to/the/repo
export REPORT_DIR=/path/to/reports            # must already exist
export DENY_LIST_FILE=/path/to/deny-list.txt
# edit AUDIT_CMD in review.py (or export AUDIT_CMD) to your tool's read-only command

python3 review.py --dry-run instruction.md reports/review-1.md   # checks only, no tool call
python3 review.py instruction.md reports/review-1.md
```

The instruction file says what to audit and what "pass" means. Keep it inside the folder being audited so the audit tool can read it.

Exit codes: `0` ok, `2` usage/config/path error, `4` deny-list or settings check failed, `5` audit tool failed or timed out, `6` report written but the working tree changed during the run, `7` report incomplete.

## Not included

The original this was distilled from was tied to one particular tool and one machine. This version keeps only the general ideas. It names no vendor, model or account, and it never calls anything until you fill in your own command.
