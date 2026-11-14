// Kimi Lead VS Code extension entry point.

import * as vscode from "vscode";
import { KimiPanel, KEY_SECRET } from "./panel.ts";
import { BASE_SCHEME, BaseContentProvider } from "./base-content.ts";

async function pickRepo(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    void vscode.window.showWarningMessage("Open a project folder (File → Open Folder), then start Kimi Lead.");
    return;
  }
  if (folders.length === 1) return folders[0].uri.fsPath;
  const active = vscode.window.activeTextEditor?.document.uri;
  const preferred = active && vscode.workspace.getWorkspaceFolder(active);
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath, picked: f === preferred })),
    { placeHolder: "Which project should Kimi Lead open?" },
  );
  return pick?.description;
}

export function activate(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, new BaseContentProvider()));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "kimiLead.open";
  const idle = () => { status.text = "$(comment-discussion) Kimi Lead"; status.tooltip = "Open Kimi Lead (Ctrl+Alt+K)"; };
  idle();
  status.show();
  ctx.subscriptions.push(status, KimiPanel.busyChanged.event((busy) => {
    if (busy) { status.text = "$(loading~spin) Kimi Lead: working"; status.tooltip = "The lead and Claude are working. Click to show."; }
    else idle();
  }));

  ctx.subscriptions.push(
    vscode.commands.registerCommand("kimiLead.open", async () => {
      const repo = await pickRepo();
      if (repo) await KimiPanel.show(ctx, repo);
    }),
    vscode.commands.registerCommand("kimiLead.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "OpenRouter API key",
        prompt: "Kept in VS Code's secret storage, not in the project.",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "sk-or-…",
      });
      if (key?.trim()) {
        await ctx.secrets.store(KEY_SECRET, key.trim());
        void vscode.window.showInformationMessage("OpenRouter key saved.");
      }
    }),
    vscode.commands.registerCommand("kimiLead.clearApiKey", async () => {
      await ctx.secrets.delete(KEY_SECRET);
      void vscode.window.showInformationMessage("OpenRouter key removed.");
    }),
    vscode.commands.registerCommand("kimiLead.stop", () => KimiPanel.current?.stop()),
    vscode.commands.registerCommand("kimiLead.newConversation", () => KimiPanel.current?.newConversation()),
  );
}

export function deactivate(): void {
  KimiPanel.current?.dispose();
}
