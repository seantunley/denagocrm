/**
 * SUPPLIERS ON PURCHASE ORDERS, AND THE WHOLE DEAL FILE — WITH TENANT ENFORCEMENT OFF, THEN ON (review of #1040).
 *
 * P1: the new purchase-order action stored the supplier but not the workspace. Enforcement off (the default and
 * the rollback mode) or in monitor mode, the scoped client stamps nothing, so the order was written with
 * tenantId NULL — and the supplier's page, which reads orders by workspace, never showed it.
 * P2: the deal file listed only the newest 20 signature requests, without saying so.
 *
 * Two real workspaces, each with a product and a supplier. A member of A orders from A's supplier through the real
 * action, in both modes: the order, its lines and units carry A, and A's supplier history (the page's own query)
 * shows it. Ordering from B's supplier is refused and writes nothing. 25 signature requests across a quote and its
 * revision all come back.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes what it creates.
 */
import { basePrisma } from "../src/lib/db";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { createPurchaseOrder } from "../src/app/actions/stock";
import { dealSignatureRequests, vendorPurchaseOrders } from "../src/lib/dealFileData";
import { seedTwoTenants, teardown } from "./harness/seed";
import { actAsStaff } from "./harness/actAs";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const settled = <T>(work: Promise<T>) => work.then((value) => ({ value, threw: null as unknown }), (error: unknown) => ({ value: null, threw: String(error) }));

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
};

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
}

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`so${SFX}`);
  const { a, b } = fixture;
  const tenants = [a.tenantId, b.tenantId];
  try {
    const productA = await basePrisma.product.create({ data: { tenantId: a.tenantId, name: `Cart ${SFX}` } });
    const vendorA = await basePrisma.vendor.create({ data: { tenantId: a.tenantId, name: `Denago ${SFX}`, kind: "oem" } });
    const vendorB = await basePrisma.vendor.create({ data: { tenantId: b.tenantId, name: `Bravo OEM ${SFX}`, kind: "oem" } });

    for (const enforcing of [false, true]) {
      __setTenantEnforcingForTests(enforcing);
      const mode = enforcing ? "enforcement on" : "enforcement off";
      const memberOfA = <T>(work: () => Promise<T>) => actAsStaff(a, work, { enforcing });

      const reference = `PO-${mode.replace(/\W/g, "")}-${SFX}`;
      const made = await settled(memberOfA(() => createPurchaseOrder(form({ vendorId: vendorA.id, productId: productA.id, qty: "2", cost: "1000", reference }))));
      check(`${mode}: ordering from the workspace's own supplier succeeds`, !made.threw && !(made.value as { error?: string } | null)?.error, JSON.stringify(made).slice(0, 300));

      const order = await basePrisma.purchaseOrder.findFirst({
        where: { reference },
        select: { id: true, tenantId: true, vendorId: true, supplier: true, lines: { select: { tenantId: true } }, units: { select: { tenantId: true } } },
      });
      check(`${mode}: the order carries the workspace and the supplier`, order?.tenantId === a.tenantId && order?.vendorId === vendorA.id && order?.supplier === vendorA.name, JSON.stringify(order));
      check(`${mode}: its lines and units carry the workspace`, !!order && order.lines.length === 1 && order.units.length === 2 && [...order.lines, ...order.units].every((row) => row.tenantId === a.tenantId), JSON.stringify(order));

      const history = await memberOfA(() => vendorPurchaseOrders(a.tenantId, vendorA.id));
      check(`${mode}: the supplier's history shows the new order`, history.some((row) => row.id === order?.id), `${history.length} orders`);

      const foreignRef = `PO-foreign-${mode.replace(/\W/g, "")}-${SFX}`;
      const foreign = await settled(memberOfA(() => createPurchaseOrder(form({ vendorId: vendorB.id, productId: productA.id, qty: "1", cost: "1000", reference: foreignRef }))));
      const leaked = await basePrisma.purchaseOrder.count({ where: { reference: foreignRef } });
      check(`${mode}: ordering from another workspace's supplier is refused and writes nothing`, leaked === 0 && (Boolean(foreign.threw) || Boolean((foreign.value as { error?: string } | null)?.error)), JSON.stringify(foreign).slice(0, 200));
    }

    // The Suppliers module switched OFF for A: an order takes a typed supplier name again, and names no record.
    __setTenantEnforcingForTests(false);
    const granted = await basePrisma.tenant.findUnique({ where: { id: a.tenantId }, select: { modules: true } });
    await basePrisma.tenant.update({ where: { id: a.tenantId }, data: { modules: (granted?.modules ?? "").split(",").filter((id) => id !== "suppliers").join(",") } });
    try {
      const typedRef = `PO-typed-${SFX}`;
      const typed = await settled(actAsStaff(a, () => createPurchaseOrder(form({ supplier: `Typed OEM ${SFX}`, productId: productA.id, qty: "1", cost: "1000", reference: typedRef })), { enforcing: false }));
      const typedOrder = await basePrisma.purchaseOrder.findFirst({ where: { reference: typedRef }, select: { tenantId: true, vendorId: true, supplier: true } });
      check(
        "module off: an order takes a typed supplier name and names no supplier record",
        !typed.threw && !(typed.value as { error?: string } | null)?.error && typedOrder?.supplier === `Typed OEM ${SFX}` && typedOrder.vendorId === null && typedOrder.tenantId === a.tenantId,
        JSON.stringify({ typed, typedOrder }).slice(0, 300),
      );
    } finally {
      await basePrisma.tenant.update({ where: { id: a.tenantId }, data: { modules: granted?.modules ?? "" } });
    }

    // P2 — every signature request on the deal, across a quote and its revision.
    __setTenantEnforcingForTests(false);
    const revision = await basePrisma.quote.create({
      data: { tenantId: a.tenantId, number: 1_900_000_000 + Math.floor(Math.random() * 90_000_000), leadId: a.rows.leadId, revisionOfId: a.rows.quoteId, status: "sent" },
      select: { id: true },
    });
    for (let index = 0; index < 25; index++) {
      await basePrisma.signatureRequest.create({ data: { tenantId: a.tenantId, title: `Request ${index} ${SFX}`, quoteId: index % 2 ? revision.id : a.rows.quoteId } });
    }
    const requests = await actAsStaff(a, () => dealSignatureRequests([a.rows.quoteId, revision.id]), { enforcing: false });
    check("the deal file lists all 25 signature requests across both quotes, not the newest 20", requests.length === 25, `${requests.length}`);
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.signatureRequest.deleteMany({ where: { tenantId: { in: tenants } } });
    await basePrisma.stockEvent.deleteMany({ where: { purchaseOrder: { reference: { contains: SFX } } } });
    await basePrisma.stockUnit.deleteMany({ where: { tenantId: { in: tenants } } });
    await basePrisma.purchaseOrderLine.deleteMany({ where: { tenantId: { in: tenants } } });
    await basePrisma.purchaseOrder.deleteMany({ where: { tenantId: { in: tenants } } });
    // Rows an unscoped write might have left without a workspace — the failure this guards.
    await basePrisma.stockUnit.deleteMany({ where: { purchaseOrder: { reference: { contains: SFX } } } });
    await basePrisma.purchaseOrderLine.deleteMany({ where: { purchaseOrder: { reference: { contains: SFX } } } });
    await basePrisma.purchaseOrder.deleteMany({ where: { reference: { contains: SFX } } });
    await basePrisma.vendor.deleteMany({ where: { tenantId: { in: tenants } } });
    await basePrisma.quote.deleteMany({ where: { tenantId: a.tenantId, revisionOfId: a.rows.quoteId } });
    await basePrisma.product.deleteMany({ where: { tenantId: { in: tenants } } });
    await teardown(fixture);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => basePrisma.$disconnect());
