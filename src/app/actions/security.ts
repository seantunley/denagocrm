"use server";

import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { revalidatePath } from "next/cache";
import { basePrisma, prisma } from "@/lib/db";
import { createSessionCookie, requireUser, requireOwner } from "@/lib/auth";
import { encryptValue, decryptValue, putSetting } from "@/lib/settings";
import { logAuditStrict } from "@/lib/audit";
import {
  generateTotpSecret,
  totpKeyUri,
  verifyTotp,
  generateBackupCodes,
} from "@/lib/totp";
import {
  bumpUserSessionVersion,
  setUserDisabledState,
} from "@/lib/userSecurity";

export async function beginTotpEnrolment(): Promise<{
  secret: string;
  qr: string;
  uri: string;
}> {
  const user = await requireUser();
  const secret = generateTotpSecret();
  const uri = totpKeyUri(secret, user.email);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  await prisma.user.update({
    where: { id: user.id },
    data: { totpSecret: encryptValue(secret), totpEnabledAt: null },
  });
  return { secret, qr, uri };
}

export type SecurityState = { error?: string; ok?: string; backupCodes?: string[] };

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
  const hashed = await Promise.all(backupCodes.map((item) => bcrypt.hash(item.replace("-", ""), 10)));
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { totpEnabledAt: new Date(), totpBackupCodes: JSON.stringify(hashed) },
  });
  await bumpUserSessionVersion(user.id);
  await createSessionCookie(updated);
  await logAuditStrict({
    action: "auth.2fa_enabled",
    summary: "Authenticator-app 2FA enabled; prior sessions revoked",
    entityType: "User",
    entityId: user.id,
    user,
  });
  revalidatePath("/settings");
  return { ok: "Two-factor authentication is on.", backupCodes };
}

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

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { totpSecret: null, totpEnabledAt: null, totpBackupCodes: null },
  });
  await bumpUserSessionVersion(user.id);
  await createSessionCookie(updated);
  await logAuditStrict({
    action: "auth.2fa_disabled",
    summary: "Authenticator-app 2FA disabled; prior sessions revoked",
    entityType: "User",
    entityId: user.id,
    user,
  });
  revalidatePath("/settings");
  return { ok: "Two-factor authentication turned off." };
}

export async function setEmailOtp(enabled: boolean) {
  const user = await requireUser();
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { emailOtpEnabled: enabled },
  });
  await bumpUserSessionVersion(user.id);
  await createSessionCookie(updated);
  await logAuditStrict({
    action: enabled ? "auth.email_2fa_enabled" : "auth.email_2fa_disabled",
    summary: `Email sign-in codes ${enabled ? "enabled" : "disabled"}; prior sessions revoked`,
    entityType: "User",
    entityId: user.id,
    user,
  });
  revalidatePath("/settings");
}

export async function saveSessionPolicy(formData: FormData) {
  const owner = await requireOwner();
  const minutes = parseInt(String(formData.get("idleMinutes") ?? "60"), 10);
  const safe = isNaN(minutes) || minutes < 5 ? 60 : Math.min(minutes, 1440);
  await putSetting("SESSION_IDLE_MINUTES", String(safe));
  await basePrisma.$executeRaw`UPDATE "User" SET "sessionVersion" = "sessionVersion" + 1`;
  await createSessionCookie(owner);
  await logAuditStrict({
    action: "security.policy_changed",
    summary: `Idle-timeout policy set to ${safe} minutes; active sessions revoked`,
    entityType: "SecurityPolicy",
    entityId: "session",
    user: owner,
    after: { idleMinutes: safe },
  });
  revalidatePath("/settings");
}

export async function setUserRole(userId: string, role: "owner" | "member") {
  const owner = await requireOwner();
  const target = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (target.role === "owner" && role === "member") {
    const rows = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "User"
      WHERE "role" = 'owner' AND "disabledAt" IS NULL AND "id" <> ${userId}
    `;
    if (Number(rows[0]?.count ?? 0) < 1) throw new Error("At least one active owner must remain");
  }
  const updated = await prisma.user.update({ where: { id: userId }, data: { role } });
  await bumpUserSessionVersion(userId);
  await logAuditStrict({
    action: "security.role_changed",
    summary: `${updated.name} set to ${role}; active sessions revoked`,
    entityType: "User",
    entityId: userId,
    user: owner,
    before: { role: target.role },
    after: { role },
  });
  revalidatePath("/settings");
}

export async function ownerResetUser2fa(userId: string) {
  const owner = await requireOwner();
  const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const target = await prisma.user.update({
    where: { id: userId },
    data: { totpSecret: null, totpEnabledAt: null, totpBackupCodes: null, emailOtpEnabled: false },
  });
  await bumpUserSessionVersion(userId);
  await logAuditStrict({
    action: "security.2fa_reset",
    summary: `2FA reset for ${target.name}; active sessions revoked`,
    entityType: "User",
    entityId: userId,
    user: owner,
    before: { totpEnabled: Boolean(before.totpEnabledAt), emailOtpEnabled: before.emailOtpEnabled },
    after: { totpEnabled: false, emailOtpEnabled: false },
  });
  revalidatePath("/settings");
}

export async function setUserModules(userId: string, modulesCsv: string) {
  const owner = await requireOwner();
  const valid = new Set(["crm", "workshop", "reports", "inbox"]);
  const clean = modulesCsv
    .split(",")
    .map((module) => module.trim())
    .filter((module) => valid.has(module))
    .join(",");
  const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const target = await prisma.user.update({ where: { id: userId }, data: { modules: clean } });
  await bumpUserSessionVersion(userId);
  await logAuditStrict({
    action: "security.modules_changed",
    summary: `${target.name}'s legacy modules set to ${clean || "none"}; active sessions revoked`,
    entityType: "User",
    entityId: userId,
    user: owner,
    before: { modules: before.modules },
    after: { modules: clean },
  });
  revalidatePath("/settings");
}

export async function revokeUserSessions(userId: string) {
  const owner = await requireOwner();
  if (userId === owner.id) throw new Error("Use sign out to end your current session");
  const target = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await bumpUserSessionVersion(userId);
  await logAuditStrict({
    action: "security.sessions_revoked",
    summary: `Revoked all active sessions for ${target.name}`,
    entityType: "User",
    entityId: userId,
    user: owner,
  });
  revalidatePath("/settings");
}

export async function setUserDisabled(userId: string, disabled: boolean) {
  const owner = await requireOwner();
  if (userId === owner.id) throw new Error("You cannot disable your own account");
  const target = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (disabled && target.role === "owner") {
    const rows = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "User"
      WHERE "role" = 'owner' AND "disabledAt" IS NULL AND "id" <> ${userId}
    `;
    if (Number(rows[0]?.count ?? 0) < 1) throw new Error("At least one active owner must remain");
  }
  await setUserDisabledState(userId, disabled);
  await logAuditStrict({
    action: disabled ? "security.user_disabled" : "security.user_reactivated",
    summary: `${target.name} ${disabled ? "disabled" : "reactivated"}`,
    entityType: "User",
    entityId: userId,
    user: owner,
    after: { disabled },
  });
  revalidatePath("/settings");
}
