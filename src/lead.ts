// Briefwise core — the lead model (via OpenRouter) as tech lead, Claude Code as the coding worker.
// UI-agnostic: everything that happens is emitted as a LeadEvent (rendered by the CLI now, the VS Code panel later).

import * as fs from "node:fs";
import * as path from "node:path";
import { clip, init, isDenied, readJson, readText, writeJson, type Config, type Paths } from "./config.ts";
import { changesSince, dirtyFiles, git, guardIssues, snapshot } from "./git.ts";
import { buildArgs, describeAllowed, resolveClaudeBin, startClaude, withMode, type ClaudeEvent, type ClaudeResult, type ClaudeRun, type Mode } from "./claude.ts";
import { leadCall, type Msg } from "./openrouter.ts";
import { leadName } from "./names.ts";

export type LeadEvent =
  | { type: "lead-start" }
  | { type: "lead-reasoning"; delta: string }
  | { type: "lead-text"; delta: string }
  | { type: "lead-end"; promptTokens: number; cachedTokens: number }
  | { type: "lead-tool"; name: string; label: string }
  | { type: "claude-start"; session: string; mode: Mode; prompt: string }
  | { type: "claude-event"; session: string; event: ClaudeEvent }
  | { type: "claude-end"; session: string; result: ClaudeResult }
  | { type: "claude-files"; session: string; files: { file: string; code: string }[] }
  | { type: "guard"; issues: string[] }
  | { type: "blocked"; reason: string }
  | { type: "notice"; text: string }
  | { type: "task-end"; report: string; streamed: boolean; leadUsd: number; claudeUsd: number };

export type LeadOptions = {
  templatesDir?: string;            // where RULES.md etc. templates live (default: ../templates next to src)
  apiKey?: () => string | undefined; // OpenRouter key provider (default: OPENROUTER_API_KEY)
};

export type LeadHooks = {
  emit(e: LeadEvent): void;
  /** Ask the user a question mid-task. Resolve null if nobody can answer. */
  askUser(question: string): Promise<string | null>;
};

type Session = { id?: string; purpose: string; created: string };
type Turn = { user: string; report: string; at: string };
type Task = {
  goal: string;
  msgs: Msg[];
  priorCount: number;            // leading msgs that are earlier (question, report) pairs
  readLabels: Map<string, string>; // tool_call_id → short label, for pruning old reads
  asks: number;
  done?: string;
  streamed: boolean;
};

const str = { type: "string" };
function tool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}
const NOTE_FILES = ["PROJECT", "TASKS", "DECISIONS", "PRIVATE"] as const;
type NoteFile = (typeof NOTE_FILES)[number];

const TOOLS = [
  tool("list_files", "List tracked files, optionally filtered by a substring.", { filter: str }),
  tool("read_file", "Read part of a repo file. Small ranges (max ~200 lines per call).", { path: str, start: { type: "integer" }, end: { type: "integer" } }, ["path"]),
  tool("grep", "Search the repo (git grep, extended regex). Returns a limited number of matching lines.", { pattern: str, path: str }, ["pattern"]),
  tool("git", "Read-only git: status, diff, log, show, branch. Pass args as a list, e.g. [\"diff\", \"--stat\"].", { args: { type: "array", items: str } }, ["args"]),
  tool("update_notes", "Overwrite one of your notes files with full new content. PRIVATE is for things only you may know (never shared with Claude).", { file: { type: "string", enum: [...NOTE_FILES] }, content: str }, ["file", "content"]),
  tool("new_session", "Register a named Claude Code session for a workstream (e.g. 'auth', 'billing-api').", { name: str, purpose: str }, ["name", "purpose"]),
  tool("list_sessions", "List Claude Code sessions."),
  tool("ask_claude", "Consult Claude Code in a session, read-only (it investigates code, cannot change it). Counts toward the per-task consultation limit.", { session: str, prompt: str }, ["session", "prompt"]),
  tool("implement", "Have Claude Code implement changes in a session. It edits files and runs allowed checks.", { session: str, prompt: str }, ["session", "prompt"]),
  tool("escalate_to_user", "Stop and ask the user. Use for approvals (dependencies, schema, deletions, production) or real ambiguity about the goal.", { question: str }, ["question"]),
  tool("finish", "Task done (or cannot continue). Give the user the final report in their language.", { report: str }, ["report"]),
];
const READ_TOOLS = new Set(["list_files", "read_file", "grep", "git"]);

const CHECKPOINT = `CONTEXT CHECKPOINT (from the system, not the user): your context is full. Write a compact summary for yourself so you can continue this task with a fresh context: the goal, what you learned (files, functions), what Claude did in which session, decisions made, what remains. Max 300 words. Do not call tools.`;

const estTokens = (system: string, msgs: Msg[]) => Math.ceil((system.length + JSON.stringify(msgs).length) / 3.5);

export class Lead {
  readonly repo: string;
  readonly cfg: Config;
  readonly P: Paths;
  readonly claudeBin: string;
  sessions: Record<string, Session>;
  leadUsd = 0;
  claudeUsd = 0;

  private hooks: LeadHooks;
  private opts: LeadOptions;
  private abort?: AbortController;
  private active?: ClaudeRun;
  private userNotes: string[] = []; // what the user told Claude directly during the current run
  private running = false;
  private stopped = false;
  private warnedDirty = false;

  constructor(repo: string, hooks: LeadHooks, opts: LeadOptions = {}) {
    this.repo = repo;
    this.hooks = hooks;
    this.opts = opts;
    const { cfg, P } = init(repo, opts.templatesDir);
    this.cfg = cfg;
    this.P = P;
    this.claudeBin = resolveClaudeBin(cfg.claude.path);
    this.sessions = readJson(P.sessions, {});
  }

  get busy(): boolean { return this.running; }
  get claudeActive(): boolean { return !!this.active; }

  /** Stop the current task: aborts the lead's request and kills the running Claude process. */
  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.active?.stop();
  }

  /** Send a message from the user straight into the running Claude session. */
  interject(text: string): boolean {
    if (!this.active) return false;
    this.log("user → Claude (interjection)", text);
    const ok = this.active.interject(text);
    if (ok) this.userNotes.push(text);
    return ok;
  }

  newConversation(): void { writeJson(this.P.history, []); }

  /** Change the lead model (any OpenRouter model with tool support); saved in .briefwise/config.json. */
  setModel(model: string): void {
    this.cfg.model = model;
    this.saveConfig((c) => { c.model = model; });
  }

  /** Change Claude Code's model: null = the user's own default, otherwise an alias like "opus". */
  setClaudeModel(model: string | null): void {
    this.cfg.claude.model = model;
    this.saveConfig((c) => { c.claude = { ...(c.claude ?? {}), model }; });
  }

  private saveConfig(change: (c: any) => void) {
    let c: any;
    try { c = JSON.parse(readText(this.P.config, "{}")); } catch {
      throw new Error(".briefwise/config.json is not valid JSON, so it was left unchanged. Fix it and try again.");
    }
    change(c);
    writeJson(this.P.config, c);
  }

  branch(): string {
    const b = git(this.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    return b.startsWith("git error") ? "" : b;
  }

  sessionId(name: string): string | undefined { return this.sessions[name]?.id; }

  listSessions(): string {
    const rows = Object.entries(this.sessions).map(([k, v]) => [k, { purpose: v.purpose, started: !!v.id, id: v.id }]);
    return rows.length ? JSON.stringify(Object.fromEntries(rows), null, 2) : "(no sessions)";
  }

  async run(userMsg: string): Promise<string> {
    if (this.running) throw new Error(`${leadName(this.cfg.model)} is already working on a task`);
    this.running = true;
    this.stopped = false;
    this.leadUsd = 0;
    this.claudeUsd = 0;
    try {
      return await this.runTask(userMsg);
    } finally {
      this.running = false;
      this.abort = undefined;
      this.active = undefined;
    }
  }

  // ───────────── internals ─────────────

  private emit(e: LeadEvent) { this.hooks.emit(e); }

  private log(section: string, body: string) {
    fs.appendFileSync(this.P.log, `\n## ${new Date().toISOString()} — ${section}\n\n${body.trim()}\n`);
  }

  private loadTurns(): Turn[] {
    const h = readJson<unknown[]>(this.P.history, []);
    return Array.isArray(h) ? (h.filter((t: any) => typeof t?.user === "string" && typeof t?.report === "string") as Turn[]) : [];
  }

  private allowedForPrompt(): string {
    const cmds = describeAllowed(this.cfg.claude.implementAllow.filter((r) => r.startsWith("Bash(")));
    return cmds.length ? cmds.map((c) => `\`${c}\``).join(", ") : "none (no tests or builds)";
  }

  private saveTurn(user: string, report: string) {
    const turns = [...this.loadTurns(), { user, report, at: new Date().toISOString() }];
    writeJson(this.P.history, turns.slice(-50));
  }

  private systemPrompt(): string {
    const sess = Object.entries(this.sessions).map(([k, v]) => `- ${k}: ${v.purpose}`).join("\n") || "(none yet)";
    return `You are the technical lead of the repository at ${this.repo}. The user is your boss. Claude Code is your engineer.

Your main job: turn what the user says (often casual, in their own language) into precise technical tasks that Claude Code understands and implements well, and keep to yourself what Claude does not need to know.

How you work:
- You never write code. Claude Code does all coding and deep investigation.
- You may read code (read_file, grep, list_files, git) to understand where and what, so your prompts are concrete. Read small pieces. Old read results are pruned from your context automatically; re-read if you need them again. For broad investigation, ask Claude instead.
- Prompts to Claude: English, self-contained, technical: goal, relevant files/functions, constraints, what "done" means, which checks to run. Never forward the user's words verbatim. Never include anything from PRIVATE or anything the user's rules forbid.
- Flow: if the approach is not obvious, ask_claude for 2-3 options → choose by the goal and the user's rules → implement → review (Claude's report + git diff) → send fixes if needed → finish.
- Claude's replies to you are short reports. The user watches Claude's full session live, so do not repeat Claude's details back to them.
- The user may message Claude directly while it works. Those messages are listed after Claude's report; they are the user's decisions and override your brief, so review against them and never have Claude undo them.
- When implementing, Claude may run only these commands: ${this.allowedForPrompt()}. Name the right one for checks in your prompt. If Claude reports that a check could not run, have it use an allowed command; if none fits, tell the user which command to add to claude.implementAllow in .briefwise/config.json.
- Work autonomously until done. escalate_to_user only for: new/changed dependencies, database schema, deleting files, production/deployment, or a genuinely ambiguous goal. A GUARD warning means you must escalate or have Claude revert.
- One Claude session per workstream (new_session); reuse a session to continue the same work, it remembers.
- The raw conversation is not kept between tasks; your notes are your long-term memory. Before finishing, update TASKS/DECISIONS briefly if something changed, and PROJECT when you learn lasting facts. Keep notes compact.
- When the user tells you something private (clients, business context, people, money), save it in PRIVATE. Only you see PRIVATE.
- If the user only asks a question or chats, answer directly, no tools needed.
- Always reply to the user in the language they write in; prompts to Claude stay in English. Be brief. Reports: what was done, why, what is open.

USER'S RULES (highest priority; they override everything above except safety). They define how you may talk to Claude and what Claude may know:
<rules>
${readText(this.P.rules).trim() || "(none)"}
</rules>

PRIVATE (only for you; never put any of this into a prompt for Claude):
<private>
${readText(this.P.private).trim() || "(empty)"}
</private>

<notes name="PROJECT">
${readText(this.P.project).trim()}
</notes>
<notes name="TASKS">
${readText(this.P.tasks).trim()}
</notes>
<notes name="DECISIONS">
${readText(this.P.decisions).trim()}
</notes>

Claude sessions:
${sess}`;
  }

  /** silent: internal call (context checkpoint) — its text is not shown to the user. */
  private async callLead(system: string, msgs: Msg[], effort: string | null, toolChoice?: "none", silent = false) {
    this.abort = new AbortController();
    this.emit({ type: "lead-start" });
    const r = await leadCall({
      cfg: this.cfg, apiKey: this.opts.apiKey?.(), system, messages: msgs, tools: TOOLS, effort, toolChoice, signal: this.abort.signal,
      onText: (delta) => { if (!silent) this.emit({ type: "lead-text", delta }); },
      onReasoning: (delta) => this.emit({ type: "lead-reasoning", delta }),
    });
    this.leadUsd += r.costUsd;
    this.emit({ type: "lead-end", promptTokens: r.promptTokens, cachedTokens: r.cachedTokens });
    return r.msg;
  }

  /** Keep the lead's context small: prune old reads/reasoning, drop earlier turns, then summarize the task. */
  private async fitContext(system: string, t: Task): Promise<void> {
    const { softTokens, hardTokens } = this.cfg.context;
    if (estTokens(system, t.msgs) <= softTokens) return;

    const reads = t.msgs
      .map((m, i) => (m.role === "tool" && m.tool_call_id && t.readLabels.has(m.tool_call_id) && !m.content.startsWith("[pruned") ? i : -1))
      .filter((i) => i >= 0);
    for (const i of reads.slice(0, -2)) {
      const m = t.msgs[i];
      t.msgs[i] = { ...m, content: `[pruned to save context: ${t.readLabels.get(m.tool_call_id!)}; read again if you need it]` };
    }
    const lastAssistant = t.msgs.map((m) => m.role).lastIndexOf("assistant");
    t.msgs = t.msgs.map((m, i) => {
      if (m.role !== "assistant" || !m.reasoning || i === lastAssistant) return m;
      const { reasoning: _r, ...rest } = m;
      return rest;
    });
    if (estTokens(system, t.msgs) <= hardTokens) return;

    if (t.priorCount > 0) {
      t.msgs = t.msgs.slice(t.priorCount);
      t.priorCount = 0;
      if (estTokens(system, t.msgs) <= hardTokens) return;
    }

    this.emit({ type: "notice", text: `Context is almost full; ${leadName(this.cfg.model)} is summarizing the work on this task so far…` });
    const summary = await this.callLead(system, [...t.msgs, { role: "user", content: CHECKPOINT }], "low", "none", true);
    this.log("Lead context checkpoint", summary.content);
    t.msgs = [{ role: "user", content: `${t.goal}\n\n[Context checkpoint. Your own summary of progress on this task so far:]\n${summary.content}` }];
    t.readLabels.clear();
  }

  private async runTask(userMsg: string): Promise<string> {
    this.log("USER", userMsg);
    if (!this.warnedDirty) {
      this.warnedDirty = true;
      const dirty = dirtyFiles(this.repo).size;
      if (dirty) this.emit({ type: "notice", text: `The working tree has ${dirty} uncommitted ${dirty === 1 ? "file" : "files"}. Claude's changes will mix with yours; commit first or work on a new branch.` });
    }

    const system = this.systemPrompt(); // frozen for the whole task → stable prefix for prompt caching
    const prior: Msg[] = this.loadTurns().slice(-this.cfg.context.keepTaskPairs)
      .flatMap((t): Msg[] => [{ role: "user", content: t.user }, { role: "assistant", content: t.report }]);
    const t: Task = { goal: userMsg, msgs: [...prior, { role: "user", content: userMsg }], priorCount: prior.length, readLabels: new Map(), asks: 0, streamed: false };
    let afterAsk = false;

    try {
      for (let step = 0; step < this.cfg.maxSteps && !t.done && !this.stopped; step++) {
        await this.fitContext(system, t);
        const msg = await this.callLead(system, t.msgs, afterAsk ? this.cfg.decisionEffort : this.cfg.reasoningEffort);
        t.msgs.push(msg);
        if (!msg.tool_calls?.length) {
          t.done = msg.content.trim() || `(${leadName(this.cfg.model)} did not reply)`;
          t.streamed = !!msg.content.trim();
          break;
        }
        afterAsk = false;
        for (const tc of msg.tool_calls) {
          if (this.stopped) break;
          let args: any = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* keep empty */ }
          const name = tc.function.name;
          let out: string;
          try { out = await this.callTool(t, name, args); } catch (e: any) { out = `ERROR: ${e.message}`; }
          if (READ_TOOLS.has(name)) t.readLabels.set(tc.id, this.toolLabel(name, args));
          if (name === "ask_claude") afterAsk = true;
          t.msgs.push({ role: "tool", tool_call_id: tc.id, content: out });
        }
      }
    } catch (e: any) {
      if (!this.stopped) throw e;
    }

    const report = this.stopped
      ? "Stopped."
      : t.done ?? `Stopped after ${this.cfg.maxSteps} steps without finishing. See .briefwise/log.md.`;
    this.log("Lead → user (report)", report);
    this.saveTurn(userMsg, report);
    this.emit({ type: "task-end", report, streamed: t.streamed && !this.stopped, leadUsd: this.leadUsd, claudeUsd: this.claudeUsd });
    return report;
  }

  private toolLabel(name: string, a: any): string {
    switch (name) {
      case "read_file": return `read_file ${a.path ?? ""} ${a.start ?? 1}-${a.end ?? ""}`.trim();
      case "grep": return `grep "${a.pattern ?? ""}"${a.path ? ` in ${a.path}` : ""}`;
      case "list_files": return `list_files${a.filter ? ` (${a.filter})` : ""}`;
      case "git": return `git ${(a.args ?? []).join(" ")}`;
      default: return name;
    }
  }

  private safeRel(p: unknown): string | null {
    if (typeof p !== "string" || !p) return null;
    const abs = path.resolve(this.repo, p);
    const rel = path.relative(this.repo, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/");
  }

  private forbiddenHit(text: string): number {
    return this.cfg.forbidden.findIndex((r) => {
      try { return new RegExp(r, "i").test(text); } catch { return text.toLowerCase().includes(r.toLowerCase()); }
    });
  }

  private async callTool(t: Task, name: string, a: any): Promise<string> {
    const { maxLines, maxChars, grepMax } = this.cfg.read;
    const deny = this.cfg.claude.denyRead;
    switch (name) {
      case "list_files": {
        this.emit({ type: "lead-tool", name, label: `lists files${a.filter ? ` (${a.filter})` : ""}` });
        const files = git(this.repo, ["ls-files"]).split("\n").filter((f) => f && (!a.filter || f.includes(a.filter)));
        const shown = files.slice(0, 300);
        return (shown.join("\n") || "(no files)") + (files.length > shown.length ? `\n…and ${files.length - shown.length} more; use a filter` : "");
      }
      case "read_file": {
        const rel = this.safeRel(a.path);
        if (!rel) return "ERROR: path outside the repo";
        if (isDenied(rel, deny)) return "ERROR: this file is in denyRead; you may not read it";
        const text = readText(path.join(this.repo, rel), "\u0000missing");
        if (text === "\u0000missing") return "ERROR: file not found";
        const lines = text.split("\n");
        const s = Math.max(1, a.start ?? 1);
        const e = Math.min(lines.length, a.end ?? s + maxLines - 1, s + maxLines - 1);
        this.emit({ type: "lead-tool", name, label: `reads ${rel} ${s}–${e}` });
        const body = lines.slice(s - 1, e).map((l, i) => `${s + i}\t${l.length > 500 ? l.slice(0, 500) + "…" : l}`).join("\n");
        const more = e < lines.length ? `\n[lines ${s}-${e} of ${lines.length}; ask for another range if needed]` : "";
        return clip(body, maxChars, "request a smaller range") + more;
      }
      case "grep": {
        this.emit({ type: "lead-tool", name, label: `searches "${a.pattern}"${a.path ? ` in ${a.path}` : ""}` });
        const out = git(this.repo, ["grep", "-n", "-I", "-E", "--max-count=10", String(a.pattern ?? ""), ...(a.path ? ["--", a.path] : [])]);
        if (out.startsWith("git error")) return out;
        const lines = out.split("\n").filter((l) => l && !isDenied(l.split(":")[0], deny));
        const shown = lines.slice(0, grepMax).map((l) => (l.length > 300 ? l.slice(0, 300) + "…" : l));
        return (shown.join("\n") || "(no matches)") + (lines.length > shown.length ? `\n…${lines.length - shown.length} more matches; narrow the pattern or path` : "");
      }
      case "git": {
        const args: string[] = Array.isArray(a.args) ? a.args.map(String) : [];
        if (!["status", "diff", "log", "show", "branch"].includes(args[0])) return "ERROR: only status/diff/log/show/branch allowed";
        if (args.some((x) => /^--?(output|exec|delete|force|D|d|m|M|c|C)$/.test(x) || x.startsWith("--output") || x.startsWith("--exec"))) return "ERROR: flag not allowed";
        // denyRead also applies through git: no `REV:path` or pathspec for a denied file,
        // and repo-wide output gets exclude pathspecs so denied files never appear in it
        const deny = this.cfg.claude.denyRead;
        if (args.some((x) => { const m = /^[^-:][^:]*:(.+)$/.exec(x); return !!m && isDenied(m[1], deny); })) return "ERROR: that path is in denyRead";
        const dd = args.indexOf("--");
        if (dd >= 0 && args.slice(dd + 1).some((p) => isDenied(p, deny))) return "ERROR: that path is in denyRead";
        const excludes = [".briefwise/**", ".kimi/**", ...deny].map((p) => `:(exclude,glob)${p.includes("/") ? p : `**/${p}`}`);
        const full = args[0] === "branch" ? args : dd >= 0 ? [...args, ...excludes] : [...args, "--", ".", ...excludes];
        this.emit({ type: "lead-tool", name, label: `git ${args.join(" ")}` });
        return clip(git(this.repo, full) || "(empty)", maxChars, "use git diff --stat or git diff -- <file>");
      }
      case "update_notes": {
        const file = a.file as NoteFile;
        if (!NOTE_FILES.includes(file)) return "ERROR: unknown notes file";
        const dest = { PROJECT: this.P.project, TASKS: this.P.tasks, DECISIONS: this.P.decisions, PRIVATE: this.P.private }[file];
        fs.writeFileSync(dest, String(a.content ?? ""));
        this.emit({ type: "lead-tool", name, label: `updates notes: ${file}` });
        return `saved ${file}`;
      }
      case "new_session": {
        this.sessions[a.name] ??= { purpose: a.purpose, created: new Date().toISOString() };
        writeJson(this.P.sessions, this.sessions);
        this.emit({ type: "lead-tool", name, label: `new Claude session: ${a.name}` });
        return `session '${a.name}' ready`;
      }
      case "list_sessions":
        return this.listSessions();
      case "ask_claude":
      case "implement": {
        const prompt = String(a.prompt ?? "");
        const session = String(a.session || "main");
        const hit = this.forbiddenHit(prompt);
        if (hit >= 0) {
          this.emit({ type: "blocked", reason: `${leadName(this.cfg.model)} tried to send Claude something forbidden (rule #${hit + 1} in config.forbidden). Blocked.` });
          this.log("BLOCKED", prompt);
          return `BLOCKED: the prompt contains content the user forbids sharing with Claude (rule #${hit + 1} in config.forbidden). Rephrase without it.`;
        }
        if (name === "ask_claude" && ++t.asks > this.cfg.maxAskRounds) {
          return `LIMIT: ${this.cfg.maxAskRounds} consultation rounds used for this task. Decide with what you have, implement, or escalate_to_user.`;
        }
        const mode: Mode = name === "ask_claude" ? "ask" : "implement";
        const before = mode === "implement" ? snapshot(this.repo) : null;
        this.emit({ type: "claude-start", session, mode, prompt });
        this.log(`→ Claude (${mode}, session ${session})`, prompt);
        this.userNotes = [];
        const res = await this.runClaude(session, prompt, mode);
        const notes = this.userNotes;
        this.userNotes = [];
        this.claudeUsd += res.costUsd;
        this.log(`← Claude (${session})`, res.text);
        this.emit({ type: "claude-end", session, result: res });
        let out = `${res.isError ? "CLAUDE ERROR: " : ""}${clip(res.text, this.cfg.claude.reportMaxChars)}`;
        if (notes.length) {
          out += `\n\nTHE USER TOLD CLAUDE DIRECTLY DURING THIS RUN (the user is in charge: treat this as their decision, do not undo it):\n${notes.map((n) => `- ${n}`).join("\n")}`;
        }
        if (before) {
          const changes = changesSince(this.repo, before);
          if (changes.length) {
            this.emit({ type: "claude-files", session, files: changes });
            out += `\n\nFILES CHANGED (from git): ${changes.map((c) => c.file).join(", ")}`;
          }
          const issues = guardIssues(changes);
          if (issues.length) {
            this.emit({ type: "guard", issues });
            const warn = `\n\nGUARD: these changes need the user's approval before you continue:\n- ${issues.join("\n- ")}\nEither escalate_to_user now, or have Claude revert them.`;
            this.log("GUARD", warn);
            out += warn;
          }
        }
        return out;
      }
      case "escalate_to_user": {
        this.log("Lead → user (escalation)", String(a.question ?? ""));
        const ans = await this.hooks.askUser(String(a.question ?? ""));
        if (ans === null) return "USER UNAVAILABLE: do not make the change that needed approval. Finish and report what is waiting for the user.";
        this.log("user → Lead", ans);
        return `USER ANSWER: ${ans}`;
      }
      case "finish":
        t.done = String(a.report ?? "");
        return "ok";
    }
    return `ERROR: unknown tool ${name}`;
  }

  private async runClaude(session: string, prompt: string, mode: Mode): Promise<ClaudeResult> {
    const s = (this.sessions[session] ??= { purpose: "(auto-created)", created: new Date().toISOString() });
    const run = startClaude({
      bin: this.claudeBin,
      repo: this.repo,
      args: buildArgs(this.cfg, mode, s.id),
      prompt: withMode(mode, prompt, this.cfg.claude.implementAllow),
      onEvent: (event) => this.emit({ type: "claude-event", session, event }),
    });
    this.active = run;
    const res = await run.done;
    this.active = undefined;
    if (res.isError && s.id && /No conversation found/i.test(res.text)) {
      delete s.id; // session vanished → start fresh
      writeJson(this.P.sessions, this.sessions);
      return this.runClaude(session, `(Previous session context was lost; start fresh.)\n\n${prompt}`, mode);
    }
    if (res.sessionId) {
      s.id = res.sessionId;
      writeJson(this.P.sessions, this.sessions);
    }
    return res;
  }
}
