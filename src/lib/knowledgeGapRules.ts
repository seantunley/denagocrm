/**
 * AI KNOWLEDGE IMPROVEMENT — the pure half (the database half is knowledgeGaps.ts).
 *
 * When the chatbot can't answer a customer's question from approved knowledge (no FAQ matches and it isn't sure), it
 * hands the chat to a person. Those questions are a list of what the knowledge base is missing: grouped by their words,
 * counted, and offered to the owner with "Draft an answer" — DAX drafts a knowledge entry, which stays a DRAFT until the
 * owner approves it, like any other entry.
 */

/** Hand-overs that are about missing knowledge — not a sale, a booking, a complaint or someone asking for a person. */
export const KNOWLEDGE_INTENTS = new Set(["pricing", "colours", "service", "general", "unknown"]);

/** Did the chatbot fail for want of knowledge? Only when it matched no FAQ, wasn't sure, and the intent is a question. */
export function isKnowledgeGap(decision: { faqId: string | null; confidence: string; intent: string }): boolean {
  return !decision.faqId && decision.confidence !== "high" && KNOWLEDGE_INTENTS.has(decision.intent);
}

const STOP = new Set([
  "the", "and", "you", "your", "for", "are", "can", "what", "how", "does", "did", "have", "has", "with", "that", "this",
  "there", "any", "about", "will", "would", "could", "please", "hi", "hello", "thanks", "thank", "is", "do", "a", "an",
  "of", "to", "in", "on", "it", "me", "my", "we", "our", "i", "be", "or", "if", "at", "from", "just", "want", "need", "know",
]);

/** Phone numbers, emails and long digit runs out — the question is kept, not who asked it. */
export function scrubQuestion(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/(\+?\d[\d\s-]{6,}\d)/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/** Questions with the same significant words are one gap ("Do you deliver to Joburg?" ≈ "deliver joburg?"). */
export function gapKey(question: string): string {
  const words = scrubQuestion(question)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ies|es|s)$/u, ""));
  return [...new Set(words)].sort().slice(0, 8).join(" ");
}

/** Up to this many recent wordings are kept per gap, to show the owner and to draft from. */
export const GAP_EXAMPLES = 5;

/** The newest wording first, no repeats, at most GAP_EXAMPLES. */
export function withExample(examples: readonly string[], question: string): string[] {
  return [question, ...examples.filter((e) => e !== question)].slice(0, GAP_EXAMPLES);
}

export const DRAFT_INSTRUCTIONS = [
  "You draft ONE knowledge-base entry for a business's customer chatbot, from questions customers asked that the chatbot couldn't answer.",
  "Use ONLY the facts given (the business's details, its products, its existing approved knowledge, and what its staff replied when these questions came in). Never invent prices, dates, stock, warranty or finance terms, legal status or promises.",
  "Where a fact the answer needs is not given, write [CHECK: what the owner must fill in] in its place — the owner reviews this draft before the chatbot may use it.",
  'Reply with JSON only: {"title":"<short title, e.g. Delivery areas>","content":"<the answer, 1–6 sentences, as the chatbot may state it>","check":"<one line: what the owner should verify>"}',
].join("\n");

/** The model's draft → title and content, or null. Bounded to what the knowledge form accepts. */
export function parseDraft(text: string): { title: string; content: string; check: string | null } | null {
  try {
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>;
    const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 180) : "";
    const content = typeof parsed.content === "string" ? parsed.content.trim().slice(0, 5000) : "";
    if (!title || !content) return null;
    const check = typeof parsed.check === "string" && parsed.check.trim() ? parsed.check.trim().slice(0, 300) : null;
    return { title, content, check };
  } catch {
    return null;
  }
}
