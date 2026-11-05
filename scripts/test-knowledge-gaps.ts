import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/**
 * Review of #1009, against real PostgreSQL:
 *  - twenty customers asking the same NEW question at the same moment are twenty asks on ONE gap (none lost to the
 *    unique key), and its wordings stay the newest five;
 *  - of several Draft clicks at once on one gap, exactly ONE claim wins; a stale claim can be taken over, and then only
 *    the new holder can finish — the old one's token no longer matches.
 */
async function main() {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV !== "test" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || !target.pathname.endsWith("_test")) {
    throw new Error("Knowledge gap integration checks require NODE_ENV=test and a local disposable *_test database.");
  }
  const { basePrisma } = await import("../src/lib/db");
  const { runInTenantScope } = await import("../src/lib/tenantScope");
  const { seedTwoTenants, teardown } = await import("./harness/seed");
  const { recordKnowledgeGap, claimGapForDraft, DRAFT_CLAIM_STALE_MS } = await import("../src/lib/knowledgeGaps");
  const { gapKey } = await import("../src/lib/knowledgeGapRules");
  const fixture = await seedTwoTenants(`kgap_${randomUUID().slice(0, 8)}`);
  const { a, b } = fixture;
  const inA = <T,>(fn: () => Promise<T>) => runInTenantScope({ tenantId: a.tenantId, system: false }, fn);
  try {
    // Twenty at once, the same new question in different words.
    await Promise.all(Array.from({ length: 20 }, (_, i) => inA(() => recordKnowledgeGap(`Do you deliver to Joburg?${" ".repeat(i % 3)}${i % 2 ? " please" : ""}`, "service"))));
    const gaps = await basePrisma.knowledgeGap.findMany({ where: { tenantId: a.tenantId } });
    assert.equal(gaps.length, 1, "one gap");
    assert.equal(gaps[0].count, 20, "every ask counted");
    assert.equal(gaps[0].key, gapKey("deliver joburg"));
    assert.ok(Array.isArray(gaps[0].examples) && (gaps[0].examples as unknown[]).length <= 5, "the newest five wordings at most");
    assert.equal(await basePrisma.knowledgeGap.count({ where: { tenantId: b.tenantId } }), 0, "another workspace is untouched");

    // Five Draft clicks at once: one claim.
    const tokens = await Promise.all(Array.from({ length: 5 }, () => claimGapForDraft(a.tenantId, gaps[0].id)));
    const winners = tokens.filter(Boolean);
    assert.equal(winners.length, 1, "exactly one Draft wins");
    assert.equal(await claimGapForDraft(b.tenantId, gaps[0].id), null, "never from another workspace");

    // A claim that went stale can be taken over — then the old holder's token no longer finishes it.
    const later = new Date(Date.now() + DRAFT_CLAIM_STALE_MS + 60_000);
    const takeover = await claimGapForDraft(a.tenantId, gaps[0].id, later);
    assert.ok(takeover && takeover !== winners[0]);
    const finishedByOld = await basePrisma.knowledgeGap.updateMany({ where: { id: gaps[0].id, tenantId: a.tenantId, status: "drafting", draftEntryId: winners[0]! }, data: { status: "drafted" } });
    assert.equal(finishedByOld.count, 0, "the old claim can't finish");
    console.log("knowledge gaps: concurrent asks all counted; one Draft claim at a time ✓");
  } finally {
    await basePrisma.knowledgeGap.deleteMany({ where: { tenantId: { in: [a.tenantId, b.tenantId] } } });
    await teardown(fixture);
    await basePrisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
