import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { changesSince, dirtyFiles, git, guardIssues, snapshot, type Change } from "../src/git.ts";
import { makeRepo, rmrf, sh, writeFile } from "./helpers.ts";

const repos: string[] = [];
const repo = (files: Record<string, string> = {}): string => {
  const r = makeRepo(files);
  repos.push(r);
  return r;
};
after(() => repos.forEach(rmrf));

const byFile = (cs: Change[]) => Object.fromEntries(cs.map((c) => [c.file, c.code]));

describe("git helpers", () => {
  test("git() returns stdout, and a 'git error' string instead of throwing", () => {
    const r = repo();
    assert.equal(git(r, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
    assert.match(git(r, ["no-such-command"]), /^git error: /);
    assert.equal(git(r, ["grep", "-n", "definitely-not-in-the-repo"]), "", "exit 1 without stderr is an empty result");
  });

  test("dirtyFiles: modified, untracked (with spaces), deleted; ignores .briefwise/ and .kimi/", () => {
    const r = repo({ "a.txt": "a\n", "b.txt": "b\n" });
    fs.appendFileSync(path.join(r, "a.txt"), "more\n");
    fs.rmSync(path.join(r, "b.txt"));
    writeFile(r, "new dir/my notes.txt", "hi\n");
    writeFile(r, ".briefwise/log.md", "log\n");
    writeFile(r, ".kimi/log.md", "log\n");
    const d = dirtyFiles(r);
    assert.deepEqual(Object.fromEntries(d), { "a.txt": " M", "b.txt": " D", "new dir/my notes.txt": "??" });
  });

  test("dirtyFiles outside a git repo is empty", () => {
    const r = repo();
    fs.rmSync(path.join(r, ".git"), { recursive: true, force: true });
    assert.equal(dirtyFiles(r).size, 0);
  });
});

describe("snapshot / changesSince", () => {
  test("no changes → nothing reported", () => {
    const r = repo({ "a.txt": "a\n" });
    fs.appendFileSync(path.join(r, "a.txt"), "dirty before\n");
    const before = snapshot(r);
    assert.deepEqual(changesSince(r, before), []);
  });

  test("a change to a clean file is reported", () => {
    const r = repo({ "src/app.js": "x\n" });
    const before = snapshot(r);
    fs.appendFileSync(path.join(r, "src/app.js"), "y\n");
    assert.deepEqual(changesSince(r, before), [{ file: "src/app.js", code: " M" }]);
  });

  test("a re-edit of an already-dirty file is detected (content hash)", () => {
    const r = repo({ "a.txt": "a\n" });
    fs.appendFileSync(path.join(r, "a.txt"), "user edit\n");
    const before = snapshot(r);
    assert.equal(before.get("a.txt")?.split(":")[0], " M");
    fs.appendFileSync(path.join(r, "a.txt"), "claude edit\n");
    assert.deepEqual(changesSince(r, before), [{ file: "a.txt", code: " M" }]);
  });

  test("a file reverted to its committed state is reported with a blank code", () => {
    const r = repo({ "a.txt": "a\n" });
    fs.appendFileSync(path.join(r, "a.txt"), "user edit\n");
    const before = snapshot(r);
    fs.writeFileSync(path.join(r, "a.txt"), "a\n");
    assert.deepEqual(changesSince(r, before), [{ file: "a.txt", code: "  " }]);
  });

  test("a new file with a space in its name", () => {
    const r = repo();
    const before = snapshot(r);
    writeFile(r, "my file.txt", "x\n");
    writeFile(r, "sub dir/other file.ts", "y\n");
    const cs = changesSince(r, before);
    assert.deepEqual(byFile(cs), { "my file.txt": "??", "sub dir/other file.ts": "??" });
    assert.deepEqual(guardIssues(cs), []);
  });

  test("deleted files are flagged", () => {
    const r = repo({ "src/old.ts": "x\n" });
    const before = snapshot(r);
    fs.rmSync(path.join(r, "src/old.ts"));
    const cs = changesSince(r, before);
    assert.deepEqual(cs, [{ file: "src/old.ts", code: " D" }]);
    assert.deepEqual(guardIssues(cs), ["deleted: src/old.ts"]);
  });

  test("staged deletions are flagged too", () => {
    const r = repo({ "src/old.ts": "x\n" });
    const before = snapshot(r);
    sh(r, ["rm", "-q", "src/old.ts"]);
    assert.deepEqual(guardIssues(changesSince(r, before)), ["deleted: src/old.ts"]);
  });

  test("package.json and lockfiles are flagged as dependencies", () => {
    const r = repo({ "package.json": "{}\n", "apps/web/package.json": "{}\n" });
    const before = snapshot(r);
    writeFile(r, "package.json", '{ "dependencies": { "left-pad": "1" } }\n');
    writeFile(r, "apps/web/package.json", '{ "name": "web" }\n');
    writeFile(r, "package-lock.json", "{}\n");
    writeFile(r, "pnpm-lock.yaml", "x\n");
    writeFile(r, "yarn.lock", "x\n");
    writeFile(r, "src/app.js", "x\n");
    const issues = guardIssues(changesSince(r, before));
    assert.deepEqual(issues.sort(), [
      "dependencies: apps/web/package.json",
      "dependencies: package-lock.json",
      "dependencies: package.json",
      "dependencies: pnpm-lock.yaml",
      "dependencies: yarn.lock",
    ]);
  });

  test("migrations and schema files are flagged", () => {
    const r = repo();
    const before = snapshot(r);
    writeFile(r, "db/migrations/001_init.js", "x\n");
    writeFile(r, "prisma/schema.prisma", "x\n");
    writeFile(r, "sql/views.sql", "x\n");
    const issues = guardIssues(changesSince(r, before));
    assert.deepEqual(issues.sort(), [
      "database schema: db/migrations/001_init.js",
      "database schema: prisma/schema.prisma",
      "database schema: sql/views.sql",
    ]);
  });

  test("CI / deploy files are flagged", () => {
    const r = repo();
    const before = snapshot(r);
    writeFile(r, ".github/workflows/ci.yml", "x\n");
    writeFile(r, "Dockerfile", "FROM node\n");
    writeFile(r, "docker-compose.prod.yml", "x\n");
    writeFile(r, "infra/main.tf", "x\n");
    writeFile(r, "k8s/deploy.yaml", "x\n");
    writeFile(r, ".env.production", "X=1\n");
    const issues = guardIssues(changesSince(r, before));
    assert.deepEqual(issues.sort(), [
      "deployment / production config: .env.production",
      "deployment / production config: .github/workflows/ci.yml",
      "deployment / production config: Dockerfile",
      "deployment / production config: docker-compose.prod.yml",
      "deployment / production config: infra/main.tf",
      "deployment / production config: k8s/deploy.yaml",
    ]);
  });
});

describe("guardIssues (pure)", () => {
  test("ordinary source changes are fine", () => {
    assert.deepEqual(guardIssues([{ file: "src/index.ts", code: " M" }, { file: "src/package.json.md", code: "??" }, { file: "README.md", code: "M " }]), []);
  });

  test("several issues for one file, de-duplicated across changes", () => {
    const issues = guardIssues([
      { file: "package.json", code: " D" },
      { file: "package.json", code: " D" },
      { file: "Cargo.toml", code: " M" },
      { file: "src/App.csproj", code: "??" },
      { file: "go.sum", code: "  " },
    ]);
    assert.deepEqual(issues, ["deleted: package.json", "dependencies: package.json", "dependencies: Cargo.toml", "dependencies: src/App.csproj", "dependencies: go.sum"]);
  });
});
