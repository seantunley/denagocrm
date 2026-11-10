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
export type AiTextResult =
  | { ok: true; text: string; provider: AiProvider; usage?: AiUsage }
  | { ok: false; failure: "not_configured" | "no_credit" | "timeout" | "failed"; provider: AiProvider | null };

/**
 * One text answer from the workspace's AI — the chatbot, invoice reading, the ✨ check and the other short helpers.
 * Never throws. Logs the status only: a provider's error body can quote what was sent.
 */
export async function aiText(
  input: {
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
  },
  /** Already decided by the caller (it needed to know to prepare the input). */
  chosen?: AiProvider | null,
): Promise<AiTextResult> {
  const provider = chosen === undefined ? await aiProvider() : chosen;
  if (!provider) return { ok: false, failure: "not_configured", provider: null };

  if (provider === "chatgpt") {
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
      return { ok: false, failure: reply.transient ? "timeout" : "failed", provider };
    }
    return { ok: true, text: reply.text, provider };
  }

  const apiKey = await getProviderKey("ANTHROPIC_API_KEY");
  if (!apiKey) return { ok: false, failure: "not_configured", provider };
  const content = [
    ...(input.pdfBase64 ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: input.pdfBase64 } }] : []),
    ...(input.images ?? []).map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } })),
    { type: "text", text: input.prompt ?? "" },
  ];
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(input.timeoutMs),
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: input.claudeModel ?? "claude-haiku-4-5",
        max_tokens: input.maxTokens,
        system: input.system,
        messages: input.history ?? [{ role: "user", content }],
      }),
    });
    if (!res.ok) {
      const noCredit = isOutOfCredit(res.status, await res.text().catch(() => ""));
      await logError(input.scope, `Anthropic API ${res.status}${noCredit ? " — out of credit" : ""}`).catch(() => {});
      return { ok: false, failure: noCredit ? "no_credit" : "failed", provider };
    }
    const json = await res.json();
    await recordAiUsage(json.usage, json.model);
    const text = String(json.content?.find?.((block: { type?: string }) => block.type === "text")?.text ?? "");
    return { ok: true, text, provider, usage: json.usage };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    await logError(input.scope, error instanceof Error ? error.name : "error").catch(() => {});
    return { ok: false, failure: timedOut ? "timeout" : "failed", provider };
  }
}
