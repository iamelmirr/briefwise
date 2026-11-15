// Read-only documents with a file's content at HEAD, for "last commit ↔ now" diffs.

import * as vscode from "vscode";
import { execFileSync } from "node:child_process";

export const BASE_SCHEME = "briefwise-base";

export function baseUri(repo: string, rel: string, empty = false): vscode.Uri {
  return vscode.Uri.from({ scheme: BASE_SCHEME, path: `/${rel}`, query: new URLSearchParams({ repo, ...(empty ? { empty: "1" } : {}) }).toString() });
}

export class BaseContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    const q = new URLSearchParams(uri.query);
    if (q.get("empty")) return "";
    const repo = q.get("repo") ?? "";
    const rel = uri.path.replace(/^\//, "");
    try {
      return execFileSync("git", ["show", `HEAD:${rel}`], { cwd: repo, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return ""; // new file: nothing at HEAD
    }
  }
}
