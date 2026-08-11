import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { activeTenantPredicate } from "./tenantPredicate";
import { tenantEnforcing } from "./tenantEnforcement";
import { receiptFields, type Receipt } from "./deliveryReceipts";

/**
 * Apply a delivery or read receipt to the messages it covers.
 *
 * EVERY QUERY HERE NAMES ITS TENANT, and the first version did not.
 *
 * It ran on basePrisma — the trusted client that sets `app.bypass_rls='on'` — and
 * justified skipping the tenant filter on the grounds that the webhook had already
 * entered `withChannelTenantScope`. That reasoning is wrong, and dangerously so:
 * a tenant scope constrains the SCOPED client. basePrisma is the one that ignores
 * it, which is the entire reason it exists.
 *
 * WhatsApp made it exploitable rather than theoretical. `Contact.messengerPsid`
 * and `instagramId` are unique, but a PHONE NUMBER is not — the same number can
 * legitimately be a customer of two tenants. So a receipt arriving for tenant A
 * could resolve tenant B's contact and then update tenant B's messages:
 *
 *   receipt for tenant A
 *     -> LIMIT 1 over all contacts with that number
 *     -> resolves tenant B's contact
 *     -> updateMany stamps tenant B's rows
 *
 * A cross-tenant write, from a webhook, with no authentication step in between.
 *
 * `activeTenantPredicate` is the repo's answer to exactly this, and it fails
 * CLOSED: with enforcement on and no scope it throws rather than querying
 * everything. The predicate is resolved ONCE here and threaded through the lookup
 * and both updates, so there is no path that forgets it.
 */
/**
 * THE TENANT CLAUSE FOR A RECEIPT, AND WHY IT IS NOT `activeTenantPredicate` ALONE.
 *
 * This is the one consumer that had to be taught to TOLERATE a scope it did not
 * previously have. `withChannelTenantScope` used to bind nothing while enforcement
 * was dormant, so `activeTenantPredicate` returned `{}` here and a receipt matched
 * every tenant's rows — the leak this module was written to close, still open in
 * the only mode we run in. Now that the channel scope binds, the predicate would
 * become strict equality on the endpoint's workspace.
 *
 * Strict equality is the WRONG answer while stamping is still rolling out, and
 * silently so. `Contact.tenantId` and `Communication.tenantId` are NULL on a large
 * share of production rows — the 2026-08-10 audit counted them — and those rows
 * belong to the workspace whose endpoint this receipt arrived on. Filtering them
 * out does not lose a message; it stops the ticks. Every legacy WhatsApp thread
 * would sit on "Sent" for ever, with no error and nothing in a log, which is a
 * failure nobody would connect to a tenancy change months later.
 *
 * So while DORMANT the clause is "this workspace's rows, or rows nobody has
 * claimed yet". That is strictly narrower than the `{}` it replaces — a second
 * tenant's OWNED rows stop matching, which is the leak — and strictly wider than
 * equality, so the rollout does not break the feature on its way through.
 *
 * Under ENFORCEMENT it is exactly `activeTenantPredicate`: equality, and a throw
 * when there is no scope. By then stamping is complete by definition, an unowned
 * row is a bug rather than a stage, and matching one would re-open the boundary.
 */
type ReceiptTenant = {
  /** Spread into a Prisma `where`. `OR` ANDs with the caller's own conditions. */
  where: { tenantId?: string | null; OR?: Array<{ tenantId: string | null }> };
  /** The same clause for the one lookup that has to be raw SQL. */
  sql: Prisma.Sql;
};

function receiptTenantScope(context: string): ReceiptTenant {
  const predicate = activeTenantPredicate(context);

  // No scope at all (dormant, unmapped endpoint) — unchanged: match everything,
  // exactly as this path did before the channel scope started binding.
  if (!("tenantId" in predicate)) return { where: {}, sql: Prisma.empty };
  const tenantId = predicate.tenantId ?? null;

  if (tenantEnforcing() || tenantId === null) {
    // IS NOT DISTINCT FROM, not `=`: a scope genuinely carrying null filters on
    // null, and `= NULL` matches nothing.
    return {
      where: { tenantId },
      sql: Prisma.sql`AND "tenantId" IS NOT DISTINCT FROM ${tenantId}`,
    };
  }

  return {
    where: { OR: [{ tenantId }, { tenantId: null }] },
    sql: Prisma.sql`AND ("tenantId" = ${tenantId} OR "tenantId" IS NULL)`,
  };
}

export async function applyReceipt(receipt: Receipt): Promise<number> {
  const scope = receiptTenantScope(`${receipt.channel} delivery receipt`);
  const tenant = scope.where;

  const contactId = await contactForRecipient(receipt, scope);
  if (!contactId) return 0;

  const fields = receiptFields(receipt.level, receipt.at);
  let updated = 0;

  // Bounded four ways now, and each bound matters:
  //
  //   tenant                   the row must belong to the channel's tenant
  //   occurredAt <= watermark  the watermark's whole meaning
  //   direction  = outbound    a receipt is about what the CUSTOMER did with OUR
  //                            message; stamping their own messages is nonsense
  //   field IS NULL            receipts arrive repeatedly and out of order, and
  //                            without this a later `delivered` for an older
  //                            watermark overwrites a `seen` — the bubble would
  //                            go backwards from Seen to Delivered
  const delivered = await basePrisma.communication.updateMany({
    where: {
      ...tenant,
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
    // A second statement, because each field has its own "still null" condition.
    // Combined, a `seen` would skip every row whose deliveredAt was already set —
    // which is the common case.
    const seen = await basePrisma.communication.updateMany({
      where: {
        ...tenant,
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
 * The contact a receipt is about, within the channel's own tenant.
 *
 * A receipt for somebody with no contact in this tenant is dropped rather than
 * widened — it means we have no record of that conversation here, and there is
 * nothing to stamp.
 */
async function contactForRecipient(
  receipt: Receipt,
  scope: ReceiptTenant,
): Promise<string | null> {
  const tenant = scope.where;
  if (receipt.channel === "whatsapp") {
    // Phone numbers are stored in assorted formats, so the comparison is on digits
    // only — the same normalisation the inbound path uses to match a sender. That
    // makes this the one lookup with no unique index behind it, and therefore the
    // one that MUST carry the tenant clause.
    //
    // Built by receiptTenantScope so the raw lookup and the two updateMany above
    // cannot drift apart — a contact resolved under one clause and its messages
    // stamped under another is the disagreement this whole module exists to stop.
    const scoped = scope.sql;
    const rows = await basePrisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Contact"
       WHERE regexp_replace(COALESCE("whatsapp", "phone", ''), '\\D', '', 'g') = ${receipt.recipientRef}
         AND "deletedAt" IS NULL
         ${scoped}
       ORDER BY "id"
       LIMIT 1
    `;
    // ORDER BY id so that two contacts sharing a number WITHIN one tenant resolve
    // the same way every time. That ambiguity is a data-quality question rather
    // than a boundary one; picking at random would make it a debugging one too.
    return rows[0]?.id ?? null;
  }

  const field = receipt.channel === "instagram" ? "instagramId" : "messengerPsid";
  const contact = await basePrisma.contact.findFirst({
    where: { ...tenant, [field]: receipt.recipientRef, deletedAt: null },
    select: { id: true },
  });
  return contact?.id ?? null;
}
