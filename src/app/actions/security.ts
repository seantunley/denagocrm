"use server";

import { asActionResult, ActionRefusal, refuse, type ActionResult } from "@/lib/actionResult";
import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { revalidatePath } from "next/cache";
import { basePrisma, prisma } from "@/lib/db";
import { createSessionCookie, requireUser, requireOwner, getActiveTenantId } from "@/lib/auth";
import { encryptValue, decryptValue, putSetting } from "@/lib/settings";
import { GOVERNANCE_TX, logAuditStrict } from "@/lib/audit";
import { lockGovernanceAdmins } from "@/lib/governanceLock";
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
  const updated = await basePrisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: user.id },
      data: { totpEnabledAt: new Date(), totpBackupCodes: JSON.stringify(hashed) },
    });
    await bumpUserSessionVersion(user.id, tx);
    await logAuditStrict({
      action: "auth.2fa_enabled",
      summary: "Authenticator-app 2FA enabled; prior sessions revoked",
      entityType: "User",
      entityId: user.id,
      user,
    }, tx);
    return updated;
  }, GOVERNANCE_TX);
  await createSessionCookie(updated);
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

  const updated = await basePrisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: user.id },
      data: { totpSecret: null, totpEnabledAt: null, totpBackupCodes: null },
    });
    await bumpUserSessionVersion(user.id, tx);
    await logAuditStrict({
      action: "auth.2fa_disabled",
      summary: "Authenticator-app 2FA disabled; prior sessions revoked",
      entityType: "User",
      entityId: user.id,
      user,
    }, tx);
    return updated;
  }, GOVERNANCE_TX);
  await createSessionCookie(updated);
  revalidatePath("/settings");
  return { ok: "Two-factor authentication turned off." };
}

export async function setEmailOtp(enabled: boolean): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireUser();
    // The change, the session bump and the governance audit go in ONE
    // transaction: a failed audit must roll the change back rather than leave it
    // committed while the save reports as failed. The cookie write is not
    // database work and stays outside, after the commit.
    const updated = await basePrisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: user.id },
        data: { emailOtpEnabled: enabled },
      });
      await bumpUserSessionVersion(user.id, tx);
      await logAuditStrict({
        action: enabled ? "auth.email_2fa_enabled" : "auth.email_2fa_disabled",
        summary: `Email sign-in codes ${enabled ? "enabled" : "disabled"}; prior sessions revoked`,
        entityType: "User",
        entityId: user.id,
        user,
      }, tx);
      return updated;
    }, GOVERNANCE_TX);
    await createSessionCookie(updated);
    revalidatePath("/settings");
  });
}

export async function saveSessionPolicy(formData: FormData) {
  return asActionResult(async () => {
    const owner = await requireOwner();
    const minutes = parseInt(String(formData.get("idleMinutes") ?? "60"), 10);
    const safe = isNaN(minutes) || minutes < 5 ? 60 : Math.min(minutes, 1440);
    await basePrisma.$transaction(async (tx) => {
      // The setting used to be written and committed BEFORE this transaction.
      // If the revocation or the audit then failed, the new idle timeout was
      // already live while the person was told the save failed — and every
      // existing session stayed valid under a policy nobody knew had changed.
      await putSetting("SESSION_IDLE_MINUTES", String(safe), tx);
      await tx.$executeRaw`UPDATE "User" SET "sessionVersion" = "sessionVersion" + 1`;
      await logAuditStrict({
        action: "security.policy_changed",
        summary: `Idle-timeout policy set to ${safe} minutes; active sessions revoked`,
        entityType: "SecurityPolicy",
        entityId: "session",
        user: owner,
        after: { idleMinutes: safe },
      }, tx);
    }, GOVERNANCE_TX);
    await createSessionCookie(owner);
    revalidatePath("/settings");
  });
}

export async function setUserRole(userId: string, role: "owner" | "member"): Promise<ActionResult> {
  return asActionResult(async () => {
    const owner = await requireOwner();
    const target = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const demoting = target.role === "owner" && role === "member";
    const updated = await basePrisma.$transaction(async (tx) => {
      // The count and the write must be atomic against another demotion. Held
      // BEFORE the count, so a second caller waits and then counts against this
      // one's committed state instead of the stale world both used to see.
      if (demoting) {
        await lockGovernanceAdmins(tx, await getActiveTenantId());
        const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*)::bigint AS count
          FROM "User"
          WHERE "role" = 'owner' AND "disabledAt" IS NULL AND "id" <> ${userId}
        `;
        if (Number(rows[0]?.count ?? 0) < 1) refuse("At least one active owner must remain.");
      }
      const updated = await tx.user.update({ where: { id: userId }, data: { role } });
      await bumpUserSessionVersion(userId, tx);
      await logAuditStrict({
        action: "security.role_changed",
        summary: `${updated.name} set to ${role}; active sessions revoked`,
        entityType: "User",
        entityId: userId,
        user: owner,
        before: { role: target.role },
        after: { role },
      }, tx);
      return updated;
    }, GOVERNANCE_TX);
    revalidatePath("/settings");
    return { success: `${updated.name} is now ${role === "owner" ? "an admin" : "a member"}. They have been signed out.` };
  });
}

export async function ownerResetUser2fa(userId: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const owner = await requireOwner();
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await basePrisma.$transaction(async (tx) => {
      const target = await tx.user.update({
        where: { id: userId },
        data: { totpSecret: null, totpEnabledAt: null, totpBackupCodes: null, emailOtpEnabled: false },
      });
      await bumpUserSessionVersion(userId, tx);
      await logAuditStrict({
        action: "security.2fa_reset",
        summary: `2FA reset for ${target.name}; active sessions revoked`,
        entityType: "User",
        entityId: userId,
        user: owner,
        before: { totpEnabled: Boolean(before.totpEnabledAt), emailOtpEnabled: before.emailOtpEnabled },
        after: { totpEnabled: false, emailOtpEnabled: false },
      }, tx);
    }, GOVERNANCE_TX);
    revalidatePath("/settings");
    return { success: "2FA reset. They have been signed out." };
  });
}

export async function setUserModules(userId: string, modulesCsv: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const owner = await requireOwner();
    const valid = new Set(["crm", "workshop", "reports", "inbox"]);
    const clean = modulesCsv
      .split(",")
      .map((module) => module.trim())
      .filter((module) => valid.has(module))
      .join(",");
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await basePrisma.$transaction(async (tx) => {
      const target = await tx.user.update({ where: { id: userId }, data: { modules: clean } });
      await bumpUserSessionVersion(userId, tx);
      await logAuditStrict({
        action: "security.modules_changed",
        summary: `${target.name}'s legacy modules set to ${clean || "none"}; active sessions revoked`,
        entityType: "User",
        entityId: userId,
        user: owner,
        before: { modules: before.modules },
        after: { modules: clean },
      }, tx);
    }, GOVERNANCE_TX);
    revalidatePath("/settings");
    return { success: "Modules updated." };
  });
}

export async function revokeUserSessions(userId: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const owner = await requireOwner();
    if (userId === owner.id) throw new ActionRefusal("Use sign out to end your current session");
    const target = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await basePrisma.$transaction(async (tx) => {
      await bumpUserSessionVersion(userId, tx);
      await logAuditStrict({
        action: "security.sessions_revoked",
        summary: `Revoked all active sessions for ${target.name}`,
        entityType: "User",
        entityId: userId,
        user: owner,
      }, tx);
    }, GOVERNANCE_TX);
    revalidatePath("/settings");
    return { success: "All their sessions were signed out." };
  });
}

export async function setUserDisabled(userId: string, disabled: boolean): Promise<ActionResult> {
  return asActionResult(async () => {
    const owner = await requireOwner();
    if (userId === owner.id) throw new ActionRefusal("You cannot disable your own account");
    const target = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await basePrisma.$transaction(async (tx) => {
      // Same invariant, same lock: two owners disabling each other at once both
      // passed a count taken outside any transaction and left zero admins.
      if (disabled && target.role === "owner") {
        await lockGovernanceAdmins(tx, await getActiveTenantId());
        const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*)::bigint AS count
          FROM "User"
          WHERE "role" = 'owner' AND "disabledAt" IS NULL AND "id" <> ${userId}
        `;
        if (Number(rows[0]?.count ?? 0) < 1) refuse("At least one active owner must remain.");
      }
      await setUserDisabledState(userId, disabled, tx);
      await logAuditStrict({
        action: disabled ? "security.user_disabled" : "security.user_reactivated",
        summary: `${target.name} ${disabled ? "disabled" : "reactivated"}`,
        entityType: "User",
        entityId: userId,
        user: owner,
        after: { disabled },
      }, tx);
    }, GOVERNANCE_TX);
    revalidatePath("/settings");
    return { success: `${target.name} ${disabled ? "disabled" : "reactivated"}.` };
  });
}
