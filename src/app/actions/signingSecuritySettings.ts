"use server";

import { revalidatePath } from "next/cache";
import { requireTenantOwner } from "@/lib/auth";
import { getSetting, putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";
import { SIGNING_AUTO_REMINDERS_KEY, signingAutoRemindersOn } from "@/lib/signingReminders";
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

/** Whether signers get an automatic reminder. Owner-only, like the rest of this page. */
export async function readSigningAutoReminders(): Promise<boolean> {
  return withActingStaffScope(async () => {
    await requireTenantOwner();
    return signingAutoRemindersOn();
  });
}

/**
 * Switch automatic signing reminders on or off. A reminder is a message to a
 * customer that nobody pressed Send on, so it is the owner's call and audited.
 */
export async function saveSigningAutoReminders(
  _prev: { error?: string; ok?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: string }> {
  return withActingStaffScope(async () => {
    const user = await requireTenantOwner();
    const on = formData.get("autoReminders") === "on";
    const before = await signingAutoRemindersOn();
    await putSetting(SIGNING_AUTO_REMINDERS_KEY, on ? "true" : "false");
    if (before !== on) {
      await logAudit({
        action: "signing.auto_reminders_changed",
        summary: `Automatic signing reminders switched ${on ? "on" : "off"}`,
        entityType: "AppSetting",
        entityId: SIGNING_AUTO_REMINDERS_KEY,
        userName: user.name,
        metadata: { before, after: on },
      });
    }
    revalidatePath("/settings/signing-security");
    return { ok: on ? "On — signers get one reminder after 3 days." : "Off — no automatic reminders." };
  });
}
