/**
 * The chatbot's "Update the CRM → move the deal" on a real database (PR #971):
 * it moves the customer's deal only when they have exactly ONE open deal — also
 * when the conversation was matched to one of several (the review's P1: the
 * matched lead used to be taken alone, so the "more than one" refusal never fired).
 *
 *   npm run test:flow-crm-deals      (DATABASE_URL = a disposable, migrated, seeded database)
 */
import assert from "node:assert/strict";

process.env.TENANT_ENFORCEMENT ||= "enforce";
const run = Date.now();
let checks = 0;
const ok = (label: string) => console.log(`  ✓ ${++checks}. ${label}`);

(async () => {
  const { basePrisma } = await import("../src/lib/db");
  const { runInTenantScope } = await import("../src/lib/tenantScope");
  const { crmActions } = await import("../src/lib/flowActions");

  const user = await basePrisma.user.findFirstOrThrow({ where: { tenantId: { not: null } }, select: { id: true, tenantId: true } });
  const tenantId = user.tenantId!;
  const stages = await basePrisma.pipelineStage.findMany({ where: { tenantId }, select: { id: true }, take: 2, orderBy: { id: "asc" } });
  assert.equal(stages.length, 2, "the seeded workspace has two pipeline stages");
  const [from, to] = stages;

  const contact = (tag: string) => basePrisma.contact.create({ data: { tenantId, firstName: "Flow", lastName: `${tag}-${run}` }, select: { id: true } });
  const deal = (contactId: string | null, tag: string) =>
    basePrisma.lead.create({ data: { tenantId, stageId: from.id, status: "open", name: `Flow ${tag}`, title: `Deal ${tag}-${run}`, contactId }, select: { id: true } });
  const stageOf = async (id: string) => (await basePrisma.lead.findUniqueOrThrow({ where: { id }, select: { stageId: true } })).stageId;
  const node = { id: `crm-${run}`, type: "crm" as const, action: "stage" as const, stageId: to.id };
  const move = (match: { contactId: string | null; leadId: string | null }) =>
    runInTenantScope({ tenantId, system: false }, () => crmActions("whatsapp", match).updateCrm(node));

  // 1. Matched to one of TWO open deals: refused, neither moves.
  const two = await contact("two");
  const a = await deal(two.id, "a");
  const b = await deal(two.id, "b");
  const refused = await move({ contactId: two.id, leadId: a.id });
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? "", /more than one open deal/);
  assert.equal(await stageOf(a.id), from.id);
  assert.equal(await stageOf(b.id), from.id);
  ok("matched to one of two open deals: refused, neither moved");

  // 2. The same when the conversation carries only the lead (no contact on the match).
  const leadOnly = await move({ contactId: null, leadId: b.id });
  assert.equal(leadOnly.ok, false);
  assert.equal(await stageOf(b.id), from.id);
  ok("matched by lead alone, the customer's other open deal still counts");

  // 3. Exactly one open deal: moved.
  const one = await contact("one");
  const c = await deal(one.id, "c");
  assert.equal((await move({ contactId: one.id, leadId: c.id })).ok, true);
  assert.equal(await stageOf(c.id), to.id);
  ok("exactly one open deal: moved");

  // 4. A lead with no customer is its own (only) deal.
  const d = await deal(null, "d");
  assert.equal((await move({ contactId: null, leadId: d.id })).ok, true);
  assert.equal(await stageOf(d.id), to.id);
  ok("a lead with no customer record: moved");

  console.log(`\n${checks} checks passed`);
  await basePrisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
