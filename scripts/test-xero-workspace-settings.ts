/**
 * Xero's per-workspace settings, on a real database (review of #1068): two
 * workspaces choose DIFFERENT Xero tax rates for the same 15% VAT, and different
 * fee items, and each reads back only its own — with tenant enforcement off AND
 * on. The general getSetting/putSetting resolve to the founding workspace while
 * enforcement is off, which is how one workspace's choice reached another.
 *
 *   npm run test:xero-workspace-settings      (DATABASE_URL = a disposable, migrated, seeded database)
 */
import assert from "node:assert/strict";

const SFX = Date.now().toString(36);
const A = `xero-ws-a-${SFX}`;
const B = `xero-ws-b-${SFX}`;

let checks = 0;
const ok = (label: string) => console.log(`  ✓ ${++checks}. ${label}`);

(async () => {
  const { basePrisma } = await import("../src/lib/db");
  const { runInTenantScope } = await import("../src/lib/tenantScope");
  const { getWorkspaceSetting, putWorkspaceSetting } = await import("../src/lib/settings");
  const { XERO_TAX_CHOICES_KEY, XERO_FEE_ITEM_KEYS, parseXeroTaxChoices, parseXeroItemLink } = await import("../src/lib/xeroInvoice");

  await basePrisma.tenant.create({ data: { id: A, name: `Xero A ${SFX}`, slug: A, active: true } });
  await basePrisma.tenant.create({ data: { id: B, name: `Xero B ${SFX}`, slug: B, active: true } });
  try {
    for (const mode of ["off", "enforce"] as const) {
      process.env.TENANT_ENFORCEMENT = mode;
      // Each workspace saves its own choice for 15%, from inside its own scope — as the action does.
      await runInTenantScope({ tenantId: A, system: false }, () =>
        putWorkspaceSetting(A, XERO_TAX_CHOICES_KEY, JSON.stringify({ "15": { taxType: "OUTPUT", name: "Standard Rate Sales" } })),
      );
      await runInTenantScope({ tenantId: B, system: false }, () =>
        putWorkspaceSetting(B, XERO_TAX_CHOICES_KEY, JSON.stringify({ "15": { taxType: "OUTPUTCAP", name: "Standard Rate Sales - Capital Goods" } })),
      );
      await runInTenantScope({ tenantId: A, system: false }, () =>
        putWorkspaceSetting(A, XERO_FEE_ITEM_KEYS.delivery, JSON.stringify({ id: "item-a", code: "DEL-A", name: "Delivery A" })),
      );
      await runInTenantScope({ tenantId: B, system: false }, () =>
        putWorkspaceSetting(B, XERO_FEE_ITEM_KEYS.delivery, JSON.stringify({ id: "item-b", code: "DEL-B", name: "Delivery B" })),
      );

      const readAs = (t: string, key: string) => runInTenantScope({ tenantId: t, system: false }, () => getWorkspaceSetting(t, key));
      assert.equal(parseXeroTaxChoices(await readAs(A, XERO_TAX_CHOICES_KEY))["15"]?.taxType, "OUTPUT", `${mode}: A reads its own 15% choice`);
      assert.equal(parseXeroTaxChoices(await readAs(B, XERO_TAX_CHOICES_KEY))["15"]?.taxType, "OUTPUTCAP", `${mode}: B reads its own, not A's`);
      assert.equal(parseXeroItemLink(await readAs(A, XERO_FEE_ITEM_KEYS.delivery))?.code, "DEL-A", `${mode}: A's delivery item`);
      assert.equal(parseXeroItemLink(await readAs(B, XERO_FEE_ITEM_KEYS.delivery))?.code, "DEL-B", `${mode}: B's delivery item`);

      // Stored as two rows, one per workspace — not one shared row.
      const rows = await basePrisma.appSetting.findMany({ where: { tenantId: { in: [A, B] }, key: XERO_TAX_CHOICES_KEY }, select: { tenantId: true } });
      assert.deepEqual(rows.map((r) => r.tenantId).sort(), [A, B].sort(), `${mode}: one row per workspace`);
      ok(`enforcement ${mode}: two workspaces keep different Xero tax rates and fee items for the same 15%`);
    }
  } finally {
    await basePrisma.appSetting.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await basePrisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
    await basePrisma.$disconnect();
  }
  console.log(`\nxero workspace settings: ${checks} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
