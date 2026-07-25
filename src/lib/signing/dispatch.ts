import "server-only";
import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { sendWhatsAppText, waDigits, isWhatsAppConfigured } from "@/lib/whatsapp";
import { logSignEvent } from "./events";
import { CLOSED_REQUEST_STATUSES, isRequestClosed } from "./status";

const BASE = process.env.SIGN_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za";

export function signUrl(token: string): string {
  return `${BASE}/signing/${token}`;
}

function emailHtml(name: string, title: string, url: string, verb: string): string {
  return `<div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1e293b">
    <div style="font-weight:800;letter-spacing:1px">DENAGO <span style="color:#ea580c">CAPE TOWN</span></div>
    <h2 style="font-size:18px;margin:18px 0 6px">${verb}</h2>
    <p>Hi ${escapeText(name)},</p>
    <p>Please review and sign <strong>${escapeText(title)}</strong>.</p>
    <p style="margin:22px 0"><a href="${url}" style="background:#ea580c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700">Open &amp; sign</a></p>
    <p style="font-size:12px;color:#64748b">Or paste this link into your browser:<br>${url}</p>
    <p style="font-size:12px;color:#94a3b8;margin-top:20px">Denago Cape Town — Authorised Denago EV Dealer</p>
  </div>`;
}
function escapeText(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/** Outcome of a notify attempt: whether the recipient had a usable channel, and
 *  whether at least one channel actually accepted the message. */
export interface NotifyOutcome {
  reachable: boolean; // had at least one usable channel (email, or phone + WhatsApp configured)
  delivered: boolean; // at least one channel accepted the send
}

/**
 * Notify one recipient (email + WhatsApp best-effort). Returns the delivery
 * outcome. A recipient with NO usable channel is NOT marked "sent" — leaving them
 * "pending" so a workflow isn't falsely advanced and the caller can surface that
 * they have no contact details (rather than silently claiming a send that could
 * never happen).
 */
export async function notifyRecipient(recipientId: string, opts?: { reminder?: boolean }): Promise<NotifyOutcome> {
  const r = await prisma.signatureRecipient.findUnique({ where: { id: recipientId }, include: { request: true } });
  if (!r || r.role === "viewer") return { reachable: false, delivered: false };
  // Never notify for a CLOSED request, or a recipient who already
  // signed/declined — the request can close (void/decline/expire/reject/
  // complete) between dispatch's claim and this external email/WhatsApp send.
  if (isRequestClosed(r.request.status)) return { reachable: false, delivered: false };
  if (r.status === "signed" || r.status === "declined") return { reachable: false, delivered: false };

  const hasEmail = !!r.email;
  const hasWhatsApp = !!r.phone && (await isWhatsAppConfigured());
  // No usable channel → no attempt is possible. Do NOT claim pending→sent: a
  // recipient we can't reach must stay pending, not look "sent" with nothing out.
  if (!hasEmail && !hasWhatsApp) return { reachable: false, delivered: false };

  // AT-MOST-ONCE first send: atomically claim pending→sending BEFORE sending, so
  // two concurrent callers (e.g. two workflow advances) can't both read "pending"
  // and both send the same signing link. count !== 1 → someone else already
  // claimed it, so do nothing. A reminder deliberately re-sends an already-"sent"
  // recipient, so it skips the claim. "sending" (not "sent") until we know a
  // provider actually accepted the message — see the finalize step below.
  if (!opts?.reminder) {
    const claimed = await prisma.signatureRecipient.updateMany({ where: { id: r.id, status: "pending" }, data: { status: "sending", sendingAt: new Date() } });
    if (claimed.count !== 1) return { reachable: true, delivered: false };
  }

  const url = signUrl(r.token);
  const verb = opts?.reminder ? "Reminder — please sign" : "Please sign your document";
  const evType = opts?.reminder ? "reminded" : "sent";
  let delivered = false;

  if (hasEmail) {
    const res = await sendEmail({
      to: r.email!, subject: `${verb}: ${r.request.title}`,
      text: `Hi ${r.name},\n\n${verb}: "${r.request.title}" from Denago Cape Town.\n\nOpen and sign here:\n${url}\n\nThank you,\nDenago Cape Town`,
      html: emailHtml(r.name, r.request.title, url, verb),
    });
    if (res.ok) delivered = true;
    await logSignEvent(r.requestId, { type: evType, recipientId: r.id, actor: "system", channel: "email", metadata: { ok: res.ok, error: res.error } });
  }
  // WhatsApp works inside the 24h customer-service window (or requires an approved
  // template for cold outreach — see @/lib/whatsapp). Best-effort; failures are logged.
  if (hasWhatsApp) {
    const res = await sendWhatsAppText(waDigits(r.phone!), `${verb}: "${r.request.title}"\nSign here: ${url}`);
    if (res.ok) delivered = true;
    await logSignEvent(r.requestId, { type: evType, recipientId: r.id, actor: "system", channel: "whatsapp", metadata: { ok: res.ok, error: res.error } });
  }

  if (opts?.reminder) {
    // Stamp remindedAt only when a provider actually accepted the re-send —
    // otherwise the "last reminded" timestamp claims a nudge that never went
    // out (and would suppress the next genuine reminder attempt).
    if (delivered) {
      await prisma.signatureRecipient.update({ where: { id: r.id }, data: { remindedAt: new Date() } });
    }
  } else {
    // Finalize the "sending" claim: only "sent" once a provider actually accepted
    // it. Total failure returns to "pending" so the normal at-most-once claim
    // above will pick it up again on the next send/retry attempt instead of
    // looking permanently (and falsely) sent with nothing delivered. CONDITIONAL
    // on status still being "sending" — a concurrent decline/withdrawal could
    // have moved this recipient off "sending" during the email/WhatsApp calls
    // above, and an unconditional update would stomp that newer state back to
    // "sent"/"pending". count !== 1 → someone else already resolved it; leave it.
    await prisma.signatureRecipient.updateMany({ where: { id: r.id, status: "sending" }, data: { status: delivered ? "sent" : "pending", sendingAt: null } });
  }
  return { reachable: true, delivered };
}

/**
 * Send the request: mark sent, and notify the right recipients for the ordering.
 * Pass `reminder: true` for a RE-send (resendRecordSigning) — recipients are
 * already "sent", so notifyRecipient's at-most-once pending→sent claim would
 * otherwise skip them; a reminder deliberately re-notifies them.
 */
export interface DispatchResult {
  /** Recipients targeted for this (re)send (1 for sequential, all unsigned for parallel). */
  targeted: number;
  /** Targets where at least one channel actually accepted the send. TRUTHFUL — not
   *  the target count; a target whose email/WhatsApp all failed is not counted. */
  notified: number;
  /** Targets with no usable contact channel — left "pending", nothing sent. */
  unreachable: number;
}

export async function dispatchRequest(requestId: string, opts?: { reminder?: boolean }): Promise<DispatchResult> {
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId }, include: { recipients: { orderBy: { order: "asc" } } } });
  if (!req) return { targeted: 0, notified: 0, unreachable: 0 };

  if (opts?.reminder) {
    // A reminder targets a request that's already genuinely "sent" (a real first
    // send already succeeded) — nothing to claim/finalize at the request level,
    // just guard against a request that closed since the caller last checked.
    if (isRequestClosed(req.status)) return { targeted: 0, notified: 0, unreachable: 0 };
  } else {
    // CONDITIONALLY claim the send: only move a still-open, not-yet-sent request
    // to the transient "sending" state. A read-check + unconditional update was a
    // TOCTOU — a concurrent void/decline could close the request between the two,
    // and the unconditional update would force it back to "sent", resurrecting a
    // dead signing link. count !== 1 → it just closed or another caller already
    // claimed it; do nothing. "sending" (not "sent") until we know at least one
    // recipient was actually notified — see the finalize step below.
    const claimed = await prisma.signatureRequest.updateMany({
      where: { id: requestId, status: { notIn: [...CLOSED_REQUEST_STATUSES, "sent", "viewed", "in_progress"] } },
      data: { status: "sending" },
    });
    if (claimed.count !== 1) return { targeted: 0, notified: 0, unreachable: 0 };
  }

  const signers = req.recipients.filter((r) => r.role !== "viewer" && r.status !== "signed");
  const targets = req.ordering === "sequential" ? signers.slice(0, 1) : signers;
  let notified = 0;
  let unreachable = 0;
  for (const r of targets) {
    const outcome = await notifyRecipient(r.id, { reminder: opts?.reminder });
    if (!outcome.reachable) unreachable += 1;
    else if (outcome.delivered) notified += 1;
  }
  // NOTE: viewers are intentionally NOT notified here. notifyRecipient() returns
  // early for viewers (they never sign), so the previous per-viewer loop was dead
  // code. If viewer "for your records" copies are wanted, add a dedicated path.

  if (!opts?.reminder) {
    // Finalize the "sending" claim: only "sent" once at least one target was
    // actually notified. Zero notified (all unreachable or all provider attempts
    // failed) reverts to the pre-dispatch status ("draft" — the claim above only
    // ever moves a request FROM draft) so a normal resend isn't silently blocked
    // by a request that looks "sent" with nothing delivered. CONDITIONAL on status
    // still being "sending" — the recipient notify loop above makes external
    // network calls, during which a concurrent void/decline/expire/reject/complete
    // can close the request. An unconditional update here would stomp that newer
    // closed state back to "sent" (or back to "draft"), resurrecting a dead
    // request. count !== 1 → it closed (or another caller finalized it) during
    // the loop; leave the newer state alone.
    await prisma.signatureRequest.updateMany({
      where: { id: requestId, status: "sending" },
      data: notified > 0 ? { status: "sent", sentAt: req.sentAt ?? new Date() } : { status: "draft" },
    });
  }
  return { targeted: targets.length, notified, unreachable };
}

const STALE_SENDING_MINUTES = 10; // generous margin over any realistic email/WhatsApp provider round-trip

/**
 * Recover requests/recipients stuck in the transient "sending" claim — e.g. a
 * server crash or timeout between the claim and the finalize update above.
 * `updatedAt` doubles as the claim lease timestamp: nothing else touches a row
 * while it's "sending" except the finalize step, so "sending" + stale
 * `updatedAt` means finalize never ran. Only rows STILL "sending" qualify —
 * one that closed via a concurrent void/decline/expire during the window
 * already moved off "sending" (that's what the conditional finalize updates
 * above guarantee), so this never resurrects or overwrites a closed request.
 * Run from the tenant cron alongside the other operational queues.
 */
export async function recoverStaleSigningClaims(): Promise<{ requests: number; recipients: number }> {
  const staleBefore = new Date(Date.now() - STALE_SENDING_MINUTES * 60_000);

  const staleRequests = await prisma.signatureRequest.findMany({
    where: { status: "sending", updatedAt: { lt: staleBefore } },
    select: { id: true },
  });
  let requests = 0;
  for (const r of staleRequests) {
    // Claim always moves a request FROM "draft" (see dispatchRequest's claim
    // query above), so "draft" is the only safe, correct state to revert to.
    const reverted = await prisma.signatureRequest.updateMany({ where: { id: r.id, status: "sending" }, data: { status: "draft" } });
    if (reverted.count === 1) {
      requests += 1;
      await logSignEvent(r.id, { type: "stale_claim_recovered", actor: "system", metadata: { scope: "request" } });
    }
  }

  const staleRecipients = await prisma.signatureRecipient.findMany({
    where: { status: "sending", sendingAt: { lt: staleBefore } },
    select: { id: true, requestId: true },
  });
  let recipients = 0;
  for (const r of staleRecipients) {
    // Claim always moves a recipient FROM "pending" (see notifyRecipient's
    // claim above), so "pending" is the only safe, correct state to revert to.
    const reverted = await prisma.signatureRecipient.updateMany({ where: { id: r.id, status: "sending" }, data: { status: "pending" } });
    if (reverted.count === 1) {
      recipients += 1;
      await logSignEvent(r.requestId, { type: "stale_claim_recovered", recipientId: r.id, actor: "system", metadata: { scope: "recipient" } });
    }
  }

  return { requests, recipients };
}

/** After someone signs (sequential): notify the next unsigned signer, if any. */
export async function notifyNextInSequence(requestId: string): Promise<void> {
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId }, include: { recipients: { orderBy: { order: "asc" } } } });
  if (!req || req.ordering !== "sequential") return;
  const next = req.recipients.find((r) => r.role !== "viewer" && r.status !== "signed");
  // First reach of a pending signer → normal (at-most-once) send. Otherwise it's a
  // re-nudge of an already-"sent"-but-unopened signer → reminder, so the
  // at-most-once claim doesn't skip it.
  if (next && next.status !== "sent" && next.status !== "viewed") await notifyRecipient(next.id);
  else if (next && !next.viewedAt) await notifyRecipient(next.id, { reminder: true });
}
