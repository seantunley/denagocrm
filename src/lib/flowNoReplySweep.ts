import "server-only";
import { prisma } from "./db";
import { botConversationTenantId } from "./botTenant";
import { isFlowEnabled, runWhatsAppFlow } from "./flowRun";
import { NO_REPLY_AT, noReplyDue } from "./flowNoReply";
import { logError } from "./errorLog";

/**
 * THE NO-REPLY SWEEP (lib/flowNoReply; inside api/cron/bot-outbox, every 30 minutes, per workspace): WhatsApp conversations
 * whose question went unanswered past its deadline are moved along that question's "no reply" route — through the
 * normal runner, so ownership, the 24-hour window, the outbox and analytics all apply, and a customer's answer that
 * lands at the same moment wins (botSessionStillWaitingTx). Nothing here sends: the runner queues, the caller flushes.
 */
export async function sweepNoReply(shouldStop: (reserveMs?: number) => boolean, limit = 50): Promise<{ checked: number; moved: number }> {
  if (!(await isFlowEnabled())) return { checked: 0, moved: 0 };
  const tenantId = botConversationTenantId();
  const rows = await prisma.botSession.findMany({
    where: { tenantId, channel: "whatsapp", status: "active", ownership: "bot", expiresAt: { gt: new Date() }, vars: { contains: `"${NO_REPLY_AT}"` } },
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
    if (!noReplyDue(row.nodeId, vars, now)) continue;
    try {
      await runWhatsAppFlow(row.key, { text: "" }, undefined, { nodeId: row.nodeId!, at: vars[NO_REPLY_AT] });
      moved += 1;
    } catch (error) {
      // One conversation failing must not stop the rest; no customer details in the log.
      await logError("bot-no-reply", error, "a no-reply move failed").catch(() => {});
    }
  }
  return { checked: rows.length, moved };
}
