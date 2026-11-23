# {{PROJECT_NAME}}: Project entry

<!-- template note begin -->
Usage: the Controller creates a new project with the fixed command (`new-project`, written in the Controller's rules). One command creates the project folder, this page and one row in the master index, so you never copy this template by hand. One project channel maps to one project folder. The project's lead bot keeps this page; a worker bot registers the results of its task at close-out with the `add-result` command (which changes only the "Current results" table and the "Current status" line below). This page holds only the current goal, status and next step; evidence, investigations and old decisions go in the project's `history/` folder, and only links to them are kept here.
Use the English words of this template exactly as written. The section titles and the placeholder cell "None yet (to be written)" are the exact words the programs match. Do not rename them.
<!-- template note end -->

## Current goal

{{ONE_LINE_GOAL}}

## Mapping

- Discord channel: {{CHANNEL}}
- Lead bot: {{LEAD_BOT}}
- Task records: `tasks/`
- Results: `outputs/`
- History: `history/`

## Current status

{{DATE}}: The project was just created.

## Next step

<What is done next, and by whom.>

## Current results

| Result | Location | Note |
| --- | --- | --- |
| None yet (to be written) | — | — |
