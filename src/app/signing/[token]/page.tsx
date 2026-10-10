import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { isValidSignToken, hashSignToken } from "@/lib/signing/tokens";
import { renderRequestSigningSheets, signedFieldStamps } from "@/lib/signing/render";
import { recordView } from "@/lib/signing/events";
import { identityStatus, loadRecipientIdentity } from "@/lib/signing/identity";
import { emailHint } from "@/lib/signing/identityChannels";
import { finishedNotice } from "@/lib/signing/finishedNotice";
import { isRequestClosed } from "@/lib/signing/status";
import { automationOn } from "@/lib/automationSwitch";
import { getRegionalSettings } from "@/lib/settings";
import { formatDate, formatDateTime } from "@/lib/format";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { currentTenantScope } from "@/lib/tenantScope";
import { customerBrand } from "@/lib/loginBrand";
import { resolveSignRecipientTenantForNotice } from "@/lib/tokenTenant";
import { SignSurface } from "./SignSurface";
import { IdentityGate } from "./IdentityGate";
import { SigningShell, SigningMessage } from "./SigningShell";
import { ResendCopyButton } from "./ResendCopyButton";

export const dynamic = "force-dynamic";

export default async function SigningPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isValidSignToken(token)) notFound();
  // Derive the tenant from the bearer link before any ordinary signing read.
  //
  // The NOTICE resolver, which still answers for a link that has been revoked:
  // this page is where a customer learns what became of their document, and a
  // finished link used to end in a bare "page not found". Everything below
  // decides for itself what such a link may see — a message, never the document.
  return withTokenTenantScope(
    () => resolveSignRecipientTenantForNotice(token),
    () => renderSigningPage(token),
    () => notFound(),
  );
}

async function renderSigningPage(token: string) {
  const recipient = await prisma.signatureRecipient.findUnique({
    where: { token: hashSignToken(token) },
    include: { request: { include: { recipients: { orderBy: { order: "asc" } }, fields: true } } },
  });
  if (!recipient) notFound();
  const req = recipient.request;
  // The signing token has ALREADY established a tenant scope (withTokenTenantScope
  // above), so the brand comes from that rather than from the hostname — a signing
  // link mailed to an outside party may well be opened on the platform domain, and
  // the document they are signing belongs to one specific company.
  const brand = await customerBrand(currentTenantScope()?.tenantId ?? null);
  const sender = brand.branded ? brand.displayName : null;

  // Every terminal state closes the document surface — and FIRST, before anything
  // that could render it. Each closed status revokes the bearer link in the
  // database trigger, and a revoked link gets a message about its document, never
  // the document.
  const expiredByDate = Boolean(req.expiresAt && req.expiresAt < new Date());
  if (req.deletedAt || isRequestClosed(req.status) || recipient.tokenRevokedAt || expiredByDate) {
    const regional = await getRegionalSettings();
    const status = req.deletedAt ? "deleted" : isRequestClosed(req.status) ? req.status : expiredByDate ? "expired" : "revoked";
    const notice = finishedNotice({
      status,
      recipient: {
        status: recipient.status,
        signedOn: recipient.signedAt ? formatDateTime(recipient.signedAt, regional) : null,
        declinedOn: recipient.declinedAt ? formatDateTime(recipient.declinedAt, regional) : null,
      },
      completedOn: req.completedAt ? formatDate(req.completedAt, regional) : null,
      // The moment before the expiry: the last day the link actually worked.
      lastValidDay: req.expiresAt ? formatDate(new Date(req.expiresAt.getTime() - 1), regional) : null,
      emailHint: recipient.email ? emailHint(recipient.email) : null,
      copySent: Boolean(recipient.completedEmailSentAt),
      signedCopiesOn: status === "completed" && (await automationOn("SIGNING_SIGNED_COPIES", req.tenantId).catch(() => false)),
      sender,
    });
    return (
      <SigningMessage title={notice.title} body={notice.body} brand={brand}>
        {notice.canResendCopy && req.signedPdfRef ? <ResendCopyButton token={token} /> : null}
      </SigningMessage>
    );
  }

  // Only a live link gets this far. A revoked one has already been answered, and
  // loadRecipientIdentity refuses it as well.
  const identity = await loadRecipientIdentity(token);
  if (!identity) notFound();

  if (recipient.status === "signed") return <SigningMessage title="Already signed ✓" body="You've completed this document — thank you. A copy will be emailed to you once everyone has signed." brand={brand} />;
  if (recipient.status === "declined") {
    return <SigningMessage {...finishedNotice({ status: "declined", recipient: { status: "declined", signedOn: null, declinedOn: null }, completedOn: null, lastValidDay: null, emailHint: null, copySent: false, signedCopiesOn: false, sender })} brand={brand} />;
  }
  if (recipient.role === "viewer") return <SigningMessage title="View only" body="You've been added to view this document, no signature required." brand={brand} />;

  if (req.ordering === "sequential") {
    const waitingOn = req.recipients.find((r) => r.order < recipient.order && r.role !== "viewer" && r.status !== "signed");
    if (waitingOn) return <SigningMessage title="Not your turn yet" body={`Waiting for ${waitingOn.name} to sign first — we'll notify you when it's your turn.`} brand={brand} />;
  }

  // A document that asks for a one-time code STAYS ON THE SERVER until the code
  // has been entered. The check used to be drawn over the finished page: it hid
  // the document from the eye and left every sheet of it in the response, so the
  // link alone was enough to read what the code was there to protect. Nothing
  // below this return runs for a signer who has not been checked — the sheets
  // are never rendered, and the document is not marked as opened by them. The
  // gate asks for this page again once the code is accepted.
  const gate = identityStatus(identity);
  if (gate.required && !gate.verified) {
    return (
      <SigningShell brand={brand}>
        <IdentityGate token={token} initial={gate} />
      </SigningShell>
    );
  }

  await recordView(recipient.id, req.id, recipient.name);
  const [sheets, stamps] = await Promise.all([renderRequestSigningSheets(req), signedFieldStamps(req.id, recipient.id)]);
  const myFields = req.fields
    .filter((f) => f.recipientId === recipient.id || f.recipientId === null)
    .map((f) => ({ id: f.id, kind: f.kind, label: f.label, required: f.required, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height }));

  return (
    <SigningShell brand={brand}>
      <SignSurface token={token} title={req.title} recipientName={recipient.name} sheets={sheets} fields={myFields} stamps={stamps} senderName={brand.branded ? brand.displayName : undefined} />
    </SigningShell>
  );
}
