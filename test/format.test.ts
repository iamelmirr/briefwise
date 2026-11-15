import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { describeTool, relPath } from "../src/format.ts";
import { leadName } from "../src/names.ts";

describe("leadName", () => {
  const cases: [string, string][] = [
    ["moonshotai/kimi-k3.1-pro", "Kimi"],
    ["~moonshotai/kimi-latest", "Kimi"],
    ["someone/kimi-finetune", "Kimi"],
    ["qwen/qwen3.8-max", "Qwen"],
    ["z-ai/glm-5", "GLM"],
    ["thudm/glm-4", "GLM"],
    ["deepseek/deepseek-v4", "DeepSeek"],
    ["google/gemini-3-pro", "Gemini"],
    ["openai/gpt-5.2", "GPT"],
    ["x-ai/grok-5", "Grok"],
    ["minimax/minimax-m3", "MiniMax"],
    ["mistralai/mistral-large", "Mistral"],
    ["meta-llama/llama-5", "Llama"],
    ["anthropic/claude-opus", "Claude"],
    ["acme/unknown-model", "Lead"],
    ["", "Lead"],
  ];
  for (const [model, name] of cases) test(`${model || "(empty)"} → ${name}`, () => assert.equal(leadName(model), name));
});

describe("relPath", () => {
  const repo = path.resolve("briefwise-fake-repo", "project");
  test("absolute paths inside the repo become forward-slash relative paths", () => {
    assert.equal(relPath(repo, path.join(repo, "src", "a.ts")), "src/a.ts");
    assert.equal(relPath(repo, repo), ".");
  });
  test("relative paths are kept; paths outside the repo stay absolute; non-strings are empty", () => {
    assert.equal(relPath(repo, "src/a.ts"), "src/a.ts");
    const outside = path.join(path.dirname(repo), "elsewhere.txt");
    assert.equal(relPath(repo, outside), outside.split(path.sep).join("/"));
    assert.equal(relPath(repo, undefined), "");
    assert.equal(relPath(repo, 42), "");
  });
});

describe("describeTool", () => {
  const repo = path.resolve("briefwise-fake-repo", "project");
  const abs = (...p: string[]) => path.join(repo, ...p);

  test("file tools", () => {
    assert.equal(describeTool(repo, "Read", { file_path: abs("src", "a.ts") }), "src/a.ts");
    assert.equal(describeTool(repo, "Read", { file_path: abs("src", "a.ts"), offset: 40 }), "src/a.ts :40");
    assert.equal(describeTool(repo, "Edit", { file_path: abs("a.ts"), old_string: "x", new_string: "y\nz\nw" }), "a.ts  +3 −1");
    assert.equal(describeTool(repo, "Edit", { file_path: abs("a.ts"), old_string: "", new_string: "y" }), "a.ts  +1 −0");
    assert.equal(describeTool(repo, "MultiEdit", { file_path: abs("a.ts"), edits: [{}, {}] }), "a.ts  (2 edits)");
    assert.equal(describeTool(repo, "Write", { file_path: abs("b.md"), content: "1\n2\n" }), "b.md  (3 lines)");
    assert.equal(describeTool(repo, "NotebookEdit", { notebook_path: abs("n.ipynb") }), "n.ipynb");
  });

  test("Bash shows the first line, max 160 chars", () => {
    assert.equal(describeTool(repo, "Bash", { command: "npm test\necho second" }), "npm test");
    assert.equal(describeTool(repo, "Bash", { command: "x".repeat(300) }).length, 160);
  });

  test("search tools", () => {
    assert.equal(describeTool(repo, "Grep", { pattern: "foo" }), '"foo"');
    assert.equal(describeTool(repo, "Grep", { pattern: "foo", path: repo }), '"foo"');
    assert.equal(describeTool(repo, "Grep", { pattern: "foo", path: abs("src"), glob: "*.ts" }), '"foo" in src (*.ts)');
    assert.equal(describeTool(repo, "Glob", { pattern: "**/*.ts" }), "**/*.ts");
  });

  test("other tools", () => {
    assert.equal(describeTool(repo, "TodoWrite", { todos: [1, 2, 3] }), "plan: 3 items");
    assert.equal(describeTool(repo, "Task", { description: "explore auth" }), "explore auth");
    assert.equal(describeTool(repo, "Agent", { description: "review" }), "review");
    assert.equal(describeTool(repo, "WebFetch", { url: "https://example.com" }), "https://example.com");
    assert.equal(describeTool(repo, "WebSearch", { query: "q" }), "q");
    assert.equal(describeTool(repo, "mcp__x__y", { a: 1 }), '{"a":1}');
    assert.equal(describeTool(repo, "Unknown", { s: "z".repeat(500) }).length, 120);
    assert.equal(describeTool(repo, "Read", undefined), "");
  });
});
