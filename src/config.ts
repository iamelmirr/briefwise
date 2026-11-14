// Config, paths and small file helpers for the .kimi/ folder inside a project.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type Config = {
  model: string;
  provider: Record<string, unknown> | null; // OpenRouter provider routing, e.g. { "sort": "throughput" }
  reasoningEffort: string | null;           // Kimi's default thinking: "low" | "medium" | "high" | null (model default)
  decisionEffort: string | null;            // thinking right after Claude returned options
  maxAskRounds: number;                     // ask_claude calls allowed per task
  maxSteps: number;                         // Kimi tool-loop steps per task
  context: {
    softTokens: number;                     // above this: prune old reads and old reasoning
    hardTokens: number;                     // above this: drop earlier turns, then summarize the task
    keepTaskPairs: number;                  // earlier (question, report) pairs Kimi sees
  };
  read: { maxLines: number; maxChars: number; grepMax: number };
  claude: {
    path: string | null;                    // path to the claude binary; null = auto-detect
    userSettings: boolean;                  // load ~/.claude/settings.json too (its allow-rules then bypass the guardrails)
    model: string | null;
    effort: string | null;
    maxBudgetUsdPerCall: number | null;
    reportMaxChars: number;                 // how much of Claude's final reply Kimi gets
    implementAllow: string[];               // extra tools Claude may use when implementing
    denyRead: string[];                     // paths neither Claude nor Kimi may read
  };
  forbidden: string[];                      // regexes that must never appear in a prompt to Claude
};

export const DEFAULT_CONFIG: Config = {
  model: "moonshotai/kimi-k3.1-pro",
  provider: { sort: "throughput" },
  reasoningEffort: "low",
  decisionEffort: "medium",
  maxAskRounds: 3,
  maxSteps: 60,
  context: { softTokens: 24_000, hardTokens: 40_000, keepTaskPairs: 8 },
  read: { maxLines: 200, maxChars: 12_000, grepMax: 40 },
  claude: {
    path: null,
    userSettings: false,
    model: null,
    effort: null,
    maxBudgetUsdPerCall: null,
    reportMaxChars: 6_000,
    implementAllow: [],
    denyRead: [".env", ".env.*", "**/*.pem", "**/*.key", "secrets/**"],
  },
  forbidden: [],
};

export type Paths = ReturnType<typeof kimiPaths>;

export function kimiPaths(repo: string) {
  const dir = path.join(repo, ".kimi");
  return {
    dir,
    config: path.join(dir, "config.json"),
    rules: path.join(dir, "RULES.md"),
    private: path.join(dir, "PRIVATE.md"),
    project: path.join(dir, "PROJECT.md"),
    tasks: path.join(dir, "TASKS.md"),
    decisions: path.join(dir, "DECISIONS.md"),
    sessions: path.join(dir, "sessions.json"),
    history: path.join(dir, "history.json"),
    log: path.join(dir, "log.md"),
  };
}

export function readText(p: string, fallback = ""): string {
  try { return fs.readFileSync(p, "utf8"); } catch { return fallback; }
}
export function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return fallback; }
}
export function writeJson(p: string, v: unknown): void {
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}
export function clip(s: string, n: number, hint = ""): string {
  return s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars${hint ? `; ${hint}` : ""}]` : s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function merge<T>(base: T, over: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge((base as Record<string, unknown>)[k], v) : v;
  return out as T;
}

/** Create .kimi/ from templates if needed, keep it out of git, and load the config. */
export function init(repo: string, templatesDir?: string): { cfg: Config; P: Paths } {
  const TEMPLATES = templatesDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
  const P = kimiPaths(repo);
  fs.mkdirSync(P.dir, { recursive: true });
  const files: [string, string][] = [
    ["RULES.md", P.rules], ["PRIVATE.md", P.private], ["PROJECT.md", P.project],
    ["TASKS.md", P.tasks], ["DECISIONS.md", P.decisions], ["config.json", P.config],
  ];
  for (const [file, dest] of files) {
    if (!fs.existsSync(dest)) {
      const fallback = file.endsWith(".json") ? JSON.stringify(DEFAULT_CONFIG, null, 2) : "";
      fs.writeFileSync(dest, readText(path.join(TEMPLATES, file), fallback));
    }
  }
  // keep .kimi out of git without touching the team's .gitignore
  const exclude = path.join(repo, ".git", "info", "exclude");
  if (fs.existsSync(path.dirname(exclude)) && !readText(exclude).includes(".kimi/")) fs.appendFileSync(exclude, "\n.kimi/\n");
  const cfg = merge(DEFAULT_CONFIG, readJson<unknown>(P.config, {}));
  return { cfg, P };
}

// gitignore-ish glob: "*" within a segment, "**" across segments, no-slash patterns match the basename anywhere.
function globRe(g: string): RegExp {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

export function isDenied(relPath: string, patterns: string[]): boolean {
  const rel = relPath.split(path.sep).join("/").replace(/^\.\//, "");
  if (rel === ".kimi" || rel.startsWith(".kimi/")) return true;
  const base = rel.split("/").pop() ?? rel;
  return patterns.some((p) => {
    const pat = p.replace(/^\.\//, "");
    const re = globRe(pat);
    return pat.includes("/") ? re.test(rel) : re.test(base) || re.test(rel);
  });
}
