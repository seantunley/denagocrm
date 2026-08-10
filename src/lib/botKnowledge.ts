import "server-only";
import { getSetting } from "./settings";
import { parseBotKnowledge, type BotKnowledgeEntry } from "./botKnowledgeRetrieval";

/**
 * Settings-backed access to owner-curated chatbot knowledge.
 *
 * The parsing/validity/retrieval rules live in `botKnowledgeRetrieval.ts`, which
 * imports nothing, so a unit test can execute them. This module stays
 * `server-only` because it reads tenant settings.
 */
export * from "./botKnowledgeRetrieval";

export async function getBotKnowledgeEntries(): Promise<BotKnowledgeEntry[]> {
  return parseBotKnowledge(await getSetting("BOT_KNOWLEDGE_ENTRIES"));
}
