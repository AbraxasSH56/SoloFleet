# Roles

English | [简体中文](../zh-CN/roles.md)

Each bot has one duty. The duty decides its rule file, its tools and what the programs let it do. Personas (a character voice) are optional and sit on top of a role.

## The roles

| Duty | agentId | What it does | Rule head |
|---|---|---|---|
| Controller | `main` | Understands requests, records decisions and cards, hands work out, sends work to audit, checks the result against the owner's words, reports. Creates projects and keeps the index and the decision ledger. Quiet unless mentioned. | `rules/roles/main/` |
| Desktop operator | `desktop` | The only bot that touches the screen. Takes the screen lock, works in the thread that mentioned it, stops and asks for six kinds of operation (payment, sending to others, permanent deletion, form submission, upload, installation). | `rules/roles/desktop/` |
| Task auditor | `task-auditor` | Audits work that executors hand in, read-only, against the owner's words and the acceptance criteria; also gives advice (not an audit) when the desktop operator is stuck. | `rules/roles/task-auditor/` |
| System auditor | `system-auditor` | Audits the system itself on a schedule (daily, weekly, after anomalies), read-only except its own report folders. | `rules/roles/system-auditor/` |
| Diary keeper | `diary` | Writes the owner's daily diary from the day's records. Optional. | `rules/roles/diary/` |
| Worker | `worker-a`, `worker-b`, … | Does the actual work in a project thread and keeps its own task record. The program recognises workers by the `worker-` prefix. | `rules/roles/worker/` |
| Standby | `standby-a`, `standby-b` | Idle until the owner explicitly calls them. They run on the API credit pool of the subscription (if any), never take task cards, and stop when the credit is used up. Same head as a worker. | `rules/roles/worker/` |

The programs work with the agent IDs in the table above, and the keys of `bots` in `config/crew.json` say which of them exist in your deployment (renaming agents is not supported yet; see [configuration.md](configuration.md) section 3). Add workers by adding `worker-c`… to `bots`, the OpenClaw agent list and the Discord bindings, then run `scripts/sync-shared-rules.py --generate`.

## What is generated

The `AGENTS.md` of each role is put together from three parts: the role head (`rules/roles/<dir>/AGENTS.head.md`), the shared rules (`rules/shared-rules.md`, trimmed by `rules/shared-rules-overrides.json`; for example the Desktop operator gets no "Desktop" section and the System auditor gets no tail), and the tail (`rules/shared-tail.md`, which holds the changed-files list marker the reply card reads). The Chinese versions are the `*.zh-CN.md` files; see [setup.md](setup.md) for the command.

## Optional personas

A persona gives a bot a voice: how it speaks, what it calls the owner, small habits. The rules never depend on it; they only say "if a persona is configured, follow it, but never let it make a statement unclear".

- `personas/TEMPLATE/` has empty `SOUL.md` and `IDENTITY.md` with writing notes (one-line character, surface and depth, how it speaks, forms of address, rules between characters).
- `personas/example/` is a short original example character.
- To use one, put its `SOUL.md` / `IDENTITY.md` into the role's workspace next to `AGENTS.md` (`<workspaceRoot>/<agentId>/`).
- Do not copy lines, avatars or artwork from games, films or books into a public repository. Characters from games are somebody else's work; write your own or keep a private persona out of the repository.

### Reference deployment: which characters it used (optional table)

The reference deployment gave its roles voices from video games. They are listed only so you can see how a duty can map to a character.

| Duty | Character used there | Work |
|---|---|---|
| Controller | Sandrone | Genshin Impact |
| Desktop operator | Silver Wolf | Honkai: Star Rail |
| Task auditor | Nous | Honkai: Star Rail |
| Diary keeper | Fairy | Zenless Zone Zero |
| Standby | Kafka, Firefly | Honkai: Star Rail |
| Workers | a mix of characters from the same three games | – |

(Character names are spelled as in the games' English versions. The repository contains no lines or art from the originals; the table is only an example and carries no endorsement from the rights holders.)
