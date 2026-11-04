import "server-only";
import { prisma } from "./db";
import { botConversationTenantId } from "./botTenant";
import { withInboundBotEvent } from "./botInboundEvent";
import { isFlowEnabled, runWhatsAppFlow } from "./flowRun";
import { NO_REPLY_AT, NO_REPLY_CLAIMED, noReplyDueAt, noReplyEventId } from "./flowNoReply";
import { logError } from "./errorLog";

/**
 * THE NO-REPLY SWEEP (lib/flowNoReply; inside api/cron/bot-outbox, every 30 minutes, per workspace): WhatsApp
 * conversations whose question went unanswered past its deadline are moved along that question's "no reply" route
 * through the normal runner — which CLAIMS the timeout before any step runs (claimNoReplyTx), so a customer's answer
 * or a staff takeover that came first means nothing happens at all.
 *
 * Each timeout runs under its own identity (noReplyEventId: workspace, conversation, question, deadline), exactly
 * as a customer message runs under its provider event's — so a Start Journey or a CRM step on the no-reply route
 * gets the same retry-safe action key, and a timeout picked up again after a crash does nothing twice.
 * Nothing here sends: the runner queues, the caller flushes.
 */
export async function sweepNoReply(shouldStop: (reserveMs?: number) => boolean, limit = 50): Promise<{ checked: number; moved: number }> {
  if (!(await isFlowEnabled())) return { checked: 0, moved: 0 };
  const tenantId = botConversationTenantId();
  const rows = await prisma.botSession.findMany({
    where: {
      tenantId, channel: "whatsapp", status: "active", ownership: "bot", expiresAt: { gt: new Date() },
      OR: [{ vars: { contains: `"${NO_REPLY_AT}"` } }, { vars: { contains: `"${NO_REPLY_CLAIMED}"` } }],
    },
    select: { key: true, nodeId: true, vars: true },
    orderBy: { updatedAt: "asc" },
    take: limit * 4,
  });
  const now = Date.now();
  let moved = 0;
  for (const row of rows) {
    if (moved >= limit || shouldStop(6_000)) break;
    let vars: Record<string, string>;
    try { vars = JSON.parse(row.vars); } catch { continue; }
    const at = noReplyDueAt(row.nodeId, vars, now);
    if (!at || !row.nodeId) continue;
    const nodeId = row.nodeId;
    try {
      await withInboundBotEvent({ rowId: noReplyEventId(tenantId, row.key, nodeId, at), leaseAttempt: null }, () =>
        runWhatsAppFlow(row.key, { text: "" }, undefined, { nodeId, at }));
      moved += 1;
    } catch (error) {
      // One conversation failing must not stop the rest; no customer details in the log.
      await logError("bot-no-reply", error, "a no-reply move failed").catch(() => {});
    }
  }
  return { checked: rows.length, moved };
}
