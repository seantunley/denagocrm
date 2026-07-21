import assert from "node:assert/strict";
import crypto from "node:crypto";
import { prisma, basePrisma } from "../src/lib/db";
import { resolveActingTenant, createUserInOwnerTenant } from "../src/lib/tenantContext";
import { ensureFoundingMembership, createTenant } from "../src/lib/provisioning";

// DB-backed verification of the security/integrity fixes (audit Groups 1-3).
// Runs in CI against the ephemeral seeded database — NOT locally (a local run
// would hit the production DB). It exercises the fix MECHANISMS directly:
// compound-where child scoping (IDOR), the atomic OTP gate, the reservation
// state transition, the dealer conditional claim, and soft-delete on findUnique.

const suffix = crypto.randomUUID().replaceAll("-", "");
const id = (name: string) => `int-${name}-${suffix}`;

async function main() {
  // HARD guard: this suite creates and deletes real rows, so it must only ever
  // run against a throwaway test database — never a developer's .env (which
  // points at production). Require NODE_ENV=test AND a database named *_test.
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (process.env.NODE_ENV !== "test" || !dbName.endsWith("_test")) {
    throw new Error(
      `test-integrity refuses to run: expected NODE_ENV=test and a *_test database, got NODE_ENV=${process.env.NODE_ENV} db=${dbName || "(none)"}.`,
    );
  }

  const num = Math.floor(Date.now() / 1000) % 1_000_000_000;
  const contactA = id("contactA");
  const contactB = id("contactB");
  const jobA = id("jobA");
  const jobB = id("jobB");
  const itemB = id("itemB");
  const vehicleA = id("vehicleA");
  const vehicleB = id("vehicleB");
  const partId = id("part");
  const reservationId = id("resv");
  const quoteId = id("quote");
  const otpId = id("otp");
  const trashContact = id("trashed");
  const mergeWinner = id("mergeWinner");
  const mergeLoser = id("mergeLoser");
  const psid = `psid-${suffix}`;

  try {
    await basePrisma.contact.createMany({
      data: [
        { id: contactA, firstName: "A" },
        { id: contactB, firstName: "B" },
        { id: trashContact, firstName: "Trashed", deletedAt: new Date() },
      ],
    });
    await basePrisma.vehicle.createMany({
      data: [
        { id: vehicleA, model: "cart A", contactId: contactA },
        { id: vehicleB, model: "cart B", contactId: contactB },
      ],
    });
    await basePrisma.jobCard.createMany({
      data: [
        { id: jobA, number: num, description: "A", vehicleId: vehicleA, contactId: contactA },
        { id: jobB, number: num + 1, description: "B", vehicleId: vehicleB, contactId: contactB },
      ],
    });
    await basePrisma.jobCardItem.create({
      data: { id: itemB, jobCardId: jobB, kind: "part", description: "B part", qty: 1, unitPriceCents: 100 },
    });
    await basePrisma.part.create({ data: { id: partId, name: "widget", stockQty: 5, priceCents: 100 } });
    await basePrisma.partReservation.create({ data: { id: reservationId, jobCardId: jobB, partId, qty: 1, status: "active" } });
    await basePrisma.quote.create({ data: { id: quoteId, number: num + 2, contactId: contactA } });
    await basePrisma.otpChallenge.create({
      data: { id: otpId, purpose: "portal", key: "int@example.invalid", codeHash: "x", channel: "email", target: "int@example.invalid", attempts: 0, expiresAt: new Date(Date.now() + 600000) },
    });

    // #3 Child IDOR — deleting job B's item scoped to the WRONG parent (job A)
    // must affect nothing; scoped to its real parent it deletes exactly one.
    const wrongParent = await basePrisma.jobCardItem.deleteMany({ where: { id: itemB, jobCardId: jobA } });
    assert.equal(wrongParent.count, 0, "IDOR: item must not delete under the wrong parent");
    const rightParent = await basePrisma.jobCardItem.deleteMany({ where: { id: itemB, jobCardId: jobB } });
    assert.equal(rightParent.count, 1, "scoped delete under the real parent removes exactly one");

    // #3 Reservation transition — active→consumed claims once; a second claim is a no-op.
    const claim1 = await basePrisma.partReservation.updateMany({ where: { id: reservationId, jobCardId: jobB, status: "active" }, data: { status: "consumed" } });
    assert.equal(claim1.count, 1, "reservation active→consumed claims once");
    const claim2 = await basePrisma.partReservation.updateMany({ where: { id: reservationId, jobCardId: jobB, status: "active" }, data: { status: "consumed" } });
    assert.equal(claim2.count, 0, "a consumed reservation can't be claimed again");

    // #4 Dealer countersign — conditional claim succeeds once, then never again.
    const dealer1 = await basePrisma.quote.updateMany({ where: { id: quoteId, deletedAt: null, dealerSignedAt: null, signedAt: null, supersededAt: null }, data: { dealerSignedAt: new Date() } });
    assert.equal(dealer1.count, 1, "dealer countersign claims once");
    const dealer2 = await basePrisma.quote.updateMany({ where: { id: quoteId, deletedAt: null, dealerSignedAt: null, signedAt: null, supersededAt: null }, data: { dealerSignedAt: new Date() } });
    assert.equal(dealer2.count, 0, "a countersigned quote can't be countersigned again");

    // #18 OTP gate — a challenge at the attempt cap is not consumable; under it, once.
    const gateOk = await basePrisma.otpChallenge.updateMany({ where: { id: otpId, verifiedAt: null, attempts: { lt: 5 } }, data: { attempts: { increment: 1 } } });
    assert.equal(gateOk.count, 1, "OTP attempt consumes while under the cap");
    await basePrisma.otpChallenge.update({ where: { id: otpId }, data: { attempts: 5 } });
    const gateBlocked = await basePrisma.otpChallenge.updateMany({ where: { id: otpId, verifiedAt: null, attempts: { lt: 5 } }, data: { attempts: { increment: 1 } } });
    assert.equal(gateBlocked.count, 0, "OTP attempt is refused at the cap");

    // #16 Soft-delete on unique lookups — the filtered client hides a trashed row
    // from findUnique; the unfiltered base client still sees it (Trash/restore).
    const viaFiltered = await prisma.contact.findUnique({ where: { id: trashContact } });
    assert.equal(viaFiltered, null, "filtered findUnique must not resolve a trashed record");
    const viaFilteredSelect = await prisma.contact.findUnique({ where: { id: trashContact }, select: { id: true, firstName: true } });
    assert.equal(viaFilteredSelect, null, "filtered findUnique hides trashed rows even with a select that omits deletedAt");
    const viaBase = await basePrisma.contact.findUnique({ where: { id: trashContact } });
    assert.notEqual(viaBase, null, "base client still resolves trashed records (for Trash/restore/purge)");
    const activeViaFiltered = await prisma.contact.findUnique({ where: { id: contactA }, select: { id: true } });
    assert.notEqual(activeViaFiltered, null, "filtered findUnique still resolves active records");

    // #16 Soft-delete guards MUTATIONS too, not just reads. A trashed row must be
    // unmodifiable through the filtered client: update throws (P2025), updateMany
    // matches nothing. This is what stops a direct action editing a Trash record.
    let trashedUpdateBlocked = false;
    try {
      await prisma.contact.update({ where: { id: trashContact }, data: { firstName: "Hacked" } });
    } catch {
      trashedUpdateBlocked = true;
    }
    assert.ok(trashedUpdateBlocked, "filtered update must refuse a trashed row");
    const trashedMany = await prisma.contact.updateMany({ where: { id: trashContact }, data: { firstName: "Hacked" } });
    assert.equal(trashedMany.count, 0, "filtered updateMany must skip a trashed row");
    const untouched = await basePrisma.contact.findUnique({ where: { id: trashContact }, select: { firstName: true } });
    assert.equal(untouched?.firstName, "Trashed", "the trashed row was left unmodified");

    // The filtered-client select bypass: even a select that sets `deletedAt: false`
    // must not resolve a trashed row (the guard injects deletedAt regardless).
    const viaFalseSelect = await prisma.contact.findUnique({ where: { id: trashContact }, select: { id: true, deletedAt: false } });
    assert.equal(viaFalseSelect, null, "filtered findUnique hides a trashed row even with deletedAt:false in select");

    // #14 Contact merge — a unique channel identity (messengerPsid) stays index-
    // occupied even on a SOFT-DELETED row, so the merge must null it on the loser
    // BEFORE it can move to the winner. Verify that exact ordering constraint.
    await basePrisma.contact.create({ data: { id: mergeLoser, firstName: "Loser", messengerPsid: psid, deletedAt: new Date() } });
    await basePrisma.contact.create({ data: { id: mergeWinner, firstName: "Winner" } });
    let identityBlocked = false;
    try {
      await basePrisma.contact.update({ where: { id: mergeWinner }, data: { messengerPsid: psid } });
    } catch {
      identityBlocked = true;
    }
    assert.ok(identityBlocked, "a soft-deleted row still occupies the unique identity index");
    await basePrisma.contact.update({ where: { id: mergeLoser }, data: { messengerPsid: null } });
    await basePrisma.contact.update({ where: { id: mergeWinner }, data: { messengerPsid: psid } });
    const identityMoved = await basePrisma.contact.findUnique({ where: { id: mergeWinner }, select: { messengerPsid: true } });
    assert.equal(identityMoved?.messengerPsid, psid, "the identity moves to the winner once the loser releases it");

    // Tenant foundation (multi-tenancy PR1) — fail-closed invariants:
    // (a) the founding tenant is provisioned and the seeded owner is a member
    //     (provisioning MUST create a membership, not lean on a default);
    // (b) no session may reference a tenant its user does not belong to. (b) is
    //     vacuously true until PR1b sets UserSession.tenantId, but encoding it now
    //     means any future regression that grants a session a tenant the user
    //     isn't a member of fails this suite.
    const foundingTenant = await basePrisma.tenant.findUnique({ where: { id: "tenant_denago_cpt" } });
    assert.ok(foundingTenant, "founding Denago tenant must be provisioned");

    const seededOwner = await basePrisma.user.findFirst({ where: { role: "owner" }, select: { id: true } });
    if (seededOwner) {
      const ownerMembership = await basePrisma.tenantMember.findUnique({
        where: { tenantId_userId: { tenantId: "tenant_denago_cpt", userId: seededOwner.id } },
      });
      assert.ok(ownerMembership, "the seeded owner must have a founding-tenant membership");
    }

    const orphanSessions = await basePrisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "UserSession" s
      WHERE s."tenantId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "TenantMember" m
          WHERE m."userId" = s."userId" AND m."tenantId" = s."tenantId"
        )`;
    assert.equal(Number(orphanSessions[0].count), 0, "every session's tenant must belong to that session's user");

    // Fail-closed provisioning: every user must belong to at least one tenant.
    // The migration backfills existing users, seed covers the owner, and
    // createUser grants membership in the same transaction as the user — so a
    // tenantless user (which would resolve to null and be denied tenant access)
    // must never exist.
    const usersWithoutTenant = await basePrisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "User" u
      WHERE NOT EXISTS (SELECT 1 FROM "TenantMember" m WHERE m."userId" = u."id")`;
    assert.equal(Number(usersWithoutTenant[0].count), 0, "every user must belong to at least one tenant (fail-closed provisioning)");

    // Upgrade path — the PRODUCTION scenario the fresh-DB CI run does NOT cover:
    // a user + session that predate the tenant columns must be backfilled. Create a
    // membership-less user + a null-tenant session, replay the migration's
    // idempotent backfill statements exactly (mirrors migration
    // 20260721130000_tenant_foundation), assert both are filled, then clean up.
    const legacyUser = id("legacyUser");
    const legacySession = id("legacySession");
    await basePrisma.user.create({ data: { id: legacyUser, name: "Legacy", email: `${legacyUser}@example.invalid`, passwordHash: "x" } });
    await basePrisma.userSession.create({ data: { id: legacySession, jti: legacySession, userId: legacyUser } });
    await basePrisma.$executeRawUnsafe(
      `INSERT INTO "TenantMember" ("id","tenantId","userId") SELECT 'tm_' || "id", 'tenant_denago_cpt', "id" FROM "User" ON CONFLICT ("tenantId","userId") DO NOTHING`,
    );
    await basePrisma.$executeRawUnsafe(`UPDATE "UserSession" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL`);
    const backfilledMember = await basePrisma.tenantMember.findUnique({ where: { tenantId_userId: { tenantId: "tenant_denago_cpt", userId: legacyUser } } });
    assert.ok(backfilledMember, "migration backfill must add a founding membership for a pre-existing user");
    const backfilledSession = await basePrisma.userSession.findUnique({ where: { id: legacySession }, select: { tenantId: true } });
    assert.equal(backfilledSession?.tenantId, "tenant_denago_cpt", "migration backfill must stamp a pre-existing session");
    await basePrisma.userSession.deleteMany({ where: { id: legacySession } });
    await basePrisma.tenantMember.deleteMany({ where: { userId: legacyUser } });
    await basePrisma.user.deleteMany({ where: { id: legacyUser } });

    // Tenant CONTEXT resolution (used by provisioning): validates active tenant +
    // membership and applies the sole/zero/many rule — never an earliest guess and
    // never a suspended tenant.
    const ctxUser = id("ctxUser");
    const tActive1 = id("tActive1");
    const tActive2 = id("tActive2");
    const tInactive = id("tInactive");
    const importUser = id("importUser");
    await basePrisma.user.create({ data: { id: ctxUser, name: "Ctx", email: `${ctxUser}@example.invalid`, passwordHash: "x" } });
    await basePrisma.tenant.createMany({
      data: [
        { id: tActive1, name: "A1", slug: tActive1, active: true },
        { id: tActive2, name: "A2", slug: tActive2, active: true },
        { id: tInactive, name: "IN", slug: tInactive, active: false },
      ],
    });
    assert.deepEqual(await resolveActingTenant(ctxUser), { error: "no_tenant" }, "no membership → no_tenant");
    await basePrisma.tenantMember.create({ data: { tenantId: tInactive, userId: ctxUser } });
    assert.deepEqual(await resolveActingTenant(ctxUser), { error: "no_tenant" }, "only a SUSPENDED-tenant membership still → no_tenant");
    await basePrisma.tenantMember.create({ data: { tenantId: tActive1, userId: ctxUser } });
    assert.deepEqual(await resolveActingTenant(ctxUser), { tenantId: tActive1 }, "exactly one active membership → that tenant");
    await basePrisma.tenantMember.create({ data: { tenantId: tActive2, userId: ctxUser } });
    assert.deepEqual(await resolveActingTenant(ctxUser), { error: "ambiguous_tenant" }, "two active memberships → ambiguous (never silently pick one)");

    // Shared provisioning service (seed + data import path) creates a founding membership.
    await basePrisma.user.create({ data: { id: importUser, name: "Imp", email: `${importUser}@example.invalid`, passwordHash: "x" } });
    await ensureFoundingMembership(basePrisma, importUser);
    const importMember = await basePrisma.tenantMember.findUnique({ where: { tenantId_userId: { tenantId: "tenant_denago_cpt", userId: importUser } } });
    assert.ok(importMember, "ensureFoundingMembership must create a founding-tenant membership");

    await basePrisma.tenantMember.deleteMany({ where: { userId: { in: [ctxUser, importUser] } } });
    await basePrisma.tenant.deleteMany({ where: { id: { in: [tActive1, tActive2, tInactive] } } });
    await basePrisma.user.deleteMany({ where: { id: { in: [ctxUser, importUser] } } });

    // createUserInOwnerTenant — the createUser provisioning core: atomic
    // user+membership into the owner's LOCKED+validated tenant, plus refuse/rollback.
    const provOwner = id("provOwner");
    const provTenant = id("provTenant");
    const provTenant2 = id("provTenant2");
    const provOwner0 = id("provOwner0");
    await basePrisma.tenant.create({ data: { id: provTenant, name: "ProvT", slug: provTenant, active: true } });
    await basePrisma.user.create({ data: { id: provOwner, name: "ProvOwner", email: `${provOwner}@example.invalid`, passwordHash: "x" } });
    await basePrisma.tenantMember.create({ data: { tenantId: provTenant, userId: provOwner } });

    // success — user + membership committed in the SAME validated tenant
    const newEmail = `${id("provNew")}@example.invalid`;
    const okRes = await createUserInOwnerTenant(provOwner, { name: "New", email: newEmail, passwordHash: "x" });
    assert.ok("tenantId" in okRes && okRes.tenantId === provTenant, "provisions into the owner's tenant");
    const newUser = await basePrisma.user.findUnique({ where: { email: newEmail }, select: { id: true } });
    assert.ok(newUser, "user was created");
    const newMember = await basePrisma.tenantMember.findUnique({ where: { tenantId_userId: { tenantId: provTenant, userId: newUser!.id } } });
    assert.ok(newMember, "membership created atomically in the same validated tenant");

    // rollback + duplicate handling — a duplicate email aborts the tx (persists
    // nothing extra) and is reported as a friendly duplicate_email, not a raw
    // Prisma exception (the concurrent-create UX race).
    const dupRes = await createUserInOwnerTenant(provOwner, { name: "Dup", email: newEmail, passwordHash: "x" });
    assert.ok("error" in dupRes && dupRes.error === "duplicate_email", "duplicate email reported as duplicate_email, not thrown");
    assert.equal(await basePrisma.user.count({ where: { email: newEmail } }), 1, "rollback left exactly the original user (no partial second)");

    // refuse — owner with no active tenant → no_tenant, no user created
    await basePrisma.user.create({ data: { id: provOwner0, name: "NoTenant", email: `${provOwner0}@example.invalid`, passwordHash: "x" } });
    const noneEmail = `${id("provNone")}@example.invalid`;
    assert.deepEqual(await createUserInOwnerTenant(provOwner0, { name: "X", email: noneEmail, passwordHash: "x" }), { error: "no_tenant" }, "owner with no active tenant is refused");
    assert.equal(await basePrisma.user.count({ where: { email: noneEmail } }), 0, "no user created when refused");

    // refuse — ambiguous (owner in two active tenants) → ambiguous_tenant, no user
    await basePrisma.tenant.create({ data: { id: provTenant2, name: "ProvT2", slug: provTenant2, active: true } });
    await basePrisma.tenantMember.create({ data: { tenantId: provTenant2, userId: provOwner } });
    const ambigEmail = `${id("provAmbig")}@example.invalid`;
    const ambigRes = await createUserInOwnerTenant(provOwner, { name: "A", email: ambigEmail, passwordHash: "x" });
    assert.ok("error" in ambigRes && ambigRes.error === "ambiguous_tenant", "ambiguous owner is refused");
    assert.equal(await basePrisma.user.count({ where: { email: ambigEmail } }), 0, "no user created when ambiguous");

    // import atomicity — user + founding membership roll back together on failure,
    // so an import failure can't leave a tenantless user.
    let importRolledBack = false;
    const importFailUser = id("importFail");
    try {
      await basePrisma.$transaction(async (tx) => {
        await tx.user.create({ data: { id: importFailUser, name: "IF", email: `${importFailUser}@example.invalid`, passwordHash: "x" } });
        await ensureFoundingMembership(tx, importFailUser);
        throw new Error("simulated import failure after provisioning");
      });
    } catch {
      importRolledBack = true;
    }
    assert.ok(importRolledBack, "the simulated failure propagates");
    assert.equal(await basePrisma.user.count({ where: { id: importFailUser } }), 0, "import user rolled back — no tenantless user left");

    await basePrisma.tenantMember.deleteMany({ where: { userId: { in: [provOwner, provOwner0, newUser!.id] } } });
    await basePrisma.user.deleteMany({ where: { id: { in: [provOwner, provOwner0, newUser!.id] } } });
    await basePrisma.tenant.deleteMany({ where: { id: { in: [provTenant, provTenant2] } } });

    // createTenant — provisions a brand-new tenant + its first owner + membership
    // atomically (the single source of truth for tenant setup: CLI, future admin
    // UI, isolation tests).
    const ctSlug = id("ctSlug");
    const ctOwnerEmail = `${id("ctOwner")}@example.invalid`;
    const ct = await createTenant(basePrisma, {
      name: "Created Tenant",
      slug: ctSlug,
      owner: { name: "CT Owner", email: ctOwnerEmail, passwordHash: "x" },
    });
    const ctTenant = await basePrisma.tenant.findUnique({ where: { id: ct.tenantId } });
    assert.ok(ctTenant?.active, "createTenant creates an active tenant");
    const ctMember = await basePrisma.tenantMember.findUnique({ where: { tenantId_userId: { tenantId: ct.tenantId, userId: ct.ownerId } } });
    assert.ok(ctMember, "createTenant makes the owner a member of the new tenant");
    assert.deepEqual(await resolveActingTenant(ct.ownerId), { tenantId: ct.tenantId }, "the new owner resolves to exactly the created tenant");
    await basePrisma.tenantMember.deleteMany({ where: { userId: ct.ownerId } });
    await basePrisma.user.deleteMany({ where: { id: ct.ownerId } });
    await basePrisma.tenant.deleteMany({ where: { id: ct.tenantId } });

    console.log("Integrity / IDOR / soft-delete integration tests passed.");
  } finally {
    await basePrisma.contact.deleteMany({ where: { id: { in: [mergeWinner, mergeLoser] } } });
    await basePrisma.otpChallenge.deleteMany({ where: { id: otpId } });
    await basePrisma.quote.deleteMany({ where: { id: quoteId } });
    await basePrisma.partReservation.deleteMany({ where: { id: reservationId } });
    await basePrisma.part.deleteMany({ where: { id: partId } });
    await basePrisma.jobCardItem.deleteMany({ where: { jobCardId: { in: [jobA, jobB] } } });
    await basePrisma.jobCard.deleteMany({ where: { id: { in: [jobA, jobB] } } });
    await basePrisma.vehicle.deleteMany({ where: { id: { in: [vehicleA, vehicleB] } } });
    await basePrisma.contact.deleteMany({ where: { id: { in: [contactA, contactB, trashContact] } } });
    await basePrisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
