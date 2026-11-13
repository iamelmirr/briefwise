#!/usr/bin/env node
// kimi-lead — Kimi (via OpenRouter) as tech lead, Claude Code as the coding worker.
// Zero dependencies. Run with: node --experimental-strip-types src/lead.ts  (Node >= 22.6)

import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

// ───────────────────────── config ─────────────────────────

type Config = {
  model: string;
  maxAskRounds: number;        // ask_claude calls allowed per task
  maxSteps: number;            // Kimi tool-loop steps per task
  historyCharLimit: number;    // trim Kimi history above this size
  claude: {
    model?: string;
    effort?: string;
    maxBudgetUsdPerCall?: number;
    implementAllow: string[];  // extra tools Claude may use when implementing (tests, lint…)
    denyRead: string[];        // paths Claude may never read (gitignore-style, relative to repo)
  };
  forbidden: string[];         // regexes that must never appear in a prompt sent to Claude
};

const DEFAULT_CONFIG: Config = {
  model: "moonshotai/kimi-k3.1-pro",
  maxAskRounds: 3,
  maxSteps: 60,
  historyCharLimit: 2_000_000,
  claude: {
    implementAllow: [],
    denyRead: [".env", ".env.*", "**/*.pem", "**/*.key", "secrets/**"],
  },
  forbidden: [],
};

const REPO = process.cwd();
const KDIR = path.join(REPO, ".kimi");
const P = {
  config: path.join(KDIR, "config.json"),
  rules: path.join(KDIR, "RULES.md"),
  project: path.join(KDIR, "PROJECT.md"),
  tasks: path.join(KDIR, "TASKS.md"),
  decisions: path.join(KDIR, "DECISIONS.md"),
  sessions: path.join(KDIR, "sessions.json"),
  history: path.join(KDIR, "history.json"),
  log: path.join(KDIR, "log.md"),
};
const NOTES: Record<string, string> = { PROJECT: P.project, TASKS: P.tasks, DECISIONS: P.decisions };

function readText(p: string, fallback = ""): string {
  try { return fs.readFileSync(p, "utf8"); } catch { return fallback; }
}
function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return fallback; }
}
function writeJson(p: string, v: unknown) { fs.writeFileSync(p, JSON.stringify(v, null, 2)); }
function log(section: string, body: string) {
  fs.appendFileSync(P.log, `\n## ${new Date().toISOString()} — ${section}\n\n${body.trim()}\n`);
}
function clip(s: string, n = 100_000): string {
  return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s;
}

function init(): Config {
  fs.mkdirSync(KDIR, { recursive: true });
  const tpl = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
  for (const [file, dest] of [["RULES.md", P.rules], ["PROJECT.md", P.project], ["TASKS.md", P.tasks], ["DECISIONS.md", P.decisions], ["config.json", P.config]] as const) {
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, readText(path.join(tpl, file), file.endsWith(".json") ? JSON.stringify(DEFAULT_CONFIG, null, 2) : ""));
  }
  // keep .kimi out of git without touching the team's .gitignore
  const exclude = path.join(REPO, ".git", "info", "exclude");
  if (fs.existsSync(path.dirname(exclude)) && !readText(exclude).includes(".kimi/")) fs.appendFileSync(exclude, "\n.kimi/\n");
  const user = readJson<Partial<Config>>(P.config, {});
  return { ...DEFAULT_CONFIG, ...user, claude: { ...DEFAULT_CONFIG.claude, ...(user.claude ?? {}) } };
}

// ───────────────────────── git helpers ─────────────────────────

function git(args: string[]): string {
  try { return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
  catch (e: any) { return `git error: ${e.stderr || e.message}`; }
}
function statusMap(): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of git(["status", "--porcelain", "-uall"]).split("\n")) {
    if (line.length > 3 && !line.startsWith("git error")) m.set(line.slice(3).trim(), line.slice(0, 2));
  }
  return m;
}

// Changes that need the user's approval — checked in code, not just by prompt.
const GUARDS: [RegExp, string][] = [
  [/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.mod|go\.sum|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Cargo\.toml|composer\.json|pom\.xml|build\.gradle(\.kts)?|[^/]+\.csproj|Gemfile)$/, "dependencies"],
  [/(^|\/)(migrations?|db\/migrate)\/|schema\.prisma$|\.sql$/, "database schema"],
  [/(^|\/)(Dockerfile|docker-compose[^/]*|\.github\/workflows\/|k8s\/|helm\/|terraform\/)|\.tf$|(^|\/)\.env/, "deployment / production config"],
];

function guardCheck(before: Map<string, string>): string[] {
  const issues: string[] = [];
  for (const [file, code] of statusMap()) {
    if (before.get(file) === code) continue; // already dirty before this call
    if (code.includes("D")) issues.push(`deleted: ${file}`);
    for (const [re, what] of GUARDS) if (re.test(file)) issues.push(`${what}: ${file}`);
  }
  return [...new Set(issues)];
}

// ───────────────────────── Claude Code worker ─────────────────────────

type Session = { id?: string; purpose: string; created: string };
let sessions: Record<string, Session> = {};

const WORKER_PROMPT = `You are a senior engineer working under a technical lead. All tasks come from the lead; you never talk to anyone else.
Hard rules unless the task text explicitly says the change is APPROVED BY THE USER:
- do not add, remove or upgrade dependencies
- do not change database schema or migrations
- do not delete files
- do not touch deployment, CI or production configuration
If a good solution needs one of these, stop and explain why instead of doing it.
Always end with a short report: what you did / found, files changed, commands or tests run with results, open questions or risks.`;

const ASK_MODE = `MODE: CONSULT. Read-only. Investigate the code and answer or propose options with trade-offs. Do not modify anything.`;
const IMPL_MODE = `MODE: IMPLEMENT. Make the changes, keep them focused, run the relevant tests/linters you are allowed to run.`;

const READ_ONLY = ["Read", "Grep", "Glob", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(ls:*)"];

let claudeCostUsd = 0;

function runClaude(cfg: Config, sessionName: string, prompt: string, mode: "ask" | "implement"): Promise<string> {
  const s = sessions[sessionName] ?? (sessions[sessionName] = { purpose: "(auto-created)", created: new Date().toISOString() });
  const deny = [
    ...cfg.claude.denyRead.flatMap((g) => [`Read(./${g})`, `Edit(./${g})`]),
    "Read(./.kimi/**)", "Edit(./.kimi/**)", "Write(./.kimi/**)",
    "Bash(git push:*)", "Bash(git reset:*)", "Bash(git checkout:*)", "Bash(rm:*)",
    ...(mode === "ask" ? ["Edit", "Write", "NotebookEdit"] : []),
  ];
  const allow = mode === "ask" ? READ_ONLY : [...READ_ONLY, "Edit", "Write", ...cfg.claude.implementAllow];
  const args = [
    "-p", "--output-format", "json",
    "--permission-mode", mode === "ask" ? "dontAsk" : "acceptEdits",
    "--permission-prompts", "none",
    "--append-system-prompt", `${WORKER_PROMPT}\n\n${mode === "ask" ? ASK_MODE : IMPL_MODE}`,
    "--allowedTools", ...allow,
    "--disallowedTools", ...deny,
  ];
  if (s.id) args.push("--resume", s.id);
  if (cfg.claude.model) args.push("--model", cfg.claude.model);
  if (cfg.claude.effort) args.push("--effort", cfg.claude.effort);
  if (cfg.claude.maxBudgetUsdPerCall) args.push("--max-budget-usd", String(cfg.claude.maxBudgetUsdPerCall));

  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve(`ERROR: could not start claude: ${e.message}`));
    child.on("close", (code) => {
      try {
        const r = JSON.parse(out.trim().split("\n").pop() || "{}");
        if (r.session_id) { s.id = r.session_id; writeJson(P.sessions, sessions); }
        claudeCostUsd += Number(r.total_cost_usd || 0);
        resolve(`${r.is_error ? "CLAUDE ERROR: " : ""}${r.result ?? "(no result)"}`);
      } catch {
        if (s.id && /No conversation found/i.test(out + err)) {
          delete s.id; writeJson(P.sessions, sessions); // session vanished → start fresh
          return resolve(runClaude(cfg, sessionName, `(Previous session context was lost; start fresh.)\n\n${prompt}`, mode));
        }
        resolve(`ERROR: claude exited with code ${code}\n${clip(err || out, 4000)}`);
      }
    });
    child.stdin.end(prompt);
  });
}

// ───────────────────────── Kimi's tools ─────────────────────────

const str = { type: "string" };
function tool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const TOOLS = [
  tool("list_files", "List tracked files in the repo, optionally filtered by a substring.", { filter: str }),
  tool("read_file", "Read a repo file (optionally a 1-based line range).", { path: str, start: { type: "integer" }, end: { type: "integer" } }, ["path"]),
  tool("grep", "Search the repo (git grep, regex).", { pattern: str, path: str }, ["pattern"]),
  tool("git", "Read-only git: status, diff, log, show, branch. Pass args as a list.", { args: { type: "array", items: str } }, ["args"]),
  tool("update_notes", "Overwrite one of your notes files (PROJECT, TASKS, DECISIONS) with full new content.", { file: { type: "string", enum: ["PROJECT", "TASKS", "DECISIONS"] }, content: str }, ["file", "content"]),
  tool("new_session", "Register a named Claude Code session for a workstream (e.g. 'auth', 'billing-api').", { name: str, purpose: str }, ["name", "purpose"]),
  tool("list_sessions", "List Claude Code sessions."),
  tool("ask_claude", "Consult Claude Code in a session (read-only: it can read code, cannot change it). Counts toward the per-task question limit.", { session: str, prompt: str }, ["session", "prompt"]),
  tool("implement", "Have Claude Code implement changes in a session. It edits files and runs allowed tests.", { session: str, prompt: str }, ["session", "prompt"]),
  tool("escalate_to_user", "Stop and ask the user. Use for approvals (dependencies, schema, deletions, production) or real ambiguity about the goal.", { question: str }, ["question"]),
  tool("finish", "Task done (or cannot continue). Give the user the final report.", { report: str }, ["report"]),
];

type Ctx = { cfg: Config; asks: number; rl: readline.Interface; done?: string };

function forbiddenHit(cfg: Config, text: string): number {
  return cfg.forbidden.findIndex((r) => new RegExp(r, "i").test(text));
}

async function callTool(ctx: Ctx, name: string, a: any): Promise<string> {
  switch (name) {
    case "list_files": {
      const files = git(["ls-files"]).split("\n").filter((f) => f && (!a.filter || f.includes(a.filter)));
      return clip(files.join("\n"));
    }
    case "read_file": {
      const abs = path.resolve(REPO, a.path);
      if (!abs.startsWith(REPO)) return "ERROR: outside repo";
      const lines = readText(abs, "\u0000missing").split("\n");
      if (lines[0] === "\u0000missing") return "ERROR: file not found";
      const s = Math.max(1, a.start ?? 1), e = Math.min(lines.length, a.end ?? lines.length);
      return clip(lines.slice(s - 1, e).map((l, i) => `${s + i}\t${l}`).join("\n"));
    }
    case "grep":
      return clip(git(["grep", "-n", "-I", "-E", "--max-count=50", a.pattern, ...(a.path ? ["--", a.path] : [])]) || "(no matches)", 40_000);
    case "git": {
      const args: string[] = a.args ?? [];
      if (!["status", "diff", "log", "show", "branch"].includes(args[0])) return "ERROR: only status/diff/log/show/branch allowed";
      if (args.some((x) => /^--?(output|exec|delete|force|D|d|m|M)$/.test(x) || x.startsWith("--output"))) return "ERROR: flag not allowed";
      return clip(git(args) || "(empty)");
    }
    case "update_notes":
      fs.writeFileSync(NOTES[a.file], a.content);
      return `saved ${a.file}`;
    case "new_session":
      sessions[a.name] = sessions[a.name] ?? { purpose: a.purpose, created: new Date().toISOString() };
      writeJson(P.sessions, sessions);
      return `session '${a.name}' ready`;
    case "list_sessions":
      return JSON.stringify(Object.fromEntries(Object.entries(sessions).map(([k, v]) => [k, { purpose: v.purpose, started: !!v.id }])), null, 2);
    case "ask_claude":
    case "implement": {
      const hit = forbiddenHit(ctx.cfg, a.prompt);
      if (hit >= 0) return `BLOCKED: the prompt contains content the user forbids sharing with Claude (rule #${hit + 1} in config.forbidden). Rephrase without it.`;
      if (name === "ask_claude" && ++ctx.asks > ctx.cfg.maxAskRounds)
        return `LIMIT: ${ctx.cfg.maxAskRounds} consultation rounds used for this task. Decide with what you have, implement, or escalate_to_user.`;
      const mode = name === "ask_claude" ? "ask" : "implement";
      say(`  → Claude [${a.session}] ${mode}…`);
      log(`→ Claude (${mode}, session ${a.session})`, a.prompt);
      const before = mode === "implement" ? statusMap() : new Map();
      let result = await runClaude(ctx.cfg, a.session, a.prompt, mode);
      log(`← Claude (${a.session})`, result);
      if (mode === "implement") {
        const issues = guardCheck(before);
        if (issues.length) {
          const warn = `\n\nGUARD — these changes need the user's approval before you continue:\n- ${issues.join("\n- ")}\nEither escalate_to_user now, or have Claude revert them.`;
          log("GUARD", warn);
          result += warn;
        }
      }
      return clip(result);
    }
    case "escalate_to_user": {
      log("Kimi → user (escalation)", a.question);
      say(`\n❓ Kimi pita:\n${a.question}\n`);
      let ans: string;
      try { ans = await ctx.rl.question("ti> "); }
      catch { return "USER UNAVAILABLE: do not make the change that needed approval. Finish and report what is waiting for the user."; }
      log("user → Kimi", ans);
      return `USER ANSWER: ${ans}`;
    }
    case "finish":
      ctx.done = a.report;
      return "ok";
  }
  return `ERROR: unknown tool ${name}`;
}

// ───────────────────────── Kimi loop ─────────────────────────

function systemPrompt(): string {
  const sess = Object.entries(sessions).map(([k, v]) => `- ${k}: ${v.purpose}`).join("\n") || "(none yet)";
  return `You are the technical lead of this repository (${REPO}). The user is your boss. Claude Code is your engineer.

How you work:
- You never write code yourself. You understand the goal, read the repo as needed, and drive Claude Code.
- You alone decide what Claude sees. Write Claude precise, technical prompts in English. Do not forward the user's messages; translate them into engineering tasks within the user's rules below.
- Typical flow: consult Claude (ask_claude) for options/trade-offs when the approach is not obvious → choose according to the goal and the user's rules → implement → review with git diff/status → send fixes back if needed → finish with a report.
- Work autonomously until the goal is reached. Only escalate_to_user for: new/changed dependencies, database schema changes, deleting files, anything touching production/deployment, or a goal that is genuinely ambiguous. If a GUARD warning appears, you must escalate or have it reverted.
- Use separate Claude sessions per workstream; reuse a session when continuing the same work.
- Keep your notes current: PROJECT (what the project is, architecture, conventions), TASKS (what is being worked on and status), DECISIONS (decisions and why). They are your long-term memory.
- Talk to the user in the language they write in (usually Bosnian). Reports: short — what was done, why, what's open.

USER'S RULES (highest priority; they override everything above except safety). They define how you may talk to Claude and what Claude may know:
<rules>
${readText(P.rules).trim() || "(none)"}
</rules>

<notes name="PROJECT">
${readText(P.project).trim()}
</notes>
<notes name="TASKS">
${readText(P.tasks).trim()}
</notes>
<notes name="DECISIONS">
${readText(P.decisions).trim()}
</notes>

Claude sessions:
${sess}`;
}

let kimiCostUsd = 0;

async function kimi(cfg: Config, messages: any[]): Promise<any> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY nije postavljen");
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "kimi-lead" },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "system", content: systemPrompt() }, ...messages], tools: TOOLS, usage: { include: true } }),
    });
    if (res.ok) {
      const data: any = await res.json();
      kimiCostUsd += Number(data.usage?.cost || 0);
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error(`OpenRouter: prazan odgovor ${JSON.stringify(data).slice(0, 500)}`);
      return msg;
    }
    if (attempt >= 4 || ![408, 429, 500, 502, 503, 504].includes(res.status)) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

function trimHistory(cfg: Config, h: any[]): any[] {
  while (JSON.stringify(h).length > cfg.historyCharLimit) {
    const next = h.findIndex((m, i) => i > 0 && m.role === "user");
    if (next <= 0) break;
    h = h.slice(next);
  }
  return h;
}

function say(s: string) { stdout.write(s + "\n"); }

async function runTask(cfg: Config, rl: readline.Interface, history: any[], userMsg: string): Promise<any[]> {
  log("USER", userMsg);
  history.push({ role: "user", content: userMsg });
  const ctx: Ctx = { cfg, asks: 0, rl };
  for (let step = 0; step < cfg.maxSteps && !ctx.done; step++) {
    const msg = await kimi(cfg, history);
    const { role, content, tool_calls, reasoning, reasoning_details } = msg;
    history.push({ role, content: content ?? "", ...(tool_calls ? { tool_calls } : {}), ...(reasoning ? { reasoning } : {}), ...(reasoning_details ? { reasoning_details } : {}) });
    if (!tool_calls?.length) { ctx.done = content || "(Kimi nije ništa odgovorio)"; break; }
    if (content?.trim()) say(`  · ${content.trim().split("\n")[0].slice(0, 160)}`);
    for (const tc of tool_calls) {
      let args: any = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* keep empty */ }
      let out: string;
      try { out = await callTool(ctx, tc.function.name, args); } catch (e: any) { out = `ERROR: ${e.message}`; }
      history.push({ role: "tool", tool_call_id: tc.id, content: out });
    }
    writeJson(P.history, history);
  }
  const report = ctx.done ?? `Stao sam nakon ${cfg.maxSteps} koraka bez završetka. Pogledaj .kimi/log.md.`;
  log("Kimi → user (report)", report);
  say(`\n${report}\n`);
  say(`  [trošak ovog zadatka do sad — Kimi: $${kimiCostUsd.toFixed(3)}, Claude: $${claudeCostUsd.toFixed(3)}]`);
  writeJson(P.history, history);
  return history;
}

async function main() {
  if (["-h", "--help"].includes(process.argv[2] ?? "")) {
    say(`kimi-lead — pokreni u root folderu projekta.\n  kimi-lead            interaktivno\n  kimi-lead "zadatak"  jedan zadatak pa izlaz\nPotrebno: OPENROUTER_API_KEY, instaliran i prijavljen 'claude'.`);
    return;
  }
  const cfg = init();
  sessions = readJson(P.sessions, {});
  let history: any[] = readJson(P.history, []);
  const rl = readline.createInterface({ input: stdin, output: stdout });
  say(`kimi-lead · ${REPO}\nKomande: /new (nova Kimi konverzacija), /sessions, /rules, /exit\nPravila: ${P.rules}\n`);

  const oneShot = process.argv.slice(2).join(" ").trim();
  if (oneShot) { await runTask(cfg, rl, trimHistory(cfg, history), oneShot); rl.close(); return; }

  for (;;) {
    const line = (await rl.question("ti> ")).trim();
    if (!line) continue;
    if (line === "/exit") break;
    if (line === "/new") { history = []; writeJson(P.history, history); say("Nova konverzacija (bilješke i sesije ostaju)."); continue; }
    if (line === "/sessions") { say(await callTool({ cfg, asks: 0, rl }, "list_sessions", {})); continue; }
    if (line === "/rules") { say(readText(P.rules) || "(prazno)"); continue; }
    kimiCostUsd = 0; claudeCostUsd = 0;
    try { history = await runTask(cfg, rl, trimHistory(cfg, history), line); }
    catch (e: any) { say(`Greška: ${e.message}`); }
  }
  rl.close();
}

main();
