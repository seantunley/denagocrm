"use server";

import { revalidatePath } from "next/cache";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { getSetting, putSetting } from "@/lib/settings";
import { sealCertificateInfo } from "@/lib/pdf/seal";
import { serverSealMaterial } from "@/lib/signing/sealMaterial";
import { SEAL_IDENTITY_KEY, ensureWorkspaceSealIdentity, storedSealIdentity } from "@/lib/signing/sealIdentity";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";
import {
  parseOtpPolicy,
  parseOtpMinValue,
  SIGNING_OTP_POLICY_KEY,
  SIGNING_OTP_MIN_VALUE_KEY,
  type SigningOtpPolicy,
} from "@/lib/signing/identityPolicy";

export type SigningSecuritySettings = {
  policy: SigningOtpPolicy;
  minValue: number;
};

/**
 * Read the current policy.
 *
 * Guarded even though it only returns two low-sensitivity values: everything
 * exported from a "use server" module is a callable endpoint, not merely a
 * function the page happens to import, and the repository's own guard test
 * enforces that without exception — which is the right rule, because the day
 * somebody adds a third field to this return type is the day the exception
 * would have mattered.
 */
export async function readSigningSecuritySettings(): Promise<SigningSecuritySettings> {
  return withActingStaffScope(async () => {
    await requireTenantOwner();
    const [policy, minValue] = await Promise.all([
      getSetting(SIGNING_OTP_POLICY_KEY).catch(() => null),
      getSetting(SIGNING_OTP_MIN_VALUE_KEY).catch(() => null),
    ]);
    return { policy: parseOtpPolicy(policy), minValue: parseOtpMinValue(minValue) };
  });
}

/**
 * Change when signers are asked to prove who they are.
 *
 * Owner-only, and audited. This decides whether a customer signing a contract is
 * challenged for a one-time code, so turning it off is a security decision that
 * should be attributable to a person rather than appearing in the settings
 * table with no history.
 */
export async function saveSigningSecuritySettings(
  _prev: { error?: string; ok?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: string }> {
  return withActingStaffScope(async () => {
    const user = await requireTenantOwner();

    const policy = parseOtpPolicy(String(formData.get("policy") ?? ""));
    const rawMin = String(formData.get("minValue") ?? "").trim();
    // An unreadable number must not silently become 0 and pull every small
    // document into the check — say so instead.
    if (rawMin !== "" && !Number.isFinite(Number(rawMin))) {
      return { error: "Enter the minimum value as a number, or leave it blank for any amount." };
    }
    const minValue = parseOtpMinValue(rawMin);

    const before = await readSigningSecuritySettings();
    await putSetting(SIGNING_OTP_POLICY_KEY, policy);
    await putSetting(SIGNING_OTP_MIN_VALUE_KEY, String(minValue));

    await logAudit({
      action: "signing.identity_policy_changed",
      summary:
        `Signer verification set to “${policy}”` +
        (policy === "money" ? ` for documents worth ${minValue} or more` : ""),
      entityType: "AppSetting",
      entityId: SIGNING_OTP_POLICY_KEY,
      userName: user.name,
      metadata: { before, after: { policy, minValue } },
    });

    revalidatePath("/settings/signing-security");
    return { ok: "Saved." };
  });
}

// Automatic signing reminders were switched here. They are the ready-made
// "Signing reminder" journey now, switched on Journeys — this page shows its state.

/**
 * Which certificate seals this workspace's signed PDFs — for the owner to see.
 *
 *   server     a certificate configured on the server, used for every workspace
 *   workspace  this workspace's own, stored with its settings
 *   none       no certificate yet; one is made at the first completed document
 *   unreadable a certificate is stored but cannot be opened (the encryption key
 *              changed, or the row is damaged) — documents are being sealed with
 *              a temporary certificate until this is put right
 *
 * Only what a certificate says about itself is returned: its name, fingerprint
 * and dates. The key never leaves the server.
 */
export type SealCertificateView = {
  source: "server" | "workspace" | "none" | "unreadable";
  subject?: string;
  fingerprint?: string;
  validFrom?: string;
  validTo?: string;
};

export async function readSealCertificate(): Promise<SealCertificateView> {
  return withActingStaffScope(async () => {
    await requireTenantOwner();
    const tenantId = await getActiveTenantId();
    try {
      const material = serverSealMaterial() ?? (tenantId ? await storedSealIdentity(tenantId) : null);
      if (!material) return { source: "none" as const };
      const info = sealCertificateInfo(material);
      return {
        source: material.source === "server" ? ("server" as const) : ("workspace" as const),
        subject: info.subject,
        fingerprint: info.fingerprintSha256,
        validFrom: info.validFrom,
        validTo: info.validTo,
      };
    } catch {
      return { source: "unreadable" as const };
    }
  });
}

/**
 * Make this workspace's certificate now, rather than at its first completed
 * document. Does nothing when one already exists — a certificate is never
 * replaced from here, because documents already sealed are recognised by it.
 */
export async function createSealCertificate(
  _prev: { error?: string; ok?: string } | undefined,
): Promise<{ error?: string; ok?: string }> {
  return withActingStaffScope(async () => {
    const user = await requireTenantOwner();
    const tenantId = await getActiveTenantId();
    if (!tenantId) return { error: "No workspace is selected." };
    if (serverSealMaterial()) return { ok: "The server's certificate is in use for this workspace." };
    try {
      const already = await storedSealIdentity(tenantId);
      const material = await ensureWorkspaceSealIdentity(tenantId);
      if (!already) {
        await logAudit({
          action: "signing.seal_certificate_created",
          summary: "Created the workspace's certificate for sealing signed documents",
          entityType: "AppSetting",
          entityId: SEAL_IDENTITY_KEY,
          userName: user.name,
          metadata: { fingerprint: sealCertificateInfo(material).fingerprintSha256 },
        });
      }
      revalidatePath("/settings/signing-security");
      return { ok: already ? "This workspace already has its certificate." : "Certificate created." };
    } catch {
      return { error: "The certificate could not be created. Check that the server's encryption key is set, then try again." };
    }
  });
}
