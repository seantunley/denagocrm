"use server";

import { asActionResult, ActionRefusal, type ActionResult } from "@/lib/actionResult";
import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { logAuditStrict } from "@/lib/audit";
import { withPlatformAdminLock } from "@/lib/platformAdminLock";
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

type Actor = { id: string; name: string; email: string };

/**
 * Audit payload for a platform-admin change.
 *
 * The actor is a PlatformAdmin, NOT a CRM User, so `user` is deliberately omitted:
 * passing it would write an id into actorUserId that resolves to no User row. The
 * identity travels as actorName + actorType + metadata instead.
 */
function adminAudit(
  actor: Actor,
  action: string,
  summary: string,
  entityId: string,
  extra?: Record<string, unknown>,
) {
  return {
    action,
    summary,
    entityType: "PlatformAdmin",
    entityId,
    userName: actor.name,
    actorType: "platform_admin",
    metadata: { platformAdminId: actor.id, platformAdminEmail: actor.email, ...extra },
  };
}

export async function createPlatformAdminAction(formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requirePlatformAdminAction();

    const name = value(formData, "name");
    const email = normalisePlatformEmail(value(formData, "email"));
    const password = String(formData.get("password") ?? "");

    if (!name) throw new ActionRefusal("Name is required.");
    if (!email) throw new ActionRefusal("Enter a valid email address.");
    if (!validPlatformPassword(password)) {
      throw new ActionRefusal("Password must be at least 12 characters and contain both letters and numbers.");
    }

    const passwordHash = await bcrypt.hash(password, 12);

    try {
      // Creating cannot REDUCE the active count, so it does not need the admin-state
      // lock. It does need the audit on the same transaction, so a failed audit rolls
      // the new account back rather than leaving an unaudited admin behind.
      await basePrisma.$transaction(async (tx) => {
        const created = await tx.platformAdmin.create({
          data: { name, email, passwordHash, passwordChangedAt: new Date() },
        });
        await logAuditStrict(
          adminAudit(
            actor,
            "platform_admin.created",
            `Created platform admin ${name} <${email}>`,
            created.id,
            { createdEmail: email }, // never any password material
          ),
          tx,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ActionRefusal("A platform admin with that email already exists.");
      throw error;
    }

    revalidatePath(CONSOLE_PATH);
  });
}

/**
 * Disable or re-enable an admin.
 *
 * Disabling also revokes live sessions. `disabledAt` alone would do — it is checked
 * on every request — but bumping sessionVersion too kills the token even if that
 * check were ever bypassed. Defence in depth on the account you are disabling
 * precisely because you no longer trust it.
 */
export async function setPlatformAdminDisabledAction(
  adminId: string,
  disabled: boolean,
): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requirePlatformAdminAction();

    await withPlatformAdminLock(async ({ tx, otherActiveCount, audit }) => {
      const target = await tx.platformAdmin.findUnique({
        where: { id: adminId },
        select: { id: true, name: true, email: true, disabledAt: true },
      });
      if (!target) throw new ActionRefusal("Platform admin not found.");

      if (disabled) {
        // Counted UNDER the lock. Counting before it is the stale read that let two
        // concurrent disables each believe the other admin was still active.
        const gate = canDisablePlatformAdmin(actor.id, adminId, await otherActiveCount(adminId));
        if (!gate.ok) throw new ActionRefusal(gate.error);

        await tx.platformAdmin.update({
          where: { id: adminId },
          data: { disabledAt: new Date(), sessionVersion: { increment: 1 } },
        });
        await tx.platformAdminSession.updateMany({
          where: { adminId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      } else {
        await tx.platformAdmin.update({ where: { id: adminId }, data: { disabledAt: null } });
      }

      await audit(
        adminAudit(
          actor,
          disabled ? "platform_admin.disabled" : "platform_admin.enabled",
          `${disabled ? "Disabled" : "Re-enabled"} platform admin ${target.name} <${target.email}>`,
          adminId,
        ),
      );
    });

    revalidatePath(CONSOLE_PATH);
  });
}

export async function deletePlatformAdminAction(adminId: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requirePlatformAdminAction();

    await withPlatformAdminLock(async ({ tx, otherActiveCount, audit }) => {
      const target = await tx.platformAdmin.findUnique({
        where: { id: adminId },
        select: { id: true, name: true, email: true },
      });
      if (!target) throw new ActionRefusal("Platform admin not found.");

      const gate = canDeletePlatformAdmin(actor.id, adminId, await otherActiveCount(adminId));
      if (!gate.ok) throw new ActionRefusal(gate.error);

      // Audited before the row disappears; both writes share this transaction, so the
      // ordering is for readability rather than safety.
      await audit(
        adminAudit(
          actor,
          "platform_admin.deleted",
          `Deleted platform admin ${target.name} <${target.email}>`,
          adminId,
        ),
      );
      // Sessions cascade with the admin row (onDelete: Cascade).
      await tx.platformAdmin.delete({ where: { id: adminId } });
    });

    revalidatePath(CONSOLE_PATH);
  });
}

/**
 * Change your OWN password. Requires the current one, so a borrowed session cannot
 * silently take ownership of the account. Every session is revoked, including this
 * one — a password change is exactly when you want other devices signed out.
 */
export async function changeOwnPasswordAction(
  formData: FormData,
): Promise<{ error?: string; ok?: string }> {
  const actor = await requirePlatformAdminAction();

  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");

  const me = await basePrisma.platformAdmin.findUnique({
    where: { id: actor.id },
    select: { id: true, passwordHash: true },
  });
  if (!me) return { error: "Your account no longer exists." };

  const matches = await bcrypt.compare(currentPassword, me.passwordHash);
  const gate = canChangeOwnPassword(matches, newPassword);
  if (!gate.ok) return { error: gate.error };

  const passwordHash = await bcrypt.hash(newPassword, 12);

  // No admin-state lock: a password change cannot alter the active count. The audit
  // still shares the transaction, so a failed audit cannot leave the password
  // changed while the operator is told it failed — which for their own credential
  // would mean being locked out of an account they believe is unchanged.
  await basePrisma.$transaction(async (tx) => {
    await tx.platformAdmin.update({
      where: { id: me.id },
      data: { passwordHash, passwordChangedAt: new Date(), sessionVersion: { increment: 1 } },
    });
    await tx.platformAdminSession.updateMany({
      where: { adminId: me.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await logAuditStrict(
      adminAudit(actor, "platform_admin.password_changed", "Changed their own password", me.id),
      tx,
    );
  });

  // The version bump just invalidated our own cookie; clear it so the next request
  // is a clean sign-in rather than a confusing silent redirect.
  await destroyPlatformSessionCookie();
  revalidatePath(CONSOLE_PATH);
  return { ok: "Password changed. Sign in again with your new password." };
}

/** Administratively reset SOMEONE ELSE'S password and sign them out everywhere. */
export async function resetPlatformAdminPasswordAction(
  adminId: string,
  formData: FormData,
): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requirePlatformAdminAction();

    const newPassword = String(formData.get("newPassword") ?? "");
    const gate = canResetOtherPassword(actor.id, adminId, newPassword);
    if (!gate.ok) throw new ActionRefusal(gate.error);

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await basePrisma.$transaction(async (tx) => {
      const target = await tx.platformAdmin.findUnique({
        where: { id: adminId },
        select: { id: true, name: true, email: true },
      });
      if (!target) throw new ActionRefusal("Platform admin not found.");

      await tx.platformAdmin.update({
        where: { id: adminId },
        data: { passwordHash, passwordChangedAt: new Date(), sessionVersion: { increment: 1 } },
      });
      await tx.platformAdminSession.updateMany({
        where: { adminId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await logAuditStrict(
        adminAudit(
          actor,
          "platform_admin.password_reset",
          `Reset the password for platform admin ${target.name} <${target.email}>`,
          adminId,
        ),
        tx,
      );
    });

    revalidatePath(CONSOLE_PATH);
  });
}

/**
 * Revoke every live session for an admin without touching their password — the
 * "I left it signed in somewhere" button. Allowed on yourself: it signs your other
 * devices out, and your own cookie is cleared so you simply sign in again.
 */
export async function revokePlatformAdminSessionsAction(adminId: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requirePlatformAdminAction();

    await basePrisma.$transaction(async (tx) => {
      const target = await tx.platformAdmin.findUnique({
        where: { id: adminId },
        select: { id: true, name: true, email: true },
      });
      if (!target) throw new ActionRefusal("Platform admin not found.");

      await tx.platformAdmin.update({
        where: { id: adminId },
        data: { sessionVersion: { increment: 1 } },
      });
      await tx.platformAdminSession.updateMany({
        where: { adminId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await logAuditStrict(
        adminAudit(
          actor,
          "platform_admin.sessions_revoked",
          `Revoked all sessions for platform admin ${target.name} <${target.email}>`,
          adminId,
        ),
        tx,
      );
    });

    const me = await getCurrentPlatformAdmin();
    if (me && me.id === adminId) await destroyPlatformSessionCookie();
    revalidatePath(CONSOLE_PATH);
  });
}
