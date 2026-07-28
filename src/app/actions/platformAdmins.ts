"use server";

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { logAuditStrict } from "@/lib/audit";
import {
  getCurrentPlatformAdmin,
  requirePlatformAdminAction,
  destroyPlatformSessionCookie,
} from "@/lib/platformAuth";
import {
  canChangeOwnPassword,
  canDeletePlatformAdmin,
  canDisablePlatformAdmin,
  canResetOtherPassword,
  normalisePlatformEmail,
  validPlatformPassword,
} from "@/lib/platformAdminGuards";

const CONSOLE_PATH = "/platform/admins";

const value = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();

/** A Prisma unique-constraint violation, duck-typed to keep this file ORM-light. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/**
 * Audit a platform-admin change.
 *
 * The actor is a PlatformAdmin, NOT a CRM User, so `user` is deliberately omitted:
 * passing it would write an id into actorUserId that resolves to no User row. The
 * identity travels as actorName + actorType + metadata instead.
 */
async function auditAdminChange(
  actor: { id: string; name: string; email: string },
  action: string,
  summary: string,
  entityId: string,
  extra?: Record<string, unknown>,
) {
  await logAuditStrict({
    action,
    summary,
    entityType: "PlatformAdmin",
    entityId,
    userName: actor.name,
    actorType: "platform_admin",
    metadata: { platformAdminId: actor.id, platformAdminEmail: actor.email, ...extra },
  });
}

export async function createPlatformAdminAction(formData: FormData): Promise<void> {
  const actor = await requirePlatformAdminAction();

  const name = value(formData, "name");
  const email = normalisePlatformEmail(value(formData, "email"));
  const password = String(formData.get("password") ?? "");

  if (!name) throw new Error("Name is required.");
  if (!email) throw new Error("Enter a valid email address.");
  if (!validPlatformPassword(password)) {
    throw new Error("Password must be at least 12 characters and contain both letters and numbers.");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  let created;
  try {
    created = await basePrisma.platformAdmin.create({
      data: { name, email, passwordHash, passwordChangedAt: new Date() },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("A platform admin with that email already exists.");
    throw error;
  }

  await auditAdminChange(
    actor,
    "platform_admin.created",
    `Created platform admin ${name} <${email}>`,
    created.id,
    // No password material in the audit trail, ever.
    { createdEmail: email },
  );
  revalidatePath(CONSOLE_PATH);
}

/**
 * Disable an admin AND revoke their live sessions.
 *
 * `disabledAt` alone is enough — getCurrentPlatformAdmin checks it on every
 * request — but bumping sessionVersion too means the token is dead even if that
 * check were ever bypassed. Defence in depth for the account you are disabling
 * precisely because you no longer trust it.
 */
export async function setPlatformAdminDisabledAction(
  adminId: string,
  disabled: boolean,
): Promise<void> {
  const actor = await requirePlatformAdminAction();

  const target = await basePrisma.platformAdmin.findUnique({
    where: { id: adminId },
    select: { id: true, name: true, email: true, disabledAt: true },
  });
  if (!target) throw new Error("Platform admin not found.");

  if (disabled) {
    // Count and mutate in one transaction, with the row locked: two concurrent
    // disables could otherwise each see "one other admin is active" and both
    // proceed, leaving nobody.
    await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT "id" FROM "PlatformAdmin" WHERE "id" = ${adminId} FOR UPDATE`;
      const others = await tx.platformAdmin.count({
        where: { id: { not: adminId }, disabledAt: null },
      });
      const gate = canDisablePlatformAdmin(actor.id, adminId, others);
      if (!gate.ok) throw new Error(gate.error);

      await tx.platformAdmin.update({
        where: { id: adminId },
        data: { disabledAt: new Date(), sessionVersion: { increment: 1 } },
      });
      await tx.platformAdminSession.updateMany({
        where: { adminId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  } else {
    await basePrisma.platformAdmin.update({
      where: { id: adminId },
      data: { disabledAt: null },
    });
  }

  await auditAdminChange(
    actor,
    disabled ? "platform_admin.disabled" : "platform_admin.enabled",
    `${disabled ? "Disabled" : "Re-enabled"} platform admin ${target.name} <${target.email}>`,
    adminId,
  );
  revalidatePath(CONSOLE_PATH);
}

export async function deletePlatformAdminAction(adminId: string): Promise<void> {
  const actor = await requirePlatformAdminAction();

  const target = await basePrisma.platformAdmin.findUnique({
    where: { id: adminId },
    select: { id: true, name: true, email: true },
  });
  if (!target) throw new Error("Platform admin not found.");

  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT "id" FROM "PlatformAdmin" WHERE "id" = ${adminId} FOR UPDATE`;
    const others = await tx.platformAdmin.count({
      where: { id: { not: adminId }, disabledAt: null },
    });
    const gate = canDeletePlatformAdmin(actor.id, adminId, others);
    if (!gate.ok) throw new Error(gate.error);
    // Sessions cascade with the admin row (onDelete: Cascade).
    await tx.platformAdmin.delete({ where: { id: adminId } });
  });

  await auditAdminChange(
    actor,
    "platform_admin.deleted",
    `Deleted platform admin ${target.name} <${target.email}>`,
    adminId,
  );
  revalidatePath(CONSOLE_PATH);
}

/**
 * Change your OWN password. Requires the current one, so a borrowed session cannot
 * silently take ownership of the account.
 *
 * Every OTHER session for this admin is revoked (sessionVersion bump + row
 * revocation) while the CURRENT one is re-issued — a password change is exactly
 * when you want other devices signed out, and exactly when you do not want to be
 * signed out yourself mid-task.
 */
export async function changeOwnPasswordAction(formData: FormData): Promise<{ error?: string; ok?: string }> {
  const actor = await requirePlatformAdminAction();

  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");

  const me = await basePrisma.platformAdmin.findUnique({
    where: { id: actor.id },
    select: { id: true, name: true, email: true, passwordHash: true, sessionVersion: true },
  });
  if (!me) return { error: "Your account no longer exists." };

  const matches = await bcrypt.compare(currentPassword, me.passwordHash);
  const gate = canChangeOwnPassword(matches, newPassword);
  if (!gate.ok) return { error: gate.error };

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await basePrisma.$transaction(async (tx) => {
    await tx.platformAdmin.update({
      where: { id: me.id },
      data: { passwordHash, passwordChangedAt: new Date(), sessionVersion: { increment: 1 } },
    });
    await tx.platformAdminSession.updateMany({
      where: { adminId: me.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });

  await auditAdminChange(actor, "platform_admin.password_changed", `Changed their own password`, me.id);

  // The bump just invalidated our own cookie too. Clear it so the next request is
  // a clean sign-in rather than a confusing silent redirect.
  await destroyPlatformSessionCookie();
  revalidatePath(CONSOLE_PATH);
  return { ok: "Password changed. Sign in again with your new password." };
}

/** Administratively reset SOMEONE ELSE'S password and sign them out everywhere. */
export async function resetPlatformAdminPasswordAction(
  adminId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requirePlatformAdminAction();

  const newPassword = String(formData.get("newPassword") ?? "");
  const gate = canResetOtherPassword(actor.id, adminId, newPassword);
  if (!gate.ok) throw new Error(gate.error);

  const target = await basePrisma.platformAdmin.findUnique({
    where: { id: adminId },
    select: { id: true, name: true, email: true },
  });
  if (!target) throw new Error("Platform admin not found.");

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await basePrisma.$transaction(async (tx) => {
    await tx.platformAdmin.update({
      where: { id: adminId },
      data: { passwordHash, passwordChangedAt: new Date(), sessionVersion: { increment: 1 } },
    });
    await tx.platformAdminSession.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });

  await auditAdminChange(
    actor,
    "platform_admin.password_reset",
    `Reset the password for platform admin ${target.name} <${target.email}>`,
    adminId,
  );
  revalidatePath(CONSOLE_PATH);
}

/**
 * Revoke every live session for an admin without touching their password —
 * the "I left it signed in somewhere" button. Allowed on yourself: it signs your
 * other devices out, and your own cookie is cleared so you simply sign in again.
 */
export async function revokePlatformAdminSessionsAction(adminId: string): Promise<void> {
  const actor = await requirePlatformAdminAction();

  const target = await basePrisma.platformAdmin.findUnique({
    where: { id: adminId },
    select: { id: true, name: true, email: true },
  });
  if (!target) throw new Error("Platform admin not found.");

  await basePrisma.$transaction(async (tx) => {
    await tx.platformAdmin.update({
      where: { id: adminId },
      data: { sessionVersion: { increment: 1 } },
    });
    await tx.platformAdminSession.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });

  await auditAdminChange(
    actor,
    "platform_admin.sessions_revoked",
    `Revoked all sessions for platform admin ${target.name} <${target.email}>`,
    adminId,
  );

  const me = await getCurrentPlatformAdmin();
  if (me && me.id === adminId) await destroyPlatformSessionCookie();
  revalidatePath(CONSOLE_PATH);
}
