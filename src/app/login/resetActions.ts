"use server";

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { after } from "next/server";
import { basePrisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit";
import { logError } from "@/lib/errorLog";
import { PLATFORM_NAME } from "@/lib/platformIdentity";
import { PASSWORD_RULE, validPassword } from "@/lib/passwordPolicy";
import { bumpUserSessionVersion, getUserSecurityStateFresh } from "@/lib/userSecurity";
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
 * "FORGOT PASSWORD?" FOR STAFF (gap audit #25).
 *
 * A 6-digit code by email, then the code + a new password — the same shape as
 * the email sign-in code and the portal login, not a link: nothing to click in a
 * mail client that previews links, and nothing long-lived in a URL.
 *
 * NOTHING HERE TELLS YOU WHETHER AN ACCOUNT EXISTS. The request step answers the
 * same sentence for every email and does the same visible work: the rate limits
 * are registered, and EVERYTHING that depends on the account — the lookup, the
 * code, the email — runs in `after()`, once the response has already gone. The
 * reset step compares against a decoy hash when there is no account or no code.
 *
 * The code is stored hashed, expires in 15 minutes, is single-use (claimed by a
 * compare-and-set), allows 5 wrong tries, and issuing a new one expires the old.
 * A successful reset signs the account out everywhere and does NOT sign you in:
 * you sign in with the new password, so two-factor still applies.
 */

const PURPOSE = "staff_password_reset";
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_TRIES = 5;
/** Same idea as login's TIMING_DECOY_HASH: a real cost-10 hash of a value nobody holds. */
const DECOY_CODE_HASH = "$2b$10$pbT9nTiOVGT2aTwxtXb46.aiRHn5R5wP920Yr7EPGh8U5Vj3O2tsm";

export type ResetState = { sent?: boolean; done?: boolean; error?: string; email?: string };

const normEmail = (value: FormDataEntryValue | null) => String(value ?? "").trim().toLowerCase();
const mask = (email: string) => email.replace(/^(.)[^@]*(@.*)$/, "$1•••$2");

export async function requestPasswordReset(_prev: ResetState | undefined, formData: FormData): Promise<ResetState> {
  const email = normEmail(formData.get("email"));
  if (!email || !email.includes("@")) return { error: "Enter the email you sign in with." };

  const ip = await getRequestIp();
  const [byEmail, byIp] = await Promise.all([
    registerRateLimitAttempt(rateLimitKey("staff-reset-send", email), OTP_SEND_POLICY),
    registerRateLimitAttempt(rateLimitKey("staff-reset-send-ip", ip), LOGIN_POLICY),
  ]);
  if (!byEmail.allowed || !byIp.allowed) {
    return { error: "Too many requests. Wait a few minutes, then try again." };
  }

  // Account-dependent work only after the response is sent (see header).
  after(() => issueResetCode(email).catch((error) => logError("password-reset", error, "Could not issue a reset code")));
  return { sent: true, email };
}

async function issueResetCode(email: string): Promise<void> {
  const user = await basePrisma.user.findUnique({ where: { email }, select: { id: true, name: true, email: true } });
  if (!user) return;
  const security = await getUserSecurityStateFresh(user.id);
  if (!security || security.disabledAt) return;

  const code = crypto.randomInt(100000, 1000000).toString();
  const codeHash = await bcrypt.hash(code, 10);
  // Expire every earlier unused code and issue this one under a per-account lock,
  // so two requests at once can't leave two valid codes.
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`otp:${PURPOSE}:${user.id}`})::bigint)`;
    await tx.otpChallenge.updateMany({
      where: { purpose: PURPOSE, key: user.id, verifiedAt: null },
      data: { expiresAt: new Date() },
    });
    await tx.otpChallenge.create({
      data: { purpose: PURPOSE, key: user.id, codeHash, channel: "email", target: mask(user.email), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
    });
  });
  await sendEmail({
    to: user.email,
    subject: `Your ${PLATFORM_NAME} password reset code`,
    text: `Hi ${user.name},\n\nYour password reset code is ${code}. It expires in 15 minutes.\n\nIf you didn't ask to reset your password, ignore this email — your password hasn't changed.`,
  });
  await logAudit({ action: "security.password_reset_requested", summary: "Password reset code emailed", userName: user.name });
}

export async function resetPasswordWithCode(_prev: ResetState | undefined, formData: FormData): Promise<ResetState> {
  const email = normEmail(formData.get("email"));
  const code = String(formData.get("code") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !/^\d{6}$/.test(code)) return { sent: true, email, error: "Enter the 6-digit code from the email." };
  if (!validPassword(password)) return { sent: true, email, error: `Your new password must be ${PASSWORD_RULE}.` };

  const ip = await getRequestIp();
  const attemptKey = rateLimitKey("staff-reset-verify", `${email}:${ip}`);
  if (!(await checkRateLimit(attemptKey)).allowed) {
    return { sent: true, email, error: "Too many incorrect codes. Request a new code in a few minutes." };
  }

  const user = await basePrisma.user.findUnique({ where: { email }, select: { id: true, name: true, email: true } });
  const security = await getUserSecurityStateFresh(user?.id ?? "0");
  const challenge = user
    ? await basePrisma.otpChallenge.findFirst({
        where: { purpose: PURPOSE, key: user.id, verifiedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
      })
    : null;
  // Always compare, so "no account / no code" costs what a wrong code costs.
  const matches = await bcrypt.compare(code, challenge?.codeHash ?? DECOY_CODE_HASH);
  const usable = Boolean(user && security && !security.disabledAt && challenge && challenge.attempts < MAX_TRIES);

  if (!usable || !matches) {
    await registerRateLimitAttempt(attemptKey, OTP_VERIFY_POLICY);
    if (challenge) await basePrisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
    return { sent: true, email, error: "That code isn't right or has expired. Check the email, or request a new code." };
  }

  // Single use: only one request can claim the code.
  const claimed = await basePrisma.otpChallenge.updateMany({
    where: { id: challenge!.id, verifiedAt: null },
    data: { verifiedAt: new Date() },
  });
  if (claimed.count !== 1) return { sent: true, email, error: "That code has already been used. Request a new one." };

  const passwordHash = await bcrypt.hash(password, 12);
  await basePrisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user!.id },
      data: { passwordHash, passwordChangedAt: new Date(), loginOtpHash: null, loginOtpExpires: null },
    });
    // Signed out everywhere — every session on the old password stops working.
    await bumpUserSessionVersion(user!.id, tx);
  });
  await Promise.all([clearRateLimit(attemptKey), clearRateLimit(rateLimitKey("staff-reset-send", email))]);
  await logAudit({ action: "security.password_reset_self", summary: "Password reset with an emailed code; all sessions signed out", userName: user!.name });
  // Tell the owner of the inbox, in case it wasn't them.
  after(() =>
    sendEmail({
      to: user!.email,
      subject: `Your ${PLATFORM_NAME} password was changed`,
      text: `Hi ${user!.name},\n\nYour password was just reset, and you've been signed out on every device.\n\nIf this wasn't you, contact your administrator straight away.`,
    }).catch(() => {}),
  );
  return { done: true };
}
