import { prisma } from "./db";
import { actingTenantId } from "./actingTenant";

/** How long one "app not approved" refusal keeps a channel handed off to Meta Business Suite. */
export const META_REFUSAL_WINDOW_DAYS = 30;

export type MetaRefusals = { messenger: boolean; instagram: boolean };

/**
 * Whether Meta is refusing this workspace's Messenger and Instagram replies — PER CHANNEL (Sean, 2026-11-09: "I
 * thought we fixed this"). Until Meta approves the app it delivers only to people with a role on it, so every reply
 * to a real customer dies `app_not_approved`, and the inbox was inviting staff to type replies that could never go.
 *
 * Read from what actually happened, not a setting: a channel is handed off while Meta has refused one of its
 * replies as "app not approved" in the last {@link META_REFUSAL_WINDOW_DAYS} days. A DELIVERED reply does NOT
 * clear it (review of #1042): Meta delivers to the app's testers, so a reply that arrived proves nothing about
 * customers — the previous "latest reply wins" rule let one test message bring the box back for everyone. Once
 * Meta approves the app the refusals stop, and the box returns by itself when the last one ages out; in between,
 * "Send from the CRM anyway" is on the hand-off.
 */
export async function metaRepliesRefused(): Promise<MetaRefusals> {
  const tenantId = await actingTenantId();
  const since = new Date(Date.now() - META_REFUSAL_WINDOW_DAYS * 86_400_000);
  const refused = await prisma.botFlowOutbox.groupBy({
    by: ["channel"],
    where: { tenantId, channel: { in: ["messenger", "instagram"] }, status: "dead", failureCode: "app_not_approved", updatedAt: { gte: since } },
  });
  const channels = new Set(refused.map((row) => row.channel));
  return { messenger: channels.has("messenger"), instagram: channels.has("instagram") };
}
