import "server-only";
import { basePrisma } from "./db";
import { receiptFields, type Receipt } from "./deliveryReceipts";

/**
 * Apply a delivery or read receipt to the messages it covers.
 *
 * basePrisma, deliberately: this runs from a webhook, inside the channel's tenant
 * scope established by the caller, and the rows it updates were written by the
 * same webhook path. Going through the scoped client would filter on a tenant
 * that is not yet stamped and update nothing.
 *
 * The update is a single statement, bounded three ways, and each bound matters:
 *
 *   occurredAt <= watermark   the watermark's whole meaning
 *   direction  = outbound     a receipt is about what the CUSTOMER did with OUR
 *                             message; stamping their own messages is nonsense
 *   field IS NULL             receipts arrive repeatedly and out of order. Without
 *                             this, a later `delivered` for an older watermark
 *                             would overwrite a `seen` and the bubble would go
 *                             backwards from Seen to Delivered.
 */
export async function applyReceipt(receipt: Receipt): Promise<number> {
  const contactId = await contactForRecipient(receipt);
  if (!contactId) return 0;

  const fields = receiptFields(receipt.level, receipt.at);
  let updated = 0;

  // Two statements rather than one, because each field has its own "still null"
  // condition. Doing them together would let a `seen` skip rows whose deliveredAt
  // was already set, which is precisely the common case.
  const delivered = await basePrisma.communication.updateMany({
    where: {
      contactId,
      type: receipt.channel,
      direction: "outbound",
      occurredAt: { lte: receipt.at },
      deliveredAt: null,
    },
    data: { deliveredAt: fields.deliveredAt },
  });
  updated += delivered.count;

  if (fields.seenAt) {
    const seen = await basePrisma.communication.updateMany({
      where: {
        contactId,
        type: receipt.channel,
        direction: "outbound",
        occurredAt: { lte: receipt.at },
        seenAt: null,
      },
      data: { seenAt: fields.seenAt },
    });
    updated += seen.count;
  }
  return updated;
}

/**
 * The contact a receipt is about.
 *
 * A receipt for somebody with no contact row is dropped rather than guessed at —
 * it means we have no record of that conversation, and there is nothing to stamp.
 */
async function contactForRecipient(receipt: Receipt): Promise<string | null> {
  if (receipt.channel === "whatsapp") {
    // Phone numbers are stored in assorted formats; compare on digits only, which
    // is the same normalisation the inbound path uses to match a sender.
    const digits = receipt.recipientRef;
    const rows = await basePrisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Contact"
       WHERE regexp_replace(COALESCE("whatsapp", "phone", ''), '\\D', '', 'g') = ${digits}
         AND "deletedAt" IS NULL
       LIMIT 1
    `;
    return rows[0]?.id ?? null;
  }
  const field = receipt.channel === "instagram" ? "instagramId" : "messengerPsid";
  const contact = await basePrisma.contact.findFirst({
    where: { [field]: receipt.recipientRef, deletedAt: null },
    select: { id: true },
  });
  return contact?.id ?? null;
}
