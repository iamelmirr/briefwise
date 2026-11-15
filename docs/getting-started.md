# Getting started

This guide takes you from nothing to a first finished task, in VS Code and in the terminal. Both use the same core, the same `.briefwise/` folder and the same config, so you can switch between them in one project.

## Before you start

You need:

- **Claude Code**, installed and signed in. Check with `claude --version` and run `claude` once to make sure you are logged in. Briefwise uses your existing login and never asks for Claude credentials.
- **git**, and a project that is a git repository. The guard, the changed-file list and the diffs all come from git.
- **An OpenRouter API key** from [openrouter.ai/keys](https://openrouter.ai/keys), with some credit on the account. Only the lead model uses it.

Start on a clean working tree, on a branch of its own:

```bash
git switch -c try-briefwise
git status        # should show nothing to commit
```

Briefwise warns you once per session when the tree has uncommitted files, because Claude's changes would mix with yours.

## First run in VS Code

1. Download [`briefwise.vsix`](https://github.com/iamelmirr/briefwise/releases/latest/download/briefwise.vsix) and install it:

   ```bash
   code --install-extension briefwise.vsix
   ```

   You can also open the Extensions view, click `...`, and choose **Install from VSIX...**.

2. Open your project folder (**File > Open Folder**). In a multi-root workspace, Briefwise asks which folder to use.

3. Press `Ctrl+Alt+K` (`Cmd+Alt+K` on macOS), run **Briefwise: Open** from the command palette, or click **Briefwise** in the status bar.

4. The left pane asks you to connect OpenRouter. Paste your key and click **Save key**. The key goes into VS Code's secret storage, not into the project. You can change it later with **Briefwise: Set OpenRouter key** or remove it with **Briefwise: Clear OpenRouter key**.

5. If the panel shows "Claude Code not found", see [Claude Code not found](troubleshooting.md#claude-code-not-found).

On first open, Briefwise creates `.briefwise/` in the project root with templates for your rules and the lead's notes, and adds `.briefwise/` to `.git/info/exclude` so it is never committed. If the project has an older `.kimi/` folder, it is renamed to `.briefwise/` automatically.

### The panel

- **Header:** the repository and branch, a status line, **Stop** (while working), **New chat**, **Rules**, **Private notes**, and a `...` menu with Project notes, Tasks, Decisions, Settings (`config.json`) and the full log.
- **Left pane:** your conversation with the lead. Under the message box you see the lead model chip (click it to switch models), a meter showing how full the lead's context is, and the running cost.
- **Right pane:** Claude Code, one tab per session. Above it, the Claude model menu and **Resume in terminal**.

On a narrow window the two panes become two tabs you switch between. You can drag the divider to resize them.

### A worked example

Say you have a small TypeScript project with a `Cart` class and Vitest tests, and `package.json` has `"test": "vitest run"`. Type:

> cart should reject negative prices, add a test

Press Enter. Here is what happens.

**Left pane.** Your message appears, then "Kimi is thinking" with a ticker of its reasoning (the name follows the model you picked). Small chips show what the lead reads, for example `searches "class Cart"` and `reads src/cart.ts 1–60`. When it is ready, a card appears: **Hands the implementation to Claude**, with the session name (say `cart`), the first lines of the brief, and a running timer. Click the card to jump to that run on the right.

**Right pane.** A `cart` tab opens with a run marked **Implementation**. At the top is the exact brief the lead wrote, in English, for example:

```text
Goal: Cart.addItem must reject negative prices.

Context: src/cart.ts, class Cart, method addItem(item: { sku: string; price: number; qty: number }).
Currently any price is accepted.

Do:
- In addItem, throw a RangeError("price must be >= 0") when item.price < 0. Zero stays allowed.
- Add a test in test/cart.test.ts covering a negative price (throws) and a zero price (accepted).

Done when: npm test passes. Do not change other behavior.
```

Claude receives this with two extra lines in front: the mode line (`[MODE: IMPLEMENT ...]`) and the commands it may run (`[ALLOWED COMMANDS: ...]`). See [How it works](how-it-works.md#claude-modes).

Below the brief, Claude's work streams in live:

- **Reads** `src/cart.ts`
- **Edits** `src/cart.ts` `+3 −0`, with the diff shown inline and an **Open diff** button
- **Edits** `test/cart.test.ts` `+12 −0`
- **Runs** `npm test`, expandable to show the output
- Claude's own short report

The run ends with **Done**, the duration and Claude's cost, plus **Changed files (2)** with a **Diff** button per file. Diffs compare against the last commit.

**Back on the left.** The lead reviews the result, often with `git diff`. If something is off, it sends Claude a follow-up in the same session. When it is satisfied, it may update its notes (`TASKS`, `DECISIONS`) and replies to you in the language you wrote in:

> Negative prices now throw a RangeError in `Cart.addItem`; zero is still allowed. Two tests added, `npm test` passes.

A footer shows the total time and the cost of the lead and of Claude for this task.

### While Claude works

- **Interject:** a box appears under Claude's live session. What you type there goes straight into Claude's session. The lead does not see it, only Claude's final report.
- **Stop:** the **Stop** button, `Esc`, or **Briefwise: Stop task** stops the lead request and kills the Claude process.
- **Questions:** when the lead needs approval (a new dependency, a schema change, a deletion, deployment) it shows a card with **Approve**, **Decline**, or a box for your own answer.
- **Resume in terminal:** opens the selected session with `claude --resume <id>` in a VS Code terminal, after Claude has finished. This is plain Claude Code with your normal settings, not Briefwise's guardrails.

The conversation survives reloads. **New chat** (or **Briefwise: New conversation**) clears it, and keeps your notes and Claude sessions.

## First run in the terminal

1. Install the CLI. It needs Node 22.6 or newer.

   ```bash
   npm install -g https://github.com/iamelmirr/briefwise/releases/latest/download/briefwise.tgz
   ```

   Or from a clone:

   ```bash
   git clone https://github.com/iamelmirr/briefwise.git
   cd briefwise
   npm link
   ```

2. Set your OpenRouter key:

   ```bash
   export OPENROUTER_API_KEY=sk-or-...
   ```

   On Windows, `setx OPENROUTER_API_KEY sk-or-...` and open a new terminal.

3. Start it in the project root:

   ```bash
   cd ~/work/shop
   briefwise
   ```

   Or run one task and exit:

   ```bash
   briefwise "cart should reject negative prices, add a test"
   ```

The same example in the terminal looks like this (shortened):

```text
Briefwise · /home/me/work/shop
Lead: moonshotai/kimi-k3.1-pro · Claude Code: /home/me/.local/bin/claude (model: your default)
you> cart should reject negative prices, add a test
  Kimi is thinking…
  · searches "class Cart"
  · reads src/cart.ts 1–60

┌─ Claude · cart · implementation
│ Kimi → Claude:
│ Goal: Cart.addItem must reject negative prices.
│ ...
│
│ ● Read src/cart.ts
│ ● Edit src/cart.ts  +4 −1
│ ● Edit test/cart.test.ts  +12 −0
│ ● Bash npm test
│ REPORT: added the check and two tests; npm test passes (14 tests).
└─ done · $0.214

Kimi  Negative prices now throw a RangeError in Cart.addItem; zero is still allowed. Two tests added, npm test passes.
  [task cost:Kimi $0.012 · Claude $0.214]
```

While Claude works, anything you type goes straight to Claude. `Ctrl+C` stops the task; at the idle prompt it exits. When the lead asks you something, type your answer at the prompt.

Commands at the prompt:

| Command | What it does |
|---|---|
| `/new` | Start a new conversation. Notes and sessions are kept. |
| `/model [id]` | Show the lead model, or switch to an OpenRouter model id. Saved in `config.json`. |
| `/claude [opus\|sonnet\|haiku\|default]` | Show or set the Claude Code model. `default` uses your Claude Code default. |
| `/sessions` | List named Claude sessions and their ids. |
| `/rules` | Print `RULES.md`. |
| `/private` | Print `PRIVATE.md`. |
| `/exit` | Quit. |

## Allow your test and build commands

When Claude implements, it may run only `git status/diff/log/show`, `ls`, and the commands listed in `claude.implementAllow` in `.briefwise/config.json`. Everything else is denied automatically. If Claude reports that it could not run your tests, this list is the reason.

A new project gets this list:

```json
"implementAllow": ["Bash(npm test:*)", "Bash(npm run lint:*)", "Bash(npx tsc:*)"]
```

Each entry is a Claude Code permission rule. `Bash(npm test:*)` allows `npm test` with any arguments. Set it for your stack.

**Node with Vitest:**

```json
"implementAllow": ["Bash(npm test:*)", "Bash(npx vitest run:*)", "Bash(npm run lint:*)", "Bash(npx tsc:*)"]
```

**Python with pytest:**

```json
"implementAllow": ["Bash(pytest:*)", "Bash(python -m pytest:*)", "Bash(ruff check:*)"]
```

**Go:**

```json
"implementAllow": ["Bash(go test:*)", "Bash(go vet:*)", "Bash(go build:*)"]
```

**Rust:**

```json
"implementAllow": ["Bash(cargo test:*)", "Bash(cargo check:*)", "Bash(cargo clippy:*)"]
```

Tips:

- Claude is told to run one simple command per call: no `cd`, no `&&` or `;` chains, no pipes. Allow commands that work from the repository root.
- Prefer check commands over commands that change the project. A command that rewrites a lockfile (for example `npm install`) triggers the dependency guard.
- The lead reads this list too, so it names the right check in its briefs. Config is read when the panel opens or the CLI starts; close and reopen the panel (or restart the CLI) after editing it by hand.

## Next steps

- Write your [rules and private notes](rules-and-notes.md).
- Pick a [lead model](models.md) that suits your budget and speed.
- Look through the [configuration reference](configuration.md).
