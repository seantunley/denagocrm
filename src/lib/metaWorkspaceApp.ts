import "server-only";
import { basePrisma } from "./db";
import { resolveTenantCredential } from "./settings";

/**
 * A WORKSPACE'S OWN META APP (Sean, 2026-11-21: "Each workspace will have its own").
 *
 * The platform's Meta app delivers to /api/webhooks/meta and is checked against the
 * platform's app secret, as before. A workspace that brings its own app points that
 * app at /api/webhooks/meta?workspace=<its slug>: its deliveries are checked against
 * ITS app secret and verify token (Settings → Integrations → Meta, this workspace's
 * own values), and are processed only for the Page / Instagram account registered to
 * it (withChannelTenantScope's `onlyTenantId`).
 *
 * Null for an unknown or inactive workspace — the caller answers 404, so a guessed
 * slug learns nothing and reaches nothing.
 */
export type WorkspaceMetaApp = { tenantId: string; appSecret: string | null; verifyToken: string | null };

export async function workspaceMetaApp(slug: string): Promise<WorkspaceMetaApp | null> {
  const clean = slug.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(clean)) return null;
  const tenant = await basePrisma.tenant.findUnique({ where: { slug: clean }, select: { id: true, active: true } });
  if (!tenant?.active) return null;
  // This workspace's OWN app values — never the platform app's (META_APP_SECRET stays the platform's alone).
  const [appSecret, verifyToken] = await Promise.all([
    resolveTenantCredential(tenant.id, "META_OWN_APP_SECRET"),
    resolveTenantCredential(tenant.id, "META_OWN_VERIFY_TOKEN"),
  ]);
  return { tenantId: tenant.id, appSecret, verifyToken };
}

/**
 * Where a workspace's own Meta app delivers: the platform address plus `?workspace=<slug>` — Pages and Instagram to
 * /api/webhooks/meta, WhatsApp to /api/webhooks/whatsapp (the same app secret and verify token check both).
 */
export function workspaceMetaCallbackUrl(origin: string, slug: string, hook: "meta" | "whatsapp" = "meta"): string {
  return `${origin.replace(/\/$/, "")}/api/webhooks/${hook}?workspace=${encodeURIComponent(slug)}`;
}
