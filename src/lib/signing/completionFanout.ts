import "server-only";
import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { signingRecord } from "@/lib/outboundMessageLog";
import { isWhatsAppConfigured, sendWhatsAppDocument, waDigits } from "@/lib/whatsapp";
import { sendPushToAll } from "@/lib/push";
import { currentTenantScope } from "@/lib/tenantScope";
import { signingEmailContent, signingWhatsAppText } from "./signingEmail";
import type { SweepTenantWhere } from "./recoveryScope";

/**
 * Emailing every recipient their sealed PDF — the one step of completion that
 * the customer actually experiences — shared by the live completion path and by
 * the recovery sweep so the two cannot drift.
 *
 * ── WHY THIS EXISTS AS ITS OWN THING ───────────────────────────────────────
 *
 * Both callers used to write the loop themselves, and both wrote the same bug:
 *
 *     await sendEmail({ ... });
 *
 * `sendEmail` DOES NOT THROW. It returns `{ ok, error }` and returns `{ ok:
 * false }` for the two failures that actually happen — SMTP not configured, and
 * the transport rejecting the message (src/lib/email.ts). Awaiting it and
 * discarding the result means a fan-out where nobody received anything is
 * indistinguishable from one where everybody did. The caller then wrote the
 * `completed` marker, which is the flag that says "this request has been
 * notified, never sweep it again" — permanently suppressing the recovery while
 * the customer still has no contract. Silent, and worse than the original
 * failure because the original at least left a trace to find.
 *
 * ── PER RECIPIENT, NOT PER FAN-OUT ─────────────────────────────────────────
 *
 * Delivery is recorded one address at a time, on the recipient row. The
 * alternative — a single "the fan-out finished" flag — forces a choice between
 * writing off whoever was not reached and re-sending to everyone who was. One
 * unroutable address on a three-signer document should cost one retry to one
 * address, not three more copies of a signed contract.
 */

/** Marker that the whole fan-out finished. Its ABSENCE is what the sweep detects. */
export const COMPLETED_EVENT = "completed";

/**
 * Marker that `runPostCompletion` finished cleanly (referral, automations,
 * audit, push). Separate from `completed` so that a retry caused by ONE
 * undelivered email does not re-fire the automations and write a second audit
 * line for a sale that was already booked.
 */
export const POST_COMPLETION_EVENT = "post_completion";

/** One recorded pass of the recovery sweep. Written before the work, so the cap holds across crashes. */
export const RECOVERY_ATTEMPT_EVENT = "recovery_attempt";

export type FanoutRecipient = {
  id: string;
  name: string;
  email: string | null;
  completedEmailSentAt: Date | null;
};

export type DeliveryResult = {
  /** True only when every recipient with an address now has the document. */
  ok: boolean;
  /** Sent on this pass. */
  sent: number;
  /** Already had it — a marker from an earlier pass. */
  skipped: number;
  /** One entry per address we could not reach, safe to log. */
  failures: string[];
};

/** What an automatic completion "sent" when the owner has switched signed copies off. */
export const SIGNED_COPIES_OFF: DeliveryResult = { ok: true, sent: 0, skipped: 0, failures: [] };

/** Anything, as a short string that will not blow the ErrorLog column. */
export function describeError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/**
 * Send the sealed PDF to every recipient who has an address and has not already
 * had it, recording each success on the recipient row. A recipient with no
 * address and a mobile number is sent it on WhatsApp instead, best-effort (the
 * name predates that; `completedEmailSentAt` likewise means "has their copy").
 *
 * `tenantWhere` is an EXPLICIT tenant fragment, not ambient scope: the delivery
 * marker is a write, and the db.ts guard rewrites nothing while enforcement is
 * dormant (which is every environment today).
 */
export async function deliverCompletionEmails(opts: {
  /** The request: whose template and brand the email uses (signingEmail.ts), and which customer's timeline each copy is recorded on. */
  requestId: string;
  title: string;
  pdf: Buffer;
  recipients: FanoutRecipient[];
  tenantWhere: SweepTenantWhere;
}): Promise<DeliveryResult> {
  const failures: string[] = [];
  let sent = 0;
  let skipped = 0;

  const recordDelivery = async (recipientId: string) => {
    try {
      await prisma.signatureRecipient.updateMany({
        where: { ...opts.tenantWhere, id: recipientId },
        data: { completedEmailSentAt: new Date() },
      });
    } catch (err) {
      // The message WENT. Failing to record that is a bookkeeping loss, not a
      // delivery one, and counting it as a failure would withhold the completion
      // marker and send this person their contract a second time. Log and move on.
      console.error(`[signing] delivered the sealed PDF to recipient ${recipientId} but could not record it`, err);
    }
  };

  // Mobile numbers for whoever has no address, looked up here so that none of
  // the callers has to remember to pass one.
  const unaddressed = opts.recipients.filter((r) => !r.email && !r.completedEmailSentAt).map((r) => r.id);
  const phones = new Map<string, string>();
  if (unaddressed.length > 0) {
    const rows = await prisma.signatureRecipient
      .findMany({ where: { ...opts.tenantWhere, id: { in: unaddressed }, phone: { not: null } }, select: { id: true, phone: true } })
      .catch(() => []);
    for (const row of rows) if (row.phone?.trim()) phones.set(row.id, row.phone.trim());
  }

  for (const recipient of opts.recipients) {
    if (!recipient.email) {
      // No address. Someone who signed a contract and was sent nothing is the
      // case this branch exists for: try the number on file, on WhatsApp.
      //
      // BEST-EFFORT, and deliberately not a `failure`. WhatsApp only delivers a
      // document within 24 hours of the customer's last message to the business,
      // so "not delivered" is an ordinary outcome here, not a fault to retry —
      // and a failure would hold back the completion marker and re-drive the
      // whole fan-out every half hour for a message that cannot arrive. A
      // refusal is written to the customer's record and pushed to staff
      // (copyByWhatsApp), who have to get the copy to them another way.
      //
      // ponytail: the Signatures hub's "copy didn't reach everyone" check and its
      // resend button still look only at signers with an email address. Widen
      // them to a mobile-only signer once this has run against real traffic.
      const phone = phones.get(recipient.id);
      if (phone && !recipient.completedEmailSentAt && (await copyByWhatsApp(opts, recipient, phone))) {
        sent += 1;
        await recordDelivery(recipient.id);
      }
      continue;
    }
    if (recipient.completedEmailSentAt) {
      skipped += 1;
      continue; // already has it; re-sending a signed contract is not a fix
    }

    const email = await signingEmailContent("completed", {
      requestId: opts.requestId, title: opts.title, recipientName: recipient.name,
    });
    const result = await sendEmail({
      to: recipient.email,
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments: [{ filename: `${opts.title}.pdf`, content: opts.pdf, contentType: "application/pdf" }],
      record: await signingRecord(opts.requestId, { email: recipient.email, label: "Signed document copy" }),
    });

    // THE FIX. sendEmail reports failure in its return value and never throws,
    // so this is the only place the difference can be seen.
    if (!result.ok) {
      // Recipient id, not address: these strings end up in ErrorLog.
      failures.push(`recipient ${recipient.id}: ${result.error ?? "send failed"}`);
      continue;
    }

    sent += 1;
    await recordDelivery(recipient.id);
  }

  return { ok: failures.length === 0, sent, skipped, failures };
}

/**
 * The sealed PDF as a WhatsApp document, with the workspace's own wording under
 * it ("Signing — signed copy (WhatsApp)", edited in Document Studio). True only
 * when WhatsApp accepted it; never throws.
 */
async function copyByWhatsApp(
  opts: { requestId: string; title: string; pdf: Buffer },
  recipient: FanoutRecipient,
  phone: string,
): Promise<boolean> {
  try {
    if (!(await isWhatsAppConfigured())) return false;
    const caption = await signingWhatsAppText("completed_whatsapp", {
      requestId: opts.requestId, title: opts.title, recipientName: recipient.name,
    });
    const result = await sendWhatsAppDocument(
      waDigits(phone),
      { content: opts.pdf, filename: `${opts.title}.pdf` },
      caption,
      await signingRecord(opts.requestId, { label: "Signed document copy" }),
    );
    // Said out loud, because nothing else will: this signer has no email address,
    // so there is no second channel to fall back on, and a refusal that only
    // sits on their record is one nobody goes looking for. Inside the workspace
    // the send ran in, or not at all — a push with no workspace named goes to
    // everyone on the platform.
    const tenantId = currentTenantScope()?.tenantId;
    if (!result.ok && tenantId) {
      await sendPushToAll(
        {
          title: "A signed copy could not be delivered",
          body: `${recipient.name} has no email address and WhatsApp did not accept their copy of “${opts.title}”. Please get it to them another way.`.slice(0, 200),
          url: `/signatures/${opts.requestId}`,
        },
        "quote_signed",
        { tenantId },
      ).catch(() => 0);
    }
    return result.ok;
  } catch (err) {
    // Recipient id, not number: this reaches the server log.
    console.error(`[signing] could not send the sealed PDF to recipient ${recipient.id} on WhatsApp`, err);
    return false;
  }
}
