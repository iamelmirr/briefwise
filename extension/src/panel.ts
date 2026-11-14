// The Kimi Lead editor panel: owns one Lead for one repo and bridges it to the webview.

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { Lead, type LeadEvent } from "../../src/lead.ts";
import { leadName } from "../../src/names.ts";
import type { FromWebview, InitData, ModelInfo, NoteName, ToWebview, UIEvent } from "./protocol.ts";
import { baseUri } from "./base-content.ts";

export const KEY_SECRET = "kimiLead.openrouterKey";
const MAX_TRANSCRIPT = 4000;
const MODELS_TTL = 10 * 60_000;
let modelsCache: { at: number; models: ModelInfo[] } | undefined;

/** Tool-capable chat models from OpenRouter's public catalogue, newest first. */
async function fetchModels(): Promise<ModelInfo[]> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL) return modelsCache.models;
  const base = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const data: any[] = (await res.json())?.data ?? [];
  const models = data
    .filter((m) => (m.supported_parameters ?? []).includes("tools") && !/:batch$/.test(m.id))
    .map((m): ModelInfo => ({
      id: m.id,
      name: String(m.name ?? m.id).replace(/^[^:]+:s*/, ""),
      prompt: Number(m.pricing?.prompt ?? 0) * 1e6,
      completion: Number(m.pricing?.completion ?? 0) * 1e6,
      context: Number(m.context_length ?? 0),
      reasoning: (m.supported_parameters ?? []).includes("reasoning"),
      created: Number(m.created ?? 0),
    }))
    .sort((a, b) => b.created - a.created);
  modelsCache = { at: Date.now(), models };
  return models;
}

export class KimiPanel {
  static current: KimiPanel | undefined;
  static readonly busyChanged = new vscode.EventEmitter<boolean>();

  readonly repo: string;
  private readonly ctx: vscode.ExtensionContext;
  private readonly panel: vscode.WebviewPanel;
  private readonly lead: Lead;
  private apiKey: string | undefined;
  private transcript: UIEvent[];
  private asks = new Map<string, (answer: string | null) => void>();
  private saveTimer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  static async show(ctx: vscode.ExtensionContext, repo: string): Promise<KimiPanel> {
    if (KimiPanel.current?.repo === repo) {
      KimiPanel.current.panel.reveal();
      return KimiPanel.current;
    }
    KimiPanel.current?.panel.dispose();
    const key = await ctx.secrets.get(KEY_SECRET);
    KimiPanel.current = new KimiPanel(ctx, repo, key);
    return KimiPanel.current;
  }

  private constructor(ctx: vscode.ExtensionContext, repo: string, key: string | undefined) {
    this.ctx = ctx;
    this.repo = repo;
    this.apiKey = key;
    this.lead = new Lead(
      repo,
      { emit: (e) => this.onLead(e), askUser: (q) => this.ask(q) },
      { templatesDir: path.join(ctx.extensionPath, "templates"), apiKey: () => this.apiKey },
    );
    this.transcript = this.loadTranscript();

    this.panel = vscode.window.createWebviewPanel("kimiLead", `Kimi Lead: ${path.basename(repo)}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "dist"), vscode.Uri.joinPath(ctx.extensionUri, "media")],
    });
    this.panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "media", "icon.svg");
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    ctx.secrets.onDidChange(async (e) => {
      if (e.key !== KEY_SECRET) return;
      this.apiKey = await ctx.secrets.get(KEY_SECRET);
      this.postState();
    }, null, this.disposables);
  }

  get busy(): boolean { return this.lead.busy; }
  stop(): void { if (this.lead.busy) this.lead.stop(); }

  newConversation(): void {
    if (this.lead.busy) { void vscode.window.showWarningMessage(`${leadName(this.lead.cfg.model)} is working. Stop the task before starting a new conversation.`); return; }
    this.lead.newConversation();
    this.transcript = [];
    this.saveTranscript();
    this.post({ type: "reset" });
  }

  // ───────────── lead → webview ─────────────

  private onLead(e: LeadEvent) {
    this.push({ ...e, ts: Date.now() } as UIEvent);
  }

  private push(ev: UIEvent) {
    this.record(ev);
    this.post({ type: "event", event: ev });
  }

  /** Keep a compact transcript so the panel looks the same after a reload. */
  private record(ev: UIEvent) {
    if (ev.type === "kimi-reasoning") return;
    const last = this.transcript[this.transcript.length - 1];
    if (ev.type === "kimi-text" && last?.type === "kimi-text") {
      this.transcript[this.transcript.length - 1] = { ...last, delta: last.delta + ev.delta };
    } else if (ev.type === "claude-event" && ev.event.kind === "tool_result") {
      this.transcript.push({ ...ev, event: { ...ev.event, text: ev.event.text.slice(0, 600) } });
    } else {
      this.transcript.push(ev);
    }
    if (this.transcript.length > MAX_TRANSCRIPT) this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveTranscript(), 1500);
  }

  private get transcriptPath() { return path.join(this.lead.P.dir, "transcript.json"); }

  private loadTranscript(): UIEvent[] {
    try {
      const t = JSON.parse(fs.readFileSync(this.transcriptPath, "utf8"));
      return Array.isArray(t) ? t : [];
    } catch { return []; }
  }

  private saveTranscript() {
    clearTimeout(this.saveTimer);
    try { fs.writeFileSync(this.transcriptPath, JSON.stringify(this.transcript)); } catch { /* .kimi missing */ }
  }

  private post(m: ToWebview) { void this.panel.webview.postMessage(m); }

  private postState() {
    this.post({ type: "state", busy: this.lead.busy, hasKey: !!this.apiKey, branch: this.lead.branch() });
  }

  private initData(): InitData {
    return {
      repo: this.repo,
      repoName: path.basename(this.repo),
      branch: this.lead.branch(),
      model: this.lead.cfg.model,
      claudeModel: this.lead.cfg.claude.model,
      contextLimit: this.lead.cfg.context.hardTokens,
      hasKey: !!this.apiKey,
      claudeBin: this.lead.claudeBin,
      claudeFound: fs.existsSync(this.lead.claudeBin),
      busy: this.lead.busy,
      transcript: this.transcript,
    };
  }

  // ───────────── user questions ─────────────

  private ask(question: string): Promise<string | null> {
    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.push({ type: "ask", id, question, ts: Date.now() });
    if (!this.panel.visible) void vscode.window.showInformationMessage(`${leadName(this.lead.cfg.model)} has a question for you.`, "Open").then((a) => a && this.panel.reveal());
    return new Promise((resolve) => this.asks.set(id, resolve));
  }

  private answer(id: string, text: string | null) {
    const resolve = this.asks.get(id);
    if (!resolve) return;
    this.asks.delete(id);
    this.push({ type: "answer", id, text, ts: Date.now() });
    resolve(text);
  }

  // ───────────── webview → extension ─────────────

  private async onMessage(m: FromWebview) {
    switch (m.type) {
      case "ready": this.post({ type: "init", data: this.initData() }); break;
      case "send": await this.send(m.text); break;
      case "interject":
        if (!this.lead.interject(m.text)) this.post({ type: "toast", text: "Claude is not running right now" });
        break;
      case "stop": this.stop(); break;
      case "answer": this.answer(m.id, m.text); break;
      case "saveKey":
        await this.ctx.secrets.store(KEY_SECRET, m.key.trim());
        this.apiKey = m.key.trim();
        this.postState();
        break;
      case "newConversation": this.newConversation(); break;
      case "openFile": await this.openFile(m.path, m.line); break;
      case "openDiff": await this.openDiff(m.path); break;
      case "openNote": await this.openNote(m.name); break;
      case "resume": this.resume(m.session); break;
      case "listModels":
        try { this.post({ type: "models", models: await fetchModels() }); }
        catch (e: any) { this.post({ type: "models", models: [], error: `Couldn't load the model list: ${e?.message ?? e}` }); }
        break;
      case "setModel":
      case "setClaudeModel":
        if (this.lead.busy) { this.post({ type: "toast", text: "You can change the model when the task finishes" }); break; }
        try {
          if (m.type === "setModel") this.lead.setModel(m.id);
          else this.lead.setClaudeModel(m.model);
        } catch (e: any) { void vscode.window.showErrorMessage(String(e?.message ?? e)); }
        this.post({ type: "config", model: this.lead.cfg.model, claudeModel: this.lead.cfg.claude.model });
        break;
      case "openExternal":
        if (/^https?:\/\//.test(m.url)) void vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
    }
  }

  private async send(text: string) {
    if (this.lead.busy || !text.trim()) return;
    if (!this.apiKey) { this.post({ type: "toast", text: "Save your OpenRouter key first" }); return; }
    this.push({ type: "user", text, ts: Date.now() });
    try {
      const running = this.lead.run(text); // sets lead.busy synchronously, before its first await
      KimiPanel.busyChanged.fire(true);
      this.postState();
      await running;
    } catch (e: any) {
      this.push({ type: "error", text: String(e?.message ?? e), ts: Date.now() });
    } finally {
      for (const id of [...this.asks.keys()]) this.answer(id, null);
      KimiPanel.busyChanged.fire(false);
      this.postState();
      this.saveTranscript();
    }
  }

  /** Resolve a path from the webview to a file inside the repo (or null). */
  private inRepo(p: string): string | null {
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(this.repo, p);
    const rel = path.relative(this.repo, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return abs;
  }

  private async openFile(p: string, line?: number) {
    const abs = this.inRepo(p);
    if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return;
    const pos = line && line > 0 ? new vscode.Position(line - 1, 0) : undefined;
    await vscode.window.showTextDocument(vscode.Uri.file(abs), {
      viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: false,
      selection: pos ? new vscode.Range(pos, pos) : undefined,
    });
  }

  private async openDiff(p: string) {
    const abs = this.inRepo(p);
    if (!abs) return;
    const rel = path.relative(this.repo, abs).split(path.sep).join("/");
    const left = baseUri(this.repo, rel);
    const right = fs.existsSync(abs) ? vscode.Uri.file(abs) : baseUri(this.repo, rel, true);
    await vscode.commands.executeCommand("vscode.diff", left, right, `${rel} (last commit ↔ now)`, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  }

  private async openNote(name: NoteName) {
    const P = this.lead.P;
    const file = { RULES: P.rules, PRIVATE: P.private, PROJECT: P.project, TASKS: P.tasks, DECISIONS: P.decisions, config: P.config, log: P.log }[name];
    if (!fs.existsSync(file)) fs.writeFileSync(file, "");
    await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside, preview: false });
  }

  private resume(session: string) {
    const id = this.lead.sessionId(session);
    if (!id) { void vscode.window.showInformationMessage(`Session "${session}" has no Claude ID yet.`); return; }
    if (this.lead.busy && this.lead.claudeActive) {
      void vscode.window.showWarningMessage("Claude is working in the background. Wait for it to finish before resuming the session by hand.");
      return;
    }
    const term = vscode.window.createTerminal({ name: `Claude: ${session}`, cwd: this.repo, shellPath: this.lead.claudeBin, shellArgs: ["--resume", id] });
    term.show();
  }

  // ───────────── html ─────────────

  private html(): string {
    const w = this.panel.webview;
    const nonce = Array.from({ length: 32 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]).join("");
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "webview.css"));
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "webview.js"));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; img-src ${w.cspSource} data:; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}">
<title>Kimi Lead</title>
</head>
<body>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose() {
    if (KimiPanel.current === this) KimiPanel.current = undefined;
    if (this.lead.busy) this.lead.stop();
    for (const id of [...this.asks.keys()]) this.answer(id, null);
    this.saveTranscript();
    KimiPanel.busyChanged.fire(false);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
