import "server-only";
import { basePrisma } from "./db";
import { putSetting } from "./settings";
import { CODEX_MODEL_KEY } from "./codex";
import { AI_CLAUDE_MODEL_KEY, AI_PROVIDER_KEY, type AiProvider } from "./aiProviderRules";

/**
 * The AI model picker's save: the provider and its model in ONE transaction (review of #1154). The provider never
 * switches without the model chosen with it — a Claude switch landing on a stale or Automatic model would bill
 * requests nobody picked. Either both are saved or neither is.
 */
export async function saveAiChoice(choice: { provider: AiProvider; model: string }): Promise<void> {
  await basePrisma.$transaction(async (tx) => {
    await putSetting(AI_PROVIDER_KEY, choice.provider, tx);
    await putSetting(choice.provider === "chatgpt" ? CODEX_MODEL_KEY : AI_CLAUDE_MODEL_KEY, choice.model, tx);
  });
}
