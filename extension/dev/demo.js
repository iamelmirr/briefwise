// Demo transcript for dev/preview.html. Mirrors the real UIEvent stream.
(function () {
  const REPO = "C:\\Users\\dev\\projects\\shop-api";
  const t0 = Date.now() - 95_000;
  let t = t0;
  const at = (dt) => (t += dt);
  const ev = [];
  const e = (dt, o) => ev.push({ ...o, ts: at(dt) });
  const ce = (dt, session, event) => e(dt, { type: "claude-event", session, event });

  e(0, { type: "user", text: "dodaj rate limiting na /api/orders, max 30 zahtjeva u minuti po korisniku. ostale rute ne diraj" });
  e(400, { type: "kimi-start" });
  e(900, { type: "kimi-tool", name: "read_file", label: "čita src/routes/orders.ts 1–120" });
  e(300, { type: "kimi-tool", name: "grep", label: "traži \"rateLimit|limiter\"" });
  e(200, { type: "kimi-tool", name: "list_files", label: "lista fajlova (middleware)" });
  e(1200, { type: "kimi-text", delta: "Nema postojećeg limitera, a `src/middleware/` već ima obrazac za Express middleware. Pitam Claudea za opcije bez nove zavisnosti." });
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
  e(1500, { type: "kimi-text", delta: "Biram **opciju 2**, sliding window u memoriji: nema nove zavisnosti, a aplikacija radi kao jedna instanca. Dajem Claudeu da implementira." });
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
  ce(900, "orders", { kind: "user", text: "koristi i Retry-After header u testu" });
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
  push(400, { type: "kimi-tool", name: "update_notes", label: "ažurira bilješke: DECISIONS" });
  push(1500, { type: "task-end", report: "Gotovo. `/api/orders` sada ima limit od 30 zahtjeva u minuti po korisniku; preko toga vraća **429** s `Retry-After`.\n\n- Novi middleware: `src/middleware/rateLimit.ts` (sliding window u memoriji, bez nove zavisnosti)\n- Primijenjen samo na orders rute, ostale nisu dirane\n- Testovi: 6/6 prolaze\n\nOtvoreno: ako jednom budeš pokretao više instanci, limit treba prebaciti na Redis.", streamed: false, kimiUsd: 0.011, claudeUsd: 0.298 });
  push(200, { type: "guard", issues: ["dependencies: package.json"] });

  const base = { repo: REPO, repoName: "shop-api", branch: "kimi/rate-limit", model: "moonshotai/kimi-k3.1-pro", contextLimit: 40000, claudeBin: "C:\\Users\\dev\\.local\\bin\\claude.exe", claudeFound: true };
  window.demoInit = (state) => ({
    ...base,
    hasKey: state !== "nokey",
    busy: state === "live",
    transcript: state === "live" ? live : state === "done" ? done.slice(0, -1) : state === "guard" ? done : [],
  });
})();
