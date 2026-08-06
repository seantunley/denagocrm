"use server";

import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { requirePlatformAdminAction } from "@/lib/platformAuth";
import { logAuditStrict } from "@/lib/audit";
import { encryptValue, decryptValue } from "@/lib/settings";
import { generateBackupCodes, generateTotpSecret, totpKeyUri, verifyTotp } from "@/lib/totp";
import { PLATFORM_NAME } from "@/lib/platformIdentity";

/**
 * Two-factor authentication for the platform console.
 *
 * `PlatformAdmin` has carried `totpSecret` and `totpEnabledAt` since it was
 * created and nothing ever wrote them. The columns existed, the CRM's identical
 * ones were fully wired, and the console's own enrolment was never built — so
 * the account that can create, brand and suspend every tenant on the platform
 * was protected by a password alone, while an ordinary sales rep inside a tenant
 * could enrol an authenticator and a passkey.
 *
 * ── Deliberately narrower than the CRM's ────────────────────────────────────
 *
 * The CRM accepts an authenticator code, an EMAILED one-time code, or a backup
 * code. This accepts the first and the last. An emailed factor would make the
 * highest-privilege account on the platform exactly as strong as somebody's
 * mailbox, which is the wrong direction for the one identity that has nobody
 * above it.
 *
 * That is also why backup codes are not optional here. A tenant user who loses
 * their authenticator asks an owner to reset it; a platform admin has no owner,
 * so the alternative to a backup code is an UPDATE against the production
 * database by hand.
 *
 * ── Every action re-authorises ──────────────────────────────────────────────
 *
 * `requirePlatformAdminAction()` at the top of each, because a Server Action is
 * reachable by direct POST rather than only from the page that rendered its
 * form. And each acts on the CALLER's own row — the id comes from the session,
 * never from the request — so there is no shape of this in which one admin
 * enrols, disables or reads another's second factor.
 */

export type PlatformSecurityState = { error?: string; ok?: string; backupCodes?: string[] };

/**
 * Start enrolment: mint a secret, store it DISABLED, and hand back a QR code.
 *
 * `totpEnabledAt` stays null until a code from the authenticator proves the
 * secret actually arrived. Writing the secret and enabling it in one step would
 * lock out anyone whose scan silently failed — which, on this account, means
 * losing the console.
 */
export async function beginPlatformTotpEnrolment(): Promise<{ secret: string; qr: string; uri: string }> {
  const actor = await requirePlatformAdminAction();
  const secret = generateTotpSecret();
  // Labelled as the PLATFORM, not a tenant — this identity is not a tenant's,
  // and an authenticator entry naming one would be actively misleading.
  const uri = totpKeyUri(secret, actor.email, `${PLATFORM_NAME} Platform Console`);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  await basePrisma.platformAdmin.update({
    where: { id: actor.id },
    data: { totpSecret: encryptValue(secret), totpEnabledAt: null },
  });
  return { secret, qr, uri };
}

/** Prove the authenticator has the secret, then switch it on and issue codes. */
export async function confirmPlatformTotpEnrolment(
  _prev: PlatformSecurityState | undefined,
  formData: FormData,
): Promise<PlatformSecurityState> {
  const actor = await requirePlatformAdminAction();
  const admin = await basePrisma.platformAdmin.findUnique({ where: { id: actor.id } });
  if (!admin?.totpSecret) return { error: "Start again — no pending secret found." };

  let secret: string;
  try {
    secret = decryptValue(admin.totpSecret);
  } catch {
    return { error: "Could not read the secret — start again." };
  }
  if (!verifyTotp(String(formData.get("code") ?? "").trim(), secret)) {
    return { error: "That code isn't right. Check your authenticator and try again." };
  }

  // Hashed, never stored in the clear — they are passwords with one use each.
  // The separator is stripped before hashing so a code typed with or without it
  // compares the same, matching how the login step normalises input.
  const backupCodes = generateBackupCodes(8);
  const hashed = await Promise.all(backupCodes.map((code) => bcrypt.hash(code.replace(/-/g, ""), 10)));

  await basePrisma.$transaction(async (tx) => {
    await tx.platformAdmin.update({
      where: { id: actor.id },
      data: {
        totpEnabledAt: new Date(),
        totpBackupCodes: JSON.stringify(hashed),
        // REVOKES EVERY OTHER SESSION. Turning on 2FA is usually a response to
        // suspecting somebody else is signed in; leaving their session alive
        // would make the whole act ceremonial.
        sessionVersion: { increment: 1 },
      },
    });
    await logAuditStrict(
      {
        action: "platform.2fa_enabled",
        summary: "Platform console 2FA enabled; prior sessions revoked",
        entityType: "PlatformAdmin",
        entityId: actor.id,
        userName: actor.name,
        actorType: "platform_admin",
        metadata: { platformAdminId: actor.id, platformAdminEmail: actor.email },
      },
      tx,
    );
  });

  revalidatePath("/platform/admins");
  // Shown ONCE. They are not recoverable — only their hashes are stored.
  return { ok: "Two-factor authentication is on.", backupCodes };
}

/**
 * Turn it off, and only with a current code.
 *
 * A password alone would make 2FA removable by exactly the attacker it exists to
 * stop: someone holding a stolen password and a live session. Requiring the
 * factor to remove the factor is the point.
 */
export async function disablePlatformTotp(
  _prev: PlatformSecurityState | undefined,
  formData: FormData,
): Promise<PlatformSecurityState> {
  const actor = await requirePlatformAdminAction();
  const admin = await basePrisma.platformAdmin.findUnique({ where: { id: actor.id } });
  if (!admin?.totpSecret || !admin.totpEnabledAt) return { error: "2FA isn't enabled." };

  let ok = false;
  try {
    ok = verifyTotp(String(formData.get("code") ?? "").trim(), decryptValue(admin.totpSecret));
  } catch {
    /* falls through to the refusal below */
  }
  if (!ok) return { error: "Enter a current authenticator code to turn 2FA off." };

  await basePrisma.$transaction(async (tx) => {
    await tx.platformAdmin.update({
      where: { id: actor.id },
      data: {
        totpSecret: null,
        totpEnabledAt: null,
        totpBackupCodes: null,
        sessionVersion: { increment: 1 },
      },
    });
    await logAuditStrict(
      {
        action: "platform.2fa_disabled",
        summary: "Platform console 2FA disabled; prior sessions revoked",
        entityType: "PlatformAdmin",
        entityId: actor.id,
        userName: actor.name,
        actorType: "platform_admin",
        metadata: { platformAdminId: actor.id, platformAdminEmail: actor.email },
      },
      tx,
    );
  });

  revalidatePath("/platform/admins");
  return { ok: "Two-factor authentication turned off." };
}
