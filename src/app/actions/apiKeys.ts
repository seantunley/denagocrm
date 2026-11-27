"use server";

import { revalidatePath } from "next/cache";
import { requireTenantOwner } from "@/lib/auth";
import { asActionResult, refuse } from "@/lib/actionResult";
import { actingTenantId } from "@/lib/actingTenant";
import { logAudit } from "@/lib/audit";
import { createWorkspaceApiKey, parseApiKeyScopes, revokeWorkspaceApiKey } from "@/lib/apiKeys";

/*
 * A workspace's own public API keys — what its website, booking widget and
 * service lookup send as X-Api-Key (lib/apiKeys.ts). The workspace's owner makes
 * and revokes them for THEIR workspace only (Sean, 2026-11-27: "each workspace
 * has to have their own details").
 */

const MAX_LABEL = 60;

/**
 * Make a key that may do exactly what was ticked (intake, bookings, service lookup — checked here, not trusted from
 * the page). The raw key comes back this once — it is stored only as a hash.
 */
export async function createApiKey(label: string, scopes: unknown): Promise<{ rawKey: string; prefix: string } | { error: string }> {
  const made: { key?: { rawKey: string; prefix: string } } = {};
  const result = await asActionResult(async () => {
    const user = await requireTenantOwner();
    const name = String(label ?? "").trim().slice(0, MAX_LABEL);
    if (!name) refuse("Name the key after where it is used, e.g. “Website”.");
    const allowed = parseApiKeyScopes(scopes);
    if (!allowed) refuse("Choose what the key may do — at least one of website leads, bookings or service lookup.");
    const tenantId = await actingTenantId();
    const key = await createWorkspaceApiKey(tenantId, name, allowed);
    await logAudit({
      action: "api_key.created",
      summary: `Created the API key “${name}” (${key.prefix}…) for ${allowed.join(", ")}`,
      entityType: "TenantApiKey",
      entityId: key.id,
      user,
    });
    made.key = { rawKey: key.rawKey, prefix: key.prefix };
    revalidatePath("/settings/integrations");
  });
  return made.key ?? { error: result.error ?? "The key could not be made." };
}

/** Revoke a key: anything still sending it is refused from now on. */
export async function revokeApiKey(id: string) {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const tenantId = await actingTenantId();
    if (!(await revokeWorkspaceApiKey(tenantId, String(id)))) refuse("That key is already revoked.");
    await logAudit({ action: "api_key.revoked", summary: "Revoked an API key", entityType: "TenantApiKey", entityId: String(id), user });
    revalidatePath("/settings/integrations");
    return { success: "Key revoked — it no longer works" };
  });
}
