"use server";

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { basePrisma } from "@/lib/db";
import { createSessionCookie, destroySessionCookie } from "@/lib/auth";
import { verifySession, SESSION_COOKIE } from "@/lib/session";
import { logError } from "@/lib/errorLog";
import { verifyTotp } from "@/lib/totp";
import { matchBackupCode } from "@/lib/backupCodes";
import { decryptValue } from "@/lib/settings";
import { sendEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit";
import {
  LOGIN_POLICY,
  OTP_SEND_POLICY,
  OTP_VERIFY_POLICY,
  checkRateLimit,
  clearRateLimit,
  getRequestIp,
  rateLimitKey,
  registerRateLimitAttempt,
} from "@/lib/rateLimit";

/**
 * A real bcrypt hash, at the same cost factor as a real password (12), of a
 * random value nobody holds — so no submitted password can ever match it.
 *
 * Its only job is to make the sign-in path spend identical work whether or not
 * the email exists. See the comparison in `signIn` for why that matters.
 * Hardcoded rather than generated at boot: a fresh hash per process costs ~100ms
 * of cold start, and there is nothing secret about a hash of a value that was
 * discarded the moment it was printed.
 */
const TIMING_DECOY_HASH = "$2b$12$sOeVwx/GKaLIJ4GYSEES7eWTdhS7Lmf0C/kB7jE/A7Gm.9ea5YVbe";

/**
 * A user id that cannot exist, so the failed-login `UPDATE` can run on the path
 * where there is no user and match nothing.
 *
 * Ids in this schema are cuids; a bare zero string is not one and never
 * collides. See the failure branch in `signIn` for why the statement runs at
 * all when there is nobody to record against.
 */
const NO_SUCH_USER_ID = "0";
import {
  bumpUserSessionVersion,
  getUserSecurityState,
  recordFailedLogin,
  recordSuccessfulLogin,
} from "@/lib/userSecurity";

const PENDING_COOKIE = "denago_2fa_pending";

const pendingSecret = () => {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET is not set (or too short) in production.");
    }
    return new TextEncoder().encode("dev-secret-local-only");
  }
  return new TextEncoder().encode(secret);
};

async function issuePending(userId: string, pwa: boolean) {
  const token = await new SignJWT({ uid: userId, pwa })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(pendingSecret());
  const store = await cookies();
  store.set(PENDING_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
}
async function readPending(): Promise<{ uid: string; pwa: boolean } | null> {
  const store = await cookies();
  const token = store.get(PENDING_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, pendingSecret());
    return typeof payload.uid === "string"
      ? { uid: payload.uid, pwa: payload.pwa === true }
      : null;
  } catch {
    return null;
  }
}

export type LoginState = { error?: string; need2fa?: boolean; methods?: string[] };

export async function login(
  _prev: LoginState | undefined,
  formData: FormData
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const pwa = formData.get("pwa") === "1"; // installed app → 7-day session
  if (!email || !password) return { error: "Email and password are required." };

  const ip = await getRequestIp();
  const accountKey = rateLimitKey("staff-login-account", email);
  const ipKey = rateLimitKey("staff-login-ip", ip);
  const [accountState, ipState] = await Promise.all([
    checkRateLimit(accountKey),
    checkRateLimit(ipKey),
  ]);
  if (!accountState.allowed || !ipState.allowed) {
    return { error: "Too many failed attempts. Try again later." };
  }

  const user = await basePrisma.user.findUnique({ where: { email } });
  /*
   * THE SECURITY READ IS UNCONDITIONAL, for the same reason the hash comparison
   * below is.
   *
   * This was `user ? await getUserSecurityState(user.id) : null`, so a known
   * email cost a database round trip that an unknown email did not. With
   * bcrypt's ~100ms difference removed (below), that residue became the
   * measurable signal instead — smaller, but the same class of leak, and enough
   * to keep the claim of "identical work" false.
   *
   * Passing a sentinel id keeps the query, its plan and its round trip on both
   * paths; it simply matches no row and returns null, which the check below
   * already treats as "cannot sign in".
   *
   * (The wasted read is real — these four columns live on the "User" row the
   * `findUnique` above already fetched — but they are not on the Prisma model,
   * so removing it means modelling them first. That is a refactor, not a
   * security fix, and it would change this file's behaviour for the OTP paths
   * too. Symmetry is what the timing needs; the extra read is a cost both
   * branches now pay equally.)
   */
  const security = await getUserSecurityState(user?.id ?? NO_SUCH_USER_ID);
  /*
   * THE COMPARISON ALWAYS RUNS, even when there is no such user.
   *
   * `user && … && await bcrypt.compare(…)` short-circuits, so an unknown email
   * skipped bcrypt entirely and answered in a fraction of the time a known one
   * took — bcrypt at cost 12 is deliberately ~100ms. That is a user-enumeration
   * oracle measurable over the network, and it defeated the point of the
   * uniform "Invalid email or password." message below: the wording said
   * nothing, the timing said which.
   *
   * Hashing the supplied password against a fixed decoy costs the same work and
   * discards the result. The decoy is a real cost-12 hash of a value nobody can
   * present, so it cannot be matched — `bcrypt.compare` returning false here is
   * the only outcome, and it returns it in the same time a genuine mismatch
   * would take.
   */
  const passwordMatches = await bcrypt.compare(password, user?.passwordHash ?? TIMING_DECOY_HASH);
  const passwordOk = Boolean(user && security && !security.disabledAt && passwordMatches);

  if (!user || !passwordOk) {
    /*
     * THE FAILURE ACCOUNTING RUNS FOR BOTH, and that is the point.
     *
     * `user ? recordFailedLogin(user.id) : Promise.resolve()` performed an
     * `UPDATE` for a known email and nothing at all for an unknown one — a
     * second, smaller timing signal underneath the bcrypt one, and the reason
     * "identical work" was not yet true after the decoy hash was added.
     *
     * Passing a sentinel id keeps the statement, its plan and its round trip on
     * both paths; it simply matches no row. Honest limit, stated rather than
     * glossed: an `UPDATE` touching zero rows still skips the heap write and
     * the WAL record, so the two are very close rather than provably equal.
     * The remaining difference is a fraction of one round trip, against an
     * endpoint rate-limited per account AND per IP.
     */
    await Promise.all([
      registerRateLimitAttempt(accountKey, LOGIN_POLICY),
      registerRateLimitAttempt(ipKey, LOGIN_POLICY),
      recordFailedLogin(user?.id ?? NO_SUCH_USER_ID),
    ]);
    return { error: "Invalid email or password." };
  }

  await clearRateLimit(accountKey);
  const hasTotp = Boolean(user.totpEnabledAt && user.totpSecret);
  if (hasTotp || user.emailOtpEnabled) {
    await issuePending(user.id, pwa);
    const methods: string[] = [];
    if (hasTotp) methods.push("totp");
    if (user.emailOtpEnabled) methods.push("email");
    if (!hasTotp && user.emailOtpEnabled) await sendLoginEmailCode(user.id);
    return { need2fa: true, methods };
  }

  await recordSuccessfulLogin(user.id);
  await createSessionCookie(user, { pwa });
  redirect("/");
}

async function sendLoginEmailCode(userId: string): Promise<boolean> {
  const user = await basePrisma.user.findUnique({ where: { id: userId } });
  const security = user ? await getUserSecurityState(user.id) : null;
  if (!user?.email || !security || security.disabledAt) return false;

  const key = rateLimitKey("staff-email-otp-send", userId);
  const result = await registerRateLimitAttempt(key, OTP_SEND_POLICY);
  if (!result.allowed) return false;

  const code = crypto.randomInt(100000, 1000000).toString();
  await basePrisma.user.update({
    where: { id: userId },
    data: {
      loginOtpHash: await bcrypt.hash(code, 10),
      loginOtpExpires: new Date(Date.now() + 10 * 60 * 1000),
    },
  });
  await sendEmail({
    to: user.email,
    subject: "Your Denago CRM sign-in code",
    text: `Your sign-in code is ${code}. It expires in 10 minutes. If this wasn't you, change your password.`,
  }).catch(() => {});
  return true;
}

export async function requestEmailCode(): Promise<{ ok?: boolean; error?: string }> {
  const pending = await readPending();
  if (!pending) return { error: "Session expired — please sign in again." };
  const sent = await sendLoginEmailCode(pending.uid);
  return sent
    ? { ok: true }
    : { error: "A code was sent recently. Wait a few minutes before requesting another." };
}

export async function verifySecondFactor(
  _prev: { error?: string } | undefined,
  formData: FormData
): Promise<{ error?: string }> {
  const pending = await readPending();
  if (!pending) return { error: "Session expired — please sign in again." };
  const uid = pending.uid;

  // Rate-limit the second factor too — the 6-digit code must not be brute-forceable.
  const ip = await getRequestIp();
  const attemptKey = rateLimitKey("staff-2fa", `${uid}:${ip}`);
  if (!(await checkRateLimit(attemptKey)).allowed) {
    return { error: "Too many incorrect codes. Try again later." };
  }

  const code = String(formData.get("code") ?? "").trim();
  const user = await basePrisma.user.findUnique({ where: { id: uid } });
  const security = user ? await getUserSecurityState(user.id) : null;
  if (!user || !security || security.disabledAt) {
    return { error: "Session expired — please sign in again." };
  }

  let ok = false;
  if (user.totpEnabledAt && user.totpSecret) {
    try {
      if (verifyTotp(code, decryptValue(user.totpSecret))) ok = true;
    } catch {}
  }
  if (!ok && user.loginOtpHash && user.loginOtpExpires && user.loginOtpExpires > new Date()) {
    if (await bcrypt.compare(code, user.loginOtpHash)) ok = true;
  }
  if (!ok && user.totpBackupCodes) {
    const match = await matchBackupCode(user.totpBackupCodes, code);
    if (match) {
      // COMPARE-AND-SWAP, not read-modify-write. The old code parsed the list,
      // spliced the used entry out and wrote it back, so two requests arriving
      // together both matched the same code, both wrote the same shortened list
      // and both were handed a session — one single-use code, two sign-ins.
      //
      // Conditioning the update on the exact value that was read means the
      // second writer matches no row. Losing that race is treated as a failed
      // code rather than a retry: the code really has been spent, just not by
      // this request.
      const claimed = await basePrisma.user.updateMany({
        where: { id: user.id, totpBackupCodes: user.totpBackupCodes },
        data: { totpBackupCodes: match.remainingJson },
      });
      if (claimed.count === 1) {
        await logAudit({
          action: "auth.backup_code_used",
          summary: `Backup code used to sign in (${match.remaining.length} remaining)`,
          userName: user.name,
        });
        ok = true;
      }
    }
  }

  if (!ok) {
    await Promise.all([
      registerRateLimitAttempt(attemptKey, OTP_VERIFY_POLICY),
      recordFailedLogin(user.id),
    ]);
    return { error: "That code isn't right. Try again, or use a backup code." };
  }

  await Promise.all([
    clearRateLimit(attemptKey),
    clearRateLimit(rateLimitKey("staff-email-otp-send", user.id)),
  ]);
  await basePrisma.user.update({
    where: { id: user.id },
    data: { loginOtpHash: null, loginOtpExpires: null },
  });
  await recordSuccessfulLogin(user.id);
  const store = await cookies();
  store.delete(PENDING_COOKIE);
  await createSessionCookie(user, { pwa: pending.pwa });
  redirect("/");
}

export async function logout() {
  // Declared out here so the catch can still identify WHO failed to log out — the
  // fallback below needs the user id, and it is only reachable on the error path.
  let session: Awaited<ReturnType<typeof verifySession>> | null = null;
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    session = token ? await verifySession(token) : null;
    if (session?.jti) {
      await basePrisma.userSession.updateMany({
        where: { jti: session.jti },
        data: { revokedAt: new Date() },
      });
    }
  } catch (err) {
    // A FAILED REVOCATION IS INVISIBLE TO THE PERSON IT AFFECTS.
    //
    // The cookie is cleared and the redirect happens either way, so the UI says
    // "signed out" whether or not the session was actually revoked. If this write
    // failed, the token stays valid server-side until it expires — which matters on
    // a shared machine, and matters more if the token was ever copied. Revocation
    // IS the protection; the cookie delete only hides the token from this browser.
    //
    // So it still fails open — deliberately, because stranding someone on a page
    // they cannot leave is worse — but it no longer fails SILENTLY.
    await logError(
      "logout",
      err,
      "Session revocation failed; falling back to a session-version bump so the token cannot be reused.",
    );

    // ESCALATE RATHER THAN LEAVE A LIVE TOKEN BEHIND.
    //
    // Revoking this one jti failed, so bump the user's sessionVersion instead:
    // getCurrentUser compares `security.sessionVersion !== session.sv` on every
    // request, so every token this user holds — including the one we just failed
    // to revoke — stops validating immediately.
    //
    // It is a bigger hammer, and that is the right trade on THIS path: it only
    // runs when a logout has already failed, and being signed out of your other
    // devices is a far better outcome than believing you signed out while the
    // token stays live. Someone who did not intend it just signs in again.
    //
    // Best-effort in turn — if the first write failed because the database is
    // unreachable, this one probably fails too. It is logged separately so the
    // System Log distinguishes "revocation failed but we closed the hole" from
    // "revocation failed and the token is still live".
    try {
      if (session?.sub) await bumpUserSessionVersion(session.sub);
    } catch (bumpErr) {
      await logError(
        "logout",
        bumpErr,
        "Session-version fallback ALSO failed — this token remains valid until it expires. Revoke the device from Settings → Security.",
      );
    }
  }
  await destroySessionCookie();
  redirect("/login");
}
