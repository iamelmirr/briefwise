// Display name for the lead model, shared by the CLI and the webview (no Node imports here).

const VENDORS: [RegExp, string][] = [
  [/^moonshotai\/|kimi/i, "Kimi"],
  [/^qwen\//i, "Qwen"],
  [/^z-ai\/|glm/i, "GLM"],
  [/^deepseek\//i, "DeepSeek"],
  [/^google\/|gemini/i, "Gemini"],
  [/^openai\//i, "GPT"],
  [/^x-ai\/|grok/i, "Grok"],
  [/^minimax\//i, "MiniMax"],
  [/^mistralai\//i, "Mistral"],
  [/^meta-llama\//i, "Llama"],
  [/^anthropic\//i, "Claude"],
];

/** "moonshotai/kimi-k3.1-pro" -> "Kimi", "qwen/qwen3.8-max" -> "Qwen", unknown -> "Lead". */
export function leadName(model: string): string {
  const id = model.replace(/^~/, "");
  for (const [re, name] of VENDORS) if (re.test(id)) return name;
  return "Lead";
}

