import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { actingTenantId } from "./actingTenant";
import { currentTenantScope } from "./tenantScope";

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

type KnowledgeRow = {
  id: string;
  title: string;
  content: string;
  status: string;
  sourceType: string;
  sourceDocumentId: string | null;
  sourceLabel: string | null;
  validFrom: Date | null;
  validUntil: Date | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type RankedKnowledgeRow = KnowledgeRow & { ftsRank: number };

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "your", "you", "our", "are", "can", "how", "what", "when", "where", "which",
  "about", "have", "has", "does", "will", "would", "could", "please", "want", "need", "tell", "there", "their", "they", "them", "into", "than",
]);

const iso = (value: Date | null): string | undefined => value?.toISOString();

function toEntry(row: KnowledgeRow): BotKnowledgeEntry {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    status: row.status as BotKnowledgeStatus,
    sourceType: row.sourceType as BotKnowledgeEntry["sourceType"],
    sourceDocumentId: row.sourceDocumentId ?? undefined,
    sourceLabel: row.sourceLabel ?? undefined,
    validFrom: iso(row.validFrom),
    validUntil: iso(row.validUntil),
    approvedAt: iso(row.approvedAt),
    approvedBy: row.approvedBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Resolve a staff or live-channel read without ever using an unqualified table scan. */
async function knowledgeTenantId(): Promise<string> {
  const ambient = currentTenantScope()?.tenantId;
  if (ambient) return ambient;
  return actingTenantId();
}

export async function getBotKnowledgeEntries(): Promise<BotKnowledgeEntry[]> {
  const tenantId = await knowledgeTenantId();
  const rows = await basePrisma.botKnowledgeEntry.findMany({
    where: { tenantId },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });
  return rows.map(toEntry);
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

function normalized(text: string): string {
  return text.toLocaleLowerCase("en-ZA").replace(/[^a-z0-9]+/g, " ").trim();
}

function score(entry: BotKnowledgeEntry, queryTerms: Set<string>, queryPhrase: string, ftsRank = 0): number {
  const title = terms(entry.title);
  const body = terms(entry.content);
  const entryTerms = [...title, ...body];
  let total = ftsRank * 20;
  let matched = 0;
  for (const token of queryTerms) {
    let hit = false;
    if (title.has(token)) { total += 6; hit = true; }
    if (body.has(token)) { total += 2; hit = true; }
    if (!hit && entryTerms.some((candidate) => candidate.startsWith(token) || token.startsWith(candidate))) {
      total += 0.75;
      hit = true;
    }
    if (hit) matched += 1;
  }
  if (queryPhrase.length >= 5) {
    if (normalized(entry.title).includes(queryPhrase)) total += 18;
    else if (normalized(entry.content).includes(queryPhrase)) total += 10;
  }
  return total + (matched / Math.max(queryTerms.size, 1)) * 4;
}

/** Combine DB full-text rank with deterministic title/body, phrase and prefix overlap. */
export function retrieveRelevantKnowledge(
  entries: BotKnowledgeEntry[],
  query: string,
  now = new Date(),
  limit = 6,
  ftsRanks: ReadonlyMap<string, number> = new Map(),
): BotKnowledgeEntry[] {
  const queryTerms = terms(query);
  if (queryTerms.size === 0) return [];
  const queryPhrase = normalized(query);
  return entries
    .filter((entry) => knowledgeIsCurrent(entry, now))
    .map((entry) => ({ entry, score: score(entry, queryTerms, queryPhrase, ftsRanks.get(entry.id) ?? 0) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt) || a.entry.id.localeCompare(b.entry.id))
    .slice(0, limit)
    .map((item) => item.entry);
}

/**
 * Tenant-scoped hybrid retrieval. The GIN-backed full-text leg contributes the
 * strongest candidates; a small recent leg preserves phrase/prefix matching for
 * terminology PostgreSQL tokenisation does not recognise.
 */
export async function searchBotKnowledge(query: string, now = new Date(), limit = 6): Promise<BotKnowledgeEntry[]> {
  const queryTerms = [...terms(query)].slice(0, 20);
  if (!queryTerms.length) return [];
  const tenantId = await knowledgeTenantId();
  const tsQuery = queryTerms.join(" | ");
  const rows = await basePrisma.$queryRaw<RankedKnowledgeRow[]>(Prisma.sql`
    WITH eligible AS (
      SELECT "id", "title", "content", "status", "sourceType", "sourceDocumentId", "sourceLabel",
             "validFrom", "validUntil", "approvedAt", "approvedBy", "createdAt", "updatedAt",
             to_tsvector('simple', "title" || ' ' || "content") AS document
        FROM "BotKnowledgeEntry"
       WHERE "tenantId" = ${tenantId}
         AND "status" = 'approved'
         AND ("validFrom" IS NULL OR "validFrom" <= ${now})
         AND ("validUntil" IS NULL OR "validUntil" >= ${now})
    ), candidates AS (
      SELECT *, ts_rank_cd(document, to_tsquery('simple', ${tsQuery}))::double precision AS "ftsRank"
        FROM eligible
       WHERE document @@ to_tsquery('simple', ${tsQuery})
       ORDER BY "ftsRank" DESC, "updatedAt" DESC
       LIMIT 80
    ), recent AS (
      SELECT *, 0::double precision AS "ftsRank"
        FROM eligible
       ORDER BY "updatedAt" DESC
       LIMIT 40
    )
    SELECT DISTINCT ON ("id")
           "id", "title", "content", "status", "sourceType", "sourceDocumentId", "sourceLabel",
           "validFrom", "validUntil", "approvedAt", "approvedBy", "createdAt", "updatedAt", "ftsRank"
      FROM (SELECT * FROM candidates UNION ALL SELECT * FROM recent) combined
     ORDER BY "id", "ftsRank" DESC
  `);
  const ranks = new Map(rows.map((row) => [row.id, Number(row.ftsRank) || 0]));
  return retrieveRelevantKnowledge(rows.map(toEntry), query, now, limit, ranks);
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
