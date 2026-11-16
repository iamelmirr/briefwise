# Configuration

Each project has its own `.briefwise/config.json`. It is created from a template on first run. Open it in VS Code with `...` > **Settings (config.json)** in the panel header, or edit it in any editor.

The file is merged over built-in defaults, so you only need the fields you want to change; a missing field keeps its default. Nested objects (`context`, `read`, `claude`) are merged field by field. Arrays replace the default entirely.

The config is read when the panel opens or the CLI starts. After editing by hand, close and reopen the panel or restart the CLI. The lead model picker and the Claude model menu (and `/model`, `/claude` in the CLI) write their choice into this file and take effect immediately.

If the file is not valid JSON, the defaults are used, and the model pickers refuse to save until you fix it.

## Full example

This is the template a new project gets:

```json
{
  "model": "moonshotai/kimi-k3.1-pro",
  "provider": { "sort": "throughput" },
  "reasoningEffort": "low",
  "decisionEffort": "medium",
  "maxAskRounds": 3,
  "maxSteps": 60,
  "context": { "softTokens": 24000, "hardTokens": 40000, "keepTaskPairs": 8 },
  "read": { "maxLines": 200, "maxChars": 12000, "grepMax": 40 },
  "claude": {
    "path": null,
    "userSettings": false,
    "model": null,
    "effort": null,
    "maxBudgetUsdPerCall": null,
    "reportMaxChars": 6000,
    "autoCompact": true,
    "implementAllow": ["Bash(npm test:*)", "Bash(npm run lint:*)", "Bash(npx tsc:*)"],
    "denyRead": [".env", ".env.*", "**/*.pem", "**/*.key", "secrets/**"]
  },
  "forbidden": []
}
```

## Lead model

### model

Default: `"moonshotai/kimi-k3.1-pro"`

The OpenRouter model id of the lead. Any model that supports tool calling works. The display name in the UI follows the id (Kimi, Qwen, GLM, DeepSeek, Gemini, GPT, Grok, MiniMax, Mistral, Llama, Claude, otherwise "Lead"). See [Models](models.md).

### provider

Default: `{ "sort": "throughput" }`

Passed unchanged as the `provider` object of every OpenRouter request, so anything in [OpenRouter's provider routing](https://openrouter.ai/docs/features/provider-routing) works here. `{ "sort": "throughput" }` sends requests to the fastest provider for the model. Set `null` to use OpenRouter's default routing.

Examples:

```json
"provider": { "sort": "price" }
```

```json
"provider": { "sort": "throughput", "data_collection": "deny" }
```

### reasoningEffort

Default: `"low"`

How hard the lead thinks on a normal step. Sent as `reasoning: { "effort": ... }`. Typical values are `"low"`, `"medium"` and `"high"`. Set `null` to send nothing and use the model's own default. Models without reasoning support ignore it.

### decisionEffort

Default: `"medium"`

The effort for the step right after Claude answered a consultation, when the lead chooses between options. `null` sends nothing.

### maxAskRounds

Default: `3`

How many read-only consultations (`ask_claude`) the lead may make per task. After that, further consultations are refused and the lead is told to decide, implement, or ask you.

### maxSteps

Default: `60`

The maximum number of lead steps (model calls) per task. If the lead hasn't finished by then, the task stops with "Stopped after 60 steps without finishing".

## Lead context

### context.softTokens

Default: `24000`

When the estimated size of the lead's context passes this, Briefwise replaces old read results (except the two most recent) with a short marker and drops the reasoning text of earlier steps. See [Why the lead stays fast](how-it-works.md#why-the-lead-stays-fast).

### context.hardTokens

Default: `40000`

When the context still passes this after pruning, earlier conversation pairs are dropped first. If that is not enough, the lead writes itself a checkpoint summary and continues the task from that summary with a fresh context. The context meter in the VS Code panel shows the lead's prompt size against this number.

### context.keepTaskPairs

Default: `8`

How many earlier (your message, the lead's report) pairs the lead sees at the start of a task. `history.json` keeps the last 50.

## Lead reads

These limit what the lead's own read tools return, so a single read can't flood its context.

### read.maxLines

Default: `200`

Maximum lines per `read_file` call. The lead asks for another range if it needs more.

### read.maxChars

Default: `12000`

Maximum characters returned by `read_file` and by the lead's `git` tool. Longer output is cut with a hint to narrow the request.

### read.grepMax

Default: `40`

Maximum matching lines returned by the lead's `grep` (which also stops at 10 matches per file).

## Claude Code

### claude.path

Default: `null`

Path to the `claude` binary. With `null`, Briefwise looks in this order: the `CLAUDE_BIN` environment variable, `PATH`, then `~/.local/bin` (where the native installer puts it, also on Windows). On Windows it looks for `claude.exe`.

```json
"path": "/opt/homebrew/bin/claude"
```

### claude.userSettings

Default: `false`

With `false`, Claude Code is started with `--setting-sources project,local`, so your global `~/.claude/settings.json` is not loaded. This matters: a broad rule there, such as `"allow": ["Bash"]`, would bypass Briefwise's command restrictions. The project's `.claude/settings.json`, `.claude/settings.local.json` and `CLAUDE.md` still apply.

Set `true` only if you understand that your global allow rules then apply to every Briefwise run.

### claude.model

Default: `null`

The model Claude Code uses, passed as `--model`. `null` uses your Claude Code default. Aliases like `"opus"`, `"sonnet"` and `"haiku"` work, as does any model name Claude Code accepts. The Claude menu in the panel and `/claude` in the CLI set this field.

### claude.effort

Default: `null`

Passed to Claude Code as `--effort` when set. `null` leaves it to Claude Code.

### claude.maxBudgetUsdPerCall

Default: `null`

Passed as `--max-budget-usd` to each Claude Code call when set. It caps the cost Claude Code reports for one consultation or implementation. `null` sets no cap.

### claude.reportMaxChars

Default: `6000`

How many characters of Claude's final reply the lead receives. You always see the full session; this only limits what goes into the lead's context.

### claude.autoCompact

Default: `true`

Whether Claude Code may compact a session on its own when the context is nearly full. With `false`, Briefwise starts Claude with `DISABLE_AUTO_COMPACT=1`, so a session is compacted only when you (or the lead, on your request) ask for it; a session that fills up completely then ends its run with an error. Toggle it in the panel's session options or with `/autocompact on|off`. It applies from the next Claude run.

### claude.implementAllow

Default in the template: `["Bash(npm test:*)", "Bash(npm run lint:*)", "Bash(npx tsc:*)"]`. The built-in default, used when the field is missing, is `[]`.

Extra Claude Code permission rules granted only in implement mode. In both modes Claude may always use `Read`, `Grep`, `Glob`, `git status/diff/log/show` and `ls`; implement mode adds `Edit`, `Write` and this list. Everything else is denied automatically.

The `Bash(...)` entries are also listed in every implement brief (the `ALLOWED COMMANDS` line) and in the lead's instructions, so both know which checks can run. Other rules (for example a non-Bash tool name) are passed to Claude Code but not listed.

See [Allow your test and build commands](getting-started.md#allow-your-test-and-build-commands) for examples per stack.

### claude.denyRead

Default: `[".env", ".env.*", "**/*.pem", "**/*.key", "secrets/**"]`

Gitignore-style globs for files neither Claude nor the lead may read. For Claude they become `Read(...)` and `Edit(...)` deny rules; the lead's `read_file` and `grep` skip them. `.briefwise/` is always denied to Claude. See [denyRead](rules-and-notes.md#denyread).

## Guardrails

### forbidden

Default: `[]`

Regular expressions (case-insensitive) that must never appear in a brief to Claude. A matching brief is blocked before it is sent and the lead has to rephrase. See [forbidden](rules-and-notes.md#forbidden).

## Fixed behavior

Some things are not configurable, on purpose:

- Claude may never run `git push`, `git reset`, `git checkout`, `git clean` or `rm`.
- Consultations are always read-only: no `Edit`, `Write` or `NotebookEdit`.
- The post-change guard (dependencies, database schema, deletions, deployment and CI) always runs after an implementation.
- The lead's `git` tool allows only `status`, `diff`, `log`, `show` and `branch`.

## Environment variables

| Variable | Used by | Effect |
|---|---|---|
| `OPENROUTER_API_KEY` | CLI, VS Code | The OpenRouter key. The VS Code extension prefers a key saved in secret storage and uses this one when none is saved. |
| `CLAUDE_BIN` | both | Path to `claude`, used when `claude.path` is `null`. |
| `OPENROUTER_BASE_URL` | both | Override the OpenRouter API base URL (default `https://openrouter.ai/api/v1`). Used by the tests to point at a mock server. |
| `NO_COLOR` | CLI | Disable colored output. |
