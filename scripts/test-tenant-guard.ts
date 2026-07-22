/**
 * Integration test for the Phase C tenant guard — exercises the REAL Prisma
 * extension (db.ts `prisma` client) with enforcement ENABLED, not just the pure
 * arg-transform helpers. Proves tenant A cannot read/update/delete another
 * tenant's rows, that writes are stamped from context, that a missing scope fails
 * closed, and that a `system` scope is the only bypass.
 *
 * DB-backed (follows scripts/test-integrity.ts): refuses to run outside a *_test
 * DB, uses UUID-suffixed fixtures via basePrisma, cleans up in `finally`.
 * Uses the Contact model — tenant-scoped in Phase B, no tenant FK yet, so
 * arbitrary tenantId strings are valid without seeding Tenant rows.
 */
import { randomUUID } from "node:crypto";
import { prisma, basePrisma } from "../src/lib/db";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { runInTenantScope } from "../src/lib/tenantScope";
import { establishTenantScopeFromId, establishStaffTenantScope, withTokenTenantScope } from "../src/lib/tenantScopeEntry";
import { TenantScopeError } from "../src/lib/tenantGuard";
import { resolvePortalTenant } from "../src/lib/portal";
import { resolveActingTenant } from "../src/lib/tenantContext";
import {
  resolveSignRecipientTenant,
  resolveApprovalStepTenant,
  resolveCampaignRecipientTenant,
} from "../src/lib/tokenTenant";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (process.env.NODE_ENV !== "test" || !dbName.endsWith("_test")) {
  throw new Error(
    `test-tenant-guard refuses to run: expected NODE_ENV=test and a *_test database, got NODE_ENV=${process.env.NODE_ENV} db=${dbName}`,
  );
}

const SFX = randomUUID().slice(0, 8);
const TENANT_A = `tguard_A_${SFX}`;
const TENANT_B = `tguard_B_${SFX}`;
const idA = `c_A_${SFX}`;
const idB = `c_B_${SFX}`;
const cmId = `c_cm_${SFX}`;
const uStaff = `u_staff_${SFX}`;
const t1 = `tn1_${SFX}`;
const t2 = `tn2_${SFX}`;
const sessJti = `sess_${SFX}`;
// No-user token-surface fixtures (Phase C 2b-C1).
const srId = `sr_${SFX}`;
const srIdB = `srB_${SFX}`;
const recId = `rec_${SFX}`;
const recIdB = `recB_${SFX}`;
const apId = `ap_${SFX}`;
const campId = `camp_${SFX}`;
const crId = `cr_${SFX}`;
const signTokenA = `signtok_${SFX}`;
const signTokenB = `signtokB_${SFX}`;
const apTokenA = `aptok_${SFX}`;
const crTokenA = `crtok_${SFX}`;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}
async function expectThrows(name: string, fn: () => Promise<unknown>, is?: (e: unknown) => boolean) {
  try {
    await fn();
    check(name, false);
  } catch (e) {
    check(name, is ? is(e) : true);
  }
}

async function main() {
  // Fixtures via basePrisma (bypasses the guard) — one contact per tenant.
  await basePrisma.contact.create({ data: { id: idA, firstName: "A", tenantId: TENANT_A } });
  await basePrisma.contact.create({ data: { id: idB, firstName: "B", tenantId: TENANT_B } });
  // Staff-bootstrap fixtures: a user with ONE active-tenant membership (a second
  // is granted mid-test to make the resolved tenant ambiguous).
  await basePrisma.user.create({ data: { id: uStaff, name: "Staff", email: `staff_${SFX}@t.test`, passwordHash: "x" } });
  await basePrisma.tenant.create({ data: { id: t1, name: "T1", slug: `t1_${SFX}`, active: true } });
  await basePrisma.tenant.create({ data: { id: t2, name: "T2", slug: `t2_${SFX}`, active: true } });
  await basePrisma.tenantMember.create({ data: { tenantId: t1, userId: uStaff } });

  // No-user token surfaces: a signing request/recipient + approval step + campaign
  // recipient owned by tenant A (and a signing recipient owned by tenant B, to prove
  // cross-tenant isolation). Tenant is DERIVED from these rows by public token.
  await basePrisma.signatureRequest.create({ data: { id: srId, title: "Doc A", tenantId: TENANT_A } });
  await basePrisma.signatureRecipient.create({ data: { id: recId, requestId: srId, name: "Signer A", token: signTokenA, tenantId: TENANT_A } });
  await basePrisma.signatureRequest.create({ data: { id: srIdB, title: "Doc B", tenantId: TENANT_B } });
  await basePrisma.signatureRecipient.create({ data: { id: recIdB, requestId: srIdB, name: "Signer B", token: signTokenB, tenantId: TENANT_B } });
  await basePrisma.approvalStep.create({ data: { id: apId, requestId: srId, nodeId: "n1", label: "Approve", assigneeType: "owner", token: apTokenA, tenantId: TENANT_A } });
  await basePrisma.campaign.create({ data: { id: campId, name: "Camp A", channel: "email", body: "hi", audience: "all", tenantId: TENANT_A } });
  await basePrisma.campaignRecipient.create({ data: { id: crId, campaignId: campId, contactId: idA, token: crTokenA, tenantId: TENANT_A } });

  __setTenantEnforcingForTests(true);
  try {
    // ── acting as tenant A ──────────────────────────────────────────────────
    await runInTenantScope({ tenantId: TENANT_A, system: false }, async () => {
      const list = await prisma.contact.findMany({ where: { id: { in: [idA, idB] } } });
      check("findMany returns only A's row", list.length === 1 && list[0].id === idA);

      const uB = await prisma.contact.findUnique({ where: { id: idB } });
      check("findUnique of B's row → null (cross-tenant hidden)", uB === null);

      const uA = await prisma.contact.findUnique({ where: { id: idA } });
      check("findUnique of A's own row → found", uA?.id === idA);

      const fB = await prisma.contact.findFirst({ where: { id: idB } });
      check("findFirst of B's row → null", fB === null);

      const n = await prisma.contact.count({ where: { id: { in: [idA, idB] } } });
      check("count sees only A's row", n === 1);

      await expectThrows(
        "update of B's row → throws (no matching row)",
        () => prisma.contact.update({ where: { id: idB }, data: { firstName: "hacked" } }),
      );
      await expectThrows(
        "delete of B's row → throws (no matching row)",
        () => prisma.contact.delete({ where: { id: idB } }),
      );

      // A create with a forged tenantId is stamped back to the acting tenant.
      const forgedId = `c_forge_${SFX}`;
      await prisma.contact.create({
        data: { id: forgedId, firstName: "forge", tenantId: TENANT_B },
      });
      const forged = await basePrisma.contact.findUnique({ where: { id: forgedId } });
      check("create stamps acting tenant, ignoring forged tenantId", forged?.tenantId === TENANT_A);

      // findFirstOrThrow of B's row → throws (scoped where finds nothing).
      await expectThrows(
        "findFirstOrThrow of B's row → throws",
        () => prisma.contact.findFirstOrThrow({ where: { id: idB } }),
      );

      // Cross-tenant upsert: the where is tenant-scoped, so it MISSES B's row and
      // takes the create branch (id collision → throws) instead of updating B.
      await expectThrows(
        "cross-tenant upsert does not update B (misses → create → PK collision)",
        () =>
          prisma.contact.upsert({
            where: { id: idB },
            create: { id: idB, firstName: "hacked", tenantId: TENANT_B },
            update: { firstName: "hacked" },
          }),
      );

      // createManyAndReturn stamps the acting tenant.
      await prisma.contact.createManyAndReturn({
        data: [{ id: cmId, firstName: "cm", tenantId: TENANT_B }],
      });
      const cm = await basePrisma.contact.findUnique({ where: { id: cmId } });
      check("createManyAndReturn stamps acting tenant", cm?.tenantId === TENANT_A);

      // updateManyAndReturn is scoped to A: only A's row is returned/updated.
      const updated = await prisma.contact.updateManyAndReturn({
        where: { id: { in: [idA, idB] } },
        data: { firstName: "bulk" },
      });
      check("updateManyAndReturn touches only A's row", updated.length === 1 && updated[0].id === idA);

      // Nested relation writes are refused under enforcement (fail closed).
      await expectThrows(
        "nested relation write is refused under enforcement",
        () =>
          prisma.contact.create({
            data: { firstName: "n", rel: { create: { x: 1 } } },
          } as unknown as Parameters<typeof prisma.contact.create>[0]),
        (e) => e instanceof TenantScopeError,
      );

      // B's row is untouched by all of the above.
      const bStill = await basePrisma.contact.findUnique({ where: { id: idB } });
      check("B's row untouched (still tenant B, name intact)", bStill?.tenantId === TENANT_B && bStill?.firstName === "B");
    });

    // ── fail-closed: no scope established ────────────────────────────────────
    await expectThrows(
      "no tenant scope + enforcement → fails closed (throws)",
      () => prisma.contact.findMany({ where: { id: { in: [idA, idB] } } }),
      (e) => e instanceof TenantScopeError,
    );

    // ── system scope is the only bypass ─────────────────────────────────────
    await runInTenantScope({ tenantId: null, system: true }, async () => {
      const both = await prisma.contact.findMany({ where: { id: { in: [idA, idB] } } });
      check("system scope sees BOTH tenants' rows", both.length === 2);
    });

    // ── chokepoint pattern (getCurrentUser / getPortalContact): validate under a
    //    system scope, then switch to the resolved tenant — no deadlock. ────────
    await runInTenantScope({ tenantId: null, system: true }, async () => {
      // Infra reads (analogue of the UserSession / AppSetting validation reads)
      // succeed under the system scope instead of failing closed.
      const infra = await prisma.contact.findMany({ where: { id: { in: [idA, idB] } } });
      check("chokepoint: infra read under system scope does not deadlock", infra.length === 2);
      // Then switch to the principal's tenant (what the chokepoints do after
      // resolving the user/contact) and confirm subsequent reads are scoped.
      establishTenantScopeFromId(TENANT_A);
      const scoped = await prisma.contact.findMany({ where: { id: { in: [idA, idB] } } });
      check("chokepoint: after switch to tenant A, reads are scoped to A", scoped.length === 1 && scoped[0].id === idA);
    });

    // ── portal bootstrap: tenant is DERIVED from the verified subject's Contact,
    //    never seedable from the token itself. ─────────────────────────────────
    const pOwner = await resolvePortalTenant(idA);
    check("resolvePortalTenant derives tenant from the contact", pOwner?.tenantId === TENANT_A);
    const pMissing = await resolvePortalTenant(`nonexistent_${SFX}`);
    check("resolvePortalTenant → null for an unknown subject (fail closed)", pMissing === null);

    // ── staff chokepoint FAIL-CLOSED: establishStaffTenantScope returns { ok:false }
    //    (→ getCurrentUser returns null → the session is unusable, not merely a null
    //    scope) whenever no valid acting tenant resolves. Tested against the real DB
    //    via the actual chokepoint helper (its .ok is deterministic — no reliance on
    //    enterWith propagation). ─────────────────────────────────────────────────
    const soleRes = await resolveActingTenant(uStaff);
    check("staff: sole active membership resolves to that tenant", "tenantId" in soleRes && soleRes.tenantId === t1);

    check("staff: sole tenant + matching tid → ok", (await establishStaffTenantScope(uStaff, t1)).ok === true);
    check("staff: mismatched tid → NOT ok (session unusable)", (await establishStaffTenantScope(uStaff, "other")).ok === false);
    check("staff: tid-less session → NOT ok (session unusable)", (await establishStaffTenantScope(uStaff, null)).ok === false);

    // New-session write under enforcement lands in the resolved tenant scope and is
    // stamped with that tenant — the login-bootstrap DB path (createSessionCookie).
    await runInTenantScope({ tenantId: t1, system: false }, async () => {
      await prisma.userSession.create({ data: { jti: sessJti, userId: uStaff, tenantId: "forged", platform: "web" } });
    });
    const sess = await basePrisma.userSession.findUnique({ where: { jti: sessJti } });
    check("staff: new session under enforcement is stamped with the scope tenant", sess?.tenantId === t1);

    // Tenant SUSPENDED → session becomes unusable immediately.
    await basePrisma.tenant.update({ where: { id: t1 }, data: { active: false } });
    check("staff: suspended tenant → NOT ok (unusable immediately)", (await establishStaffTenantScope(uStaff, t1)).ok === false);
    await basePrisma.tenant.update({ where: { id: t1 }, data: { active: true } });

    // Membership REMOVED → session becomes unusable immediately.
    await basePrisma.tenantMember.deleteMany({ where: { userId: uStaff, tenantId: t1 } });
    check("staff: membership removed → NOT ok (unusable immediately)", (await establishStaffTenantScope(uStaff, t1)).ok === false);

    // Newly AMBIGUOUS (re-add t1 + add a second active membership) → unusable.
    await basePrisma.tenantMember.create({ data: { tenantId: t1, userId: uStaff } });
    await basePrisma.tenantMember.create({ data: { tenantId: t2, userId: uStaff } });
    check("staff: ambiguous (2 active memberships) → NOT ok (session unusable)", (await establishStaffTenantScope(uStaff, t1)).ok === false);

    // ── no-user token surfaces (Phase C 2b-C1): tenant is DERIVED from the token's
    //    row via a narrow trusted lookup, then the guarded re-read runs INSIDE that
    //    derived scope — the query that dead-locked before the fix. ────────────────
    check("token: resolveSignRecipientTenant derives A from the signing token", (await resolveSignRecipientTenant(signTokenA))?.tenantId === TENANT_A);
    check("token: resolveApprovalStepTenant derives A from the approval token", (await resolveApprovalStepTenant(apTokenA))?.tenantId === TENANT_A);
    check("token: resolveCampaignRecipientTenant derives A from the campaign token", (await resolveCampaignRecipientTenant(crTokenA))?.tenantId === TENANT_A);
    check("token: resolver → null for an unknown token (fail closed)", (await resolveSignRecipientTenant(`nope_${SFX}`)) === null);

    // The guarded re-read the signing PAGE/route runs succeeds inside the derived
    // scope (this exact query threw TenantScopeError before the fix).
    let signRan = false;
    const sr = await withTokenTenantScope(
      () => resolveSignRecipientTenant(signTokenA),
      async () => {
        signRan = true;
        return prisma.signatureRecipient.findUnique({ where: { token: signTokenA }, include: { request: true } });
      },
      () => null,
    );
    check("token: guarded re-read succeeds inside the derived scope (no deadlock)", signRan && sr?.id === recId && sr?.request.tenantId === TENANT_A);

    // Unknown token → onFailClosed, and the guarded work NEVER runs.
    let missRan = false;
    const miss = await withTokenTenantScope(
      () => resolveSignRecipientTenant(`nope_${SFX}`),
      async () => { missRan = true; return "ran"; },
      () => "failed-closed",
    );
    check("token: unknown token fails closed WITHOUT running the guarded work", miss === "failed-closed" && missRan === false);

    // Cross-tenant: inside A's derived scope, B's recipient is invisible.
    const leak = await withTokenTenantScope(
      () => resolveSignRecipientTenant(signTokenA),
      async () => prisma.signatureRecipient.findUnique({ where: { id: recIdB } }),
      () => null,
    );
    check("token: A's derived scope cannot read B's recipient (no cross-tenant leak)", leak === null);

    // Unsubscribe is a compliance action: the opt-out write commits inside the scope.
    const optOutDone = await withTokenTenantScope(
      () => resolveCampaignRecipientTenant(crTokenA),
      async () => {
        const r = await prisma.campaignRecipient.findUnique({ where: { token: crTokenA } });
        if (!r) return false;
        await prisma.contact.update({ where: { id: r.contactId }, data: { marketingOptOut: true } });
        return true;
      },
      () => false,
    );
    const optedOut = await basePrisma.contact.findUnique({ where: { id: idA }, select: { marketingOptOut: true } });
    check("token: unsubscribe actually sets marketingOptOut inside the derived scope", optOutDone === true && optedOut?.marketingOptOut === true);

    // Tracking records the open inside the derived scope.
    await withTokenTenantScope(
      () => resolveCampaignRecipientTenant(crTokenA),
      async () => {
        const r = await prisma.campaignRecipient.findUnique({ where: { token: crTokenA } });
        if (r) await prisma.campaignRecipient.update({ where: { id: r.id }, data: { openCount: { increment: 1 }, openedAt: new Date() } });
      },
      () => undefined,
    );
    const tracked = await basePrisma.campaignRecipient.findUnique({ where: { id: crId }, select: { openCount: true } });
    check("token: tracking records the open inside the derived scope", (tracked?.openCount ?? 0) >= 1);
  } finally {
    __setTenantEnforcingForTests(null);
    // No-user token fixtures first (children before parents; contact FK below).
    await basePrisma.campaignRecipient.deleteMany({ where: { id: crId } });
    await basePrisma.campaign.deleteMany({ where: { id: campId } });
    await basePrisma.approvalStep.deleteMany({ where: { id: apId } });
    await basePrisma.signatureRecipient.deleteMany({ where: { id: { in: [recId, recIdB] } } });
    await basePrisma.signatureRequest.deleteMany({ where: { id: { in: [srId, srIdB] } } });
    await basePrisma.contact.deleteMany({
      where: { id: { in: [idA, idB, cmId, `c_forge_${SFX}`] } },
    });
    await basePrisma.userSession.deleteMany({ where: { jti: sessJti } });
    await basePrisma.tenantMember.deleteMany({ where: { userId: uStaff } });
    await basePrisma.tenant.deleteMany({ where: { id: { in: [t1, t2] } } });
    await basePrisma.user.deleteMany({ where: { id: uStaff } });
    await basePrisma.$disconnect();
  }

  console.log(`\ntenant-guard integration: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
