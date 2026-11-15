// `npm test` for the extension: fully offline.
// Creates a throwaway git repo, starts a scripted mock OpenRouter, points Claude at the fake CLI
// from ../test/fixtures, then runs dev/host-test.cjs (the bundled extension against a fake vscode API).
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..");
const fakeClaude = path.resolve(ext, "..", "test", "fixtures", "fake-claude.mjs");

// 1. a small repo, committed, with a secret the lead must not read
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "briefwise-host-"));
const git = (...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: repo, stdio: "pipe" });
fs.writeFileSync(path.join(repo, "math.js"), "function div(a, b) { return a / b; }\nmodule.exports = { div };\n");
fs.writeFileSync(path.join(repo, ".env"), "API_SECRET=never-send-this\n");
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-qm", "init");
fs.mkdirSync(path.join(repo, ".briefwise"));
fs.writeFileSync(path.join(repo, ".briefwise", "config.json"), JSON.stringify({ claude: { path: fakeClaude }, forbidden: ["ACME"] }, null, 2));

// 2. the lead's script: read, try a forbidden brief, consult, implement, review, finish
const tc = (name, args) => ({ name, args });
const STEPS = [
  { text: "I'll look at math.js.", calls: [tc("read_file", { path: "math.js" })] },
  { calls: [tc("grep", { pattern: "div" }), tc("read_file", { path: ".env" })] },
  { calls: [tc("implement", { session: "math", prompt: "For our client ACME, add a check." }),
            tc("ask_claude", { session: "math", prompt: "How should div(a, b) handle b === 0? Two options, one line each." })] },
  { text: "Going with throwing an error.", calls: [tc("implement", { session: "math", prompt: "In math.js, make div throw on b === 0. [fake:edit math.js]" })] },
  { calls: [tc("git", { args: ["diff"] })] },
  { calls: [tc("update_notes", { file: "TASKS", content: "- div(b=0) throws: done\n" })] },
  { calls: [tc("finish", { report: "Done: `div` now throws when b is 0. Only math.js changed." })] },
];
let n = 0;
let leaked = false;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d)).on("end", () => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "moonshotai/kimi-k3.1-pro", name: "Kimi K3.1 Pro", supported_parameters: ["tools"], pricing: { prompt: "0.000002", completion: "0.00001" }, context_length: 1048576, created: 1 }] }));
      return;
    }
    if (body.includes("never-send-this")) leaked = true;
    const step = STEPS[n++] ?? { text: "ok" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ choices: [{ delta: { reasoning: "thinking…" } }] });
    for (const w of (step.text ?? "").split(/(?<= )/)) if (w) send({ choices: [{ delta: { content: w } }] });
    (step.calls ?? []).forEach((c, index) => {
      const a = JSON.stringify(c.args), mid = Math.floor(a.length / 2);
      send({ choices: [{ delta: { tool_calls: [{ index, id: `call_${n}_${index}`, type: "function", function: { name: c.name, arguments: a.slice(0, mid) } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: a.slice(mid) } }] } }] });
    });
    send({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1000, cost: 0.001, prompt_tokens_details: { cached_tokens: 800 } } });
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// 3. run the host test against it
const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(here, "host-test.cjs"), repo], {
    cwd: ext, stdio: "inherit",
    env: { ...process.env, OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/api/v1` },
  });
  child.on("exit", (c) => resolve(c ?? 1));
});
server.close();
fs.rmSync(repo, { recursive: true, force: true });
if (leaked) { console.error("FAILED: .env content reached the lead model"); process.exit(1); }
process.exit(code);
