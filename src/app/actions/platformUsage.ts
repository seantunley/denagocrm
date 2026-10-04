"use server";

import { requirePlatformAdminAction } from "@/lib/platformAuth";
import {
  getTenantActivity,
  getTenantStorage,
  type TenantActivity,
  type TenantStorage,
} from "@/lib/tenantUsage";
import { tenantBlobUsage, type TenantBlobUsage } from "@/lib/storage";

/** `files` is null when Blob storage isn't configured or couldn't be listed. */
export type TenantUsage = { storage: TenantStorage; activity: TenantActivity; files: TenantBlobUsage | null };

/**
 * Usage figures for one tenant, fetched on demand by the console's Usage tab.
 *
 * This exists as an ACTION rather than being rendered with the rest of the
 * profile because the storage estimate is the most expensive thing the console
 * does — one COUNT per sampled table. Rendered server-side it ran on every
 * profile visit, including for someone who only wanted the Errors tab; a
 * Suspense boundary made that non-blocking but did not make it optional. Behind
 * an action it runs when, and only when, somebody opens the tab.
 *
 * Platform-admin auth is re-checked here rather than trusted from the page:
 * an action is a public endpoint, so the caller could be anybody.
 */
export async function loadTenantUsage(tenantId: string): Promise<TenantUsage> {
  await requirePlatformAdminAction();

  const [storage, activity, files] = await Promise.all([
    getTenantStorage(tenantId),
    getTenantActivity(tenantId),
    // A Blob outage must not take the database figures down with it.
    tenantBlobUsage(tenantId).catch(() => null),
  ]);

  return { storage, activity, files };
}
