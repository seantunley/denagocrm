import "server-only";

import { prisma } from "./db";
import type { StageGateFacts } from "./stageGate";

/**
 * Stage gates — the FACTS half. The impure counterpart to `stageGate.ts`.
 *
 * This is the same seam journeys already use: `journeyContext.ts` imports prisma
 * and builds a plain record; `journeyTypes.ts` imports nothing and evaluates
 * against it. Keeping the split means the rule engine is testable without a
 * database, and the board can import the rules without dragging server-only code
 * into the browser bundle.
 *
 * ── THE GUARDED CLIENT, NOT basePrisma ──────────────────────────────────────
 *
 * Every read here goes through `prisma`, which carries the tenant guard.
 * `basePrisma` is the documented RLS BYPASS, and this feature's own neighbourhood
 * is the cautionary tale: every SalesPipeline path used `basePrisma`, which is
 * how making a pipeline default in one workspace cleared the default in every
 * other one. A gate decides whether a deal may move; deciding it from another
 * tenant's quotes would be worse than any read leak.
 *
 * The lead id still arrives from a client, so it is never trusted on its own —
 * `moveLead` has already put it through `requireLeadAccess` and `getLeadPipeline`
 * before this runs. The guard here is the second boundary, not the first.
 */

/** A day in milliseconds, for the one derived number the facts carry. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build the fact snapshot for ONE lead, fresh.
 *
 * `moveLead` calls this per move and never reads a fact from the request. That
 * is the entire integrity story of the two-sided check: the board's facts are a
 * render snapshot used to grey a column, and a snapshot goes stale the moment
 * someone deletes a quote in another tab. The client's copy is a rendering
 * input; this is the authority.
 *
 * Six reads, all indexed and all keyed on one lead. This runs on a drag, so it
 * is deliberately not a per-board loader — the board's own bulk version can come
 * with the Attention Centre, which already needs batched aggregates.
 */
export async function stageGateFactsForLead(
  leadId: string,
  now: Date = new Date(),
): Promise<StageGateFacts | null> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      valueCents: true,
      assignedToId: true,
      productId: true,
      email: true,
      phone: true,
      source: true,
      contactId: true,
      stageEnteredAt: true,
      contact: { select: { email: true, phone: true } },
    },
  });
  // Not our workspace's lead, or gone. The caller refuses the move rather than
  // gating on invented facts — an empty snapshot would pass "quotes is at most
  // 0" and fail "quotes is at least 1", both of which are answers about a lead
  // that is not there.
  if (!lead) return null;

  const [quotes, activityCounts] = await Promise.all([
    // Ordered so `latestStatus` means "the most recently raised quote", which is
    // what someone writing "latest quote status is accepted" has in mind. The ids
    // come back with them because the signature counts hang off the same rows —
    // asking for the lead's quotes twice to answer two questions about quotes is
    // a query nobody has to run.
    prisma.quote.findMany({
      where: { leadId, deletedAt: null },
      select: { id: true, status: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
    // No `deletedAt` clause: Activity is not soft-deleted — it has no such
    // column — so a deleted activity is gone rather than hidden. Quote IS soft
    // deleted, which is why the query above carries one.
    prisma.activity.groupBy({
      by: ["status"],
      where: { leadId },
      _count: { _all: true },
    }),
  ]);
  const signatures = await signatureCounts(quotes.map((quote) => quote.id));

  const planned = activityCounts.find((row) => row.status === "planned")?._count._all ?? 0;
  // Counted separately from `planned`, and only when there is something planned
  // to narrow. The `book_test_drive` remedy declares this as the criterion it
  // satisfies, so it has to mean "a test drive is booked" and not "something is
  // booked" — otherwise a service visit satisfies a test-drive rule.
  const testDrives = planned
    ? await prisma.activity.count({ where: { leadId, status: "planned", type: "test_drive" } })
    : 0;
  // Overdue is a second, narrower question than "planned", so it is counted
  // separately rather than derived — a planned activity due tomorrow is not
  // overdue, and the groupBy above cannot express the date predicate.
  const overdue = planned
    ? await prisma.activity.count({
        where: { leadId, status: "planned", dueDate: { lt: now } },
      })
    : 0;

  return {
    lead: {
      valueCents: lead.valueCents,
      assignedToId: lead.assignedToId,
      productId: lead.productId,
      email: lead.email,
      phone: lead.phone,
      source: lead.source,
    },
    quote: {
      count: quotes.length,
      sentCount: quotes.filter((q) => q.status === "sent").length,
      acceptedCount: quotes.filter((q) => q.status === "accepted").length,
      latestStatus: quotes[0]?.status ?? null,
    },
    contact: {
      linked: Boolean(lead.contactId),
      email: lead.contact?.email ?? null,
      phone: lead.contact?.phone ?? null,
    },
    activity: { plannedCount: planned, overdueCount: overdue, testDriveCount: testDrives },
    signature: signatures,
    stage: {
      // Whole days, floored, matching how the board's own `ageDays` is computed
      // and read — "3 days in this stage" must mean the same number in a rule as
      // it does on the card, or a rule written from the board misfires by one.
      ageDays: Math.max(0, Math.floor((now.getTime() - lead.stageEnteredAt.getTime()) / DAY_MS)),
    },
  };
}

/**
 * Signature counts for a lead's quotes.
 *
 * SignatureRequest carries `quoteId`, never `leadId`, so this is two hops by
 * schema rather than by choice. It takes the ids the caller has already read
 * rather than finding them again, and a lead with no quotes short-circuits —
 * which is the common case and skips a pointless `IN ()`.
 */
async function signatureCounts(quoteIds: string[]): Promise<{ completedCount: number; pendingCount: number }> {
  if (quoteIds.length === 0) return { completedCount: 0, pendingCount: 0 };

  const rows = await prisma.signatureRequest.groupBy({
    by: ["status"],
    where: { quoteId: { in: quoteIds } },
    _count: { _all: true },
  });

  const byStatus = new Map(rows.map((row) => [row.status, row._count._all]));
  // "Pending" is every state where a signature is still expected of somebody.
  // Declined, expired, voided and rejected are outcomes, not waiting — counting
  // them as pending would make "no pending signatures" unsatisfiable after a
  // customer declines, which is exactly when the deal needs to move on.
  const pending = ["sent", "viewed", "in_progress"].reduce(
    (total, status) => total + (byStatus.get(status) ?? 0),
    0,
  );
  return { completedCount: byStatus.get("completed") ?? 0, pendingCount: pending };
}
