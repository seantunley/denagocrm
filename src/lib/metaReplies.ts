import { prisma } from "./db";
import { actingTenantId } from "./actingTenant";

/**
 * Whether Meta is refusing this workspace's Messenger and Instagram replies (Sean, 2026-11-09: "I thought we
 * fixed this"). Until Meta approves the app, it delivers only to people with a role on it — every reply to a real
 * customer dies `app_not_approved`, and the inbox was inviting staff to type replies that could never go.
 *
 * Read from what actually happened, not a setting: the workspace's most recent Messenger/Instagram reply that
 * finished (sent or dead). Refused → the inbox hands off to Meta Business Suite. The moment one is delivered — the
 * app approved, or this workspace's own Meta app — the reply box is back, with nothing to switch.
 */
export async function metaRepliesRefused(): Promise<boolean> {
  const tenantId = await actingTenantId();
  const latest = await prisma.botFlowOutbox.findFirst({
    where: { tenantId, channel: { in: ["messenger", "instagram"] }, status: { in: ["sent", "dead"] } },
    orderBy: { updatedAt: "desc" },
    select: { status: true, failureCode: true },
  });
  return latest?.status === "dead" && latest.failureCode === "app_not_approved";
}
