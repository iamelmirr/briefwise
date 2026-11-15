// Session control: context size, compaction (by the user or on the user's request through the lead),
// fresh sessions and turning Claude's auto-compact off. Offline: mock OpenRouter + fake Claude.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Lead, type LeadEvent } from "../src/lead.ts";
import { FAKE_CLAUDE, MockOpenRouter, TEMPLATES, makeRepo, rmrf, tmpDir, toolReply, writeFile } from "./helpers.ts";

const mock = new MockOpenRouter();
const cleanup: string[] = [];
let logDir = "";
const saved = { base: process.env.OPENROUTER_BASE_URL, log: process.env.FAKE_CLAUDE_LOG };

before(async () => {
  await mock.start();
  process.env.OPENROUTER_BASE_URL = mock.url;
  logDir = tmpDir("briefwise-sessions-");
  cleanup.push(logDir);
});
after(async () => {
  await mock.close();
  cleanup.forEach(rmrf);
  for (const [k, v] of [["OPENROUTER_BASE_URL", saved.base], ["FAKE_CLAUDE_LOG", saved.log]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

type FakeLog = { event: "start"; pid: number; argv: string[]; disableAutoCompact: string | null } | { event: "message"; pid: number; text: string };

function setup(name: string, claude: Record<string, unknown> = {}) {
  const repo = makeRepo({ "src/app.js": "console.log('hello');\n" });
  cleanup.push(repo);
  writeFile(repo, ".briefwise/config.json", JSON.stringify({ model: "test/lead-model", provider: null, claude: { path: FAKE_CLAUDE, ...claude } }));
  const logFile = path.join(logDir, `${name}.jsonl`);
  process.env.FAKE_CLAUDE_LOG = logFile;
  const events: LeadEvent[] = [];
  let onEvent: (e: LeadEvent) => void = () => {};
  const lead = new Lead(repo, { emit: (e) => { events.push(e); onEvent(e); }, askUser: async () => null }, { apiKey: () => "k", templatesDir: TEMPLATES });
  const fakeLog = (): FakeLog[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const starts = () => fakeLog().filter((l): l is Extract<FakeLog, { event: "start" }> => l.event === "start");
  const resumeOf = (argv: string[]) => { const i = argv.indexOf("--resume"); return i >= 0 ? argv[i + 1] : null; };
  return { repo, lead, events, fakeLog, starts, resumeOf, setOnEvent: (f: (e: LeadEvent) => void) => (onEvent = f) };
}

const toolMsgs = (body: any): string[] => (body?.messages ?? []).filter((m: any) => m.role === "tool").map((m: any) => m.content);
const info = (lead: Lead, name: string) => lead.sessionInfo().find((s) => s.name === name)!;

/** Run one task that implements something in `session`, so it has a Claude conversation. */
async function warmUp(lead: Lead, session: string) {
  mock.reset([toolReply("implement", { session, prompt: "Warm up." }), toolReply("finish", { report: "ok" })]);
  await lead.run("start");
}

describe("Claude session control", { timeout: 20_000 }, () => {
  test("context size is tracked per session and shown to the lead", async () => {
    const { lead } = setup("ctx");
    await warmUp(lead, "s1");
    const s = info(lead, "s1");
    assert.deepEqual([s.started, s.contextTokens, s.contextWindow, s.live], [true, 40010, 200000, false]);
    mock.reset([toolReply("list_sessions", {}), toolReply("finish", { report: "ok" })]);
    await lead.run("which sessions?");
    assert.match(String(mock.requests[0].body.messages[0].content), /- s1: .*context 40k of 200k tokens, 20%/);
    assert.match(toolMsgs(mock.requests[1].body)[0], /"context": "context 40k of 200k tokens, 20%"/);
  });

  test("the user compacts an idle session: /compact with the focus goes to that Claude conversation", async () => {
    const { lead, events, fakeLog, starts, resumeOf } = setup("compact-idle");
    await warmUp(lead, "s1");
    const id = info(lead, "s1") && lead.sessionId("s1");
    events.length = 0;
    const p = lead.compact("s1", "keep the API decisions");
    assert.equal(lead.busy, true, "busy while compacting");
    assert.equal(await p, "done");
    assert.equal(lead.busy, false);
    assert.equal(fakeLog().filter((l) => l.event === "message").at(-1)!.text, "/compact keep the API decisions");
    assert.equal(resumeOf(starts().at(-1)!.argv), id, "compacts the session's own conversation");
    const start = events.find((e) => e.type === "claude-start") as Extract<LeadEvent, { type: "claude-start" }>;
    assert.deepEqual([start.mode, start.by, start.prompt], ["compact", "user", "/compact keep the API decisions"]);
    const end = events.find((e) => e.type === "claude-end") as Extract<LeadEvent, { type: "claude-end" }>;
    assert.deepEqual(end.result.compacted, { trigger: "manual", pre: 41000, post: 1600 });
    assert.equal(info(lead, "s1").contextTokens, 1600);
    assert.equal(lead.sessionId("s1"), id, "same conversation, now compacted");
    await assert.rejects(lead.compact("nope"), /no Claude conversation/);
  });

  test("compacting while Claude works is queued, runs right after, and the lead is told", async () => {
    const { lead, events, fakeLog, setOnEvent } = setup("compact-queued");
    mock.reset([
      toolReply("implement", { session: "s2", prompt: "Long job. [fake:hang]" }),
      toolReply("finish", { report: "done" }),
    ]);
    let queued: Promise<string> | undefined;
    setOnEvent((e) => {
      if (!queued && e.type === "claude-event" && e.event.kind === "init") {
        queued = lead.compact("s2");
        setTimeout(() => lead.interject("carry on"), 20); // lets the hanging fake Claude finish its turn
      }
    });
    await lead.run("do the long job");
    assert.equal(await queued, "queued");
    const kinds = events.filter((e) => e.type === "claude-start").map((e) => (e as any).mode);
    assert.deepEqual(kinds, ["implement", "compact"], "the compaction ran after the implementation");
    const order = events.filter((e) => e.type === "claude-start" || e.type === "claude-end").map((e) => e.type === "claude-start" ? `start:${e.mode}` : "end");
    assert.deepEqual(order, ["start:implement", "end", "start:compact", "end"], "the run ends (for the UI) before the compaction starts");
    assert.ok(events.some((e) => e.type === "sessions" && e.sessions.some((s) => s.name === "s2" && s.compactQueued)), "the UI saw it queued");
    assert.equal(fakeLog().filter((l) => l.event === "message").at(-1)!.text, "/compact");
    const out = toolMsgs(mock.requests[1].body)[0];
    assert.match(out, /USER ACTIONS[^\n]*\n- The user compacted Claude session "s2" \(41k → 2k tokens\)/);
  });

  test("a fresh session starts a new Claude conversation; the old one is kept for resuming by hand", async () => {
    const { lead, events, starts, resumeOf } = setup("fresh");
    await warmUp(lead, "s1");
    const old = lead.sessionId("s1")!;
    lead.freshSession("s1");
    assert.equal(info(lead, "s1").started, false);
    assert.equal(lead.sessions.s1.previousIds?.at(-1), old);
    assert.ok(events.some((e) => e.type === "session-fresh" && e.session === "s1" && e.by === "user"));
    mock.reset([toolReply("implement", { session: "s1", prompt: "Next." }), toolReply("finish", { report: "ok" })]);
    await lead.run("next");
    assert.match(String(mock.requests[0].body.messages[0].content), /- s1: .*fresh: no Claude conversation yet/);
    assert.equal(resumeOf(starts().at(-1)!.argv), null, "no --resume: a new conversation");
    assert.notEqual(lead.sessionId("s1"), old);
  });

  test("on the user's request the lead compacts and starts fresh sessions with its tools", async () => {
    const { lead, events, fakeLog } = setup("lead-tools");
    await warmUp(lead, "s1");
    events.length = 0;
    mock.reset([
      toolReply("compact_session", { session: "s1", focus: "keep the schema" }),
      toolReply("fresh_session", { session: "s1" }),
      toolReply("compact_session", { session: "s1" }),
      toolReply("finish", { report: "ok" }),
    ]);
    await lead.run("compact s1, then start it fresh");
    const outs = toolMsgs(mock.requests[3].body);
    assert.match(outs[0], /^Compacted\. Session s1 context is now context 2k of 200k tokens, 1%\./);
    assert.match(outs[1], /fresh Claude conversation/);
    assert.match(outs[2], /^ERROR: session "s1" has no Claude conversation/);
    assert.ok(events.some((e) => e.type === "claude-start" && e.mode === "compact" && e.by === "lead"));
    assert.ok(events.some((e) => e.type === "session-fresh" && e.by === "lead"));
    assert.equal(fakeLog().filter((l) => l.event === "message").at(-1)!.text, "/compact keep the schema");
    assert.match(String(mock.requests[0].body.messages[0].content), /Call compact_session or fresh_session only when the user asks/);
  });

  test("a session can't be reset while Claude works in it", async () => {
    const { lead, setOnEvent } = setup("fresh-live");
    mock.reset([toolReply("implement", { session: "s3", prompt: "Long. [fake:hang]" }), toolReply("finish", { report: "ok" })]);
    let err: unknown;
    setOnEvent((e) => {
      if (!err && e.type === "claude-event" && e.event.kind === "init") {
        try { lead.freshSession("s3"); } catch (x) { err = x; }
        setTimeout(() => lead.interject("go on"), 20);
      }
    });
    await lead.run("go");
    assert.match(String(err), /working in session s3/);
    assert.equal(info(lead, "s3").started, true);
  });

  test("autoCompact false turns Claude's own compaction off; it is saved in config.json", async () => {
    const { repo, lead, starts } = setup("autocompact");
    await warmUp(lead, "s1");
    assert.equal(starts().at(-1)!.disableAutoCompact, null, "default: Claude compacts on its own");
    lead.setAutoCompact(false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, ".briefwise/config.json"), "utf8")).claude.autoCompact, false);
    await warmUp(lead, "s1");
    assert.equal(starts().at(-1)!.disableAutoCompact, "1");
    await lead.compact("s1");
    assert.equal(starts().at(-1)!.disableAutoCompact, "1", "manual /compact still runs with it off");
  });
});
