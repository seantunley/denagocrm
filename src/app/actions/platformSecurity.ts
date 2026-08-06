"use server";

import QRCode from "qrcode";
import { hashBackupCode } from "@/lib/backupCodes";
import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { requirePlatformAdminAction } from "@/lib/platformAuth";
import { logAuditStrict } from "@/lib/audit";
import { encryptValue, decryptValue } from "@/lib/settings";
import { generateBackupCodes, generateTotpSecret, totpKeyUri, verifyTotp } from "@/lib/totp";
// The platform's own name, read straight from the environment rather than from
// the branding chain's helper — this PR must be mergeable on its own, and a
// two-factor feature has no business depending on a per-tenant branding stack.
// When that chain lands, this collapses back to the shared constant.
const PLATFORM_NAME = process.env.NEXT_PUBLIC_PLATFORM_NAME?.trim() || "CRM";
import { createPlatformSessionRow, setPlatformSessionCookie } from "@/lib/platformAuth";

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
 * The replacement session is created INSIDE the transaction that bumps the
 * version, and only the cookie is set afterwards.
 *
 * My first attempt read the current version after the transaction and minted a
 * fresh session then. That is a hole, not a fix: between the commit and the
 * mint, another administrator can reset the password or revoke all sessions —
 * their operation deletes the rows that exist, and then this creates a brand new
 * valid one, silently undoing the revocation. In the stolen-session case the
 * attacker survives exactly the action taken to remove them.
 *
 * Created inside the transaction, the replacement row exists before any
 * revocation can run, so a revoke-all takes it along with everything else. The
 * comment I wrote previously claimed this property while the code did the
 * opposite.
 */
type ReissuePlan = { jti: string; admin: { id: string; name: string; email: string; sessionVersion: number } } | null;

/**
 * Start enrolment: mint a secret, store it DISABLED, and hand back a QR code.
 *
 * `totpEnabledAt` stays null until a code from the authenticator proves the
 * secret actually arrived. Writing the secret and enabling it in one step would
 * lock out anyone whose scan silently failed — which, on this account, means
 * losing the console.
 */
export async function beginPlatformTotpEnrolment(currentCode?: string): Promise<{ secret: string; qr: string; uri: string }> {
  const actor = await requirePlatformAdminAction();

  // REPLACING a live authenticator costs a current code.
  //
  // Writing the new secret straight over the old one — as this used to — is a
  // working 2FA disable for anyone holding a session, and a Server Action is a
  // POST endpoint reachable without the console screen that renders the button.
  // disablePlatformTotp demands a code for exactly this reason; without this
  // check, "enrolling" achieved the same thing one function over. On an account
  // with nobody above it, that is not recoverable by asking an administrator.
  //
  // Enrolling for the FIRST time is still free: there is nothing to protect yet,
  // and demanding a code nobody has would make 2FA impossible to turn on.
  const live = await basePrisma.platformAdmin.findUnique({
    where: { id: actor.id },
    select: { totpSecret: true, totpEnabledAt: true },
  });
  if (live?.totpEnabledAt && live.totpSecret) {
    let ok = false;
    try {
      ok = verifyTotp(String(currentCode ?? "").trim(), decryptValue(live.totpSecret));
    } catch {
      // An unreadable stored secret must not become a way past this check.
    }
    if (!ok) throw new Error("Enter a current authenticator code to replace your authenticator.");
  }

  const secret = generateTotpSecret();
  // Labelled as the PLATFORM, not a tenant — this identity is not a tenant's,
  // and an authenticator entry naming one would be actively misleading.
  const uri = totpKeyUri(secret, actor.email, `${PLATFORM_NAME} Platform Console`);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  await basePrisma.platformAdmin.update({
    where: { id: actor.id },
    // The PENDING slot. The live factor is left exactly as it is.
    data: { totpPendingSecret: encryptValue(secret) },
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
  // The PENDING secret, not the live one: confirming against the authenticator
  // already in use would "prove" an enrolment that never happened.
  if (!admin?.totpPendingSecret) return { error: "Start again — no pending secret found." };

  let secret: string;
  try {
    secret = decryptValue(admin.totpPendingSecret);
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
  // Shared with the login's matcher, so the two cannot drift apart — on the CRM
  // side they did, and a code typed exactly as displayed was rejected.
  const hashed = await Promise.all(backupCodes.map((code) => hashBackupCode(code)));

  let promoted = false;
  const reissue: { plan: ReissuePlan } = { plan: null };
  await basePrisma.$transaction(async (tx) => {
    // CONDITIONAL on the exact pending value that was verified.
    //
    // An unconditional update loses two races. If disablePlatformTotp clears the
    // factor between the read above and this write, the promotion lands anyway
    // and silently switches 2FA back on after it was turned off. And two
    // confirmations running together would both issue backup-code sets while
    // only the last stored set actually works, leaving the admin holding codes
    // that verify against nothing — on the one account with nobody above it to
    // sort that out.
    const claimed = await tx.platformAdmin.updateMany({
      where: { id: actor.id, totpPendingSecret: admin.totpPendingSecret },
      data: {
        // Promotion: the proven secret becomes live, and the pending slot is
        // cleared so an abandoned enrolment cannot be confirmed later.
        totpSecret: encryptValue(secret),
        totpPendingSecret: null,
        totpEnabledAt: new Date(),
        totpBackupCodes: JSON.stringify(hashed),
        // REVOKES EVERY OTHER SESSION. Turning on 2FA is usually a response to
        // suspecting somebody else is signed in; leaving their session alive
        // would make the whole act ceremonial.
        sessionVersion: { increment: 1 },
      },
    });
    // Nothing else in this transaction runs, so no audit entry claims an
    // enrolment that did not happen.
    if (claimed.count !== 1) return;
    promoted = true;
    const updated = await tx.platformAdmin.findUniqueOrThrow({
      where: { id: actor.id },
      select: { id: true, name: true, email: true, sessionVersion: true },
    });
    reissue.plan = { jti: await createPlatformSessionRow(actor.id, tx), admin: updated };
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

  if (!promoted) {
    return { error: "This setup is no longer active — two-factor authentication was changed elsewhere. Start again." };
  }

  // Only the COOKIE is set here; its row was created in the transaction above.
  // The admin who just turned 2FA on must not be the first casualty of it.
  // A holder object rather than a bare `let`: TypeScript narrows a variable that
  // is only assigned inside a callback to `never` at the point of use.
  if (reissue.plan) await setPlatformSessionCookie(reissue.plan.admin, reissue.plan.jti);

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

  const reissue: { plan: ReissuePlan } = { plan: null };
  await basePrisma.$transaction(async (tx) => {
    await tx.platformAdmin.update({
      where: { id: actor.id },
      data: {
        totpSecret: null,
        // Cleared too, or a secret staged before the disable survives it and can
        // be confirmed afterwards, quietly re-enabling a factor just turned off.
        totpPendingSecret: null,
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
    const updated = await tx.platformAdmin.findUniqueOrThrow({
      where: { id: actor.id },
      select: { id: true, name: true, email: true, sessionVersion: true },
    });
    // Same reasoning as enabling, and the same atomicity: the replacement row is
    // created here so a concurrent revoke-all takes it too.
    reissue.plan = { jti: await createPlatformSessionRow(actor.id, tx), admin: updated };
  });

  // A holder object rather than a bare `let`: TypeScript narrows a variable that
  // is only assigned inside a callback to `never` at the point of use.
  if (reissue.plan) await setPlatformSessionCookie(reissue.plan.admin, reissue.plan.jti);

  revalidatePath("/platform/admins");
  return { ok: "Two-factor authentication turned off." };
}
