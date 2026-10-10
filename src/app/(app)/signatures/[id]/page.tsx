import Link from "next/link";
import { notFound } from "next/navigation";
import { hasPermission, requireAnyPermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { listTenantStaff } from "@/lib/tenantActor";
import { reassignApprovalTo, resendApprovalLink } from "@/app/actions/signhub";
import { contactName, formatDate, formatDateTime } from "@/lib/format";
import { canAccessSignatureRequest } from "@/lib/signing/access";
import { SendVoidBar, RecipientControls } from "./SigningClient";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { StatusPill } from "@/components/visual-system";
import { Download, FileCheck2, FileText } from "lucide-react";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { resendSignedCopies, retryStuckSteps } from "@/app/actions/signhub";
import { isRequestClosed, lastValidDay } from "@/lib/signing/status";
import { stuckSteps } from "@/lib/signing/stuck";
import { allSignersSigned, failureInWords, finishingStalled, stuckExplanation, stuckHeadline, stuckProgress, worstStep } from "@/lib/signing/stuckText";
import { loadEvidence } from "@/lib/signing/evidence";
import { eventInWords } from "@/lib/signing/evidenceText";

export const dynamic = "force-dynamic";
// Retry finishes a signed document from this page's action: rendering and
// sealing the PDF, then mailing it. Seconds normally, not always.
export const maxDuration = 60;

/** A time-stamp authority is recorded as the address that was asked; show who, not the URL. */
function authorityName(authority: string | null): string {
  if (!authority) return "an independent authority";
  try {
    return new URL(authority).host;
  } catch {
    return authority;
  }
}

const RSTATUS: Record<string, string> = {
  pending: "text-slate-400", sent: "text-blue-300", viewed: "text-indigo-300", signed: "text-emerald-300", declined: "text-red-300",
};

/**
 * A "sent"/"reminded" event carries the per-channel delivery result in its
 * metadata ({ ok, error }). Surface it so a failed email/WhatsApp is visible
 * instead of looking identical to a successful send.
 */
function deliveryOf(e: { type: string; channel: string | null; metadata: unknown }): { ok: boolean; error?: string } | null {
  if ((e.type !== "sent" && e.type !== "reminded") || !e.channel) return null;
  const m = e.metadata as Record<string, unknown> | null;
  if (!m || typeof m !== "object" || !("ok" in m)) return null;
  // Cap the provider error before it reaches the UI.
  const error = typeof m.error === "string" ? m.error.slice(0, 120) : undefined;
  // Strict identity — Boolean("false") is true, so historical/malformed string
  // metadata must NOT be shown as a success.
  return { ok: m.ok === true, error };
}

/** Human-readable rendering of one field response value for the ack list. */
function describeResponse(kind: string, value: string): string {
  if (kind === "checkbox") return value === "true" ? "✓ checked" : "✗ unchecked";
  if (kind === "signature" || kind === "initials" || kind === "stamp") return "signed";
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}

/** How a request asks its signers to prove who they are, in the owner's words. */
const IDENTITY_MODE: Record<string, string> = {
  link: "Link only — no code",
  otp: "One-time code, by email or SMS",
  email_otp: "One-time code, by email",
  sms_otp: "One-time code, by SMS",
};

/** What one signer actually proved — the same claims the certificate makes. */
function identityProved(r: { identityMethod: string | null; identityVerifiedAt: Date | null }, witness: string | null): string | null {
  const at = r.identityVerifiedAt ? ` · ${formatDateTime(r.identityVerifiedAt)}` : "";
  if (r.identityMethod === "email_otp") return `Verified by a code to their email${at}`;
  if (r.identityMethod === "sms_otp") return `Verified by a code to their mobile${at}`;
  if (r.identityMethod === "in_person") return `Signed in person${witness ? `, witnessed by ${witness}` : ""}${at}`;
  if (r.identityMethod === "staff_session") return "Signed while signed in to the CRM";
  return null;
}

export default async function SignatureDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAnyPermission("signing.view", "signing.manage");
  const { id } = await params;
  const req = await prisma.signatureRequest.findUnique({
    where: { id },
    include: {
      recipients: { orderBy: { order: "asc" } },
      events: { orderBy: { createdAt: "asc" } },
      fields: { include: { responses: { orderBy: { filledAt: "asc" } } } },
      approvals: { orderBy: { order: "asc" } },
    },
  });
  if (!req || req.deletedAt) notFound();
  // The same record check every action on this page already makes
  // (lib/signing/access.ts). The page itself only checked the capability, so a
  // user limited to their own quotes could open any request by id and read the
  // customer, the document and the whole audit trail.
  if (!(await canAccessSignatureRequest(user, req))) notFound();

  const card = "rounded-xl border border-border bg-card p-4 shadow-sm";
  // EVERY closed state. Declined, rejected and expired requests used to keep
  // their Resend, Void and per-signer buttons, none of which could do anything.
  const closed = isRequestClosed(req.status);

  // What this request is about, to link back to. Read separately from the
  // blocked-completion probe below so each stays readable on its own.
  const [linkedQuote, linkedJobCard, linkedContact] = await Promise.all([
    req.quoteId ? prisma.quote.findUnique({ where: { id: req.quoteId }, select: { id: true, number: true, leadId: true, deletedAt: true } }) : null,
    req.jobCardId ? prisma.jobCard.findUnique({ where: { id: req.jobCardId }, select: { id: true, number: true, deletedAt: true } }) : null,
    req.contactId ? prisma.contact.findUnique({ where: { id: req.contactId }, select: { id: true, firstName: true, lastName: true, company: true, isCompany: true, deletedAt: true } }) : null,
  ]);
  // Who watched an in-person signature, from each signer's own signed event.
  const witnessOf = new Map<string, string>();
  for (const event of req.events) {
    const name = event.type === "signed" && event.recipientId ? (event.metadata as { witness?: { name?: unknown } } | null)?.witness?.name : null;
    if (typeof name === "string" && event.recipientId) witnessOf.set(event.recipientId, name);
  }
  const rejection = req.status === "rejected" ? [...req.approvals].reverse().find((step) => step.status === "rejected") : undefined;
  // Who may send an approval again or hand it to someone else, and to whom.
  // Only asked for when there is a waiting approval to act on.
  const hasWaitingApproval = !closed && req.approvals.some((step) => step.status === "pending");
  const canReassign = hasWaitingApproval && (await hasPermission(user, "signing.manage"));
  const staff = canReassign ? await listTenantStaff() : [];

  // ── Gap audit #32: the two states that used to look fine and weren't ──
  // 1. Everyone signed, but the quote/job card changed after sending, so the
  //    request can never complete. Same test completion applies (complete.ts):
  //    the quote is gone or superseded, or the job card is gone.
  const allSigned = allSignersSigned(req.recipients);
  let blockedReason: string | null = null;
  if (allSigned && !isRequestClosed(req.status)) {
    if (req.quoteId) {
      const quote = await prisma.quote.findUnique({ where: { id: req.quoteId }, select: { deletedAt: true, supersededAt: true } });
      if (!quote || quote.deletedAt) blockedReason = "its quote was deleted after it was sent";
      else if (quote.supersededAt) blockedReason = "its quote was replaced by a newer revision after it was sent";
    } else if (req.jobCardId) {
      const jobCard = await prisma.jobCard.findUnique({ where: { id: req.jobCardId }, select: { deletedAt: true } });
      if (!jobCard || jobCard.deletedAt) blockedReason = "its job card was deleted after it was sent";
    }
  }
  // 2. Completed, but the signed copy never reached some recipients.
  const missingCopy = req.status === "completed" ? req.recipients.filter((r) => r.email && !r.completedEmailSentAt) : [];
  // 3. The one nothing reported: a step that runs after somebody acts failed —
  //    or the worker running it was cut off — and the request went on reading
  //    "2/2 signed". A blocked completion (1) is its own message, with its own fix.
  const failedStep = closed || blockedReason ? null : worstStep(await stuckSteps([req.id]));
  const stalled = !blockedReason && finishingStalled({ status: req.status, closed, recipients: req.recipients, approvals: req.approvals }, new Date());
  const stuck = failedStep || stalled ? { jobType: failedStep?.jobType ?? "advance_signature", step: failedStep } : null;
  const canManage = await hasPermission(user, "signing.manage");
  // What proves a completed document is the one that was signed.
  const evidence = req.status === "completed" ? await loadEvidence(req) : null;

  // Shared fields (recipientId null, fillable by anyone) keep only the FIRST
  // value on SignatureField — the one the sealed PDF stamps. Every signer's own
  // answer lives in SignatureFieldResponse. Surface this as an AUDIT view: list
  // every non-viewer recipient under each shared field, showing "Not answered"
  // where no response exists, so a MISSING acknowledgement is visible rather than
  // invisible (only rendering rows that exist would hide who never answered).
  const signers = req.recipients.filter((r) => r.role !== "viewer");
  const sharedFields = req.fields
    .filter((f) => f.recipientId === null)
    .map((f) => {
      const byRecipient = new Map(f.responses.map((r) => [r.recipientId, r]));
      return {
        id: f.id,
        label: f.label || f.kind,
        kind: f.kind,
        required: f.required,
        answered: signers.filter((s) => byRecipient.has(s.id)).length,
        rows: signers.map((s) => ({ id: s.id, name: s.name, color: s.color, response: byRecipient.get(s.id) ?? null })),
      };
    });

  return (
    <EntityDetailShell
      backHref="/signatures"
      backLabel="Signatures"
      eyebrow="Signing request"
      title={req.title}
      status={<StatusPill tone={req.status === "completed" ? "success" : ["declined", "voided", "rejected"].includes(req.status) ? "danger" : req.status === "expired" ? "warning" : req.status === "draft" ? "neutral" : "info"}>{req.status === "draft" ? "not sent" : req.status.replace("_", " ")}</StatusPill>}
      description={`${req.ordering === "sequential" ? "Sequential" : "Parallel"} signing workflow`}
      facts={[
        { label: "Signers", value: req.recipients.filter((recipient) => recipient.role !== "viewer").length },
        { label: "Completed", value: req.recipients.filter((recipient) => recipient.status === "signed").length },
        { label: "Signer check", value: IDENTITY_MODE[req.identityMode] ?? req.identityMode },
        { label: req.status === "expired" ? "Link expired after" : "Link works until", value: req.expiresAt ? formatDate(lastValidDay(req.expiresAt)) : "No expiry" },
      ]}
      actions={<SendVoidBar requestId={req.id} status={req.status} closed={closed} />}
    >
      {/* What this is a signature ON. The page used to be a dead end: no way to
          the quote, the job card or the customer it belonged to. */}
      {(linkedQuote || linkedJobCard || linkedContact) && (
        <div className={`${card} flex flex-wrap items-center gap-2 text-sm`}>
          <span className="text-xs text-muted-foreground">For</span>
          {linkedQuote && !linkedQuote.deletedAt && <Link className="btn-secondary btn-sm" href={`/quotes/${linkedQuote.id}`}>Quote Q-{linkedQuote.number}</Link>}
          {linkedQuote?.deletedAt && <span className="text-xs text-muted-foreground">Quote Q-{linkedQuote.number} (deleted)</span>}
          {linkedJobCard && !linkedJobCard.deletedAt && <Link className="btn-secondary btn-sm" href={`/jobcards/${linkedJobCard.id}`}>Job card #{linkedJobCard.number}</Link>}
          {linkedContact && !linkedContact.deletedAt && <Link className="btn-secondary btn-sm" href={`/contacts/${linkedContact.id}`}>{contactName(linkedContact)}</Link>}
          {linkedQuote?.leadId && <Link className="btn-secondary btn-sm" href={`/leads/${linkedQuote.leadId}`}>Lead</Link>}
        </div>
      )}
      {rejection && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm">
          <p className="font-semibold text-red-200">Not approved{rejection.label ? ` at “${rejection.label}”` : ""}</p>
          <p className="mt-1 text-muted-foreground">
            {rejection.decidedByName ?? "The approver"} rejected it{rejection.decidedAt ? ` on ${formatDateTime(rejection.decidedAt)}` : ""}, so it was never sent on.
            {rejection.reason?.trim() ? ` Their reason: “${rejection.reason.trim()}”` : " They gave no reason."}
            {" "}Start it again from the quote once it has been changed.
          </p>
        </div>
      )}
      {blockedReason && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="font-semibold text-amber-200">Everyone signed, but this can&apos;t complete</p>
          <p className="mt-1 text-muted-foreground">
            It stays open because {blockedReason}, so there is nothing current to attach the signatures to. Void this request and send the current version for signing.
          </p>
        </div>
      )}
      {stuck && (
        <div className="flex flex-wrap items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm">
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-red-200">{stuckHeadline(stuck.jobType, allSigned)}</p>
            <p className="mt-1 text-muted-foreground">
              {stuckExplanation(stuck.jobType, allSigned)}
              {stuck.step ? ` ${stuckProgress(stuck.step, formatDateTime(stuck.step.availableAt))}` : ""}
            </p>
            {stuck.step?.lastError && (
              <p className="mt-1 text-[11px] text-muted-foreground/80">
                What went wrong: {failureInWords(stuck.step.lastError)} The technical detail is in Settings → System log.
              </p>
            )}
          </div>
          {canManage && (
            <SaveForm action={retryStuckSteps.bind(null, req.id)}>
              <SaveButton className="btn-primary btn-sm" pendingLabel="Retrying…">Retry now</SaveButton>
            </SaveForm>
          )}
        </div>
      )}
      {missingCopy.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm">
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-red-200">Completed — but the signed copy didn&apos;t reach everyone</p>
            <p className="mt-1 text-muted-foreground">Not delivered to: {missingCopy.map((r) => r.name).join(", ")}.</p>
          </div>
          <SaveForm action={resendSignedCopies.bind(null, req.id)}>
            <SaveButton className="btn-primary btn-sm" pendingLabel="Sending…">Send signed copy again</SaveButton>
          </SaveForm>
        </div>
      )}

      <div className={card}>
        <div className="flex flex-wrap gap-2">
          {req.documentId && <a className="btn-secondary btn-sm" href={`/api/files/${req.documentId}`} target="_blank" rel="noreferrer"><FileText className="size-4" />Unsigned PDF</a>}
          {req.signedDocId && <a className="btn-primary btn-sm" href={`/api/files/${req.signedDocId}`} target="_blank" rel="noreferrer"><FileCheck2 className="size-4" />Signed PDF</a>}
          {req.signedPdfHash && <span className="self-center text-[10px] text-muted-foreground">sha256 {req.signedPdfHash.slice(0, 16)}…</span>}
        </div>
      </div>

      {/* What proves this is the document that was signed. All of it was already
          recorded — the seal, an independent time-stamp, a chained audit trail and
          a check of the stored file after sealing — and none of it was shown. */}
      {evidence && (
        <div className={card}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-foreground">Evidence</p>
            <a className="btn-secondary btn-sm" href={`/api/signatures/${req.id}/evidence`}><Download className="size-4" />Download evidence pack</a>
          </div>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Sealed</dt>
              <dd className="text-foreground">
                {formatDateTime(evidence.sealedAt)}
                {evidence.certificate && (
                  <span className="block text-[11px] text-muted-foreground">
                    with “{evidence.certificate.name}”{evidence.certificate.trusted ? "" : " — not a publicly issued certificate"}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Unchanged since sealing</dt>
              <dd className={evidence.check && !evidence.check.valid ? "font-semibold text-red-300" : "text-foreground"}>
                {!evidence.check
                  ? "Not checked yet"
                  : evidence.check.valid
                    ? "Yes"
                    : "The last check FAILED"}
                <span className="block text-[11px] font-normal text-muted-foreground">
                  {!evidence.check
                    ? "The stored file is checked automatically after sealing, within the hour."
                    : evidence.check.valid
                      ? `File, seal and audit trail last verified ${formatDateTime(evidence.check.at)}`
                      : `${formatDateTime(evidence.check.at)} — ${evidence.check.errors.join("; ").slice(0, 240)}`}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Independent time-stamp</dt>
              <dd className={evidence.timestamp && !evidence.timestamp.verified ? "font-semibold text-red-300" : "text-foreground"}>
                {evidence.timestamp
                  ? `${formatDateTime(evidence.timestamp.at)}${evidence.timestamp.verified ? "" : " — could not be verified"}`
                  : "None"}
                <span className="block text-[11px] font-normal text-muted-foreground">
                  {evidence.timestamp
                    ? `From ${authorityName(evidence.timestamp.authority)}, over this exact file`
                    : "The time-stamp service did not answer when this was sealed. The seal and audit trail are unaffected."}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Audit trail</dt>
              <dd className={evidence.check?.chainVerified === false ? "font-semibold text-red-300" : "text-foreground"}>
                {req.events.length} entries
                {evidence.check?.chainVerified === true ? ", unbroken" : evidence.check?.chainVerified === false ? " — the chain is BROKEN" : ""}
                <span className="block text-[11px] font-normal text-muted-foreground">Each entry is locked to the one before it, so none can be changed or removed unnoticed.</span>
              </dd>
            </div>
            {evidence.sha256 && (
              <div className="sm:col-span-2">
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Fingerprint of the signed PDF (SHA-256)</dt>
                <dd className="break-all font-mono text-[11px] text-foreground">{evidence.sha256}</dd>
              </div>
            )}
          </dl>
          <p className="mt-3 text-[11px] text-muted-foreground">
            The evidence pack is one file to hand to an attorney or the customer: the signed PDF, the full audit trail, the time-stamp, and a page
            explaining how to check each of them without this system.
            {evidence.retainUntil ? ` This record is kept until ${formatDate(evidence.retainUntil)}.` : ""}
          </p>
        </div>
      )}

      {/* A workflow's approval gates. They hold the document back from the
          customer and have no recipient row, so nothing on this page showed that
          one existed, who had it or what they decided. */}
      {req.approvals.length > 0 && (
        <div className={card}>
          <p className="mb-3 text-sm font-semibold text-foreground">Approvals</p>
          <ul className="space-y-2">
            {req.approvals.map((step) => (
              <li key={step.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border/60 p-3">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-foreground">{step.label}</span>
                  <span className="ml-2 text-[11px] text-muted-foreground">{step.assigneeName ?? step.assigneeRole ?? (step.assigneeType === "owner" ? "Owner" : "A member of the team")}</span>
                  {step.reason?.trim() && <div className="mt-1 text-[11px] text-muted-foreground">“{step.reason.trim()}”</div>}
                </div>
                <span className={`text-xs font-semibold ${step.status === "approved" ? "text-emerald-300" : step.status === "rejected" ? "text-red-300" : "text-amber-300"}`}>
                  {step.status === "pending" ? "waiting" : step.status}
                  {step.decidedAt ? ` · ${formatDateTime(step.decidedAt)}` : ""}
                </span>
                {/* A waiting approval used to be a dead end for everyone but the
                    approver: the email went once, and nobody could send it again
                    or give the decision to someone who was actually in. */}
                {step.status === "pending" && canReassign && (
                  <div className="flex w-full flex-wrap items-center gap-2 border-t border-border/40 pt-2">
                    <SaveForm action={resendApprovalLink.bind(null, step.id)}>
                      <SaveButton className="btn-secondary btn-sm" pendingLabel="Sending…">Send again</SaveButton>
                    </SaveForm>
                    <SaveForm action={reassignApprovalTo.bind(null, step.id)} className="flex flex-wrap items-center gap-2">
                      <select name="userId" required defaultValue="" aria-label={`Reassign ${step.label} to`} className="rounded-md border border-input bg-card px-2 py-1.5 text-xs text-foreground">
                        <option value="" disabled>Reassign to…</option>
                        {staff.filter((person) => person.id !== step.assigneeUserId).map((person) => (
                          <option key={person.id} value={person.id}>{person.name}</option>
                        ))}
                      </select>
                      <SaveButton className="btn-secondary btn-sm" pendingLabel="Reassigning…">Reassign</SaveButton>
                    </SaveForm>
                    <span className="text-[11px] text-muted-foreground">Reassigning replaces the link already sent.</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={card}>
        <p className="mb-3 text-sm font-semibold text-foreground">Recipients</p>
        <ul className="space-y-3">
          {req.recipients.map((r) => (
            <li key={r.id} className="rounded-lg border border-border/60 p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.color }} />
                  <span className="text-sm font-medium text-foreground">{r.name}</span>
                  <span className="text-[10px] uppercase text-muted-foreground">{r.role}</span>
                </div>
                <span className={`text-xs font-semibold ${RSTATUS[r.status] ?? "text-slate-400"}`}>{r.status}</span>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {r.signedAt
                  ? `Signed ${formatDateTime(r.signedAt)}${r.signerIp ? ` · IP ${r.signerIp}` : ""}`
                  : r.declinedAt
                    ? `Declined ${formatDateTime(r.declinedAt)}`
                    : r.viewedAt ? `Viewed ${formatDateTime(r.viewedAt)}` : "Not yet opened"}
              </div>
              {/* The reason was recorded and shown on the quote, but not here —
                  on the one page about this request. */}
              {r.status === "declined" && (
                <div className="mt-1 text-[11px] text-red-300">
                  {r.declineReason?.trim() ? `Their reason: “${r.declineReason.trim()}”` : "They gave no reason."}
                </div>
              )}
              {identityProved(r, witnessOf.get(r.id) ?? null) && (
                <div className="mt-1 text-[11px] text-muted-foreground">{identityProved(r, witnessOf.get(r.id) ?? null)}</div>
              )}
              {r.role !== "viewer" && r.status !== "signed" && !closed && (
                <RecipientControls recipientId={r.id} requestId={req.id} email={r.email ?? ""} phone={r.phone ?? ""} inPersonHref={`/signatures/${req.id}/sign/${r.id}`} />
              )}
            </li>
          ))}
        </ul>
      </div>

      {sharedFields.length > 0 && (
        <div className={card}>
          <p className="mb-1 text-sm font-semibold text-foreground">Shared field acknowledgements</p>
          <p className="mb-3 text-[11px] text-muted-foreground">Fields any signer can complete. Every signer is listed so a missing acknowledgement is visible (the sealed PDF stamps the first answer).</p>
          <ul className="space-y-3">
            {sharedFields.map((f) => (
              <li key={f.id} className="rounded-lg border border-border/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">
                    {f.label}
                    {!f.required && <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">(optional)</span>}
                  </span>
                  {f.required ? (
                    <span className={`text-[10px] font-semibold ${f.answered === f.rows.length ? "text-emerald-300" : "text-amber-300"}`}>
                      {f.answered}/{f.rows.length} answered
                    </span>
                  ) : (
                    <span className="text-[10px] font-semibold text-muted-foreground">{f.answered}/{f.rows.length} responded</span>
                  )}
                </div>
                <ul className="mt-2 space-y-1">
                  {f.rows.map((row) => (
                    <li key={row.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: row.color }} />
                      <span className="font-medium text-foreground">{row.name}</span>
                      {row.response ? (
                        <>
                          <span>· {describeResponse(f.kind, row.response.value)}</span>
                          <span className="text-muted-foreground/70">· {formatDateTime(row.response.filledAt)}</span>
                        </>
                      ) : f.required ? (
                        <span className="text-amber-300/90">· Not answered</span>
                      ) : (
                        <span className="text-muted-foreground/70">· No response</span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={card}>
        <p className="mb-3 text-sm font-semibold text-foreground">Audit trail</p>
        <ol className="space-y-2">
          {req.events.map((e) => {
            const delivery = deliveryOf(e);
            const failed = delivery ? !delivery.ok : false;
            return (
              <li key={e.id} className="flex items-start gap-3 text-[12px]">
                <span className={`mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full ${failed ? "bg-red-400" : "bg-primary/70"}`} />
                <div className="min-w-0">
                  <span className="font-medium text-foreground">{eventInWords(e.type)}</span>
                  <span className="text-muted-foreground"> · {e.actor}{e.channel ? ` · ${e.channel}` : ""}{e.ip ? ` · ${e.ip}` : ""}</span>
                  {delivery && (
                    delivery.ok ? (
                      <span className="ml-1.5 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300" title="Accepted by the provider — not a confirmed delivery">✓ sent</span>
                    ) : (
                      <span className="ml-1.5 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">
                        ✕ failed{delivery.error ? ` — ${delivery.error}` : ""}
                      </span>
                    )
                  )}
                  <div className="text-[10px] text-muted-foreground/70">{formatDateTime(e.createdAt)}</div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </EntityDetailShell>
  );
}
