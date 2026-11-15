// Runs the bundled extension (dist/extension.js) in plain Node against a fake `vscode` API,
// drives the panel like the webview would, and checks the round trip.
// Usage: OPENROUTER_BASE_URL=http://127.0.0.1:PORT node dev/host-test.cjs <test-repo>
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");

const repo = path.resolve(process.argv[2]);
const extDir = path.resolve(__dirname, "..");
const log = [];
const posted = [];
let onWebviewMessage = null;
const executed = [];
const shown = [];
const providers = {};
const secrets = new Map();

class EventEmitter {
  constructor() { this.l = []; this.event = (fn) => { this.l.push(fn); return { dispose() {} }; }; }
  fire(v) { for (const fn of this.l) fn(v); }
}
const Uri = {
  file: (p) => ({ scheme: "file", fsPath: p, path: p, toString: () => `file://${p}` }),
  joinPath: (u, ...parts) => Uri.file(path.join(u.fsPath, ...parts)),
  from: (o) => ({ ...o, toString: () => `${o.scheme}:${o.path}?${o.query}` }),
  parse: (s) => ({ toString: () => s }),
};
const vscode = {
  Uri, EventEmitter,
  ViewColumn: { Active: -1, Beside: -2 },
  StatusBarAlignment: { Right: 2 },
  Position: class { constructor(l, c) { this.line = l; this.character = c; } },
  Range: class { constructor(a, b) { this.start = a; this.end = b; } },
  workspace: {
    workspaceFolders: [{ name: path.basename(repo), uri: Uri.file(repo) }],
    registerTextDocumentContentProvider: (scheme, p) => { providers[scheme] = p; return { dispose() {} }; },
    getWorkspaceFolder: () => undefined,
  },
  window: {
    activeTextEditor: undefined,
    createStatusBarItem: () => ({ show() {}, dispose() {}, text: "", tooltip: "", command: "" }),
    createWebviewPanel: (id, title) => {
      log.push(`panel: ${title}`);
      return {
        visible: true,
        webview: {
          html: "", cspSource: "vscode-resource:",
          asWebviewUri: (u) => u,
          postMessage: async (m) => { posted.push(m); return true; },
          onDidReceiveMessage: (fn) => { onWebviewMessage = fn; return { dispose() {} }; },
        },
        onDidDispose: () => ({ dispose() {} }),
        reveal() {}, dispose() {},
      };
    },
    showTextDocument: async (uri, opts) => { shown.push(uri.fsPath); },
    showWarningMessage: async (m) => log.push(`warn: ${m}`),
    showInformationMessage: async (m) => log.push(`info: ${m}`),
    showInputBox: async () => undefined,
    showQuickPick: async (items) => items[0],
    createTerminal: (o) => { log.push(`terminal: ${o.shellPath} ${o.shellArgs.join(" ")}`); return { show() {} }; },
  },
  commands: {
    _reg: {},
    registerCommand(name, fn) { this._reg[name] = fn; return { dispose() {} }; },
    async executeCommand(name, ...args) { if (this._reg[name]) return this._reg[name](...args); executed.push([name, ...args]); },
  },
  env: { openExternal: async () => true },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === "vscode" ? "vscode" : origResolve.call(this, req, ...rest); };
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscode };

const ext = require(path.join(extDir, "dist", "extension.js"));
const ctx = {
  extensionPath: extDir,
  extensionUri: Uri.file(extDir),
  subscriptions: [],
  secrets: {
    get: async (k) => secrets.get(k),
    store: async (k, v) => { secrets.set(k, v); },
    delete: async (k) => { secrets.delete(k); },
    onDidChange: () => ({ dispose() {} }),
  },
};

const send = (m) => onWebviewMessage(m);
const until = async (pred, ms = 300_000) => {
  const t = Date.now();
  while (!pred()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 200)); }
};
const events = () => posted.filter((m) => m.type === "event").map((m) => m.event);

(async () => {
  ext.activate(ctx);
  await vscode.commands.executeCommand("briefwise.open");
  assert.ok(onWebviewMessage, "webview message handler registered");

  await send({ type: "ready" });
  const init = posted.find((m) => m.type === "init");
  assert.ok(init, "init posted");
  assert.equal(init.data.hasKey, false);
  assert.equal(init.data.claudeFound, true, `claude found at ${init.data.claudeBin}`);
  assert.ok(fs.existsSync(path.join(repo, ".briefwise", "PRIVATE.md")), "templates copied into .briefwise");
  console.log("✓ init:", init.data.repoName, init.data.branch, init.data.model);

  await send({ type: "send", text: "this must not go through without a key" });
  assert.ok(posted.some((m) => m.type === "toast"), "toast when no key");
  await send({ type: "saveKey", key: "dummy-key" });
  assert.equal(secrets.get("briefwise.openrouterKey"), "dummy-key");
  assert.equal(posted.filter((m) => m.type === "state").at(-1).hasKey, true);
  console.log("✓ key saved to secret storage");

  const sendP = send({ type: "send", text: "add a check so we never divide by zero" });
  await until(() => posted.some((m) => m.type === "state" && m.busy));
  console.log("✓ busy while running");
  // interject as soon as Claude implements
  await until(() => events().some((e) => e.type === "claude-start" && e.mode === "implement"));
  await until(() => events().some((e) => e.type === "claude-event" && e.event.kind === "init" && events().filter((x) => x.type === "claude-start").length === 2));
  await send({ type: "interject", text: "Also add a one-line comment above div explaining the zero check." });
  await sendP;
  await until(() => events().some((e) => e.type === "task-end"));
  const st = posted.filter((m) => m.type === "state").at(-1);
  assert.equal(st.busy, false, "idle after task");

  const ev = events();
  const types = [...new Set(ev.map((e) => e.type))];
  console.log("✓ event types seen:", types.join(", "));
  for (const t of ["user", "lead-start", "lead-text", "lead-tool", "claude-start", "claude-event", "claude-end", "blocked", "task-end"]) assert.ok(types.includes(t), `saw ${t}`);
  assert.ok(ev.every((e) => typeof e.ts === "number"), "every event has ts");
  const acked = ev.some((e) => e.type === "claude-event" && e.event.kind === "user");
  console.log(acked ? "✓ interjection acknowledged by Claude" : "• interjection not acknowledged (Claude may have finished first)");
  const files = ev.find((e) => e.type === "claude-files");
  console.log(files ? `✓ claude-files: ${files.files.map((f) => f.file).join(", ")}` : "• no claude-files event");

  // transcript persisted, deltas coalesced
  const tp = path.join(repo, ".briefwise", "transcript.json");
  await until(() => fs.existsSync(tp));
  const tr = JSON.parse(fs.readFileSync(tp, "utf8"));
  assert.ok(tr.length > 5 && tr.length < ev.length, `transcript compacted (${tr.length} < ${ev.length})`);
  assert.ok(!tr.some((e) => e.type === "lead-reasoning"), "no reasoning in transcript");
  console.log(`✓ transcript saved: ${tr.length} events (live stream had ${ev.length})`);

  // reload: a new "ready" gets the transcript back
  posted.length = 0;
  await send({ type: "ready" });
  assert.equal(posted.find((m) => m.type === "init").data.transcript.length, tr.length);
  console.log("✓ reload restores transcript");

  // file + diff + notes + resume
  await send({ type: "openFile", path: "math.js", line: 2 });
  await send({ type: "openFile", path: "../outside.txt" });
  assert.equal(shown.filter((p) => p.endsWith("math.js")).length, 1);
  assert.equal(shown.length, 1, "path outside repo ignored");
  await send({ type: "openDiff", path: "math.js" });
  const diff = executed.find((x) => x[0] === "vscode.diff");
  assert.ok(diff, "vscode.diff executed");
  const base = providers["briefwise-base"].provideTextDocumentContent(diff[1]);
  assert.ok(base.includes("function div(a, b) { return a / b; }"), "base content is HEAD version");
  console.log("✓ diff opens HEAD ↔ working copy:", diff[3]);
  await send({ type: "openNote", name: "RULES" });
  assert.ok(shown.at(-1).endsWith(path.join(".briefwise", "RULES.md")));
  await send({ type: "resume", session: "math" });
  assert.ok(log.some((l) => l.startsWith("terminal:") && l.includes("--resume")), "resume opens terminal with --resume");
  console.log("✓ notes, resume:", log.find((l) => l.startsWith("terminal:")));

  // session control: context shown, compact between tasks (busy while it runs), fresh session, auto-compact toggle
  const initSessions = posted.find((m) => m.type === "init").data.sessions;
  const math = initSessions.find((s) => s.name === "math");
  assert.ok(math && math.started && math.contextTokens > 0 && math.contextWindow === 200000, "init carries session context");
  assert.equal(posted.find((m) => m.type === "init").data.autoCompact, true);
  posted.length = 0;
  await send({ type: "compact", session: "math", focus: "keep the zero check" });
  const cs = events().find((e) => e.type === "claude-start" && e.mode === "compact");
  assert.deepEqual([cs.by, cs.prompt], ["user", "/compact keep the zero check"]);
  assert.ok(posted.some((m) => m.type === "state" && m.busy) && posted.filter((m) => m.type === "state").at(-1).busy === false, "busy while compacting, idle after");
  assert.equal(posted.filter((m) => m.type === "sessions").at(-1).sessions.find((s) => s.name === "math").contextTokens, 1600);
  assert.ok(!events().some((e) => e.type === "sessions"), "session state is posted live, not as transcript events");
  await send({ type: "freshSession", session: "math" });
  assert.equal(posted.filter((m) => m.type === "sessions").at(-1).sessions.find((s) => s.name === "math").started, false);
  assert.ok(events().some((e) => e.type === "session-fresh" && e.session === "math"));
  await send({ type: "compact", session: "math", focus: "" });
  assert.match(posted.filter((m) => m.type === "toast").at(-1).text, /no Claude conversation/);
  await send({ type: "setAutoCompact", on: false });
  assert.equal(posted.filter((m) => m.type === "config").at(-1).autoCompact, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, ".briefwise", "config.json"), "utf8")).claude.autoCompact, false);
  console.log("✓ sessions: context shown, compact (41k → 2k), fresh session, auto-compact off saved");

  await send({ type: "newConversation" });
  assert.ok(posted.some((m) => m.type === "reset"));
  assert.equal(JSON.parse(fs.readFileSync(tp, "utf8")).length, 0);
  console.log("✓ new conversation clears transcript");
  console.log("ALL HOST CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e); console.error(log.join("\n")); process.exit(1); });
