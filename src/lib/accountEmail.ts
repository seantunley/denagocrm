import "server-only";
import { basePrisma } from "./db";
import { runInTenantScope } from "./tenantScope";
import { DEFAULT_TENANT_ID } from "./tenant";
import { isSmtpConfigured, sendEmail } from "./email";
import { logError } from "./errorLog";

/**
 * MAIL ABOUT A PERSON'S OWN ACCOUNT, SENT BEFORE THEY ARE SIGNED IN: a password reset code, "your password was
 * changed", an emailed sign-in code.
 *
 * That path has no request scope, and with tenant enforcement live the mail settings cannot be read without one —
 * every such email failed with "No tenant scope established for AppSetting" and nobody could reset a password
 * (Kristina, Breastfeeding Art, 2026-11-02). It is sent as the person's OWN workspace when that workspace has its
 * own mail set up, and otherwise as the platform (the founding workspace's mail settings) — so a workspace with no
 * SMTP can still get its people back in. Never throws; a failure is logged (no address, no code) and returned.
 */
export async function accountWorkspaceId(userId: string): Promise<string | null> {
  return (await basePrisma.tenantMember.findUnique({ where: { userId }, select: { tenantId: true } }))?.tenantId ?? null;
}

/** The workspace to SEND AS: the person's own if it has mail set up, else the platform's. */
export async function accountMailTenantId(userId: string): Promise<string> {
  const own = await accountWorkspaceId(userId);
  if (!own || own === DEFAULT_TENANT_ID) return DEFAULT_TENANT_ID;
  const ownMail = await runInTenantScope({ tenantId: own, system: false }, () => isSmtpConfigured()).catch(() => false);
  return ownMail ? own : DEFAULT_TENANT_ID;
}

export async function sendAccountEmail(userId: string, mail: { to: string; subject: string; text: string }): Promise<boolean> {
  try {
    const tenantId = await accountMailTenantId(userId);
    const result = await runInTenantScope({ tenantId, system: false }, () => sendEmail(mail));
    if (!result.ok) await logError("account-email", `Account email not sent: ${result.error ?? "unknown"}`);
    return result.ok;
  } catch (error) {
    await logError("account-email", error, "Account email not sent");
    return false;
  }
}

/** Run an account action's bookkeeping (its audit entry) in the person's own workspace. */
export async function inAccountWorkspace<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return runInTenantScope({ tenantId: (await accountWorkspaceId(userId)) ?? DEFAULT_TENANT_ID, system: false }, fn);
}
