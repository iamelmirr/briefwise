# Rules and notes

Everything Briefwise keeps for a project lives in `.briefwise/` in the project root. The folder is created on first run and added to `.git/info/exclude`, so it never gets committed and you don't have to touch the team's `.gitignore`. An older `.kimi/` folder from before the rename is moved to `.briefwise/` automatically.

Claude Code is never allowed to read or edit anything in `.briefwise/`. That is enforced with Claude Code's own permission rules, not just by prompt.

## What each file is for

| File | Written by | Purpose |
|---|---|---|
| `RULES.md` | you only | How the lead should work, what Claude may know, your preferences. Highest priority. |
| `PRIVATE.md` | you and the lead | Context only the lead may know. Never sent to Claude. |
| `PROJECT.md` | the lead, and you | Lasting facts: what the project is, architecture, conventions. |
| `TASKS.md` | the lead, and you | What is being worked on and its status. |
| `DECISIONS.md` | the lead, and you | Decisions with the reason and date. |
| `config.json` | you (the model pickers write to it too) | Models, limits and hard guardrails. See [Configuration](configuration.md). |
| `sessions.json` | Briefwise | Named Claude Code sessions (`cart`, `auth`, `billing-api`...) with their purpose and Claude session id. |
| `history.json` | Briefwise | Short conversation history: your messages and the lead's final reports, the last 50. |
| `transcript.json` | VS Code extension | What the panel shows after a reload. |
| `log.md` | Briefwise | Everything: your messages, every brief and Claude reply, interjections, blocked briefs, guard warnings, context checkpoints, reports. |

How they are used:

- `RULES.md`, `PRIVATE.md`, `PROJECT.md`, `TASKS.md` and `DECISIONS.md` go into the lead's system prompt at the start of every task. Changes you make take effect on the next task.
- The lead can overwrite `PROJECT`, `TASKS`, `DECISIONS` and `PRIVATE` with its `update_notes` tool. It has no tool to change `RULES.md`.
- The raw conversation is not kept between tasks. The lead sees the last few (message, report) pairs from `history.json` (`context.keepTaskPairs`, default 8) plus its notes. The notes are its long-term memory.
- Nothing in `.briefwise/` is sent to Claude, except what the lead itself writes into a brief.

In VS Code, **Rules** and **Private notes** in the header open those two files. The `...` menu opens the others. In the terminal, `/rules` and `/private` print them.

## Writing a good RULES.md

`RULES.md` is your standing instruction to the lead. It sits above the lead's built-in instructions (only safety ranks higher). Write it in any language; the lead still writes to Claude in English.

Good rules are concrete and checkable. Cover four things: how to brief Claude, what Claude may know, how you like the code, and when to ask you.

```markdown
# My rules for the lead

## How you may talk to Claude
- Give it technically precise tasks: what, where in the code, and when it counts as done.
- When the approach is not obvious, first ask for 2–3 options with pros and cons.
- Always name the test file that should cover the change.

## What Claude may know
- Only what it needs for the current task.
- Never mention the company name, client names, prices, contracts or deadlines.
- Refer to the customer integration as "the partner API", not by name.

## How I like things done
- TypeScript strict, no `any`, no non-null assertions.
- Every new endpoint gets a test in test/api/.
- Small, focused changes. No drive-by refactors.
- Error messages are user-facing; keep them short and in English.

## When you must ask me
- new dependencies, database schema changes, deleting files, anything involving production or deployment
- anything that changes the public API in src/api/public/
```

Things that don't work well in `RULES.md`:

- Vague wishes ("write clean code"). The lead can only pass on what it can phrase precisely.
- Secrets. `RULES.md` is in the lead's prompt and the lead model runs through OpenRouter. Keep credentials out of every file here.
- Instructions for Claude's tools. Claude never reads this file. If Claude Code itself should follow a convention in every session, put it in the project's `CLAUDE.md` as usual.

## Writing a good PRIVATE.md

`PRIVATE.md` holds the context that helps the lead make good decisions but that Claude doesn't need: who the client is, why something matters, what a deadline means. The lead also writes here when you tell it something private in the chat ("remember that the March release is for Acme").

```markdown
# Private (lead only)

- The project is the ordering portal for Acme Retail. The contract renews in March.
- Acme's QA team tests against the staging API every Monday morning; avoid breaking staging on Fridays.
- Priority this quarter: checkout speed. Anything that slows checkout needs my sign-off.
- Pricing tiers (internal): Basic 49 EUR, Pro 199 EUR. Never expose these in code comments or tests.
- "Jane" in issues is Acme's product owner.
```

The lead is told never to put anything from `PRIVATE` into a brief. That is a prompt-level rule. To make sure, back the important items with `forbidden` patterns.

## Backing rules with code: forbidden and denyRead

Two settings in `config.json` turn the most important rules into checks that don't depend on the model behaving.

### forbidden

`forbidden` is a list of regular expressions. Before every `ask_claude` or `implement` call, Briefwise tests the brief against each pattern, case-insensitively. If one matches, the brief is not sent. The lead gets a `BLOCKED` result telling it which rule number matched and that it must rephrase, you see a "Blocked before reaching Claude" card, and the attempt is written to `log.md`.

```json
"forbidden": ["Acme", "Jane\\s+Doe", "\\b(49|199)\\s*EUR\\b", "contract renew"]
```

- Patterns are JavaScript regular expressions, matched with the `i` flag. Escape backslashes for JSON (`\\s`, `\\b`).
- An invalid pattern falls back to a plain case-insensitive substring match.
- Only briefs from the lead are checked. What you type into Claude's session yourself (interjections) is not.
- Keep patterns specific. A pattern like `"price"` would block most e-commerce briefs.

### denyRead

`claude.denyRead` is a list of gitignore-style globs for files that neither Claude nor the lead may read. The default:

```json
"denyRead": [".env", ".env.*", "**/*.pem", "**/*.key", "secrets/**"]
```

- A pattern without a slash matches the file name anywhere in the tree (`.env` blocks `api/.env` too). A pattern with a slash is matched against the path from the repository root.
- `*` matches within one path segment, `**` across segments.
- For Claude, each pattern becomes `Read(...)` and `Edit(...)` deny rules passed to Claude Code with `--disallowedTools`.
- For the lead, `read_file` refuses denied paths and `grep` drops matching lines from denied files.
- `.briefwise/` is always denied to Claude, whatever this list says.

Add your own sensitive paths:

```json
"denyRead": [".env", ".env.*", "**/*.pem", "**/*.key", "secrets/**", "config/credentials.yml", "**/*.p12", "infra/prod/**"]
```

`denyRead` protects against reading files through the normal file tools. It is not a sandbox: read-only git commands can still print the content of tracked files. Keep real secrets out of git. See [Security model](how-it-works.md#security-model-and-limits).

## Resetting

- **New chat** / `/new` clears `history.json` (and in VS Code the transcript). Notes and sessions stay.
- Delete `sessions.json` to forget all Claude sessions; new ones are created on demand.
- Edit or empty any notes file by hand at any time.
- Delete `.briefwise/` entirely to start from scratch. It is recreated from templates on the next run.
