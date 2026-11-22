# config/examples/

Fragments of OpenClaw configuration for this crew. Every ID, path and model is a placeholder: replace `<LIKE_THIS>` values with your own. Secrets are never written in these files; they only name the environment variable that holds them (for example `DISCORD_BOT_TOKEN_MAIN`). The deployment-wide values (owner, channels, bot IDs, time zone, paths) live in `config/crew.example.json`, copied to `config/crew.json`; use the same values here.

Each file starts with a `_readme` field (one sentence on what it does) and may carry `_notes` or `_groups` fields for explanation: delete those underscore fields before merging into your real OpenClaw config.

| File | What it sets up |
|---|---|
| `discord-integration.example.json` | Discord connection: one application and account per bot, one binding per agent, owner-only allow-list, mention rules, thread bindings. Tokens come from `DISCORD_BOT_TOKEN_<ROLE>` environment variables. |
| `agents-and-workers.example.json` | The agents (Controller `main`, `desktop`, `task-auditor`, `system-auditor`, `diary`, `standby-a`, `standby-b`, `worker-a`, `worker-b`), their workspaces and models, and who may start whom as a sub-agent. Add more `worker-*` entries by copying one. |
| `agent-tools.example.json` | The tool allow-list of each role, grouped by feature (task board, inbox and follow-up tools, web search and fetch, document sync, command access, `computer` for the Desktop operator). |
| `desktop-agent.example.json` | The Desktop operator on OpenClaw's native `computer` tool (with Peekaboo installed for screen reading). |
| `approval-routing.example.json` | Plugin approval cards go to the dedicated Approval channel; only the owner approves. |
| `claude-full-access.example.json` | Claude-only models with no fallback, and `exec` in full mode on the gateway machine. Read `docs/en/safety.md` first. |
| `continuation.example.json` | `commands.ownerAllowFrom` (the owner and all bots except the Desktop operator) so the continuation job can wake an original session after a quota stop. |
| `inbox-integration.example.json` | Load and enable `plugins/personal-inbox`, and spell out the reply card defaults (card on, quota line off, no usage-footer setting needed). |
| `bot-mentions-and-session-reset.example.json` | Bots answer other bots only when mentioned (`allowBots: "mentions"`) with OpenClaw's loop protection on, and sessions reset daily at a fixed local hour while a thread resets only after 24 hours idle (`session.reset`, `resetByType.thread`). |
| `api-credit-providers.example.json` | Three separate API providers (`anthropic-api`, `anthropic-standby-a`, `anthropic-standby-b`), each with its own key variable, no fallback, for the API credit that comes with some subscriptions. |

Merge order does not matter, but `commands.ownerAllowFrom` is set only in `continuation.example.json`. Check field names against your OpenClaw version before applying: the shapes here follow the reference deployment (OpenClaw 2026.10.x).
