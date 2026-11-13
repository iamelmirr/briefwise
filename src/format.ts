// Human-readable one-liners for Claude's tool calls (shared by the CLI and, later, the VS Code panel).

import * as path from "node:path";

export function relPath(repo: string, p: unknown): string {
  if (typeof p !== "string" || !p) return "";
  const r = path.isAbsolute(p) ? path.relative(repo, p) : p;
  return (r.startsWith("..") ? p : r || ".").split(path.sep).join("/");
}

function lineCount(s: unknown): number {
  return typeof s === "string" && s.length ? s.split("\n").length : 0;
}

export function describeTool(repo: string, name: string, input: any): string {
  const i = input ?? {};
  switch (name) {
    case "Read": return `${relPath(repo, i.file_path)}${i.offset ? ` :${i.offset}` : ""}`;
    case "Edit": return `${relPath(repo, i.file_path)}  +${lineCount(i.new_string)} −${lineCount(i.old_string)}`;
    case "MultiEdit": return `${relPath(repo, i.file_path)}  (${(i.edits ?? []).length} izmjena)`;
    case "Write": return `${relPath(repo, i.file_path)}  (${lineCount(i.content)} linija)`;
    case "NotebookEdit": return relPath(repo, i.notebook_path);
    case "Bash": return String(i.command ?? "").split("\n")[0].slice(0, 160);
    case "Grep": {
      const where = relPath(repo, i.path);
      return `"${i.pattern ?? ""}"${where && where !== "." ? ` u ${where}` : ""}${i.glob ? ` (${i.glob})` : ""}`;
    }
    case "Glob": return String(i.pattern ?? "");
    case "TodoWrite": return `plan: ${(i.todos ?? []).length} stavki`;
    case "Task": case "Agent": return String(i.description ?? "");
    case "WebFetch": return String(i.url ?? "");
    case "WebSearch": return String(i.query ?? "");
    default: return JSON.stringify(i).slice(0, 120);
  }
}
