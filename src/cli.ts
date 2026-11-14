// Terminal UI for kimi-lead: chat with the lead, watch Claude Code work live.

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
  console.log(`kimi-lead: run it in the project's root folder.
  kimi-lead            interactive
  kimi-lead "task"     run one task, then exit
While running: Ctrl+C stops the task; while Claude is working, anything you type goes straight to Claude.
Requires: OPENROUTER_API_KEY and an installed, signed-in 'claude'.`);
  process.exit(0);
}

let kimiOpen = false;
let thinking = false;

function render(lead: Lead, e: LeadEvent) {
  switch (e.type) {
    case "kimi-start":
      kimiOpen = false; thinking = false;
      break;
    case "kimi-reasoning":
      if (!thinking && !kimiOpen) { line(c.dim(`  ${leadName(lead.cfg.model)} is thinking…`)); thinking = true; }
      break;
    case "kimi-text":
      if (!kimiOpen) { line(); out(c.cyan(c.bold(`${leadName(lead.cfg.model)}  `))); kimiOpen = true; }
      out(e.delta);
      break;
    case "kimi-end":
      if (kimiOpen) line();
      break;
    case "kimi-tool":
      line(c.dim(`  · ${e.label}`));
      break;
    case "claude-start": {
      line();
      line(c.magenta(`┌─ Claude · ${e.session} · ${e.mode === "ask" ? "consultation (read-only)" : "implementation"}`));
      line(bar + c.dim(`${leadName(lead.cfg.model)} → Claude:`));
      for (const l of e.prompt.trim().split("\n")) line(bar + c.dim(l));
      line(c.magenta("│"));
      break;
    }
    case "claude-event": {
      const ev = e.event;
      if (ev.kind === "text") {
        const ls = ev.text.trim().split("\n");
        for (const l of ls.slice(0, 20)) line(bar + l);
        if (ls.length > 20) line(bar + c.dim(`… (${ls.length - 20} more lines in .kimi/log.md)`));
      } else if (ev.kind === "user") {
        line(bar + c.cyan(c.bold("you → Claude: ")) + ev.text);
      } else if (ev.kind === "tool") {
        const paint = TOOL_COLOR[ev.name] ?? c.green;
        line(bar + paint(`● ${ev.name}`) + " " + describeTool(lead.repo, ev.name, ev.input));
      } else if (ev.kind === "tool_result" && ev.isError) {
        line(bar + c.red(`  ✗ ${ev.text.split("\n")[0].slice(0, 200)}`));
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
    case "task-end":
      if (!e.streamed) { line(); line(c.cyan(c.bold(`${leadName(lead.cfg.model)}  `)) + e.report); }
      line(c.dim(`  [task cost:${leadName(lead.cfg.model)} $${e.kimiUsd.toFixed(3)} · Claude $${e.claudeUsd.toFixed(3)}]`));
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

rl.on("line", async (raw) => {
  const text = raw.trim();
  if (pendingAnswer) { const r = pendingAnswer; pendingAnswer = null; r(text); return; }
  if (lead.busy) {
    if (!text) return;
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
  if (text === "/sessions") { line(lead.listSessions()); rl.prompt(); return; }
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

line(`${c.bold("kimi-lead")} · ${lead.repo}`);
line(c.dim(`Lead: ${lead.cfg.model} · Claude Code: ${lead.claudeBin} (model: ${lead.cfg.claude.model ?? "your default"})`));
line(c.dim("Commands: /new  /model [id]  /claude [opus|sonnet|haiku|default]  /sessions  /rules  /private  /exit · Ctrl+C stops the task"));

const task = process.argv.slice(2).join(" ").trim();
if (task) {
  oneShot = true;
  await runTask(task);
  process.exit(0);
} else {
  rl.prompt();
}
