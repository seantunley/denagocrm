"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { basePrisma } from "@/lib/db";
import { createPlatformSessionCookie, destroyPlatformSessionCookie } from "@/lib/platformAuth";
import {
  LOGIN_POLICY,
  checkRateLimit,
  clearRateLimit,
  getRequestIp,
  rateLimitKey,
  registerRateLimitAttempt,
} from "@/lib/rateLimit";

export type PlatformLoginState = { error?: string };

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

  await basePrisma.platformAdmin.update({
    where: { id: admin!.id },
    data: { lastLoginAt: new Date() },
  });

  await createPlatformSessionCookie({
    id: admin!.id,
    name: admin!.name,
    email: admin!.email,
    sessionVersion: admin!.sessionVersion,
  });

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
