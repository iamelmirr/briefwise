// Briefwise webview: left = conversation with the lead model, right = Claude Code sessions, live.

import type { FromWebview, InitData, ModelInfo, NoteName, ToWebview, UIEvent } from "../src/protocol.ts";
import { leadName } from "../../src/names.ts";
import { icon } from "./icons.ts";
import { renderMarkdown, type MdOptions } from "./markdown.ts";
import { diffStats, lineDiff } from "./diff.ts";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();
const post = (m: FromWebview) => vscode.postMessage(m);
const saved: { split?: number; view?: "lead" | "claude"; draft?: string } = vscode.getState() ?? {};
// state saved before the Briefwise rename called the lead pane "kimi"
if ((saved.view as string) === "kimi") saved.view = "lead";
const persist = () => vscode.setState(saved);

// ───────────── tiny DOM helper ─────────────

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c != null && c !== false) e.append(c);
  return e;
}

const md: MdOptions = {
  onPath: (p) => { const [file, line] = p.split(":"); post({ type: "openFile", path: file, line: line ? Number(line) : undefined }); },
  onLink: (url) => post({ type: "openExternal", url }),
};

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(s % 60).padStart(2, "0")} s`;
}
const usd = (n: number) => (n >= 0.995 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const ktok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// ───────────── state ─────────────

let info: InitData | null = null;
/** Display name of the lead model ("Qwen", "GLM", "DeepSeek"…); follows the chosen model. */
let LN = "Lead";
let busy = false;
let replaying = false;
let lastUserTs = 0;
let waitingAnswer = false;
const totals = { lead: 0, claude: 0 };

type ToolView = { row: HTMLElement; detail: HTMLElement; status: HTMLElement; name: string };
type RunView = {
  id: string; session: string; mode: "ask" | "implement"; start: number;
  el: HTMLElement; stream: HTMLElement; foot: HTMLElement; timer: HTMLElement;
  tools: Map<string, ToolView>; handoff: HTMLElement; done: boolean;
};
type SessionView = { name: string; tab: HTMLButtonElement; feed: HTMLElement; runs: RunView[] };
const sessions = new Map<string, SessionView>();
let activeSession: string | null = null;
let liveRun: RunView | null = null;

let leadMsg: { body: HTMLElement; text: string; queued: boolean } | null = null;
let thinking: { el: HTMLElement; ticker: HTMLElement; text: string } | null = null;

// ───────────── shell ─────────────

const statusDot = h("span", { class: "status-dot" });
const statusText = h("span", { class: "status-text" }, "Ready");
const status = h("div", { class: "status", role: "status", "aria-live": "polite" }, statusDot, statusText);
const repoName = h("span", { class: "repo-name" });
const branchName = h("span", { class: "branch-name" });
const stopBtn = h("button", { class: "btn btn-stop", title: "Stop the lead model and Claude (Esc)", onclick: () => post({ type: "stop" }) }, icon("stop"), "Stop");

function noteBtn(name: NoteName, label: string, ic: string, title: string) {
  return h("button", { class: "btn btn-ghost", title, onclick: () => post({ type: "openNote", name }) }, icon(ic), h("span", { class: "btn-label" }, label));
}
const moreMenu = h("div", { class: "menu", role: "menu", hidden: true },
  ...([["PROJECT", "Project notes"], ["TASKS", "Tasks"], ["DECISIONS", "Decisions"], ["config", "Settings (config.json)"], ["log", "Full log"]] as [NoteName, string][])
    .map(([name, label]) => h("button", { class: "menu-item", role: "menuitem", onclick: () => { moreMenu.hidden = true; post({ type: "openNote", name }); } }, label)),
);
const moreBtn = h("button", { class: "btn btn-ghost btn-icon", title: "More", "aria-haspopup": "menu", onclick: (e: Event) => { e.stopPropagation(); moreMenu.hidden = !moreMenu.hidden; } }, icon("more"));
document.addEventListener("click", () => { moreMenu.hidden = true; claudeMenu.hidden = true; closePicker(); });

const header = h("header", { class: "top" },
  h("div", { class: "where" }, repoName, h("span", { class: "branch" }, icon("branch"), branchName)),
  status,
  h("div", { class: "actions" },
    stopBtn,
    h("button", { class: "btn btn-ghost", title: "Start a new conversation (notes and sessions are kept)", onclick: () => { if (!busy) post({ type: "newConversation" }); } }, icon("plus"), h("span", { class: "btn-label" }, "New chat")),
    noteBtn("RULES", "Rules", "rules", "Your rules: how the lead works and what Claude may know"),
    noteBtn("PRIVATE", "Private notes", "lock", "Only the lead model knows this; Claude never sees it"),
    h("div", { class: "menu-wrap" }, moreBtn, moreMenu),
  ),
);

// view switch for narrow widths
const segLeadLabel = h("span", null, LN);
const segLead = h("button", { class: "seg-btn", onclick: () => setView("lead") }, segLeadLabel);
const segClaudeDot = h("span", { class: "live-dot", hidden: true });
const segClaude = h("button", { class: "seg-btn", onclick: () => setView("claude") }, "Claude", segClaudeDot);
const seg = h("div", { class: "seg", role: "tablist" }, segLead, segClaude);

// lead pane
const leadFeed = h("div", { class: "feed lead-feed", role: "log", "aria-label": "Conversation" });
const input = h("textarea", { class: "input", rows: 1, placeholder: "Tell the lead what to do…", "aria-label": "Message" }) as HTMLTextAreaElement;
const sendBtn = h("button", { class: "send", title: "Send (Enter)", "aria-label": "Send", onclick: () => submit() }, icon("send"));
const ctxBar = h("span", { class: "meter-fill" });
const ctxText = h("span", { class: "meta-item" });
const costText = h("span", { class: "meta-item" });
const modelLabel = h("span", { class: "model-name" });
const modelBtn = h("button", { class: "model-btn", title: "Choose the lead model", "aria-haspopup": "listbox", "aria-expanded": "false", onclick: (e: Event) => { e.stopPropagation(); togglePicker(); } },
  h("span", { class: "model-dot" }), modelLabel, icon("caret", "model-caret"));
const pickSearch = h("input", { class: "pick-search", placeholder: "Search models: qwen, glm, deepseek, gemini…", "aria-label": "Search models", spellcheck: "false", autocomplete: "off" }) as HTMLInputElement;
const pickList = h("div", { class: "pick-list", role: "listbox", "aria-label": "Lead models" });
const picker = h("div", { class: "picker", hidden: true, onclick: (e: Event) => e.stopPropagation() },
  h("div", { class: "pick-top" }, icon("search", "pick-ico"), pickSearch),
  pickList,
  h("div", { class: "pick-note" }, "The lead model talks with you and writes the briefs. Code is always written by the real Claude Code, on your subscription."));
const composer = h("div", { class: "composer-wrap" },
  picker,
  h("div", { class: "composer" }, input, sendBtn),
  h("div", { class: "meta" }, modelBtn, h("span", { class: "meter", title: "How full the lead model's context is" }, h("span", { class: "meter-track" }, ctxBar), ctxText), costText),
);
const leadPane = h("section", { class: "pane pane-lead", "aria-label": "Lead" }, leadFeed, composer);

// Claude pane
const tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Claude sessions" });
const resumeBtn = h("button", { class: "btn btn-ghost", title: "Open this session in a terminal (claude --resume) and continue by hand", onclick: () => activeSession && post({ type: "resume", session: activeSession }) }, icon("resume"), h("span", { class: "btn-label" }, "Resume in terminal"));
const CLAUDE_MODELS: [string | null, string, string][] = [
  [null, "Your default", "the model from your Claude Code settings"],
  ["opus", "Opus", "strongest, for serious work"],
  ["sonnet", "Sonnet", "faster and cheaper"],
  ["haiku", "Haiku", "fastest, for small things"],
];
const claudeModelLabel = h("span", { class: "cm-name" });
const claudeMenu = h("div", { class: "menu menu-claude", role: "menu", hidden: true });
const claudeModelBtn = h("button", { class: "cm-btn", title: "The model Claude Code uses (your subscription)", "aria-haspopup": "menu", onclick: (e: Event) => { e.stopPropagation(); renderClaudeMenu(); claudeMenu.hidden = !claudeMenu.hidden; closePicker(); moreMenu.hidden = true; } },
  h("span", { class: "cm-dot" }), claudeModelLabel, icon("caret", "model-caret"));
function renderClaudeMenu() {
  const cur = info?.claudeModel ?? null;
  claudeMenu.replaceChildren(...CLAUDE_MODELS.map(([id, label, hint]) =>
    h("button", { class: `menu-item cm-item${id === cur ? " on" : ""}`, role: "menuitemradio", "aria-checked": String(id === cur), onclick: () => { claudeMenu.hidden = true; if (id !== cur) post({ type: "setClaudeModel", model: id }); } },
      h("span", { class: "cm-item-top" }, h("span", null, label), id === cur ? icon("check", "cm-check") : null),
      h("span", { class: "cm-hint" }, hint))));
}
const claudeBody = h("div", { class: "claude-body" });
const claudeEmpty = h("div", { class: "empty empty-claude" },
  h("div", { class: "empty-mark" }, h("span", { class: "mark-k" }), h("span", { class: "mark-c" })),
  h("p", { class: "empty-lead" }, "Watch Claude Code work here, live."),
  h("p", { class: "empty-sub" }, "The real Claude Code, on your subscription. When it gets a task, you see the exact brief, every file it reads, every command and every edit."),
);
claudeBody.append(claudeEmpty);
const interjectInput = h("textarea", { class: "input", rows: 1, placeholder: "Message Claude directly (the lead sees it with the report)", "aria-label": "Message straight to Claude" }) as HTMLTextAreaElement;
const interjectBtn = h("button", { class: "send send-claude", title: "Send to Claude (Enter)", "aria-label": "Send to Claude", onclick: () => submitInterject() }, icon("send"));
const interject = h("div", { class: "interject", hidden: true }, h("div", { class: "composer composer-claude" }, interjectInput, interjectBtn));
const claudePane = h("section", { class: "pane pane-claude", "aria-label": "Claude Code" },
  h("div", { class: "tabbar" }, tabs, h("div", { class: "menu-wrap" }, claudeModelBtn, claudeMenu), resumeBtn), claudeBody, interject);

const splitter = h("div", { class: "splitter", role: "separator", "aria-orientation": "vertical", tabindex: 0, title: "Drag to resize" });
const split = h("main", { class: "split" }, leadPane, splitter, claudePane);
const toast = h("div", { class: "toast", role: "status", hidden: true });
const app = h("div", { class: "app" }, header, seg, split, toast);
document.body.append(app);

function setView(v: "lead" | "claude") {
  saved.view = v; persist();
  app.dataset.view = v;
  segLead.classList.toggle("on", v === "lead");
  segClaude.classList.toggle("on", v === "claude");
}
setView(saved.view ?? "lead");

// splitter
function applySplit(p: number) {
  const v = Math.min(70, Math.max(28, p));
  split.style.setProperty("--left", `${v}%`);
  saved.split = v; persist();
}
applySplit(saved.split ?? 42);
splitter.addEventListener("pointerdown", (e) => {
  splitter.setPointerCapture(e.pointerId);
  split.classList.add("dragging");
  const move = (ev: PointerEvent) => { const r = split.getBoundingClientRect(); applySplit(((ev.clientX - r.left) / r.width) * 100); };
  const up = () => { split.classList.remove("dragging"); splitter.removeEventListener("pointermove", move); splitter.removeEventListener("pointerup", up); };
  splitter.addEventListener("pointermove", move);
  splitter.addEventListener("pointerup", up);
});
splitter.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") applySplit((saved.split ?? 42) - 3);
  if (e.key === "ArrowRight") applySplit((saved.split ?? 42) + 3);
});

// ───────────── scrolling ─────────────

function nearBottom(el: HTMLElement) { return el.scrollHeight - el.scrollTop - el.clientHeight < 120; }
function stick(el: HTMLElement, fn: () => void) {
  const was = replaying || nearBottom(el);
  fn();
  if (was) el.scrollTop = el.scrollHeight;
}

// ───────────── composer ─────────────

function autosize(t: HTMLTextAreaElement) { t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 220)}px`; }
input.value = saved.draft ?? "";
input.addEventListener("input", () => { autosize(input); saved.draft = input.value; persist(); });
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
});
interjectInput.addEventListener("input", () => autosize(interjectInput));
interjectInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitInterject(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && busy) post({ type: "stop" });
});

function submit() {
  const text = input.value.trim();
  if (!text || busy || !info?.hasKey) return;
  post({ type: "send", text });
  input.value = ""; saved.draft = ""; persist(); autosize(input);
}
function submitInterject() {
  const text = interjectInput.value.trim();
  if (!text || !liveRun) return;
  post({ type: "interject", text });
  interjectInput.value = ""; autosize(interjectInput);
  showToast("Sent to Claude");
}

let toastTimer = 0;
function showToast(text: string) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 2200);
}

// ───────────── status & meta ─────────────

function setStatus(kind: "idle" | "lead" | "claude" | "ask", text: string) {
  status.dataset.kind = kind;
  statusText.textContent = text;
}

function refreshChrome() {
  app.classList.toggle("busy", busy);
  stopBtn.hidden = !busy;
  input.disabled = busy || !info?.hasKey;
  sendBtn.disabled = busy || !info?.hasKey;
  input.placeholder = !info?.hasKey ? "Save your OpenRouter key first" : busy ? `${LN} is working. Esc stops it.` : "What should we do? Write it in your own words…";
  modelBtn.disabled = busy;
  const claudeLive = !!liveRun && !liveRun.done;
  interject.hidden = !(claudeLive && liveRun!.session === activeSession);
  segClaudeDot.hidden = !claudeLive;
  resumeBtn.hidden = !activeSession;
  costText.textContent = totals.lead || totals.claude ? `${LN} ${usd(totals.lead)}  Claude ${usd(totals.claude)}` : "";
  if (!busy && !waitingAnswer) setStatus("idle", "Ready");
}

function setContext(prompt: number, cached: number) {
  if (!info || !prompt) return;
  const pct = Math.min(100, (prompt / info.contextLimit) * 100);
  ctxBar.style.width = `${pct}%`;
  ctxBar.parentElement!.parentElement!.dataset.level = pct > 80 ? "high" : pct > 55 ? "mid" : "low";
  ctxText.textContent = `${ktok(prompt)} / ${ktok(info.contextLimit)}`;
  ctxText.title = cached ? `From cache: ${Math.round((cached / prompt) * 100)}%` : "";
}

// ───────────── lead feed ─────────────

function leadEmpty(): HTMLElement {
  if (!info?.hasKey) {
    const keyInput = h("input", { class: "key-input", type: "password", placeholder: "sk-or-…", "aria-label": "OpenRouter API key", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const save = () => { const k = keyInput.value.trim(); if (k) post({ type: "saveKey", key: k }); };
    keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
    return h("div", { class: "empty empty-lead-pane onboarding" },
      h("div", { class: "empty-mark" }, h("span", { class: "mark-k" }), h("span", { class: "mark-c" })),
      h("p", { class: "empty-lead" }, "Connect OpenRouter"),
      h("p", { class: "empty-sub" }, `${LN} (the lead model) runs through OpenRouter. Paste an API key; it is kept in VS Code's secret storage, not in the project. Claude Code runs on your subscription and needs no key.`),
      h("div", { class: "key-row" }, keyInput, h("button", { class: "btn btn-primary", onclick: save }, icon("key"), "Save key")),
      h("a", { class: "subtle-link", href: "https://openrouter.ai/keys", onclick: (e: Event) => { e.preventDefault(); post({ type: "openExternal", url: "https://openrouter.ai/keys" }); } }, "Create a key at openrouter.ai/keys"),
    );
  }
  const ideas = [
    "Explain how this project is organized and where the main logic lives.",
    "Find out why … doesn't work and fix it.",
    "Add tests for … and run them.",
  ];
  return h("div", { class: "empty empty-lead-pane" },
    h("div", { class: "empty-mark" }, h("span", { class: "mark-k" }), h("span", { class: "mark-c" })),
    h("p", { class: "empty-lead" }, `What are we working on in ${info.repoName}?`),
    h("p", { class: "empty-sub" }, `Write in your own words. ${LN} turns it into a precise task for Claude Code, and you see everything it hands over on the right.`),
    h("div", { class: "ideas" }, ...ideas.map((t) => h("button", { class: "idea", onclick: () => { input.value = t; autosize(input); input.focus(); const i = t.indexOf("…"); if (i >= 0) input.setSelectionRange(i, i + 1); } }, t))),
  );
}

function resetLeadFeed() {
  leadFeed.replaceChildren(leadEmpty());
  leadMsg = null; thinking = null;
}

function feedAppend(node: HTMLElement) {
  leadFeed.querySelector(".empty")?.remove();
  stick(leadFeed, () => leadFeed.append(node));
}

function addUser(text: string, ts: number) {
  lastUserTs = ts;
  feedAppend(h("div", { class: "msg msg-user" }, h("div", { class: "bubble" }, text)));
}

function startThinking() {
  if (thinking || replaying) return;
  const ticker = h("span", { class: "ticker" });
  const el = h("div", { class: "thinking" }, h("span", { class: "thinking-label" }, `${LN} is thinking`), ticker);
  thinking = { el, ticker, text: "" };
  feedAppend(el);
}
function stopThinking() { thinking?.el.remove(); thinking = null; }

let mdQueued = false;
function renderLeadMsg() {
  mdQueued = false;
  if (!leadMsg) return;
  const m = leadMsg;
  stick(leadFeed, () => m.body.replaceChildren(renderMarkdown(m.text, md)));
}
function leadText(delta: string) {
  stopThinking();
  if (!leadMsg) {
    const body = h("div", { class: "md" });
    leadMsg = { body, text: "", queued: false };
    feedAppend(h("div", { class: "msg msg-lead" }, h("div", { class: "who who-lead" }, LN), body));
  }
  leadMsg.text += delta;
  if (replaying) renderLeadMsg();
  else if (!mdQueued) { mdQueued = true; requestAnimationFrame(renderLeadMsg); }
}

function leadTool(label: string, name: string) {
  const last = leadFeed.lastElementChild;
  const chip = h("span", { class: "chip" }, icon(name === "grep" ? "search" : name === "update_notes" ? "notes" : name === "new_session" ? "plus" : name === "git" ? "branch" : "file"), label);
  if (last?.classList.contains("activity")) stick(leadFeed, () => last.querySelector(".chips")!.append(chip));
  else feedAppend(h("div", { class: "activity" }, h("div", { class: "chips" }, chip)));
}

function alertCard(kind: "warn" | "danger" | "info", title: string, body: HTMLElement | string) {
  feedAppend(h("div", { class: `alert alert-${kind}` }, icon(kind === "info" ? "info" : kind === "warn" ? "warn" : "shield"),
    h("div", { class: "alert-body" }, h("div", { class: "alert-title" }, title), typeof body === "string" ? (body ? h("div", null, body) : null) : body)));
}

const asks = new Map<string, HTMLElement>();
function askCard(id: string, question: string) {
  waitingAnswer = true;
  setStatus("ask", "Waiting for your answer");
  const free = h("input", { class: "ask-input", placeholder: "Or type your own answer and press Enter", "aria-label": "Your answer" }) as HTMLInputElement;
  const send = (text: string) => { if (text.trim()) post({ type: "answer", id, text: text.trim() }); };
  free.addEventListener("keydown", (e) => { if (e.key === "Enter") send(free.value); });
  const actions = h("div", { class: "ask-actions" },
    h("button", { class: "btn btn-primary", onclick: () => send("Yes, approved.") }, icon("check"), "Approve"),
    h("button", { class: "btn", onclick: () => send("No, don't do that.") }, icon("x"), "Decline"),
    free);
  const card = h("div", { class: "ask" }, h("div", { class: "ask-head" }, icon("info"), `${LN} asks`), h("div", { class: "md" }, renderMarkdown(question, md)), actions);
  asks.set(id, card);
  feedAppend(card);
  if (!replaying) free.focus();
}
function askAnswered(id: string, text: string | null) {
  waitingAnswer = false;
  const card = asks.get(id);
  if (!card) return;
  card.classList.add("answered");
  card.querySelector(".ask-actions")?.replaceWith(h("div", { class: "ask-answer" }, text === null ? "No answer" : `Your answer: ${text}`));
}

// ───────────── Claude pane ─────────────

function ensureSession(name: string): SessionView {
  let s = sessions.get(name);
  if (s) return s;
  claudeEmpty.remove();
  const tab = h("button", { class: "tab", role: "tab", onclick: () => selectSession(name) }, h("span", { class: "live-dot", hidden: true }), h("span", { class: "tab-name" }, name)) as HTMLButtonElement;
  const feed = h("div", { class: "feed claude-feed", role: "log", "aria-label": `Claude session ${name}`, hidden: true });
  s = { name, tab, feed, runs: [] };
  sessions.set(name, s);
  tabs.append(tab);
  claudeBody.append(feed);
  if (!activeSession) selectSession(name);
  return s;
}

function selectSession(name: string) {
  activeSession = name;
  for (const s of sessions.values()) {
    const on = s.name === name;
    s.tab.classList.toggle("on", on);
    s.tab.setAttribute("aria-selected", String(on));
    s.feed.hidden = !on;
  }
  refreshChrome();
}

function relPath(p: unknown): string {
  if (typeof p !== "string") return "";
  const norm = (x: string) => x.replace(/\\/g, "/");
  const r = norm(info?.repo ?? "");
  const n = norm(p);
  if (r && n.toLowerCase().startsWith(r.toLowerCase() + "/")) return n.slice(r.length + 1);
  if (r && n.toLowerCase() === r.toLowerCase()) return ".";
  return n;
}

const TOOL_ICON: Record<string, string> = {
  Read: "file", Edit: "edit", MultiEdit: "edit", Write: "write", NotebookEdit: "edit",
  Bash: "terminal", PowerShell: "terminal", Grep: "search", Glob: "search",
  TodoWrite: "list", Task: "agent", Agent: "agent", WebFetch: "globe", WebSearch: "globe",
};
const TOOL_VERB: Record<string, string> = {
  Read: "Reads", Edit: "Edits", MultiEdit: "Edits", Write: "Writes", NotebookEdit: "Edits", Bash: "Runs", PowerShell: "Runs",
  Grep: "Searches", Glob: "Finds files", TodoWrite: "Plan", Task: "Subagent", Agent: "Subagent", WebFetch: "Fetches", WebSearch: "Searches the web",
};

function diffBlock(before: string, after: string, max = 80): { el: HTMLElement; add: number; del: number } {
  const lines = lineDiff(before, after);
  const { add, del } = diffStats(lines);
  // keep changes with 2 lines of context
  const keep = new Set<number>();
  lines.forEach((l, i) => { if (l.t !== " ") for (let k = i - 2; k <= i + 2; k++) keep.add(k); });
  const pre = h("div", { class: "diff" });
  let shown = 0, gap = false;
  lines.forEach((l, i) => {
    if (!keep.has(i)) { gap = true; return; }
    if (gap && shown) pre.append(h("div", { class: "dl dl-gap" }, "⋯"));
    gap = false;
    if (shown++ >= max) return;
    pre.append(h("div", { class: `dl ${l.t === "+" ? "dl-add" : l.t === "-" ? "dl-del" : ""}` }, h("span", { class: "dl-sign" }, l.t === " " ? "" : l.t), h("span", { class: "dl-text" }, l.s || " ")));
  });
  if (shown > max) pre.append(h("div", { class: "dl dl-gap" }, `${shown - max} more lines in the full diff`));
  return { el: pre, add, del };
}

function toolRow(run: RunView, id: string, name: string, input: any) {
  const status = h("span", { class: "tstatus running" });
  let label: Child = "";
  let stats: Child = null;
  let detail: HTMLElement = h("div", { class: "tdetail", hidden: true });
  let open = false;
  const file = relPath(input?.file_path ?? input?.notebook_path);
  const fileLink = (f: string, line?: number) => h("button", { class: "tpath", title: "Open file", onclick: (e: Event) => { e.stopPropagation(); post({ type: "openFile", path: f, line }); } }, f);
  switch (name) {
    case "Read": label = fileLink(file, input.offset); if (input.offset) stats = h("span", { class: "tmeta" }, `from line ${input.offset}`); break;
    case "Edit": case "Write": case "MultiEdit": {
      label = fileLink(file);
      const edits: { old_string?: string; new_string?: string }[] =
        name === "Write" ? [{ old_string: "", new_string: input.content ?? "" }] : name === "MultiEdit" ? input.edits ?? [] : [input];
      let add = 0, del = 0;
      for (const ed of edits) {
        const d = diffBlock(ed.old_string ?? "", ed.new_string ?? "", name === "Write" ? 40 : 80);
        if (name === "Write") d.el.classList.add("diff-new"); // whole file is new: no green wash on every line
        add += d.add; del += d.del;
        detail.append(d.el);
      }
      detail.append(h("button", { class: "btn btn-ghost btn-small", onclick: () => post({ type: "openDiff", path: file }) }, icon("diff"), "Open diff"));
      stats = h("span", { class: "tstats" }, h("span", { class: "add" }, `+${add}`), h("span", { class: "del" }, `−${del}`));
      // show small edits inline right away; big ones and whole new files stay one click away
      open = name === "Write" ? add <= 8 : add + del <= 24;
      break;
    }
    case "Bash": case "PowerShell": label = h("code", { class: "tcmd" }, String(input.command ?? "").split("\n")[0]); break;
    case "Grep": label = h("code", { class: "tcmd" }, String(input.pattern ?? "")); if (input.path && relPath(input.path) !== ".") stats = h("span", { class: "tmeta" }, `in ${relPath(input.path)}`); break;
    case "Glob": label = h("code", { class: "tcmd" }, String(input.pattern ?? "")); break;
    case "TodoWrite": {
      const todos: { content?: string; status?: string }[] = input.todos ?? [];
      label = `${todos.length} steps`;
      detail.append(h("ul", { class: "todos" }, ...todos.map((t) => h("li", { class: `todo todo-${t.status ?? "pending"}` }, t.content ?? ""))));
      open = true;
      break;
    }
    case "Task": case "Agent": label = String(input.description ?? ""); break;
    case "WebFetch": label = String(input.url ?? ""); break;
    case "WebSearch": label = String(input.query ?? ""); break;
    default: label = h("code", { class: "tcmd" }, JSON.stringify(input ?? {}).slice(0, 140));
  }
  const chevron = icon("chevron", "tchev");
  const head = h("div", { class: "thead", tabindex: 0, role: "button", "aria-expanded": String(open) },
    status, icon(TOOL_ICON[name] ?? "dot", "tico"), h("span", { class: "tverb" }, TOOL_VERB[name] ?? name), h("span", { class: "tlabel" }, label), stats, chevron);
  const row = h("div", { class: `tool tool-${name.toLowerCase()}` }, head, detail);
  const toggle = () => {
    if (!detail.childElementCount) return;
    detail.hidden = !detail.hidden;
    row.classList.toggle("open", !detail.hidden);
    head.setAttribute("aria-expanded", String(!detail.hidden));
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  if (open && detail.childElementCount) { detail.hidden = false; row.classList.add("open"); }
  row.classList.toggle("expandable", detail.childElementCount > 0);
  run.tools.set(id, { row, detail, status, name });
  stick(sessions.get(run.session)!.feed, () => run.stream.append(row));
}

function toolResult(run: RunView, id: string, isError: boolean, text: string) {
  const t = run.tools.get(id);
  if (!t) return;
  t.status.className = `tstatus ${isError ? "err" : "ok"}`;
  if (isError) {
    t.row.classList.add("failed", "expandable");
    t.detail.prepend(h("pre", { class: "tresult err" }, text.slice(0, 1200) || "Error"));
    if (/denied|permission/i.test(text)) t.row.querySelector(".tverb")!.append(h("span", { class: "tmeta" }, " blocked"));
  } else if (["Bash", "PowerShell", "Grep", "Glob"].includes(t.name) && text.trim()) {
    t.row.classList.add("expandable");
    t.detail.append(h("pre", { class: "tresult" }, text.slice(0, 1200)));
  }
}

function startRun(session: string, mode: "ask" | "implement", prompt: string, ts: number) {
  const s = ensureSession(session);
  const id = `run-${ts}-${Math.random().toString(36).slice(2, 7)}`;
  const timer = h("span", { class: "run-timer", dataset: { start: String(ts) } }, replaying ? "" : "0 s");
  const promptPre = h("pre", { class: "brief-text" }, prompt.trim());
  const more = h("button", { class: "brief-more", hidden: true, onclick: () => { brief.classList.toggle("expanded"); more.textContent = brief.classList.contains("expanded") ? "Collapse" : "Show full brief"; } }, "Show full brief");
  const brief = h("div", { class: "brief" }, h("div", { class: "brief-head" }, h("span", { class: "who who-lead" }, LN), h("span", { class: "brief-to" }, "hands off to Claude")), promptPre, more);
  const stream = h("div", { class: "stream" });
  const foot = h("div", { class: "run-foot" });
  const el = h("article", { class: `run run-${mode}`, id },
    h("div", { class: "run-head" },
      h("span", { class: `mode mode-${mode}` }, mode === "ask" ? "Consult, read-only" : "Implementation"),
      h("span", { class: "run-time" }, clock(ts)),
      timer),
    brief, stream, foot);
  // handoff card in the lead's feed: the bridge between the two panes
  const hstatus = h("span", { class: "handoff-status running" }, replaying ? "" : "running");
  const handoff = h("button", { class: `handoff handoff-${mode}`, onclick: () => focusRun(run) },
    h("span", { class: "handoff-rail" }),
    h("span", { class: "handoff-main" },
      h("span", { class: "handoff-top" }, icon("handoff"), h("span", { class: "handoff-title" }, mode === "ask" ? `Asks Claude for advice` : `Hands the implementation to Claude`), h("span", { class: "session-tag" }, session)),
      h("span", { class: "handoff-preview" }, prompt.trim().split("\n").slice(0, 3).join("\n"))),
    hstatus);
  const run: RunView = { id, session, mode, start: ts, el, stream, foot, timer, tools: new Map(), handoff, done: false };
  s.runs.push(run);
  liveRun = run;
  stick(s.feed, () => s.feed.append(el));
  requestAnimationFrame(() => { if (promptPre.scrollHeight > promptPre.clientHeight + 4) more.hidden = false; });
  feedAppend(handoff);
  s.tab.querySelector(".live-dot")!.removeAttribute("hidden");
  if (!replaying) {
    selectSession(session);
    handoff.classList.add("sent");
    setStatus("claude", `Claude is working in session ${session}`);
  }
  refreshChrome();
}

function focusRun(run: RunView) {
  selectSession(run.session);
  setView("claude");
  run.el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  run.el.classList.remove("flash");
  void run.el.offsetWidth;
  run.el.classList.add("flash");
}

function endRun(run: RunView, isError: boolean, stopped: boolean, cost: number, text: string, ts: number) {
  run.done = true;
  const took = fmtDuration(ts - run.start);
  run.timer.textContent = took;
  run.el.classList.add(stopped ? "stopped" : isError ? "errored" : "finished");
  const st = run.handoff.querySelector(".handoff-status")!;
  st.className = `handoff-status ${stopped ? "stopped" : isError ? "err" : "ok"}`;
  st.replaceChildren(icon(stopped ? "stop" : isError ? "x" : "check"), stopped ? "stopped" : isError ? "error" : took);
  run.foot.prepend(h("div", { class: "run-end" },
    h("span", { class: `end-state ${stopped ? "stopped" : isError ? "err" : "ok"}` }, icon(stopped ? "stop" : isError ? "x" : "check"), stopped ? "Stopped" : isError ? "Finished with an error" : "Done"),
    h("span", { class: "end-meta" }, took), cost ? h("span", { class: "end-meta" }, usd(cost)) : null));
  if (isError && !stopped && text) run.foot.append(h("pre", { class: "tresult err" }, text.slice(0, 800)));
  for (const t of run.tools.values()) if (t.status.classList.contains("running")) t.status.className = `tstatus ${stopped ? "stopped" : "ok"}`;
  const s = sessions.get(run.session)!;
  s.tab.querySelector(".live-dot")!.setAttribute("hidden", "");
  if (liveRun === run) liveRun = null;
  if (busy && !replaying) setStatus("lead", `${LN} is reviewing Claude's work`);
  refreshChrome();
}

function runFiles(run: RunView, files: { file: string; code: string }[]) {
  const key = (code: string) => (code.includes("D") ? "deleted" : code.includes("?") || code.includes("A") ? "new" : code.trim() ? "modified" : "reverted");
  run.foot.append(h("div", { class: "files" },
    h("div", { class: "files-title" }, `Changed files (${files.length})`),
    ...files.map((f) => h("div", { class: "file-row" },
      h("button", { class: "tpath", onclick: () => post({ type: "openFile", path: f.file }) }, f.file),
      h("span", { class: `fstate fstate-${key(f.code)}` }, key(f.code)),
      h("button", { class: "btn btn-ghost btn-small", onclick: () => post({ type: "openDiff", path: f.file }) }, icon("diff"), "Diff")))));
}

// ───────────── event handling ─────────────

function handle(e: UIEvent) {
  switch (e.type) {
    case "user":
      addUser(e.text, e.ts);
      leadMsg = null;
      if (!replaying) { busy = true; setStatus("lead", `${LN} is thinking`); refreshChrome(); }
      break;
    case "lead-start":
      leadMsg = null;
      if (!replaying) { startThinking(); if (!liveRun) setStatus("lead", `${LN} is thinking`); }
      break;
    case "lead-reasoning":
      if (thinking) {
        thinking.text = (thinking.text + e.delta).slice(-400);
        thinking.ticker.textContent = thinking.text.replace(/\s+/g, " ").trim().slice(-140);
      }
      break;
    case "lead-text":
      leadText(e.delta);
      break;
    case "lead-end":
      stopThinking();
      if (leadMsg) renderLeadMsg();
      leadMsg = null;
      setContext(e.promptTokens, e.cachedTokens);
      break;
    case "lead-tool":
      leadTool(e.label, e.name);
      if (!replaying) setStatus("lead", `${LN} is reading code`);
      break;
    case "claude-start":
      stopThinking();
      startRun(e.session, e.mode, e.prompt, e.ts);
      break;
    case "claude-event": {
      const s = ensureSession(e.session);
      const run = s.runs[s.runs.length - 1];
      if (!run) break;
      const ev = e.event;
      if (ev.kind === "text") {
        stick(s.feed, () => run.stream.append(h("div", { class: "ctext md" }, renderMarkdown(ev.text, md))));
      } else if (ev.kind === "tool") {
        toolRow(run, ev.id, ev.name, ev.input);
      } else if (ev.kind === "tool_result") {
        toolResult(run, ev.id, ev.isError, ev.text);
      } else if (ev.kind === "user") {
        stick(s.feed, () => run.stream.append(h("div", { class: "interjection" }, h("span", { class: "who who-you" }, "You"), h("span", null, ev.text))));
      } else if (ev.kind === "init" && ev.model) {
        run.el.querySelector(".run-head")!.append(h("span", { class: "run-model" }, ev.model));
      }
      break;
    }
    case "claude-files": {
      const run = sessions.get(e.session)?.runs.at(-1);
      if (run) runFiles(run, e.files);
      break;
    }
    case "claude-end": {
      const run = sessions.get(e.session)?.runs.at(-1);
      if (run) endRun(run, e.result.isError, !!e.result.stopped, e.result.costUsd, e.result.text, e.ts);
      break;
    }
    case "guard":
      alertCard("warn", "This needs your approval", h("ul", { class: "alert-list" }, ...e.issues.map((i) => h("li", null, i))));
      break;
    case "blocked":
      alertCard("danger", "Blocked before reaching Claude", e.reason);
      break;
    case "notice":
      feedAppend(h("div", { class: "notice" }, icon("info"), h("span", null, e.text)));
      break;
    case "ask":
      stopThinking();
      askCard(e.id, e.question);
      break;
    case "answer":
      askAnswered(e.id, e.text);
      break;
    case "error":
      stopThinking();
      alertCard("danger", "Something went wrong", e.text);
      break;
    case "task-end": {
      stopThinking();
      if (!e.streamed) {
        const body = h("div", { class: "md" }, renderMarkdown(e.report, md));
        feedAppend(h("div", { class: `msg msg-lead${e.report === "Stopped." ? " msg-stopped" : ""}` }, h("div", { class: "who who-lead" }, LN), body));
      }
      totals.lead += e.leadUsd; totals.claude += e.claudeUsd;
      const took = lastUserTs ? fmtDuration(e.ts - lastUserTs) : "";
      feedAppend(h("div", { class: "task-foot" },
        took ? h("span", null, took) : null,
        e.leadUsd ? h("span", null, `${LN} ${usd(e.leadUsd)}`) : null,
        e.claudeUsd ? h("span", null, `Claude ${usd(e.claudeUsd)}`) : null));
      leadMsg = null;
      waitingAnswer = false;
      refreshChrome();
      break;
    }
  }
}

// elapsed timers
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) for (const r of s.runs) {
    if (r.done) continue;
    const t = fmtDuration(now - r.start);
    r.timer.textContent = t;
    const st = r.handoff.querySelector(".handoff-status");
    if (st?.classList.contains("running")) st.textContent = t;
  }
}, 1000);

// ───────────── model choice ─────────────

/** Strong tool-calling leads, shown first when they exist in OpenRouter's catalogue. */
const RECOMMENDED = [
  "moonshotai/kimi-k3.1-pro", "qwen/qwen3.8-max-0902", "z-ai/glm-5.3", "deepseek/deepseek-v4-pro-0813",
  "openai/gpt-5.6-luna-pro", "google/gemini-3.8-flash", "minimax/minimax-m3.1-flash",
];
let models: ModelInfo[] | null = null;
let modelsError = "";
let pickActive = 0;

const shortModel = (id: string) => id.replace(/^.*\//, "");
const claudeLabel = (m: string | null) => CLAUDE_MODELS.find(([id]) => id === m)?.[1] ?? m ?? "Your default";
const price = (n: number) => (n === 0 ? "0" : n < 1 ? n.toFixed(2) : Number.isInteger(n) ? String(n) : n.toFixed(1));
const ctxSize = (n: number) => (n >= 1_000_000 ? `${Math.round((n / 1_048_576) * 10) / 10 || 1}M` : `${Math.round(n / 1000)}k`);

function applyConfig(model: string, claudeModel: string | null) {
  if (info) { info.model = model; info.claudeModel = claudeModel; }
  LN = leadName(model);
  modelLabel.textContent = shortModel(model);
  modelBtn.title = `Lead model: ${model}. Click to change.`;
  claudeModelLabel.textContent = `Claude: ${claudeModel ? claudeLabel(claudeModel) : "your default"}`;
  segLeadLabel.textContent = LN;
  leadPane.setAttribute("aria-label", LN);
  if (leadFeed.querySelector(".empty")) resetLeadFeed();
  refreshChrome();
}

function togglePicker() {
  if (!picker.hidden) { closePicker(); return; }
  if (busy) return;
  claudeMenu.hidden = true; moreMenu.hidden = true;
  picker.hidden = false;
  modelBtn.setAttribute("aria-expanded", "true");
  pickSearch.value = "";
  pickActive = 0;
  if (!models) post({ type: "listModels" });
  renderPicker();
  pickSearch.focus();
}
function closePicker() {
  if (picker.hidden) return;
  picker.hidden = true;
  modelBtn.setAttribute("aria-expanded", "false");
}

function pickRows(): { title: string; items: (ModelInfo | string)[] }[] {
  if (!models) return [];
  const q = pickSearch.value.trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/);
    const hits = models.filter((m) => terms.every((t) => m.id.toLowerCase().includes(t) || m.name.toLowerCase().includes(t))).slice(0, 80);
    const custom = q.includes("/") && !models.some((m) => m.id === q) ? [q] : [];
    return [{ title: hits.length ? `Results (${hits.length})` : "No matching model with tool support", items: [...hits, ...custom] }];
  }
  const byId = new Map(models.map((m) => [m.id, m]));
  const rec = RECOMMENDED.map((id) => byId.get(id)).filter((m): m is ModelInfo => !!m);
  const cur = info && !RECOMMENDED.includes(info.model) ? byId.get(info.model) : undefined;
  const top = cur ? [cur, ...rec] : rec;
  // free variants often log prompts; keep them out of the default list (still reachable by search)
  const rest = models.filter((m) => !top.includes(m) && !m.id.endsWith(":free")).slice(0, 60);
  return [{ title: "Recommended", items: top }, { title: "Newest on OpenRouter", items: rest }];
}

function renderPicker() {
  if (!models) {
    pickList.replaceChildren(h("div", { class: "pick-empty" }, modelsError || "Loading models from OpenRouter…"));
    return;
  }
  const groups = pickRows();
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  pickActive = Math.max(0, Math.min(pickActive, total - 1));
  let k = 0;
  const cur = info?.model;
  pickList.replaceChildren(...groups.flatMap((g) => [
    h("div", { class: "pick-group" }, g.title),
    ...g.items.map((m) => {
      const i = k++;
      const custom = typeof m === "string";
      const id = custom ? m : m.id;
      return h("button", {
        class: `pick-row${i === pickActive ? " active" : ""}${id === cur ? " on" : ""}`, role: "option", "aria-selected": String(id === cur),
        dataset: { i: String(i) }, onclick: () => choose(id), onmousemove: () => setActive(i),
      },
        h("span", { class: "pick-main" },
          h("span", { class: "pick-name" }, custom ? `Use "${m}"` : m.name),
          h("span", { class: "pick-id" }, custom ? "Not in the catalogue; the model must support tools" : m.id)),
        custom ? null : h("span", { class: "pick-facts" },
          h("span", { class: "pick-price", title: "USD per million tokens: input / output" }, `${price(m.prompt)} / ${price(m.completion)}`),
          h("span", { class: "pick-ctx", title: "Context size" }, ctxSize(m.context))),
        id === cur ? icon("check", "pick-check") : h("span", { class: "pick-check" }));
    }),
  ]));
  pickList.querySelector(".pick-row.active")?.scrollIntoView({ block: "nearest" });
}
function setActive(i: number) {
  if (i === pickActive) return;
  pickActive = i;
  for (const r of pickList.querySelectorAll<HTMLElement>(".pick-row")) r.classList.toggle("active", r.dataset.i === String(i));
}
function choose(id: string) {
  closePicker();
  if (id !== info?.model) post({ type: "setModel", id });
  input.focus();
}
pickSearch.addEventListener("input", () => { pickActive = 0; renderPicker(); });
pickSearch.addEventListener("keydown", (e) => {
  const rows = [...pickList.querySelectorAll<HTMLElement>(".pick-row")];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    setActive(Math.max(0, Math.min(rows.length - 1, pickActive + (e.key === "ArrowDown" ? 1 : -1))));
    pickList.querySelector(".pick-row.active")?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    rows.find((r) => r.dataset.i === String(pickActive))?.click();
  } else if (e.key === "Escape") {
    e.preventDefault(); e.stopPropagation();
    closePicker(); modelBtn.focus();
  }
});

// ───────────── messages from the extension ─────────────

function markInterrupted() {
  for (const s of sessions.values()) for (const r of s.runs) if (!r.done) endRun(r, true, true, 0, "", r.start);
}

function applyInit(d: InitData) {
  info = d;
  busy = false;
  sessions.clear(); tabs.replaceChildren(); claudeBody.replaceChildren(claudeEmpty);
  activeSession = null; liveRun = null; totals.lead = 0; totals.claude = 0;
  repoName.textContent = d.repoName;
  repoName.title = d.repo;
  branchName.textContent = d.branch || "no branch";
  applyConfig(d.model, d.claudeModel);
  resetLeadFeed();
  replaying = true;
  for (const e of d.transcript) handle(e);
  replaying = false;
  if (!d.busy) { markInterrupted(); waitingAnswer = false; }
  for (const a of asks.values()) if (!a.classList.contains("answered") && !d.busy) a.querySelector(".ask-actions")?.replaceWith(h("div", { class: "ask-answer" }, "Question expired"));
  busy = d.busy;
  if (busy) {
    const live = liveRun as RunView | null; // set by handle() during replay
    if (live) setStatus("claude", `Claude is working in session ${live.session}`);
    else if (waitingAnswer) setStatus("ask", "Waiting for your answer");
    else setStatus("lead", `${LN} is thinking`);
  }
  if (!d.claudeFound) {
    claudeBody.prepend(h("div", { class: "alert alert-danger" }, icon("warn"), h("div", { class: "alert-body" },
      h("div", { class: "alert-title" }, "Claude Code not found"),
      h("div", null, `Looked for: ${d.claudeBin}. Install Claude Code or set "claude.path" in .briefwise/config.json.`))));
  }
  leadFeed.scrollTop = leadFeed.scrollHeight;
  for (const s of sessions.values()) s.feed.scrollTop = s.feed.scrollHeight;
  refreshChrome();
  if (d.hasKey) input.focus();
}

window.addEventListener("message", (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case "init": applyInit(m.data); break;
    case "event": handle(m.event); break;
    case "state": {
      const hadKey = info?.hasKey;
      busy = m.busy;
      if (info) { info.hasKey = m.hasKey; info.branch = m.branch; }
      branchName.textContent = m.branch || "no branch";
      if (!hadKey && m.hasKey && leadFeed.querySelector(".empty")) { resetLeadFeed(); input.focus(); }
      if (!busy) { stopThinking(); waitingAnswer = false; }
      refreshChrome();
      break;
    }
    case "reset":
      if (info) applyInit({ ...info, transcript: [], busy: false });
      break;
    case "toast": showToast(m.text); break;
    case "models":
      models = m.models; modelsError = m.error ?? "";
      if (!picker.hidden) renderPicker();
      break;
    case "config":
      applyConfig(m.model, m.claudeModel);
      showToast(`Lead: ${shortModel(m.model)} · Claude Code: ${claudeLabel(m.claudeModel)}`);
      break;
  }
});

post({ type: "ready" });
