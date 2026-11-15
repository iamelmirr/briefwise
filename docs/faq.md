# FAQ

## Is it the real Claude Code?

Yes. Briefwise starts your installed `claude` CLI in print mode with streaming JSON. It doesn't patch it, wrap its API, or replace its system prompt; it adds short worker instructions with `--append-system-prompt` and sets permissions with Claude Code's own flags. See [How Claude is started](how-it-works.md#how-claude-is-started).

## Does it use my Claude subscription?

Yes. Claude Code runs under your own login, so the work counts against your plan's usage limits. Briefwise never reads, stores or asks for your Claude credentials. The OpenRouter key is only for the lead model.

## Does Claude see my private notes?

No. `.briefwise/` is denied to Claude through Claude Code's permission rules, so Claude can't open `PRIVATE.md` or any other file there. The lead is instructed never to put private content into a brief. That instruction is a prompt, so for names and numbers that must never leak, add `forbidden` patterns: a matching brief is blocked in code. See [Rules and notes](rules-and-notes.md#forbidden).

## Does the lead model see my code?

It sees what it reads: small file ranges, grep results, git output, and Claude's reports. All of that goes to OpenRouter and the model's provider. Files in `denyRead` are not read. Check your employer's policy before using it on work code.

## Can I use it without VS Code?

Yes. The `briefwise` CLI does the same in the terminal: the lead conversation, Claude's live stream, interjection, stop, and the same `.briefwise/` folder. See [Getting started](getting-started.md#first-run-in-the-terminal).

## Which languages can I write in?

Any language your lead model handles well. The lead replies in the language you write in and always briefs Claude in English. `RULES.md` and `PRIVATE.md` can be in any language too.

## Which programming languages does it support?

Whatever Claude Code supports. Briefwise doesn't parse code. Set `claude.implementAllow` so Claude can run your stack's tests and checks.

## Does it commit or push?

No. Claude may not run `git push`, `git reset`, `git checkout`, `git clean` or `rm`, and Briefwise itself never commits. Review the changes and commit them yourself. Work on a branch of its own.

## What does it cost?

- **The lead:** OpenRouter usage on your key, shown per task. Depends on the model; the lead's context is kept small.
- **Claude:** covered by your Claude subscription, within its usage limits. The dollar figure shown for Claude is what Claude Code reports for each run.

See [Models](models.md#cost-trade-offs).

## Does it work on Windows, macOS and Linux?

Yes. On Windows, the native Claude Code installer is the easiest setup; Briefwise finds `claude.exe` in `~/.local/bin` automatically.

## Why not let the lead write code?

Because Claude Code is better at it, and that is the point. The lead's job is to understand you, keep context and private information, write precise briefs, and review. Keeping it out of the code keeps its context small and fast, gives one clear place where edits happen, and lets every edit go through Claude Code's permission system and the post-change guard.

## Why not just talk to Claude Code directly?

You can, and for many tasks you should. Briefwise helps when you want to write casually or in your own language, keep business context away from the coding agent, have a reviewer check each change against your rules, or keep a long-running project memory outside Claude's sessions.

## Can I continue a session by hand?

Yes. In VS Code, **Resume in terminal** opens the selected session with `claude --resume <id>`. In the CLI, `/sessions` shows the ids. A resumed session is plain Claude Code with your normal settings.

## Where is my data stored?

In `.briefwise/` in the project (excluded from git), and in Claude Code's own session storage. The VS Code extension keeps the OpenRouter key in VS Code's secret storage.
