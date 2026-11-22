# Builder tools (optional examples)

[中文](README.zh-CN.md)

This folder is **optional**. The SoloFleet runtime does not need anything in it. It holds examples for people who build and maintain a crew with a coding assistant, as described in the development process document (`development-process.md`).

## What is here

| Path | What it is |
|---|---|
| [`cross-vendor-review/`](cross-vendor-review/README.md) | A generic example script that runs another vendor's command-line audit tool in read-only mode: checks the deny list first, adds three standard rules to the instruction (evidence, three-class grading, no dangerous version-control commands), and writes the report only into a chosen folder. The development process asks for at least one audit from a different vendor; this is one way to do it safely. You must fill in your own audit command. |
| [`skills/ste-document-maintenance/`](skills/ste-document-maintenance/SKILL.md) | A skill for writing and maintaining process documents, decision records and handoffs in plain, exact wording, while keeping the goal and the current state of long tasks visible. It cites the writing principles of ASD-STE100 Issue 9. |
| [`skills/flat-agent-management/`](skills/flat-agent-management/SKILL.md) | A skill for designing, adjusting or auditing multi-agent set-ups: roles, authority, information sharing, capacity and prevention, judged by results and cost. |

Both skills are written in Chinese. They keep the usual layout: `SKILL.md`, `agents/*.yaml` (interface hints) and `references/*.md`. To use one, copy its folder into the skills folder of your coding assistant and adapt the wording to your own project.

The skills refer to books and projects by title, author and link only; no original text is reproduced. ASD-STE100 is owned by ASD; the skill contains only an original summary, and you should get the official standard from the link in it. Read the sources in the `references/` files for details.

## Local tools that are not in the repository

The closing gate, the record-writing tool and the dispatch reminder hook are small tools on the builder's own machine. They are not in this repository. (Forbidding writes to the OpenClaw program folder is just a rule in your coding assistant's local settings.) The crew runs without them.
