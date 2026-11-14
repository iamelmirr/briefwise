// Streaming OpenRouter client for Kimi (OpenAI-compatible chat completions with tools).

import type { Config } from "./config.ts";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type Msg = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning?: string;
};

export type KimiResult = { msg: Msg; costUsd: number; promptTokens: number; cachedTokens: number };

const RETRY = [408, 429, 500, 502, 503, 504];

export async function kimiCall(o: {
  cfg: Config;
  apiKey?: string;
  system: string;
  messages: Msg[];
  tools: unknown[];
  effort: string | null;
  signal?: AbortSignal;
  toolChoice?: "auto" | "none";
  onText?(delta: string): void;
  onReasoning?(delta: string): void;
}): Promise<KimiResult> {
  const key = o.apiKey || process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("Nema OpenRouter API ključa (OPENROUTER_API_KEY)");
  const body = JSON.stringify({
    model: o.cfg.model,
    messages: [{ role: "system", content: o.system }, ...o.messages],
    tools: o.tools,
    ...(o.toolChoice ? { tool_choice: o.toolChoice } : {}),
    stream: true,
    usage: { include: true },
    ...(o.effort ? { reasoning: { effort: o.effort } } : {}),
    ...(o.cfg.provider ? { provider: o.cfg.provider } : {}),
  });

  let res: Response;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "kimi-lead" },
      body,
      signal: o.signal,
    });
    if (res.ok && res.body) break;
    if (attempt >= 4 || !RETRY.includes(res.status)) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }

  const dec = new TextDecoder();
  let buf = "", content = "", reasoning = "";
  const calls: ToolCall[] = [];
  let usage: any = null;

  const onData = (data: string) => {
    if (data === "[DONE]") return;
    let j: any;
    try { j = JSON.parse(data); } catch { return; }
    if (j.error) throw new Error(`OpenRouter: ${j.error.message ?? JSON.stringify(j.error)}`);
    if (j.usage) usage = j.usage;
    const d = j.choices?.[0]?.delta;
    if (!d) return;
    if (d.content) { content += d.content; o.onText?.(d.content); }
    if (d.reasoning) { reasoning += d.reasoning; o.onReasoning?.(d.reasoning); }
    for (const tc of d.tool_calls ?? []) {
      const k = typeof tc.index === "number" ? tc.index : calls.length;
      const c = (calls[k] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.function.name ||= tc.function.name;
      if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
    }
  };

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith("data:")) onData(line.slice(5).trim());
    }
  }
  if (buf.trim().startsWith("data:")) onData(buf.trim().slice(5).trim());

  const toolCalls = calls.filter(Boolean).map((c, k) => ({ ...c, id: c.id || `call_${Date.now()}_${k}` }));
  const msg: Msg = {
    role: "assistant",
    content,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
  return {
    msg,
    costUsd: Number(usage?.cost || 0),
    promptTokens: Number(usage?.prompt_tokens || 0),
    cachedTokens: Number(usage?.prompt_tokens_details?.cached_tokens || 0),
  };
}
