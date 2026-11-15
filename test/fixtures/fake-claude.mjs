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
//   - if the message starts with /compact: behaves like Claude Code's compaction (status, compact_boundary
//     with pre/post tokens, a replayed "Compacted" note, an empty result) and does nothing else
//   - emits a final assistant text ending with "REPORT: …" (with usage: the context grows 1000 tokens per turn,
//     from 40000) and a result event with total_cost_usd and modelUsage.contextWindow 200000
// It exits when stdin ends.
// FAKE_CLAUDE_ENV_LOG: if set, the start record also carries DISABLE_AUTO_COMPACT.
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

log({ event: "start", argv, cwd: process.cwd(), disableAutoCompact: process.env.DISABLE_AUTO_COMPACT ?? null });

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

  if (text.startsWith("/compact")) {
    out({ type: "system", subtype: "status", status: "compacting", session_id: sessionId });
    out({ type: "system", subtype: "status", status: null, compact_result: "success", session_id: sessionId });
    out({ type: "system", subtype: "init", session_id: sessionId, model, cwd: process.cwd(), tools: ["Read", "Edit"] });
    out({ type: "system", subtype: "compact_boundary", session_id: sessionId, compact_metadata: { trigger: "manual", pre_tokens: 41000, post_tokens: 1600 } });
    out({ type: "user", session_id: sessionId, isSynthetic: true, message: { role: "user", content: "This session is being continued from a previous conversation…" } });
    if (replay) out({ type: "user", session_id: sessionId, isReplay: true, message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } });
    out({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: "", total_cost_usd: 0.002, num_turns: 0 });
    return;
  }
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
  const usage = { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 39000 + turn * 1000 - 1000, output_tokens: 8 };
  out({ type: "assistant", session_id: sessionId, message: { role: "assistant", usage, content: [{ type: "text", text: `All done.\n\n${report}` }] } });
  out({
    type: "result", subtype: "success", is_error: false, session_id: sessionId,
    result: `All done.\n\n${report}`, total_cost_usd: 0.0125, num_turns: 1,
    modelUsage: { [model]: { contextWindow: 200000 } },
  });
});
rl.on("close", () => process.exit(0));
