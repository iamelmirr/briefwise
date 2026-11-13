// Terminal UI for kimi-lead: chat with Kimi, watch Claude Code work live.

import * as readline from "node:readline";
import { stdin, stdout } from "node:process";
import { Lead, type LeadEvent } from "./lead.ts";
import { describeTool } from "./format.ts";
import { readText } from "./config.ts";

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
  console.log(`kimi-lead: pokreni u root folderu projekta.
  kimi-lead            interaktivno
  kimi-lead "zadatak"  jedan zadatak pa izlaz
Dok radi: Ctrl+C zaustavlja zadatak; kad Claude radi, otkucana poruka ide direktno njemu.
Potrebno: OPENROUTER_API_KEY i instaliran, prijavljen 'claude'.`);
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
      if (!thinking && !kimiOpen) { line(c.dim("  Kimi razmišlja…")); thinking = true; }
      break;
    case "kimi-text":
      if (!kimiOpen) { line(); out(c.cyan(c.bold("Kimi  "))); kimiOpen = true; }
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
      line(c.magenta(`┌─ Claude · ${e.session} · ${e.mode === "ask" ? "konsultacija (read-only)" : "implementacija"}`));
      line(bar + c.dim("Kimi → Claude:"));
      for (const l of e.prompt.trim().split("\n")) line(bar + c.dim(l));
      line(c.magenta("│"));
      break;
    }
    case "claude-event": {
      const ev = e.event;
      if (ev.kind === "text") {
        const ls = ev.text.trim().split("\n");
        for (const l of ls.slice(0, 20)) line(bar + l);
        if (ls.length > 20) line(bar + c.dim(`… (${ls.length - 20} linija više u .kimi/log.md)`));
      } else if (ev.kind === "user") {
        line(bar + c.cyan(c.bold("ti → Claude: ")) + ev.text);
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
      const status = r.stopped ? c.yellow("zaustavljeno") : r.isError ? c.red("greška") : c.green("gotovo");
      line(c.magenta("└─ ") + status + c.dim(r.costUsd ? ` · $${r.costUsd.toFixed(3)}` : ""));
      if (r.isError && !r.stopped) line(c.red(r.text.split("\n").slice(0, 6).join("\n")));
      break;
    }
    case "guard":
      line(c.yellow(`⚠ Zaštita: ${e.issues.join(", ")}`));
      break;
    case "blocked":
      line(c.yellow(`⛔ ${e.reason}`));
      break;
    case "notice":
      line(c.yellow(`ℹ ${e.text}`));
      break;
    case "task-end":
      if (!e.streamed) { line(); line(c.cyan(c.bold("Kimi  ")) + e.report); }
      line(c.dim(`  [trošak zadatka: Kimi $${e.kimiUsd.toFixed(3)} · Claude $${e.claudeUsd.toFixed(3)}]`));
      break;
  }
}

const rl = readline.createInterface({ input: stdin, output: stdout, prompt: "ti> " });
let pendingAnswer: ((s: string | null) => void) | null = null;
let stdinClosed = false;
let oneShot = false;

const lead = new Lead(process.cwd(), {
  emit: (e) => render(lead, e),
  askUser: (q) => {
    if (stdinClosed) return Promise.resolve(null);
    line();
    line(c.yellow(c.bold("❓ Kimi pita:")));
    line(q);
    return new Promise((res) => { pendingAnswer = res; rl.prompt(); });
  },
});

async function runTask(text: string) {
  try { await lead.run(text); } catch (e: any) { line(c.red(`Greška: ${e.message}`)); }
}

rl.on("line", async (raw) => {
  const text = raw.trim();
  if (pendingAnswer) { const r = pendingAnswer; pendingAnswer = null; r(text); return; }
  if (lead.busy) {
    if (!text) return;
    if (lead.interject(text)) line(c.dim("  → poslano direktno Claudeu"));
    else line(c.dim("  (Kimi radi; sačekaj, ili Ctrl+C za stop)"));
    return;
  }
  if (!text) { rl.prompt(); return; }
  if (text === "/exit") { rl.close(); return; }
  if (text === "/new") { lead.newConversation(); line("Nova konverzacija (bilješke i sesije ostaju)."); rl.prompt(); return; }
  if (text === "/sessions") { line(lead.listSessions()); rl.prompt(); return; }
  if (text === "/rules") { line(readText(lead.P.rules) || "(prazno)"); rl.prompt(); return; }
  if (text === "/private") { line(readText(lead.P.private) || "(prazno)"); rl.prompt(); return; }
  await runTask(text);
  if (stdinClosed) process.exit(0);
  rl.prompt();
});

rl.on("SIGINT", () => {
  if (lead.busy) { line(c.yellow("■ zaustavljam…")); lead.stop(); }
  else rl.close();
});

rl.on("close", () => {
  stdinClosed = true;
  if (pendingAnswer) { const r = pendingAnswer; pendingAnswer = null; r(null); }
  if (!lead.busy && !oneShot) process.exit(0);
});

line(`${c.bold("kimi-lead")} · ${lead.repo}`);
line(c.dim(`Kimi: ${lead.cfg.model} · Claude: ${lead.claudeBin}`));
line(c.dim("Komande: /new  /sessions  /rules  /private  /exit · Ctrl+C zaustavlja zadatak"));

const task = process.argv.slice(2).join(" ").trim();
if (task) {
  oneShot = true;
  await runTask(task);
  process.exit(0);
} else {
  rl.prompt();
}
