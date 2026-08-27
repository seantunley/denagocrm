"use server";

import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { requireTenantOwner, getActiveTenantId } from "@/lib/auth";
import { putTenantCredential } from "@/lib/settings";
import { isKnownTenantCredentialKey } from "@/lib/tenantCredentialFields";
import { integrationsUsingCredentialKey } from "@/lib/integrationFlow";
import { clearIntegrationVerification } from "@/lib/integrationConnection";
import { logAuditStrict } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";

const OVERRIDES_PATH = "/settings/integration-overrides";

/**
 * A credential key just changed by hand, so nothing is proven about the bundle
 * it belongs to any more — drop the verification verdict for every integration
 * that uses it.
 *
 * Without this, the wizard's "Connected, verified on the 3rd" survives a
 * password being replaced or deleted underneath it, and the page ranks
 * `lastVerifiedAt` above override presence — so the stale verdict is what the
 * owner sees. Re-running the guided setup (or Test connection) is what earns the
 * badge back, which is the point: it means the credentials were actually tried.
 */
async function invalidateVerificationForKey(tenantId: string, key: string): Promise<void> {
  for (const integrationId of integrationsUsingCredentialKey(key)) {
    await clearIntegrationVerification(tenantId, integrationId);
  }
}

/**
 * Save (or replace) THIS tenant's own override for one outbound-integration
 * credential key. Owner-only — re-checked here, not just at the page, since a
 * server action is a POST endpoint reachable directly. `tenantId` always comes
 * from the caller's own session (getActiveTenantId), never from the form —
 * an owner can only ever set an override for their own active tenant.
 */
export async function saveTenantCredentialOverride(formData: FormData): Promise<void> {
  return withActingStaffScope(async () => {
    const user = await requireTenantOwner();
    const key = String(formData.get("key") ?? "");
    if (!isKnownTenantCredentialKey(key)) throw new Error("Unknown integration credential key.");

    const value = String(formData.get("value") ?? "").trim();
    // The field never echoes back a saved value (secret or plain — this UI never
    // renders one), so a blank submit means "leave whatever's saved (override or
    // platform default) alone" — same "leave blank to keep" semantics as the
    // global settings page's secret fields. Clearing an override is a separate,
    // explicit action (clearTenantCredentialOverride).
    if (!value) return;

    const tenantId = await getActiveTenantId();
    if (!tenantId) throw new Error("No active tenant — can't save a tenant-specific override.");

    await putTenantCredential(tenantId, key, value);
    // The stored bundle changed, so any verification verdict about it is now
    // about a credential that no longer exists.
    await invalidateVerificationForKey(tenantId, key);
    // Never log the value itself (secret or not) — only that an override for
    // this key was set, mirroring how the global page's saveSetting action never
    // writes a credential value into an audit entry either.
    await logAuditStrict({
      action: "tenant_credential.override_set",
      summary: `Set a tenant override for ${key}`,
      entityType: "TenantIntegrationCredential",
      entityId: `${tenantId}:${key}`,
      user,
      after: { key },
    });
    revalidatePath(OVERRIDES_PATH);
  });
}

/**
 * Clear THIS tenant's own override for one credential key, reverting it back
 * to the platform's shared default. Owner-only, and the key is allowlisted —
 * a server action's bound arg comes from the client, so we must not delete an
 * arbitrary row. Uses deleteMany (not delete) so a repeat/duplicate submit is
 * a harmless no-op instead of a P2025 "record not found" error.
 */
export async function clearTenantCredentialOverride(key: string): Promise<void> {
  return withActingStaffScope(async () => {
    const user = await requireTenantOwner();
    if (!isKnownTenantCredentialKey(key)) throw new Error("Unknown integration credential key.");

    const tenantId = await getActiveTenantId();
    if (!tenantId) throw new Error("No active tenant — nothing to clear.");

    await basePrisma.tenantIntegrationCredential.deleteMany({ where: { tenantId, key } });
    // Reverting to the platform default is just as much a change to what the
    // bundle IS — the old verdict was about the override that just went away.
    await invalidateVerificationForKey(tenantId, key);
    await logAuditStrict({
      action: "tenant_credential.override_cleared",
      summary: `Cleared the tenant override for ${key}`,
      entityType: "TenantIntegrationCredential",
      entityId: `${tenantId}:${key}`,
      user,
    });
    revalidatePath(OVERRIDES_PATH);
  });
}
