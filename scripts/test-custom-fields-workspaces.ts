/**
 * Custom fields across two workspaces, on a real database (review of #1064),
 * with tenant enforcement OFF and ON. Off is the case the review is about: the
 * Prisma client is not scoped then, so an unnamed query reads every workspace.
 *
 *  - Both workspaces can define a field with the SAME key (the key is unique per
 *    workspace, not globally).
 *  - A record's rule facts (customRuleValues — what stage rules and journeys
 *    read) come only from its own workspace's definitions and values, even when
 *    the other workspace stored a value against the same record id.
 *  - A link field cannot point at another workspace's contact or product.
 *
 *   npm run test:custom-fields-workspaces      (DATABASE_URL = a disposable, migrated, seeded database)
 */
import assert from "node:assert/strict";

const SFX = Date.now().toString(36);
const A = `cf-ws-a-${SFX}`;
const B = `cf-ws-b-${SFX}`;
const RECORD = `cf-lead-${SFX}`; // custom values key on recordId with no foreign key

let checks = 0;
const ok = (label: string) => console.log(`  ✓ ${++checks}. ${label}`);

(async () => {
  const { basePrisma } = await import("../src/lib/db");
  const { runInTenantScope } = await import("../src/lib/tenantScope");
  const { customRuleValues, getFieldDefs, getFieldsWithValues, linkTargetExists } = await import("../src/lib/customFieldValues");

  await basePrisma.tenant.create({ data: { id: A, name: `CF A ${SFX}`, slug: A, active: true } });
  await basePrisma.tenant.create({ data: { id: B, name: `CF B ${SFX}`, slug: B, active: true } });
  try {
    // The SAME key in both workspaces — refused before the key became unique per workspace.
    const defA = await basePrisma.customFieldDef.create({ data: { tenantId: A, entity: "lead", key: "finance_house", label: "Finance house", type: "text" } });
    const defB = await basePrisma.customFieldDef.create({ data: { tenantId: B, entity: "lead", key: "finance_house", label: "Finance house", type: "text" } });
    ok("two workspaces each define a lead field with the key \"finance_house\"");

    await basePrisma.customFieldValue.create({ data: { tenantId: A, defId: defA.id, recordId: RECORD, value: "WesBank" } });
    // Worst case: B has a value stored against the very same record id.
    await basePrisma.customFieldValue.create({ data: { tenantId: B, defId: defB.id, recordId: RECORD, value: "Absa" } });

    const contactA = await basePrisma.contact.create({ data: { tenantId: A, firstName: `A ${SFX}` } });
    const contactB = await basePrisma.contact.create({ data: { tenantId: B, firstName: `B ${SFX}` } });
    const productA = await basePrisma.product.create({ data: { tenantId: A, name: `Rover A ${SFX}` } });
    const productB = await basePrisma.product.create({ data: { tenantId: B, name: `Rover B ${SFX}` } });

    for (const mode of ["off", "enforce"] as const) {
      process.env.TENANT_ENFORCEMENT = mode;
      const asA = <T>(fn: () => Promise<T>) => runInTenantScope({ tenantId: A, system: false }, fn);

      const defs = await asA(() => getFieldDefs("lead", { tenantId: A }));
      assert.deepEqual(defs.map((d) => d.id), [defA.id], `${mode}: A's definitions only`);

      const facts = await asA(() => customRuleValues("lead", RECORD, A));
      assert.deepEqual(facts, { finance_house: "WesBank" }, `${mode}: A's lead reads A's value — never B's "Absa"`);
      const factsB = await runInTenantScope({ tenantId: B, system: false }, () => customRuleValues("lead", RECORD, B));
      assert.deepEqual(factsB, { finance_house: "Absa" }, `${mode}: and B reads its own`);

      const fields = await asA(() => getFieldsWithValues("lead", RECORD, A));
      assert.deepEqual(fields.map((f) => [f.def.id, f.value]), [[defA.id, "WesBank"]], `${mode}: the form shows A's field and value`);
      ok(`enforcement ${mode}: identical keys in two workspaces never mix in rule facts or forms`);

      assert.equal(await asA(() => linkTargetExists("contact", contactA.id, A)), true, `${mode}: A's own contact links`);
      assert.equal(await asA(() => linkTargetExists("contact", contactB.id, A)), false, `${mode}: B's contact is refused`);
      assert.equal(await asA(() => linkTargetExists("product", productA.id, A)), true, `${mode}: A's own product links`);
      assert.equal(await asA(() => linkTargetExists("product", productB.id, A)), false, `${mode}: B's product is refused`);
      ok(`enforcement ${mode}: a link field cannot point at another workspace's contact or product`);
    }
  } finally {
    await basePrisma.customFieldValue.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await basePrisma.customFieldDef.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await basePrisma.product.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await basePrisma.contact.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await basePrisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
    await basePrisma.$disconnect();
  }
  console.log(`\ncustom fields across workspaces: ${checks} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
