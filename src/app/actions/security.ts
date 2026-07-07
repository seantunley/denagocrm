"use server";

import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser, requireOwner } from "@/lib/auth";
import { encryptValue, decryptValue, putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import {
  generateTotpSecret,
  totpKeyUri,
  verifyTotp,
  generateBackupCodes,
} from "@/lib/totp";

/** Step 1 of enrolment: mint a secret and return the QR to scan. */
export async function beginTotpEnrolment(): Promise<{
  secret: string;
  qr: string;
  uri: string;
}> {
  const user = await requireUser();
  const secret = generateTotpSecret();
  const uri = totpKeyUri(secret, user.email);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  // Stash the un-confirmed secret (encrypted); confirmed only after a code check
  await prisma.user.update({
    where: { id: user.id },
    data: { totpSecret: encryptValue(secret), totpEnabledAt: null },
  });
  return { secret, qr, uri };
}

export type SecurityState = { error?: string; ok?: string; backupCodes?: string[] };

/** Step 2: confirm a code to switch 2FA on, returning one-time backup codes. */
export async function confirmTotpEnrolment(
  _prev: SecurityState | undefined,
  formData: FormData
): Promise<SecurityState> {
  const user = await requireUser();
  const code = String(formData.get("code") ?? "").trim();
  if (!user.totpSecret) return { error: "Start again — no pending secret found." };
  let secret: string;
  try {
    secret = decryptValue(user.totpSecret);
  } catch {
    return { error: "Could not read the secret — start again." };
  }
  if (!verifyTotp(code, secret)) {
    return { error: "That code isn't right. Check your authenticator and try again." };
  }
  const backupCodes = generateBackupCodes(8);
  const hashed = await Promise.all(backupCodes.map((c) => bcrypt.hash(c.replace("-", ""), 10)));
  await prisma.user.update({
    where: { id: user.id },
    data: { totpEnabledAt: new Date(), totpBackupCodes: JSON.stringify(hashed) },
  });
  await logAudit({
    action: "auth.2fa_enabled",
    summary: "Authenticator-app 2FA enabled",
    userName: user.name,
  });
  revalidatePath("/settings");
  return { ok: "Two-factor authentication is on.", backupCodes };
}

/** Turn 2FA off (requires a current code so a hijacked session can't disable it). */
export async function disableTotp(
  _prev: SecurityState | undefined,
  formData: FormData
): Promise<SecurityState> {
  const user = await requireUser();
  const code = String(formData.get("code") ?? "").trim();
  if (!user.totpSecret || !user.totpEnabledAt) return { error: "2FA isn't enabled." };
  let ok = false;
  try {
    ok = verifyTotp(code, decryptValue(user.totpSecret));
  } catch {}
  if (!ok) return { error: "Enter a current authenticator code to turn 2FA off." };
  await prisma.user.update({
    where: { id: user.id },
    data: { totpSecret: null, totpEnabledAt: null, totpBackupCodes: null },
  });
  await logAudit({
    action: "auth.2fa_disabled",
    summary: "Authenticator-app 2FA disabled",
    userName: user.name,
  });
  revalidatePath("/settings");
  return { ok: "Two-factor authentication turned off." };
}

/** Email backup codes on/off (only useful with a working SMTP config). */
export async function setEmailOtp(enabled: boolean) {
  const user = await requireUser();
  await prisma.user.update({ where: { id: user.id }, data: { emailOtpEnabled: enabled } });
  await logAudit({
    action: enabled ? "auth.email_2fa_enabled" : "auth.email_2fa_disabled",
    summary: `Email sign-in codes ${enabled ? "enabled" : "disabled"}`,
    userName: user.name,
  });
  revalidatePath("/settings");
}

/** Owner-only: idle-timeout policy for everyone. */
export async function saveSessionPolicy(formData: FormData) {
  await requireOwner();
  const minutes = parseInt(String(formData.get("idleMinutes") ?? "60"), 10);
  const safe = isNaN(minutes) || minutes < 5 ? 60 : Math.min(minutes, 1440);
  await putSetting("SESSION_IDLE_MINUTES", String(safe));
  await logAudit({
    action: "security.policy_changed",
    summary: `Idle-timeout policy set to ${safe} minutes`,
    userName: (await requireUser()).name,
  });
  revalidatePath("/settings");
}

/** Owner-only: change a teammate's role. */
export async function setUserRole(userId: string, role: "owner" | "member") {
  const owner = await requireOwner();
  if (userId === owner.id && role === "member") {
    // Don't allow the last owner to demote themselves into lockout
    const owners = await prisma.user.count({ where: { role: "owner" } });
    if (owners <= 1) return;
  }
  const target = await prisma.user.update({ where: { id: userId }, data: { role } });
  await logAudit({
    action: "security.role_changed",
    summary: `${target.name} set to ${role}`,
    userName: owner.name,
  });
  revalidatePath("/settings");
}

/** Owner-only: force-disable a user's 2FA if they're locked out of their authenticator. */
export async function ownerResetUser2fa(userId: string) {
  const owner = await requireOwner();
  const target = await prisma.user.update({
    where: { id: userId },
    data: { totpSecret: null, totpEnabledAt: null, totpBackupCodes: null, emailOtpEnabled: false },
  });
  await logAudit({
    action: "security.2fa_reset",
    summary: `2FA reset for ${target.name} by owner`,
    userName: owner.name,
  });
  revalidatePath("/settings");
}
