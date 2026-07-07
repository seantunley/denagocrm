"use server";

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { prisma } from "@/lib/db";
import { createSessionCookie, destroySessionCookie } from "@/lib/auth";
import { verifyTotp } from "@/lib/totp";
import { decryptValue } from "@/lib/settings";
import { sendEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit";

// Brute-force protection: max 5 failed attempts per account per 15 minutes.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const failedAttempts = new Map<string, { count: number; first: number }>();

function isLockedOut(key: string): boolean {
  const entry = failedAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    failedAttempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}
function recordFailure(key: string) {
  const entry = failedAttempts.get(key);
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    failedAttempts.set(key, { count: 1, first: Date.now() });
  } else {
    entry.count++;
  }
}

// Short-lived signed cookie that proves "password OK, awaiting 2nd factor".
const PENDING_COOKIE = "denago_2fa_pending";
const pendingSecret = () =>
  new TextEncoder().encode(process.env.SESSION_SECRET ?? "dev-secret-local-only");

async function issuePending(userId: string) {
  const token = await new SignJWT({ uid: userId })
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
async function readPending(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(PENDING_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, pendingSecret());
    return typeof payload.uid === "string" ? payload.uid : null;
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
  if (!email || !password) return { error: "Email and password are required." };
  if (isLockedOut(email)) return { error: "Too many failed attempts. Try again in 15 minutes." };

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    recordFailure(email);
    return { error: "Invalid email or password." };
  }
  failedAttempts.delete(email);

  const hasTotp = Boolean(user.totpEnabledAt && user.totpSecret);
  if (hasTotp || user.emailOtpEnabled) {
    await issuePending(user.id);
    const methods: string[] = [];
    if (hasTotp) methods.push("totp");
    if (user.emailOtpEnabled) methods.push("email");
    if (!hasTotp && user.emailOtpEnabled) await sendLoginEmailCode(user.id);
    return { need2fa: true, methods };
  }

  await createSessionCookie(user);
  redirect("/");
}

async function sendLoginEmailCode(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email) return;
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
}

/** Request the email code from the 2FA screen. */
export async function requestEmailCode(): Promise<{ ok?: boolean; error?: string }> {
  const uid = await readPending();
  if (!uid) return { error: "Session expired — please sign in again." };
  await sendLoginEmailCode(uid);
  return { ok: true };
}

export async function verifySecondFactor(
  _prev: { error?: string } | undefined,
  formData: FormData
): Promise<{ error?: string }> {
  const uid = await readPending();
  if (!uid) return { error: "Session expired — please sign in again." };
  const code = String(formData.get("code") ?? "").trim();
  const user = await prisma.user.findUnique({ where: { id: uid } });
  if (!user) return { error: "Session expired — please sign in again." };

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
    for (let i = 0; i < codes.length; i++) {
      if (await bcrypt.compare(normalized, codes[i])) {
        codes.splice(i, 1);
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

  if (!ok) return { error: "That code isn't right. Try again, or use a backup code." };

  await prisma.user.update({
    where: { id: user.id },
    data: { loginOtpHash: null, loginOtpExpires: null },
  });
  const store = await cookies();
  store.delete(PENDING_COOKIE);
  await createSessionCookie(user);
  redirect("/");
}

export async function logout() {
  await destroySessionCookie();
  redirect("/login");
}
