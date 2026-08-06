"use server";

import bcrypt from "bcryptjs";
import { matchBackupCode } from "@/lib/backupCodes";
import { redirect } from "next/navigation";
import { basePrisma } from "@/lib/db";
import { createPlatformSessionCookie, destroyPlatformSessionCookie } from "@/lib/platformAuth";
import { clearPlatformPending, issuePlatformPending, readPlatformPending } from "@/lib/platformPending";
import { verifyTotp } from "@/lib/totp";
import { decryptValue } from "@/lib/settings";
import { logAuditStrict } from "@/lib/audit";
import {
  LOGIN_POLICY,
  checkRateLimit,
  clearRateLimit,
  getRequestIp,
  rateLimitKey,
  registerRateLimitAttempt,
} from "@/lib/rateLimit";

export type PlatformLoginState = {
  error?: string;
  /** The password was right and this account has an authenticator enrolled. */
  need2fa?: boolean;
};

/**
 * Platform-console login. Deliberately separate from the CRM's staff login: it
 * authenticates against `PlatformAdmin`, not `User`, so console access is not
 * derived from any tenant membership or CRM role.
 *
 * Rate-limit keys are namespaced away from the staff login ("platform-login-*"),
 * so console attempts and CRM attempts don't consume each other's budget — and a
 * lockout on one surface doesn't silently lock the other.
 */
export async function platformLogin(
  _prev: PlatformLoginState,
  formData: FormData,
): Promise<PlatformLoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Email and password are required." };

  const ip = await getRequestIp();
  const accountKey = rateLimitKey("platform-login-account", email);
  const ipKey = rateLimitKey("platform-login-ip", ip);
  const [accountState, ipState] = await Promise.all([
    checkRateLimit(accountKey),
    checkRateLimit(ipKey),
  ]);
  if (!accountState.allowed || !ipState.allowed) {
    return { error: "Too many failed attempts. Try again later." };
  }

  const admin = await basePrisma.platformAdmin.findUnique({ where: { email } });

  // Compare against a dummy hash when the account is missing so a non-existent
  // email costs the same time as a wrong password — otherwise response timing
  // enumerates which platform-admin addresses exist.
  const hash = admin?.passwordHash ?? DUMMY_HASH;
  const passwordMatches = await bcrypt.compare(password, hash);
  const passwordOk = Boolean(admin && !admin.disabledAt && passwordMatches);

  if (!passwordOk) {
    await Promise.all([
      registerRateLimitAttempt(accountKey, LOGIN_POLICY),
      registerRateLimitAttempt(ipKey, LOGIN_POLICY),
    ]);
    // One message for every failure mode (unknown email, wrong password,
    // disabled account) — a distinct "account disabled" reply would confirm the
    // address exists.
    return { error: "Invalid email or password." };
  }

  await clearRateLimit(accountKey);

  // THE SECOND FACTOR. A correct password stops here when one is enrolled — no
  // session cookie is issued, `lastLoginAt` is not stamped, and nothing is
  // recorded as a sign-in, because none of that has happened yet.
  //
  // The pending cookie carries the admin id and is signed; the verify step
  // re-reads the row rather than trusting anything cached in it.
  if (admin!.totpEnabledAt && admin!.totpSecret) {
    await issuePlatformPending(admin!.id);
    return { need2fa: true };
  }

  await completePlatformLogin(admin!);
  redirect("/platform/tenants");
}

/**
 * Issue the session. The ONE place a platform session is created after a
 * successful login, so the password-only path and the two-factor path cannot
 * drift on what "signed in" means.
 */
async function completePlatformLogin(admin: {
  id: string;
  name: string;
  email: string;
  sessionVersion: number;
}): Promise<void> {
  await basePrisma.platformAdmin.update({
    where: { id: admin.id },
    data: { lastLoginAt: new Date() },
  });
  await createPlatformSessionCookie({
    id: admin.id,
    name: admin.name,
    email: admin.email,
    sessionVersion: admin.sessionVersion,
  });
}

/**
 * Verify the second factor and finish the login.
 *
 * Accepts an authenticator code or a one-time backup code. Deliberately NOT an
 * emailed code: the CRM offers one, and adding it here would make the account
 * that governs every tenant only as strong as somebody's mailbox. A platform
 * admin who loses both their authenticator and their backup codes is recovered
 * by hand, which is the correct amount of friction for this account.
 */
export async function platformVerifyTotp(
  _prev: PlatformLoginState,
  formData: FormData,
): Promise<PlatformLoginState> {
  const adminId = await readPlatformPending();
  if (!adminId) return { error: "That took too long — please sign in again." };

  // The six digits are rate-limited in their own right. Without this the pending
  // cookie is a ten-minute window to try a million codes at whatever rate the
  // network allows, which is not a second factor.
  const ip = await getRequestIp();
  const attemptKey = rateLimitKey("platform-2fa", `${adminId}:${ip}`);
  if (!(await checkRateLimit(attemptKey)).allowed) {
    return { error: "Too many incorrect codes. Try again later.", need2fa: true };
  }

  const code = String(formData.get("code") ?? "").trim();
  const admin = await basePrisma.platformAdmin.findUnique({ where: { id: adminId } });
  // Re-checked here, not just at the password step: an account disabled in the
  // ten minutes between the two steps must not be able to finish signing in.
  if (!admin || admin.disabledAt || !admin.totpEnabledAt || !admin.totpSecret) {
    await clearPlatformPending();
    return { error: "That took too long — please sign in again." };
  }

  let ok = false;
  try {
    ok = verifyTotp(code, decryptValue(admin.totpSecret));
  } catch {
    // A secret that will not decrypt means the encryption key changed. Fall
    // through to the backup codes rather than locking the account out entirely.
  }

  if (!ok && admin.totpBackupCodes) {
    const match = await matchBackupCode(admin.totpBackupCodes, code);
    if (match) {
      // SPENT BEFORE THE SESSION IS ISSUED, and spent exactly once.
      //
      // Consuming afterwards would leave the code reusable if anything below
      // threw. Read-modify-write would let two requests arriving together match
      // the same code, write the same shortened list and both receive a session
      // — one single-use credential, two sign-ins. Conditioning the update on
      // the exact value read means the second writer matches no row; losing that
      // race is treated as a failed code, because the code really has been
      // spent, just not by this request.
      const claimed = await basePrisma.platformAdmin.updateMany({
        where: { id: admin.id, totpBackupCodes: admin.totpBackupCodes },
        data: { totpBackupCodes: match.remainingJson },
      });
      if (claimed.count === 1) {
        await logAuditStrict({
          action: "platform.backup_code_used",
          summary: `Platform backup code used to sign in (${match.remaining.length} remaining)`,
          entityType: "PlatformAdmin",
          entityId: admin.id,
          userName: admin.name,
          actorType: "platform_admin",
          metadata: { platformAdminId: admin.id, platformAdminEmail: admin.email, remaining: match.remaining.length },
        });
        ok = true;
      }
    }
  }

  if (!ok) {
    await registerRateLimitAttempt(attemptKey, LOGIN_POLICY);
    return { error: "That code isn't right. Try again, or use a backup code.", need2fa: true };
  }

  await clearRateLimit(attemptKey);
  await clearPlatformPending();
  await completePlatformLogin(admin);
  redirect("/platform/tenants");
}

export async function platformLogout(): Promise<void> {
  await destroyPlatformSessionCookie();
  redirect("/platform/login");
}

/**
 * A real bcrypt hash of a value nobody can supply, used only to equalise timing on
 * the unknown-account path.
 *
 * The COST MUST MATCH the cost real platform passwords are hashed at (12, see
 * scripts/create-platform-admin.ts). A cheaper dummy defeats the whole point: a
 * cost-10 compare returns roughly four times faster than a cost-12 one, so
 * response timing would still separate "no such admin" from "wrong password".
 */
const DUMMY_HASH = "$2b$12$SlH72I15J7MY7idR9GgLVOSKEVoACg5NXIqsb7mBiB5e4LRQD3zEa";
