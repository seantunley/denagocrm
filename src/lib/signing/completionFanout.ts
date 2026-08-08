import "server-only";
import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
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

/** Anything, as a short string that will not blow the ErrorLog column. */
export function describeError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/**
 * Send the sealed PDF to every recipient who has an address and has not already
 * had it, recording each success on the recipient row.
 *
 * `tenantWhere` is an EXPLICIT tenant fragment, not ambient scope: the delivery
 * marker is a write, and the db.ts guard rewrites nothing while enforcement is
 * dormant (which is every environment today).
 */
export async function deliverCompletionEmails(opts: {
  title: string;
  pdf: Buffer;
  recipients: FanoutRecipient[];
  tenantWhere: SweepTenantWhere;
}): Promise<DeliveryResult> {
  const failures: string[] = [];
  let sent = 0;
  let skipped = 0;

  for (const recipient of opts.recipients) {
    if (!recipient.email) continue; // nothing to send to — not a failure
    if (recipient.completedEmailSentAt) {
      skipped += 1;
      continue; // already has it; re-sending a signed contract is not a fix
    }

    const result = await sendEmail({
      to: recipient.email,
      subject: `Completed & signed: ${opts.title}`,
      text: `Hi ${recipient.name},\n\nEveryone has signed "${opts.title}". The final sealed PDF is attached.\n\nDenago Cape Town`,
      attachments: [{ filename: `${opts.title}.pdf`, content: opts.pdf, contentType: "application/pdf" }],
    });

    // THE FIX. sendEmail reports failure in its return value and never throws,
    // so this is the only place the difference can be seen.
    if (!result.ok) {
      failures.push(`${recipient.email}: ${result.error ?? "send failed"}`);
      continue;
    }

    sent += 1;
    try {
      await prisma.signatureRecipient.updateMany({
        where: { ...opts.tenantWhere, id: recipient.id },
        data: { completedEmailSentAt: new Date() },
      });
    } catch (err) {
      // The message WENT. Failing to record that is a bookkeeping loss, not a
      // delivery one, and counting it as a failure would withhold the completion
      // marker and mail this person their contract a second time. Log and move on.
      console.error(
        `[signing] delivered the sealed PDF to ${recipient.email} but could not record it`,
        err,
      );
    }
  }

  return { ok: failures.length === 0, sent, skipped, failures };
}
