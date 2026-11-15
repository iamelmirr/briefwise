# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's private vulnerability reporting: go to the [Security tab](https://github.com/iamelmirr/briefwise/security) of the repository and choose **Report a vulnerability**.

Include what you found, how to reproduce it (a minimal repo or config helps), the affected version, and your OS. You can expect an acknowledgement within a few days.

For hardening ideas or questions that don't expose users to risk (for example "the docs should warn about X"), a normal [issue](https://github.com/iamelmirr/briefwise/issues) is fine.

Please don't include real API keys, private code or `.briefwise/` contents from a real project in a report.

## Supported versions

Security fixes go into the latest release. Please update before reporting.

## Threat model

Briefwise sits between you, a lead model on OpenRouter, and Claude Code running on your machine. It aims to:

- keep context you mark as private (`PRIVATE.md`, `forbidden` patterns) away from Claude
- keep files you mark as sensitive (`denyRead`) away from both models' file tools
- keep Claude within a narrow set of allowed actions, even if a brief goes wrong or the lead model misbehaves
- make risky changes (dependencies, schema, deletions, deploy/CI) visible and require your approval
- never touch your Claude credentials, and keep the OpenRouter key out of the project

It does not try to protect against a malicious local user, a compromised Claude Code or Node installation, or a compromised OpenRouter account.

## What is protected

Enforced in code:

- Briefs that match a `forbidden` pattern are blocked before they reach Claude.
- Claude Code's permission flags deny `Read`/`Edit` on `denyRead` paths and on `.briefwise/`, deny `git push`, `git reset`, `git checkout`, `git clean` and `rm`, deny all editing during consultations, and deny any command not on the allow list. Permission prompts are off, so nothing can be approved interactively by accident.
- Your global `~/.claude/settings.json` is not loaded by default, so broad allow rules there can't widen Briefwise's permissions.
- The lead's tools can't edit project files, read outside the repository, read `denyRead` files with `read_file` or `grep`, or run git commands other than `status`, `diff`, `log`, `show` and `branch`.
- After every implementation, a guard compares git state and flags dependency, schema, deletion and deploy/CI changes to the lead and to you.
- `.briefwise/` is excluded from git.
- The VS Code extension stores the OpenRouter key in VS Code's secret storage.

## What is not protected

- **Code the lead reads goes to OpenRouter** and the provider serving the model. Only `denyRead` files are kept out.
- **Prompt-level rules can fail.** Keeping `PRIVATE.md` out of briefs, following `RULES.md`, asking before risky changes, and Claude's own hard rules are instructions to models. Use `forbidden` and the guard as the backstop.
- **`denyRead` is not a sandbox.** The lead’s `git` tool honors it, but Claude’s read-only git commands (`git show`, `git diff`) can print tracked files that match it. Keep secrets out of git.
- **Project-level Claude settings apply.** Allow rules in the project's `.claude/settings.json` or `.claude/settings.local.json` widen what Claude may do. Review them in repositories you don't control.
- **The guard reports after the fact** and only sees changes visible to `git status`. It doesn't revert anything.
- **`log.md` holds everything**, including private messages. It stays local, but treat it as sensitive.
- **Sessions resumed in a terminal** run as plain Claude Code with your normal settings.
- **Setting `claude.userSettings` to `true`** loads your global Claude settings and can bypass the command restrictions.

See [How it works](docs/how-it-works.md#security-model-and-limits) for details.
