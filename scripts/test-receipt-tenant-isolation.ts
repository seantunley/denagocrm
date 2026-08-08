/**
 * A DELIVERY RECEIPT MAY NOT REACH ANOTHER TENANT'S MESSAGES.
 *
 * The structural tests can assert that every query names a tenant. They cannot
 * assert that the boundary actually holds — only two tenants sharing a phone
 * number in a real database can do that.
 *
 * The defect this reproduces: applyReceipt ran on basePrisma, which sets
 * app.bypass_rls='on', with no tenant predicate. messengerPsid and instagramId
 * are unique columns, but a PHONE NUMBER is not — the same number can legitimately
 * be a customer of two tenants. So a WhatsApp receipt arriving for tenant A could
 * resolve tenant B's contact through LIMIT 1 and stamp tenant B's outbound rows.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * every row it creates.
 */
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { applyReceipt } from "../src/lib/messageReceipts";

const SFX = Math.random().toString(16).slice(2, 10);
const PHONE = `2782${SFX.replace(/\D/g, "").padEnd(7, "1").slice(0, 7)}`;
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

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
  }
}

const ids = {
  tenantA: `t_a_${SFX}`,
  tenantB: `t_b_${SFX}`,
  userA: `u_a_${SFX}`,
  userB: `u_b_${SFX}`,
  contactA: `c_a_${SFX}`,
  contactB: `c_b_${SFX}`,
};

async function seed() {
  for (const [tenantId, userId, contactId] of [
    [ids.tenantA, ids.userA, ids.contactA],
    [ids.tenantB, ids.userB, ids.contactB],
  ]) {
    await basePrisma.tenant.create({
      data: { id: tenantId, name: `Tenant ${tenantId}`, slug: tenantId, active: true },
    });
    await basePrisma.user.create({
      data: { id: userId, name: `User ${userId}`, email: `${userId}@example.test`, passwordHash: "x", role: "sales", tenantId },
    });
    // THE SAME PHONE NUMBER IN BOTH TENANTS. This is legitimate — one person can
    // be a customer of two businesses — and it is what makes the phone lookup
    // unable to identify a tenant on its own.
    await basePrisma.contact.create({
      data: { id: contactId, firstName: "Shared", whatsapp: PHONE, createdById: userId, tenantId },
    });
    // One outbound message per tenant, older than the receipt we will send.
    await basePrisma.communication.create({
      data: {
        type: "whatsapp",
        direction: "outbound",
        body: `hello from ${tenantId}`,
        occurredAt: new Date(Date.now() - 60_000),
        contactId,
        userId,
        tenantId,
      },
    });
  }
}

async function cleanup() {
  await basePrisma.communication.deleteMany({ where: { contactId: { in: [ids.contactA, ids.contactB] } } });
  await basePrisma.contact.deleteMany({ where: { id: { in: [ids.contactA, ids.contactB] } } });
  await basePrisma.user.deleteMany({ where: { id: { in: [ids.userA, ids.userB] } } });
  await basePrisma.tenant.deleteMany({ where: { id: { in: [ids.tenantA, ids.tenantB] } } });
}

const stateOf = async (contactId: string) =>
  basePrisma.communication.findFirst({
    where: { contactId, direction: "outbound" },
    select: { deliveredAt: true, seenAt: true },
  });

async function main() {
  guardEnvironment();
  await seed();

  // A read receipt arriving on TENANT A's channel, for a number both tenants have.
  await runInTenantScope({ tenantId: ids.tenantA, system: false }, async () => {
    await applyReceipt({ channel: "whatsapp", recipientRef: PHONE, level: "seen", at: new Date() });
  });

  const a = await stateOf(ids.contactA);
  const b = await stateOf(ids.contactB);

  check("tenant A's message is marked seen", Boolean(a?.seenAt), JSON.stringify(a));
  check("tenant A's message is also marked delivered", Boolean(a?.deliveredAt));
  check(
    "TENANT B'S MESSAGE IS UNTOUCHED",
    !b?.seenAt && !b?.deliveredAt,
    `tenant B was stamped: ${JSON.stringify(b)}`,
  );

  // And the mirror image: a receipt on B's channel must not reach A.
  await runInTenantScope({ tenantId: ids.tenantB, system: false }, async () => {
    await applyReceipt({ channel: "whatsapp", recipientRef: PHONE, level: "delivered", at: new Date() });
  });
  const bAfter = await stateOf(ids.contactB);
  check("tenant B's own receipt reaches its own message", Boolean(bAfter?.deliveredAt));
  check("and B's receipt did not mark B seen", !bAfter?.seenAt, "delivered must not imply seen");
}

main()
  .then(async () => {
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  })
  .catch(async (error) => {
    await cleanup().catch(() => {});
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => basePrisma.$disconnect());
