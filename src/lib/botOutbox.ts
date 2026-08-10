import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { customerRecordTenantId } from "./customerRecordTenant";
import { DEFAULT_TENANT_ID } from "./tenant";
import { withTenantWrite, writeTenantId } from "./tenantWrite";
import type { OutMsg } from "./flow";
import { sendWhatsAppButtons, sendWhatsAppImage, sendWhatsAppList, sendWhatsAppText } from "./whatsapp";
import { sendDirectAttachment, sendDirectMessage, sendDirectQuickReplies } from "./messenger";
import { tgSend, tgSendPhoto } from "./telegramTransport";
import { logError } from "./errorLog";
import { recordBotFlowEvents } from "./botFlowAnalytics";
import type { CronSliceContext } from "./tenantCron";

const FLOW_MARKER = "🤖 Flow";
const MAX_ATTEMPTS = 8;
const LEASE_MS = 5 * 60 * 1000;

type OutboxRow = {
  id: string;
  channel: string;
  key: string;
  batchId: string;
  sequence: number;
  payload: unknown;
  flowVersionId: string | null;
  contactId: string | null;
  leadId: string | null;
  actorId: string | null;
  attempts: number;
  status: string;
  availableAt: Date;
  leaseUntil: Date | null;
  createdAt: Date;
  communicationLoggedAt: Date | null;
};

export type BotOutboxRun = { sent: number; retried: number; dead: number; repairedLogs: number };
type OutboxBudget = Pick<CronSliceContext, "shouldStop">;

/**
 * The tenant whose queue this call may touch.
 *
 * A conversation is identified by `(channel, key)` — a phone number, a Telegram
 * chat id, a Page-scoped id. None of those are unique across tenants: the same
 * customer messaging two tenant-owned WhatsApp numbers produces the SAME key
 * twice. Migration 20260809152000 acknowledged that for BotSession and the
 * outbox was missed, so every conversation query here matched other tenants'
 * rows as well.
 *
 * That was not only a read leak. `blockLaterMessages` mass-marks rows `dead`, and
 * `sendProvider` resolves credentials from the AMBIENT tenant scope rather than
 * from the row — so an unscoped claim could deliver one tenant's message from
 * another tenant's WhatsApp number, or kill their queue.
 *
 * This mirrors exactly what `withTenantWrite` stamps on the way in, so the filter
 * and the writer always agree, including while enforcement is dormant.
 */
function outboxTenantId(): string {
  return writeTenantId() ?? DEFAULT_TENANT_ID;
}

function storedMessages(channel: string, messages: OutMsg[]): OutMsg[] {
  const out: OutMsg[] = [];
  for (const message of messages) {
    if ((channel === "messenger" || channel === "instagram") && message.type === "image" && message.caption) {
      out.push({ type: "image", url: message.url });
      out.push({ type: "text", text: message.caption });
    } else out.push(message);
  }
  return out;
}

/** Legacy convenience wrapper; modern flow runners use botOutboxWrite inside their state transaction. */
export async function enqueueBotMessages(input: {
  channel: string;
  key: string;
  messages: OutMsg[];
  flowVersionId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  actorId?: string | null;
}): Promise<void> {
  if (!input.messages.length) return;
  const batchId = crypto.randomUUID();
  const createdAt = new Date();
  const messages = storedMessages(input.channel, input.messages);
  await withTenantWrite(async (tx, tenantId) => {
    for (let sequence = 0; sequence < messages.length; sequence++) {
      await tx.botFlowOutbox.create({
        data: {
          tenantId,
          channel: input.channel,
          key: input.key,
          batchId,
          sequence,
          payload: messages[sequence] as unknown as Prisma.InputJsonValue,
          flowVersionId: input.flowVersionId ?? null,
          contactId: input.contactId ?? null,
          leadId: input.leadId ?? null,
          actorId: input.actorId ?? null,
          createdAt,
          availableAt: createdAt,
        },
      });
    }
  });
}

function asOutMsg(payload: unknown): OutMsg | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (value.type === "text" && typeof value.text === "string") return { type: "text", text: value.text };
  if (value.type === "image" && typeof value.url === "string") return { type: "image", url: value.url, caption: typeof value.caption === "string" ? value.caption : undefined };
  if (value.type === "choice" && typeof value.text === "string" && Array.isArray(value.options)) {
    const options = value.options
      .filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === "object")
      .filter((option) => typeof option.id === "string" && typeof option.label === "string")
      .map((option) => ({ id: option.id as string, label: option.label as string, description: typeof option.description === "string" ? option.description : undefined }));
    return { type: "choice", text: value.text, options };
  }
  return null;
}

async function sendProvider(row: OutboxRow): Promise<{ ok: boolean; error?: string }> {
  const message = asOutMsg(row.payload);
  if (!message) return { ok: false, error: "Invalid outbox payload" };
  if (row.channel === "whatsapp") {
    if (message.type === "text") return sendWhatsAppText(row.key, message.text);
    if (message.type === "image") return sendWhatsAppImage(row.key, message.url, message.caption);
    return message.options.length <= 3
      ? sendWhatsAppButtons(row.key, message.text, message.options.map((o) => ({ id: o.id, title: o.label })))
      : sendWhatsAppList(row.key, message.text, "Choose", message.options.map((o) => ({ id: o.id, title: o.label, description: o.description })));
  }
  if (row.channel === "messenger" || row.channel === "instagram") {
    if (message.type === "text") return sendDirectMessage(row.channel, row.key, message.text);
    if (message.type === "image") return sendDirectAttachment(row.channel, row.key, { type: "image", url: message.url });
    return sendDirectQuickReplies(row.channel, row.key, message.text, message.options.map((o) => ({ title: o.label, payload: o.id })));
  }
  if (row.channel === "telegram") {
    if (message.type === "text") return tgSend(row.key, message.text);
    if (message.type === "image") return tgSendPhoto(row.key, message.url, message.caption);
    return tgSend(row.key, message.text, message.options.map((o) => ({ id: o.id, label: o.label })));
  }
  return { ok: false, error: `Unsupported bot channel: ${row.channel}` };
}

function timelineBody(row: OutboxRow): string | null {
  const message = asOutMsg(row.payload);
  if (!message) return null;
  if (message.type === "text") return message.text;
  if (message.type === "image") return message.caption ? `🖼 ${message.caption}` : "🖼 [image]";
  return `${message.text}\n${message.options.map((o) => `• ${o.label}`).join("\n")}`;
}

async function repairCommunicationLog(row: OutboxRow): Promise<boolean> {
  if (row.communicationLoggedAt) return false;
  if (!row.actorId || !["whatsapp", "messenger", "instagram"].includes(row.channel)) {
    await prisma.botFlowOutbox.updateMany({ where: { id: row.id, status: "sent", communicationLoggedAt: null }, data: { communicationLoggedAt: new Date() } });
    return true;
  }
  const body = timelineBody(row);
  if (!body) throw new Error("Cannot log invalid bot outbox payload");
  const storedBody = row.channel === "whatsapp" && !row.contactId && !row.leadId ? `${body}\n\n[to +${row.key}]` : body;
  const dedupeKey = `bot-outbox:${row.id}`;
  await prisma.communication.upsert({
    where: { dedupeKey },
    update: {},
    // `tenantForOutbox()` resolves an unowned write to DEFAULT_TENANT_ID because the
    // outbox only needs a stable partition key. A Communication is a customer record
    // and carries composite keys to Contact and Lead, so its owner is theirs.
    create: { type: row.channel, direction: "outbound", subject: FLOW_MARKER, body: storedBody, contactId: row.contactId, leadId: row.leadId, userId: row.actorId, dedupeKey, tenantId: await customerRecordTenantId({ contactId: row.contactId, leadId: row.leadId }) },
  });
  await prisma.botFlowOutbox.updateMany({ where: { id: row.id, status: "sent", communicationLoggedAt: null }, data: { communicationLoggedAt: new Date() } });
  return true;
}

/**
 * The next message this conversation may send.
 *
 * Ordering is enforced at the moment of failure, not for ever. When a message
 * exhausts its retries, `blockLaterMessages` marks the ENTIRE existing backlog
 * for that conversation `dead` in the same step — so nothing that was queued
 * behind the failure can overtake it. A Meta image and its split-out caption die
 * together; the caption cannot arrive alone.
 *
 * Once that has happened the dead rows are history. Treating them as a permanent
 * barrier — which is what excluding only `sent` did — meant one undeliverable
 * message silenced the bot for that customer for ever: every later message sorted
 * behind a row that could never be claimed, with no reaper and no operator
 * surface. An expired token or a customer who blocks the business number is
 * enough to reach eight failed attempts.
 *
 * So dead rows stop being a barrier, and it is safe for them to, precisely
 * because the backlog was already killed. A message enqueued in the narrow window
 * between the final failure and blockLaterMessages survives as `pending` and will
 * send: it is genuinely new, produced after the failure, and holding it back
 * would restore the silence this is fixing.
 */
async function earliestUnfinished(channel: string, key: string): Promise<OutboxRow | null> {
  return prisma.botFlowOutbox.findFirst({
    where: { tenantId: outboxTenantId(), channel, key, status: { notIn: ["sent", "dead"] } },
    orderBy: [{ createdAt: "asc" }, { sequence: "asc" }, { id: "asc" }],
  }) as Promise<OutboxRow | null>;
}

async function claimOldest(channel: string, key: string): Promise<OutboxRow | null> {
  const now = new Date();
  const row = await earliestUnfinished(channel, key);
  if (!row || row.availableAt > now || (row.status === "running" && row.leaseUntil && row.leaseUntil > now)) return null;

  // attempts is the lease generation. Every later mutation must match it so an
  // expired worker cannot complete/fail a lease that another worker reclaimed.
  const leaseUntil = new Date(Date.now() + LEASE_MS);
  const claimed = await prisma.botFlowOutbox.updateMany({
    where: {
      id: row.id,
      attempts: row.attempts,
      availableAt: { lte: now },
      OR: [{ status: { in: ["pending", "retry"] } }, { status: "running", OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }],
    },
    data: { status: "running", attempts: { increment: 1 }, leaseUntil, lastError: null },
  });
  return claimed.count === 1 ? { ...row, status: "running", attempts: row.attempts + 1, leaseUntil } : null;
}

function retryAt(attempts: number): Date { return new Date(Date.now() + Math.min(15 * 60 * 1000, 15_000 * 2 ** Math.max(0, attempts - 1))); }

/**
 * Kill the message AND the backlog behind it in ONE transaction.
 *
 * These were two separate awaited statements. Since `earliestUnfinished` skips
 * dead rows, a concurrent worker could land in the gap between them, step over
 * the just-dead head row, claim the next one and send it — delivering a Meta
 * caption whose image had permanently failed, or a "Choose an option" list with
 * no preceding context. That is a regression against main, where WhatsApp sent
 * inline and sequentially so overtaking was structurally impossible.
 *
 * `running` rows are included deliberately: a row another worker claimed inside
 * the window is exactly the one that would overtake. Its own terminal write is
 * fenced by `attempts`, so this cannot corrupt a live send — the worker simply
 * finds its lease superseded.
 */
async function killMessageAndBacklog(row: OutboxRow, lastError: string): Promise<boolean> {
  const blocked = `Blocked by earlier failed message ${row.id}: ${lastError}`.slice(0, 1000);
  const tenantId = outboxTenantId();
  return prisma.$transaction(async (tx) => {
    const dead = await tx.botFlowOutbox.updateMany({
      where: { id: row.id, status: "running", attempts: row.attempts },
      data: { status: "dead", leaseUntil: null, lastError },
    });
    if (dead.count !== 1) return false;
    await tx.botFlowOutbox.updateMany({
      where: {
        tenantId,
        channel: row.channel,
        key: row.key,
        id: { not: row.id },
        status: { in: ["pending", "retry", "running"] },
      },
      data: { status: "dead", leaseUntil: null, lastError: blocked },
    });
    // Repair the conversation HERE, not in a second best-effort transaction.
    // Separately, the dead-letter could commit, the process die, and the session
    // repair never happen — with no retry left to trigger it, because the message
    // is already terminal. The customer would then be back to waiting at a prompt
    // they never received, which is the exact state this repair exists to prevent.
    await tx.$executeRawUnsafe(
      `UPDATE "BotSession"
          SET "ownership" = 'delivery_failed', "updatedAt" = CURRENT_TIMESTAMP
        WHERE "tenantId" = $1 AND "channel" = $2 AND "key" = $3 AND "ownership" <> 'human'`,
      tenantId,
      row.channel,
      row.key,
    );
    return true;
  });
}

async function failDelivery(row: OutboxRow, error: string): Promise<"retry" | "dead"> {
  const lastError = error.slice(0, 1000);
  if (row.attempts >= MAX_ATTEMPTS) {
    // Kills the message, the backlog behind it, and repairs the conversation —
    // all in one transaction, so none of the three can commit without the others.
    if (!(await killMessageAndBacklog(row, lastError))) return "retry";
    if (row.flowVersionId) {
      await recordBotFlowEvents([{ channel: row.channel, conversationKey: row.key, flowVersionId: row.flowVersionId, eventType: "delivery_failed", metadata: { outboxId: row.id, attempts: row.attempts } }]);
    }
    await logError("bot-outbox", new Error(lastError), `${row.channel}:${row.key}:${row.id}`).catch(() => {});
    return "dead";
  }
  await prisma.botFlowOutbox.updateMany({
    where: { id: row.id, status: "running", attempts: row.attempts },
    data: { status: "retry", leaseUntil: null, lastError, availableAt: retryAt(row.attempts) },
  });
  return "retry";
}

async function deliverClaimed(row: OutboxRow): Promise<"sent" | "retry" | "dead"> {
  let result: { ok: boolean; error?: string };
  try { result = await sendProvider(row); } catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  if (!result.ok) return failDelivery(row, result.error ?? "Provider rejected chatbot message");

  const sent = await prisma.botFlowOutbox.updateMany({
    where: { id: row.id, status: "running", attempts: row.attempts },
    data: { status: "sent", sentAt: new Date(), leaseUntil: null, lastError: null },
  });
  if (sent.count !== 1) {
    // The provider ACCEPTED this message; only our lease was superseded while it
    // was in flight. Record that unconditionally, so the newer lease-holder does
    // not send it a second time and — more importantly — so a later error on the
    // duplicate cannot carry the row to `dead` and reset a conversation the
    // customer was in fact receiving. A delivery that succeeded must never end up
    // recorded as a delivery failure.
    await prisma.botFlowOutbox.updateMany({
      where: { id: row.id, status: { notIn: ["sent", "dead"] } },
      data: { status: "sent", sentAt: new Date(), leaseUntil: null, lastError: null },
    });
    await logError("bot-outbox-stale-lease", new Error("Provider accepted a send after this worker's outbox lease was superseded; recorded as sent so it is not delivered twice"), row.id).catch(() => {});
    await repairCommunicationLog({ ...row, status: "sent" }).catch(() => {});
    return "sent";
  }
  await repairCommunicationLog({ ...row, status: "sent" }).catch(async (error) => { await logError("bot-outbox-log", error, row.id).catch(() => {}); });
  return "sent";
}

/** Immediate best-effort drain for the conversation that just produced output. */
export async function flushBotOutboxConversation(
  channel: string,
  key: string,
  limit = 20,
  budget?: OutboxBudget,
): Promise<BotOutboxRun> {
  const stats: BotOutboxRun = { sent: 0, retried: 0, dead: 0, repairedLogs: 0 };
  for (let i = 0; i < limit; i++) {
    if (budget?.shouldStop(4_000)) break;
    const row = await claimOldest(channel, key);
    if (!row) break;
    const outcome = await deliverClaimed(row);
    stats[outcome === "sent" ? "sent" : outcome === "retry" ? "retried" : "dead"] += 1;
    if (outcome !== "sent") break;
  }
  return stats;
}

/** Repair sent messages whose provider delivery succeeded but CRM logging did not. */
async function repairPendingCommunicationLogs(limit: number, budget?: OutboxBudget): Promise<number> {
  const rows = await prisma.botFlowOutbox.findMany({
    where: { tenantId: outboxTenantId(), status: "sent", communicationLoggedAt: null },
    orderBy: { sentAt: "asc" },
    take: limit,
  }) as OutboxRow[];
  let repaired = 0;
  for (const row of rows) {
    if (budget?.shouldStop(4_000)) break;
    try {
      if (await repairCommunicationLog(row)) repaired += 1;
    } catch (error) {
      await logError("bot-outbox-log", error, row.id).catch(() => {});
    }
  }
  return repaired;
}

/** Per-tenant cron drain. Conversation ordering is preserved by claimOldest(). */
export async function flushBotOutbox(limit = 50, budget?: OutboxBudget): Promise<BotOutboxRun> {
  const stats: BotOutboxRun = { sent: 0, retried: 0, dead: 0, repairedLogs: 0 };
  if (budget?.shouldStop(4_000)) return stats;
  stats.repairedLogs = await repairPendingCommunicationLogs(Math.min(limit, 25), budget);
  if (budget?.shouldStop(4_000)) return stats;

  const due = await prisma.botFlowOutbox.findMany({
    where: { tenantId: outboxTenantId(), status: { notIn: ["sent", "dead"] }, availableAt: { lte: new Date() } },
    orderBy: [{ createdAt: "asc" }, { sequence: "asc" }],
    take: limit * 2,
    select: { channel: true, key: true },
  });

  const conversations = [...new Set(due.map((row) => `${row.channel}\u0000${row.key}`))];
  let remaining = limit;
  for (const conversation of conversations) {
    if (remaining <= 0 || budget?.shouldStop(4_000)) break;
    const split = conversation.indexOf("\u0000");
    const channel = conversation.slice(0, split);
    const key = conversation.slice(split + 1);
    const run = await flushBotOutboxConversation(channel, key, remaining, budget);
    stats.sent += run.sent;
    stats.retried += run.retried;
    stats.dead += run.dead;
    remaining -= run.sent + run.retried + run.dead;
  }
  return stats;
}
