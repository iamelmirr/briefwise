#!/usr/bin/env node
// A tiny stand-in for the Claude Code CLI, speaking its stream-json protocol, for offline tests.
// Used via claude.path = <this file> (src/claude.ts runs .js/.mjs/.cjs "binaries" with the current Node).
//
// For each user message on stdin it:
//   - echoes it back with isReplay: true when --replay-user-messages is passed
//   - emits system/init (session id from --resume, or a new one) and the model
//   - if the message contains [fake:hang]: stops there and waits (for stop() tests)
//   - if the message contains [fake:edit <path>] and the mode is acceptEdits: emits an Edit tool_use,
//     really appends a line to <path> (relative to cwd), then emits the tool_result
//   - emits a final assistant text ending with "REPORT: …" and a result event with total_cost_usd
// It exits when stdin ends.
//
// If FAKE_CLAUDE_LOG is set, it appends JSON lines there: {event:"start", pid, argv, cwd} and {event:"message", pid, text}.

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const replay = argv.includes("--replay-user-messages");
const mode = flag("--permission-mode") ?? "default";
const model = flag("--model") ?? "fake-claude-model";
const sessionId = flag("--resume") ?? `fake-session-${process.pid}-${Date.now().toString(36)}`;
const logFile = process.env.FAKE_CLAUDE_LOG;

const log = (rec) => {
  if (logFile) fs.appendFileSync(logFile, JSON.stringify({ ...rec, pid: process.pid }) + "\n");
};
const out = (e) => process.stdout.write(JSON.stringify(e) + "\n");

log({ event: "start", argv, cwd: process.cwd() });

let turn = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  const content = msg.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => b?.text ?? "").join("\n") : "";
  log({ event: "message", text });
  turn++;

  if (replay) out({ type: "user", message: msg.message, session_id: sessionId, isReplay: true });
  out({ type: "system", subtype: "init", session_id: sessionId, model, cwd: process.cwd(), tools: ["Read", "Edit"] });
  if (text.includes("[fake:hang]")) return; // wait for stop()

  const edit = /\[fake:edit ([^\]]+)\]/.exec(text);
  let changed = "";
  if (edit && mode === "acceptEdits") {
    const rel = edit[1].trim();
    const abs = path.join(process.cwd(), rel);
    const id = `toolu_fake_${turn}`;
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const added = `// edited by fake claude (turn ${turn})\n`;
    out({
      type: "assistant", session_id: sessionId,
      message: { role: "assistant", content: [{ type: "tool_use", id, name: "Edit", input: { file_path: abs, old_string: before, new_string: before + added } }] },
    });
    fs.writeFileSync(abs, before + added);
    out({
      type: "user", session_id: sessionId,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `The file ${abs} has been updated.`, is_error: false }] },
    });
    changed = rel;
  }

  const report = `REPORT: ${changed ? `edited ${changed}` : "investigated, no changes"} (mode ${mode}).`;
  out({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [{ type: "text", text: `All done.\n\n${report}` }] } });
  out({
    type: "result", subtype: "success", is_error: false, session_id: sessionId,
    result: `All done.\n\n${report}`, total_cost_usd: 0.0125, num_turns: 1,
  });
});
rl.on("close", () => process.exit(0));
