import "server-only";
import { getProviderKey } from "./settings";
import { codexModelList } from "./codex";
import { modelChoices } from "./codexProtocol";
import { CLAUDE_MODEL_CHOICES } from "./aiProviderRules";
import { hasListedPrice } from "./usageMeters";
import { chatGptChoicesFrom, claudeChoicesFrom, type ModelChoice } from "./aiModelLists";

/**
 * The models each provider offers this workspace, asked of the provider (lib/aiModelLists). `live` says whether the
 * provider answered; when it didn't, the built-in list stands in and the page says so.
 */
export type ModelCatalog = { chatgpt: ModelChoice[]; claude: ModelChoice[]; chatgptLive: boolean; claudeLive: boolean };

export async function aiModelCatalog(current: { chatgpt: string; claude: string }): Promise<ModelCatalog> {
  const [chatgpt, claude] = await Promise.all([
    codexModelList().then((models) => chatGptChoicesFrom(models, current.chatgpt)).catch(() => null),
    anthropicModels().then((data) => claudeChoicesFrom(data, current.claude)).catch(() => null),
  ]);
  const builtInClaude: ModelChoice[] = CLAUDE_MODEL_CHOICES.slice(1);
  if (current.claude && !builtInClaude.some((choice) => choice.id === current.claude)) {
    // The saved model, always shown — disabled when it has no listed price (it isn't used: claudeModelFor).
    builtInClaude.push(hasListedPrice(current.claude) ? { id: current.claude, label: current.claude } : { id: current.claude, label: `${current.claude} — price pending`, disabled: true });
  }
  return {
    chatgpt: chatgpt ?? modelChoices(current.chatgpt),
    claude: [CLAUDE_MODEL_CHOICES[0], ...(claude ?? builtInClaude)],
    chatgptLive: Boolean(chatgpt),
    claudeLive: Boolean(claude),
  };
}

/** Anthropic's GET /v1/models for this workspace's key — `data`, or null without a key or an answer. */
async function anthropicModels(): Promise<unknown> {
  const apiKey = await getProviderKey("ANTHROPIC_API_KEY");
  if (!apiKey) return null;
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(5000),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return ((await res.json()) as { data?: unknown }).data ?? null;
}
