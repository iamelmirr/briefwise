# Kimi Lead (VS Code)

A VS Code panel where a lead model acts as tech lead and the real Claude Code CLI does the engineering. On the left you chat with the lead (any OpenRouter model, Kimi by default). On the right you watch Claude Code work live: the brief it received, every file it reads, every command it runs and every edit it makes.

Claude Code runs on your own Claude subscription. The OpenRouter key is only used for the lead model.

## Install

From a release `.vsix`:

```
code --install-extension kimi-lead.vsix
```

Or build it yourself:

```
npm install
npm run package
code --install-extension kimi-lead.vsix
```

You also need the Claude Code CLI (`claude`) installed and signed in.

## Usage

- Press `Ctrl+Alt+K` (`Cmd+Alt+K` on macOS) or run **Kimi Lead: Open**.
- Paste your OpenRouter key in the panel, or run **Kimi Lead: Set OpenRouter key**. It is stored in VS Code's secret storage, not in the project.
- Pick the lead model from the model button under the chat box, and the Claude model from the menu above the Claude pane.
- Rules, private notes and config live in `.kimi/` inside your project (see the main README).
- Type into the Claude pane's box while it works to send a message straight to Claude. Use **Resume in terminal** to continue a session by hand.

## Development

```
npm install
npm run build      # or: npm run watch
npm run typecheck
```

To preview the webview in a browser without VS Code, run `npm run build` and open `dev/preview.html`. Query parameters: `theme=light|dark`, `state=live|empty|nokey|done|guard`, plus `picker=1` or `claudemenu=1` to open those menus.
