import "server-only";
import { getProviderKey, getSetting } from "./settings";
import { codexRespond, isCodexConnected } from "./codex";
import { CODEX_QUICK_MODEL } from "./codexProtocol";
import { safeCodexError } from "./codexErrors";
import { recordAiUsage } from "./systemHealth";
import { logError } from "./errorLog";
import { AI_PROVIDER_KEY, chatTranscript, isOutOfCredit, pickAiProvider, type AiProvider } from "./aiProviderRules";

/** This workspace's AI: its choice (ChatGPT unless set to Claude) when set up, else the other, else null. */
export async function aiProvider(): Promise<AiProvider | null> {
  const [chosen, chatgpt, claudeKey] = await Promise.all([
    getSetting(AI_PROVIDER_KEY),
    isCodexConnected(),
    getProviderKey("ANTHROPIC_API_KEY"),
  ]);
  return pickAiProvider(chosen, chatgpt, Boolean(claudeKey));
}

export type AiUsage = { input_tokens?: number; output_tokens?: number };
export type AiFailure = "not_configured" | "no_credit" | "timeout" | "failed" | "unreachable";
/**
 * model: the model that answered — or, on a failure, the one asked for (null when nothing was asked).
 * usage: the tokens the provider reported, either provider (review of #1056: screening meters both).
 */
export type AiTextResult =
  | { ok: true; text: string; provider: AiProvider; model: string; usage?: AiUsage }
  /** failed = the provider answered with an error; unreachable = it never answered (network). */
  | { ok: false; failure: AiFailure; provider: AiProvider | null; model: string | null };

type AiTextInput = {
  /** ErrorLog scope. */
  scope: string;
  system: string;
  /** One question — or `history`, a conversation oldest first. */
  prompt?: string;
  history?: { role: "user" | "assistant"; content: string }[];
  images?: { mediaType: string; base64: string }[];
  /** A PDF for Claude to read itself. ChatGPT is given its text in `prompt` instead (lib/supplierInvoiceReader). */
  pdfBase64?: string;
  maxTokens: number;
  timeoutMs: number;
  claudeModel?: string;
  /** Short, quick calls (the chatbot, sorting, extraction): ChatGPT's quicker model. */
  quick?: boolean;
  effort?: "low" | "medium" | "high";
};

/**
 * One text answer from the workspace's AI — the chatbot, invoice reading, the ✨ check and the other short helpers.
 * NEVER THROWS: everything, the provider lookup included, is inside one handler, so a caller always gets a named
 * result (review of #1056: an exception here lost the screening record). Logs the status only: a provider's error
 * body can quote what was sent.
 */
export async function aiText(input: AiTextInput, chosen?: AiProvider | null): Promise<AiTextResult> {
  let provider: AiProvider | null = chosen ?? null;
  let model: string | null = null;
  try {
    if (chosen === undefined) provider = await aiProvider();
    if (!provider) return { ok: false, failure: "not_configured", provider: null, model: null };
    if (provider === "chatgpt") {
      // The workspace's own model when not quick — codexRespond picks it; the answer names the one that replied.
      model = input.quick ? CODEX_QUICK_MODEL : "chatgpt";
      return await askChatGpt(input, model);
    }
    model = input.claudeModel ?? "claude-haiku-4-5";
    return await askClaude(input, model);
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    await logError(input.scope, error instanceof Error ? error.name : "error").catch(() => {});
    return { ok: false, failure: timedOut ? "timeout" : "unreachable", provider, model };
  }
}

async function askChatGpt(input: AiTextInput, asked: string): Promise<AiTextResult> {
  const reply = await codexRespond({
    instructions: input.system,
    prompt: input.history ? chatTranscript(input.history) : input.prompt ?? "",
    images: input.images?.map((image) => `data:${image.mediaType};base64,${image.base64}`),
    reasoningEffort: input.effort ?? "low",
    timeoutMs: input.timeoutMs,
    preferModel: input.quick ? CODEX_QUICK_MODEL : undefined,
  });
  if ("error" in reply) {
    await logError(input.scope, "ChatGPT failed", safeCodexError(reply.error)).catch(() => {});
    return { ok: false, failure: reply.transient ? "timeout" : "failed", provider: "chatgpt", model: asked };
  }
  const usage = reply.usage ? { input_tokens: reply.usage.inputTokens, output_tokens: reply.usage.outputTokens } : undefined;
  return { ok: true, text: reply.text, provider: "chatgpt", model: reply.model ?? asked, usage };
}

async function askClaude(input: AiTextInput, asked: string): Promise<AiTextResult> {
  const apiKey = await getProviderKey("ANTHROPIC_API_KEY");
  if (!apiKey) return { ok: false, failure: "not_configured", provider: "claude", model: null };
  // Text alone goes as a plain string, exactly as every caller sent it before; blocks only for a file.
  const content = input.pdfBase64 || input.images?.length
    ? [
        ...(input.pdfBase64 ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: input.pdfBase64 } }] : []),
        ...(input.images ?? []).map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } })),
        { type: "text", text: input.prompt ?? "" },
      ]
    : input.prompt ?? "";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(input.timeoutMs),
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: asked, max_tokens: input.maxTokens, system: input.system, messages: input.history ?? [{ role: "user", content }] }),
  });
  if (!res.ok) {
    const noCredit = isOutOfCredit(res.status, await res.text().catch(() => ""));
    await logError(input.scope, `Anthropic API ${res.status}${noCredit ? " — out of credit" : ""}`).catch(() => {});
    return { ok: false, failure: noCredit ? "no_credit" : "failed", provider: "claude", model: asked };
  }
  const json = await res.json();
  await recordAiUsage(json.usage, json.model);
  const text = String(json.content?.find?.((block: { type?: string }) => block.type === "text")?.text ?? "");
  return { ok: true, text, provider: "claude", model: typeof json.model === "string" ? json.model : asked, usage: json.usage };
}
