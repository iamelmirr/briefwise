# How it works

## Architecture

```text
 you ──► lead model (OpenRouter) ──► Claude Code CLI (your subscription) ──► your repo
   ◄── report in your language ◄── short REPORT ◄──────────────────────────────┘
          │                              ▲
          └── reads small bits of code   └── you watch the full stream and can interject
```

Briefwise has three parts:

- **The core** (`src/`) is UI-agnostic. The `Lead` class runs the lead loop, starts Claude Code, applies the guardrails, and emits every step as an event.
- **The CLI** (`src/cli.ts`) renders those events in the terminal.
- **The VS Code extension** (`extension/`) bundles the same core and renders the events in a webview panel.

Everything per project is stored in `.briefwise/` (see [Rules and notes](rules-and-notes.md)).

## The lead loop

When you send a message, Briefwise starts a task:

1. It builds the lead's system prompt: its instructions, your `RULES.md`, `PRIVATE.md`, the `PROJECT`, `TASKS` and `DECISIONS` notes, the list of Claude sessions, and the commands Claude may run when implementing. This prompt is frozen for the whole task.
2. It adds the last few (message, report) pairs from `history.json` and your new message.
3. It calls the lead model (streaming) with the tools below. If the lead replies without a tool call, that reply is the answer. Otherwise each tool call runs and its result goes back to the lead.
4. The loop ends when the lead calls `finish`, replies in plain text, you stop it, or `maxSteps` is reached.
5. The final report is saved to `history.json` and `log.md`.

### The lead's tools

| Tool | What it does |
|---|---|
| `list_files` | Lists tracked files (`git ls-files`), optionally filtered. At most 300 names. |
| `read_file` | Reads a line range of a file, at most `read.maxLines` lines. Refuses paths outside the repo and `denyRead` paths. |
| `grep` | `git grep` with an extended regex, at most 10 matches per file and `read.grepMax` lines. Drops lines from `denyRead` files. |
| `git` | Read-only git: `status`, `diff`, `log`, `show`, `branch`. Flags such as `--output`, `--exec`, `-d`, `-D`, `-m`, `-c` are refused. |
| `update_notes` | Overwrites `PROJECT`, `TASKS`, `DECISIONS` or `PRIVATE`. There is no tool for `RULES.md`. |
| `new_session` | Registers a named Claude session for a workstream. |
| `list_sessions` | Lists Claude sessions. |
| `ask_claude` | Consults Claude, read-only. Counts toward `maxAskRounds`. |
| `implement` | Has Claude make changes. |
| `escalate_to_user` | Stops and asks you. Used for approvals and real ambiguity. |
| `finish` | Ends the task with the report for you. |

The lead never writes code itself. Its instructions say so, and it has no tool that edits project files.

When the lead asks you something and nobody can answer (for example you closed the panel, or stdin closed in a one-shot CLI run), it is told the user is unavailable, must not make the change that needed approval, and should finish with what is waiting for you.

## Claude Code

### How Claude is started

Every consultation or implementation starts your `claude` binary in the repository root:

```text
claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages
       --permission-mode <dontAsk | acceptEdits> --permission-prompts none
       --append-system-prompt <worker instructions>
       --allowedTools <...> --disallowedTools <...>
       [--setting-sources project,local] [--resume <session id>]
       [--model <claude.model>] [--effort <claude.effort>] [--max-budget-usd <claude.maxBudgetUsdPerCall>]
```

- The brief goes in on stdin as a stream-json message. Claude's output comes back as stream-json and is shown live.
- `--setting-sources project,local` is added unless `claude.userSettings` is `true`, so your global `~/.claude/settings.json` can't widen permissions.
- Briefwise does not modify Claude Code, its system prompt, or your login. It only adds the worker instructions with `--append-system-prompt`.

The appended worker instructions tell Claude that it works under a technical lead, that it must not add or upgrade dependencies, change schema or migrations, delete files, or touch deployment, CI or production config unless the brief says the change is approved by the user, that it should use one simple command per Bash call, and that it must end every reply with a compact `REPORT` of at most about 150 words.

### Permissions

| | Consult (`ask_claude`) | Implement (`implement`) |
|---|---|---|
| Permission mode | `dontAsk` | `acceptEdits` |
| Allowed | `Read`, `Grep`, `Glob`, `git status/diff/log/show`, `ls` | the same, plus `Edit`, `Write` and `claude.implementAllow` |
| Denied | `Edit`, `Write`, `NotebookEdit`, plus the list below | the list below |

Always denied, in both modes:

- `Read` and `Edit` on every `denyRead` pattern
- `Read`, `Edit` and `Write` on `.briefwise/` (and the legacy `.kimi/`)
- `git push`, `git reset`, `git checkout`, `git clean`, `rm`

Permission prompts are turned off, so anything that is not allowed is denied automatically instead of waiting for an answer. In the VS Code panel a denied tool call is marked "blocked".

### Claude modes

One Claude session can be consulted and then asked to implement, so the mode has to be clear per message. Every brief starts with a mode line that applies to that message only:

```text
[MODE: CONSULT. Read-only for this message: investigate the code and answer, or propose options with trade-offs. Do not modify anything.]
```

```text
[MODE: IMPLEMENT. For this message you may edit files; any earlier read-only CONSULT mode no longer applies. Make the changes, keep them focused, run the relevant checks you are allowed to run.]
[ALLOWED COMMANDS: `npm test …`, `npm run lint …`, `npx tsc …`, plus git status/diff/log/show and ls. Any other command is denied automatically, so do not try others. Use these for checks.]
```

The `ALLOWED COMMANDS` line is built from the `Bash(...)` entries in `claude.implementAllow`. If there are none, it tells Claude it can't run tests or builds and should say so in its report. The lead's own instructions list the same commands, so it names the right check in the brief and can tell you which command to add when a check couldn't run.

The mode line is a prompt. The actual permissions come from the flags above, which differ per mode.

### Sessions

The lead organizes Claude's work in named sessions, one per workstream (`cart`, `auth`, `billing-api`). Names, purposes and Claude session ids are stored in `sessions.json`. Reusing a session name resumes the Claude conversation with `--resume`, so Claude remembers what it did. If the lead names a session that doesn't exist yet, it is created on the fly (`main` when no name is given). If Claude no longer has the conversation, Briefwise starts a fresh one and tells Claude that the earlier context was lost.

In VS Code each session is a tab in the right pane. **Resume in terminal** opens it with `claude --resume <id>` so you can continue by hand.

### Interjection

While Claude runs, what you type in Claude's box (VS Code) or at the prompt (CLI) is written into the running process as an extra user message. Claude sees it during its current turn. The lead does not watch the run; when it ends, the lead gets Claude's report followed by your interjections, marked as your decisions that it must not undo. Interjections are recorded in `log.md`.

### Stopping

Stop (the button, `Esc`, **Briefwise: Stop task**, or `Ctrl+C` in the CLI) aborts the lead's current request and kills the running Claude process. The task ends with "Stopped." Changes Claude already made stay in your working tree.

## The post-change guard

Before each implementation, Briefwise takes a snapshot of every dirty file in git (status code plus a content hash). Afterwards it takes another and compares. Any file whose status or content changed is listed as changed, so edits to files that were already dirty are caught too. `.briefwise/` is ignored.

Each changed file is checked:

| Issue | Matched when |
|---|---|
| deleted | git reports the file as deleted |
| dependencies | `package.json`, lockfiles (npm, pnpm, yarn, bun), `go.mod`/`go.sum`, `requirements*.txt`, `pyproject.toml`, `poetry.lock`, `uv.lock`, `Cargo.toml`/`Cargo.lock`, `composer.json`/`.lock`, `pom.xml`, `build.gradle(.kts)`, `*.csproj`, `Gemfile(.lock)` |
| database schema | anything under `migration/`, `migrations/` or `db/migrate/`, `schema.prisma`, `*.sql` |
| deployment / production config | `Dockerfile`, `docker-compose*`, `.github/workflows/`, `k8s/`, `helm/`, `terraform/`, `*.tf`, `.env*` |

If anything matches, you see a "This needs your approval" card, and the lead's tool result gets a `GUARD` section saying it must either ask you now or have Claude revert. The guard reports; it does not revert anything itself.

## Why the lead stays fast

The lead is the part you wait on between Claude runs, so its context is kept small:

- **Only Claude's short report.** The lead receives Claude's final message (cut at `claude.reportMaxChars`) and the list of changed files, not the transcript. You watch the full session; the lead doesn't need it.
- **Pruning.** Past `context.softTokens`, old read results (except the two most recent) are replaced with a marker like `[pruned to save context: read_file src/cart.ts 1-60; read again if you need it]`, and reasoning text from earlier steps is dropped.
- **Checkpoint summaries.** Past `context.hardTokens`, earlier conversation pairs are dropped. If that is not enough, the lead writes itself a summary of at most 300 words (goal, what it learned, what Claude did, decisions, what remains), and the task continues from that summary with a fresh context. You see a notice when this happens.
- **No raw conversation between tasks.** A new task starts with the last few (message, report) pairs and the notes, not the previous tool calls.
- **A frozen system prompt.** The system prompt is built once per task and not changed, so providers with prompt caching can reuse it on every step. Notes the lead updates during a task show up in the next task's prompt.

## Security model and limits

Briefwise is designed so that a lead model that misbehaves, or a brief that goes wrong, does limited damage, and so that Claude doesn't learn what you keep private. Some protections are enforced in code, some only by prompt.

### Enforced in code

- Briefs matching a `forbidden` pattern are never sent to Claude.
- Claude Code's permission system denies `Read`/`Edit` on `denyRead` paths and on `.briefwise/`, denies `git push/reset/checkout/clean` and `rm`, denies editing in consult mode, and denies any command not on the allow list.
- Your global `~/.claude/settings.json` is not loaded (unless `claude.userSettings` is `true`).
- The lead's tools can't edit project files, can't read `denyRead` paths with `read_file` or `grep`, can't leave the repository, and only run read-only git subcommands.
- The post-change guard detects dependency, schema, deletion and deploy/CI changes after every implementation and tells the lead to ask you.
- `.briefwise/` is excluded from git and from the guard.
- The extension keeps the OpenRouter key in VS Code's secret storage.

### Enforced only by prompt

- Keeping `PRIVATE.md` content out of briefs. Back important items with `forbidden`.
- Following your `RULES.md`.
- Escalating to you before risky changes, instead of after the guard fires.
- Claude's hard rules about dependencies, schema, deletions and deployment. The guard catches violations after the fact.
- The lead not writing code.

### Limits to be aware of

- **The lead sees the code it reads.** Everything the lead reads goes to OpenRouter and the model's provider.
- **`denyRead` is not a sandbox.** It covers the file tools and the lead’s `git` tool (denied paths are refused and excluded from repo-wide output). Claude’s own read-only git commands (`git show`, `git diff`) can still print tracked files that match `denyRead`. Keep secrets out of git.
- **Project settings still apply.** `.claude/settings.json` and `.claude/settings.local.json` in the project are loaded. An allow rule there widens what Claude may do.
- **Claude Code decides what `acceptEdits` covers.** In implement mode, Claude Code's own `acceptEdits` mode controls which edit operations are approved automatically. Briefwise adds deny rules on top but does not change that mode.
- **The guard sees only what git sees.** Changes to ignored files don't show up in `git status` and are not checked. The guard warns; it doesn't undo.
- **`forbidden` is pattern matching.** A paraphrase that avoids your patterns gets through. Write patterns for names and numbers, not concepts.
- **Resume in terminal is plain Claude Code.** A session resumed by hand runs with your normal settings and permissions.
- **`log.md` contains everything.** Briefs, Claude replies, and your messages, including private ones. It stays local and out of git, but treat it as sensitive.

To report a security issue, see [SECURITY.md](../SECURITY.md).
