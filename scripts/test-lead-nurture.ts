/** Real actions, two workspaces, real PostgreSQL. Run only against a disposable local *_test database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

async function main() {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV !== "test" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || !target.pathname.endsWith("_test")) {
    throw new Error("Nurture integration checks require NODE_ENV=test and a local disposable *_test database.");
  }
  const { basePrisma } = await import("../src/lib/db");
  const { seedTwoTenants, teardown } = await import("./harness/seed");
  const { actAsStaff } = await import("./harness/actAs");
  const { __setTenantEnforcingForTests } = await import("../src/lib/tenantEnforcement");
  const { saveLeadNurture, queueNurtureFollowUp } = await import("../src/app/actions/nurture");
  const { reactivateNurturedLead, reopenLead, markLost } = await import("../src/app/actions/leads");
  const { winLeadInTx } = await import("../src/lib/quoteOutcome");
  const { HarnessRedirect } = await import("./harness/stubs/next-navigation");
  const form = (values: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(values)) data.set(key, value);
    return data;
  };
  const ok = (result: { error?: string }) => assert.equal(result.error, undefined, result.error);
  const date = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  try {
    for (const enforcing of [false, true]) {
      __setTenantEnforcingForTests(enforcing);
      const fixture = await seedTwoTenants(`nurture_${randomUUID().slice(0, 8)}`);
      const { a, b } = fixture;
      const asA = <T,>(fn: () => Promise<T>) => actAsStaff(a, fn, { enforcing });
      const read = () => basePrisma.lead.findUniqueOrThrow({ where: { id: a.rows.leadId } });
      const nurture = () => form({ reason: "product", interest: "4×4 hunting vehicle", trigger: "Specifications available", reviewDate: date, assignedToId: a.memberUserId });
      const reactivate = () => form({ stageId: a.rows.stageId, summary: "Call about the new 4×4", dueDate: date });
      try {
        const original = await read();
        ok(await asA(() => saveLeadNurture(a.rows.leadId, nurture())));
        let lead = await read();
        assert.equal(lead.status, "nurture");
        assert.equal(lead.notes, original.notes);
        assert.equal(lead.contactId, original.contactId);
        assert.ok(lead.nurtureActivityId);
        const reviewId = lead.nurtureActivityId;
        assert.equal((await basePrisma.activity.findUniqueOrThrow({ where: { id: reviewId } })).assignedToId, a.memberUserId);
        assert.equal((await basePrisma.activity.findUniqueOrThrow({ where: { id: a.rows.activityId } })).status, "planned", "keep other commitments");
        const [forecast] = await basePrisma.$queryRaw<Array<{ forecastCategory: string; probability: number }>>`SELECT "forecastCategory", probability FROM "Lead" WHERE id = ${lead.id}`;
        assert.equal(forecast.forecastCategory, "omitted");
        assert.equal(forecast.probability, 0);
        assert.equal(lead.wonAt, null);
        assert.equal(lead.lostAt, null);
        ok(await asA(() => saveLeadNurture(a.rows.leadId, nurture())));
        assert.equal((await read()).nurtureActivityId, reviewId, "editing reuses the review task");
        const count = await basePrisma.activity.count({ where: { leadId: lead.id, status: "planned" } });
        const results = await asA(() => Promise.all([queueNurtureFollowUp(lead.id), queueNurtureFollowUp(lead.id)]));
        assert.ok(results.some((result) => !result.error));
        assert.equal(await basePrisma.activity.count({ where: { leadId: lead.id, status: "planned" } }), count, "concurrent follow-ups cannot duplicate tasks");
        const foreign = nurture(); foreign.set("assignedToId", b.memberUserId);
        assert.ok((await asA(() => saveLeadNurture(lead.id, foreign))).error);
        for (const action of [() => saveLeadNurture(b.rows.leadId, nurture()), () => queueNurtureFollowUp(b.rows.leadId), () => reactivateNurturedLead(b.rows.leadId, reactivate())]) {
          await assert.rejects(asA(action), HarnessRedirect, "foreign lead access is refused");
        }
        assert.equal((await basePrisma.lead.findUniqueOrThrow({ where: { id: b.rows.leadId } })).status, "open");
        assert.ok((await asA(() => reopenLead(lead.id))).error, "generic reopen cannot bypass nurture's required next action");
        const blank = reactivate(); blank.set("summary", "");
        assert.ok((await asA(() => reactivateNurturedLead(lead.id, blank))).error);
        const wrongStage = reactivate(); wrongStage.set("stageId", b.rows.stageId);
        assert.ok((await asA(() => reactivateNurturedLead(lead.id, wrongStage))).error);
        ok(await asA(() => reactivateNurturedLead(lead.id, reactivate())));
        lead = await read();
        assert.equal(lead.status, "open");
        assert.equal(lead.nurtureSince, null);
        assert.equal(lead.nurtureActivityId, null);
        assert.equal((await basePrisma.activity.findUniqueOrThrow({ where: { id: reviewId } })).status, "cancelled");
        assert.equal(await basePrisma.activity.count({ where: { leadId: lead.id, summary: "Call about the new 4×4", status: "planned" } }), 1);
        const [restored] = await basePrisma.$queryRaw<Array<{ forecastCategory: string; probability: number }>>`SELECT "forecastCategory", probability FROM "Lead" WHERE id = ${lead.id}`;
        assert.equal(restored.forecastCategory, "pipeline");
        assert.ok(restored.probability > 0);
        assert.ok((await asA(() => reactivateNurturedLead(lead.id, reactivate()))).error, "repeat reactivation has no side effects");
        ok(await asA(() => saveLeadNurture(lead.id, nurture())));
        const winReview = (await read()).nurtureActivityId!;
        assert.equal(await basePrisma.$transaction((tx) => winLeadInTx(tx, lead.id, a.tenantId)), true);
        assert.equal((await read()).status, "won", "a genuine quote acceptance can win a nurtured deal");
        assert.equal((await basePrisma.activity.findUniqueOrThrow({ where: { id: winReview } })).status, "cancelled");
        assert.equal(await basePrisma.$transaction((tx) => winLeadInTx(tx, lead.id, a.tenantId)), false);
        assert.ok((await asA(() => saveLeadNurture(lead.id, nurture()))).error, "won deals cannot be parked");
        ok(await asA(() => reopenLead(lead.id)));
        ok(await asA(() => saveLeadNurture(lead.id, nurture())));
        ok(await asA(() => markLost(lead.id, form({ lostReason: "No longer interested" }))));
        assert.equal((await read()).status, "lost");
        assert.equal(await basePrisma.activity.count({ where: { leadId: lead.id, status: "planned" } }), 0);
        console.log(`PASS nurture lifecycle, concurrency, forecast, quote acceptance and workspace isolation (${enforcing ? "enforced" : "dormant"})`);
      } finally {
        await teardown(fixture);
      }
    }
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.$disconnect();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
