import "server-only";

import { prisma } from "../db";
import { ATTENTION_WEIGHTS, type AttentionSignal } from "./score";

/**
 * The Attention Centre — the IMPURE half. Five queries, never five per lead.
 *
 * ── THE GUARDED CLIENT, ALWAYS ──────────────────────────────────────────────
 *
 * Every read here goes through `prisma`, which carries the tenant guard, never
 * `basePrisma`. Worth stating loudly because the counter-example lives in this
 * same feature area: every SalesPipeline path used the bypass client, which is
 * how making a pipeline default in one workspace cleared the default in every
 * other one. A list that tells someone what to work on next must not be able to
 * name another tenant's deals.
 *
 * ── NO N+1, AND NO UNBOUNDED `IN` ───────────────────────────────────────────
 *
 * One query per signal family over the already-scoped id set, then an in-memory
 * join. The ids arrive permission-scoped from `getAccessibleLeadIds`, whose
 * documented contract the caller honours: `null` is unrestricted and `[]` must
 * become an impossible match rather than an absent filter.
 *
 * The id list is CHUNKED. A few hundred open leads is the realistic working set,
 * but `/leads/page.tsx` builds an unbounded `Prisma.join(leadIds)` today and that
 * is fine at a few hundred and is not fine at ten thousand — this is the same
 * shape, so it is bounded from the start rather than after the incident.
 */

/** Postgres tolerates far more, but a bounded list keeps plans stable. */
const ID_CHUNK = 1000;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A quote is "expiring" this many days out. */
export const QUOTE_EXPIRY_WINDOW_DAYS = 7;
/** Silence is only a signal after this long. */
export const UNANSWERED_INBOUND_HOURS = 4;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** "in 3 days" / "tomorrow" / "today" — for a sentence, not a table cell. */
function inDays(target: Date, now: Date): string {
  const days = Math.round((target.getTime() - now.getTime()) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

function agoHours(from: Date, now: Date): string {
  const hours = Math.floor((now.getTime() - from.getTime()) / HOUR_MS);
  if (hours < 24) return `${Math.max(1, hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

function add(map: Map<string, AttentionSignal[]>, leadId: string, signal: AttentionSignal): void {
  const existing = map.get(leadId);
  if (existing) existing.push(signal);
  else map.set(leadId, [signal]);
}

export type AttentionStage = { staleAfterDays: number | null };

/**
 * Every signal for a set of leads, keyed by lead id.
 *
 * `stages` is passed in rather than fetched because the caller already has it —
 * the board renders from it and the page needs it for the same reason — and
 * re-reading it here would be a query per request for data already in hand.
 */
export async function collectAttentionSignals(input: {
  /** ALREADY permission-scoped. This function does not re-derive access. */
  leadIds: string[];
  now: Date;
  /** stageId → its threshold, for `stage_age`. */
  stages: Map<string, AttentionStage>;
  /** stageId per lead, so `stage_age` can find the right threshold. */
  stageByLead: Map<string, string>;
  /** When each lead entered its current stage. */
  stageEnteredByLead: Map<string, Date>;
}): Promise<Map<string, AttentionSignal[]>> {
  const signals = new Map<string, AttentionSignal[]>();
  const { leadIds, now, stages, stageByLead, stageEnteredByLead } = input;
  if (leadIds.length === 0) return signals;

  const batches = chunk(leadIds, ID_CHUNK);

  // ── stage_age ─────────────────────────────────────────────────────────────
  // Free: computed from data the caller already holds, no query at all. Reuses
  // the stage's own `staleAfterDays` rather than inventing a second threshold —
  // "stale" on the board and "old" here must mean the same number, or a rule
  // written from one misfires on the other.
  for (const leadId of leadIds) {
    const stageId = stageByLead.get(leadId);
    const enteredAt = stageEnteredByLead.get(leadId);
    const threshold = stageId ? stages.get(stageId)?.staleAfterDays ?? null : null;
    if (!enteredAt || threshold == null || threshold <= 0) continue;
    const days = Math.floor((now.getTime() - enteredAt.getTime()) / DAY_MS);
    if (days < threshold) continue;
    add(signals, leadId, {
      kind: "stage_age",
      weight: ATTENTION_WEIGHTS.stage_age,
      detail: `In this stage ${days} days — past the ${threshold}-day mark`,
      since: enteredAt.toISOString(),
    });
  }

  // ── overdue_task ──────────────────────────────────────────────────────────
  // The OLDEST overdue activity per lead, so the sentence names the one that has
  // been waiting longest rather than an arbitrary row.
  for (const batch of batches) {
    const overdue = await prisma.activity.findMany({
      where: { leadId: { in: batch }, status: "planned", dueDate: { lt: now } },
      // `summary` is Activity's name field — there is no `title` on this model.
      select: { leadId: true, summary: true, dueDate: true },
      orderBy: { dueDate: "asc" },
    });
    const seen = new Set<string>();
    for (const row of overdue) {
      if (!row.leadId || seen.has(row.leadId) || !row.dueDate) continue;
      seen.add(row.leadId);
      add(signals, row.leadId, {
        kind: "overdue_task",
        weight: ATTENTION_WEIGHTS.overdue_task,
        detail: `“${row.summary}” was due ${agoHours(row.dueDate, now)} ago`,
        since: row.dueDate.toISOString(),
      });
    }
  }

  // ── no_next_step ──────────────────────────────────────────────────────────
  // The complement of "has a planned activity". Asked as one grouped query over
  // the whole batch rather than a count per lead.
  for (const batch of batches) {
    const planned = await prisma.activity.groupBy({
      by: ["leadId"],
      where: { leadId: { in: batch }, status: "planned" },
      _count: { _all: true },
    });
    const hasPlanned = new Set(planned.map((row) => row.leadId).filter(Boolean) as string[]);
    for (const leadId of batch) {
      if (hasPlanned.has(leadId)) continue;
      add(signals, leadId, {
        kind: "no_next_step",
        weight: ATTENTION_WEIGHTS.no_next_step,
        detail: "No next step planned",
      });
    }
  }

  // ── quote_expiring ────────────────────────────────────────────────────────
  // Sent, unsigned, not superseded, and inside the window. `signedAt` and
  // `supersededAt` are both checked because a signed quote is done and a
  // superseded one has been replaced — chasing either is noise, and noise is what
  // stops this list being read.
  const horizon = new Date(now.getTime() + QUOTE_EXPIRY_WINDOW_DAYS * DAY_MS);
  for (const batch of batches) {
    const quotes = await prisma.quote.findMany({
      where: {
        leadId: { in: batch },
        status: "sent",
        deletedAt: null,
        signedAt: null,
        supersededAt: null,
        validUntil: { not: null, lte: horizon },
      },
      select: { leadId: true, number: true, validUntil: true },
      orderBy: { validUntil: "asc" },
    });
    const seen = new Set<string>();
    for (const row of quotes) {
      if (!row.leadId || seen.has(row.leadId) || !row.validUntil) continue;
      seen.add(row.leadId);
      // Already past `validUntil` reads as "expired", not "expires today" — the
      // window catches both and the sentence has to tell them apart.
      const expired = row.validUntil.getTime() < now.getTime();
      add(signals, row.leadId, {
        kind: "quote_expiring",
        weight: ATTENTION_WEIGHTS.quote_expiring,
        detail: expired
          ? `Quote Q-${row.number} expired ${agoHours(row.validUntil, now)} ago`
          : `Quote Q-${row.number} expires ${inDays(row.validUntil, now)}`,
        since: row.validUntil.toISOString(),
      });
    }
  }

  // ── unanswered_inbound ────────────────────────────────────────────────────
  // The cheapest strong signal in the schema, and the heaviest weight: somebody
  // has written to us and nobody has replied. `Conversation.lastDirection` and
  // `lastMessageAt` are both indexed already.
  const quietBefore = new Date(now.getTime() - UNANSWERED_INBOUND_HOURS * HOUR_MS);
  for (const batch of batches) {
    const waiting = await prisma.conversation.findMany({
      where: { leadId: { in: batch }, lastDirection: "inbound", lastMessageAt: { lt: quietBefore } },
      select: { leadId: true, lastMessageAt: true },
      orderBy: { lastMessageAt: "asc" },
    });
    const seen = new Set<string>();
    for (const row of waiting) {
      if (!row.leadId || seen.has(row.leadId)) continue;
      seen.add(row.leadId);
      add(signals, row.leadId, {
        kind: "unanswered_inbound",
        weight: ATTENTION_WEIGHTS.unanswered_inbound,
        detail: `Customer wrote ${agoHours(row.lastMessageAt, now)} ago and has had no reply`,
        since: row.lastMessageAt.toISOString(),
      });
    }
  }

  return signals;
}
