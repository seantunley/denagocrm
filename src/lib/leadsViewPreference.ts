import "server-only";
import { actingTenantId } from "@/lib/actingTenant";
import { getWorkspaceSetting } from "@/lib/settings";

/**
 * Board or list — each person's own choice, remembered (brief §2; Sean, 2026-11-24:
 * the board stays the default for everyone who has not chosen the list). Kept as a
 * workspace setting under the person's id: no new table for one word per person.
 */
export type LeadsView = "board" | "list";

export const leadsViewKey = (userId: string) => `LEADS_VIEW:${userId}`;

export async function leadsViewPreference(userId: string): Promise<LeadsView> {
  return (await getWorkspaceSetting(await actingTenantId(), leadsViewKey(userId))) === "list" ? "list" : "board";
}
