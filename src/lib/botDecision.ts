/**
 * The chatbot's answering boundary, stated as pure functions.
 *
 * Everything here used to live inside `generateBotReply`/`routeBotChoice` in
 * `botAi.ts`, wrapped around a `fetch` to the model. That made the rules that
 * matter most — what the application will ACCEPT from the model — reachable only
 * by calling a paid API, so the existing suite could only assert them with
 * regexes over the source. This module imports nothing, so an evaluation corpus
 * can execute the boundary against a table of model outputs.
 *
 * The rules, in one place:
 * - The model's output must be one strict JSON object. Prose, code fences and
 *   JSON-looking fragments inside text are rejected, not fished out.
 * - A model-authored reply is only sent at confidence=high. Medium and low go to
 *   a person.
 * - A canonical FAQ answer may be sent at medium confidence, because the
 *   application sends the OWNER'S wording, not the model's — but the id must be
 *   one the application supplied.
 * - A menu route must be confidence=high AND one of the supplied option ids.
 */

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

/** A pathway is an owner-authored answer the application sends verbatim. */
export type BotPathway = { id: string; when: string; answer: string; handoff?: boolean };

export type ParsedBotDecision = {
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

/** Sent instead of a guess whenever the model is not confident. */
export const LOW_CONFIDENCE_REPLY = "Let me get one of our team to confirm that for you — they'll pick it up from here 👍";

export function sanitizeBotHistory(msgs: BotMsg[]): BotMsg[] {
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

export function personalize(text: string, name?: string | null) {
  const first = name?.split(" ")[0] ?? "there";
  return text.replace(/\{\{\s*(first_name|name)\s*\}\}/g, first);
}

function textField(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean ? clean.slice(0, max) : undefined;
}

/**
 * The whole response must parse as one JSON object. Deliberately not a regex
 * scan: fishing a `{...}` out of prose or a code fence is how injected text in a
 * transcript gets promoted into a decision.
 */
export function strictJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseBotDecision(text: string): ParsedBotDecision | null {
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

/**
 * Turn a parsed model decision into what the application will actually send.
 * Returns null when the decision cannot be honoured at all (unknown pathway id,
 * or a high-confidence answer with no text), which the callers treat as "AI
 * unavailable" and fall back to a human.
 */
export function applyBotDecision(input: {
  parsed: ParsedBotDecision;
  pathways: BotPathway[];
  customerName?: string | null;
}): BotReplyDecision | null {
  const { parsed, pathways } = input;

  // Canonical pathways may be used at medium confidence because the
  // application sends their approved answer instead of model-authored copy.
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
      reply: LOW_CONFIDENCE_REPLY,
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
}

/**
 * Accept a menu route only when the router returned strict JSON, said high
 * confidence, and named an id the application supplied. Anything else falls back
 * to the deterministic matcher / re-prompt in the flow engine.
 */
export function parseChoiceRoute(text: string, options: BotChoiceOption[]): string | null {
  const parsed = strictJsonObject(text);
  if (!parsed || parsed.confidence !== "high" || typeof parsed.optionId !== "string") return null;
  return options.some((option) => option.id === parsed.optionId) ? parsed.optionId : null;
}
