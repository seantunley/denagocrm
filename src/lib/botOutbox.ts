import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant";
import { withTenantWrite, writeTenantId, type TenantWriteTx } from "./tenantWrite";
import { markBotSessionDeliveryFailedTx, pauseBotSessionTx } from "./botSessionStore";
import { logAuditStrict } from "./audit";
import { classifyDeliveryFailure, PERMANENT_FAILURES, staffReplyMatchesRow } from "./messageDelivery";
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

export type StaffReplyResult = {
  /**
   * `created`  — this call wrote the message.
   * `duplicate`— this exact send was already accepted; nothing new was written,
   *              and the ids point at the message this duplicates.
   * `conflict` — the key was already used by a DIFFERENT send. Nothing was
   *              written and nothing is safe to report about it; the caller must
   *              surface this rather than claim either outcome.
   */
  outcome: "created" | "duplicate" | "conflict";
  /** Kept for readability at call sites that only care whether anything was written. */
  created: boolean;
  /** The FIRST part's ids, which is all a single-part caller ever needs. */
  communicationId: string | null;
  outboxId: string | null;
  /** One entry per requested part, in the order they were requested. */
  parts: StaffReplyPartResult[];
};

/** One provider send: what goes out, and what the timeline shows for it. */
export type StaffReplyPart = {
  message: OutboxPayload;
  /** Derived by the caller from the composition AND this part's payload. */
  clientIdempotencyKey: string;
  body: string;
  attachmentUrl?: string | null;
  attachmentType?: string | null;
};

export type StaffReplyPartResult = {
  outcome: "created" | "duplicate";
  communicationId: string | null;
  outboxId: string | null;
};

/**
 * A staff reply: ownership, history and delivery intent, as ONE durable operation.
 *
 * The manual reply paths called the provider first and wrote the CRM record
 * afterwards. A provider success followed by a failed insert left the customer
 * holding a message the CRM had no record of: staff were told it failed, retried,
 * and the customer received it twice. Ordering alone does not fix that — the
 * retry has to be recognisable — so the key stays stable across retries of the
 * same composition.
 *
 * But recording and queueing are not the whole act. Replying by hand is a
 * DECISION about who owns the conversation, and the parts of that decision used
 * to be separate awaits after the write: pause the bot, cancel what it was about
 * to say, write the trail. Anything that interrupted the request between them
 * left the decision half-made — most damagingly, an accepted reply with the bot
 * never paused, which the retry could not repair because the retry recognises the
 * duplicate and returns early. The customer then gets the person's answer and the
 * bot's next scripted line after it.
 *
 * So all of it commits together or none of it does:
 *
 *   1. the bot is paused for this conversation — a person owns it now;
 *   2. automation output still queued for it is CANCELLED, because it was
 *      composed for a conversation the bot was still running and can otherwise
 *      be delivered after the human answer, contradicting it;
 *   3. each part's delivery intent is written, its unique key rejecting a
 *      duplicate before any CRM history exists for it;
 *   4. each part's CRM Communication is written;
 *   5. the two are linked, so the inbox can show what actually happened to the
 *      message rather than assuming it left;
 *   6. the trail commits with the decision it describes.
 *
 * A duplicate key therefore proves the whole decision already committed once.
 *
 * WHY PARTS, AND WHY ONE TRANSACTION FOR ALL OF THEM. Meta has no single call
 * carrying a file and its caption, so an attachment and its text are two provider
 * sends. Accepting them in two separate transactions leaves a state where the
 * first committed and the second did not: the outbox then delivers a bare file
 * with no explanation, and the caption arrives only if the person happens to
 * retry. One transaction removes that state rather than making it recoverable.
 *
 * It also removes a subtler hazard. Two calls meant two runs of the bot-output
 * fence, and the reply's own first part was only spared because the fence filters
 * `origin: "bot"` — a correctness argument resting on one `where` clause, which
 * anyone widening that filter would silently break. The fence now runs once,
 * before any part of this reply exists.
 *
 * Parts are resolved BEFORE the transaction so an edited half still sends. A
 * person whose send half-failed usually corrects the text and submits again;
 * writing all parts blindly would hit the attachment's existing key, roll the
 * whole thing back, and lose the correction. Already-accepted parts are reported
 * as duplicates and only the missing ones are written.
 *
 * Delivery itself remains the outbox worker's job: the same leases, retries,
 * ordering barriers and dead-lettering the bot paths already use, rather than a
 * second parallel ledger for staff sends.
 */
export async function enqueueStaffReply(input: {
  channel: string;
  /** Provider recipient identity: WhatsApp digits, PSID, IG id. */
  key: string;
  /** In the order the customer should receive them. */
  parts: StaffReplyPart[];
  contactId?: string | null;
  leadId?: string | null;
  actorId: string;
  /** Written in the same transaction, so an accepted reply is always accounted for. */
  audit?: { action: string; summary: string; user: { id: string; name: string } };
  /** How long the person keeps the conversation after replying. */
  pauseHours?: number;
}): Promise<StaffReplyResult> {
  if (!input.parts.length) {
    return { outcome: "duplicate", created: false, communicationId: null, outboxId: null, parts: [] };
  }

  const identity = (part: StaffReplyPart) => ({
    channel: input.channel,
    key: input.key,
    actorId: input.actorId,
    contactId: input.contactId,
    leadId: input.leadId,
    payload: part.message,
  });

  /** Rows already holding these keys, by key. */
  const resolveExisting = async () => {
    const rows = await prisma.botFlowOutbox.findMany({
      where: {
        tenantId: outboxTenantId(),
        clientIdempotencyKey: { in: input.parts.map((part) => part.clientIdempotencyKey) },
      },
      select: {
        id: true,
        clientIdempotencyKey: true,
        communicationId: true,
        channel: true,
        key: true,
        actorId: true,
        contactId: true,
        leadId: true,
        payload: true,
      },
    });
    return new Map(rows.map((row) => [row.clientIdempotencyKey as string, row]));
  };

  const conflict = async (rowId: string): Promise<StaffReplyResult> => {
    await logError(
      "staff-reply-idempotency-conflict",
      new Error("An idempotency key resolved to a different send"),
      rowId,
    ).catch(() => {});
    return { outcome: "conflict", created: false, communicationId: null, outboxId: null, parts: [] };
  };

  let existing = await resolveExisting();
  for (const part of input.parts) {
    const row = existing.get(part.clientIdempotencyKey);
    // A key is a CLAIM about identity, and this is where the claim is checked
    // against the row it matched. Answering "already sent" without checking means
    // that if the key ever stops covering some part of the send — a future field,
    // a derivation change — the caller is told a different message is theirs and
    // the real one is silently dropped.
    if (row && !staffReplyMatchesRow(identity(part), row)) return conflict(row.id);
  }

  const pending = input.parts.filter((part) => !existing.has(part.clientIdempotencyKey));
  const resultsFrom = (byKey: typeof existing, createdKeys: Set<string>): StaffReplyResult => {
    const parts: StaffReplyPartResult[] = input.parts.map((part) => {
      const row = byKey.get(part.clientIdempotencyKey);
      return {
        outcome: createdKeys.has(part.clientIdempotencyKey) ? "created" : "duplicate",
        communicationId: row?.communicationId ?? null,
        outboxId: row?.id ?? null,
      };
    });
    const created = parts.some((part) => part.outcome === "created");
    return {
      outcome: created ? "created" : "duplicate",
      created,
      communicationId: parts[0]?.communicationId ?? null,
      outboxId: parts[0]?.outboxId ?? null,
      parts,
    };
  };

  if (!pending.length) return resultsFrom(existing, new Set());

  const batchId = crypto.randomUUID();
  const createdAt = new Date();

  try {
    const written = await withTenantWrite(async (tx, tenantId) => {
      // 1 + 2. Ownership, once for the whole reply and before any part of it
      // exists — so a duplicate submission finding an intent already there knows
      // these happened, and so the fence cannot reach this reply's own rows.
      //
      // Unconditional, for every channel a staff reply can go out on: a
      // BotSession is keyed by (tenant, channel, key), so pausing one that does
      // not exist creates it already paused — the correct state for a
      // conversation a person has answered, whether or not a flow had reached it.
      await pauseBotSessionTx(tx, tenantId, {
        channel: input.channel,
        key: input.key,
        // A PERSON owns this thread now, which is stronger than "paused":
        // nothing the customer types hands it back, only an explicit Return to
        // bot does. Replying by hand is the same claim `Take over` makes, so it
        // must record the same ownership — otherwise the next inbound message
        // returns the conversation to automation under the person's answer.
        ownership: "human",
        expiresAt: new Date(createdAt.getTime() + (input.pauseHours ?? 12) * 3600 * 1000),
      });
      await cancelPendingBotOutputTx(tx, tenantId, input.channel, input.key);

      const links: { key: string; outboxId: string; communicationId: string }[] = [];
      for (let index = 0; index < pending.length; index++) {
        const part = pending[index];
        // 3. The delivery intent, FIRST of the two writes, so the unique
        // (tenantId, clientIdempotencyKey) rejects a duplicate before any CRM
        // history exists for it. Writing the Communication first and discovering
        // the duplicate afterwards would commit a message the CRM claims to have
        // sent and the outbox never queued — the very disagreement this prevents.
        //
        // `sequence` is the order the customer should receive them, and the
        // queue claims a conversation by (createdAt, sequence, id) — so a caption
        // can never overtake the file it describes.
        const queued = await tx.botFlowOutbox.create({
          data: {
            tenantId,
            channel: input.channel,
            key: input.key,
            batchId,
            sequence: index,
            origin: "staff",
            payload: part.message as unknown as Prisma.InputJsonValue,
            clientIdempotencyKey: part.clientIdempotencyKey,
            contactId: input.contactId ?? null,
            leadId: input.leadId ?? null,
            actorId: input.actorId,
            createdAt,
            availableAt: createdAt,
            // Already logged, below, in this same transaction. Without this the
            // delivery worker sees a sent row with an actorId and no log, and
            // writes a SECOND Communication stamped with the bot marker —
            // turning one staff reply into two rows, one attributed to the bot.
            communicationLoggedAt: createdAt,
          },
          select: { id: true },
        });

        // 4. History.
        const communication = await tx.communication.create({
          data: {
            type: input.channel,
            direction: "outbound",
            body: part.body,
            attachmentUrl: part.attachmentUrl ?? null,
            attachmentType: part.attachmentType ?? null,
            contactId: input.contactId ?? null,
            leadId: input.leadId ?? null,
            userId: input.actorId,
            tenantId,
          },
          select: { id: true },
        });

        // 5. The link, without which the inbox can only ever show that a message
        // exists and never whether it arrived.
        await tx.botFlowOutbox.update({
          where: { id: queued.id },
          data: { communicationId: communication.id },
        });

        links.push({ key: part.clientIdempotencyKey, outboxId: queued.id, communicationId: communication.id });
      }

      // 6. One entry for the decision, not one per provider send.
      if (input.audit) {
        await logAuditStrict(
          {
            action: input.audit.action,
            summary: input.audit.summary,
            contactId: input.contactId ?? null,
            leadId: input.leadId ?? null,
            user: input.audit.user,
          },
          tx,
        );
      }

      return links;
    });

    for (const link of written) {
      existing.set(link.key, {
        id: link.outboxId,
        clientIdempotencyKey: link.key,
        communicationId: link.communicationId,
        channel: input.channel,
        key: input.key,
        actorId: input.actorId,
        contactId: input.contactId ?? null,
        leadId: input.leadId ?? null,
        payload: input.parts.find((part) => part.clientIdempotencyKey === link.key)!.message,
      } as never);
    }
    return resultsFrom(existing, new Set(written.map((link) => link.key)));
  } catch (error) {
    // Two submissions racing. The transaction rolled back, so the winner's
    // single copy stands alone — and because the whole decision was in that
    // transaction, the winner also paused the bot, cancelled its backlog and
    // wrote the trail.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      existing = await resolveExisting();
      for (const part of input.parts) {
        const row = existing.get(part.clientIdempotencyKey);
        // The racer wrote something this submission cannot claim, or wrote
        // nothing at all — either way nothing here is safe to report.
        if (!row) return conflict("(no row after a lost race)");
        if (!staffReplyMatchesRow(identity(part), row)) return conflict(row.id);
      }
      return resultsFrom(existing, new Set());
    }
    throw error;
  }
}

/**
 * The single-message form. Everything a one-part reply needs, and the shape the
 * WhatsApp path uses — it has no attachment support, so it never has two parts.
 */
export async function enqueueStaffMessage(input: {
  channel: string;
  key: string;
  message: OutboxPayload;
  clientIdempotencyKey: string;
  body: string;
  contactId?: string | null;
  leadId?: string | null;
  actorId: string;
  attachmentUrl?: string | null;
  attachmentType?: string | null;
  audit?: { action: string; summary: string; user: { id: string; name: string } };
  pauseHours?: number;
}): Promise<StaffReplyResult> {
  const { message, clientIdempotencyKey, body, attachmentUrl, attachmentType, ...rest } = input;
  return enqueueStaffReply({
    ...rest,
    parts: [{ message, clientIdempotencyKey, body, attachmentUrl, attachmentType }],
  });
}

/**
 * Automation output for this conversation that has not left yet, withdrawn.
 *
 * A flow composes its messages for a conversation the BOT is still running. Once
 * a person answers, anything still queued was written under an assumption that no
 * longer holds — it can arrive seconds after the human reply and contradict it,
 * or ask a question the person has just answered. Pausing the session stops the
 * flow producing anything NEW; it does nothing about what is already in the
 * queue, and that backlog is exactly what the customer sees next.
 *
 * `pending` and `retry` only. A `running` row is already at the provider and its
 * lease belongs to a worker: cancelling it here would race that worker to decide
 * what happened to a message that may already have been delivered. Its own
 * completion path is the one place that can answer that, so it is left alone.
 */
async function cancelPendingBotOutputTx(
  tx: TenantWriteTx,
  tenantId: string,
  channel: string,
  key: string,
): Promise<number> {
  const cancelled = await tx.botFlowOutbox.updateMany({
    where: { tenantId, channel, key, origin: "bot", status: { in: ["pending", "retry"] } },
    data: {
      status: "cancelled",
      leaseUntil: null,
      failureCode: "superseded_by_human",
      lastError: "Cancelled: a person took over this conversation before this message was sent",
    },
  });
  return cancelled.count;
}

/**
 * How far each of these timeline rows actually got.
 *
 * The inbox showed "Sent ✓" under every outbound bubble that had no read receipt,
 * because the timeline row was all it had — and a Communication exists from the
 * moment the reply is accepted, long before anything reaches the customer. So a
 * message still queued, and a message the provider rejected eight times, and a
 * message cancelled when a colleague took the conversation over all rendered
 * identically to one that was delivered.
 *
 * Rows with no outbox record are absent from the map. That is the honest answer
 * for them: every outbound message written before this queue existed went out
 * through a direct provider call whose result was never recorded, and inventing
 * a state for those would be worse than showing none.
 */
export type MessageDeliveryState = {
  status: string;
  failureCode: string | null;
  lastError: string | null;
  attempts: number;
};

export async function deliveryStateForMessages(
  communicationIds: string[],
): Promise<Map<string, MessageDeliveryState>> {
  if (communicationIds.length === 0) return new Map();
  const rows = await prisma.botFlowOutbox.findMany({
    where: { tenantId: outboxTenantId(), communicationId: { in: communicationIds } },
    select: { communicationId: true, status: true, failureCode: true, lastError: true, attempts: true },
  });
  const states = new Map<string, MessageDeliveryState>();
  for (const row of rows) {
    if (!row.communicationId) continue;
    states.set(row.communicationId, {
      status: row.status,
      failureCode: row.failureCode,
      lastError: row.lastError,
      attempts: row.attempts,
    });
  }
  return states;
}

/**
 * What an outbox row may carry.
 *
 * A superset of the flow's `OutMsg`, and deliberately a separate type rather than
 * a widened one. A staff reply can attach a voice note, a video or a PDF —
 * `sendDirectAttachment` has always accepted all four kinds — while a flow can
 * only ever produce text, an image or a choice. Adding `attachment` to `OutMsg`
 * would oblige every flow node, simulator and validator to handle a case no flow
 * can emit, to describe a capability that belongs to the queue.
 */
export type AttachmentKind = "image" | "audio" | "video" | "file";
export type OutboxPayload = OutMsg | { type: "attachment"; kind: AttachmentKind; url: string };

const ATTACHMENT_KINDS: AttachmentKind[] = ["image", "audio", "video", "file"];

function asOutMsg(payload: unknown): OutboxPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (
    value.type === "attachment" &&
    typeof value.url === "string" &&
    ATTACHMENT_KINDS.includes(value.kind as AttachmentKind)
  ) {
    return { type: "attachment", kind: value.kind as AttachmentKind, url: value.url };
  }
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
  if (message.type === "attachment") {
    // Only Meta's DM channels have a generic attachment endpoint. Naming the
    // channel in the error matters: this is a permanent failure, so it is what
    // the operator will see under the message that did not go.
    if (row.channel !== "messenger" && row.channel !== "instagram") {
      return { ok: false, error: `Unsupported bot channel: ${row.channel} cannot send a ${message.kind} attachment` };
    }
    return sendDirectAttachment(row.channel, row.key, { type: message.kind, url: message.url });
  }
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

const ATTACHMENT_LABEL: Record<AttachmentKind, string> = {
  image: "🖼 [image]",
  audio: "🎤 [voice note]",
  video: "🎬 [video]",
  file: "📎 [file]",
};

function timelineBody(row: OutboxRow): string | null {
  const message = asOutMsg(row.payload);
  if (!message) return null;
  if (message.type === "attachment") return ATTACHMENT_LABEL[message.kind];
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
    create: { type: row.channel, direction: "outbound", subject: FLOW_MARKER, body: storedBody, contactId: row.contactId, leadId: row.leadId, userId: row.actorId, dedupeKey },
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
 *
 * `cancelled` is excluded for the same reason and more plainly: it is a message
 * somebody decided not to send. Leaving it claimable would deliver it after all;
 * leaving it in the queue as an unclaimable head would silence the conversation
 * for ever, which is the exact failure the paragraph above exists to prevent.
 */
const FINISHED_STATUSES = ["sent", "dead", "cancelled"];

async function earliestUnfinished(channel: string, key: string): Promise<OutboxRow | null> {
  return prisma.botFlowOutbox.findFirst({
    where: { tenantId: outboxTenantId(), channel, key, status: { notIn: FINISHED_STATUSES } },
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

async function blockLaterMessages(row: OutboxRow, error: string): Promise<void> {
  await prisma.botFlowOutbox.updateMany({
    where: { tenantId: outboxTenantId(), channel: row.channel, key: row.key, id: { not: row.id }, status: { in: ["pending", "retry"] } },
    data: {
      status: "dead",
      leaseUntil: null,
      lastError: `Blocked by earlier failed message ${row.id}: ${error}`.slice(0, 1000),
    },
  });
}

async function failDelivery(row: OutboxRow, error: string): Promise<"retry" | "dead"> {
  const lastError = error.slice(0, 1000);
  const failureCode = classifyDeliveryFailure(lastError);
  if (row.attempts >= MAX_ATTEMPTS || PERMANENT_FAILURES.has(failureCode)) {
    const dead = await prisma.botFlowOutbox.updateMany({
      where: { id: row.id, status: "running", attempts: row.attempts },
      data: { status: "dead", leaseUntil: null, lastError, failureCode },
    });
    if (dead.count !== 1) return "retry";
    await blockLaterMessages(row, lastError);

    // The flow state and the customer's reality have now diverged. The session
    // was committed BEFORE delivery — deliberately, so a provider timeout cannot
    // lose the message that explains the new state — which means the CRM believes
    // the customer is waiting at, say, a choice node whose prompt they never
    // received. Their next message would be interpreted against a menu that does
    // not exist for them.
    //
    // Mark the conversation instead, so the next inbound turn starts over rather
    // than answering something unseen. This never evicts a person who has taken
    // the thread over; see markBotSessionDeliveryFailedTx.
    await withTenantWrite(async (tx, tenantId) => {
      await markBotSessionDeliveryFailedTx(tx, tenantId, row.channel, row.key);
    }).catch(async (error) => {
      await logError("bot-outbox-session-repair", error, row.id).catch(() => {});
    });
    if (row.flowVersionId) {
      await recordBotFlowEvents([{ channel: row.channel, conversationKey: row.key, flowVersionId: row.flowVersionId, eventType: "delivery_failed", metadata: { outboxId: row.id, attempts: row.attempts, failureCode } }]);
    }
    await logError("bot-outbox", new Error(lastError), `${row.channel}:${row.key}:${row.id}:${failureCode}`).catch(() => {});
    return "dead";
  }
  await prisma.botFlowOutbox.updateMany({
    where: { id: row.id, status: "running", attempts: row.attempts },
    data: { status: "retry", leaseUntil: null, lastError, failureCode, availableAt: retryAt(row.attempts) },
  });
  return "retry";
}

async function deliverClaimed(row: OutboxRow): Promise<"sent" | "retry" | "dead"> {
  let result: { ok: boolean; error?: string };
  try { result = await sendProvider(row); } catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  if (!result.ok) return failDelivery(row, result.error ?? "Provider rejected chatbot message");

  const sent = await prisma.botFlowOutbox.updateMany({
    where: { id: row.id, status: "running", attempts: row.attempts },
    data: { status: "sent", sentAt: new Date(), leaseUntil: null, lastError: null, failureCode: null },
  });
  if (sent.count !== 1) {
    await logError("bot-outbox-stale-lease", new Error("Provider accepted a send after this worker's outbox lease was superseded"), row.id).catch(() => {});
    return "retry";
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
    where: { tenantId: outboxTenantId(), status: { notIn: FINISHED_STATUSES }, availableAt: { lte: new Date() } },
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
