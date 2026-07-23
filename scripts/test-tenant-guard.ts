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
import { establishTenantScopeFromId, establishStaffTenantScope, withTokenTenantScope, withChannelTenantScope, validateInSystemScope, withSystemScope } from "../src/lib/tenantScopeEntry";
import { runCronPerTenant, activeTenantIds } from "../src/lib/tenantCron";
import { logAudit } from "../src/lib/audit";
import { getSetting } from "../src/lib/settings";
import { TenantScopeError } from "../src/lib/tenantGuard";
import { resolvePortalTenant } from "../src/lib/portal";
import { resolveActingTenant } from "../src/lib/tenantContext";
import {
  resolveSignRecipientTenant,
  resolveApprovalStepTenant,
  resolveCampaignRecipientTenant,
  resolveSurveyResponseTenant,
} from "../src/lib/tokenTenant";
import { resolveTenantActor, resolveTenantMemberUser, listTenantStaff } from "../src/lib/tenantActor";
import { resolveApprover } from "../src/lib/signing/approvals";
import { hashApiKey, resolveApiKeyTenant, authenticateIntakeKey } from "../src/lib/apiKeys";
import { claimSlotCapacity } from "../src/lib/bookingSlots";
import { serviceOtpKey } from "../src/lib/serviceOtp";
import { pushRecipientsForCurrentScope } from "../src/lib/push";
import { resolveChannelTenant } from "../src/lib/channelTenant";
import { upsertChannel } from "./backfill-channel-identities";

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
const survId = `surv_${SFX}`;
const survIdB = `survB_${SFX}`;
const srespId = `sresp_${SFX}`;
const srespIdB = `srespB_${SFX}`;
const surveyTokenA = `survtok_${SFX}`;
const surveyTokenB = `survtokB_${SFX}`;
// Tenant-aware actor fixtures: userB is OLDER than userA, so the legacy global
// "oldest user" pick would wrongly choose B. TENANT_A/TENANT_B get real Tenant rows
// here (TenantMember needs the FK).
const userAId = `uA_${SFX}`;
const userBId = `uB_${SFX}`;
const userCId = `uC_${SFX}`; // DISABLED member of TENANT_A, oldest of all — must never be picked
// Per-tenant API keys (C2).
const apiKeyRawA = `keyA_${SFX}`;
const apiKeyRawRevoked = `keyR_${SFX}`;
const apiKeyRawGlobal = `legacyglobal_${SFX}`;
const apiKeyIdA = `tak_${SFX}`;
const apiKeyIdR = `takR_${SFX}`;
const TENANT_SUS = `tenant_sus_${SFX}`; // suspended tenant (active=false)
const ghostTenant = `ghost_${SFX}`; // a tenantId with NO Tenant row (dangling key)
const apiKeyRawSuspended = `keyS_${SFX}`;
const apiKeyRawDangling = `keyD_${SFX}`;
const apiKeyIdS = `takS_${SFX}`;
const apiKeyIdD = `takD_${SFX}`;
// Route-level tenant boundaries (C2 review round 2): booking slot capacity, service
// OTP challenge, and push delivery.
const actAId = `act_A_${SFX}`;
const otpChalId = `otp_A_${SFX}`;
const subAId = `sub_A_${SFX}`;
const subBId = `sub_B_${SFX}`;
const subCId = `sub_C_${SFX}`;
const otpVin = `VINSHARE${SFX}`.toUpperCase();
const slotDt = new Date("2030-06-03T06:00:00.000Z"); // fixed future slot instant
// Inbound channel-identity fixtures (Phase C 2b-C3): OUR endpoints → tenant.
const waEndpointA = `waA_${SFX}`; // WhatsApp phone-number id owned by TENANT_A
const pageEndpointB = `pageB_${SFX}`; // FB Page id owned by TENANT_B
const waDisabled = `waDis_${SFX}`; // an endpoint with disabledAt set
const waSus = `waSus_${SFX}`; // endpoint of a SUSPENDED tenant
const waGhost = `waGhost_${SFX}`; // endpoint whose tenant has NO Tenant row (dangling)
const chTenantSus = `chsus_${SFX}`; // suspended tenant (active=false)
const chGhostTenant = `chghost_${SFX}`; // tenantId with no Tenant row
const chIdA = `chA_${SFX}`;
const chIdB = `chB_${SFX}`;
const chIdDis = `chDis_${SFX}`;
const chIdSus = `chSus_${SFX}`;
const chIdGhost = `chGhost_${SFX}`;
const cfgKey = `TESTCFG_${SFX}`; // a tenant-scoped AppSetting (review blocker 1 fixture)

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
  // Public survey surface: a survey + response owned by A (and one owned by B).
  await basePrisma.survey.create({ data: { id: survId, title: "Survey A", questions: [], tenantId: TENANT_A } });
  await basePrisma.surveyResponse.create({ data: { id: srespId, surveyId: survId, token: surveyTokenA, contactId: idA, status: "sent", tenantId: TENANT_A } });
  await basePrisma.survey.create({ data: { id: survIdB, title: "Survey B", questions: [], tenantId: TENANT_B } });
  await basePrisma.surveyResponse.create({ data: { id: srespIdB, surveyId: survIdB, token: surveyTokenB, status: "sent", tenantId: TENANT_B } });

  // Real Tenant rows for A/B + one owner member each. userB is created OLDER than
  // userA on purpose: the legacy global oldest-user pick would choose B.
  await basePrisma.tenant.create({ data: { id: TENANT_A, name: "Tenant A", slug: `ta_${SFX}`, active: true } });
  await basePrisma.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: `tb_${SFX}`, active: true } });
  await basePrisma.user.create({ data: { id: userBId, name: "Owner B", email: `ob_${SFX}@t.test`, passwordHash: "x", role: "owner", createdAt: new Date("2020-01-01T00:00:00Z") } });
  await basePrisma.user.create({ data: { id: userAId, name: "Owner A", email: `oa_${SFX}@t.test`, passwordHash: "x", role: "owner", createdAt: new Date("2021-01-01T00:00:00Z") } });
  await basePrisma.tenantMember.create({ data: { tenantId: TENANT_B, userId: userBId } });
  await basePrisma.tenantMember.create({ data: { tenantId: TENANT_A, userId: userAId } });
  // A DISABLED owner member of TENANT_A, OLDER than everyone — so an actor pick that
  // ignored disablement would wrongly choose them. disabledAt is a raw User column
  // (not in the Prisma model), so seed it via SQL.
  await basePrisma.user.create({ data: { id: userCId, name: "Disabled A", email: `oc_${SFX}@t.test`, passwordHash: "x", role: "owner", createdAt: new Date("2019-01-01T00:00:00Z") } });
  await basePrisma.tenantMember.create({ data: { tenantId: TENANT_A, userId: userCId } });
  await basePrisma.$executeRaw`UPDATE "User" SET "disabledAt" = ${new Date("2019-06-01T00:00:00Z")} WHERE "id" = ${userCId}`;

  // Per-tenant API keys (raw SQL — the client delegate may be un-regenerated locally,
  // and this is exactly how apiKeys.ts queries the table). keyA is scoped to
  // intake+bookings only (NOT service-lookup); keyR is revoked. A legacy global key
  // is seeded into AppSetting for the dormant back-compat test.
  await basePrisma.$executeRaw`INSERT INTO "TenantApiKey" ("id","tenantId","label","hashedKey","prefix","scopes","createdAt") VALUES (${apiKeyIdA}, ${TENANT_A}, ${"Key A"}, ${hashApiKey(apiKeyRawA)}, ${apiKeyRawA.slice(0, 8)}, ${"intake,bookings"}, CURRENT_TIMESTAMP)`;
  await basePrisma.$executeRaw`INSERT INTO "TenantApiKey" ("id","tenantId","label","hashedKey","prefix","scopes","createdAt","revokedAt") VALUES (${apiKeyIdR}, ${TENANT_A}, ${"Key R"}, ${hashApiKey(apiKeyRawRevoked)}, ${apiKeyRawRevoked.slice(0, 8)}, ${"intake,bookings,service-lookup"}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
  await basePrisma.$executeRaw`INSERT INTO "AppSetting" ("key","value") VALUES ('INTAKE_API_KEY', ${apiKeyRawGlobal}) ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"`;
  // A key for a SUSPENDED tenant (active=false) and a DANGLING key (tenantId with no
  // Tenant row) — both must fail to authenticate.
  await basePrisma.tenant.create({ data: { id: TENANT_SUS, name: "Suspended", slug: `sus_${SFX}`, active: false } });
  await basePrisma.$executeRaw`INSERT INTO "TenantApiKey" ("id","tenantId","label","hashedKey","prefix","scopes","createdAt") VALUES (${apiKeyIdS}, ${TENANT_SUS}, ${"Key S"}, ${hashApiKey(apiKeyRawSuspended)}, ${apiKeyRawSuspended.slice(0, 8)}, ${"intake,bookings,service-lookup"}, CURRENT_TIMESTAMP)`;
  await basePrisma.$executeRaw`INSERT INTO "TenantApiKey" ("id","tenantId","label","hashedKey","prefix","scopes","createdAt") VALUES (${apiKeyIdD}, ${ghostTenant}, ${"Key D"}, ${hashApiKey(apiKeyRawDangling)}, ${apiKeyRawDangling.slice(0, 8)}, ${"intake,bookings,service-lookup"}, CURRENT_TIMESTAMP)`;

  // One WORKSHOP activity for tenant A at a fixed instant (slot capacity fixture).
  await basePrisma.activity.create({
    data: { id: actAId, type: "meeting", category: "workshop", status: "planned", summary: "A booked slot", dueDate: slotDt, contactId: idA, assignedToId: userAId, createdById: userAId, tenantId: TENANT_A },
  });
  // Push device subscriptions (PushSubscription is a GLOBAL model): one for a member
  // of A, one for a member of B, and one for A's DISABLED member (userC).
  await basePrisma.pushSubscription.create({ data: { id: subAId, endpoint: `epA_${SFX}`, p256dh: "x", auth: "x", userId: userAId, userName: "A" } });
  await basePrisma.pushSubscription.create({ data: { id: subBId, endpoint: `epB_${SFX}`, p256dh: "x", auth: "x", userId: userBId, userName: "B" } });
  await basePrisma.pushSubscription.create({ data: { id: subCId, endpoint: `epC_${SFX}`, p256dh: "x", auth: "x", userId: userCId, userName: "C-disabled" } });

  // Channel identities (C3, raw SQL — the delegate may be un-regenerated locally, and
  // this is how channelTenant.ts queries the table): A's WhatsApp number, B's Page, a
  // DISABLED endpoint, a SUSPENDED-tenant endpoint, and a DANGLING endpoint (no Tenant).
  await basePrisma.tenant.create({ data: { id: chTenantSus, name: "Suspended Ch", slug: `chsus_${SFX}`, active: false } });
  await basePrisma.$executeRaw`INSERT INTO "ChannelIdentity" ("id","tenantId","channel","externalId","createdAt") VALUES (${chIdA}, ${TENANT_A}, 'whatsapp', ${waEndpointA}, CURRENT_TIMESTAMP)`;
  await basePrisma.$executeRaw`INSERT INTO "ChannelIdentity" ("id","tenantId","channel","externalId","createdAt") VALUES (${chIdB}, ${TENANT_B}, 'messenger', ${pageEndpointB}, CURRENT_TIMESTAMP)`;
  await basePrisma.$executeRaw`INSERT INTO "ChannelIdentity" ("id","tenantId","channel","externalId","createdAt","disabledAt") VALUES (${chIdDis}, ${TENANT_A}, 'whatsapp', ${waDisabled}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
  await basePrisma.$executeRaw`INSERT INTO "ChannelIdentity" ("id","tenantId","channel","externalId","createdAt") VALUES (${chIdSus}, ${chTenantSus}, 'whatsapp', ${waSus}, CURRENT_TIMESTAMP)`;
  await basePrisma.$executeRaw`INSERT INTO "ChannelIdentity" ("id","tenantId","channel","externalId","createdAt") VALUES (${chIdGhost}, ${chGhostTenant}, 'whatsapp', ${waGhost}, CURRENT_TIMESTAMP)`;
  // A tenant-scoped AppSetting (blocker 1): a bare read fails closed under enforcement,
  // but the webhook's validateInSystemScope wrapper reads it via the system bypass.
  await basePrisma.appSetting.create({ data: { key: cfgKey, value: "sig-secret" } });

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

    // Actor helpers must ALSO fail closed under enforcement with no scope — never
    // silently fall back to global users (a missed chokepoint / lost propagation
    // must not leak a cross-tenant approver). Runs at top level = no ambient scope.
    check("failclosed(no scope): resolveTenantActor → null", (await resolveTenantActor()) === null);
    check("failclosed(no scope): resolveTenantActor ownerOnly → null", (await resolveTenantActor({ ownerOnly: true })) === null);
    check("failclosed(no scope): resolveTenantMemberUser → null", (await resolveTenantMemberUser(userAId)) === null);
    check("failclosed(no scope): listTenantStaff → empty", (await listTenantStaff()).length === 0);
    check("failclosed(no scope): resolveApprover staff → no email", (await resolveApprover({ assigneeType: "staff", assigneeUserId: userAId, assigneeRole: null, assigneeName: "A", assigneeEmail: `x_${SFX}@x.test` })).email === null);
    check("failclosed(no scope): resolveApprover owner → no email", (await resolveApprover({ assigneeType: "owner", assigneeUserId: null, assigneeRole: null, assigneeName: "O", assigneeEmail: `x_${SFX}@x.test` })).email === null);

    // A null NON-system scope ({ tenantId: null, system: false }) is NOT a global
    // bypass — it must fail closed too (only an explicit system scope bypasses).
    await runInTenantScope({ tenantId: null, system: false }, async () => {
      check("failclosed(null non-system): resolveTenantActor → null", (await resolveTenantActor()) === null);
      check("failclosed(null non-system): resolveTenantMemberUser → null", (await resolveTenantMemberUser(userAId)) === null);
      check("failclosed(null non-system): listTenantStaff → empty", (await listTenantStaff()).length === 0);
      check("failclosed(null non-system): resolveApprover staff → no email", (await resolveApprover({ assigneeType: "staff", assigneeUserId: userAId, assigneeRole: null, assigneeName: "A", assigneeEmail: `x_${SFX}@x.test` })).email === null);
    });

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

    // Public SURVEY surface (page /s/[token] + the submitSurveyResponse action).
    check("survey: resolveSurveyResponseTenant derives A from the survey token", (await resolveSurveyResponseTenant(surveyTokenA))?.tenantId === TENANT_A);
    check("survey: resolver → null for an unknown token (fail closed)", (await resolveSurveyResponseTenant(`nope_${SFX}`)) === null);

    // The guarded re-read the PAGE does succeeds inside the derived scope.
    const survResp = await withTokenTenantScope(
      () => resolveSurveyResponseTenant(surveyTokenA),
      async () => prisma.surveyResponse.findUnique({ where: { token: surveyTokenA }, include: { survey: true } }),
      () => null,
    );
    check("survey: page's guarded re-read succeeds inside the derived scope", survResp?.id === srespId && survResp?.survey.tenantId === TENANT_A);

    // The SUBMISSION write (surveyResponse.update to completed) commits inside scope.
    const survDone = await withTokenTenantScope(
      () => resolveSurveyResponseTenant(surveyTokenA),
      async () => {
        const r = await prisma.surveyResponse.findUnique({ where: { token: surveyTokenA } });
        if (!r) return false;
        await prisma.surveyResponse.update({ where: { id: r.id }, data: { status: "completed", completedAt: new Date() } });
        return true;
      },
      () => false,
    );
    const survAfter = await basePrisma.surveyResponse.findUnique({ where: { id: srespId }, select: { status: true, tenantId: true } });
    check("survey: submission write completes inside the derived scope (stays tenant A)", survDone === true && survAfter?.status === "completed" && survAfter?.tenantId === TENANT_A);

    // Cross-tenant: inside A's derived scope, B's survey response is invisible.
    const survLeak = await withTokenTenantScope(
      () => resolveSurveyResponseTenant(surveyTokenA),
      async () => prisma.surveyResponse.findUnique({ where: { id: srespIdB } }),
      () => null,
    );
    check("survey: A's derived scope cannot read B's response (no cross-tenant leak)", survLeak === null);

    // ── tenant-aware actor resolution (Phase C 2b-C1): system-generated records
    //    must reference a member of the CURRENT tenant, never the global oldest
    //    user (here userB, created earlier than userA). ────────────────────────────
    await runInTenantScope({ tenantId: TENANT_A, system: false }, async () => {
      check("actor: A's scope resolves A's member, not B's older global user", (await resolveTenantActor())?.id === userAId);
      check("actor: A's scope ownerOnly resolves A's owner, not B's", (await resolveTenantActor({ ownerOnly: true }))?.id === userAId);

      // The exact survey side effect: the timeline note is attributed to A's user
      // AND stamped tenant A — never userB (the older, cross-tenant global pick).
      const actor = await resolveTenantActor();
      const comm = await prisma.communication.create({
        data: { type: "note", direction: "inbound", subject: "Survey response: A", body: "b", contactId: idA, userId: actor!.id },
      });
      const storedComm = await basePrisma.communication.findUnique({ where: { id: comm.id }, select: { userId: true, tenantId: true } });
      check("actor: survey note attributed to A's user + stamped tenant A (never B)", storedComm?.userId === userAId && storedComm?.tenantId === TENANT_A);
      await basePrisma.communication.deleteMany({ where: { id: comm.id } });
    });
    await runInTenantScope({ tenantId: TENANT_B, system: false }, async () => {
      check("actor: B's scope resolves B's member", (await resolveTenantActor())?.id === userBId);
    });
    // System scope (analogue of dormant / no user-tenant): global oldest NON-DISABLED
    // user — userC is older (2019) but disabled, so it skips to userB (2020).
    await runInTenantScope({ tenantId: null, system: true }, async () => {
      check("actor: system scope → global oldest non-disabled user (skips disabled userC) = B", (await resolveTenantActor())?.id === userBId);
    });

    // ── explicit STAFF approval assignees: the real notification-resolution path
    //    (resolveApprover) must reject a cross-tenant/stale assigneeUserId and only
    //    resolve an email for a current-tenant member. ─────────────────────────────
    await runInTenantScope({ tenantId: TENANT_A, system: false }, async () => {
      // A member of A → their email is returned (they WOULD be notified).
      const okStaff = await resolveApprover({ assigneeType: "staff", assigneeUserId: userAId, assigneeRole: null, assigneeName: "A", assigneeEmail: null });
      check("approver: current-tenant staff assignee → their email", okStaff.email === `oa_${SFX}@t.test`);
      // A user of tenant B (cross-tenant / stale) — even with a stored email — is
      // rejected: fail closed, no notification.
      const crossStaff = await resolveApprover({ assigneeType: "staff", assigneeUserId: userBId, assigneeRole: null, assigneeName: "B", assigneeEmail: `ob_${SFX}@t.test` });
      check("approver: cross-tenant staff assignee → fail closed (no email)", crossStaff.email === null);
      // Owner assignee → A's owner, never B's.
      const ownerApprover = await resolveApprover({ assigneeType: "owner", assigneeUserId: null, assigneeRole: null, assigneeName: null, assigneeEmail: null });
      check("approver: owner assignee → A's owner email, never B's", ownerApprover.email === `oa_${SFX}@t.test`);

      // resolveTenantMemberUser directly: A member resolves, B's user is rejected.
      check("member: resolveTenantMemberUser(A's user) → resolves", (await resolveTenantMemberUser(userAId))?.id === userAId);
      check("member: resolveTenantMemberUser(B's user) under A → null (fail closed)", (await resolveTenantMemberUser(userBId)) === null);

      // Staff picker: the assignee list excludes B's user under A's scope.
      const staffList = await listTenantStaff();
      const staffIds = staffList.map((u) => u.id);
      check("picker: staff list scoped to A's members (includes A, excludes B)", staffIds.includes(userAId) && !staffIds.includes(userBId));

      // ── disabled accounts are excluded from EVERY actor path (userC is the oldest
      //    member of A but disabled — a token action needs no login, so a disabled
      //    account must never be picked/listed/emailed). ──────────────────────────
      check("disabled: resolveTenantActor skips the disabled (older) member → userA", (await resolveTenantActor())?.id === userAId);
      check("disabled: ownerOnly skips the disabled owner → userA", (await resolveTenantActor({ ownerOnly: true }))?.id === userAId);
      check("disabled: resolveTenantMemberUser(disabled member) → null", (await resolveTenantMemberUser(userCId)) === null);
      check("disabled: resolveApprover staff=disabled member → fail closed (no email)", (await resolveApprover({ assigneeType: "staff", assigneeUserId: userCId, assigneeRole: null, assigneeName: "C", assigneeEmail: `oc_${SFX}@t.test` })).email === null);
      check("disabled: listTenantStaff excludes the disabled member", staffIds.includes(userAId) && !staffIds.includes(userCId));

      // ── legacy/malformed steps fail closed under enforcement (blocker 2) ────────
      check("approver: staff step with NO assigneeUserId → fail closed (no stored-email fallback)", (await resolveApprover({ assigneeType: "staff", assigneeUserId: null, assigneeRole: null, assigneeName: "X", assigneeEmail: `stored_${SFX}@x.test` })).email === null);
    });
    // Owner assignee whose scope has no active, non-disabled owner → fail closed.
    await runInTenantScope({ tenantId: `empty_${SFX}`, system: false }, async () => {
      check("approver: owner assignee with no resolvable owner → fail closed (no email)", (await resolveApprover({ assigneeType: "owner", assigneeUserId: null, assigneeRole: null, assigneeName: "O", assigneeEmail: `stored_${SFX}@x.test` })).email === null);
    });

    // ── per-tenant API keys (Phase C 2b-C2) ─────────────────────────────────────
    check("apikey: resolveApiKeyTenant(keyA,'intake') → tenant A", (await resolveApiKeyTenant(apiKeyRawA, "intake")) === TENANT_A);
    check("apikey: resolveApiKeyTenant(keyA,'bookings') → tenant A", (await resolveApiKeyTenant(apiKeyRawA, "bookings")) === TENANT_A);
    check("apikey: keyA out of scope (service-lookup) → null", (await resolveApiKeyTenant(apiKeyRawA, "service-lookup")) === null);
    check("apikey: unknown key → null", (await resolveApiKeyTenant(`nope_${SFX}`, "intake")) === null);
    check("apikey: revoked key → null", (await resolveApiKeyTenant(apiKeyRawRevoked, "intake")) === null);
    check("apikey: key for a SUSPENDED tenant → null (Tenant.active=false)", (await resolveApiKeyTenant(apiKeyRawSuspended, "intake")) === null);
    check("apikey: authenticateIntakeKey(suspended-tenant key) → null", (await authenticateIntakeKey(apiKeyRawSuspended, "intake")) === null);
    check("apikey: DANGLING key (deleted tenant, no Tenant row) → null", (await resolveApiKeyTenant(apiKeyRawDangling, "intake")) === null);
    // Enforcement: per-tenant keys only — the legacy global key is rejected.
    check("apikey: authenticateIntakeKey(keyA) enforcing → tenant A", (await authenticateIntakeKey(apiKeyRawA, "intake"))?.tenantId === TENANT_A);
    check("apikey: authenticateIntakeKey(legacy global) enforcing → null", (await authenticateIntakeKey(apiKeyRawGlobal, "intake")) === null);
    check("apikey: authenticateIntakeKey(null) → null", (await authenticateIntakeKey(null, "intake")) === null);

    // ── booking SLOT CAPACITY is per-tenant (C2 review round 2). claimSlotCapacity
    //    runs on basePrisma with an EXPLICIT tenant, so one tenant's booking must
    //    neither consume nor lock-contend on another's slot. tenantId is passed
    //    directly (not via scope), so this holds regardless of ambient scope. ───────
    let bClaimOk = false;
    await basePrisma.$transaction(async (tx) => {
      await claimSlotCapacity(tx, slotDt, 1, TENANT_B);
      bClaimOk = true;
    });
    check("slot: tenant B can claim the instant A already booked (per-tenant capacity)", bClaimOk);
    await expectThrows(
      "slot: the same instant is FULL for tenant A (its own booking counts)",
      () => basePrisma.$transaction((tx) => claimSlotCapacity(tx, slotDt, 1, TENANT_A)),
      (e) => e instanceof Error && e.message === "SLOT_TAKEN",
    );
    await expectThrows(
      "slot: global (null tenant) capacity still counts A's row (dormant back-compat)",
      () => basePrisma.$transaction((tx) => claimSlotCapacity(tx, slotDt, 1, null)),
      (e) => e instanceof Error && e.message === "SLOT_TAKEN",
    );

    // ── service OTP challenge is tenant-namespaced (OtpChallenge is global). A code
    //    issued for tenant A's VIN must be invisible to — and not rate-limit — tenant
    //    B's request for the SAME VIN. ──────────────────────────────────────────────
    let otpKeyA = "";
    let otpKeyB = "";
    await runInTenantScope({ tenantId: TENANT_A, system: false }, async () => {
      otpKeyA = serviceOtpKey(otpVin);
      await basePrisma.otpChallenge.create({
        data: { id: otpChalId, purpose: "service-booking", key: otpKeyA, codeHash: "x", channel: "sms", target: "x", expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
      });
    });
    await runInTenantScope({ tenantId: TENANT_B, system: false }, async () => {
      otpKeyB = serviceOtpKey(otpVin);
    });
    check("otp: same VIN → DIFFERENT challenge key per tenant", otpKeyA !== otpKeyB && otpKeyA.includes(TENANT_A) && otpKeyB.includes(TENANT_B));
    const bSeesChallenge = await basePrisma.otpChallenge.findFirst({ where: { purpose: "service-booking", key: otpKeyB, verifiedAt: null, expiresAt: { gt: new Date() } } });
    check("otp: tenant B cannot see/verify A's challenge for the same VIN", bSeesChallenge === null);
    const bFloodCount = await basePrisma.otpChallenge.count({ where: { purpose: "service-booking", key: otpKeyB } });
    check("otp: A's issuance does not rate-limit B (per-tenant flood count)", bFloodCount === 0);
    const aSeesChallenge = await basePrisma.otpChallenge.findFirst({ where: { purpose: "service-booking", key: otpKeyA, verifiedAt: null } });
    check("otp: tenant A still finds its own challenge", aSeesChallenge?.id === otpChalId);
    // Fail-closed: a null non-system scope must never mint/match a globally-keyed
    // challenge (deterministic "closed" case — no reliance on ambient emptiness).
    await runInTenantScope({ tenantId: null, system: false }, async () => {
      await expectThrows(
        "otp: serviceOtpKey fails closed under a null non-system scope",
        async () => { serviceOtpKey(otpVin); },
        (e) => e instanceof TenantScopeError,
      );
    });

    // ── PUSH delivery is per-tenant (PushSubscription is global). A tenant-A push must
    //    reach only A's active-member devices, never B's, and never a disabled member. ─
    await runInTenantScope({ tenantId: TENANT_A, system: false }, async () => {
      const ids = (await pushRecipientsForCurrentScope()).map((r) => r.id);
      check("push: tenant A push reaches A's member device", ids.includes(subAId));
      check("push: tenant A push does NOT reach B's device (no cross-tenant leak)", !ids.includes(subBId));
      check("push: tenant A push excludes the DISABLED member's device", !ids.includes(subCId));
    });
    await runInTenantScope({ tenantId: TENANT_B, system: false }, async () => {
      const ids = (await pushRecipientsForCurrentScope()).map((r) => r.id);
      check("push: tenant B push reaches only B's device (never A's)", ids.includes(subBId) && !ids.includes(subAId));
    });
    await runInTenantScope({ tenantId: null, system: true }, async () => {
      const ids = (await pushRecipientsForCurrentScope()).map((r) => r.id);
      check("push: system scope broadcasts to ALL devices (A + B)", ids.includes(subAId) && ids.includes(subBId));
    });
    await runInTenantScope({ tenantId: null, system: false }, async () => {
      check("push: null non-system scope → delivers to NOBODY (fail closed)", (await pushRecipientsForCurrentScope()).length === 0);
    });

    // ── inbound CHANNEL identity (Phase C 2b-C3): resolve OUR endpoint → tenant with
    //    an active-Tenant JOIN, then run the event inside that scope (enforcement ON).
    check("channel: resolveChannelTenant(whatsapp, A's number) → tenant A", (await resolveChannelTenant("whatsapp", waEndpointA)) === TENANT_A);
    check("channel: resolveChannelTenant(messenger, B's page) → tenant B", (await resolveChannelTenant("messenger", pageEndpointB)) === TENANT_B);
    check("channel: same id under the WRONG channel → null", (await resolveChannelTenant("whatsapp", pageEndpointB)) === null);
    check("channel: unknown endpoint → null", (await resolveChannelTenant("whatsapp", `nope_${SFX}`)) === null);
    check("channel: null externalId → null", (await resolveChannelTenant("whatsapp", null)) === null);
    check("channel: DISABLED endpoint → null (disabledAt set)", (await resolveChannelTenant("whatsapp", waDisabled)) === null);
    check("channel: endpoint of a SUSPENDED tenant → null (Tenant.active=false)", (await resolveChannelTenant("whatsapp", waSus)) === null);
    check("channel: DANGLING endpoint (no Tenant row) → null", (await resolveChannelTenant("whatsapp", waGhost)) === null);

    // withChannelTenantScope confines the event's guarded work to the derived tenant.
    const chSeen = await withChannelTenantScope(
      "whatsapp",
      waEndpointA,
      async () => (await prisma.contact.findMany({ where: { id: { in: [idA, idB] } } })).map((r) => r.id),
      () => [] as string[],
    );
    check("channel: withChannelTenantScope confines reads to the derived tenant (A only, not B)", chSeen.length === 1 && chSeen[0] === idA);

    // Unmapped endpoint under enforcement → onUnresolved runs, `fn` NEVER runs (the
    // returned marker distinguishes which branch executed).
    const chMiss = await withChannelTenantScope(
      "whatsapp",
      `nope_${SFX}`,
      async () => "ran",
      () => "unresolved",
    );
    check("channel: unmapped endpoint → onUnresolved WITHOUT running the event", chMiss === "unresolved");

    // A suspended-tenant endpoint also fails closed through the scope helper.
    const chSus = await withChannelTenantScope("whatsapp", waSus, async () => "ran", () => "skipped");
    check("channel: suspended-tenant endpoint → event skipped (fail closed)", chSus === "skipped");

    // ── review blocker 1: the webhook's PRE-scope receive-side config reads must go
    //    through validateInSystemScope — a bare tenant-scoped AppSetting read fails
    //    closed under enforcement (so signature verification would never complete). ──
    await runInTenantScope({ tenantId: null, system: false }, async () => {
      await expectThrows(
        "channel: bare tenant-scoped AppSetting read fails closed (would break sig verify)",
        () => getSetting(cfgKey),
        (e) => e instanceof TenantScopeError,
      );
    });
    check("channel: validateInSystemScope reads receive-side config pre-scope (system bypass)", (await validateInSystemScope(() => getSetting(cfgKey))) === "sig-secret");

    // ── review blocker 2: ChannelIdentity is an authz boundary — the backfill must
    //    NEVER silently reassign an endpoint owned by another tenant. ────────────────
    await expectThrows(
      "backfill: refuses to reassign B's endpoint to A (cross-tenant hijack)",
      () => upsertChannel("messenger", pageEndpointB, "hijack", TENANT_A),
    );
    check("backfill: B's endpoint STILL owned by B after the refused reassignment", (await resolveChannelTenant("messenger", pageEndpointB)) === TENANT_B);
    check("backfill: same-tenant upsert is a no-op (no ownership change)", (await upsertChannel("messenger", pageEndpointB, "same", TENANT_B)) === "unchanged");

    // ── cron scoping (Phase C 2b-C4): background jobs carry NO principal. Platform
    //    sweeps run in the trusted system scope (guard bypass); per-tenant business
    //    queues run once per ACTIVE tenant, each confined to its own scope. ──────────
    // A guarded sweep with no scope fails closed — exactly why crons need a scope.
    await runInTenantScope({ tenantId: null, system: false }, async () => {
      await expectThrows(
        "cron: a guarded sweep with NO scope fails closed (motivates the cron scope)",
        () => prisma.contact.findMany({ where: { id: { in: [idA, idB] } } }),
        (e) => e instanceof TenantScopeError,
      );
    });
    // withSystemScope: the same sweep sees EVERY tenant's rows (guard bypass), no deadlock.
    // NB: the guarded read must be AWAITED inside the callback — the ALS scope covers
    // only work awaited within `fn`, not a lazy Prisma thenable returned unawaited.
    const sysSweep = await withSystemScope(async () => {
      return await prisma.contact.findMany({ where: { id: { in: [idA, idB] } }, select: { id: true } });
    });
    check("cron: withSystemScope sees BOTH tenants' rows (platform sweep, no deadlock)", sysSweep.length === 2);

    // runCronPerTenant: one run per ACTIVE tenant, each confined — A's slice sees only
    // A's contact, B's only B's — and NO run for a suspended tenant.
    const perTenantRuns = await runCronPerTenant(async () =>
      (await prisma.contact.findMany({ where: { id: { in: [idA, idB] } }, select: { id: true } })).map((r) => r.id),
    );
    const runA = perTenantRuns.find((r) => r.tenantId === TENANT_A);
    const runB = perTenantRuns.find((r) => r.tenantId === TENANT_B);
    check("cron: runCronPerTenant confines A's slice to A (sees only idA)", !!runA && runA.result.length === 1 && runA.result[0] === idA);
    check("cron: runCronPerTenant confines B's slice to B (sees only idB)", !!runB && runB.result.length === 1 && runB.result[0] === idB);
    check("cron: runCronPerTenant produces no run for the SUSPENDED tenant", !perTenantRuns.some((r) => r.tenantId === TENANT_SUS));
    const activeIds = await activeTenantIds();
    check("cron: activeTenantIds includes active A + B, excludes the suspended tenant", activeIds.includes(TENANT_A) && activeIds.includes(TENANT_B) && !activeIds.includes(TENANT_SUS));
    // The per-tenant actor pick inside a cron scope resolves that tenant's owner.
    const cronActor = perTenantRuns.length ? await runInTenantScope({ tenantId: TENANT_A, system: false }, () => resolveTenantActor({ ownerOnly: true })) : null;
    check("cron: actor pick inside a per-tenant cron scope resolves that tenant's owner", cronActor?.id === userAId);

    // ── C4 review blocker 1: ONE tenant's failure must NOT abort the rest of the
    //    sweep — it is captured as `status:"error"` and later tenants still run.
    const failReported: string[] = [];
    const isoRuns = await runCronPerTenant(
      async (tid) => {
        if (tid === TENANT_A) throw new Error("boom-A");
        return tid;
      },
      {
        concurrency: 1,
        maxRuntimeMs: 60_000,
        minStartBudgetMs: 0,
        rotationWindowMs: 60 * 60 * 1000,
        onError: (tid) => { failReported.push(tid); },
        now: () => 1_000_000, // constant clock → admit every tenant (no deadline skips)
      },
    );
    const isoA = isoRuns.find((r) => r.tenantId === TENANT_A);
    const isoB = isoRuns.find((r) => r.tenantId === TENANT_B);
    check("cron-iso: failing tenant A captured as error (sweep NOT aborted)", isoA?.status === "error");
    check("cron-iso: tenant B still runs after A throws", !!isoB && isoB.status === "ok" && isoB.result === TENANT_B);
    check("cron-iso: onError reported the failing tenant", failReported.includes(TENANT_A));

    // ── C4 review blocker 2: fairness. (a) the starting tenant ROTATES between
    //    windows so fixed ordering can't starve later tenants; (b) the invocation
    //    deadline CAPS admission — later tenants are visibly `skipped`, not run.
    const order1: (string | null)[] = [];
    await runCronPerTenant(async (tid) => { order1.push(tid); return tid; },
      { concurrency: 1, maxRuntimeMs: 60_000, minStartBudgetMs: 0, rotationWindowMs: 1_000, now: () => 5_000 });
    const order2: (string | null)[] = [];
    await runCronPerTenant(async (tid) => { order2.push(tid); return tid; },
      { concurrency: 1, maxRuntimeMs: 60_000, minStartBudgetMs: 0, rotationWindowMs: 1_000, now: () => 6_000 });
    check("cron-fair: rotation changes the starting tenant across windows (no fixed starvation)",
      order1.length >= 2 && order2.length >= 2 && order1[0] !== order2[0]);

    let clock = 1_000_000;
    const deadlineRuns = await runCronPerTenant(async () => { clock += 30_000; return "done"; },
      { concurrency: 1, maxRuntimeMs: 50_000, minStartBudgetMs: 5_000, rotationWindowMs: 60 * 60 * 1000, now: () => clock });
    // startDeadline = 1e6 + 50000 - 5000 = 1.045e6; each slice advances +30000 →
    // only the first two are admitted, the rest fall past the deadline as skipped.
    check("cron-fair: invocation deadline caps admission (later tenants skipped, not run)",
      deadlineRuns.some((r) => r.status === "skipped") && deadlineRuns.filter((r) => r.status === "ok").length <= 2);

    // ── C4 review blocker 3: a cron-generated audit row written INSIDE a tenant
    //    scope must be stamped with THAT tenant (not null), and hidden from others.
    //    logAudit's primary path writes via basePrisma, so it relies on
    //    actingTenantId() honouring the ambient non-system scope.
    const auditSummary = `c4-cron-audit-${SFX}`;
    await runInTenantScope({ tenantId: TENANT_A, system: false }, async () => {
      await logAudit({ action: "cron.audit.test", summary: auditSummary, userName: "Automation" });
    });
    const auditRow = await basePrisma.auditLog.findFirst({ where: { summary: auditSummary }, select: { tenantId: true } });
    check("audit: cron log inside tenant A's scope is stamped tenant A (not null)", auditRow?.tenantId === TENANT_A);
    const bSeesAudit = await runInTenantScope({ tenantId: TENANT_B, system: false }, async () => {
      // Await the guarded read INSIDE the callback — a lazy thenable returned
      // unawaited would run after the scope reverts and fail closed.
      return await prisma.auditLog.findFirst({ where: { summary: auditSummary } });
    });
    check("audit: tenant B cannot see tenant A's cron audit row (guard-scoped)", bSeesAudit === null);
    // System-scope cron audit stays global (tenantId null) — no ambient tenant to inherit.
    const sysAuditSummary = `c4-sys-audit-${SFX}`;
    await withSystemScope(async () => {
      await logAudit({ action: "cron.audit.sys", summary: sysAuditSummary, userName: "Automation" });
    });
    const sysAuditRow = await basePrisma.auditLog.findFirst({ where: { summary: sysAuditSummary }, select: { tenantId: true } });
    check("audit: system-scope cron log stays global (tenantId null)", sysAuditRow !== null && sysAuditRow.tenantId === null);
    // Inline cleanup of both audit tables (governance AuditEvent + legacy AuditLog).
    await basePrisma.$executeRaw`DELETE FROM "AuditEvent" WHERE "summary" IN (${auditSummary}, ${sysAuditSummary})`;
    await basePrisma.auditLog.deleteMany({ where: { summary: { in: [auditSummary, sysAuditSummary] } } });

    // ── DORMANT back-compat (enforcement OFF): C2 keys/OTP/push + C3 channel all run
    //    byte-for-byte the pre-tenancy path. ─────────────────────────────────────────
    __setTenantEnforcingForTests(false);
    const dormLegacy = await authenticateIntakeKey(apiKeyRawGlobal, "intake");
    check("apikey: DORMANT legacy global accepted (tenantId null)", dormLegacy !== null && dormLegacy.tenantId === null);
    check("apikey: DORMANT per-tenant keyA still resolves to A", (await authenticateIntakeKey(apiKeyRawA, "intake"))?.tenantId === TENANT_A);
    check("apikey: DORMANT unknown key → null", (await authenticateIntakeKey(`nope_${SFX}`, "intake")) === null);
    check("otp: DORMANT serviceOtpKey → bare VIN (legacy key, byte-for-byte)", serviceOtpKey(otpVin) === otpVin);
    const dormPushIds = (await pushRecipientsForCurrentScope()).map((r) => r.id);
    check("push: DORMANT delivers to ALL devices (global, unchanged)", dormPushIds.includes(subAId) && dormPushIds.includes(subBId) && dormPushIds.includes(subCId));
    const chDorm = await withChannelTenantScope("whatsapp", `nope_${SFX}`, async () => "ran", () => "skipped");
    check("channel: DORMANT runs the event directly even for an unmapped id (byte-for-byte legacy)", chDorm === "ran");
    // C4: dormant cron runs ONCE globally (tenantId null), the slice unscoped sees all rows.
    const dormCron = await runCronPerTenant(async () =>
      (await prisma.contact.findMany({ where: { id: { in: [idA, idB] } }, select: { id: true } })).map((r) => r.id),
    );
    check("cron: DORMANT runCronPerTenant runs ONCE globally (tenantId null, sees both rows)", dormCron.length === 1 && dormCron[0].tenantId === null && dormCron[0].result.length === 2);
    __setTenantEnforcingForTests(true);
  } finally {
    __setTenantEnforcingForTests(null);
    // No-user token fixtures first (children before parents; contact FK below).
    await basePrisma.campaignRecipient.deleteMany({ where: { id: crId } });
    await basePrisma.campaign.deleteMany({ where: { id: campId } });
    await basePrisma.approvalStep.deleteMany({ where: { id: apId } });
    await basePrisma.signatureRecipient.deleteMany({ where: { id: { in: [recId, recIdB] } } });
    await basePrisma.signatureRequest.deleteMany({ where: { id: { in: [srId, srIdB] } } });
    await basePrisma.surveyResponse.deleteMany({ where: { id: { in: [srespId, srespIdB] } } });
    await basePrisma.survey.deleteMany({ where: { id: { in: [survId, survIdB] } } });
    await basePrisma.communication.deleteMany({ where: { contactId: { in: [idA, idB] } } });
    // Route-level boundary fixtures (activity FKs contact; push subs FK user).
    await basePrisma.activity.deleteMany({ where: { id: actAId } });
    await basePrisma.otpChallenge.deleteMany({ where: { id: otpChalId } });
    await basePrisma.pushSubscription.deleteMany({ where: { id: { in: [subAId, subBId, subCId] } } });
    await basePrisma.$executeRaw`DELETE FROM "TenantApiKey" WHERE "tenantId" IN (${TENANT_A}, ${TENANT_SUS}, ${ghostTenant})`;
    await basePrisma.$executeRaw`DELETE FROM "AppSetting" WHERE "key" = 'INTAKE_API_KEY'`;
    await basePrisma.$executeRaw`DELETE FROM "ChannelIdentity" WHERE "id" IN (${chIdA}, ${chIdB}, ${chIdDis}, ${chIdSus}, ${chIdGhost})`;
    await basePrisma.appSetting.deleteMany({ where: { key: cfgKey } });
    await basePrisma.tenantMember.deleteMany({ where: { userId: { in: [userAId, userBId, userCId] } } });
    await basePrisma.user.deleteMany({ where: { id: { in: [userAId, userBId, userCId] } } });
    await basePrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B, TENANT_SUS, chTenantSus] } } });
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
