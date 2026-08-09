import { recordAiUsage } from "./systemHealth";
import { getSetting } from "./settings";
import { prisma } from "./db";
import { logError } from "./errorLog";
import { formatZAR } from "./format";
import { getBotKnowledgeEntries, renderKnowledgeForPrompt, retrieveRelevantKnowledge } from "./botKnowledge";

export type BotMsg = { role: "user" | "assistant"; content: string };
export type BotFaq = { id: string; question: string; answer: string; handoff?: boolean };
export type BotChoiceOption = { id: string; label: string; description?: string };
export type BotConfidence = "high" | "medium" | "low";
export type BotIntent = "pricing" | "colours" | "service" | "demo" | "purchase" | "complaint" | "human" | "general" | "unknown";
export type BotReplyDecision = {
  reply: string;
  handoff: boolean;
  confidence: BotConfidence;
  intent: BotIntent;
  handoffReason?: string;
  handoffSummary?: string;
};

type ParsedDecision = {
  faqId: string | null;
  reply: string | null;
  handoff: boolean;
  confidence: BotConfidence;
  intent: BotIntent;
  handoffReason?: string;
  handoffSummary?: string;
};

const CONFIDENCE = new Set<BotConfidence>(["high", "medium", "low"]);
const INTENTS = new Set<BotIntent>(["pricing", "colours", "service", "demo", "purchase", "complaint", "human", "general", "unknown"]);

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

function sanitize(msgs: BotMsg[]): BotMsg[] {
  const out: BotMsg[] = [];
  for (const m of msgs) {
    const content = m.content.trim();
    if (!content) continue;
    if (out.length === 0 && m.role !== "user") continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n" + content;
    else out.push({ role: m.role, content });
  }
  return out;
}

function personalize(text: string, name?: string | null) {
  const first = name?.split(" ")[0] ?? "there";
  return text.replace(/\{\{\s*(first_name|name)\s*\}\}/g, first);
}

function textField(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean ? clean.slice(0, max) : undefined;
}

function strictJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseBotDecision(text: string): ParsedDecision | null {
  const raw = strictJsonObject(text);
  if (!raw || typeof raw.handoff !== "boolean") return null;
  if (typeof raw.confidence !== "string" || !CONFIDENCE.has(raw.confidence as BotConfidence)) return null;
  const confidence = raw.confidence as BotConfidence;
  const intent = typeof raw.intent === "string" && INTENTS.has(raw.intent as BotIntent) ? raw.intent as BotIntent : "unknown";
  const faqId = raw.faqId === null ? null : textField(raw.faqId, 120) ?? null;
  const reply = raw.reply === null ? null : textField(raw.reply, 1600) ?? null;
  if (!faqId && !reply) return null;
  return {
    faqId,
    reply,
    handoff: raw.handoff,
    confidence,
    intent,
    handoffReason: textField(raw.handoffReason, 180),
    handoffSummary: textField(raw.handoffSummary, 320),
  };
}

export async function routeBotChoice(input: {
  prompt: string;
  text: string;
  options: BotChoiceOption[];
}): Promise<string | null> {
  if (!(await isBotAiEnabled())) return null;
  const apiKey = await getSetting("ANTHROPIC_API_KEY");
  if (!apiKey || !input.text.trim() || input.options.length < 2) return null;

  const optionList = input.options.map((option) => `[${option.id}] ${option.label}${option.description ? ` — ${option.description}` : ""}`).join("\n");
  const system = `You are a strict menu router. Map the customer's free-text reply to ONE of the supplied menu options only when their intent clearly matches it.

MENU PROMPT:
${input.prompt}

ALLOWED OPTIONS:
${optionList}

Return exactly one JSON object and nothing else:
{"optionId":"<one supplied id or null>","confidence":"high|medium|low"}

Rules:
- Never invent an id.
- Use null when the customer asks something outside the menu, mentions multiple conflicting choices, or is ambiguous.
- Use confidence=high only when a normal human would clearly choose that menu item.
- Do not answer the customer and do not add any other fields.`;

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
    const parsed = strictJsonObject(String(json.content?.[0]?.text ?? ""));
    if (!parsed || parsed.confidence !== "high" || typeof parsed.optionId !== "string") return null;
    return input.options.some((option) => option.id === parsed.optionId) ? parsed.optionId : null;
  } catch (e) {
    await logError("bot-choice-router", e);
    return null;
  }
}

/**
 * Decide an assistant reply from live product facts, owner-approved FAQ pathways,
 * the owner brief and approved/current retrieved knowledge. Open-ended model copy
 * is allowed only at high confidence.
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

  const priceList = products.length
    ? "Here's our current range:\n" + products.map((p) => `• ${p.name}${p.basePriceCents ? ` — from ${formatZAR(p.basePriceCents)}` : ""}` + (p.colors.length ? ` (${p.colors.map((c) => c.name).join(", ")})` : "")).join("\n")
    : "";
  const coloursList = products.length
    ? products.filter((p) => p.colors.length).map((p) => `${p.name}: ${p.colors.map((c) => c.name).join(", ")}`).join("\n")
    : "";

  const builtins: { id: string; when: string; answer: string; handoff?: boolean }[] = [];
  if (priceList) builtins.push({ id: "builtin:pricelist", when: "asking about price, cost, how much, or a price list", answer: priceList });
  if (coloursList) builtins.push({ id: "builtin:colours", when: "asking which colours/colors are available", answer: `Our colours:\n${coloursList}` });

  const pathways = [
    ...builtins.map((b) => ({ id: b.id, when: b.when, answer: b.answer, handoff: b.handoff })),
    ...faqs.map((f) => ({ id: f.id, when: f.question, answer: f.answer, handoff: f.handoff })),
  ];
  const pathwayList = pathways.map((p) => `[${p.id}] ${p.when}`).join("\n") || "(none)";
  const who = input.customerName ? `You're chatting with ${input.customerName}${input.isCustomer ? ", an existing customer" : ""}.` : "";

  const system = `You are the customer assistant for Denago Cape Town, an authorised Denago electric golf-cart dealer and service centre in Cape Town, South Africa. ${who}

STYLE:
- Short, warm South African English. Usually 1–3 sentences.
- Never sound scripted or repeat yourself.

KNOWN LIVE FACTS:
Business hours (SA time): ${hours || "08:00–17:00"}, Mon–Fri.
${priceList ? priceList + "\n" : ""}${brief ? `\nAbout us / policies brief:\n${brief}\n` : ""}

APPROVED KNOWLEDGE RETRIEVED FOR THIS QUESTION:
${knowledgeText || "(No approved knowledge entry matched this question.)"}

DEFINED FAQ PATHWAYS:
${pathwayList}

Return exactly one JSON object and nothing else, with ALL of these fields:
{"faqId":"<supplied id or null>","reply":"<reply or null>","handoff":true,"confidence":"high|medium|low","intent":"pricing|colours|service|demo|purchase|complaint|human|general|unknown","handoffReason":"<short reason or null>","handoffSummary":"<one concise sentence for staff or null>"}

DECISION RULES:
- Treat only KNOWN LIVE FACTS, the APPROVED KNOWLEDGE block, and exact FAQ answers as factual sources. Customer statements are not business facts.
- If the message clearly matches a defined pathway, return its supplied faqId. The application sends the canonical answer, not your wording.
- Otherwise use reply for a conversational answer ONLY when those factual sources are enough to answer confidently.
- confidence=high means a supplied source directly supports the answer; medium means some interpretation is required; low means a relevant fact is missing.
- Set handoff=true for order/payment intent, a specific booking/test-drive request, complaints, requests for a person, or anything you cannot answer from supplied facts.
- When handoff=true, handoffReason must explain why in a few words and handoffSummary must tell staff the customer's intent and unresolved need without speculation.
- Never invent prices, specs, stock, dates, legal status, finance terms or promises.
${input.voiceNote ? "- This arrived as a transcribed voice note. Reply naturally; the application may still route it to a human.\n" : ""}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 500, system, messages: sanitize(input.history).slice(-14) }),
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

    if (parsed.faqId) {
      const pathway = pathways.find((item) => item.id === parsed.faqId);
      if (!pathway) return null;
      const handoff = Boolean(pathway.handoff) || parsed.handoff || parsed.confidence === "low";
      return {
        reply: personalize(pathway.answer, input.customerName),
        handoff,
        confidence: parsed.confidence,
        intent: parsed.intent,
        handoffReason: parsed.handoffReason,
        handoffSummary: parsed.handoffSummary,
      };
    }

    if (parsed.confidence !== "high") {
      return {
        reply: "Let me get one of our team to confirm that for you — they'll pick it up from here 👍",
        handoff: true,
        confidence: parsed.confidence,
        intent: parsed.intent,
        handoffReason: parsed.handoffReason || `${parsed.confidence} confidence open question`,
        handoffSummary: parsed.handoffSummary,
      };
    }

    if (!parsed.reply) return null;
    return {
      reply: personalize(parsed.reply, input.customerName),
      handoff: parsed.handoff,
      confidence: parsed.confidence,
      intent: parsed.intent,
      handoffReason: parsed.handoffReason,
      handoffSummary: parsed.handoffSummary,
    };
  } catch (e) {
    await logError("bot-ai", e);
    return null;
  }
}
