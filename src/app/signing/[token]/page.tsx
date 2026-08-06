import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { isValidSignToken, hashSignToken } from "@/lib/signing/tokens";
import { renderRequestSigningSheets, signedFieldStamps } from "@/lib/signing/render";
import { recordView } from "@/lib/signing/events";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";
import { findRecipientIdentity, identitySatisfied, maskedDestination, requiredOtpMethods } from "@/lib/signing/identity";
import { isRequestClosed } from "@/lib/signing/status";
import { SignSurface } from "./SignSurface";
import { IdentityGate } from "./IdentityGate";
import { PasskeyIdentityGate } from "./PasskeyIdentityGate";
import { Toaster } from "@/components/ui/sonner";

export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "#0f172a", color: "#e2e8f0", display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 16px", fontFamily: "Helvetica, Arial, sans-serif" }}>
      <div style={{ marginBottom: 20, fontWeight: 800, letterSpacing: 1, color: "#fff" }}>DENAGO <span style={{ color: "#ea580c" }}>CAPE TOWN</span></div>
      {children}<Toaster />
    </div>
  );
}
function Msg({ title, body, evidenceUrl, actionLabel = "Download portable evidence bundle" }: { title: string; body: string; evidenceUrl?: string; actionLabel?: string }) {
  return <Shell><div style={{ maxWidth: 500, background: "#1e293b", border: "1px solid #334155", borderRadius: 12, padding: 28, textAlign: "center" }}>
    <div style={{ fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 8 }}>{title}</div>
    <div style={{ fontSize: 14, color: "#94a3b8", lineHeight: 1.6 }}>{body}</div>
    {evidenceUrl ? <a href={evidenceUrl} style={{ display: "inline-block", marginTop: 18, background: "#ea580c", color: "#fff", textDecoration: "none", padding: "10px 16px", borderRadius: 8, fontWeight: 700 }}>{actionLabel}</a> : null}
  </div></Shell>;
}

export default async function SigningPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isValidSignToken(token)) notFound();
  return withTokenTenantScope(
    () => resolveSignRecipientTenant(token),
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
  if (req.deletedAt || ["voided", "declined", "expired", "rejected", "failed_manual_intervention"].includes(req.status)) {
    return <Msg title="Document unavailable" body="This signing link is no longer active. Please contact Denago Cape Town." />;
  }
  if (req.expiresAt && req.expiresAt < new Date()) return <Msg title="Link expired" body="This signing link has expired. Please ask Denago to issue a new one." />;
  const identity = await findRecipientIdentity(token);
  if (!identity) notFound();
  const policy = identity.policy;
  const identityVerified = await identitySatisfied(recipient.id, req.id, policy);
  const gate = () => {
    if (policy === "ES3_PASSKEY") return <Shell><PasskeyIdentityGate token={token} /></Shell>;
    if (policy === "ES2_AUTHENTICATED_PORTAL") {
      const next = `/signing/${token}`;
      return <Msg title="Sign in to verify your identity" body="This document is bound to your authenticated Denago account. Sign in with the matching email address, then return to continue." evidenceUrl={`/login?next=${encodeURIComponent(next)}`} actionLabel="Sign in" />;
    }
    const required = requiredOtpMethods(policy);
    if (!required.length) {
      return <Msg title="Higher-assurance identity required" body={`This document requires ${policy}. Open it through the configured authenticated portal, passkey or accredited signing ceremony.`} />;
    }
    return <Shell><IdentityGate token={token} required={required} masked={{ email: maskedDestination(identity.email), sms: maskedDestination(identity.phone) }} /></Shell>;
  };

  if (recipient.status === "signed") {
    if (["sealed", "distributing", "completed"].includes(req.status) && !identityVerified) return gate();
    return <Msg title="Already signed ✓" body={req.status === "completed" ? "The document is complete and its sealed evidence package is ready." : ["sealed", "distributing"].includes(req.status) ? "Your signature is recorded. The sealed artifact is being verified and distributed." : "Your signature is recorded. You will receive the sealed final copy after all parties complete."} evidenceUrl={req.status === "completed" ? `/api/signing/${token}/evidence` : undefined} />;
  }
  if (recipient.status === "declined") return <Msg title="Declined" body="You declined this document. Contact Denago if this was a mistake." />;
  if (recipient.role === "viewer") return <Msg title="View only" body="You were added as a viewer; no signature is required." />;
  if (isRequestClosed(req.status)) return <Msg title="No longer active" body="This request has reached a final state." />;
  if (!identityVerified) return gate();

  if (req.ordering === "sequential") {
    const waitingOn = req.recipients.find((row) => row.order < recipient.order && row.role !== "viewer" && row.status !== "signed");
    if (waitingOn) return <Msg title="Not your turn yet" body={`Waiting for ${waitingOn.name} to sign first. You will be notified when the workflow reaches you.`} />;
  }

  await recordView(recipient.id, req.id, recipient.name);
  const [sheets, stamps] = await Promise.all([renderRequestSigningSheets(req), signedFieldStamps(req.id, recipient.id)]);
  const fields = req.fields.filter((field) => field.recipientId === recipient.id || field.recipientId === null).map((field) => ({
    id: field.id, kind: field.kind, label: field.label, required: field.required,
    page: field.page, x: field.x, y: field.y, width: field.width, height: field.height,
  }));
  return <Shell><SignSurface token={token} title={req.title} recipientName={recipient.name} sheets={sheets} fields={fields} stamps={stamps} /></Shell>;
}
