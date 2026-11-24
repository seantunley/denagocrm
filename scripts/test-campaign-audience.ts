/**
 * A campaign goes only to a saved audience of its own workspace — on a real database (review of #1211).
 *
 * Before #1211 the audience was a typed label: a campaign with no saved audience passed the pre-launch check and,
 * at launch, was worked out from empty rules — everyone who accepts marketing. Driven through the real paths:
 *
 *  - saving a draft keeps only a live saved audience of the SAME workspace (another workspace's or an archived one
 *    is dropped), and the label becomes the audience's name;
 *  - the pre-launch check fails without one;
 *  - queueing refuses no audience and an archived one (another workspace's can't be attached: the database's
 *    composite key refuses it), and with a valid one freezes exactly the matching, opted-in contacts of this workspace.
 *
 *   npm run test:campaign-audience      (DATABASE_URL = a disposable, migrated, seeded database)
 */
import assert from "node:assert/strict";

const SFX = Date.now().toString(36);
const A = `camp-aud-a-${SFX}`;
const B = `camp-aud-b-${SFX}`;

let checks = 0;
const ok = (label: string) => console.log(`  ✓ ${++checks}. ${label}`);

async function refuses(fn: () => Promise<unknown>, message: RegExp, label: string) {
  await assert.rejects(fn, (error: unknown) => message.test(String((error as Error)?.message)), label);
}

(async () => {
  const { basePrisma } = await import("../src/lib/db");
  const { runInTenantScope } = await import("../src/lib/tenantScope");
  const { createCampaignDraftRecord, readCampaignDraftRecord, updateCampaignDraftRecord, NO_AUDIENCE } = await import("../src/lib/marketingCampaignDrafts");
  const { campaignQa, freezeAudienceAndQueue } = await import("../src/lib/marketingCampaignWorkflow");

  const user = await basePrisma.user.findFirst({ select: { id: true, name: true } });
  assert.ok(user, "the seeded database has a user to own the campaign");

  await basePrisma.tenant.create({ data: { id: A, name: `Campaign A ${SFX}`, slug: A, active: true } });
  await basePrisma.tenant.create({ data: { id: B, name: `Campaign B ${SFX}`, slug: B, active: true } });
  const segment = async (tenantId: string, name: string, status: string) => {
    const id = `seg-${name.replace(/\W/g, "")}-${SFX}`;
    await basePrisma.$executeRaw`
      INSERT INTO "Segment" ("id", "tenantId", "name", "criteria", "status")
      VALUES (${id}, ${tenantId}, ${name}, ${JSON.stringify({ province: "Gauteng" })}, ${status})
    `;
    return id;
  };
  try {
    const live = await segment(A, "Gauteng owners", "active");
    const archived = await segment(A, "Old list", "archived");
    const foreign = await segment(B, "B's list", "active");

    const reached = await basePrisma.contact.create({ data: { tenantId: A, firstName: `In ${SFX}`, email: `in-${SFX}@example.com`, province: "Gauteng" } });
    await basePrisma.contact.create({ data: { tenantId: A, firstName: `Elsewhere ${SFX}`, email: `else-${SFX}@example.com`, province: "Limpopo" } });
    await basePrisma.contact.create({ data: { tenantId: A, firstName: `Opted out ${SFX}`, email: `out-${SFX}@example.com`, province: "Gauteng", marketingOptOut: true } });
    await basePrisma.contact.create({ data: { tenantId: B, firstName: `B ${SFX}`, email: `b-${SFX}@example.com`, province: "Gauteng" } });

    await runInTenantScope({ tenantId: A, system: false }, async () => {
      const base = { name: `Spring ${SFX}`, objective: "Book services", channel: "email", subject: "Hello", body: "Hi", htmlBody: "<p>Hi</p>" };

      // 1. Saving a draft.
      const id = await createCampaignDraftRecord({ tenantId: A, userId: user.id, input: { ...base, segmentId: foreign, audience: "everyone" } });
      let draft = await readCampaignDraftRecord(id, A);
      assert.deepEqual([draft?.segmentId, draft?.audience], [null, NO_AUDIENCE], "another workspace's audience is dropped, and the typed label with it");
      await updateCampaignDraftRecord({ id, tenantId: A, input: { segmentId: archived } });
      draft = await readCampaignDraftRecord(id, A);
      assert.equal(draft?.segmentId, null, "an archived audience is dropped");
      ok("a draft never keeps another workspace's audience or an archived one");

      // 2. The pre-launch check.
      assert.ok((await campaignQa(id, A)).some((issue) => issue.code === "audience"), "no saved audience fails the check");
      await updateCampaignDraftRecord({ id, tenantId: A, input: { segmentId: live, audience: "anything typed" } });
      draft = await readCampaignDraftRecord(id, A);
      assert.deepEqual([draft?.segmentId, draft?.audience], [live, "Gauteng owners"], "a live audience is kept, labelled with its own name");
      assert.ok(!(await campaignQa(id, A)).some((issue) => issue.code === "audience"), "and passes the check");
      ok("the pre-launch check wants a live saved audience; the label is the audience's name");

      // 3. Queueing — the campaign approved, its audience then forced underneath the draft rules.
      const queue = () => freezeAudienceAndQueue({ campaignId: id, tenantId: A, scheduleFor: null, userId: user.id, userName: user.name ?? "Test", reason: "test" });
      const force = (segmentId: string | null) =>
        basePrisma.$executeRaw`UPDATE "Campaign" SET "segmentId" = ${segmentId}, "status" = 'approved' WHERE "id" = ${id}`;
      await force(null);
      await refuses(queue, /Choose a saved audience/, "no audience: refused, not sent to everyone");
      await force(archived);
      await refuses(queue, /no longer exists/, "an archived audience: refused");
      // Another workspace's audience can't even be attached: the composite key Campaign(tenantId, segmentId) →
      // Segment(tenantId, id) refuses it, so no campaign can ever point there.
      await refuses(() => force(foreign), /Campaign_tenantId_segmentId_fkey/, "the database refuses another workspace's audience");
      assert.equal(await basePrisma.campaignRecipient.count({ where: { campaignId: id } }), 0, "nothing was queued by any refusal");
      ok("queueing refuses no audience and an archived one; another workspace's can't be attached at all — nobody queued");

      await force(live);
      const result = await queue();
      const recipients = await basePrisma.campaignRecipient.findMany({ where: { campaignId: id }, select: { contactId: true, tenantId: true } });
      assert.equal(result.count, 1);
      assert.deepEqual(recipients, [{ contactId: reached.id, tenantId: A }], "only this workspace's matching, opted-in contact");
      ok("a valid audience freezes exactly its matching, opted-in contacts of this workspace");
    });
  } finally {
    const campaigns = await basePrisma.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Campaign" WHERE "tenantId" IN (${A}, ${B})`;
    const ids = campaigns.map((campaign) => campaign.id);
    if (ids.length) {
      await basePrisma.campaignRecipient.deleteMany({ where: { campaignId: { in: ids } } });
      for (const campaignId of ids) {
        await basePrisma.$executeRaw`DELETE FROM "CampaignVersion" WHERE "campaignId" = ${campaignId}`;
        await basePrisma.$executeRaw`DELETE FROM "Campaign" WHERE "id" = ${campaignId}`;
      }
    }
    await basePrisma.$executeRaw`DELETE FROM "Segment" WHERE "tenantId" IN (${A}, ${B})`;
    await basePrisma.contact.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await basePrisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
    await basePrisma.$disconnect();
  }
  console.log(`\ncampaign audience: ${checks} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
