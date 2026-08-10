import "server-only";
import { getSetting } from "./settings";

export type BotKnowledgeStatus = "draft" | "approved" | "expired";
export type BotKnowledgeEntry = {
  id: string;
  title: string;
  content: string;
  status: BotKnowledgeStatus;
  sourceType: "manual" | "library";
  sourceDocumentId?: string;
  sourceLabel?: string;
  validFrom?: string;
  validUntil?: string;
  approvedAt?: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
};

const STATUSES = new Set<BotKnowledgeStatus>(["draft", "approved", "expired"]);
const SOURCE_TYPES = new Set<BotKnowledgeEntry["sourceType"]>(["manual", "library"]);
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "your", "you", "our", "are", "can", "how", "what", "when", "where", "which",
  "about", "have", "has", "does", "will", "would", "could", "please", "want", "need", "tell", "there", "their", "they", "them", "into", "than",
]);

function cleanString(value: unknown, max = 5000): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean ? clean.slice(0, max) : undefined;
}

function isoDate(value: unknown): string | undefined {
  const raw = cleanString(value, 40);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function parseBotKnowledge(raw: string | null | undefined): BotKnowledgeEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: BotKnowledgeEntry[] = [];
    for (const value of parsed) {
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      const id = cleanString(item.id, 120);
      const title = cleanString(item.title, 180);
      const content = cleanString(item.content, 5000);
      const status = typeof item.status === "string" && STATUSES.has(item.status as BotKnowledgeStatus)
        ? item.status as BotKnowledgeStatus
        : "draft";
      const sourceType = typeof item.sourceType === "string" && SOURCE_TYPES.has(item.sourceType as BotKnowledgeEntry["sourceType"])
        ? item.sourceType as BotKnowledgeEntry["sourceType"]
        : "manual";
      const createdAt = isoDate(item.createdAt) ?? new Date(0).toISOString();
      const updatedAt = isoDate(item.updatedAt) ?? createdAt;
      if (!id || !title || !content) continue;
      out.push({
        id,
        title,
        content,
        status,
        sourceType,
        sourceDocumentId: cleanString(item.sourceDocumentId, 120),
        sourceLabel: cleanString(item.sourceLabel, 220),
        validFrom: isoDate(item.validFrom),
        validUntil: isoDate(item.validUntil),
        approvedAt: isoDate(item.approvedAt),
        approvedBy: cleanString(item.approvedBy, 180),
        createdAt,
        updatedAt,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function getBotKnowledgeEntries(): Promise<BotKnowledgeEntry[]> {
  return parseBotKnowledge(await getSetting("BOT_KNOWLEDGE_ENTRIES"));
}

export function knowledgeIsCurrent(entry: BotKnowledgeEntry, now = new Date()): boolean {
  if (entry.status !== "approved") return false;
  if (entry.validFrom && new Date(entry.validFrom) > now) return false;
  if (entry.validUntil && new Date(entry.validUntil) < now) return false;
  return true;
}

function terms(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase("en-ZA")
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOP.has(token)),
  );
}

function score(entry: BotKnowledgeEntry, queryTerms: Set<string>): number {
  const title = terms(entry.title);
  const body = terms(entry.content);
  let total = 0;
  for (const token of queryTerms) {
    if (title.has(token)) total += 5;
    if (body.has(token)) total += 2;
  }
  return total;
}

/**
 * Small deterministic retriever for curated knowledge. We intentionally do not
 * send the whole knowledge base to the model and do not need an embedding vendor:
 * only approved/current snippets that overlap the customer's actual question are
 * included. This keeps provenance obvious and makes expiry enforceable.
 */
export function retrieveRelevantKnowledge(
  entries: BotKnowledgeEntry[],
  query: string,
  now = new Date(),
  limit = 6,
): BotKnowledgeEntry[] {
  const queryTerms = terms(query);
  if (queryTerms.size === 0) return [];
  return entries
    .filter((entry) => knowledgeIsCurrent(entry, now))
    .map((entry) => ({ entry, score: score(entry, queryTerms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
    .slice(0, limit)
    .map((item) => item.entry);
}

export function renderKnowledgeForPrompt(entries: BotKnowledgeEntry[], maxChars = 12_000): string {
  let out = "";
  for (const entry of entries) {
    const source = entry.sourceLabel ? ` · source: ${entry.sourceLabel}` : "";
    const block = `[${entry.title}${source}]\n${entry.content}\n`;
    if (out.length + block.length > maxChars) break;
    out += block;
  }
  return out.trim();
}
