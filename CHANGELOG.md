# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Session control. A meter next to the session tabs shows how full each Claude session's context is. Its options let you compact the session (with a note on what to keep), start a fresh Claude conversation in it, or stop Claude from compacting on its own (`claude.autoCompact`). A compaction requested while Claude works runs right after the current step. In the CLI: `/sessions`, `/compact`, `/fresh`, `/autocompact`.
- The lead can compact a session or start it fresh when you ask (`compact_session`, `fresh_session`), sees each session's context size, and mentions sessions over 60% full in its report.

### Changed

- Messages you send straight to Claude while it works now reach the lead together with Claude's report, marked as your decisions, so the lead's review doesn't undo them.
- The VS Code extension uses `OPENROUTER_API_KEY` when no key is saved in the panel, like the CLI.

### Fixed

- The **Briefwise** status bar item now appears when VS Code starts. Before, it showed only after the first Briefwise command. There is also a Briefwise button in the editor title bar.

## 0.4.0 - 2026-11-15

### Changed

- Renamed the project from kimi-lead to Briefwise: the CLI command and npm package are now `briefwise`, the VS Code commands are under "Briefwise", and the packaged extension is `briefwise.vsix`.
- The per-project folder is now `.briefwise/`. An existing `.kimi/` folder is moved to `.briefwise/` automatically on first run, and the OpenRouter key saved by the old extension is carried over.

### Added

- Tests: `npm test` runs core unit tests and a mock end-to-end run without network access; `cd extension && npm test` runs the extension host test against a mock OpenRouter.
- Continuous integration for the tests and type checks.
- Documentation: getting started, rules and notes, configuration, models, how it works, troubleshooting, FAQ, contributing and security policy.
- `briefwise.vsix` and a prebuilt CLI package `briefwise.tgz` attached to GitHub releases (`npm install -g <release URL>`, no build step).
- `npm run build` compiles the core to JavaScript in `dist/`; the launcher uses it when the package is installed.
- Support for Claude Code installed through npm on Windows (`claude.cmd`), both for running tasks and for **Resume in terminal**.

### Fixed

- Stop now ends the Claude Code process reliably on macOS and Linux.
- `denyRead` now also applies to the lead's `git` tool: `git show REV:<denied path>` and denied pathspecs are refused, and repo-wide git output excludes denied files.
- The default `claude.implementAllow` now matches the config template, so a project without that field can still run `npm test`, `npm run lint` and `npx tsc`.
- The rules template no longer claims that edits to `RULES.md` apply mid-task; they apply from the next task.

## 0.3.0 - 2026-11-15

### Added

- Any OpenRouter model with tool calling can be the lead, with a model picker in the panel (catalogue search, prices, context size) and `/model` in the CLI. The lead's display name follows the model.
- Claude model menu in the panel (your default, Opus, Sonnet, Haiku) and `/claude` in the CLI.
- An `ALLOWED COMMANDS` line in every implement brief, built from `claude.implementAllow`, so Claude knows which checks it can run.
- Actionable OpenRouter error messages for invalid keys, missing credits, unavailable models and rate limits.

### Changed

- The whole UI is in English.
- Released under the MIT license.

## 0.2.0 - 2026-11-15

### Added

- VS Code extension: the lead conversation on the left, live Claude Code sessions on the right with a tool stream, inline diffs, interjection, stop and resume in terminal.

## 0.1.0 - 2026-11-13

### Added

- CLI: a lead model on OpenRouter that briefs the real Claude Code CLI as its worker.
- Live stream of Claude's work in the terminal.
- Guardrails: forbidden patterns, `denyRead`, read-only consultations, and a post-change guard for dependencies, schema, deletions and deploy/CI changes.
