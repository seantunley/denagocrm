import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  LOGIN_POLICY,
  checkRateLimit,
  clearRateLimit,
  rateLimitKey,
  refundRateLimitAttempt,
  registerRateLimitAttempt,
  reserveRateLimitAttempt,
} from "../src/lib/rateLimit";
import {
  bumpUserSessionVersion,
  getUserSecurityState,
  setUserDisabledState,
} from "../src/lib/userSecurity";
import { signFreshSession, verifySession } from "../src/lib/session";

const prisma = new PrismaClient();

async function expectDatabaseRejection(operation: () => Promise<unknown>, label: string) {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true, label);
}

async function main() {
  const suffix = crypto.randomUUID();
  const userId = `security-test-${suffix}`;
  const email = `security-test-${suffix}@example.invalid`;
  const limiterKey = rateLimitKey("security-integration", suffix);
  const auditId = `security-test-audit-${suffix}`;

  await prisma.$executeRaw`
    INSERT INTO "User" ("id", "name", "email", "passwordHash", "role", "modules")
    VALUES (${userId}, 'Security Test', ${email}, 'not-a-real-password-hash', 'member', 'crm')
  `;

  try {
    await clearRateLimit(limiterKey);
    for (let attempt = 1; attempt < LOGIN_POLICY.limit; attempt++) {
      const result = await registerRateLimitAttempt(limiterKey, LOGIN_POLICY);
      assert.equal(result.allowed, true, `attempt ${attempt} should still be allowed`);
    }
    const blocked = await registerRateLimitAttempt(limiterKey, LOGIN_POLICY);
    assert.equal(blocked.allowed, false, "the threshold attempt must block the key");
    assert.equal((await checkRateLimit(limiterKey)).allowed, false, "blocked state must persist in PostgreSQL");
    await clearRateLimit(limiterKey);
    assert.equal((await checkRateLimit(limiterKey)).allowed, true, "clearing a limiter must restore access");

    // A BURST cannot beat the limit (security audit 2026-10-25). Guesses are
    // counted before they are checked, under the key's lock, so of 25 sent at
    // once exactly LOGIN_POLICY.limit get through to be checked.
    const burstKey = rateLimitKey("security-burst", suffix);
    const burst = await Promise.all(Array.from({ length: 25 }, () => reserveRateLimitAttempt(burstKey, LOGIN_POLICY)));
    assert.equal(burst.filter((r) => r.allowed).length, LOGIN_POLICY.limit, "a burst gets exactly `limit` guesses checked");
    assert.equal((await checkRateLimit(burstKey)).allowed, false, "and leaves the key blocked");
    await clearRateLimit(burstKey);

    // A RIGHT guess gives its count back, so the limit still means `limit` WRONG guesses.
    const refundKey = rateLimitKey("security-refund", suffix);
    for (let wrong = 1; wrong < LOGIN_POLICY.limit; wrong++) {
      assert.equal((await reserveRateLimitAttempt(refundKey, LOGIN_POLICY)).allowed, true);
    }
    // The next guess reaches the limit (and sets the block) — but it is right.
    assert.equal((await reserveRateLimitAttempt(refundKey, LOGIN_POLICY)).allowed, true);
    await refundRateLimitAttempt(refundKey, LOGIN_POLICY);
    assert.equal((await checkRateLimit(refundKey)).allowed, true, "a right guess must not leave the key blocked");
    // One more wrong guess is still allowed (that is wrong guess number `limit`), then the key blocks.
    assert.equal((await reserveRateLimitAttempt(refundKey, LOGIN_POLICY)).allowed, true);
    assert.equal((await reserveRateLimitAttempt(refundKey, LOGIN_POLICY)).allowed, false, "wrong guesses past the limit are refused");
    await clearRateLimit(refundKey);

    const initial = await getUserSecurityState(userId);
    assert.equal(initial?.sessionVersion, 0);
    assert.equal(initial?.disabledAt, null);

    const token = await signFreshSession(
      {
        id: userId,
        name: "Security Test",
        email,
        role: "member",
        grants: "",
        sessionVersion: initial?.sessionVersion ?? 0,
      },
      60
    );
    const payload = await verifySession(token);
    assert.equal(payload?.sv, 0, "session token must contain the database session version");

    const nextVersion = await bumpUserSessionVersion(userId);
    assert.equal(nextVersion, 1);
    const afterBump = await getUserSecurityState(userId);
    assert.notEqual(payload?.sv, afterBump?.sessionVersion, "bumped versions must invalidate older tokens");

    await setUserDisabledState(userId, true);
    const disabled = await getUserSecurityState(userId);
    assert.ok(disabled?.disabledAt, "disabling a user must persist a timestamp");
    assert.equal(disabled?.sessionVersion, 2, "disabling a user must revoke active sessions");

    const requiredAdminPermissions = [
      "roles.view",
      "roles.manage",
      "teams.view",
      "teams.manage",
      "audit.view",
      "audit.export",
    ];
    const adminPermissions = await prisma.$queryRaw<Array<{ permissionKey: string }>>`
      SELECT "permissionKey" FROM "RolePermission" WHERE "roleId" = 'role_crm_admin'
    `;
    const adminSet = new Set(adminPermissions.map((item) => item.permissionKey));
    for (const permission of requiredAdminPermissions) {
      assert.equal(adminSet.has(permission), true, `CRM administrator is missing ${permission}`);
    }

    await prisma.$executeRaw`
      INSERT INTO "AuditEvent" (
        "id", "actorName", "actorType", "eventType", "entityType", "entityId", "summary"
      ) VALUES (
        ${auditId}, 'Security test', 'system', 'security.integration_test', 'User', ${userId}, 'Audit immutability test'
      )
    `;
    await expectDatabaseRejection(
      () => prisma.$executeRaw`UPDATE "AuditEvent" SET "summary" = 'mutated' WHERE "id" = ${auditId}`,
      "AuditEvent UPDATE must be rejected"
    );
    await expectDatabaseRejection(
      () => prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE "id" = ${auditId}`,
      "AuditEvent DELETE must be rejected"
    );

    console.log("Security integration tests passed.");
  } finally {
    await clearRateLimit(limiterKey);
    await prisma.$executeRaw`DELETE FROM "UserRole" WHERE "userId" = ${userId}`;
    await prisma.$executeRaw`DELETE FROM "TeamMember" WHERE "userId" = ${userId}`;
    await prisma.$executeRaw`DELETE FROM "User" WHERE "id" = ${userId}`;
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
