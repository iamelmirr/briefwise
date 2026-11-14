// Messages between the extension host and the webview.

import type { LeadEvent } from "../../src/lead.ts";

export type UIEvent = (
  | LeadEvent
  | { type: "user"; text: string }
  | { type: "ask"; id: string; question: string }
  | { type: "answer"; id: string; text: string | null }
  | { type: "error"; text: string }
) & { ts: number };

export type InitData = {
  repo: string;
  repoName: string;
  branch: string;
  model: string;
  contextLimit: number;
  hasKey: boolean;
  claudeBin: string;
  claudeFound: boolean;
  busy: boolean;
  transcript: UIEvent[];
};

export type ToWebview =
  | { type: "init"; data: InitData }
  | { type: "event"; event: UIEvent }
  | { type: "state"; busy: boolean; hasKey: boolean; branch: string }
  | { type: "reset" }
  | { type: "toast"; text: string };

export type NoteName = "RULES" | "PRIVATE" | "PROJECT" | "TASKS" | "DECISIONS" | "config" | "log";

export type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "interject"; text: string }
  | { type: "stop" }
  | { type: "answer"; id: string; text: string }
  | { type: "saveKey"; key: string }
  | { type: "newConversation" }
  | { type: "openFile"; path: string; line?: number }
  | { type: "openDiff"; path: string }
  | { type: "openNote"; name: NoteName }
  | { type: "resume"; session: string }
  | { type: "openExternal"; url: string };
