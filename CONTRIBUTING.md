# Contributing to Briefwise

Thanks for helping. Bug reports, fixes, docs and small focused features are all welcome. For larger changes, open an issue first so we can agree on the approach.

## Development setup

You need Node 22.6 or newer, git, and for end-to-end use Claude Code and an OpenRouter key. The tests don't need either.

```bash
git clone https://github.com/iamelmirr/briefwise.git
cd briefwise
npm install                 # dev dependencies only: TypeScript and Node types
npm run typecheck

cd extension
npm install
npm run build               # bundles the extension and webview into extension/dist
```

Run the CLI from your checkout:

```bash
npm link                    # gives you a global `briefwise` pointing at this checkout
cd ~/some/test-repo
briefwise
```

Run the extension from source in an Extension Development Host (keep `npm run watch` running in `extension/` while you work, then use **Developer: Reload Window** in the host to pick up changes):

```bash
code --extensionDevelopmentPath="$PWD/extension" ~/some/test-repo
```

Or package it and install the result:

```bash
cd extension
npm run package             # writes briefwise.vsix
code --install-extension briefwise.vsix
```

## Project layout

```text
bin/briefwise.mjs     CLI launcher: runs src/cli.ts with Node's type stripping
src/
  lead.ts             the lead loop, its tools, system prompt and context management
  claude.ts           starts Claude Code: flags, modes, permissions, streaming, interjection, stop
  openrouter.ts       streaming OpenRouter client with retries and readable errors
  config.ts           config defaults, .briefwise/ setup and migration, denyRead globs
  git.ts              git helpers and the post-change guard
  cli.ts              terminal UI
  format.ts           one-line descriptions of Claude's tool calls
  names.ts            display name for the lead model
templates/            initial RULES.md, PRIVATE.md, notes and config.json for a new project
test/                 core tests (unit and mock end-to-end)
extension/
  src/                extension host: commands, panel, bridge to the core
  webview/            the panel UI (plain TypeScript and CSS, no framework)
  dev/                browser preview and host test harness
  build.mjs           esbuild bundling; copies ../templates into the extension
docs/                 user documentation
```

The core in `src/` is UI-agnostic: `Lead` emits events, and the CLI and the extension render them. Keep it that way; UI code belongs in `cli.ts` or `extension/`.

## Running tests

```bash
npm test                    # core: unit tests and a mock end-to-end run, no network
cd extension && npm test    # extension host test against a mock OpenRouter
```

Neither suite calls OpenRouter or a real Claude Code. Tests must not generate live API traffic. Use `OPENROUTER_BASE_URL` to point at a mock server and a fake `claude` binary (via `claude.path` or `CLAUDE_BIN`).

Also run the type checks before a PR:

```bash
npm run typecheck
cd extension && npm run typecheck
```

## UI preview without VS Code

After `npm run build` in `extension/`, open `extension/dev/preview.html` in a browser. It loads the built webview with a fake VS Code API and a demo transcript.

| Query parameter | Values |
|---|---|
| `state` | `live`, `done`, `guard`, `nokey`, `empty` |
| `theme` | `light` (dark is the default) |
| `picker` | `1` opens the lead model picker |
| `claudemenu` | `1` opens the Claude model menu |

For example `extension/dev/preview.html?state=guard&theme=light`. Check both themes and a narrow window when you change the UI.

## Code style

- TypeScript everywhere. The core runs directly with Node's built-in type stripping, so use only erasable syntax: no `enum`, no `namespace`, no parameter properties. Import local files with the `.ts` extension.
- No runtime dependencies in the core. Use the Node standard library. The extension may use dev dependencies for bundling.
- Small, readable functions with a comment where the reason isn't obvious.
- Guardrails belong in code where possible. If you add a safety rule that is only a prompt, say so in the PR and in `docs/how-it-works.md`.
- User-facing text: plain English, sentence case, no exclamation marks.
- Keep files LF (see `.gitattributes`).

## Pull request checklist

- [ ] One focused change per PR, with a clear description of what and why
- [ ] `npm test` and `npm run typecheck` pass in the root and in `extension/`
- [ ] New behavior has a test, or the PR explains why not
- [ ] UI changes checked in the preview, in light and dark themes
- [ ] Docs updated if behavior, config or commands changed
- [ ] `CHANGELOG.md` updated under "Unreleased"
- [ ] No secrets, `.env` files, API keys, `.briefwise/` folders or personal logs in the diff

## Never commit secrets

Don't commit `.env` files, OpenRouter keys, Claude credentials, or a `.briefwise/` folder from a real project (it can contain private notes and full logs). If you commit a key by accident, revoke it right away, even if you force-push it away.

## Security issues

Please don't report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
