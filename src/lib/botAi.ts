import { recordAiUsage } from "./systemHealth";
import { getSetting } from "./settings";
import { prisma } from "./db";
import { logError } from "./errorLog";
import { formatZAR } from "./format";
import { getBotKnowledgeEntries, renderKnowledgeForPrompt, retrieveRelevantKnowledge } from "./botKnowledge";
import { renderBotProductFacts } from "./botProductFacts";
import {
  applyBotDecision,
  parseBotDecision,
  parseChoiceRoute,
  sanitizeBotHistory,
  type BotChoiceOption,
  type BotFaq,
  type BotMsg,
  type BotReplyDecision,
} from "./botDecision";
import { botPathways, buildBotSystemPrompt, buildChoiceRouterPrompt } from "./botPrompt";

// The decision contract itself lives in botDecision.ts so it can be unit tested
// without a model call; re-exported here so channel adapters keep one import.
export type {
  BotMsg,
  BotFaq,
  BotChoiceOption,
  BotConfidence,
  BotIntent,
  BotPathway,
  BotReplyDecision,
  ParsedBotDecision,
} from "./botDecision";
export { parseBotDecision } from "./botDecision";

export async function getBotFaqs(): Promise<BotFaq[]> {
  const raw = await getSetting("BOT_FAQS");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function isBotAiEnabled(): Promise<boolean> {
  return (await getSetting("BOT_AI_ENABLED")) === "true" && Boolean(await getSetting("ANTHROPIC_API_KEY"));
}

export async function routeBotChoice(input: {
  prompt: string;
  text: string;
  options: BotChoiceOption[];
}): Promise<string | null> {
  if (!(await isBotAiEnabled())) return null;
  const apiKey = await getSetting("ANTHROPIC_API_KEY");
  if (!apiKey || !input.text.trim() || input.options.length < 2) return null;

  const system = buildChoiceRouterPrompt({ prompt: input.prompt, options: input.options });

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 80, system, messages: [{ role: "user", content: input.text.trim() }] }),
    });
    if (!res.ok) {
      await logError("bot-choice-router", `Anthropic ${res.status}`, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const json = await res.json();
    void recordAiUsage(json.usage);
    return parseChoiceRoute(String(json.content?.[0]?.text ?? ""), input.options);
  } catch (e) {
    await logError("bot-choice-router", e);
    return null;
  }
}

/**
 * Decide an assistant reply from authoritative CRM product fields, owner-approved
 * FAQ pathways, the owner brief and approved/current retrieved knowledge.
 */
export async function generateBotReply(input: {
  history: BotMsg[];
  customerName?: string | null;
  isCustomer: boolean;
  voiceNote?: boolean;
}): Promise<BotReplyDecision | null> {
  const apiKey = await getSetting("ANTHROPIC_API_KEY");
  if (!apiKey) return null;

  const latestQuestion = [...input.history].reverse().find((message) => message.role === "user")?.content ?? "";
  const [brief, hours, products, faqs, knowledgeEntries] = await Promise.all([
    getSetting("BOT_AI_BRIEF"),
    getSetting("BOT_HOURS"),
    prisma.product.findMany({ where: { active: true }, include: { colors: true }, orderBy: { name: "asc" } }),
    getBotFaqs(),
    getBotKnowledgeEntries(),
  ]);
  const relevantKnowledge = retrieveRelevantKnowledge(knowledgeEntries, latestQuestion);
  const knowledgeText = renderKnowledgeForPrompt(relevantKnowledge);
  const productFacts = renderBotProductFacts(products);

  const priceList = products.length
    ? "Here's our current range:\n" + products.map((p) => `• ${p.name}${p.basePriceCents ? ` — from ${formatZAR(p.basePriceCents)}` : ""}` + (p.colors.length ? ` (${p.colors.map((c) => c.name).join(", ")})` : "")).join("\n")
    : "";
  const coloursList = products.length
    ? products.filter((p) => p.colors.length).map((p) => `${p.name}: ${p.colors.map((c) => c.name).join(", ")}`).join("\n")
    : "";

  const pathways = botPathways({ priceList, coloursList, faqs });
  const system = buildBotSystemPrompt({
    hours,
    brief,
    productFacts,
    knowledgeText,
    pathways,
    customerName: input.customerName,
    isCustomer: input.isCustomer,
    voiceNote: input.voiceNote,
  });

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 500, system, messages: sanitizeBotHistory(input.history).slice(-14) }),
    });
    if (!res.ok) {
      await logError("bot-ai", `Anthropic ${res.status}`, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const json = await res.json();
    void recordAiUsage(json.usage);
    const parsed = parseBotDecision(String(json.content?.[0]?.text ?? ""));
    if (!parsed) {
      await logError("bot-ai", "Assistant returned a response outside the decision contract").catch(() => {});
      return null;
    }
    return applyBotDecision({ parsed, pathways, customerName: input.customerName });
  } catch (e) {
    await logError("bot-ai", e);
    return null;
  }
}
