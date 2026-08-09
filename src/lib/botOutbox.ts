import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { withTenantWrite } from "./tenantWrite";
import type { OutMsg } from "./flow";
import {
  sendWhatsAppButtons,
  sendWhatsAppImage,
  sendWhatsAppList,
  sendWhatsAppText,
} from "./whatsapp";
import {
  sendDirectAttachment,
  sendDirectMessage,
  sendDirectQuickReplies,
} from "./messenger";
import { tgSend, tgSendPhoto } from "./telegramTransport";
import { logError } from "./errorLog";

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

function storedMessages(channel: string, messages: OutMsg[]): OutMsg[] {
  const out: OutMsg[] = [];
  for (const message of messages) {
    // Messenger/Instagram render an image caption as a second provider message.
    // Store those as TWO durable rows so a caption failure retries the caption,
    // not the already-delivered image.
    if ((channel === "messenger" || channel === "instagram") && message.type === "image" && message.caption) {
      out.push({ type: "image", url: message.url });
      out.push({ type: "text", text: message.caption });
    } else {
      out.push(message);
    }
  }
  return out;
}

/** Persist a whole engine output batch atomically before BotSession advances. */
export async function enqueueBotMessages(input: {
  channel: string;
  key: string;
  messages: OutMsg[];
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
  if (value.type === "image" && typeof value.url === "string") {
    return {
      type: "image",
      url: value.url,
      caption: typeof value.caption === "string" ? value.caption : undefined,
    };
  }
  if (value.type === "choice" && typeof value.text === "string" && Array.isArray(value.options)) {
    const options = value.options
      .filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === "object")
      .filter((option) => typeof option.id === "string" && typeof option.label === "string")
      .map((option) => ({
        id: option.id as string,
        label: option.label as string,
        description: typeof option.description === "string" ? option.description : undefined,
      }));
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
      : sendWhatsAppList(
          row.key,
          message.text,
          "Choose",
          message.options.map((o) => ({ id: o.id, title: o.label, description: o.description })),
        );
  }

  if (row.channel === "messenger" || row.channel === "instagram") {
    if (message.type === "text") return sendDirectMessage(row.channel, row.key, message.text);
    if (message.type === "image") return sendDirectAttachment(row.channel, row.key, { type: "image", url: message.url });
    return sendDirectQuickReplies(
      row.channel,
      row.key,
      message.text,
      message.options.map((o) => ({ title: o.label, payload: o.id })),
    );
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

/** Repair CRM timeline logging independently of provider delivery. */
async function repairCommunicationLog(row: OutboxRow): Promise<boolean> {
  if (row.communicationLoggedAt) return false;
  if (!row.actorId || !["whatsapp", "messenger", "instagram"].includes(row.channel)) {
    await prisma.botFlowOutbox.updateMany({
      where: { id: row.id, status: "sent", communicationLoggedAt: null },
      data: { communicationLoggedAt: new Date() },
    });
    return true;
  }

  const body = timelineBody(row);
  if (!body) throw new Error("Cannot log invalid bot outbox payload");
  const storedBody = row.channel === "whatsapp" && !row.contactId && !row.leadId
    ? `${body}\n\n[to +${row.key}]`
    : body;
  const dedupeKey = `bot-outbox:${row.id}`;

  await prisma.communication.upsert({
    where: { dedupeKey },
    update: {},
    create: {
      type: row.channel,
      direction: "outbound",
      subject: FLOW_MARKER,
      body: storedBody,
      contactId: row.contactId,
      leadId: row.leadId,
      userId: row.actorId,
      dedupeKey,
    },
  });
  await prisma.botFlowOutbox.updateMany({
    where: { id: row.id, status: "sent", communicationLoggedAt: null },
    data: { communicationLoggedAt: new Date() },
  });
  return true;
}

async function earliestUnfinished(channel: string, key: string): Promise<OutboxRow | null> {
  return prisma.botFlowOutbox.findFirst({
    where: { channel, key, status: { notIn: ["sent", "dead"] } },
    orderBy: [{ createdAt: "asc" }, { sequence: "asc" }, { id: "asc" }],
  }) as Promise<OutboxRow | null>;
}

async function claimOldest(channel: string, key: string): Promise<OutboxRow | null> {
  const now = new Date();
  const row = await earliestUnfinished(channel, key);
  if (!row) return null;
  if (row.availableAt > now) return null;
  if (row.status === "running" && row.leaseUntil && row.leaseUntil > now) return null;

  const claimed = await prisma.botFlowOutbox.updateMany({
    where: {
      id: row.id,
      availableAt: { lte: now },
      OR: [
        { status: { in: ["pending", "retry"] } },
        { status: "running", OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      ],
    },
    data: {
      status: "running",
      attempts: { increment: 1 },
      leaseUntil: new Date(Date.now() + LEASE_MS),
      lastError: null,
    },
  });
  if (claimed.count !== 1) return null;
  return prisma.botFlowOutbox.findUnique({ where: { id: row.id } }) as Promise<OutboxRow | null>;
}

function retryAt(attempts: number): Date {
  const delayMs = Math.min(15 * 60 * 1000, 15_000 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + delayMs);
}

async function failDelivery(row: OutboxRow, error: string): Promise<"retry" | "dead"> {
  const lastError = error.slice(0, 1000);
  if (row.attempts >= MAX_ATTEMPTS) {
    await prisma.botFlowOutbox.updateMany({
      where: { id: row.id, status: "running" },
      data: { status: "dead", leaseUntil: null, lastError },
    });
    await logError("bot-outbox", new Error(lastError), `${row.channel}:${row.key}:${row.id}`).catch(() => {});
    return "dead";
  }
  await prisma.botFlowOutbox.updateMany({
    where: { id: row.id, status: "running" },
    data: { status: "retry", leaseUntil: null, lastError, availableAt: retryAt(row.attempts) },
  });
  return "retry";
}

async function deliverClaimed(row: OutboxRow): Promise<"sent" | "retry" | "dead"> {
  let result: { ok: boolean; error?: string };
  try {
    result = await sendProvider(row);
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result.ok) return failDelivery(row, result.error ?? "Provider rejected chatbot message");

  // Provider acceptance is final for delivery purposes. Timeline logging is a
  // separate repairable state so a CRM insert failure never resends to customer.
  await prisma.botFlowOutbox.updateMany({
    where: { id: row.id, status: "running" },
    data: { status: "sent", sentAt: new Date(), leaseUntil: null, lastError: null },
  });
  await repairCommunicationLog({ ...row, status: "sent" }).catch(async (error) => {
    await logError("bot-outbox-log", error, row.id).catch(() => {});
  });
  return "sent";
}

/** Immediate best-effort drain for the conversation that just produced output. */
export async function flushBotOutboxConversation(
  channel: string,
  key: string,
  limit = 20,
): Promise<BotOutboxRun> {
  const stats: BotOutboxRun = { sent: 0, retried: 0, dead: 0, repairedLogs: 0 };
  for (let i = 0; i < limit; i++) {
    const row = await claimOldest(channel, key);
    if (!row) break;
    const outcome = await deliverClaimed(row);
    stats[outcome === "sent" ? "sent" : outcome === "retry" ? "retried" : "dead"] += 1;
    if (outcome === "retry") break;
  }
  return stats;
}

/** Repair sent messages whose provider delivery succeeded but CRM logging did not. */
async function repairPendingCommunicationLogs(limit: number): Promise<number> {
  const rows = await prisma.botFlowOutbox.findMany({
    where: { status: "sent", communicationLoggedAt: null },
    orderBy: { sentAt: "asc" },
    take: limit,
  }) as OutboxRow[];
  let repaired = 0;
  for (const row of rows) {
    try {
      if (await repairCommunicationLog(row)) repaired += 1;
    } catch (error) {
      await logError("bot-outbox-log", error, row.id).catch(() => {});
    }
  }
  return repaired;
}

/** Per-tenant cron drain. Conversation ordering is preserved by claimOldest(). */
export async function flushBotOutbox(limit = 50): Promise<BotOutboxRun> {
  const stats: BotOutboxRun = { sent: 0, retried: 0, dead: 0, repairedLogs: 0 };
  stats.repairedLogs = await repairPendingCommunicationLogs(Math.min(limit, 25));

  const due = await prisma.botFlowOutbox.findMany({
    where: { status: { notIn: ["sent", "dead"] }, availableAt: { lte: new Date() } },
    orderBy: [{ createdAt: "asc" }, { sequence: "asc" }],
    take: limit * 2,
    select: { channel: true, key: true },
  });

  const conversations = [...new Set(due.map((row) => `${row.channel}\u0000${row.key}`))];
  let remaining = limit;
  for (const conversation of conversations) {
    if (remaining <= 0) break;
    const split = conversation.indexOf("\u0000");
    const channel = conversation.slice(0, split);
    const key = conversation.slice(split + 1);
    const run = await flushBotOutboxConversation(channel, key, remaining);
    stats.sent += run.sent;
    stats.retried += run.retried;
    stats.dead += run.dead;
    remaining -= run.sent + run.retried + run.dead;
  }
  return stats;
}
