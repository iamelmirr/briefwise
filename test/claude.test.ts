import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { buildArgs, describeAllowed, resolveClaudeBin, startClaude, withMode, type ClaudeEvent } from "../src/claude.ts";
import { FAKE_CLAUDE, alive, makeRepo, rmrf, tmpDir } from "./helpers.ts";

const cfgWith = (claude: Partial<Config["claude"]> = {}): Config => ({ ...DEFAULT_CONFIG, claude: { ...DEFAULT_CONFIG.claude, ...claude } });

/** Values of a variadic flag: everything after `flag` up to the next "--option". */
function listAfter(args: string[], flag: string): string[] {
  const i = args.indexOf(flag);
  assert.ok(i >= 0, `${flag} missing`);
  const out: string[] = [];
  for (let k = i + 1; k < args.length && !args[k].startsWith("--"); k++) out.push(args[k]);
  return out;
}
const valueOf = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

describe("describeAllowed", () => {
  test("Bash rules become readable commands, others are unchanged", () => {
    assert.deepEqual(
      describeAllowed(["Bash(npm test:*)", "Bash(npx tsc)", "Bash(npm run lint:*)", "WebFetch", "Read(./docs/**)"]),
      ["npm test …", "npx tsc", "npm run lint …", "WebFetch", "Read(./docs/**)"],
    );
    assert.deepEqual(describeAllowed([]), []);
  });
});

describe("withMode", () => {
  test("consult: mode line, no ALLOWED line", () => {
    const s = withMode("ask", "Where is auth handled?", ["Bash(npm test:*)"]);
    assert.ok(s.startsWith("[MODE: CONSULT."));
    assert.ok(!s.includes("ALLOWED COMMANDS"));
    assert.ok(s.endsWith("\n\nWhere is auth handled?"));
  });

  test("implement: mode line, then the allowed commands (Bash rules only)", () => {
    const s = withMode("implement", "Fix the bug.", ["Bash(npm test:*)", "Bash(npx tsc:*)", "WebFetch"]);
    const lines = s.split("\n");
    assert.ok(lines[0].startsWith("[MODE: IMPLEMENT."));
    assert.ok(lines[1].startsWith("[ALLOWED COMMANDS: `npm test …`, `npx tsc …`, plus git status/diff/log/show and ls."));
    assert.ok(!lines[1].includes("WebFetch"));
    assert.ok(s.endsWith("\n\nFix the bug."));
  });

  test("implement with an empty allow list says no tests or builds", () => {
    const s = withMode("implement", "Fix it.");
    assert.match(s.split("\n")[1], /^\[ALLOWED COMMANDS: only git status\/diff\/log\/show and ls\. You cannot run tests or builds/);
    assert.equal(withMode("implement", "Fix it.", ["WebFetch"]), s, "non-Bash rules do not count as commands");
  });
});

describe("buildArgs", () => {
  test("stream-json flags are always present", () => {
    const a = buildArgs(cfgWith(), "ask");
    for (const f of ["-p", "--verbose", "--replay-user-messages"]) assert.ok(a.includes(f), f);
    assert.equal(valueOf(a, "--input-format"), "stream-json");
    assert.equal(valueOf(a, "--output-format"), "stream-json");
    assert.equal(valueOf(a, "--permission-prompts"), "none");
    assert.match(valueOf(a, "--append-system-prompt") ?? "", /REPORT/);
  });

  test("consult is read-only: no Edit/Write allowed, and they are denied", () => {
    const a = buildArgs(cfgWith({ implementAllow: ["Bash(npm test:*)"] }), "ask");
    assert.equal(valueOf(a, "--permission-mode"), "dontAsk");
    const allow = listAfter(a, "--allowedTools");
    assert.deepEqual(allow, ["Read", "Grep", "Glob", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(ls:*)"]);
    const deny = listAfter(a, "--disallowedTools");
    for (const t of ["Edit", "Write", "NotebookEdit"]) assert.ok(deny.includes(t), t);
  });

  test("implement allows Edit/Write plus implementAllow", () => {
    const a = buildArgs(cfgWith({ implementAllow: ["Bash(npm test:*)", "Bash(npx tsc:*)"] }), "implement");
    assert.equal(valueOf(a, "--permission-mode"), "acceptEdits");
    const allow = listAfter(a, "--allowedTools");
    for (const t of ["Read", "Edit", "Write", "Bash(npm test:*)", "Bash(npx tsc:*)"]) assert.ok(allow.includes(t), t);
    const deny = listAfter(a, "--disallowedTools");
    for (const t of ["Edit", "Write", "NotebookEdit"]) assert.ok(!deny.includes(t), `${t} must not be denied when implementing`);
  });

  test("deny list: destructive git, rm, .briefwise/.kimi and denyRead paths", () => {
    for (const mode of ["ask", "implement"] as const) {
      const deny = listAfter(buildArgs(cfgWith(), mode), "--disallowedTools");
      for (const t of [
        "Bash(git push:*)", "Bash(git reset:*)", "Bash(git checkout:*)", "Bash(git clean:*)", "Bash(rm:*)",
        "Read(./.briefwise/**)", "Edit(./.briefwise/**)", "Write(./.briefwise/**)", "Read(./.kimi/**)",
        "Read(./.env)", "Read(./**/.env)", "Edit(./.env)", "Read(./.env.*)", "Read(./**/*.pem)", "Read(./secrets/**)",
      ]) assert.ok(deny.includes(t), `${mode}: ${t}`);
      assert.ok(!deny.includes("Read(./**/secrets/**)"), "patterns with a slash stay anchored");
    }
  });

  test("--setting-sources project,local unless userSettings", () => {
    assert.equal(valueOf(buildArgs(cfgWith(), "ask"), "--setting-sources"), "project,local");
    assert.ok(!buildArgs(cfgWith({ userSettings: true }), "ask").includes("--setting-sources"));
  });

  test("--resume only with a session id", () => {
    assert.ok(!buildArgs(cfgWith(), "implement").includes("--resume"));
    assert.equal(valueOf(buildArgs(cfgWith(), "implement", "abc-123"), "--resume"), "abc-123");
  });

  test("model, effort and budget flags only when configured", () => {
    const plain = buildArgs(cfgWith(), "ask");
    for (const f of ["--model", "--effort", "--max-budget-usd"]) assert.ok(!plain.includes(f), f);
    const a = buildArgs(cfgWith({ model: "opus", effort: "high", maxBudgetUsdPerCall: 2.5 }), "ask");
    assert.equal(valueOf(a, "--model"), "opus");
    assert.equal(valueOf(a, "--effort"), "high");
    assert.equal(valueOf(a, "--max-budget-usd"), "2.5");
  });
});

describe("resolveClaudeBin", () => {
  test("configured path wins, then CLAUDE_BIN", () => {
    const saved = process.env.CLAUDE_BIN;
    try {
      process.env.CLAUDE_BIN = "/opt/from-env/claude";
      assert.equal(resolveClaudeBin("/opt/configured/claude"), "/opt/configured/claude");
      assert.equal(resolveClaudeBin(null), "/opt/from-env/claude");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = saved;
    }
  });

  test("an npm claude.cmd shim resolves to the package's JS entry (runs via node)", () => {
    const dir = tmpDir("briefwise-npmshim-");
    try {
      const pkg = path.join(dir, "node_modules", "@anthropic-ai", "claude-code");
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(dir, "claude.cmd"), "@echo off\r\n");
      fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ bin: { claude: "cli.js" } }));
      fs.writeFileSync(path.join(pkg, "cli.js"), "");
      assert.equal(resolveClaudeBin(path.join(dir, "claude.cmd")), path.join(pkg, "cli.js"));
      // a .cmd without npm's layout is passed through unchanged
      fs.rmSync(path.join(pkg, "cli.js"));
      assert.equal(resolveClaudeBin(path.join(dir, "claude.cmd")), path.join(dir, "claude.cmd"));
    } finally {
      rmrf(dir);
    }
  });
});

describe("startClaude with the fake CLI (.mjs runs via node)", () => {
  const dirs: string[] = [];
  after(() => dirs.forEach(rmrf));

  test("streams init → tool → tool_result → text and resolves with the result", async () => {
    const repo = makeRepo({ "src/app.js": "console.log(1);\n" });
    dirs.push(repo);
    const events: ClaudeEvent[] = [];
    const run = startClaude({
      bin: FAKE_CLAUDE, repo, args: buildArgs(cfgWith(), "implement"),
      prompt: withMode("implement", "Edit it. [fake:edit src/app.js]"),
      onEvent: (e) => events.push(e),
    });
    const res = await run.done;
    assert.deepEqual(events.map((e) => e.kind), ["init", "tool", "tool_result", "text"]);
    const init = events[0] as Extract<ClaudeEvent, { kind: "init" }>;
    assert.match(init.sessionId, /^fake-session-/);
    assert.equal(res.sessionId, init.sessionId);
    assert.equal(res.isError, false);
    assert.equal(res.costUsd, 0.0125);
    assert.match(res.text, /REPORT: edited src\/app\.js/);
    assert.match(fs.readFileSync(path.join(repo, "src/app.js"), "utf8"), /edited by fake claude/);
    assert.equal(run.interject("late"), false, "a finished run cannot be interjected");
  });

  test("a missing binary resolves with a helpful error instead of throwing", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const res = await startClaude({ bin: path.join(dir, "no-such-claude"), repo: dir, args: [], prompt: "x", onEvent: () => {} }).done;
    assert.equal(res.isError, true);
    assert.match(res.text, /could not start Claude Code/);
    assert.match(res.text, /claude\.path/);
  });

  test("stop() kills the process", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const log = path.join(dir, "fake.log");
    process.env.FAKE_CLAUDE_LOG = log;
    try {
      let resolveInit: () => void = () => {};
      const inited = new Promise<void>((r) => (resolveInit = r));
      const run = startClaude({
        bin: FAKE_CLAUDE, repo: dir, args: buildArgs(cfgWith(), "ask"), prompt: "wait [fake:hang]",
        onEvent: (e) => { if (e.kind === "init") resolveInit(); },
      });
      await inited;
      const pid = JSON.parse(fs.readFileSync(log, "utf8").split("\n")[0]).pid as number;
      assert.equal(alive(pid), true);
      run.stop();
      const res = await run.done;
      assert.equal(res.stopped, true);
      assert.match(res.text, /^STOPPED/);
      assert.equal(alive(pid), false);
    } finally {
      delete process.env.FAKE_CLAUDE_LOG;
    }
  });
});
