// Terminal UI for Briefwise: chat with the lead, watch Claude Code work live.

import * as readline from "node:readline";
import { stdin, stdout } from "node:process";
import { Lead, type LeadEvent } from "./lead.ts";
import { describeTool } from "./format.ts";
import { readText } from "./config.ts";
import { leadName } from "./names.ts";

const color = stdout.isTTY && !process.env.NO_COLOR;
const sgr = (a: number, b: number) => (s: string) => (color ? `\x1b[${a}m${s}\x1b[${b}m` : s);
const c = {
  bold: sgr(1, 22), dim: sgr(2, 22), red: sgr(31, 39), green: sgr(32, 39),
  yellow: sgr(33, 39), blue: sgr(34, 39), magenta: sgr(35, 39), cyan: sgr(36, 39),
};

let atLineStart = true;
function out(s: string) { if (s) { stdout.write(s); atLineStart = s.endsWith("\n"); } }
function line(s = "") { if (!atLineStart) out("\n"); out(s + "\n"); }

const bar = c.magenta("│ ");
const TOOL_COLOR: Record<string, (s: string) => string> = { Edit: c.yellow, MultiEdit: c.yellow, Write: c.yellow, Bash: c.blue };

if (["-h", "--help"].includes(process.argv[2] ?? "")) {
  console.log(`briefwise: run it in the project's root folder.
  briefwise            interactive
  briefwise "task"     run one task, then exit
While running: Ctrl+C stops the task; while Claude is working, anything you type goes straight to Claude.
Sessions: /sessions shows how full each Claude session is; /compact [session] [what to keep] compacts one;
/fresh [session] starts it over; /autocompact on|off decides whether Claude may compact on its own.
Requires: OPENROUTER_API_KEY and an installed, signed-in 'claude'.`);
  process.exit(0);
}

let leadOpen = false;
let thinking = false;
let lastSession = ""; // the session /compact and /fresh act on when none is named
let compactingShown = false;

const ktok = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function render(lead: Lead, e: LeadEvent) {
  switch (e.type) {
    case "lead-start":
      leadOpen = false; thinking = false;
      break;
    case "lead-reasoning":
      if (!thinking && !leadOpen) { line(c.dim(`  ${leadName(lead.cfg.model)} is thinking…`)); thinking = true; }
      break;
    case "lead-text":
      if (!leadOpen) { line(); out(c.cyan(c.bold(`${leadName(lead.cfg.model)}  `))); leadOpen = true; }
      out(e.delta);
      break;
    case "lead-end":
      if (leadOpen) line();
      break;
    case "lead-tool":
      line(c.dim(`  · ${e.label}`));
      break;
    case "claude-start": {
      lastSession = e.session;
      compactingShown = false;
      line();
      line(c.magenta(`┌─ Claude · ${e.session} · ${e.mode === "ask" ? "consultation (read-only)" : e.mode === "compact" ? "compaction" : "implementation"}`));
      line(bar + c.dim(`${e.by === "user" ? "you" : leadName(lead.cfg.model)} → Claude:`));
      for (const l of e.prompt.trim().split("\n")) line(bar + c.dim(l));
      line(c.magenta("│"));
      break;
    }
    case "claude-event": {
      const ev = e.event;
      if (ev.kind === "text") {
        const ls = ev.text.trim().split("\n");
        for (const l of ls.slice(0, 20)) line(bar + l);
        if (ls.length > 20) line(bar + c.dim(`… (${ls.length - 20} more lines in .briefwise/log.md)`));
      } else if (ev.kind === "user") {
        line(bar + c.cyan(c.bold("you → Claude: ")) + ev.text);
      } else if (ev.kind === "tool") {
        const paint = TOOL_COLOR[ev.name] ?? c.green;
        line(bar + paint(`● ${ev.name}`) + " " + describeTool(lead.repo, ev.name, ev.input));
      } else if (ev.kind === "tool_result" && ev.isError) {
        line(bar + c.red(`  ✗ ${ev.text.split("\n")[0].slice(0, 200)}`));
      } else if (ev.kind === "compacting") {
        if (!compactingShown) line(bar + c.dim("compacting the conversation…"));
        compactingShown = true; // Claude repeats this status while it works
      } else if (ev.kind === "compacted") {
        line(bar + c.yellow(`⇣ ${ev.trigger === "manual" ? "compacted" : "Claude compacted on its own"}: ${ktok(ev.pre)} → ${ktok(ev.post)} tokens`));
      }
      break;
    }
    case "claude-end": {
      const r = e.result;
      const status = r.stopped ? c.yellow("stopped") : r.isError ? c.red("error") : c.green("done");
      line(c.magenta("└─ ") + status + c.dim(r.costUsd ? ` · $${r.costUsd.toFixed(3)}` : ""));
      if (r.isError && !r.stopped) line(c.red(r.text.split("\n").slice(0, 6).join("\n")));
      break;
    }
    case "guard":
      line(c.yellow(`⚠ Guard: ${e.issues.join(", ")}`));
      break;
    case "blocked":
      line(c.yellow(`⛔ ${e.reason}`));
      break;
    case "notice":
      line(c.yellow(`ℹ ${e.text}`));
      break;
    case "session-fresh":
      line(c.yellow(`ℹ Session ${e.session} starts a fresh Claude conversation on its next run${e.by === "lead" ? ` (${leadName(lead.cfg.model)}, as you asked)` : ""}.`));
      break;
    case "task-end":
      if (!e.streamed) { line(); line(c.cyan(c.bold(`${leadName(lead.cfg.model)}  `)) + e.report); }
      line(c.dim(`  [task cost:${leadName(lead.cfg.model)} $${e.leadUsd.toFixed(3)} · Claude $${e.claudeUsd.toFixed(3)}]`));
      break;
  }
}

const rl = readline.createInterface({ input: stdin, output: stdout, prompt: "you> " });
let pendingAnswer: ((s: string | null) => void) | null = null;
let stdinClosed = false;
let oneShot = false;

const lead = new Lead(process.cwd(), {
  emit: (e) => render(lead, e),
  askUser: (q) => {
    if (stdinClosed) return Promise.resolve(null);
    line();
    line(c.yellow(c.bold(`❓ ${leadName(lead.cfg.model)} asks:`)));
    line(q);
    return new Promise((res) => { pendingAnswer = res; rl.prompt(); });
  },
});

async function runTask(text: string) {
  try { await lead.run(text); } catch (e: any) { line(c.red(`Error: ${e.message}`)); }
}

function sessionsTable(): string {
  const rows = lead.sessionInfo();
  if (!rows.length) return "(no Claude sessions yet)";
  return rows.map((s) => {
    const ctx = !s.started ? "fresh" : !s.contextTokens ? "size unknown"
      : s.contextWindow ? `${ktok(s.contextTokens)} / ${ktok(s.contextWindow)} (${Math.round((s.contextTokens / s.contextWindow) * 100)}%)` : ktok(s.contextTokens);
    return `  ${s.name.padEnd(14)} ${ctx.padEnd(18)} ${c.dim(s.purpose)}${s.live ? c.green("  ● working") : ""}${s.compactQueued ? c.yellow("  compaction queued") : ""}`;
  }).join("\n");
}

/** "/compact [session] [what to keep]": the first word names a session if one has that name. */
function sessionArg(rest: string): { name: string; tail: string } {
  const [first = "", ...more] = rest.trim().split(/\s+/);
  if (first && lead.sessions[first]) return { name: first, tail: more.join(" ") };
  const fallback = lastSession && lead.sessions[lastSession] ? lastSession : Object.keys(lead.sessions).at(-1) ?? "";
  return { name: fallback, tail: rest.trim() };
}

/** Session commands work while a task runs too (they are not sent to Claude). Returns true if handled. */
async function sessionCommand(text: string): Promise<boolean> {
  if (text === "/sessions") { line(sessionsTable()); return true; }
  if (text === "/compact" || text.startsWith("/compact ")) {
    const { name, tail } = sessionArg(text.slice(8));
    if (!name) { line(c.red("No Claude session yet.")); return true; }
    try { await lead.compact(name, tail); } catch (e: any) { line(c.red(e.message)); } // progress is printed by render()
    return true;
  }
  if (text === "/fresh" || text.startsWith("/fresh ")) {
    const arg = text.slice(6).trim();
    if (arg && !lead.sessions[arg]) { line(c.red(`There is no session "${arg}". /sessions lists them.`)); return true; } // never reset a different one
    const { name } = sessionArg(arg);
    if (!name) { line(c.red("No Claude session yet.")); return true; }
    try { lead.freshSession(name); } catch (e: any) { line(c.red(e.message)); }
    return true;
  }
  if (text === "/autocompact" || text.startsWith("/autocompact ")) {
    const v = text.slice(12).trim();
    if (v === "on" || v === "off") { try { lead.setAutoCompact(v === "on"); } catch (e: any) { line(c.red(e.message)); return true; } }
    line(lead.cfg.claude.autoCompact ? "Auto-compact: on (Claude compacts by itself when its context is nearly full)" : "Auto-compact: off (Claude only compacts when you say /compact)");
    return true;
  }
  return false;
}

rl.on("line", async (raw) => {
  const text = raw.trim();
  if (pendingAnswer) { const r = pendingAnswer; pendingAnswer = null; r(text); return; }
  if (lead.busy) {
    if (!text) return;
    if (/^\/(sessions|compact|fresh|autocompact)\b/.test(text)) { await sessionCommand(text); return; }
    if (lead.interject(text)) line(c.dim("  → sent straight to Claude"));
    else line(c.dim(`  (${leadName(lead.cfg.model)} is working; wait, or press Ctrl+C to stop)`));
    return;
  }
  if (!text) { rl.prompt(); return; }
  if (text === "/exit") { rl.close(); return; }
  if (text === "/new") { lead.newConversation(); line("New conversation (notes and sessions are kept)."); rl.prompt(); return; }
  if (text === "/model" || text.startsWith("/model ")) {
    const id = text.slice(6).trim();
    if (id) { try { lead.setModel(id); line(`Lead model: ${id}`); } catch (e: any) { line(c.red(e.message)); } }
    else line(`Lead model: ${lead.cfg.model}`);
    rl.prompt(); return;
  }
  if (text === "/claude" || text.startsWith("/claude ")) {
    const m = text.slice(7).trim();
    if (m) { try { lead.setClaudeModel(m === "default" ? null : m); line(`Claude Code model: ${m}`); } catch (e: any) { line(c.red(e.message)); } }
    else line(`Claude Code model: ${lead.cfg.claude.model ?? "your default"}`);
    rl.prompt(); return;
  }
  if (await sessionCommand(text)) { rl.prompt(); return; }
  if (text === "/rules") { line(readText(lead.P.rules) || "(empty)"); rl.prompt(); return; }
  if (text === "/private") { line(readText(lead.P.private) || "(empty)"); rl.prompt(); return; }
  await runTask(text);
  if (stdinClosed) process.exit(0);
  rl.prompt();
});

rl.on("SIGINT", () => {
  if (lead.busy) { line(c.yellow("■ stopping…")); lead.stop(); }
  else rl.close();
});

rl.on("close", () => {
  stdinClosed = true;
  if (pendingAnswer) { const r = pendingAnswer; pendingAnswer = null; r(null); }
  if (!lead.busy && !oneShot) process.exit(0);
});

line(`${c.bold("Briefwise")} · ${lead.repo}`);
line(c.dim(`Lead: ${lead.cfg.model} · Claude Code: ${lead.claudeBin} (model: ${lead.cfg.claude.model ?? "your default"})`));
line(c.dim("Commands: /new  /model [id]  /claude [opus|sonnet|haiku|default]  /sessions  /compact [session] [keep…]  /fresh [session]  /autocompact on|off  /rules  /private  /exit · Ctrl+C stops the task"));

const task = process.argv.slice(2).join(" ").trim();
if (task) {
  oneShot = true;
  await runTask(task);
  process.exit(0);
} else {
  rl.prompt();
}
