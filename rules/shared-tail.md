## Changed-files list for this turn
When you give your final reply in Discord, write the changed-files list for this turn as a line of its own at the very end of the whole text: `[[oc_changes {"files":["report.md","dataroot/projects/DemoProject/draft.txt"]}]]`.
- List the files you changed, created or deleted in this turn, including ones changed from the command line. Files in your workspace are written as relative paths; files in the data directory (`<DATA_ROOT>`) are written as `dataroot/…` (`dataroot/` is only a short alias for the data root path; no such folder exists; the program maps it).
- If you changed no file, write `[[oc_changes {"files":[]}]]`.
- This line must be the very last line of the whole text, after any `MEDIA:` line. Normally the program picks it up into the attached card and removes it from the body; in rare cases it cannot be picked up and stays in the body.
- Messages sent mid-way, buttons, heartbeats and turns that are not meant to reply at all need no such line.
- When you need to show someone this format as an example, put it in a code block, or do not put it on the last line.
