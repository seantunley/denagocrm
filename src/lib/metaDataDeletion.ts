import "server-only";
import crypto from "crypto";
import { basePrisma } from "./db";
import { getSetting, putSetting } from "./settings";
import { withSystemScope } from "./tenantScopeEntry";
import { runInTenantScope } from "./tenantScope";
import { CONNECTED } from "./metaPage";
import { disconnectMetaPage } from "./metaConnect";
import { logAudit } from "./audit";

/**
 * META'S DATA-DELETION CALLBACK (required for App Review; the public page is /legal/data-deletion).
 *
 * When a person removes the platform's app from their Facebook account and asks for their data to be deleted, Meta
 * calls us with a signed request naming them (their app-scoped user id). What we hold about THAT person is the
 * connection they made with Connect Facebook: the Page token it gave, recorded against META_CONNECTED_BY_USER. Every
 * workspace connection made by them is disconnected and forgotten, each in its own workspace's scope, and audited
 * there. The business's own customer conversations belong to that business, not to the person who connected it,
 * and stay with the business.
 *
 * Meta wants a status address and a confirmation code back; the code is recorded so the page can confirm it later.
 */
const STATUS_PREFIX = "META_DELETION:";

export async function metaPlatformSecret(): Promise<string | null> {
  return withSystemScope(async () => await getSetting("META_APP_SECRET"));
}

export async function deleteMetaUserData(metaUserId: string): Promise<{ code: string; workspaces: number }> {
  // Plain (not encrypted) value: META_CONNECTED_BY_USER is an id, not a secret. A deliberate cross-workspace read —
  // the request names a person, not a workspace — of exactly one key, returning only the workspace ids.
  const rows = await withSystemScope(async () =>
    await basePrisma.tenantIntegrationCredential.findMany({ where: { key: CONNECTED.byUser, value: metaUserId }, select: { tenantId: true } }),
  );
  const tenantIds = [...new Set(rows.map((row) => row.tenantId))];
  for (const tenantId of tenantIds) {
    await runInTenantScope({ tenantId, system: false }, async () => {
      const name = await disconnectMetaPage(tenantId);
      await logAudit({
        action: "integration.meta_data_deleted",
        summary: `Meta asked for the data of the person who connected ${name ? `the Facebook Page "${name}"` : "Facebook"} to be deleted; the connection was removed`,
        userName: "Meta (data deletion request)",
      });
    });
  }
  const code = crypto.randomBytes(9).toString("base64url");
  await withSystemScope(async () =>
    await putSetting(STATUS_PREFIX + code, JSON.stringify({ at: new Date().toISOString(), workspaces: tenantIds.length })),
  );
  return { code, workspaces: tenantIds.length };
}

/** For the status page: when a request with this code was completed, or null for an unknown code. */
export async function metaDeletionStatus(code: string): Promise<{ at: string } | null> {
  if (!/^[A-Za-z0-9_-]{8,24}$/.test(code)) return null;
  const raw = await withSystemScope(async () => await getSetting(STATUS_PREFIX + code));
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as { at?: string };
    return saved.at ? { at: saved.at } : null;
  } catch {
    return null;
  }
}
