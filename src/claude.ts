// Claude Code worker: runs the real `claude` binary with streaming JSON in and out,
// so every tool call and message is visible live, and the user can interject mid-run.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "./config.ts";

export type Mode = "ask" | "implement";

export type ClaudeEvent =
  | { kind: "init"; sessionId: string; model?: string }
  | { kind: "text"; text: string }
  | { kind: "user"; text: string } // a message the user interjected, acknowledged by Claude
  | { kind: "tool"; id: string; name: string; input: any }
  | { kind: "tool_result"; id: string; isError: boolean; text: string };

export type ClaudeResult = { text: string; isError: boolean; costUsd: number; sessionId?: string; stopped?: boolean };

export type ClaudeRun = {
  done: Promise<ClaudeResult>;
  /** Send an extra user message into the running session. False if the run already finished. */
  interject(text: string): boolean;
  stop(): void;
};

/** Find the claude binary: config → CLAUDE_BIN → PATH → ~/.local/bin (native installer default). */
export function resolveClaudeBin(configured: string | null): string {
  if (configured) return configured;
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  const local = path.join(os.homedir(), ".local", "bin", exe);
  return fs.existsSync(local) ? local : "claude";
}

const WORKER_PROMPT = `You are a senior engineer working under a technical lead. All tasks come from the lead.
Hard rules unless the task text explicitly says the change is APPROVED BY THE USER:
- do not add, remove or upgrade dependencies
- do not change database schema or migrations
- do not delete files
- do not touch deployment, CI or production configuration
If a good solution needs one of these, stop and explain why instead of doing it.
You already run in the repository root. Use one simple command per Bash call: no \`cd\`, no \`&&\` or \`;\` chains, no pipes. Compound commands are denied by the permission system.
Every message from the lead starts with a [MODE: ...] line. It applies to that message only and replaces any earlier mode in this session.
The lead reads only your final message, so end every reply with a compact REPORT (max ~150 words): what you did or found, files changed, commands/tests run with results, open questions or risks.`;

const MODE_LINE: Record<Mode, string> = {
  ask: "[MODE: CONSULT. Read-only for this message: investigate the code and answer, or propose options with trade-offs. Do not modify anything.]",
  implement: "[MODE: IMPLEMENT. For this message you may edit files; any earlier read-only CONSULT mode no longer applies. Make the changes, keep them focused, run the relevant checks you are allowed to run.]",
};

/** "Bash(npm test:*)" -> "npm test …"; other tool rules are left as they are. */
export function describeAllowed(rules: string[]): string[] {
  return rules.map((r) => {
    const m = /^Bash\((.+?)(:\*)?\)$/.exec(r);
    return m ? `${m[1]}${m[2] ? " …" : ""}` : r;
  });
}

/** The lead's prompt as sent to Claude, with the per-message mode line (and, when implementing, the commands it may run). */
export function withMode(mode: Mode, prompt: string, implementAllow: string[] = []): string {
  if (mode !== "implement") return `${MODE_LINE[mode]}\n\n${prompt}`;
  const cmds = describeAllowed(implementAllow.filter((r) => r.startsWith("Bash(")));
  const allowed = cmds.length
    ? `[ALLOWED COMMANDS: ${cmds.map((x) => `\`${x}\``).join(", ")}, plus git status/diff/log/show and ls. Any other command is denied automatically, so do not try others. Use these for checks.]`
    : "[ALLOWED COMMANDS: only git status/diff/log/show and ls. You cannot run tests or builds; say so in your report.]";
  return `${MODE_LINE[mode]}\n${allowed}\n\n${prompt}`;
}

const READ_ONLY = ["Read", "Grep", "Glob", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(ls:*)"];

export function buildArgs(cfg: Config, mode: Mode, sessionId?: string): string[] {
  const denyPaths = cfg.claude.denyRead.flatMap((g) => {
    const p = g.replace(/^\.\//, "");
    return p.includes("/") ? [`./${p}`] : [`./${p}`, `./**/${p}`];
  });
  const deny = [
    ...denyPaths.flatMap((p) => [`Read(${p})`, `Edit(${p})`]),
    "Read(./.kimi/**)", "Edit(./.kimi/**)", "Write(./.kimi/**)",
    "Bash(git push:*)", "Bash(git reset:*)", "Bash(git checkout:*)", "Bash(git clean:*)", "Bash(rm:*)",
    ...(mode === "ask" ? ["Edit", "Write", "NotebookEdit"] : []),
  ];
  const allow = mode === "ask" ? READ_ONLY : [...READ_ONLY, "Edit", "Write", ...cfg.claude.implementAllow];
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
    "--permission-mode", mode === "ask" ? "dontAsk" : "acceptEdits",
    "--permission-prompts", "none",
    "--append-system-prompt", WORKER_PROMPT,
    "--allowedTools", ...allow,
    "--disallowedTools", ...deny,
  ];
  // Without this, the user's global ~/.claude/settings.json (e.g. "allow": ["Bash"]) would override the guardrails above.
  if (!cfg.claude.userSettings) args.push("--setting-sources", "project,local");
  if (sessionId) args.push("--resume", sessionId);
  if (cfg.claude.model) args.push("--model", cfg.claude.model);
  if (cfg.claude.effort) args.push("--effort", cfg.claude.effort);
  if (cfg.claude.maxBudgetUsdPerCall) args.push("--max-budget-usd", String(cfg.claude.maxBudgetUsdPerCall));
  return args;
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("\n");
  return "";
}

export function startClaude(o: { bin: string; repo: string; args: string[]; prompt: string; onEvent(e: ClaudeEvent): void }): ClaudeRun {
  const child = spawn(o.bin, o.args, { cwd: o.repo, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  // sent: messages written to stdin; acked: messages Claude replayed back (it may fold an interjection into the
  // running turn, so there is not always one result per message). Close stdin once a turn ends with all acked.
  let sent = 0, acked = 0, buf = "", err = "", cost = 0, stopped = false;
  let sessionId: string | undefined;
  let last: any = null;

  const send = (text: string): boolean => {
    if (child.stdin.writableEnded || child.exitCode !== null) return false;
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    sent++;
    return true;
  };

  const handle = (e: any) => {
    if (e.session_id) sessionId = e.session_id;
    if (e.type === "system" && e.subtype === "init") {
      o.onEvent({ kind: "init", sessionId: e.session_id, model: e.model });
    } else if (e.type === "assistant") {
      for (const b of e.message?.content ?? []) {
        if (b.type === "text" && b.text?.trim()) o.onEvent({ kind: "text", text: b.text });
        else if (b.type === "tool_use") o.onEvent({ kind: "tool", id: b.id, name: b.name, input: b.input ?? {} });
      }
    } else if (e.type === "user") {
      const content = e.message?.content;
      if (e.isReplay) {
        acked++;
        if (acked > 1) o.onEvent({ kind: "user", text: resultText(content) });
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === "tool_result") o.onEvent({ kind: "tool_result", id: b.tool_use_id, isError: !!b.is_error, text: resultText(b.content).slice(0, 2000) });
        }
      }
    } else if (e.type === "result") {
      last = e;
      cost = Math.max(cost, Number(e.total_cost_usd || 0));
      // nothing more queued → let the process exit (acked === 0: this claude build does not replay; don't wait)
      if (acked >= sent || acked === 0) child.stdin.end();
    }
  };

  child.stdout.on("data", (d) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { handle(JSON.parse(line)); } catch { /* not JSON */ }
    }
  });
  child.stderr.on("data", (d) => (err += d));
  child.stdin.on("error", () => { /* process gone */ });

  const done = new Promise<ClaudeResult>((resolve) => {
    child.on("error", (e) => resolve({
      text: `ERROR: could not start Claude Code (${o.bin}): ${e.message}. Set "claude.path" in .kimi/config.json.`,
      isError: true, costUsd: 0,
    }));
    child.on("close", (code) => {
      if (stopped) return resolve({ text: "STOPPED: the user stopped this Claude run.", isError: true, costUsd: cost, sessionId, stopped: true });
      if (last) return resolve({ text: String(last.result ?? last.subtype ?? "(no result)"), isError: !!last.is_error, costUsd: cost, sessionId });
      resolve({ text: `ERROR: claude exited with code ${code}\n${(err || buf).slice(-4000)}`, isError: true, costUsd: cost, sessionId });
    });
  });

  send(o.prompt);
  return {
    done,
    interject: (text) => send(text),
    stop: () => { stopped = true; killTree(child); },
  };
}
