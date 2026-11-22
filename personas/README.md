# personas/

Optional voices for your roles. ([中文说明](README.zh-CN.md))

- `TEMPLATE/`: empty `SOUL.md` and `IDENTITY.md` with writing instructions, plus a `README.md` explaining each section and how to write the source note.
- `example/`: one finished, original persona ("Wren", a Controller-style dispatcher). It uses no game character and no line from any outside work.

## How to use

1. Copy `TEMPLATE/` to `personas/<your role>/`, fill in the braces and delete every comment.
2. Put `SOUL.md` and `IDENTITY.md` into the role's workspace (`<WORKSPACE_ROOT>/<agentId>/`, next to the generated `AGENTS.md`).
3. A persona can be written in any language; the structure is the same: one-line character, surface and depth, a few ways of speaking, forms of address, rules between characters, the direction it most easily drifts in, and sources.

## Writing notes

- `SOUL.md` is injected every turn: keep it under 2500 characters; `IDENTITY.md` under 400.
- Write in the second person and turn character into behaviour you can follow, not a pile of adjectives.
- A persona only changes the voice, not the duties. Approvals, safety and the reply language come from `rules/` and a persona cannot override them. See `docs/en/roles.md`.
- Catchphrases belong to the persona; the rules only say "if a persona is configured, follow it".
- "Sources": for an original character write "original"; for one based on an existing work, name the work and the version you read, tag each borrowed fact with a short label (such as `[S1]`), list what each label points to once at the end, and mark what you made up as "(original addition)".
- No avatars, and no lines or long quotes from games, books, films or songs; describe behaviour in your own words. This repository ships none, and you should hold the rights to anything you add to your own persona.
