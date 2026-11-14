// Kimi Lead webview: left = conversation with Kimi, right = Claude Code sessions, live.

import type { FromWebview, InitData, NoteName, ToWebview, UIEvent } from "../src/protocol.ts";
import { icon } from "./icons.ts";
import { renderMarkdown, type MdOptions } from "./markdown.ts";
import { diffStats, lineDiff } from "./diff.ts";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();
const post = (m: FromWebview) => vscode.postMessage(m);
const saved: { split?: number; view?: "kimi" | "claude"; draft?: string } = vscode.getState() ?? {};
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
let busy = false;
let replaying = false;
let lastUserTs = 0;
let waitingAnswer = false;
const totals = { kimi: 0, claude: 0 };

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

let kimiMsg: { body: HTMLElement; text: string; queued: boolean } | null = null;
let thinking: { el: HTMLElement; ticker: HTMLElement; text: string } | null = null;

// ───────────── shell ─────────────

const statusDot = h("span", { class: "status-dot" });
const statusText = h("span", { class: "status-text" }, "Spreman");
const status = h("div", { class: "status", role: "status", "aria-live": "polite" }, statusDot, statusText);
const repoName = h("span", { class: "repo-name" });
const branchName = h("span", { class: "branch-name" });
const stopBtn = h("button", { class: "btn btn-stop", title: "Zaustavi Kimija i Claudea (Esc)", onclick: () => post({ type: "stop" }) }, icon("stop"), "Zaustavi");

function noteBtn(name: NoteName, label: string, ic: string, title: string) {
  return h("button", { class: "btn btn-ghost", title, onclick: () => post({ type: "openNote", name }) }, icon(ic), h("span", { class: "btn-label" }, label));
}
const moreMenu = h("div", { class: "menu", role: "menu", hidden: true },
  ...([["PROJECT", "Bilješke o projektu"], ["TASKS", "Zadaci"], ["DECISIONS", "Odluke"], ["config", "Podešavanja (config.json)"], ["log", "Cijeli log"]] as [NoteName, string][])
    .map(([name, label]) => h("button", { class: "menu-item", role: "menuitem", onclick: () => { moreMenu.hidden = true; post({ type: "openNote", name }); } }, label)),
);
const moreBtn = h("button", { class: "btn btn-ghost btn-icon", title: "Više", "aria-haspopup": "menu", onclick: (e: Event) => { e.stopPropagation(); moreMenu.hidden = !moreMenu.hidden; } }, icon("more"));
document.addEventListener("click", () => (moreMenu.hidden = true));

const header = h("header", { class: "top" },
  h("div", { class: "where" }, repoName, h("span", { class: "branch" }, icon("branch"), branchName)),
  status,
  h("div", { class: "actions" },
    stopBtn,
    h("button", { class: "btn btn-ghost", title: "Počni novu konverzaciju s Kimijem (bilješke i sesije ostaju)", onclick: () => { if (!busy) post({ type: "newConversation" }); } }, icon("plus"), h("span", { class: "btn-label" }, "Nova")),
    noteBtn("RULES", "Pravila", "rules", "Tvoja pravila za Kimija"),
    noteBtn("PRIVATE", "Privatno", "lock", "Ono što zna samo Kimi"),
    h("div", { class: "menu-wrap" }, moreBtn, moreMenu),
  ),
);

// view switch for narrow widths
const segKimi = h("button", { class: "seg-btn", onclick: () => setView("kimi") }, "Kimi");
const segClaudeDot = h("span", { class: "live-dot", hidden: true });
const segClaude = h("button", { class: "seg-btn", onclick: () => setView("claude") }, "Claude", segClaudeDot);
const seg = h("div", { class: "seg", role: "tablist" }, segKimi, segClaude);

// Kimi pane
const kimiFeed = h("div", { class: "feed kimi-feed", role: "log", "aria-label": "Razgovor s Kimijem" });
const input = h("textarea", { class: "input", rows: 1, placeholder: "Reci Kimiju šta treba uraditi…", "aria-label": "Poruka Kimiju" }) as HTMLTextAreaElement;
const sendBtn = h("button", { class: "send", title: "Pošalji (Enter)", "aria-label": "Pošalji", onclick: () => submit() }, icon("send"));
const ctxBar = h("span", { class: "meter-fill" });
const ctxText = h("span", { class: "meta-item" });
const costText = h("span", { class: "meta-item" });
const modelText = h("span", { class: "meta-item model" });
const composer = h("div", { class: "composer-wrap" },
  h("div", { class: "composer" }, input, sendBtn),
  h("div", { class: "meta" }, modelText, h("span", { class: "meter", title: "Koliko je Kimijev kontekst pun" }, h("span", { class: "meter-track" }, ctxBar), ctxText), costText),
);
const kimiPane = h("section", { class: "pane pane-kimi", "aria-label": "Kimi" }, kimiFeed, composer);

// Claude pane
const tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Claude sesije" });
const resumeBtn = h("button", { class: "btn btn-ghost", title: "Otvori ovu sesiju u terminalu (claude --resume) i nastavi ručno", onclick: () => activeSession && post({ type: "resume", session: activeSession }) }, icon("resume"), h("span", { class: "btn-label" }, "Nastavi u terminalu"));
const claudeBody = h("div", { class: "claude-body" });
const claudeEmpty = h("div", { class: "empty empty-claude" },
  h("div", { class: "empty-mark" }, h("span", { class: "mark-k" }), h("span", { class: "mark-c" })),
  h("p", { class: "empty-lead" }, "Ovdje gledaš Claude Code uživo."),
  h("p", { class: "empty-sub" }, "Kad mu Kimi preda zadatak, vidiš tačan brief koji je dobio, svaki fajl koji čita, svaku komandu i svaku izmjenu."),
);
claudeBody.append(claudeEmpty);
const interjectInput = h("textarea", { class: "input", rows: 1, placeholder: "Upadni: poruka ide direktno Claudeu, Kimi je ne vidi", "aria-label": "Poruka direktno Claudeu" }) as HTMLTextAreaElement;
const interjectBtn = h("button", { class: "send send-claude", title: "Pošalji Claudeu (Enter)", "aria-label": "Pošalji Claudeu", onclick: () => submitInterject() }, icon("send"));
const interject = h("div", { class: "interject", hidden: true }, h("div", { class: "composer composer-claude" }, interjectInput, interjectBtn));
const claudePane = h("section", { class: "pane pane-claude", "aria-label": "Claude Code" },
  h("div", { class: "tabbar" }, tabs, resumeBtn), claudeBody, interject);

const splitter = h("div", { class: "splitter", role: "separator", "aria-orientation": "vertical", tabindex: 0, title: "Povuci za promjenu širine" });
const split = h("main", { class: "split" }, kimiPane, splitter, claudePane);
const toast = h("div", { class: "toast", role: "status", hidden: true });
const app = h("div", { class: "app" }, header, seg, split, toast);
document.body.append(app);

function setView(v: "kimi" | "claude") {
  saved.view = v; persist();
  app.dataset.view = v;
  segKimi.classList.toggle("on", v === "kimi");
  segClaude.classList.toggle("on", v === "claude");
}
setView(saved.view ?? "kimi");

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
  showToast("Poslano Claudeu");
}

let toastTimer = 0;
function showToast(text: string) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 2200);
}

// ───────────── status & meta ─────────────

function setStatus(kind: "idle" | "kimi" | "claude" | "ask", text: string) {
  status.dataset.kind = kind;
  statusText.textContent = text;
}

function refreshChrome() {
  app.classList.toggle("busy", busy);
  stopBtn.hidden = !busy;
  input.disabled = busy || !info?.hasKey;
  sendBtn.disabled = busy || !info?.hasKey;
  input.placeholder = !info?.hasKey ? "Prvo poveži Kimija (OpenRouter ključ)" : busy ? "Kimi radi. Esc zaustavlja." : "Reci Kimiju šta treba uraditi…";
  const claudeLive = !!liveRun && !liveRun.done;
  interject.hidden = !(claudeLive && liveRun!.session === activeSession);
  segClaudeDot.hidden = !claudeLive;
  resumeBtn.hidden = !activeSession;
  costText.textContent = totals.kimi || totals.claude ? `Kimi ${usd(totals.kimi)}  Claude ${usd(totals.claude)}` : "";
  if (!busy && !waitingAnswer) setStatus("idle", "Spreman");
}

function setContext(prompt: number, cached: number) {
  if (!info || !prompt) return;
  const pct = Math.min(100, (prompt / info.contextLimit) * 100);
  ctxBar.style.width = `${pct}%`;
  ctxBar.parentElement!.parentElement!.dataset.level = pct > 80 ? "high" : pct > 55 ? "mid" : "low";
  ctxText.textContent = `${ktok(prompt)} / ${ktok(info.contextLimit)}`;
  ctxText.title = cached ? `Iz keša: ${Math.round((cached / prompt) * 100)} %` : "";
}

// ───────────── Kimi feed ─────────────

function kimiEmpty(): HTMLElement {
  if (!info?.hasKey) {
    const keyInput = h("input", { class: "key-input", type: "password", placeholder: "sk-or-…", "aria-label": "OpenRouter API ključ", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const save = () => { const k = keyInput.value.trim(); if (k) post({ type: "saveKey", key: k }); };
    keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
    return h("div", { class: "empty empty-kimi onboarding" },
      h("div", { class: "empty-mark" }, h("span", { class: "mark-k" }), h("span", { class: "mark-c" })),
      h("p", { class: "empty-lead" }, "Poveži Kimija"),
      h("p", { class: "empty-sub" }, "Kimi radi preko OpenRoutera. Zalijepi API ključ. Čuva se u sigurnom spremištu VS Codea, ne u projektu."),
      h("div", { class: "key-row" }, keyInput, h("button", { class: "btn btn-primary", onclick: save }, icon("key"), "Sačuvaj ključ")),
      h("a", { class: "subtle-link", href: "https://openrouter.ai/keys", onclick: (e: Event) => { e.preventDefault(); post({ type: "openExternal", url: "https://openrouter.ai/keys" }); } }, "Napravi ključ na openrouter.ai/keys"),
    );
  }
  const ideas = [
    "Objasni mi kako je ovaj projekat organizovan i gdje je glavna logika.",
    "Nađi zašto … ne radi i popravi to.",
    "Dodaj testove za … i pokreni ih.",
  ];
  return h("div", { class: "empty empty-kimi" },
    h("div", { class: "empty-mark" }, h("span", { class: "mark-k" }), h("span", { class: "mark-c" })),
    h("p", { class: "empty-lead" }, `Šta radimo u ${info.repoName}?`),
    h("p", { class: "empty-sub" }, "Piši kako ti je prirodno. Kimi to pretvara u precizan zadatak za Claudea, a sve što mu preda vidiš desno."),
    h("div", { class: "ideas" }, ...ideas.map((t) => h("button", { class: "idea", onclick: () => { input.value = t; autosize(input); input.focus(); const i = t.indexOf("…"); if (i >= 0) input.setSelectionRange(i, i + 1); } }, t))),
  );
}

function resetKimiFeed() {
  kimiFeed.replaceChildren(kimiEmpty());
  kimiMsg = null; thinking = null;
}

function feedAppend(node: HTMLElement) {
  kimiFeed.querySelector(".empty")?.remove();
  stick(kimiFeed, () => kimiFeed.append(node));
}

function addUser(text: string, ts: number) {
  lastUserTs = ts;
  feedAppend(h("div", { class: "msg msg-user" }, h("div", { class: "bubble" }, text)));
}

function startThinking() {
  if (thinking || replaying) return;
  const ticker = h("span", { class: "ticker" });
  const el = h("div", { class: "thinking" }, h("span", { class: "thinking-label" }, "Kimi razmišlja"), ticker);
  thinking = { el, ticker, text: "" };
  feedAppend(el);
}
function stopThinking() { thinking?.el.remove(); thinking = null; }

let mdQueued = false;
function renderKimiMsg() {
  mdQueued = false;
  if (!kimiMsg) return;
  const m = kimiMsg;
  stick(kimiFeed, () => m.body.replaceChildren(renderMarkdown(m.text, md)));
}
function kimiText(delta: string) {
  stopThinking();
  if (!kimiMsg) {
    const body = h("div", { class: "md" });
    kimiMsg = { body, text: "", queued: false };
    feedAppend(h("div", { class: "msg msg-kimi" }, h("div", { class: "who who-kimi" }, "Kimi"), body));
  }
  kimiMsg.text += delta;
  if (replaying) renderKimiMsg();
  else if (!mdQueued) { mdQueued = true; requestAnimationFrame(renderKimiMsg); }
}

function kimiTool(label: string, name: string) {
  const last = kimiFeed.lastElementChild;
  const chip = h("span", { class: "chip" }, icon(name === "grep" ? "search" : name === "update_notes" ? "notes" : name === "new_session" ? "plus" : name === "git" ? "branch" : "file"), label);
  if (last?.classList.contains("activity")) stick(kimiFeed, () => last.querySelector(".chips")!.append(chip));
  else feedAppend(h("div", { class: "activity" }, h("div", { class: "chips" }, chip)));
}

function alertCard(kind: "warn" | "danger" | "info", title: string, body: HTMLElement | string) {
  feedAppend(h("div", { class: `alert alert-${kind}` }, icon(kind === "info" ? "info" : kind === "warn" ? "warn" : "shield"),
    h("div", { class: "alert-body" }, h("div", { class: "alert-title" }, title), typeof body === "string" ? (body ? h("div", null, body) : null) : body)));
}

const asks = new Map<string, HTMLElement>();
function askCard(id: string, question: string) {
  waitingAnswer = true;
  setStatus("ask", "Čeka tvoj odgovor");
  const free = h("input", { class: "ask-input", placeholder: "Ili napiši svoj odgovor i pritisni Enter", "aria-label": "Tvoj odgovor" }) as HTMLInputElement;
  const send = (text: string) => { if (text.trim()) post({ type: "answer", id, text: text.trim() }); };
  free.addEventListener("keydown", (e) => { if (e.key === "Enter") send(free.value); });
  const actions = h("div", { class: "ask-actions" },
    h("button", { class: "btn btn-primary", onclick: () => send("Da, odobreno.") }, icon("check"), "Odobri"),
    h("button", { class: "btn", onclick: () => send("Ne, nemoj to raditi.") }, icon("x"), "Odbij"),
    free);
  const card = h("div", { class: "ask" }, h("div", { class: "ask-head" }, icon("info"), "Kimi te pita"), h("div", { class: "md" }, renderMarkdown(question, md)), actions);
  asks.set(id, card);
  feedAppend(card);
  if (!replaying) free.focus();
}
function askAnswered(id: string, text: string | null) {
  waitingAnswer = false;
  const card = asks.get(id);
  if (!card) return;
  card.classList.add("answered");
  card.querySelector(".ask-actions")?.replaceWith(h("div", { class: "ask-answer" }, text === null ? "Bez odgovora" : `Tvoj odgovor: ${text}`));
}

// ───────────── Claude pane ─────────────

function ensureSession(name: string): SessionView {
  let s = sessions.get(name);
  if (s) return s;
  claudeEmpty.remove();
  const tab = h("button", { class: "tab", role: "tab", onclick: () => selectSession(name) }, h("span", { class: "live-dot", hidden: true }), h("span", { class: "tab-name" }, name)) as HTMLButtonElement;
  const feed = h("div", { class: "feed claude-feed", role: "log", "aria-label": `Claude sesija ${name}`, hidden: true });
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
  Read: "Čita", Edit: "Mijenja", MultiEdit: "Mijenja", Write: "Piše", NotebookEdit: "Mijenja", Bash: "Pokreće", PowerShell: "Pokreće",
  Grep: "Traži", Glob: "Traži fajlove", TodoWrite: "Plan", Task: "Pomoćnik", Agent: "Pomoćnik", WebFetch: "Otvara", WebSearch: "Pretražuje",
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
  if (shown > max) pre.append(h("div", { class: "dl dl-gap" }, `još ${shown - max} linija u pravom diffu`));
  return { el: pre, add, del };
}

function toolRow(run: RunView, id: string, name: string, input: any) {
  const status = h("span", { class: "tstatus running" });
  let label: Child = "";
  let stats: Child = null;
  let detail: HTMLElement = h("div", { class: "tdetail", hidden: true });
  let open = false;
  const file = relPath(input?.file_path ?? input?.notebook_path);
  const fileLink = (f: string, line?: number) => h("button", { class: "tpath", title: "Otvori fajl", onclick: (e: Event) => { e.stopPropagation(); post({ type: "openFile", path: f, line }); } }, f);
  switch (name) {
    case "Read": label = fileLink(file, input.offset); if (input.offset) stats = h("span", { class: "tmeta" }, `od linije ${input.offset}`); break;
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
      detail.append(h("button", { class: "btn btn-ghost btn-small", onclick: () => post({ type: "openDiff", path: file }) }, icon("diff"), "Otvori diff u editoru"));
      stats = h("span", { class: "tstats" }, h("span", { class: "add" }, `+${add}`), h("span", { class: "del" }, `−${del}`));
      // show small edits inline right away; big ones and whole new files stay one click away
      open = name === "Write" ? add <= 8 : add + del <= 24;
      break;
    }
    case "Bash": case "PowerShell": label = h("code", { class: "tcmd" }, String(input.command ?? "").split("\n")[0]); break;
    case "Grep": label = h("code", { class: "tcmd" }, String(input.pattern ?? "")); if (input.path && relPath(input.path) !== ".") stats = h("span", { class: "tmeta" }, `u ${relPath(input.path)}`); break;
    case "Glob": label = h("code", { class: "tcmd" }, String(input.pattern ?? "")); break;
    case "TodoWrite": {
      const todos: { content?: string; status?: string }[] = input.todos ?? [];
      label = `${todos.length} koraka`;
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
    t.detail.prepend(h("pre", { class: "tresult err" }, text.slice(0, 1200) || "Greška"));
    if (/denied|permission/i.test(text)) t.row.querySelector(".tverb")!.append(h("span", { class: "tmeta" }, " blokirano"));
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
  const more = h("button", { class: "brief-more", hidden: true, onclick: () => { brief.classList.toggle("expanded"); more.textContent = brief.classList.contains("expanded") ? "Skupi" : "Prikaži cijeli brief"; } }, "Prikaži cijeli brief");
  const brief = h("div", { class: "brief" }, h("div", { class: "brief-head" }, h("span", { class: "who who-kimi" }, "Kimi"), h("span", { class: "brief-to" }, "predaje Claudeu")), promptPre, more);
  const stream = h("div", { class: "stream" });
  const foot = h("div", { class: "run-foot" });
  const el = h("article", { class: `run run-${mode}`, id },
    h("div", { class: "run-head" },
      h("span", { class: `mode mode-${mode}` }, mode === "ask" ? "Savjetovanje, samo čita" : "Implementacija"),
      h("span", { class: "run-time" }, clock(ts)),
      timer),
    brief, stream, foot);
  // handoff card in Kimi's feed: the bridge between the two panes
  const hstatus = h("span", { class: "handoff-status running" }, replaying ? "" : "radi");
  const handoff = h("button", { class: `handoff handoff-${mode}`, onclick: () => focusRun(run) },
    h("span", { class: "handoff-rail" }),
    h("span", { class: "handoff-main" },
      h("span", { class: "handoff-top" }, icon("handoff"), h("span", { class: "handoff-title" }, mode === "ask" ? `Pita Claudea za savjet` : `Daje Claudeu da implementira`), h("span", { class: "session-tag" }, session)),
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
    setStatus("claude", `Claude radi u sesiji ${session}`);
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
  st.replaceChildren(icon(stopped ? "stop" : isError ? "x" : "check"), stopped ? "zaustavljeno" : isError ? "greška" : took);
  run.foot.prepend(h("div", { class: "run-end" },
    h("span", { class: `end-state ${stopped ? "stopped" : isError ? "err" : "ok"}` }, icon(stopped ? "stop" : isError ? "x" : "check"), stopped ? "Zaustavljeno" : isError ? "Završeno s greškom" : "Gotovo"),
    h("span", { class: "end-meta" }, took), cost ? h("span", { class: "end-meta" }, usd(cost)) : null));
  if (isError && !stopped && text) run.foot.append(h("pre", { class: "tresult err" }, text.slice(0, 800)));
  for (const t of run.tools.values()) if (t.status.classList.contains("running")) t.status.className = `tstatus ${stopped ? "stopped" : "ok"}`;
  const s = sessions.get(run.session)!;
  s.tab.querySelector(".live-dot")!.setAttribute("hidden", "");
  if (liveRun === run) liveRun = null;
  if (busy && !replaying) setStatus("kimi", "Kimi pregleda Claudeov rad");
  refreshChrome();
}

function runFiles(run: RunView, files: { file: string; code: string }[]) {
  const label = (code: string) => (code.includes("D") ? "obrisan" : code.includes("?") || code.includes("A") ? "nov" : code.trim() ? "izmijenjen" : "vraćen");
  run.foot.append(h("div", { class: "files" },
    h("div", { class: "files-title" }, `Promijenjeni fajlovi (${files.length})`),
    ...files.map((f) => h("div", { class: "file-row" },
      h("button", { class: "tpath", onclick: () => post({ type: "openFile", path: f.file }) }, f.file),
      h("span", { class: `fstate fstate-${label(f.code)}` }, label(f.code)),
      h("button", { class: "btn btn-ghost btn-small", onclick: () => post({ type: "openDiff", path: f.file }) }, icon("diff"), "Diff")))));
}

// ───────────── event handling ─────────────

function handle(e: UIEvent) {
  switch (e.type) {
    case "user":
      addUser(e.text, e.ts);
      kimiMsg = null;
      if (!replaying) { busy = true; setStatus("kimi", "Kimi razmišlja"); refreshChrome(); }
      break;
    case "kimi-start":
      kimiMsg = null;
      if (!replaying) { startThinking(); if (!liveRun) setStatus("kimi", "Kimi razmišlja"); }
      break;
    case "kimi-reasoning":
      if (thinking) {
        thinking.text = (thinking.text + e.delta).slice(-400);
        thinking.ticker.textContent = thinking.text.replace(/\s+/g, " ").trim().slice(-140);
      }
      break;
    case "kimi-text":
      kimiText(e.delta);
      break;
    case "kimi-end":
      stopThinking();
      if (kimiMsg) renderKimiMsg();
      kimiMsg = null;
      setContext(e.promptTokens, e.cachedTokens);
      break;
    case "kimi-tool":
      kimiTool(e.label, e.name);
      if (!replaying) setStatus("kimi", "Kimi čita kod");
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
        stick(s.feed, () => run.stream.append(h("div", { class: "interjection" }, h("span", { class: "who who-you" }, "Ti"), h("span", null, ev.text))));
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
      alertCard("warn", "Ovo traži tvoje odobrenje", h("ul", { class: "alert-list" }, ...e.issues.map((i) => h("li", null, i))));
      break;
    case "blocked":
      alertCard("danger", "Blokirano prije slanja Claudeu", e.reason);
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
      alertCard("danger", "Nešto je puklo", e.text);
      break;
    case "task-end": {
      stopThinking();
      if (!e.streamed) {
        const body = h("div", { class: "md" }, renderMarkdown(e.report, md));
        feedAppend(h("div", { class: `msg msg-kimi${e.report === "Zaustavljeno." ? " msg-stopped" : ""}` }, h("div", { class: "who who-kimi" }, "Kimi"), body));
      }
      totals.kimi += e.kimiUsd; totals.claude += e.claudeUsd;
      const took = lastUserTs ? fmtDuration(e.ts - lastUserTs) : "";
      feedAppend(h("div", { class: "task-foot" },
        took ? h("span", null, took) : null,
        e.kimiUsd ? h("span", null, `Kimi ${usd(e.kimiUsd)}`) : null,
        e.claudeUsd ? h("span", null, `Claude ${usd(e.claudeUsd)}`) : null));
      kimiMsg = null;
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

// ───────────── messages from the extension ─────────────

function markInterrupted() {
  for (const s of sessions.values()) for (const r of s.runs) if (!r.done) endRun(r, true, true, 0, "", r.start);
}

function applyInit(d: InitData) {
  info = d;
  busy = false;
  sessions.clear(); tabs.replaceChildren(); claudeBody.replaceChildren(claudeEmpty);
  activeSession = null; liveRun = null; totals.kimi = 0; totals.claude = 0;
  repoName.textContent = d.repoName;
  repoName.title = d.repo;
  branchName.textContent = d.branch || "bez grane";
  modelText.textContent = d.model.replace(/^.*\//, "");
  modelText.title = d.model;
  resetKimiFeed();
  replaying = true;
  for (const e of d.transcript) handle(e);
  replaying = false;
  if (!d.busy) { markInterrupted(); waitingAnswer = false; }
  for (const a of asks.values()) if (!a.classList.contains("answered") && !d.busy) a.querySelector(".ask-actions")?.replaceWith(h("div", { class: "ask-answer" }, "Pitanje je isteklo"));
  busy = d.busy;
  if (busy) {
    const live = liveRun as RunView | null; // set by handle() during replay
    if (live) setStatus("claude", `Claude radi u sesiji ${live.session}`);
    else if (waitingAnswer) setStatus("ask", "Čeka tvoj odgovor");
    else setStatus("kimi", "Kimi razmišlja");
  }
  if (!d.claudeFound) {
    claudeBody.prepend(h("div", { class: "alert alert-danger" }, icon("warn"), h("div", { class: "alert-body" },
      h("div", { class: "alert-title" }, "Claude Code nije pronađen"),
      h("div", null, `Tražio sam: ${d.claudeBin}. Instaliraj Claude Code ili upiši putanju u "claude.path" u .kimi/config.json.`))));
  }
  kimiFeed.scrollTop = kimiFeed.scrollHeight;
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
      branchName.textContent = m.branch || "bez grane";
      if (!hadKey && m.hasKey && kimiFeed.querySelector(".empty")) { resetKimiFeed(); input.focus(); }
      if (!busy) { stopThinking(); waitingAnswer = false; }
      refreshChrome();
      break;
    }
    case "reset":
      if (info) applyInit({ ...info, transcript: [], busy: false });
      break;
    case "toast": showToast(m.text); break;
  }
});

post({ type: "ready" });
