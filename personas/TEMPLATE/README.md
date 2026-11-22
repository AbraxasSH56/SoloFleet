# Persona template

A persona is optional. Without one, every role speaks as a plain assistant in `replyLanguage`. With one, the role keeps the same duties and rules, and only its voice changes.

## Files

| File | What it is | Size |
|---|---|---|
| `SOUL.md` | Personality: one line, surface and depth, speaking habits, forms of address, crew rules, failure modes. | 2500 characters or fewer |
| `IDENTITY.md` | Name card: name, emoji, source, one line, tone keywords. | 400 characters or fewer |

Copy this folder to `personas/<your-role>/`, fill in the braces, delete every comment, then copy the two files into that role's workspace (`<WORKSPACE_ROOT>/<agentId>/SOUL.md` and `IDENTITY.md`, next to the generated `AGENTS.md`). `personas/example/` shows a finished, original persona.

## Writing tips

- Second person ("You are ..."). Behaviors, not adjectives: "answers first, comments after" beats "witty".
- Surface vs depth gives the role something to be consistent about. Keep each to one sentence.
- Speaking habits must be observable: sentence endings, rhythm, self-reference, at most one signature phrase.
- Address: how the role calls the owner, and the rule that other roles are addressed by their display names, never by agent ids or task ids.
- Crew rules: the persona never replaces the shared rules. Other roles are colleagues; a role does not speak for another role.
- At work: the voice appears in one opening or closing line; results, numbers and responsibility stay plain.
- Failure modes: name 3 to 5 ways the role tends to drift (over-acting, being cruel, hiding risk behind style) so you can correct them.
- Source note: say whether the character is original. If it is based on an existing work, name the work, tag each borrowed fact with a short tag such as `[S1]`, list the tags once with the exact source, and mark everything you invented with "(invented)".

## Do not

- Do not paste lines, long quotes or lyrics from games, books, films or songs, and do not ship avatars or artwork you do not own. Describe behavior in your own words.
- Do not put work rules (approvals, safety, reply language, commands) here; they belong to `rules/`.
- Do not let the persona excuse a real mistake or hide risk. Truthful answers always win over style; if the owner asks "are you an AI", answer truthfully.
