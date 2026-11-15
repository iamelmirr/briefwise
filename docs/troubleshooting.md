# Troubleshooting

Start with the log. Everything that happens in a project (your messages, every brief, Claude's replies, warnings, blocked briefs, guard results) is appended to `.briefwise/log.md`. In VS Code, open it from the panel's `...` menu > **Full log**.

## Claude Code not found

The VS Code panel shows "Claude Code not found" with the path it looked for, or a Claude run ends with `ERROR: could not start Claude Code`.

Briefwise looks for `claude` in this order:

1. `claude.path` in `.briefwise/config.json`
2. the `CLAUDE_BIN` environment variable
3. every directory on `PATH` (it looks for `claude.exe` on Windows, `claude` elsewhere)
4. `~/.local/bin`, where the native installer puts it, Windows included

Fixes:

- Check that Claude Code is installed and signed in: `claude --version`, then run `claude` once.
- Find the binary (`which claude` on macOS/Linux, `where.exe claude` on Windows) and set it explicitly:

  ```json
  "claude": { "path": "/Users/me/.local/bin/claude" }
  ```

  On Windows, use forward slashes or escaped backslashes: `"C:/Users/me/.local/bin/claude.exe"`.
- VS Code inherits `PATH` from how it was started. If `claude` works in your terminal but not in the panel, start VS Code from that terminal (`code .`) or set `claude.path`.
- On Windows, Briefwise looks for `claude.exe`, and for an npm-installed `claude.cmd` it runs the package’s JavaScript entry with Node instead. If neither is on `PATH`, set `claude.path` to `claude.exe` (the native installer puts it in `~/.local/bin`) or to the `claude.cmd` npm created.

After changing the config, close and reopen the panel or restart the CLI.

## OpenRouter errors

These appear as an error card in the panel or an `Error:` line in the CLI.

| Message | Cause and fix |
|---|---|
| `No OpenRouter API key (OPENROUTER_API_KEY)` | CLI: set the environment variable. On Windows after `setx`, open a new terminal. |
| "Save your OpenRouter key first" | VS Code: paste the key in the panel, or run **Briefwise: Set OpenRouter key**. The extension does not read `OPENROUTER_API_KEY`. |
| `The OpenRouter key is invalid or revoked (401)` | Create a new key at [openrouter.ai/keys](https://openrouter.ai/keys) and save it again. |
| `does not have enough credits (402)` | Top up at [openrouter.ai/credits](https://openrouter.ai/credits). |
| `Model ... is unavailable or does not support tools (404)` | The model id is wrong, was removed, or has no tool-capable provider. Pick another model in the picker or with `/model`. |
| `is rate-limiting requests ... (429)` | Briefwise already retried. Wait a moment, choose another model, or loosen `provider` routing so more providers qualify. |

Briefwise retries 408, 429 and 5xx responses up to three times with a short backoff before showing an error.

If you restricted providers with the `provider` field (for example `"data_collection": "deny"`) and get 404 errors, no provider of that model meets the restriction. Relax it or pick another model.

## Claude's command was denied

Claude reports that it couldn't run the tests, or a tool row in the panel is marked "blocked".

Claude may run only `git status/diff/log/show`, `ls`, and what is in `claude.implementAllow`, and only while implementing. Add the command you need:

```json
"implementAllow": ["Bash(npm test:*)", "Bash(npx vitest run:*)"]
```

See [Allow your test and build commands](getting-started.md#allow-your-test-and-build-commands). Then close and reopen the panel (or restart the CLI).

Other reasons for a denial:

- Claude tried a compound command (`cd x && npm test`, pipes, `;`). Only single commands match the allow rules.
- The command is always denied: `git push`, `git reset`, `git checkout`, `git clean`, `rm`.
- The run was a consultation, which is read-only.
- The file is in `denyRead` or in `.briefwise/`.

## "The working tree has N uncommitted files"

This notice appears once per session when you start a task with uncommitted changes. It is a warning, not an error: Claude's changes will mix with yours, which makes them harder to review or undo. Commit or stash first, or switch to a new branch. The guard still works on a dirty tree, because it compares file contents before and after each run.

## Guard warnings

A "This needs your approval" card (or `Guard:` in the CLI) lists files Claude changed that touch dependencies, database schema or migrations, deployment or CI config, or that were deleted.

The lead is told to ask you or have Claude revert. When it asks:

- Approve if you wanted the change.
- Decline, and the lead should have Claude undo it.
- Check the files yourself with **Open diff** or `git diff`.

If a check command rewrites a lockfile (for example an install step), the dependency guard fires on every run. Allow a command that doesn't modify the lockfile instead.

## Stop doesn't stop

Stop (button, `Esc`, **Briefwise: Stop task**, `Ctrl+C`) should end both the lead request and the Claude process within a moment. If Claude keeps running:

1. Find and end the process: Task Manager on Windows (`claude.exe`), or `ps aux | grep claude` and `kill <pid>` on macOS/Linux.
2. Please [open an issue](https://github.com/iamelmirr/briefwise/issues/new?template=bug_report.md) with your OS, how you stopped it, and the end of `.briefwise/log.md`.

## The panel is blank or stuck

- Run **Developer: Reload Window** from the command palette. The conversation is restored from `.briefwise/transcript.json`.
- If it stays blank, run **Developer: Open Webview Developer Tools** with the panel focused and look for errors in the console, then open an issue with them.

## The lead stopped after 60 steps

The lead used `maxSteps` without finishing. Look at `log.md` to see where it went around in circles. Often a smaller, more concrete request helps, or a model with better tool calling. You can raise `maxSteps` in `config.json`.

## Model or Claude menu won't change

You can't switch models while a task runs; stop it or wait. If you get an error that `config.json` is not valid JSON, fix the file (a missing comma is common) and try again.

## Resetting

- **New chat** in the panel (or **Briefwise: New conversation**, or `/new` in the CLI) clears the conversation. Notes and Claude sessions are kept.
- To clear the history by hand, delete `.briefwise/history.json` (and `.briefwise/transcript.json` for the panel).
- To forget all Claude sessions, delete `.briefwise/sessions.json`.
- To start completely fresh, delete `.briefwise/`. It is recreated from templates on the next run, so back up `RULES.md` and `PRIVATE.md` first if you want to keep them.

Close the panel or quit the CLI before deleting files by hand.
