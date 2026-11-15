// Git helpers and the post-implementation guard.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function git(repo: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    if (e.status === 1 && !String(e.stderr ?? "").trim()) return String(e.stdout ?? ""); // e.g. git grep: no matches
    return `git error: ${String(e.stderr || e.message || "").trim()}`;
  }
}

/** Dirty files (modified, staged, untracked, deleted) → two-letter porcelain code. Ignores .briefwise/ (and legacy .kimi/). */
export function dirtyFiles(repo: string): Map<string, string> {
  const m = new Map<string, string>();
  const out = git(repo, ["status", "--porcelain", "-uall", "-z"]);
  if (out.startsWith("git error")) return m;
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const code = e.slice(0, 2);
    const file = e.slice(3);
    if (code[0] === "R" || code[0] === "C") i++; // next entry is the original path
    if (file === ".briefwise" || file.startsWith(".briefwise/") || file === ".kimi" || file.startsWith(".kimi/")) continue;
    m.set(file, code);
  }
  return m;
}

/** file → "code:contenthash" for every dirty file, so re-edits of already-dirty files are still detected. */
export type Snapshot = Map<string, string>;

function hashFile(abs: string): string {
  try { return createHash("sha1").update(fs.readFileSync(abs)).digest("hex").slice(0, 12); } catch { return "-"; }
}

export function snapshot(repo: string): Snapshot {
  const s: Snapshot = new Map();
  for (const [file, code] of dirtyFiles(repo)) s.set(file, `${code}:${hashFile(path.join(repo, file))}`);
  return s;
}

export type Change = { file: string; code: string };

export function changesSince(repo: string, before: Snapshot): Change[] {
  const after = snapshot(repo);
  const out: Change[] = [];
  for (const [file, v] of after) if (before.get(file) !== v) out.push({ file, code: v.split(":")[0] });
  for (const file of before.keys()) if (!after.has(file)) out.push({ file, code: "  " }); // reverted to committed state
  return out;
}

// Changes that need the user's approval — checked in code, not just by prompt.
const GUARDS: [RegExp, string][] = [
  [/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|go\.mod|go\.sum|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Cargo\.toml|Cargo\.lock|composer\.json|composer\.lock|pom\.xml|build\.gradle(\.kts)?|[^/]+\.csproj|Gemfile(\.lock)?)$/, "dependencies"],
  [/(^|\/)(migrations?|db\/migrate)\/|schema\.prisma$|\.sql$/, "database schema"],
  [/(^|\/)(Dockerfile|docker-compose[^/]*|\.github\/workflows\/|k8s\/|helm\/|terraform\/)|\.tf$|(^|\/)\.env/, "deployment / production config"],
];

export function guardIssues(changes: Change[]): string[] {
  const issues: string[] = [];
  for (const { file, code } of changes) {
    if (code.includes("D")) issues.push(`deleted: ${file}`);
    for (const [re, what] of GUARDS) if (re.test(file)) issues.push(`${what}: ${file}`);
  }
  return [...new Set(issues)];
}
