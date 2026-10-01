import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { withStaffConversationScope } from "./actingScope";
import { botConversationTenantId, withBotConversationWrite } from "./botTenant";
import { customerRecordTenantId } from "./customerRecordTenant";
import { runInTenantScope } from "./tenantScope";
import { type TenantWriteTx } from "./tenantWrite";
import { botStillOwnsTx, pauseBotSessionTx } from "./botSessionStore";
import { logAuditStrict } from "./audit";
import { redactForLog } from "./redactLog";
import { classifyDeliveryFailure, deliveryFailureReason, PERMANENT_FAILURES, staffReplyMatchesRow } from "./messageDelivery";
import { sendPushToAll } from "./push";
import { metaEchoDedupeKey } from "./metaEcho";
import {
  decodeParkedFailure,
  encodeParkedFailure,
  reconcileProviderFailure,
  recordProviderFailure,
  sweepParkedFailures,
  type FailureLedger,
  type ProviderFailure,
} from "./providerFailure";
import { deleteCommunicationsAndReconcile } from "./conversations";
import { attachmentUrlForDelivery } from "./outboundMedia";
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

/**
 * Joins `(tenantId, channel, key)` into one dedupe-able conversation identity for
 * the sweep below. A control character no provider id, channel name or tenant id
 * can contain, so the parts cannot run together — a `+` or a `:` would let a key
 * ending in one collide with the next conversation along.
 */
const SEPARATOR = String.fromCharCode(0);

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
  origin: string;
  attempts: number;
  status: string;
  availableAt: Date;
  leaseUntil: Date | null;
  createdAt: Date;
  communicationLoggedAt: Date | null;
  communicationId?: string | null;
  providerMessageId?: string | null;
  /** As read BEFORE the claim — carries RETRY_IN_FLIGHT for a retried failure. */
  lastError?: string | null;
};

export type BotOutboxRun = { sent: number; retried: number; dead: number; cancelled: number; repairedLogs: number };
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
 * This mirrors exactly what the write helper stamps on the way in, so the filter
 * and the writer always agree, including while enforcement is dormant.
 *
 * ── BOTH SIDES OF THE QUEUE MOVED HERE, TOGETHER ───────────────────────────────
 *
 * This one expression is the tenant for BOTH sides, which is precisely why #473
 * could not convert either of them alone:
 *
 *   - the STAFF side (`enqueueStaffReply` → its idempotency re-read at
 *     `resolveExisting`, and the transaction that writes the row), which IS
 *     user-originated — both callers are Server Actions behind `inbox.reply`;
 *   - the DRAIN side (`flushBotOutbox`, `flushBotOutboxConversation`,
 *     `claimOldest`, `earliestUnfinished`, `repairPendingCommunicationLogs`,
 *     `deliveryStateForMessages`), which is the bot-outbox cron.
 *
 * Move the staff write on its own and a second tenant's reply is written into
 * workspace B while every reader still looks in workspace A: the idempotency check
 * stops recognising its own rows (so a resubmission sends the message twice), the
 * immediate flush finds nothing, and the cron never claims it. The reply is
 * accepted, reported as sent, and never leaves.
 *
 * So they moved in one change, onto ONE expression they all share —
 * {@link ./botTenant}.`botConversationTenantId`, whose middle rung is the AMBIENT
 * scope. What makes that rung a real answer rather than nothing:
 *
 *   - at a webhook, `withChannelTenantScope` binds the workspace that owns the
 *     provider endpoint, now while enforcement is dormant as well as under it;
 *   - at the inbox, `withStaffConversationScope` binds the acting workspace;
 *   - on the cron, `flushBotOutbox`'s dormant sweep binds each conversation's OWN
 *     tenant, read off its rows, before draining it — so a workspace whose replies
 *     are not the founding tenant's is drained rather than stranded, and
 *     `sendProvider` resolves that workspace's provider credentials instead of
 *     whoever's happen to be configured globally.
 *
 * Writer and readers agreed before because they were all wrong in the same way.
 * They agree now because they ask the same question.
 */
function outboxTenantId(): string {
  return botConversationTenantId();
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

/**
 * Legacy convenience wrapper; modern flow runners use botOutboxWrite inside their state transaction.
 *
 * UNREACHABLE — nothing in `src/` or `tests/` calls this (nor its namesake in
 * botOutboxWrite.ts); every live enqueue goes through `enqueueBotMessagesTx` inside
 * the caller's own turn transaction. It moves to `withBotConversationWrite` with the
 * rest of the queue anyway: an outbox row that names a different workspace from the
 * one `outboxTenantId()` claims with is unclaimable, so leaving dead code on the old
 * helper would leave a loaded gun for whoever revives it.
 */
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
  await withBotConversationWrite(async (tx, tenantId) => {
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
export type StaffReplyInput = {
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
};

export async function enqueueStaffReply(input: StaffReplyInput): Promise<StaffReplyResult> {
  // ONE workspace for the whole decision, resolved ONCE and bound for it.
  //
  // The idempotency re-read, the queue write, the bot pause, the backlog
  // cancellation and the trail all have to name the same workspace — that is what
  // makes a duplicate key proof that the whole decision already committed. Resolving
  // the acting workspace independently at each of them would cost a session lookup
  // per statement and, worse, could disagree between them if the session changed
  // mid-request. Binding it here is also what lets the immediate flush that follows
  // claim what this just wrote.
  return withStaffConversationScope(() => enqueueStaffReplyInWorkspace(input));
}

async function enqueueStaffReplyInWorkspace(input: StaffReplyInput): Promise<StaffReplyResult> {
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

  /**
   * WHO OWNS THE HISTORY ROW — the customer record, not the queue.
   *
   * `withTenantWrite` hands down `writeTenantId() ?? DEFAULT_TENANT_ID`, and
   * enforcement is dormant in every environment today, so that value is the
   * FOUNDING tenant no matter which workspace is replying. That is the right
   * answer for the outbox row below, which only needs a stable partition key its
   * reader (`outboxTenantId()`) agrees with. It is the WRONG answer for the
   * Communication: that is a customer record carrying composite keys to Contact
   * and Lead, so it must claim their tenant or Postgres refuses the insert — and
   * stamping the founding tenant on another workspace's reply is worse than
   * leaving it null, because it looks correct to every later query and surfaces
   * in the wrong workspace once enforcement flips.
   *
   * Resolved ONCE and outside the transaction: every part of a reply points at
   * the same contact and lead, and the parent lookups are reads that do not need
   * to hold the write transaction open.
   */
  const historyTenantId = await customerRecordTenantId({
    contactId: input.contactId,
    leadId: input.leadId,
  });

  try {
    // USER-ORIGINATED, and CONVERTED — with `outboxTenantId()` and the drain, not
    // ahead of them. Both callers are Server Actions behind `inbox.reply`
    // (`enqueueStaffMessage` ← whatsapp.ts, and messenger.ts), so a signed-in person
    // is unambiguously doing this and the acting workspace is the right owner.
    //
    // The tenant this stamps has to equal the one `outboxTenantId()` read above in
    // `resolveExisting` and the one the drain claims with — so it resolves the SAME
    // expression rather than a parallel one. The whole body runs inside
    // `withStaffConversationScope`, which binds the acting workspace once (and never
    // over a scope that already exists), so all three read it off the same rung.
    const written = await withBotConversationWrite(async (tx, tenantId) => {
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
            // The customer record's tenant, NOT the queue's — see historyTenantId.
            tenantId: historyTenantId,
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
export type OutboxPayload =
  | OutMsg
  | {
      type: "attachment";
      kind: AttachmentKind;
      /**
       * The DURABLE storage reference — what `saveFile` returned, and the thing
       * that still identifies these bytes tomorrow.
       *
       * NOT a provider-fetchable URL. This carried the signed relay URL, minted
       * when the person pressed Send and valid for an hour, which quietly undid
       * the guarantee the queue exists to give: a worker outage, a paused drain,
       * a deployment or a backlog longer than that hour left the row perfectly
       * durable and its attachment already expired. A durable queue cannot store
       * an expiring credential; it stores the identity and mints the credential
       * per attempt. See `attachmentUrlForDelivery`.
       *
       * Volatile across resubmissions of the same file — see stablePayload.
       */
      ref: string;
      /** Served back on the relay, so the provider is told what it is fetching. */
      contentType?: string;
      /** What the bytes ARE. The message's identity across re-uploads. */
      digest?: string;
    };

const ATTACHMENT_KINDS: AttachmentKind[] = ["image", "audio", "video", "file"];

function asOutMsg(payload: unknown): OutboxPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (
    value.type === "attachment" &&
    typeof value.ref === "string" &&
    ATTACHMENT_KINDS.includes(value.kind as AttachmentKind)
  ) {
    return {
      type: "attachment",
      kind: value.kind as AttachmentKind,
      ref: value.ref,
      ...(typeof value.contentType === "string" ? { contentType: value.contentType } : {}),
      ...(typeof value.digest === "string" ? { digest: value.digest } : {}),
    };
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

/**
 * Remove the echo of a message we have just proved is ours.
 *
 * Meta echoes our own sends back to the webhook, and the echo can arrive before
 * this worker has committed the provider id — so the webhook, unable to tell it
 * from a colleague replying in Business Suite, records it. That is deliberate:
 * guessing from the message TEXT drops a colleague's "Thanks" whenever we happen
 * to be sending "Thanks", and a lost message is worse than a duplicate nobody
 * has had time to read.
 *
 * Committing the id is the proof. The echo row is keyed by that id, so this is
 * an exact delete of one row, not a resemblance match — and it is a no-op in the
 * ordinary case where the echo arrived after the id and was never written.
 */
async function reconcileProviderEcho(providerMessageId: string | undefined): Promise<void> {
  if (!providerMessageId) return;
  // outboxTenantId(), the same value every claim and write in this file uses, so
  // the key built here is the key the webhook built for the same message.
  const tenantId = outboxTenantId();
  // Reconciling, not deleting. The echo was written through the guarded client,
  // which rolled the conversation's counters forward; nothing intercepts a
  // delete, so a bare one leaves the projection permanently ahead of the
  // transcript — and Conversation is what the inbox reads for ordering and for
  // "who is waiting on us".
  await deleteCommunicationsAndReconcile({ dedupeKey: metaEchoDedupeKey(tenantId, providerMessageId) })
    .catch(() => {
      /* Best effort: a duplicate left on the timeline is visible and survivable,
         and must never turn a delivered message into a failed one. */
    });
}

async function sendProvider(row: OutboxRow): Promise<{ ok: boolean; error?: string; providerMessageId?: string }> {
  const message = asOutMsg(row.payload);
  if (!message) return { ok: false, error: "Invalid outbox payload" };
  if (message.type === "attachment") {
    // Only Meta's DM channels have a generic attachment endpoint. Naming the
    // channel in the error matters: this is a permanent failure, so it is what
    // the operator will see under the message that did not go.
    if (row.channel !== "messenger" && row.channel !== "instagram") {
      return { ok: false, error: `Unsupported bot channel: ${row.channel} cannot send a ${message.kind} attachment` };
    }
    // Minted HERE, for this attempt, from the durable ref — never read out of the
    // payload. That is the whole difference between a queue that survives an
    // outage and one that only appears to.
    const url = attachmentUrlForDelivery(message);
    if (!url) {
      // Classifies as `not_configured`, which is deliberately NOT permanent: an
      // operator who sets a public origin should see the backlog drain, not find
      // it dead-lettered while they were fixing it.
      return {
        ok: false,
        error: "Attachments are not configured for delivery: this deployment has no public https origin Meta could fetch from",
      };
    }
    return sendDirectAttachment(row.channel, row.key, { type: message.kind, url });
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
  // Telegram added with gap audit #29: its bot replies were sent and never shown.
  if (!row.actorId || !["whatsapp", "messenger", "instagram", "telegram"].includes(row.channel)) {
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
    create: { type: row.channel, direction: "outbound", subject: FLOW_MARKER, body: storedBody, contactId: row.contactId, leadId: row.leadId, userId: row.actorId, dedupeKey, messageId: row.providerMessageId ?? null, tenantId: await customerRecordTenantId({ contactId: row.contactId, leadId: row.leadId }) },
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
    // A retried failure keeps its marker through the claim, so a crash mid-send
    // and a reclaim still let the fence recognise it (see RETRY_IN_FLIGHT).
    data: { status: "running", attempts: { increment: 1 }, leaseUntil, lastError: isRetryInFlight(row.lastError) ? row.lastError : null },
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
/**
 * The incident's identity. Every row killed behind a failed message carries that
 * message's id in this prefix, so "this failure and what it took down" is an
 * exact match, not a guess from timestamps.
 */
const blockedByPrefix = (headId: string) => `Blocked by earlier failed message ${headId}: `;

async function killMessageAndBacklog(row: OutboxRow, lastError: string, failureCode: string): Promise<boolean> {
  const blocked = `${blockedByPrefix(row.id)}${lastError}`.slice(0, 1000);
  const tenantId = outboxTenantId();
  return prisma.$transaction(async (tx) => {
    const dead = await tx.botFlowOutbox.updateMany({
      where: { id: row.id, status: "running", attempts: row.attempts },
      data: { status: "dead", leaseUntil: null, lastError, failureCode },
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
      data: { status: "dead", leaseUntil: null, lastError: blocked, failureCode: "blocked_by_earlier_failure" },
    });
    // Repair the conversation HERE, not in a second best-effort transaction.
    // Separately, the dead-letter could commit, the process die, and the session
    // repair never happen — with no retry left to trigger it, because the message
    // is already terminal. The customer would then be back to waiting at a prompt
    // they never received, which is the exact state this repair exists to prevent.
    const parked: Array<{ id: string }> = await tx.$queryRawUnsafe(
      `UPDATE "BotSession"
          SET "ownership" = 'delivery_failed', "updatedAt" = CURRENT_TIMESTAMP
        WHERE "tenantId" = $1 AND "channel" = $2 AND "key" = $3 AND "ownership" <> 'human'
        RETURNING "id"`,
      tenantId,
      row.channel,
      row.key,
    );
    // Record WHICH failure parked it, in the same transaction, so "Send again"
    // retries exactly this one. Keyed by the session id, never the customer's
    // handle. Inferring the head from recency instead was wrong twice over: two
    // failures close together, and a late provider receipt marking an older,
    // already-sent message dead after this one.
    for (const session of parked) {
      await tx.botInboundEvent.upsert({
        where: { tenantId_channel_providerId: { tenantId, channel: `${row.channel}${PARKED_HEAD_SUFFIX}`, providerId: session.id } },
        create: {
          tenantId,
          channel: `${row.channel}${PARKED_HEAD_SUFFIX}`,
          providerId: session.id,
          status: "completed",
          attempts: 0,
          lastError: row.id,
          completedAt: new Date(),
        },
        update: { lastError: row.id },
      });
    }
    return true;
  });
}

/**
 * Ledger channel suffix for "which outbox row parked this conversation".
 * BotInboundEvent is already this file's tenant-scoped ledger (see
 * failureLedger); rows here are written `completed`, so no inbound claim and no
 * parked-failure sweep (which matches PARKED_FAILURE_SUFFIX) ever picks one up.
 */
const PARKED_HEAD_SUFFIX = ":parked-head";

type ParkedHeadDb = Pick<typeof prisma, "botInboundEvent" | "botFlowOutbox">;

/**
 * The failure that parked a conversation — by identity, not by recency.
 *
 * Read from the record killMessageAndBacklog writes. A conversation parked
 * before that record existed falls back to the newest message the WORKER killed:
 * a late provider receipt can mark an older message dead afterwards, but such a
 * message was accepted and so always carries the provider's id; a worker-killed
 * head never does.
 */
export async function parkedFailureHead(
  db: ParkedHeadDb,
  conversation: { tenantId: string | undefined; channel: string; key: string; sessionId: string },
): Promise<{ id: string; failureCode: string | null; updatedAt: Date; contactId: string | null } | null> {
  const { tenantId, channel, key, sessionId } = conversation;
  const select = { id: true, failureCode: true, updatedAt: true, contactId: true } as const;
  const record = await db.botInboundEvent.findFirst({
    where: { tenantId, channel: `${channel}${PARKED_HEAD_SUFFIX}`, providerId: sessionId },
    select: { lastError: true },
  });
  if (record) {
    if (!record.lastError) return null;
    return db.botFlowOutbox.findFirst({ where: { id: record.lastError, tenantId, channel, key, status: "dead" }, select });
  }
  return db.botFlowOutbox.findFirst({
    where: { tenantId, channel, key, status: "dead", providerMessageId: null, NOT: { failureCode: "blocked_by_earlier_failure" } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select,
  });
}

/**
 * Tell staff a message did not reach a customer — whether the worker failed it
 * or the provider reported it failed later. No number or handle in the push; the
 * inbox's Bot handoffs tab lists it.
 */
async function notifyDeliveryFailed(row: { origin: string; channel: string }, failureCode: string, tenantId?: string): Promise<void> {
  await sendPushToAll({
    title: "A message didn't reach a customer",
    body: `${row.origin === "staff" ? "A reply" : "The assistant's reply"} on ${row.channel} failed — ${deliveryFailureReason(failureCode) ?? "the channel rejected it"}. They're waiting.`.slice(0, 200),
    url: "/inbox",
  }, "bot_handoff", { tenantId }).catch(() => {});
}

async function failDelivery(row: OutboxRow, error: string): Promise<"retry" | "dead"> {
  // Classified on the provider's own text, STORED without client information:
  // a WhatsApp or Messenger error can quote the customer's number.
  const failureCode = classifyDeliveryFailure(error.slice(0, 1000));
  const lastError = redactForLog(error).slice(0, 1000);
  if (row.attempts >= MAX_ATTEMPTS || PERMANENT_FAILURES.has(failureCode)) {
    // Kills the message, the backlog behind it, and repairs the conversation —
    // all in one transaction, so none of the three can commit without the others.
    if (!(await killMessageAndBacklog(row, lastError, failureCode))) return "retry";
    if (row.flowVersionId) {
      await recordBotFlowEvents([{ channel: row.channel, conversationKey: row.key, flowVersionId: row.flowVersionId, eventType: "delivery_failed", metadata: { outboxId: row.id, attempts: row.attempts, failureCode } }]);
    }
    // The outbox id, not row.key: the conversation key IS the customer's phone
    // number on WhatsApp (and a handle elsewhere). The id leads to the row.
    await logError("bot-outbox", new Error(lastError), `${row.channel}:${row.id}:${failureCode}`).catch(() => {});
    // A person has to step in — the customer is waiting at a prompt they never
    // got, and the error log was the only place this showed (gap audit #31).
    await notifyDeliveryFailed(row, failureCode);
    return "dead";
  }
  await prisma.botFlowOutbox.updateMany({
    where: { id: row.id, status: "running", attempts: row.attempts },
    // A retried failure that fails transiently is still a retried failure.
    data: { status: "retry", failureCode, leaseUntil: null, lastError: isRetryInFlight(row.lastError) ? `${RETRY_IN_FLIGHT}: ${lastError}`.slice(0, 1000) : lastError, availableAt: retryAt(row.attempts) },
  });
  return "retry";
}

/**
 * MAY THE BOT STILL SPEAK IN THIS CONVERSATION?
 *
 * Cancelling the queue at takeover is necessary and not sufficient, and the gap
 * is not theoretical — it is the shape of the whole feature. A message that a
 * worker has already CLAIMED is `running`, and takeover deliberately does not
 * touch a running row: its lease belongs to a worker that may already be at the
 * provider, and deciding its outcome from another transaction would race that
 * worker over a message that might already have been delivered. So the row
 * survives takeover, the worker finishes, and the bot speaks over the person.
 *
 * The same hole covers anything enqueued in the window: a flow turn that began
 * before takeover and commits after it. #425 fences that at the ENQUEUE side with
 * `botStillOwnsTx`, and that is the right place for the paths it covers — but it
 * is one call site per channel runtime, and a queue that only enforces ownership
 * where somebody remembered to ask is not enforcing it.
 *
 * So ownership is checked HERE too, at the last point before the provider is
 * called, for every bot-origin row on every path. The session row is taken FOR
 * UPDATE, so a takeover cannot commit between the check and the decision.
 *
 * WHAT THIS DOES NOT CLAIM, STATED PRECISELY. The FOR UPDATE lock is held only
 * for the duration of this check's transaction, and that transaction commits
 * before the provider is called. So the race is not merely "a takeover during
 * the provider call" — it is anything that commits in the gap AFTER this check
 * commits and BEFORE the send begins, as well as during the send itself. Both
 * windows are real and neither is closed here.
 *
 * Closing them would mean holding a database transaction across an external HTTP
 * call, which trades a narrow race for a much worse failure mode: a provider
 * timeout would pin a row lock for the length of that timeout, and a crash
 * mid-send would leave it held until the connection is reaped.
 *
 * So the honest guarantee is bounded: no bot message is sent after a takeover
 * that had already committed when this check ran. The window it leaves is the
 * few milliseconds between that check and the send, against the original bug's
 * window of "for as long as the row sat in the queue" — which for a claimed row
 * was the whole lease, and for a pending one was indefinite.
 */
async function botMayStillSpeak(row: OutboxRow): Promise<boolean> {
  if (row.origin !== "bot") return true; // a person's own reply is never fenced
  // RUNTIME — `withBotConversationWrite`, the same expression that CLAIMED this row
  // in `claimOldest`/`earliestUnfinished`. That agreement is the point: the session
  // this locks FOR UPDATE has to be the session belonging to the workspace whose
  // queue produced the row, or the fence checks a stranger's ownership and lets the
  // bot speak over a person who has taken the conversation over.
  //
  // It is now a real per-workspace answer on every path into here: the cron drain
  // binds each conversation's own tenant before draining it, and the immediate flush
  // after a staff reply inherits the workspace `withStaffConversationScope` bound.
  return withBotConversationWrite(async (tx, tenantId) => {
    if (await botStillOwnsTx(tx, tenantId, row.channel, row.key)) return true;
    // Withdraw this row AND anything queued behind it, inside the same
    // transaction that observed the takeover — so the next claim cannot pick up
    // a sibling that this one just proved is superseded.
    //
    // A retried FAILURE is withdrawn back to `dead`, keeping its failure code, not
    // cancelled: it never reached the customer, and "Send again" must not make
    // that incident disappear just because a person took over before it went
    // (re-review of #733). It stays listed; no longer retryable, since the bot no
    // longer owns the thread.
    await tx.botFlowOutbox.updateMany({
      where: { id: row.id },
      data: isRetryInFlight(row.lastError)
        ? { status: "dead", leaseUntil: null, lastError: RETRY_SUPERSEDED }
        : {
            status: "cancelled",
            leaseUntil: null,
            failureCode: "superseded_by_human",
            lastError: "Cancelled: a person took over this conversation before this message was sent",
          },
    });
    await cancelPendingBotOutputTx(tx, tenantId, row.channel, row.key);
    return false;
  });
}

async function deliverClaimed(row: OutboxRow): Promise<"sent" | "retry" | "dead" | "cancelled"> {
  // Last gate before the provider. A claimed row is not licence to send: the
  // conversation may have changed hands since it was queued, or since it was
  // claimed.
  if (!(await botMayStillSpeak(row))) return "cancelled";

  let result: { ok: boolean; error?: string; providerMessageId?: string };
  try { result = await sendProvider(row); } catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  if (!result.ok) return failDelivery(row, result.error ?? "Provider rejected chatbot message");

  const sent = await prisma.botFlowOutbox.updateMany({
    where: { id: row.id, status: "running", attempts: row.attempts },
    data: { status: "sent", sentAt: new Date(), leaseUntil: null, lastError: null, failureCode: null, providerMessageId: result.providerMessageId ?? null },
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
      // The provider id goes on too. Without it this row is a message that WAS
      // delivered and cannot be recognised when its echo comes back, so the one
      // path where the lease was superseded is also the one path that duplicates
      // the customer's history.
      data: { status: "sent", sentAt: new Date(), leaseUntil: null, lastError: null, providerMessageId: result.providerMessageId ?? null },
    });
    await logError("bot-outbox-stale-lease", new Error("Provider accepted a send after this worker's outbox lease was superseded; recorded as sent so it is not delivered twice"), row.id).catch(() => {});
    // AFTER the write above, not before it: on this path the id is committed by
    // that second statement, and reconciling first would look for the echo while
    // the webhook could still legitimately be recording one.
    await reconcileProviderEcho(result.providerMessageId);
    await reconcileParkedFailure(row.channel, result.providerMessageId);
    await stampProviderMessageId(row, result.providerMessageId);
    await repairCommunicationLog({ ...row, status: "sent", providerMessageId: result.providerMessageId }).catch(() => {});
    return "sent";
  }
  await reconcileProviderEcho(result.providerMessageId);
  // AFTER the id is committed, exactly like the echo: a `failed` status that
  // arrived before this point was parked, and this is where it lands.
  await reconcileParkedFailure(row.channel, result.providerMessageId);
  await stampProviderMessageId(row, result.providerMessageId);
  await repairCommunicationLog({ ...row, status: "sent", providerMessageId: result.providerMessageId }).catch(async (error) => { await logError("bot-outbox-log", error, row.id).catch(() => {}); });
  return "sent";
}

/**
 * Put the provider's id (WhatsApp wamid) on the timeline row a staff reply
 * already has, so the message can be traced to a later async status.
 * Best effort: the send happened; a missing id must not turn it into a failure.
 */
async function stampProviderMessageId(row: OutboxRow, providerMessageId: string | undefined): Promise<void> {
  if (!providerMessageId || !row.communicationId) return;
  await prisma.communication
    .updateMany({ where: { id: row.communicationId, messageId: null }, data: { messageId: providerMessageId } })
    .catch(() => {});
}

/**
 * The Prisma side of ./providerFailure.ts, for one channel in this
 * conversation's tenant (outboxTenantId(): the endpoint's workspace at the
 * webhook, the conversation's in the worker — the same value, as for the echo).
 *
 * `markFailed` sets `dead` + the failure class, which deliveryLabel renders as
 * "Not delivered — <reason>". Exact match on the provider id; nothing later in
 * the conversation is blocked, since those messages already went.
 *
 * Parked failures reuse BotInboundEvent — the existing tenant-scoped ledger of
 * provider events, unique on (tenantId, channel, providerId), with its RLS and
 * grants already in place — under a channel of their own (`whatsapp:failed`) so
 * they can never collide with an inbound-message claim.
 */
function failureLedger(channel: string): FailureLedger {
  const tenantId = outboxTenantId();
  const parkChannel = `${channel}:failed`;
  return {
    async markFailed(failure) {
      const data = { status: "dead", failureCode: failure.failureCode, lastError: failure.detail.slice(0, 1000) };
      // The FIRST report flips sent → dead, one row at a time and conditional on
      // `sent`, so only that flip tells staff: a redelivered webhook, or two
      // racing, finds the row already dead and stays quiet (re-review of #733 —
      // an accepted message that later failed reached nobody but the timeline).
      const accepted = await prisma.botFlowOutbox.findMany({
        where: { tenantId, channel, providerMessageId: failure.providerMessageId, status: "sent" },
        select: { id: true, origin: true },
      });
      for (const row of accepted) {
        const flipped = await prisma.botFlowOutbox.updateMany({ where: { id: row.id, tenantId, status: "sent" }, data });
        if (flipped.count === 1) await notifyDeliveryFailed({ origin: row.origin, channel }, failure.failureCode, tenantId);
      }
      // `dead` too: a redelivered webhook re-marks its own row instead of
      // parking a record nothing will consume.
      const marked = await prisma.botFlowOutbox.updateMany({
        where: { tenantId, channel, providerMessageId: failure.providerMessageId, status: "dead" },
        data,
      });
      return marked.count;
    },
    async park(failure) {
      await prisma.botInboundEvent.upsert({
        where: { tenantId_channel_providerId: { tenantId, channel: parkChannel, providerId: failure.providerMessageId } },
        create: { tenantId, channel: parkChannel, providerId: failure.providerMessageId, status: "pending", attempts: 0, lastError: encodeParkedFailure(failure) },
        update: {},
      });
    },
    async parked(providerMessageId) {
      const row = await prisma.botInboundEvent.findFirst({
        where: { tenantId, channel: parkChannel, providerId: providerMessageId, status: "pending" },
        select: { lastError: true },
      });
      return row ? decodeParkedFailure(providerMessageId, row.lastError) : null;
    },
    async consume(providerMessageId) {
      await prisma.botInboundEvent.updateMany({
        where: { tenantId, channel: parkChannel, providerId: providerMessageId, status: "pending" },
        data: { status: "completed", completedAt: new Date() },
      });
    },
  };
}

/**
 * Apply a provider's ASYNC failure (WhatsApp `failed` status) to the message it
 * names — or park it until the worker commits that id. See ./providerFailure.ts.
 */
export async function applyProviderFailure(channel: string, failure: ProviderFailure): Promise<number> {
  return recordProviderFailure(failureLedger(channel), failure);
}

/**
 * Worker side: apply a failure that arrived before the id was committed. Best
 * effort like the echo reconcile — the send happened, and a bookkeeping error
 * must not turn it into a thrown delivery.
 */
async function reconcileParkedFailure(channel: string, providerMessageId: string | undefined): Promise<void> {
  if (!providerMessageId) return;
  // A reconcile that errors here leaves the failure parked; the outbox cron's
  // retryParkedFailures applies it on a later pass.
  await reconcileProviderFailure(failureLedger(channel), providerMessageId).catch(async (error) => {
    await logError("bot-outbox-failure-reconcile", error, `${channel}:${providerMessageId}`).catch(() => {});
  });
}

/**
 * Immediate best-effort drain for the conversation that just produced output.
 *
 * Wrapped in `withStaffConversationScope` because two of its callers are Server
 * Actions firing this straight after `enqueueStaffReply`: without it the reply is
 * written into the acting workspace and this flush looks for it in the founding
 * one, which is the "accepted, reported sent, never leaves" failure #473 refused to
 * ship. Every other caller — the webhook turn runners, the cron sweep below — is
 * already inside a bound scope, where this is a bare call.
 */
export async function flushBotOutboxConversation(
  channel: string,
  key: string,
  limit = 20,
  budget?: OutboxBudget,
): Promise<BotOutboxRun> {
  return withStaffConversationScope(() => drainConversation(channel, key, limit, budget));
}

export type RequeueOutcome = "requeued" | "not_parked" | "permanent" | "human_owned";

/**
 * Send a dead-lettered conversation's failed messages again (gap audit #31).
 *
 * Only while the conversation is still parked at `delivery_failed` — claimed
 * atomically, so two people pressing Retry, or Retry racing a staff reply that
 * took the conversation, resend nothing twice. Only the messages killed in THIS
 * failure come back (the head and the backlog `killMessageAndBacklog` marked in
 * the same transaction), never older dead rows from an earlier incident. And a
 * permanent failure — the customer blocked us, the 24-hour window closed — is
 * refused: resending cannot fix it, and would only fail again.
 */
export async function requeueDeadConversation(channel: string, key: string): Promise<{ outcome: RequeueOutcome; headId?: string }> {
  return withStaffConversationScope(async () => {
    const tenantId = outboxTenantId();
    return prisma.$transaction(async (tx) => {
      const session = await tx.botSession.findFirst({
        where: { tenantId, channel, key, ownership: "delivery_failed" },
        select: { id: true },
      });
      if (!session) return { outcome: "not_parked" as const };
      // The failure that parked THIS session, by its recorded identity.
      const head = await parkedFailureHead(tx, { tenantId, channel, key, sessionId: session.id });
      if (!head) return { outcome: "not_parked" as const };
      if (head.failureCode && PERMANENT_FAILURES.has(head.failureCode)) return { outcome: "permanent" as const };
      const claimed = await tx.$executeRawUnsafe(
        `UPDATE "BotSession"
            SET "ownership" = 'bot', "updatedAt" = CURRENT_TIMESTAMP
          WHERE "tenantId" = $1 AND "channel" = $2 AND "key" = $3 AND "ownership" = 'delivery_failed'`,
        tenantId,
        channel,
        key,
      );
      if (claimed !== 1) return { outcome: "not_parked" as const };
      // Exactly the failure that parked the conversation and the backlog it
      // killed, by the head's id. A time window here (it was 5 s) also swept in
      // an earlier failure's dead output when two landed close together, and
      // re-sent messages nobody chose to retry.
      await tx.botFlowOutbox.updateMany({ where: { id: head.id, tenantId, status: "dead" }, data: retryInFlight() });
      await tx.botFlowOutbox.updateMany({
        where: {
          tenantId,
          channel,
          key,
          status: "dead",
          failureCode: "blocked_by_earlier_failure",
          lastError: { startsWith: blockedByPrefix(head.id) },
        },
        data: BACKLOG_RESET(),
      });
      return { outcome: "requeued" as const, headId: head.id };
    });
  });
}

/**
 * A retried failure's marker while it is back in the queue. The worker's fence
 * (botMayStillSpeak) reads it: if a person takes the conversation over between
 * the retry and the send — the retry's own lock is long gone by then — the
 * message goes back to `dead` as RETRY_SUPERSEDED instead of vanishing as
 * `cancelled`, so the incident stays on the list (re-review of #733).
 *
 * The failure code and provider id are KEPT while it is in flight: a successful
 * send overwrites both, and a withdrawn one is still recognisably the message
 * that failed. Claiming and a transient retry both carry the marker forward.
 */
const RETRY_IN_FLIGHT = "Retrying a failed message";
/** A retried failure the fence withdrew because a person took the conversation over first. */
export const RETRY_SUPERSEDED = "Not sent again: a person took this conversation over first";
const retryInFlight = () => ({ status: "pending", attempts: 0, leaseUntil: null, lastError: RETRY_IN_FLIGHT, availableAt: new Date() });
const BACKLOG_RESET = () => ({ status: "pending", attempts: 0, leaseUntil: null, lastError: null, failureCode: null, availableAt: new Date() });
const isRetryInFlight = (lastError: string | null | undefined) => Boolean(lastError?.startsWith(RETRY_IN_FLIGHT));

/**
 * What actually became of a retried message, read AFTER the flush — so "Send
 * again" reports the send, not the requeue (re-review of #733).
 */
export async function retriedMessageOutcome(outboxId: string): Promise<"sent" | "queued" | "superseded" | "failed"> {
  return withStaffConversationScope(async () => {
    const row = await prisma.botFlowOutbox.findFirst({
      where: { id: outboxId, tenantId: outboxTenantId() },
      select: { status: true, lastError: true },
    });
    if (!row) return "failed";
    if (row.status === "sent") return "sent";
    if (row.status === "dead") return row.lastError === RETRY_SUPERSEDED ? "superseded" : "failed";
    if (row.status === "cancelled") return "superseded";
    return "queued";
  });
}

/**
 * A failed message that did NOT park its conversation (gap audit #31, re-reviews
 * of #733). Two kinds, and only these — a bot message the worker failed parks
 * the session and is retried through requeueDeadConversation instead:
 *  - a STAFF reply: it put the conversation in a person's hands ("human"), which
 *    the kill never parks — and must not, since un-parking hands it to the bot;
 *  - a message the provider ACCEPTED (it has the provider's id) and reported
 *    failed later, asynchronously — by then the conversation had moved on.
 * The inbox list and the retry both use this, so they always agree.
 */
export const UNPARKED_FAILURE = {
  status: "dead",
  NOT: { failureCode: "blocked_by_earlier_failure" },
  // …plus a retried failure the fence withdrew because a person took over first
  // (RETRY_SUPERSEDED): its conversation is no longer parked, but it still never
  // reached the customer.
  OR: [{ origin: "staff" }, { providerMessageId: { not: null } }, { lastError: RETRY_SUPERSEDED }],
} satisfies Prisma.BotFlowOutboxWhereInput;

/**
 * Send one unparked failed message again, plus exactly the backlog it blocked.
 * Works on the message, never the session, so ownership is left alone. Claimed
 * by a conditional update on the row, so two clicks resend once. A permanent
 * failure is refused — resending cannot fix it.
 */
export async function requeueFailedMessage(
  outboxId: string,
): Promise<{ outcome: RequeueOutcome; channel?: string; key?: string; headId?: string }> {
  return withStaffConversationScope(async () => {
    const tenantId = outboxTenantId();
    return prisma.$transaction(async (tx) => {
      const head = await tx.botFlowOutbox.findFirst({
        where: { id: outboxId, tenantId, ...UNPARKED_FAILURE },
        select: { id: true, channel: true, key: true, failureCode: true, origin: true },
      });
      if (!head) return { outcome: "not_parked" as const };
      if (head.failureCode && PERMANENT_FAILURES.has(head.failureCode)) return { outcome: "permanent" as const, channel: head.channel, key: head.key };
      // A BOT message may only be resent while the bot still owns the thread. Once
      // a person has taken over, the worker's fence (botMayStillSpeak) would cancel
      // it on the way out — so requeueing it "sent again" nothing and dropped it
      // from the list (re-review of #733). Asked under the same session lock the
      // fence takes, so a takeover cannot slip in between this check and the send.
      // (TenantWriteTx is typed off basePrisma; this guarded-client transaction is the same runtime client.)
      if (head.origin === "bot" && !(await botStillOwnsTx(tx as unknown as TenantWriteTx, tenantId, head.channel, head.key))) {
        return { outcome: "human_owned" as const, channel: head.channel, key: head.key };
      }
      // The lock above ends with this transaction; a takeover after it is the
      // fence's to catch, and retryInFlight() is what lets it keep the incident.
      const claimed = await tx.botFlowOutbox.updateMany({ where: { id: head.id, tenantId, status: "dead" }, data: retryInFlight() });
      if (claimed.count !== 1) return { outcome: "not_parked" as const };
      await tx.botFlowOutbox.updateMany({
        where: {
          tenantId,
          channel: head.channel,
          key: head.key,
          status: "dead",
          failureCode: "blocked_by_earlier_failure",
          lastError: { startsWith: blockedByPrefix(head.id) },
        },
        data: BACKLOG_RESET(),
      });
      return { outcome: "requeued" as const, channel: head.channel, key: head.key, headId: head.id };
    });
  });
}

async function drainConversation(
  channel: string,
  key: string,
  limit: number,
  budget?: OutboxBudget,
): Promise<BotOutboxRun> {
  const stats: BotOutboxRun = { sent: 0, retried: 0, dead: 0, cancelled: 0, repairedLogs: 0 };
  for (let i = 0; i < limit; i++) {
    if (budget?.shouldStop(4_000)) break;
    const row = await claimOldest(channel, key);
    if (!row) break;
    const outcome = await deliverClaimed(row);
    stats[outcome === "sent" ? "sent" : outcome === "retry" ? "retried" : outcome === "cancelled" ? "cancelled" : "dead"] += 1;
    // A cancelled row is not a failure and does not stop the drain: the person's
    // OWN reply is queued behind it and must still go out.
    if (outcome !== "sent" && outcome !== "cancelled") break;
  }
  return stats;
}

/**
 * Repair sent messages whose provider delivery succeeded but CRM logging did not.
 *
 * `scope` is the same predicate the due-conversation query uses: the slice's own
 * workspace under enforcement, EVERY workspace on the dormant single-sweep path.
 * Narrowing it to `outboxTenantId()` unconditionally would leave a non-founding
 * workspace's sent rows permanently unlogged while dormant, which is a message the
 * customer received and the CRM has no record of.
 */
async function repairPendingCommunicationLogs(
  limit: number,
  scope: { tenantId?: string },
  budget?: OutboxBudget,
): Promise<number> {
  const rows = await prisma.botFlowOutbox.findMany({
    where: { ...scope, status: "sent", communicationLoggedAt: null },
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

const PARKED_FAILURE_SUFFIX = ":failed";

/**
 * Retry parked provider failures (see ./providerFailure.ts) whose immediate
 * reconcile did not land. Same `scope` rule as repairPendingCommunicationLogs,
 * and each record is reconciled inside ITS OWN tenant's scope — the tenant the
 * ledger (outboxTenantId()) must match — exactly as the drain below binds each
 * conversation's tenant.
 */
async function retryParkedFailures(
  limit: number,
  scope: { tenantId?: string },
  budget?: OutboxBudget,
): Promise<number> {
  const rows = await prisma.botInboundEvent.findMany({
    where: { ...scope, channel: { endsWith: PARKED_FAILURE_SUFFIX }, status: "pending" },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, tenantId: true, channel: true, providerId: true, createdAt: true },
  });
  const parked = rows.map((row) => ({
    ...row,
    outboxChannel: row.channel.slice(0, -PARKED_FAILURE_SUFFIX.length),
    providerMessageId: row.providerId,
    parkedAt: row.createdAt,
  }));
  const run = await sweepParkedFailures(parked, {
    reconcile: (row) =>
      runInTenantScope({ tenantId: row.tenantId, system: false }, () =>
        reconcileProviderFailure(failureLedger(row.outboxChannel), row.providerMessageId),
      ),
    expire: async (row) => {
      await prisma.botInboundEvent.updateMany({
        where: { id: row.id, tenantId: row.tenantId, status: "pending" },
        data: { status: "expired", completedAt: new Date() },
      });
    },
    onError: async (row, error) => {
      await logError("bot-outbox-failure-reconcile", error, `${row.channel}:${row.providerMessageId}`).catch(() => {});
    },
    shouldStop: () => Boolean(budget?.shouldStop(4_000)),
  });
  return run.applied;
}

/**
 * Per-slice cron drain. Conversation ordering is preserved by claimOldest().
 *
 * `sliceTenantId` is what `runCronPerTenant` handed this slice, and the two shapes
 * are not interchangeable:
 *
 *   - a CONCRETE tenant (the enforcing fan-out) → drain that workspace only. The
 *     runner has already bound its scope, so `outboxTenantId()` agrees with it.
 *   - `null` (the dormant single sweep) → drain EVERY workspace, binding each
 *     conversation's OWN tenant — read off its rows — before draining it.
 *
 * The second case is the half of this change that stops it trading one bug for
 * another. The runtime now writes a webhook's replies under the workspace that owns
 * the provider endpoint, so a dormant sweep still filtering on `outboxTenantId()` —
 * the founding tenant, because that is the stand-in `runCronPerTenant` binds —
 * would leave every other workspace's queue unclaimed for ever: replies accepted,
 * retries never attempted, nothing anywhere to see. Taking the tenant from the row
 * is also what lets `sendProvider` resolve THAT workspace's provider credentials,
 * so a message can no longer go out over another tenant's WhatsApp number.
 *
 * Omitting the argument keeps the previous behaviour — the ambient workspace only —
 * so a caller that is already scoped is unaffected.
 */
export async function flushBotOutbox(
  limit = 50,
  budget?: OutboxBudget,
  sliceTenantId?: string | null,
): Promise<BotOutboxRun> {
  const stats: BotOutboxRun = { sent: 0, retried: 0, dead: 0, cancelled: 0, repairedLogs: 0 };
  if (budget?.shouldStop(4_000)) return stats;

  // `null` is the dormant sweep and means "every workspace"; `undefined` is a caller
  // that did not say, and keeps the ambient answer it had before.
  const scope = sliceTenantId === null ? {} : { tenantId: outboxTenantId() };

  stats.repairedLogs = await repairPendingCommunicationLogs(Math.min(limit, 25), scope, budget);
  if (budget?.shouldStop(4_000)) return stats;
  // Best effort, like the log repair: a sweep error must not stop the drain.
  await retryParkedFailures(Math.min(limit, 25), scope, budget).catch(async (error) => {
    await logError("bot-outbox-failure-reconcile", error, "sweep").catch(() => {});
  });
  if (budget?.shouldStop(4_000)) return stats;

  const due = await prisma.botFlowOutbox.findMany({
    where: { ...scope, status: { notIn: FINISHED_STATUSES }, availableAt: { lte: new Date() } },
    orderBy: [{ createdAt: "asc" }, { sequence: "asc" }],
    take: limit * 2,
    // `tenantId` is selected even when the sweep is already narrowed to one
    // workspace, so the per-conversation drain below binds the same way in both
    // modes rather than only on the path someone remembered to special-case.
    select: { tenantId: true, channel: true, key: true },
  });

  const conversations = [...new Set(due.map((row) => [row.tenantId, row.channel, row.key].join(SEPARATOR)))];
  let remaining = limit;
  for (const conversation of conversations) {
    if (remaining <= 0 || budget?.shouldStop(4_000)) break;
    const first = conversation.indexOf(SEPARATOR);
    const second = conversation.indexOf(SEPARATOR, first + SEPARATOR.length);
    const tenantId = conversation.slice(0, first);
    const channel = conversation.slice(first + SEPARATOR.length, second);
    // The REST of the string, not up to a third separator: a provider key is opaque
    // and nothing promises it cannot contain one, and a truncated key would drain
    // the wrong conversation rather than fail.
    const key = conversation.slice(second + SEPARATOR.length);
    // Bound per conversation, so every reader inside — the claim, the ownership
    // fence, the credential lookup — names the workspace that owns these rows.
    const run = await runInTenantScope({ tenantId, system: false }, () =>
      drainConversation(channel, key, remaining, budget),
    );
    stats.sent += run.sent;
    stats.retried += run.retried;
    stats.dead += run.dead;
    stats.cancelled += run.cancelled;
    remaining -= run.sent + run.retried + run.dead + run.cancelled;
  }
  return stats;
}
