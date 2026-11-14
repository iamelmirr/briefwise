// Demo transcript for dev/preview.html. Mirrors the real UIEvent stream.
(function () {
  const REPO = "C:\\Users\\dev\\projects\\shop-api";
  const t0 = Date.now() - 95_000;
  let t = t0;
  const at = (dt) => (t += dt);
  const ev = [];
  const e = (dt, o) => ev.push({ ...o, ts: at(dt) });
  const ce = (dt, session, event) => e(dt, { type: "claude-event", session, event });

  e(0, { type: "user", text: "add rate limiting to /api/orders, max 30 requests per minute per user. don't touch the other routes" });
  e(400, { type: "kimi-start" });
  e(900, { type: "kimi-tool", name: "read_file", label: "reads src/routes/orders.ts 1–120" });
  e(300, { type: "kimi-tool", name: "grep", label: "searches \"rateLimit|limiter\"" });
  e(200, { type: "kimi-tool", name: "list_files", label: "lists files (middleware)" });
  e(1200, { type: "kimi-text", delta: "There's no existing limiter, and `src/middleware/` already has a pattern for Express middleware. Asking Claude for options without a new dependency." });
  e(100, { type: "kimi-end", promptTokens: 6120, cachedTokens: 4800 });

  const askPrompt = `Investigate src/routes/orders.ts and src/middleware/.
Goal: per-user rate limiting on /api/orders only, max 30 requests per 60 s window.
Constraints: no new dependencies; other routes must be unaffected.
Propose 2-3 implementation options with trade-offs (storage, where to hook in, behaviour behind multiple instances) and say which fits the existing middleware pattern best. Do not modify anything.`;
  e(300, { type: "claude-start", session: "orders", mode: "ask", prompt: askPrompt });
  ce(1800, "orders", { kind: "init", sessionId: "a1", model: "claude-opus-5-5" });
  ce(900, "orders", { kind: "tool", id: "t1", name: "Glob", input: { pattern: "src/middleware/**" } });
  ce(300, "orders", { kind: "tool_result", id: "t1", isError: false, text: "src/middleware/auth.ts\nsrc/middleware/errors.ts" });
  ce(400, "orders", { kind: "tool", id: "t2", name: "Read", input: { file_path: REPO + "\\src\\routes\\orders.ts" } });
  ce(200, "orders", { kind: "tool_result", id: "t2", isError: false, text: "…" });
  ce(400, "orders", { kind: "tool", id: "t3", name: "Read", input: { file_path: REPO + "\\src\\middleware\\auth.ts" } });
  ce(200, "orders", { kind: "tool_result", id: "t3", isError: false, text: "…" });
  ce(500, "orders", { kind: "tool", id: "t4", name: "Grep", input: { pattern: "redis|ioredis", path: REPO } });
  ce(300, "orders", { kind: "tool_result", id: "t4", isError: false, text: "No matches found" });
  ce(4200, "orders", { kind: "text", text: "Three options fit:\n\n1. **Fixed window in memory**: a `Map<userId, {count, resetAt}>` in a new `rateLimit.ts`. Simplest; resets abruptly at the window edge.\n2. **Sliding window in memory**: keep the last 30 timestamps per user. Smooth limiting, small memory cost. Same middleware shape as `requireAuth`.\n3. **Redis**: correct across instances, but needs a new dependency and infra.\n\nThe repo runs a single instance (`Dockerfile`, no cluster), so option 2 fits best.\n\nREPORT: read-only, no changes. Recommend option 2." });
  e(600, { type: "claude-end", session: "orders", result: { text: "…", isError: false, costUsd: 0.084, sessionId: "a1" } });

  e(300, { type: "kimi-start" });
  e(1500, { type: "kimi-text", delta: "Going with **option 2**, an in-memory sliding window: no new dependency, and the app runs as a single instance. Handing it to Claude to implement." });
  e(100, { type: "kimi-end", promptTokens: 8410, cachedTokens: 6900 });

  const implPrompt = `Implement option 2 (sliding window, in memory) as Express middleware.
- New file src/middleware/rateLimit.ts exporting rateLimit({ limit, windowMs }) keyed by req.user.id.
- Apply it only to the /api/orders router in src/routes/orders.ts: limit 30, windowMs 60_000.
- When exceeded respond 429 with JSON { error: "rate_limited" }.
- Follow the style of src/middleware/auth.ts. Add a unit test next to the existing route tests and run: npm test -- orders.`;
  e(300, { type: "claude-start", session: "orders", mode: "implement", prompt: implPrompt });
  ce(1700, "orders", { kind: "init", sessionId: "a1", model: "claude-opus-5-5" });
  ce(600, "orders", { kind: "tool", id: "u1", name: "TodoWrite", input: { todos: [
    { content: "Write sliding-window middleware", status: "completed" },
    { content: "Mount it on the orders router", status: "completed" },
    { content: "Add 429 + Retry-After test", status: "in_progress" },
    { content: "Run npm test -- orders", status: "pending" },
  ] } });
  ce(200, "orders", { kind: "tool_result", id: "u1", isError: false, text: "" });
  ce(1400, "orders", { kind: "tool", id: "u2", name: "Write", input: { file_path: REPO + "\\src\\middleware\\rateLimit.ts", content: `import type { RequestHandler } from "express";

export function rateLimit({ limit, windowMs }: { limit: number; windowMs: number }): RequestHandler {
  const hits = new Map<string, number[]>();
  return (req, res, next) => {
    const key = req.user?.id ?? req.ip;
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      res.setHeader("Retry-After", Math.ceil((recent[0] + windowMs - now) / 1000));
      return res.status(429).json({ error: "rate_limited" });
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}` } });
  ce(300, "orders", { kind: "tool_result", id: "u2", isError: false, text: "File created" });
  ce(900, "orders", { kind: "tool", id: "u3", name: "Edit", input: { file_path: REPO + "\\src\\routes\\orders.ts",
    old_string: `import { Router } from "express";\nimport { requireAuth } from "../middleware/auth";\n\nexport const orders = Router();\norders.use(requireAuth);`,
    new_string: `import { Router } from "express";\nimport { requireAuth } from "../middleware/auth";\nimport { rateLimit } from "../middleware/rateLimit";\n\nexport const orders = Router();\norders.use(requireAuth);\norders.use(rateLimit({ limit: 30, windowMs: 60_000 }));` } });
  ce(200, "orders", { kind: "tool_result", id: "u3", isError: false, text: "ok" });
  ce(900, "orders", { kind: "user", text: "also check the Retry-After header in the test" });
  ce(1300, "orders", { kind: "text", text: "Understood, the test will assert `Retry-After` as well." });
  ce(700, "orders", { kind: "tool", id: "u4", name: "Bash", input: { command: "npm test -- orders" } });
  ce(2600, "orders", { kind: "tool_result", id: "u4", isError: false, text: " PASS  test/orders.test.ts\n  ✓ returns 429 after 30 requests (41 ms)\n  ✓ sets Retry-After (3 ms)\n\nTests: 6 passed, 6 total" });
  ce(800, "orders", { kind: "tool", id: "u5", name: "Read", input: { file_path: REPO + "\\test\\orders.test.ts", offset: 40 } });

  const live = ev.slice();

  // finished variant
  const done = ev.slice();
  const push = (dt, o) => done.push({ ...o, ts: (t += dt) });
  push(300, { type: "claude-event", session: "orders", event: { kind: "tool_result", id: "u5", isError: false, text: "" } });
  push(2200, { type: "claude-event", session: "orders", event: { kind: "text", text: "REPORT: added src/middleware/rateLimit.ts (sliding window), mounted on the orders router only, 2 new tests. npm test -- orders: 6/6 pass." } });
  push(200, { type: "claude-files", session: "orders", files: [{ file: "src/middleware/rateLimit.ts", code: "??" }, { file: "src/routes/orders.ts", code: " M" }, { file: "test/orders.test.ts", code: " M" }] });
  push(100, { type: "claude-end", session: "orders", result: { text: "…", isError: false, costUsd: 0.214, sessionId: "a1" } });
  push(300, { type: "kimi-start" });
  push(700, { type: "kimi-tool", name: "git", label: "git diff --stat" });
  push(400, { type: "kimi-tool", name: "update_notes", label: "updates notes: DECISIONS" });
  push(1500, { type: "task-end", report: "Done. `/api/orders` is now limited to 30 requests per minute per user; above that it returns **429** with `Retry-After`.\n\n- New middleware: `src/middleware/rateLimit.ts` (in-memory sliding window, no new dependency)\n- Applied only to the orders routes; other routes are untouched\n- Tests: 6/6 pass\n\nOpen: if you ever run more than one instance, the limit should move to Redis.", streamed: false, kimiUsd: 0.011, claudeUsd: 0.298 });
  push(200, { type: "guard", issues: ["dependencies: package.json"] });

  const base = { repo: REPO, repoName: "shop-api", branch: "kimi/rate-limit", model: "moonshotai/kimi-k3.1-pro", claudeModel: null, contextLimit: 40000, claudeBin: "C:\\Users\\dev\\.local\\bin\\claude.exe", claudeFound: true };
  window.demoInit = (state) => ({
    ...base,
    hasKey: state !== "nokey",
    busy: state === "live",
    transcript: state === "live" ? live : state === "done" ? done.slice(0, -1) : state === "guard" ? done : [],
  });
  // a slice of OpenRouter's catalogue (tool-capable models) for the model picker
  window.demoModels = [{"id":"inclusionai/ling-3.2-flash:free","name":"Ling 3.2 Flash (free)","prompt":0,"completion":0,"context":1048576,"reasoning":true,"created":1794591958},{"id":"google/gemini-4-hydrogen","name":"Gemini 4 Hydrogen","prompt":1.5,"completion":7.5,"context":1048576,"reasoning":true,"created":1794506460},{"id":"baidu/ernie-5.5-flash-preview:free","name":"ERNIE-5.5-Flash-Preview (free)","prompt":0,"completion":0,"context":1024000,"reasoning":true,"created":1794333533},{"id":"baidu/ernie-light-dt-1.0-intl","name":"ERNIE-Light-DT-1.0","prompt":1.13,"completion":3.94,"context":1024000,"reasoning":true,"created":1794331260},{"id":"google/gemini-4-carbon","name":"Gemini 4 Carbon","prompt":2,"completion":10,"context":1048576,"reasoning":true,"created":1794326871},{"id":"nex-agi/nex-n2.6","name":"Nex-N2.6","prompt":0.12,"completion":0.4,"context":262144,"reasoning":true,"created":1794282379},{"id":"thinkingmachines/inkling-2-small","name":"Inkling 2 Small","prompt":0.3,"completion":1,"context":1048576,"reasoning":true,"created":1794261847},{"id":"thinkingmachines/inkling-2-small:free","name":"Inkling 2 Small (free)","prompt":0,"completion":0,"context":1048576,"reasoning":true,"created":1794261847},{"id":"anthropic/claude-fable-5.2","name":"Claude Fable 5.2","prompt":8,"completion":40,"context":1000000,"reasoning":true,"created":1794253781},{"id":"meta/muse-ember","name":"Muse Ember","prompt":0.1,"completion":0.5,"context":1048576,"reasoning":true,"created":1794247648},{"id":"liquid/lfm-3-1.7b","name":"LFM3-1.7B","prompt":0.08,"completion":0.2,"context":262144,"reasoning":true,"created":1794009477},{"id":"liquid/lfm-3-1.7b:free","name":"LFM3-1.7B (free)","prompt":0,"completion":0,"context":262144,"reasoning":true,"created":1794009477},{"id":"kt/midm-k-3.0-pro","name":"Mi:dm K 3.0 Pro","prompt":0.2,"completion":0.8,"context":261795,"reasoning":true,"created":1793897701},{"id":"openrouter/auto","name":"Auto Router","prompt":-1000000,"completion":-1000000,"context":2000000,"reasoning":true,"created":1793885889},{"id":"openrouter/auto-code","name":"Auto Code","prompt":-1000000,"completion":-1000000,"context":2000000,"reasoning":true,"created":1793884321},{"id":"ricursiveai/ripple-65b-preview","name":"Ripple 65B Preview","prompt":0.1,"completion":0.3,"context":1048576,"reasoning":true,"created":1793818990},{"id":"tencent/hy4","name":"Hy4","prompt":0.417,"completion":1.25,"context":1048576,"reasoning":true,"created":1793766031},{"id":"motif-technologies/motif-3","name":"Motif 3","prompt":0.3,"completion":1.2,"context":262144,"reasoning":true,"created":1793655334},{"id":"z-ai/glm-5.3-flashx-legal","name":"GLM 5.3 FlashX Legal","prompt":0.37,"completion":1.25,"context":1048576,"reasoning":true,"created":1793626154},{"id":"particle-ai/particle-1","name":"Particle-1","prompt":0.06,"completion":0.5,"context":1048576,"reasoning":true,"created":1793207893},{"id":"particle-ai/particle-1:free","name":"Particle-1 (free)","prompt":0,"completion":0,"context":1048576,"reasoning":true,"created":1793207893},{"id":"openai/gpt-6.1-terra-pro","name":"GPT-6.1 Terra Pro","prompt":1,"completion":5,"context":1050000,"reasoning":true,"created":1793038556},{"id":"openai/gpt-6.1-terra","name":"GPT-6.1 Terra","prompt":1,"completion":5,"context":1050000,"reasoning":true,"created":1793038409},{"id":"moonshotai/kimi-k3.1-pro","name":"Kimi K3.1 Pro","prompt":2,"completion":10,"context":1048576,"reasoning":true,"created":1792778188},{"id":"recursive/flint-v1.0:free","name":"Flint (free)","prompt":0,"completion":0,"context":262144,"reasoning":true,"created":1792622765},{"id":"minimax/minimax-m3.1-flash","name":"MiniMax M3.1 Flash","prompt":0.075,"completion":0.3,"context":1048576,"reasoning":true,"created":1792379569},{"id":"deepseek/deepseek-v4.1-flash-1017","name":"DeepSeek V4.1 Flash 1017","prompt":0.038,"completion":0.5,"context":1048576,"reasoning":true,"created":1792225624},{"id":"elorian/glimpse","name":"Glimpse","prompt":0.6,"completion":3,"context":262144,"reasoning":true,"created":1792206629},{"id":"reflection/beam-1.0-501b-a23b","name":"Beam 1.0 501B A23B","prompt":0.3,"completion":1,"context":1048576,"reasoning":true,"created":1792160499},{"id":"prism-ml/ternary-bonsai-2-9b","name":"Ternary Bonsai 2 9B","prompt":0.08,"completion":0.13,"context":262144,"reasoning":true,"created":1792130995},{"id":"meta/muse-spark-open","name":"Muse Spark Open","prompt":1.25,"completion":4.25,"context":1048576,"reasoning":true,"created":1792087069},{"id":"nvidia/nemotron-3.5-super-vl","name":"Nemotron 3.5 Super VL","prompt":0.15,"completion":0.47,"context":1048576,"reasoning":true,"created":1792076662},{"id":"nvidia/nemotron-3.5-super-vl:free","name":"Nemotron 3.5 Super VL (free)","prompt":0,"completion":0,"context":1000000,"reasoning":true,"created":1792076662},{"id":"unbiased/pareto-26.10","name":"Pareto 26.10","prompt":0.8,"completion":3.2,"context":1048576,"reasoning":false,"created":1792073620},{"id":"~unbiased/pareto-latest","name":"Pareto Latest","prompt":0.8,"completion":3.2,"context":1048576,"reasoning":false,"created":1791933050},{"id":"unbiased/pareto-26.9","name":"Pareto 26.9","prompt":2.5,"completion":7.5,"context":262144,"reasoning":false,"created":1791930537},{"id":"liquid/lfm-2.5-24b-a2b","name":"LFM2.5-24B-A2B","prompt":0.05,"completion":0.7,"context":128000,"reasoning":true,"created":1791912025},{"id":"google/gemini-4-argon","name":"Gemini 4 Argon","prompt":2,"completion":10,"context":1048576,"reasoning":true,"created":1791907477},{"id":"meta/muse-wonder","name":"Muse Wonder","prompt":4,"completion":20,"context":1048576,"reasoning":true,"created":1791807945},{"id":"stepfun/step-5-preview","name":"Step 5 Preview","prompt":1,"completion":2.7,"context":1000000,"reasoning":true,"created":1791462849}];
})();
