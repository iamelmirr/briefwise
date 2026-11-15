import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { leadCall, type Msg } from "../src/openrouter.ts";
import { MockOpenRouter, turn, type Reply } from "./helpers.ts";

const mock = new MockOpenRouter();
const savedBase = process.env.OPENROUTER_BASE_URL;
before(async () => {
  await mock.start();
  process.env.OPENROUTER_BASE_URL = mock.url;
});
after(async () => {
  await mock.close();
  if (savedBase === undefined) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = savedBase;
});
beforeEach(() => mock.reset());

const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, model: "test/model", ...over });
const call = (extra: Partial<Parameters<typeof leadCall>[0]> = {}) =>
  leadCall({ cfg: cfg(), apiKey: "sk-test", system: "SYS", messages: [{ role: "user", content: "hi" }], tools: [], effort: null, ...extra });

describe("leadCall streaming", () => {
  test("text, reasoning and tool calls split across chunks are reassembled", async () => {
    const text = "Héllo wörld 👋, I will read the file.";
    const reasoning = "The user wants… a 🧠 plan.";
    mock.reset([{
      sse: turn({
        text, reasoning, cost: 0.0042, promptTokens: 1234, cachedTokens: 1000,
        tools: [
          { name: "read_file", args: { path: "src/app.js", start: 1, end: 40 }, id: "call_a" },
          { name: "grep", args: { pattern: "füü|bar", path: "src" }, id: "call_b" },
        ],
      }),
      splitEvery: 7, // byte slices: splits lines, JSON and multi-byte characters
    }]);
    const texts: string[] = [], thoughts: string[] = [];
    const r = await call({ onText: (d) => texts.push(d), onReasoning: (d) => thoughts.push(d) });

    assert.equal(r.msg.role, "assistant");
    assert.equal(r.msg.content, text);
    assert.equal(r.msg.reasoning, reasoning);
    assert.equal(texts.join(""), text);
    assert.ok(texts.length >= 2, "text arrives as several deltas");
    assert.equal(thoughts.join(""), reasoning);
    assert.deepEqual(r.msg.tool_calls, [
      { id: "call_a", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/app.js", start: 1, end: 40 }) } },
      { id: "call_b", type: "function", function: { name: "grep", arguments: JSON.stringify({ pattern: "füü|bar", path: "src" }) } },
    ]);
    assert.equal(r.costUsd, 0.0042);
    assert.equal(r.promptTokens, 1234);
    assert.equal(r.cachedTokens, 1000);
  });

  test("the request carries key, model, system prompt, tools, effort, provider and streaming usage", async () => {
    mock.reset([{ sse: turn({ text: "ok" }) }]);
    const msgs: Msg[] = [{ role: "user", content: "hi" }];
    const tools = [{ type: "function", function: { name: "finish", parameters: { type: "object", properties: {} } } }];
    await leadCall({ cfg: cfg({ provider: { sort: "throughput" } }), apiKey: "sk-test", system: "SYS", messages: msgs, tools, effort: "high", toolChoice: "none" });
    const [req] = mock.requests;
    assert.equal(req.url, "/api/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer sk-test");
    assert.equal(req.headers["x-title"], "Briefwise");
    assert.equal(req.body.model, "test/model");
    assert.equal(req.body.stream, true);
    assert.deepEqual(req.body.usage, { include: true });
    assert.deepEqual(req.body.reasoning, { effort: "high" });
    assert.deepEqual(req.body.provider, { sort: "throughput" });
    assert.equal(req.body.tool_choice, "none");
    assert.deepEqual(req.body.tools, tools);
    assert.deepEqual(req.body.messages, [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }]);
  });

  test("optional fields are omitted when not set", async () => {
    mock.reset([{ sse: turn({ text: "ok" }) }]);
    await leadCall({ cfg: cfg({ provider: null }), apiKey: "k", system: "S", messages: [], tools: [], effort: null });
    const { body } = mock.requests[0];
    for (const k of ["reasoning", "provider", "tool_choice"]) assert.ok(!(k in body), k);
  });

  test("plain text reply: no tool_calls / reasoning keys; missing usage → zeros", async () => {
    mock.reset([{ sse: `data: ${JSON.stringify({ choices: [{ delta: { content: "Just an answer." } }] })}\n\ndata: [DONE]\n\n` }]);
    const r = await call();
    assert.deepEqual(r.msg, { role: "assistant", content: "Just an answer." });
    assert.deepEqual([r.costUsd, r.promptTokens, r.cachedTokens], [0, 0, 0]);
  });

  test("a final line without a trailing newline is still parsed; tool calls without id get one", async () => {
    const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "finish", arguments: '{"report":"done"}' } }] } }] };
    mock.reset([{ sse: `data: ${JSON.stringify(chunk)}` }]);
    const r = await call();
    const calls = r.msg.tool_calls ?? [];
    assert.equal(calls.length, 1);
    assert.match(calls[0].id, /^call_\d+_0$/);
    assert.equal(calls[0].function.arguments, '{"report":"done"}');
  });

  test("an error event inside the stream throws", async () => {
    mock.reset([{ sse: `data: ${JSON.stringify({ choices: [{ delta: { content: "par" } }] })}\n\ndata: ${JSON.stringify({ error: { message: "upstream exploded" } })}\n\n` }]);
    await assert.rejects(call(), /OpenRouter: upstream exploded/);
  });

  test("no API key → clear error, no request", async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      await assert.rejects(call({ apiKey: undefined }), /No OpenRouter API key/);
      assert.equal(mock.requests.length, 0);
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });
});

describe("leadCall errors", () => {
  const err = (status: number, message: string): Reply => ({ status, body: JSON.stringify({ error: { message } }) });

  test("401 → invalid key, not retried", async () => {
    mock.reset([err(401, "No auth credentials found")]);
    await assert.rejects(call(), { message: "The OpenRouter key is invalid or revoked (401). Enter a new key." });
    assert.equal(mock.requests.length, 1);
  });

  test("402 → top up credits, not retried", async () => {
    mock.reset([err(402, "Insufficient credits")]);
    await assert.rejects(call(), { message: "The OpenRouter account does not have enough credits (402). Top up at openrouter.ai/credits." });
    assert.equal(mock.requests.length, 1);
  });

  test("404 → model unavailable, with the server's detail", async () => {
    mock.reset([err(404, "No endpoints found that support tool use")]);
    await assert.rejects(call(), {
      message: "Model test/model is unavailable or does not support tools (404: No endpoints found that support tool use). Choose another model.",
    });
    assert.equal(mock.requests.length, 1);
  });

  test("400 about tools → model message; other 400 → generic message with the raw detail", async () => {
    mock.reset([err(400, "tool_choice is not supported"), { status: 400, body: "bad things" }]);
    await assert.rejects(call(), /^Error: Model test\/model is unavailable or does not support tools \(400: tool_choice is not supported\)/);
    await assert.rejects(call(), { message: "OpenRouter 400: bad things" });
    assert.equal(mock.requests.length, 2);
  });

  // The backoff is 2 s × attempt (production default, not overridden), so each retry test takes ~2 s; they run concurrently.
  test("429 and 5xx are retried, then succeed", { timeout: 15_000 }, async () => {
    const seen: Record<string, number> = {};
    mock.route = (body) => {
      const n = (seen[body.model] = (seen[body.model] ?? 0) + 1);
      if (n > 1) return { sse: turn({ text: `ok after ${n}`, cost: 0.01 }) };
      return body.model === "m/429" ? err(429, "rate limited") : { status: 503, body: "Service Unavailable" };
    };
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      leadCall({ cfg: cfg({ model: "m/429" }), apiKey: "k", system: "S", messages: [], tools: [], effort: null }),
      leadCall({ cfg: cfg({ model: "m/503" }), apiKey: "k", system: "S", messages: [], tools: [], effort: null }),
    ]);
    assert.equal(a.msg.content, "ok after 2");
    assert.equal(b.msg.content, "ok after 2");
    assert.equal(a.costUsd, 0.01);
    assert.deepEqual(seen, { "m/429": 2, "m/503": 2 });
    assert.ok(Date.now() - t0 >= 1900, "waited for the backoff");
  });

  test("an abort signal cancels the request", async () => {
    mock.route = () => ({ sse: turn({ text: "never" }) });
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(call({ signal: ac.signal }), { name: "AbortError" });
  });
});
