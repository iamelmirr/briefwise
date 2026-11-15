// End-to-end lead loop, fully offline: a mock OpenRouter scripts the lead's tool calls,
// and test/fixtures/fake-claude.mjs stands in for the Claude Code CLI.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Lead, type LeadEvent } from "../src/lead.ts";
import { FAKE_CLAUDE, MockOpenRouter, TEMPLATES, alive, makeRepo, rmrf, tmpDir, toolReply, turn, waitFor, writeFile } from "./helpers.ts";

const mock = new MockOpenRouter();
const cleanup: string[] = [];
let logDir = "";
const saved = { base: process.env.OPENROUTER_BASE_URL, log: process.env.FAKE_CLAUDE_LOG, key: process.env.OPENROUTER_API_KEY };

before(async () => {
  await mock.start();
  process.env.OPENROUTER_BASE_URL = mock.url;
  delete process.env.OPENROUTER_API_KEY; // the key must come from LeadOptions.apiKey
  logDir = tmpDir("briefwise-fakelog-");
  cleanup.push(logDir);
});
after(async () => {
  await mock.close();
  cleanup.forEach(rmrf);
  for (const [k, v] of [["OPENROUTER_BASE_URL", saved.base], ["FAKE_CLAUDE_LOG", saved.log], ["OPENROUTER_API_KEY", saved.key]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

type FakeLog = { event: "start"; pid: number; argv: string[]; cwd: string } | { event: "message"; pid: number; text: string };

/** A temp repo with a pre-written .briefwise/config.json pointing claude.path at the fake CLI. */
function setup(name: string, files: Record<string, string> = {}, config: Record<string, unknown> = {}) {
  const repo = makeRepo({ "src/app.js": "console.log('hello');\n", ...files });
  cleanup.push(repo);
  writeFile(repo, ".briefwise/config.json", JSON.stringify({
    model: "test/lead-model",
    provider: null,
    claude: { path: FAKE_CLAUDE, implementAllow: ["Bash(npm test:*)"] },
    forbidden: ["ACME\\s*Corp"],
    ...config,
  }, null, 2));
  const logFile = path.join(logDir, `${name}.jsonl`);
  process.env.FAKE_CLAUDE_LOG = logFile;
  const events: LeadEvent[] = [];
  const asked: string[] = [];
  const hooks = {
    emit: (e: LeadEvent) => { events.push(e); onEvent(e); },
    askUser: async (q: string) => { asked.push(q); return null; },
  };
  let onEvent: (e: LeadEvent) => void = () => {};
  const lead = new Lead(repo, hooks, { apiKey: () => "test-key", templatesDir: TEMPLATES });
  const fakeLog = (): FakeLog[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { repo, lead, events, asked, fakeLog, setOnEvent: (f: (e: LeadEvent) => void) => (onEvent = f) };
}

/** Event types, with runs of streamed deltas collapsed and claude events shown by kind. */
function shape(events: LeadEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type === "sessions" || (e.type === "claude-event" && e.event.kind === "context")) continue; // bookkeeping, tested separately
    const s = e.type === "claude-event" ? `claude-event:${e.event.kind}` : e.type === "lead-tool" ? `lead-tool:${e.name}` : e.type;
    if ((e.type === "lead-text" || e.type === "lead-reasoning") && out[out.length - 1] === s) continue;
    out.push(s);
  }
  return out;
}

const toolMsgs = (body: any): string[] => (body?.messages ?? []).filter((m: any) => m.role === "tool").map((m: any) => m.content);

describe("Lead end-to-end (mock OpenRouter + fake Claude)", { timeout: 20_000 }, () => {
  test("read_file → implement → git diff → finish, then a consult that resumes the session", async () => {
    const { repo, lead, events, fakeLog } = setup("main");
    mock.reset([
      toolReply("read_file", { path: "src/app.js" }, { reasoning: "Let me look at the file first.", text: "Checking the code." }),
      toolReply("implement", { session: "s1", prompt: "Add a header comment to src/app.js. [fake:edit src/app.js]" }),
      toolReply("git", { args: ["diff", "--stat"] }),
      toolReply("finish", { report: "Added the header comment to src/app.js." }),
    ]);

    const report = await lead.run("dodaj komentar u app.js");
    assert.equal(report, "Added the header comment to src/app.js.");
    assert.equal(lead.busy, false);
    assert.equal(lead.claudeActive, false);

    assert.deepEqual(shape(events), [
      "lead-start", "lead-reasoning", "lead-text", "lead-end", "lead-tool:read_file",
      "lead-start", "lead-end",
      "claude-start", "claude-event:init", "claude-event:tool", "claude-event:tool_result", "claude-event:text", "claude-end", "claude-files",
      "lead-start", "lead-end", "lead-tool:git",
      "lead-start", "lead-end",
      "task-end",
    ]);

    // what the lead saw
    assert.equal(mock.requests.length, 4);
    for (const r of mock.requests) {
      assert.equal(r.headers.authorization, "Bearer test-key");
      assert.equal(r.body.model, "test/lead-model");
    }
    assert.match(mock.requests[0].body.messages[0].content, /technical lead of the repository/);
    assert.match(mock.requests[0].body.messages[0].content, /`npm test …`/, "allowed commands are in the system prompt");
    assert.match(toolMsgs(mock.requests[1].body)[0], /^1\tconsole\.log\('hello'\);/);
    const implementOut = toolMsgs(mock.requests[2].body)[1];
    assert.match(implementOut, /REPORT: edited src\/app\.js/);
    assert.match(implementOut, /FILES CHANGED \(from git\): src\/app\.js/);
    assert.ok(!implementOut.includes("GUARD"));
    assert.match(toolMsgs(mock.requests[3].body)[2], /src\/app\.js \| 1 \+/);

    // what fake Claude received
    const log1 = fakeLog();
    const start = log1.find((l) => l.event === "start") as Extract<FakeLog, { event: "start" }>;
    const msgs = log1.filter((l) => l.event === "message") as Extract<FakeLog, { event: "message" }>[];
    assert.equal(msgs.length, 1);
    const brief = msgs[0].text;
    assert.ok(brief.startsWith("[MODE: IMPLEMENT."), brief.slice(0, 80));
    assert.match(brief.split("\n")[1], /^\[ALLOWED COMMANDS: `npm test …`/);
    assert.ok(brief.endsWith("Add a header comment to src/app.js. [fake:edit src/app.js]"));
    assert.equal(fs.realpathSync(start.cwd), repo);
    assert.ok(start.argv.includes("--replay-user-messages"));
    assert.equal(start.argv[start.argv.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.ok(!start.argv.includes("--resume"));
    assert.equal(alive(start.pid), false, "fake Claude exited after its result");

    // the change, as reported
    assert.match(fs.readFileSync(path.join(repo, "src/app.js"), "utf8"), /^console\.log\('hello'\);\n\/\/ edited by fake claude/);
    const cs = events.find((e) => e.type === "claude-start") as Extract<LeadEvent, { type: "claude-start" }>;
    assert.deepEqual([cs.session, cs.mode], ["s1", "implement"]);
    const init = events.find((e) => e.type === "claude-event" && e.event.kind === "init") as Extract<LeadEvent, { type: "claude-event" }>;
    const sessionId = (init.event as { sessionId: string }).sessionId;
    assert.match(sessionId, /^fake-session-/);
    const tool = events.find((e) => e.type === "claude-event" && e.event.kind === "tool") as any;
    assert.equal(tool.event.name, "Edit");
    const files = events.find((e) => e.type === "claude-files") as Extract<LeadEvent, { type: "claude-files" }>;
    assert.deepEqual(files.files, [{ file: "src/app.js", code: " M" }]);
    const end = events.find((e) => e.type === "claude-end") as Extract<LeadEvent, { type: "claude-end" }>;
    assert.equal(end.result.isError, false);
    assert.equal(end.result.sessionId, sessionId);
    const taskEnd = events.at(-1) as Extract<LeadEvent, { type: "task-end" }>;
    assert.equal(taskEnd.report, "Added the header comment to src/app.js.");
    assert.equal(taskEnd.streamed, false);
    assert.ok(Math.abs(taskEnd.leadUsd - 0.004) < 1e-9, String(taskEnd.leadUsd));
    assert.equal(taskEnd.claudeUsd, 0.0125);
    assert.ok(!events.some((e) => e.type === "notice" || e.type === "guard" || e.type === "blocked"));

    // persisted state
    const bw = path.join(repo, ".briefwise");
    const history = JSON.parse(fs.readFileSync(path.join(bw, "history.json"), "utf8"));
    assert.equal(history.length, 1);
    assert.equal(history[0].user, "dodaj komentar u app.js");
    assert.equal(history[0].report, "Added the header comment to src/app.js.");
    const sessions = JSON.parse(fs.readFileSync(path.join(bw, "sessions.json"), "utf8"));
    assert.equal(sessions.s1.id, sessionId);
    const log = fs.readFileSync(path.join(bw, "log.md"), "utf8");
    for (const s of ["— USER", "→ Claude (implement, session s1)", "← Claude (s1)", "Lead → user (report)"]) assert.ok(log.includes(s), s);
    assert.ok(fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8").includes(".briefwise/"));

    // second task: consult in the same session → --resume, read-only mode, prior turn in the lead's context
    mock.reset([
      toolReply("ask_claude", { session: "s1", prompt: "What does src/app.js do now?" }),
      { sse: turn({ text: "It logs hello and has a header comment." }) },
    ]);
    events.length = 0;
    const report2 = await lead.run("what does it do?");
    assert.equal(report2, "It logs hello and has a header comment.");
    assert.deepEqual(mock.requests[0].body.messages.slice(1).map((m: any) => m.content), [
      "dodaj komentar u app.js", "Added the header comment to src/app.js.", "what does it do?",
    ]);
    const log2 = fakeLog().slice(log1.length);
    const start2 = log2.find((l) => l.event === "start") as Extract<FakeLog, { event: "start" }>;
    assert.equal(start2.argv[start2.argv.indexOf("--resume") + 1], sessionId);
    assert.equal(start2.argv[start2.argv.indexOf("--permission-mode") + 1], "dontAsk");
    const consult = (log2.find((l) => l.event === "message") as Extract<FakeLog, { event: "message" }>).text;
    assert.ok(consult.startsWith("[MODE: CONSULT."));
    assert.ok(!consult.includes("ALLOWED COMMANDS"));
    assert.ok(!events.some((e) => e.type === "claude-files"), "a consult reports no file changes");
    const te2 = events.at(-1) as Extract<LeadEvent, { type: "task-end" }>;
    assert.equal(te2.streamed, true, "a plain-text final answer was streamed to the user");
    assert.equal(JSON.parse(fs.readFileSync(path.join(bw, "history.json"), "utf8")).length, 2);
  });

  test("a forbidden pattern blocks the brief; nothing reaches Claude", async () => {
    const { lead, events, fakeLog } = setup("forbidden");
    mock.reset([
      toolReply("implement", { session: "s1", prompt: "Build the invoice export for ACME Corp." }),
      toolReply("finish", { report: "Could not send that." }),
    ]);
    const report = await lead.run("export za acme corp");
    assert.equal(report, "Could not send that.");
    const blocked = events.filter((e) => e.type === "blocked") as Extract<LeadEvent, { type: "blocked" }>[];
    assert.equal(blocked.length, 1);
    assert.match(blocked[0].reason, /rule #1 in config\.forbidden/);
    assert.ok(!events.some((e) => e.type === "claude-start" || e.type === "claude-event"));
    assert.deepEqual(fakeLog(), [], "fake Claude was never started");
    assert.match(toolMsgs(mock.requests[1].body)[0], /^BLOCKED: /);
    const te = events.at(-1) as Extract<LeadEvent, { type: "task-end" }>;
    assert.equal(te.claudeUsd, 0);
  });

  test("denyRead blocks the lead's read_file of .env (and paths outside the repo)", async () => {
    const { lead, events } = setup("deny", { ".env": "API_SECRET=super-secret-value\n", "secrets/key.txt": "k\n" });
    mock.reset([
      toolReply("read_file", { path: ".env" }),
      toolReply("read_file", { path: "secrets/key.txt" }),
      toolReply("read_file", { path: "../outside.txt" }),
      toolReply("read_file", { path: ".briefwise/PRIVATE.md" }),
      toolReply("finish", { report: "done" }),
    ]);
    await lead.run("check the env");
    const outs = toolMsgs(mock.requests[4].body);
    assert.deepEqual(outs, [
      "ERROR: this file is in denyRead; you may not read it",
      "ERROR: this file is in denyRead; you may not read it",
      "ERROR: path outside the repo",
      "ERROR: this file is in denyRead; you may not read it",
    ]);
    assert.ok(!mock.requests.some((r) => JSON.stringify(r.body).includes("super-secret-value")));
    assert.ok(!events.some((e) => e.type === "lead-tool"), "denied reads are not shown as reads");
  });

  test("denyRead also holds through the lead's git tool", async () => {
    const { lead } = setup("deny-git", { ".env": "API_SECRET=super-secret-value\n", "secrets/key.txt": "secret-key-material\n", "app.js": "ok\n" });
    mock.reset([
      toolReply("git", { args: ["show", "HEAD:.env"] }),
      toolReply("git", { args: ["diff", "HEAD~0", "--", "secrets/key.txt"] }),
      toolReply("git", { args: ["show", "HEAD"] }),
      toolReply("git", { args: ["log", "-p", "-1"] }),
      toolReply("finish", { report: "done" }),
    ]);
    await lead.run("look at the last commit");
    const outs = toolMsgs(mock.requests[4].body);
    assert.equal(outs[0], "ERROR: that path is in denyRead");
    assert.equal(outs[1], "ERROR: that path is in denyRead");
    assert.match(outs[2], /app\.js/, "repo-wide show still works for allowed files");
    assert.match(outs[3], /app\.js/);
    const all = JSON.stringify(mock.requests.map((r) => r.body));
    assert.ok(!all.includes("super-secret-value") && !all.includes("secret-key-material"), "denied file contents never reach the lead model");
  });

  test("what the user tells Claude mid-run reaches the lead with the report, marked as the user's decision", async () => {
    const { lead, fakeLog, setOnEvent } = setup("interject");
    mock.reset([
      toolReply("implement", { session: "s3", prompt: "Refactor app.js. [fake:hang]" }),
      toolReply("finish", { report: "Done, kept the user's choice." }),
    ]);
    let sent = false;
    setOnEvent((e) => {
      if (!sent && e.type === "claude-event" && e.event.kind === "init") {
        sent = true;
        setTimeout(() => assert.equal(lead.interject("use tabs, not spaces"), true), 20);
      }
    });
    const report = await lead.run("refactor the app");
    assert.equal(report, "Done, kept the user's choice.");
    assert.ok(fakeLog().some((l) => l.event === "message" && l.text === "use tabs, not spaces"), "Claude got the message");
    const out = toolMsgs(mock.requests[1].body)[0];
    assert.match(out, /REPORT:/);
    assert.match(out, /THE USER TOLD CLAUDE DIRECTLY DURING THIS RUN[^\n]*\n- use tabs, not spaces/);
    assert.match(String(mock.requests[0].body.messages[0].content), /The user may message Claude directly/);
    assert.equal(lead.interject("too late"), false, "nothing to interject into once Claude is done");
  });

  test("stop() mid-run kills fake Claude and ends the task with 'Stopped.'", async () => {
    const { lead, events, fakeLog, setOnEvent } = setup("stop");
    mock.reset([
      toolReply("implement", { session: "s2", prompt: "A long job. [fake:hang]" }),
      toolReply("finish", { report: "should never be requested" }),
    ]);
    let pid = 0;
    setOnEvent((e) => {
      if (e.type === "claude-event" && e.event.kind === "init") {
        pid = (fakeLog().find((l) => l.event === "start") as Extract<FakeLog, { event: "start" }>).pid;
        assert.equal(alive(pid), true);
        assert.equal(lead.claudeActive, true);
        setTimeout(() => lead.stop(), 20);
      }
    });
    const t0 = Date.now();
    const report = await lead.run("do the long job");
    assert.equal(report, "Stopped.");
    assert.ok(Date.now() - t0 < 10_000);
    assert.ok(pid > 0);
    assert.ok(await waitFor(() => !alive(pid), 3000), "fake Claude process is gone");
    assert.equal(mock.requests.length, 1, "the lead was not called again after stop");
    const end = events.find((e) => e.type === "claude-end") as Extract<LeadEvent, { type: "claude-end" }>;
    assert.equal(end.result.stopped, true);
    const te = events.at(-1) as Extract<LeadEvent, { type: "task-end" }>;
    assert.deepEqual([te.type, te.report, te.streamed], ["task-end", "Stopped.", false]);
    assert.equal(lead.busy, false);
    assert.equal(lead.claudeActive, false);
  });
});
