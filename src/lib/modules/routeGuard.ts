import "server-only";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getEnabledModuleIds } from "./enabled";
import { isPathEnabled } from "./registry";

/**
 * Single-point route block: a page belonging to a disabled module is not
 * reachable by direct URL, not just hidden from the nav. Core paths always
 * pass; the pathname comes from middleware (x-pathname header). Call this from
 * every top-level layout that can serve module-owned routes — (app), the
 * /messages PWA, and the (print) document pages — so the guard can't be
 * bypassed by rendering under a different layout.
 */
export async function assertPathModuleEnabled(): Promise<void> {
  const enabled = await getEnabledModuleIds().catch(() => null);
  if (!enabled) return;
  const pathname = (await headers()).get("x-pathname") ?? "";
  if (pathname.startsWith("/") && !isPathEnabled(pathname, enabled)) {
    notFound();
  }
}
