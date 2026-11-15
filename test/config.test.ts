import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG, clip, init, isDenied, projectPaths } from "../src/config.ts";
import { TEMPLATES, rmrf, tmpDir } from "./helpers.ts";

const DENY = DEFAULT_CONFIG.claude.denyRead;
const PRISTINE = structuredClone(DEFAULT_CONFIG);
const dirs: string[] = [];
const fresh = (): string => {
  const d = tmpDir();
  dirs.push(d);
  return d;
};
after(() => dirs.forEach(rmrf));

describe("isDenied", () => {
  test("dotenv files anywhere, with variants", () => {
    assert.equal(isDenied(".env", DENY), true);
    assert.equal(isDenied("./.env", DENY), true);
    assert.equal(isDenied(".ENV", DENY), true, "case-insensitive");
    assert.equal(isDenied(".env.local", DENY), true);
    assert.equal(isDenied(".env.production", DENY), true);
    assert.equal(isDenied("apps/web/.env", DENY), true, "basename patterns match nested paths");
    assert.equal(isDenied("apps/web/.env.local", DENY), true);
    assert.equal(isDenied("src/env.ts", DENY), false);
    assert.equal(isDenied("docs/.envrc-notes.md", DENY), false);
  });

  test("**/*.pem and **/*.key match at the root and nested", () => {
    assert.equal(isDenied("server.pem", DENY), true);
    assert.equal(isDenied("certs/server.pem", DENY), true);
    assert.equal(isDenied("a/b/c/id.key", DENY), true);
    assert.equal(isDenied("certs/server.pem.txt", DENY), false);
    assert.equal(isDenied("src/keyboard.ts", DENY), false);
  });

  test("secrets/** is anchored at the repo root", () => {
    assert.equal(isDenied("secrets/token.txt", DENY), true);
    assert.equal(isDenied("secrets/deep/nested/token.txt", DENY), true);
    assert.equal(isDenied("app/secrets/token.txt", DENY), false);
    assert.equal(isDenied("secretsfile.txt", DENY), false);
  });

  test("single-segment wildcards", () => {
    assert.equal(isDenied("src/a.ts", ["src/*.ts"]), true);
    assert.equal(isDenied("src/sub/a.ts", ["src/*.ts"]), false);
    assert.equal(isDenied("src/sub/a.ts", ["src/**/*.ts"]), true);
    assert.equal(isDenied("x1.txt", ["x?.txt"]), true);
    assert.equal(isDenied("x12.txt", ["x?.txt"]), false);
    assert.equal(isDenied("a+b(c).txt", ["a+b(c).txt"]), true, "regex metacharacters are literal");
  });

  test(".briefwise/** and legacy .kimi/** are always denied, even with no patterns", () => {
    for (const p of [".briefwise", ".briefwise/config.json", ".briefwise/PRIVATE.md", "./.briefwise/log.md", ".kimi", ".kimi/PRIVATE.md"]) {
      assert.equal(isDenied(p, []), true, p);
    }
    assert.equal(isDenied("src/.briefwise-notes.md", []), false);
    assert.equal(isDenied("README.md", []), false);
  });

  test("platform-separator paths", () => {
    assert.equal(isDenied(path.join("secrets", "a.txt"), DENY), true);
    assert.equal(isDenied(path.join(".briefwise", "PRIVATE.md"), []), true);
    assert.equal(isDenied(path.join("apps", "web", ".env"), DENY), true);
  });

  test("Windows backslash paths", { skip: process.platform !== "win32" && "backslash is not a path separator here" }, () => {
    assert.equal(isDenied("secrets\\a.txt", DENY), true);
    assert.equal(isDenied("apps\\web\\.env.local", DENY), true);
    assert.equal(isDenied("certs\\server.pem", DENY), true);
    assert.equal(isDenied(".briefwise\\PRIVATE.md", []), true);
    assert.equal(isDenied(".kimi\\RULES.md", []), true);
    assert.equal(isDenied("src\\index.ts", DENY), false);
  });
});

describe("clip", () => {
  test("short strings are unchanged, long ones are cut with a count and hint", () => {
    assert.equal(clip("hello", 10), "hello");
    assert.equal(clip("0123456789", 10), "0123456789");
    assert.equal(clip("0123456789abc", 10), "0123456789\n…[truncated 3 chars]");
    assert.equal(clip("0123456789abc", 10, "read less"), "0123456789\n…[truncated 3 chars; read less]");
  });
});

describe("init", () => {
  test("creates .briefwise/ from the templates and loads the template config", () => {
    const repo = fresh();
    const { cfg, P } = init(repo, TEMPLATES);
    assert.equal(P.dir, path.join(repo, ".briefwise"));
    for (const f of ["RULES.md", "PRIVATE.md", "PROJECT.md", "TASKS.md", "DECISIONS.md", "config.json"]) {
      const dest = path.join(P.dir, f);
      assert.ok(fs.existsSync(dest), f);
      assert.equal(fs.readFileSync(dest, "utf8"), fs.readFileSync(path.join(TEMPLATES, f), "utf8"), f);
    }
    const template = JSON.parse(fs.readFileSync(path.join(TEMPLATES, "config.json"), "utf8"));
    assert.deepEqual(cfg.claude.implementAllow, template.claude.implementAllow);
    assert.equal(cfg.model, template.model);
    assert.deepEqual(P, projectPaths(repo));
  });

  test("does not overwrite existing files", () => {
    const repo = fresh();
    fs.mkdirSync(path.join(repo, ".briefwise"));
    fs.writeFileSync(path.join(repo, ".briefwise", "RULES.md"), "my rules");
    init(repo, TEMPLATES);
    assert.equal(fs.readFileSync(path.join(repo, ".briefwise", "RULES.md"), "utf8"), "my rules");
  });

  test("missing templates fall back to defaults (empty notes, DEFAULT_CONFIG)", () => {
    const repo = fresh();
    const { cfg, P } = init(repo, path.join(repo, "no-templates-here"));
    assert.equal(fs.readFileSync(P.rules, "utf8"), "");
    assert.deepEqual(cfg, DEFAULT_CONFIG);
  });

  test("config.json is deep-merged over the defaults; arrays replace, unknown keys are kept", () => {
    const repo = fresh();
    fs.mkdirSync(path.join(repo, ".briefwise"));
    fs.writeFileSync(path.join(repo, ".briefwise", "config.json"), JSON.stringify({
      model: "qwen/qwen3-max",
      provider: null,
      context: { softTokens: 1000 },
      claude: { denyRead: ["only.txt"], model: "opus" },
      forbidden: ["ACME"],
      extra: { x: 1 },
    }));
    const { cfg } = init(repo, TEMPLATES);
    assert.equal(cfg.model, "qwen/qwen3-max");
    assert.equal(cfg.provider, null);
    assert.equal(cfg.context.softTokens, 1000);
    assert.equal(cfg.context.hardTokens, DEFAULT_CONFIG.context.hardTokens);
    assert.equal(cfg.context.keepTaskPairs, DEFAULT_CONFIG.context.keepTaskPairs);
    assert.deepEqual(cfg.claude.denyRead, ["only.txt"], "arrays replace, not concatenate");
    assert.equal(cfg.claude.model, "opus");
    assert.equal(cfg.claude.reportMaxChars, DEFAULT_CONFIG.claude.reportMaxChars);
    assert.deepEqual(cfg.claude.implementAllow, DEFAULT_CONFIG.claude.implementAllow, "keys missing from config.json keep the default");
    assert.deepEqual(cfg.forbidden, ["ACME"]);
    assert.deepEqual((cfg as any).extra, { x: 1 });
    assert.deepEqual(DEFAULT_CONFIG, PRISTINE, "defaults are not mutated");
  });

  test("invalid config.json falls back to the defaults", () => {
    const repo = fresh();
    fs.mkdirSync(path.join(repo, ".briefwise"));
    fs.writeFileSync(path.join(repo, ".briefwise", "config.json"), "{ not json");
    const { cfg } = init(repo, TEMPLATES);
    assert.deepEqual(cfg, DEFAULT_CONFIG);
  });

  test("adds .briefwise/ to .git/info/exclude exactly once", () => {
    const repo = fresh();
    fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    const exclude = path.join(repo, ".git", "info", "exclude");
    fs.writeFileSync(exclude, "# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n");
    init(repo, TEMPLATES);
    init(repo, TEMPLATES);
    init(repo, TEMPLATES);
    const text = fs.readFileSync(exclude, "utf8");
    assert.equal(text.split("\n").filter((l) => l.trim() === ".briefwise/").length, 1);
    assert.ok(text.startsWith("# git ls-files"), "existing lines are kept");
    assert.ok(text.includes("*.log"));
  });

  test("creates the exclude file when .git/info exists but exclude does not", () => {
    const repo = fresh();
    fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    init(repo, TEMPLATES);
    assert.ok(fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8").includes(".briefwise/"));
  });

  test("outside a git repo nothing is written to .git", () => {
    const repo = fresh();
    init(repo, TEMPLATES);
    assert.equal(fs.existsSync(path.join(repo, ".git")), false);
  });

  test("migrates a legacy .kimi/ folder to .briefwise/", () => {
    const repo = fresh();
    fs.mkdirSync(path.join(repo, ".kimi"));
    fs.writeFileSync(path.join(repo, ".kimi", "RULES.md"), "legacy rules");
    fs.writeFileSync(path.join(repo, ".kimi", "history.json"), "[]");
    fs.writeFileSync(path.join(repo, ".kimi", "config.json"), JSON.stringify({ model: "legacy/model" }));
    const { cfg, P } = init(repo, TEMPLATES);
    assert.equal(fs.existsSync(path.join(repo, ".kimi")), false);
    assert.equal(fs.readFileSync(P.rules, "utf8"), "legacy rules");
    assert.equal(fs.readFileSync(P.history, "utf8"), "[]");
    assert.equal(cfg.model, "legacy/model");
    assert.ok(fs.existsSync(P.tasks), "missing files are filled in from templates");
  });

  test("does not migrate .kimi/ when .briefwise/ already exists", () => {
    const repo = fresh();
    fs.mkdirSync(path.join(repo, ".kimi"));
    fs.writeFileSync(path.join(repo, ".kimi", "RULES.md"), "legacy rules");
    fs.mkdirSync(path.join(repo, ".briefwise"));
    fs.writeFileSync(path.join(repo, ".briefwise", "RULES.md"), "current rules");
    init(repo, TEMPLATES);
    assert.equal(fs.readFileSync(path.join(repo, ".kimi", "RULES.md"), "utf8"), "legacy rules");
    assert.equal(fs.readFileSync(path.join(repo, ".briefwise", "RULES.md"), "utf8"), "current rules");
  });
});
