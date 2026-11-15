# Briefwise

Briefwise puts a lead model between you and Claude Code. You describe what you want in your own words, in any language. The lead (any OpenRouter model with tool calling, Kimi K3.1 Pro by default) reads a little code, turns your request into a precise English brief, and hands it to the real, unmodified Claude Code CLI running on your own Claude subscription. Claude does the work while you watch it live. The lead then reviews the diff and reports back to you in your language.

![Briefwise in VS Code: the lead conversation on the left, the live Claude Code session on the right](docs/screenshot.png)

## Key points

- **The engineer is the real Claude Code.** Briefwise starts your installed `claude` CLI on your own Claude subscription. It never reads or stores your Claude credentials.
- **The lead is any OpenRouter model with tool calling.** Pick Kimi, Qwen, GLM, DeepSeek, GPT, Gemini or anything else from a picker. Only the lead uses your OpenRouter key.
- **You see everything Claude does.** The exact brief, every file it reads, every command, every edit with an inline diff. You can type into Claude's session while it works, stop it, or resume it in a terminal.
- **The lead keeps private notes.** Business context, clients and other things you tell the lead go into `PRIVATE.md`, which is never sent to Claude.
- **Some guardrails are enforced in code.** Forbidden patterns block a brief before it reaches Claude, `denyRead` files are off limits, consultations are read-only, and a post-change guard flags dependency, schema, deletion and deploy/CI changes.
- **The lead stays fast.** It gets Claude's short report instead of the whole transcript, prunes old reads, and summarizes itself when its context fills up.

## Quick start

You need [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in (`claude` works in your terminal), `git`, and an [OpenRouter API key](https://openrouter.ai/keys).

### VS Code

1. Download [`briefwise.vsix`](https://github.com/iamelmirr/briefwise/releases/latest/download/briefwise.vsix) from the latest release.
2. Install it:

   ```bash
   code --install-extension briefwise.vsix
   ```

   Or use the Extensions view, then the `...` menu, then **Install from VSIX...**.
3. Open a project folder (a git repository) and press `Ctrl+Alt+K` (`Cmd+Alt+K` on macOS), or run **Briefwise: Open** from the command palette.
4. Paste your OpenRouter key into the panel. It is kept in VS Code's secret storage, not in the project.

### Terminal

The CLI needs Node 22.6 or newer.

```bash
npm install -g https://github.com/iamelmirr/briefwise/releases/latest/download/briefwise.tgz
```

Or from a clone:

```bash
git clone https://github.com/iamelmirr/briefwise.git
cd briefwise
npm link
```

Then:

```bash
export OPENROUTER_API_KEY=sk-or-...   # Windows: setx OPENROUTER_API_KEY sk-or-... (then open a new terminal)

cd ~/work/some-project
briefwise                                        # interactive
briefwise "add rate limiting to /api/orders"     # one task, then exit
```

See [Getting started](docs/getting-started.md) for a full first run.

## How a task flows

1. You write casually: *"cart should reject negative prices, add a test"*.
2. The lead reads a few small pieces of code if it needs to.
3. If the approach is not obvious, it **consults** Claude in read-only mode for options.
4. It sends Claude an **implement** brief: English, scoped, with the checks to run.
5. Claude edits files and runs the commands you allowed. You watch every step.
6. The lead reviews the diff, asks Claude for fixes if needed, updates its notes, and replies in your language with the cost.

Briefwise never commits or pushes. That stays with you.

## Documentation

- [Getting started](docs/getting-started.md): first run in VS Code and the terminal, allowing your test commands
- [Rules and notes](docs/rules-and-notes.md): the `.briefwise/` folder, `RULES.md`, `PRIVATE.md`, `forbidden` and `denyRead`
- [Configuration](docs/configuration.md): every `config.json` field
- [Models](docs/models.md): choosing the lead model and the Claude model
- [How it works](docs/how-it-works.md): architecture, context management, security model
- [Troubleshooting](docs/troubleshooting.md)
- [FAQ](docs/faq.md)
- [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), [Changelog](CHANGELOG.md)

## Requirements

- [Claude Code](https://docs.claude.com/en/docs/claude-code), installed and signed in
- `git`, and a project that is a git repository (the guard and the diffs rely on it)
- An [OpenRouter API key](https://openrouter.ai/keys) for the lead model
- VS Code 1.95 or newer for the extension, or Node 22.6 or newer for the CLI
- Windows, macOS or Linux

## Before you use it at work

- The lead model sees whatever code it reads, through OpenRouter and the provider that serves the model. Check that your employer allows this. You can restrict providers in your OpenRouter settings or with the `provider` field in [config.json](docs/configuration.md#provider).
- Claude Code runs as `claude -p` under your own plan and counts against your subscription limits. The lead may call Claude several times per task.
- Work on a separate branch. Briefwise never commits; committing and pushing is up to you.

## License

[MIT](LICENSE)
