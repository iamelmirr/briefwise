# Models

Briefwise uses two models: the **lead**, which you talk to and which writes the briefs, and **Claude Code**, which does the engineering. You choose them separately.

## Choosing a lead model

The lead runs through OpenRouter on your OpenRouter key. Any model with tool calling can be the lead. The default is `moonshotai/kimi-k3.1-pro`.

### What matters

- **Reliable tool calling.** This is the one hard requirement. The lead works entirely through tools (`read_file`, `grep`, `ask_claude`, `implement`, `finish`...). A model that produces malformed tool calls, invents tool names, or answers in prose when it should act will stall tasks. Models without tool support are rejected by OpenRouter and are not listed in the picker.
- **Following instructions.** The lead must keep its hands off the code, keep `PRIVATE` out of briefs, follow your `RULES.md`, and write self-contained English briefs. Stronger instruction followers make better leads.
- **Speed.** A task is a chain of lead steps: read, think, brief, wait for Claude, review, report. Each step waits for the previous one, so time to first token and output speed add up. A fast lead makes the whole task feel quicker even though Claude does most of the work.
- **Price.** The lead's context stays small (by default it is pruned past about 24k tokens and summarized past 40k), so input price per task is modest. The system prompt is frozen for the whole task, which lets providers that support prompt caching reuse it. In VS Code, hover the context meter to see how much of the last prompt came from cache.
- **Context size.** With the default limits, any model with 64k context or more is plenty. A bigger window does not help unless you raise `context.hardTokens`.
- **Languages.** The lead replies in the language you write in and briefs Claude in English. If you write in a less common language, check that the model handles it well.

### Switching the lead model

**In VS Code**, click the model chip under the message box. The picker loads OpenRouter's catalogue and shows only tool-capable models:

- **Recommended:** a short list of strong tool-calling leads, plus your current model.
- **Newest on OpenRouter:** the most recent tool-capable models.
- **Search** by name or id (`qwen`, `glm`, `deepseek`, `gemini`...). Each row shows the price in USD per million tokens (input / output) and the context size.
- To use a model that isn't in the catalogue, type its full id (with the `/`) and choose `Use "<id>"`. It must support tools.

The choice is saved to `model` in `.briefwise/config.json`. You can't switch while a task is running.

**In the terminal**, use `/model` to show the current model and `/model <id>` to switch:

```text
you> /model qwen/qwen3.8-max-0902
Lead model: qwen/qwen3.8-max-0902
```

Or set `model` in `config.json` directly.

### Free models

Models with a `:free` suffix are hidden from the default picker lists, because free endpoints may log or train on your prompts, and the lead sees your code. They still show up when you search. If you use one, assume everything the lead reads can be stored by the provider.

### Reasoning effort

Two settings control how hard the lead thinks:

- `reasoningEffort` (default `"low"`) for normal steps: reading code, writing briefs, reviewing.
- `decisionEffort` (default `"medium"`) for the step right after Claude answered a consultation, when the lead picks an approach.

The values are sent to OpenRouter as `reasoning.effort`. Higher effort usually means better decisions, more reasoning tokens, and slower steps. Set either to `null` to use the model's default. Models without reasoning support ignore them. The context checkpoint summary always runs at `"low"`.

A practical start: keep `"low"` / `"medium"`. If the lead picks poor approaches after consulting, raise `decisionEffort` to `"high"`. If it is slow on simple tasks, try `reasoningEffort: null` or a faster model.

### Provider routing

`provider` is sent to OpenRouter as-is. The default `{ "sort": "throughput" }` routes each request to the provider with the highest output speed for that model, which suits the lead's many short steps. Use `{ "sort": "price" }` to favor the cheapest provider, or add other [provider routing](https://openrouter.ai/docs/features/provider-routing) options, for example `"data_collection": "deny"` to exclude providers that may store prompts. Set `provider` to `null` for OpenRouter's default routing.

## Tested lead models

Measured on 2026-11-15 on a real open-source library, [jshttp/cookie](https://github.com/jshttp/cookie) (TypeScript, vitest). Each lead got the same casual request, written in Bosnian: *"stringifySetCookie: maxAge must be an integer; if not, throw a TypeError with a clear message; if validation already exists, just verify it and add the missing tests; run the tests"*. Claude Code ran on Haiku, and `implementAllow` was `npx vitest …` and `npx tsc …`.

The validation already existed. Every lead noticed that, had Claude add only the missing tests, replied in Bosnian, and left the full suite passing.

| Lead model | Time | Lead cost | Claude cost | Claude rounds | What it did |
|---|---|---|---|---|---|
| `moonshotai/kimi-k3.1-pro` | 117 s | $0.052 | $0.014 | 2 | The most thorough. Covered NaN, ±Infinity, fractions and unsafe integers, and asserted the exact error type and message. |
| `qwen/qwen3.8-max-0902` | 177 s | $0.029 | $0.025 | 2 | Added null, NaN and −Infinity cases plus an explicit TypeError check. Had Claude run the full suite and `tsc`. |
| `z-ai/glm-5.3` | 65 s | $0.021 | $0.005 | 1 | Added NaN and a check that negative integers are accepted. Gave a short, precise brief. |
| `deepseek/deepseek-v4-pro-0813` | 56 s | $0.011 | $0.004 | 1 | The fastest and cheapest. Added only a NaN case. |

In a separate run through the VS Code extension, Kimi K3.1 Pro led Claude Sonnet through a feature on the same repo. The feature was a new `skipEmpty` option for `parseCookie`, with tests and README docs. The run took 2 minutes, cost $0.06 for the lead and $0.12 for Claude, and 35 of 35 tests passed. Most of the lead's prompt was served from cache: 9.3k of 9.6k tokens.

What this suggests:

- **Kimi K3.1 Pro** is the default because its reviews are the most careful.
- **GLM 5.3** and **DeepSeek V4 Pro** are good fast, cheap leads for routine work.
- **Qwen 3.8 Max** is thorough but slower.

These results come from one task per model, so treat them as a starting point, not a benchmark. If you test another model, a PR adding a row here is welcome.

## Choosing the Claude model

Claude Code runs on your own Claude subscription. Briefwise only passes a `--model` flag when you choose one.

| Choice | Config value | When to use it |
|---|---|---|
| Your default | `null` | Whatever your Claude Code is set to. A good start. |
| Opus | `"opus"` | The strongest model, for complex or risky changes. Uses your limits fastest. |
| Sonnet | `"sonnet"` | Faster and cheaper. Works well for the scoped, explicit tasks the lead writes. |
| Haiku | `"haiku"` | Fastest, for small, mechanical changes. |

Switch in the VS Code panel with the **Claude** menu above the Claude pane, or in the terminal:

```text
you> /claude sonnet
Claude Code model: sonnet
you> /claude default
Claude Code model: default
```

The choice is saved to `claude.model` in `config.json`. You can also put any model name Claude Code accepts there. `claude.effort` passes `--effort` to Claude Code if you want to control its thinking too.

### Cost trade-offs

- **Lead cost** is real money on your OpenRouter account, shown per task (for example `Kimi $0.012`).
- **Claude cost** is the figure Claude Code reports for each run (for example `Claude $0.21`). On a subscription you are not billed per token; the work counts against your plan's usage limits instead. The figure is still a useful measure of how heavy a task was.
- A task usually costs one or more consultations plus one or more implementations. `maxAskRounds` caps consultations per task, and `claude.maxBudgetUsdPerCall` can cap each Claude call.
- Most of the spend is normally on the Claude side. A cheaper lead saves little if it writes vague briefs that need extra Claude rounds.
