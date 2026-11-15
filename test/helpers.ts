// Shared helpers for the offline test suite: temp git repos and an in-process mock of OpenRouter.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATES = path.join(ROOT, "templates");
export const FAKE_CLAUDE = path.join(ROOT, "test", "fixtures", "fake-claude.mjs");

/** A fresh, real temp directory (symlinks resolved, e.g. macOS /var → /private/var). */
export function tmpDir(prefix = "briefwise-test-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export function sh(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function writeFile(repo: string, rel: string, content: string): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** A temp git repo with the given files committed. Local config only, so it works on bare CI runners. */
export function makeRepo(files: Record<string, string> = {}): string {
  const repo = tmpDir();
  sh(repo, ["-c", "init.defaultBranch=main", "init", "-q"]);
  for (const [k, v] of [["user.name", "Briefwise Test"], ["user.email", "test@example.invalid"], ["core.autocrlf", "false"], ["commit.gpgsign", "false"]]) {
    sh(repo, ["config", k, v]);
  }
  writeFile(repo, "README.md", "# test repo\n");
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  sh(repo, ["add", "-A"]);
  sh(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

// ───────────── mock OpenRouter ─────────────

export type Reply =
  | { status: number; body: string }
  | { sse: string; splitEvery?: number }; // the raw SSE stream, written in byte slices of splitEvery

export type Recorded = { headers: http.IncomingHttpHeaders; body: any; url: string };

export type ToolSpec = { name: string; args: unknown; id?: string };

let callSeq = 0;

/** One streamed assistant turn in OpenAI/OpenRouter SSE form: reasoning, text and tool calls split across chunks, then usage. */
export function turn(o: { reasoning?: string; text?: string; tools?: ToolSpec[]; cost?: number; promptTokens?: number; cachedTokens?: number }): string {
  const events: string[] = [];
  const push = (delta: unknown) => events.push(`data: ${JSON.stringify({ id: "gen-1", choices: [{ index: 0, delta }] })}\n\n`);
  const halves = (s: string) => [s.slice(0, Math.ceil(s.length / 2)), s.slice(Math.ceil(s.length / 2))].filter(Boolean);
  if (o.reasoning) for (const r of halves(o.reasoning)) push({ reasoning: r });
  if (o.text) for (const t of halves(o.text)) push({ content: t });
  (o.tools ?? []).forEach((t, i) => {
    const a = JSON.stringify(t.args);
    const k = Math.max(1, Math.ceil(a.length / 3));
    const id = t.id ?? `call_${++callSeq}`;
    push({ tool_calls: [{ index: i, id, type: "function", function: { name: t.name, arguments: a.slice(0, k) } }] });
    push({ tool_calls: [{ index: i, function: { arguments: a.slice(k, 2 * k) } }] });
    push({ tool_calls: [{ index: i, function: { arguments: a.slice(2 * k) } }] });
  });
  events.push(`: OPENROUTER PROCESSING\n\n`);
  events.push(`data: ${JSON.stringify({
    id: "gen-1", choices: [{ index: 0, delta: {}, finish_reason: o.tools?.length ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: o.promptTokens ?? 1000, completion_tokens: 50, cost: o.cost ?? 0.001, prompt_tokens_details: { cached_tokens: o.cachedTokens ?? 0 } },
  })}\n\n`);
  events.push("data: [DONE]\n\n");
  return events.join("");
}

/** Shorthand: an SSE reply with one tool call. */
export const toolReply = (name: string, args: unknown, extra: { text?: string; reasoning?: string } = {}): Reply =>
  ({ sse: turn({ ...extra, tools: [{ name, args }] }), splitEvery: 29 });

export class MockOpenRouter {
  requests: Recorded[] = [];
  queue: Reply[] = [];
  /** Optional router: return a reply for this request, or undefined to fall back to the queue. */
  route?: (body: any, n: number) => Reply | undefined;
  url = "";
  private server = http.createServer((req, res) => void this.handle(req, res));

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api/v1`;
    return this;
  }

  reset(queue: Reply[] = []): void {
    this.requests = [];
    this.queue = queue;
    this.route = undefined;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* keep null */ }
    this.requests.push({ headers: req.headers, body, url: req.url ?? "" });
    const reply = this.route?.(body, this.requests.length) ?? this.queue.shift()
      ?? { status: 418, body: JSON.stringify({ error: { message: "mock: no scripted reply left" } }) };
    if ("status" in reply) {
      res.writeHead(reply.status, { "content-type": "application/json", connection: "close" });
      res.end(reply.body);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
    const buf = Buffer.from(reply.sse, "utf8");
    const step = reply.splitEvery ?? buf.length;
    for (let i = 0; i < buf.length; i += step) {
      res.write(buf.subarray(i, i + step));
      await new Promise((r) => setImmediate(r));
    }
    res.end();
  }
}

/** True while a process with this pid exists. */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === "EPERM"; }
}

export async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}
