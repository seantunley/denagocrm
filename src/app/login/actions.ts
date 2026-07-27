"use server";

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { prisma, basePrisma } from "@/lib/db";
import { createSessionCookie, destroySessionCookie } from "@/lib/auth";
import { verifySession, SESSION_COOKIE } from "@/lib/session";
import { verifyTotp } from "@/lib/totp";
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
import {
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

  const user = await prisma.user.findUnique({ where: { email } });
  const security = user ? await getUserSecurityState(user.id) : null;
  const passwordOk = Boolean(user && security && !security.disabledAt && await bcrypt.compare(password, user.passwordHash));

  if (!user || !passwordOk) {
    await Promise.all([
      registerRateLimitAttempt(accountKey, LOGIN_POLICY),
      registerRateLimitAttempt(ipKey, LOGIN_POLICY),
      user ? recordFailedLogin(user.id) : Promise.resolve(),
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
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const security = user ? await getUserSecurityState(user.id) : null;
  if (!user?.email || !security || security.disabledAt) return false;

  const key = rateLimitKey("staff-email-otp-send", userId);
  const result = await registerRateLimitAttempt(key, OTP_SEND_POLICY);
  if (!result.allowed) return false;

  const code = crypto.randomInt(100000, 1000000).toString();
  await prisma.user.update({
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
  const user = await prisma.user.findUnique({ where: { id: uid } });
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
    const codes: string[] = JSON.parse(user.totpBackupCodes);
    const normalized = code.toUpperCase().replace(/\s/g, "");
    for (let index = 0; index < codes.length; index++) {
      if (await bcrypt.compare(normalized, codes[index])) {
        codes.splice(index, 1);
        await prisma.user.update({
          where: { id: user.id },
          data: { totpBackupCodes: JSON.stringify(codes) },
        });
        await logAudit({
          action: "auth.backup_code_used",
          summary: `Backup code used to sign in (${codes.length} remaining)`,
          userName: user.name,
        });
        ok = true;
        break;
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
  await prisma.user.update({
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
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    const session = token ? await verifySession(token) : null;
    if (session?.jti) {
      await basePrisma.userSession.updateMany({
        where: { jti: session.jti },
        data: { revokedAt: new Date() },
      });
    }
  } catch {}
  await destroySessionCookie();
  redirect("/login");
}
