import crypto from "crypto";
import { Prisma } from "@prisma/client";
import type { OutMsg } from "./flow";
import { withTenantWrite, type TenantWriteTx } from "./tenantWrite";

export type BotOutboxWriteInput = {
  channel: string;
  key: string;
  messages: OutMsg[];
  flowVersionId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  actorId?: string | null;
};

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

function jsonPayload(message: OutMsg): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(message)) as Prisma.InputJsonValue;
}

/** Write one engine result into an EXISTING transaction. */
export async function enqueueBotMessagesTx(
  tx: TenantWriteTx,
  tenantId: string,
  input: BotOutboxWriteInput,
): Promise<void> {
  if (!input.messages.length) return;
  const batchId = crypto.randomUUID();
  const createdAt = new Date();
  const messages = storedMessages(input.channel, input.messages);

  for (let sequence = 0; sequence < messages.length; sequence++) {
    await tx.botFlowOutbox.create({
      data: {
        tenantId,
        channel: input.channel,
        key: input.key,
        batchId,
        sequence,
        payload: jsonPayload(messages[sequence]),
        flowVersionId: input.flowVersionId ?? null,
        contactId: input.contactId ?? null,
        leadId: input.leadId ?? null,
        actorId: input.actorId ?? null,
        createdAt,
        availableAt: createdAt,
      },
    });
  }
}

export async function enqueueBotMessages(input: BotOutboxWriteInput): Promise<void> {
  await withTenantWrite(async (tx, tenantId) => enqueueBotMessagesTx(tx, tenantId, input));
}
