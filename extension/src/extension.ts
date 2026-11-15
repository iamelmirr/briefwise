// Briefwise VS Code extension entry point.

import * as vscode from "vscode";
import { BriefwisePanel, KEY_SECRET, LEGACY_KEY_SECRET } from "./panel.ts";
import { BASE_SCHEME, BaseContentProvider } from "./base-content.ts";

async function pickRepo(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    void vscode.window.showWarningMessage("Open a project folder (File → Open Folder), then start Briefwise.");
    return;
  }
  if (folders.length === 1) return folders[0].uri.fsPath;
  const active = vscode.window.activeTextEditor?.document.uri;
  const preferred = active && vscode.workspace.getWorkspaceFolder(active);
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath, picked: f === preferred })),
    { placeHolder: "Which project should Briefwise open?" },
  );
  return pick?.description;
}

/** One-time move of the OpenRouter key from the pre-rename secret to the current one. */
async function migrateSecret(ctx: vscode.ExtensionContext): Promise<void> {
  try {
    const old = await ctx.secrets.get(LEGACY_KEY_SECRET);
    if (old === undefined) return;
    if (!(await ctx.secrets.get(KEY_SECRET))) await ctx.secrets.store(KEY_SECRET, old);
    await ctx.secrets.delete(LEGACY_KEY_SECRET);
  } catch { /* secret storage unavailable: the user can set the key again */ }
}

export function activate(ctx: vscode.ExtensionContext): void {
  const migrated = migrateSecret(ctx);
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, new BaseContentProvider()));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "briefwise.open";
  const idle = () => { status.text = "$(comment-discussion) Briefwise"; status.tooltip = "Open Briefwise (Ctrl+Alt+K)"; };
  idle();
  status.show();
  ctx.subscriptions.push(status, BriefwisePanel.busyChanged.event((busy) => {
    if (busy) { status.text = "$(loading~spin) Briefwise: working"; status.tooltip = "The lead and Claude are working. Click to show."; }
    else idle();
  }));

  ctx.subscriptions.push(
    vscode.commands.registerCommand("briefwise.open", async () => {
      await migrated;
      const repo = await pickRepo();
      if (repo) await BriefwisePanel.show(ctx, repo);
    }),
    vscode.commands.registerCommand("briefwise.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "OpenRouter API key",
        prompt: "Kept in VS Code's secret storage, not in the project.",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "sk-or-…",
      });
      if (key?.trim()) {
        await migrated;
        await ctx.secrets.store(KEY_SECRET, key.trim());
        void vscode.window.showInformationMessage("OpenRouter key saved.");
      }
    }),
    vscode.commands.registerCommand("briefwise.clearApiKey", async () => {
      await migrated;
      await ctx.secrets.delete(KEY_SECRET);
      void vscode.window.showInformationMessage("OpenRouter key removed.");
    }),
    vscode.commands.registerCommand("briefwise.stop", () => BriefwisePanel.current?.stop()),
    vscode.commands.registerCommand("briefwise.newConversation", () => BriefwisePanel.current?.newConversation()),
  );
}

export function deactivate(): void {
  BriefwisePanel.current?.dispose();
}
