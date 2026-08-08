import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { isValidSignToken, hashSignToken } from "@/lib/signing/tokens";
import { renderRequestSigningSheets, signedFieldStamps } from "@/lib/signing/render";
import { recordView } from "@/lib/signing/events";
import { identityStatus, loadRecipientIdentity } from "@/lib/signing/identity";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { currentTenantScope } from "@/lib/tenantScope";
import { customerBrand, type LoginBrand } from "@/lib/loginBrand";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";
import { SignSurface } from "./SignSurface";
import { IdentityGate } from "./IdentityGate";
import { Toaster } from "@/components/ui/sonner";

export const dynamic = "force-dynamic";

function Shell({ children, brand }: { children: React.ReactNode; brand?: LoginBrand }) {
  return (
    <div style={{ minHeight: "100vh", background: "#0f172a", color: "#e2e8f0", display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 16px", fontFamily: "Helvetica, Arial, sans-serif" }}>
      {brand?.style && <style>{brand.style}</style>}
      {brand?.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={brand.logoUrl} alt={brand.displayName} style={{ marginBottom: 20, height: 32, width: "auto" }} />
      ) : brand?.branded ? (
        <div style={{ marginBottom: 20, fontWeight: 800, letterSpacing: 1, color: "#fff" }}>{brand.displayName}</div>
      ) : (
        <div style={{ marginBottom: 20, fontWeight: 800, letterSpacing: 1, color: "#fff" }}>DENAGO <span style={{ color: "#ea580c" }}>CAPE TOWN</span></div>
      )}
      {children}
      {/* Signing has no layout of its own, so the Toaster is mounted on this
          shell. Feedback matters most here: the signer is an outside party with
          no other way to tell whether their signature was recorded. */}
      <Toaster />
    </div>
  );
}
function Msg({ title, body, brand }: { title: string; body: string; brand?: LoginBrand }) {
  return (
    <Shell brand={brand}>
      <div style={{ maxWidth: 460, background: "#1e293b", border: "1px solid #334155", borderRadius: 12, padding: 28, textAlign: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 14, color: "#94a3b8" }}>{body}</div>
      </div>
    </Shell>
  );
}

export default async function SigningPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isValidSignToken(token)) notFound();
  // Derive the tenant from the bearer link before any ordinary signing read.
  return withTokenTenantScope(
    () => resolveSignRecipientTenant(token),
    () => renderSigningPage(token),
    () => notFound(),
  );
}

async function renderSigningPage(token: string) {
  const [recipient, identity] = await Promise.all([
    prisma.signatureRecipient.findUnique({
      where: { token: hashSignToken(token) },
      include: { request: { include: { recipients: { orderBy: { order: "asc" } }, fields: true } } },
    }),
    loadRecipientIdentity(token),
  ]);
  if (!recipient || !identity) notFound();
  const req = recipient.request;
  // The signing token has ALREADY established a tenant scope (withTokenTenantScope
  // above), so the brand comes from that rather than from the hostname — a signing
  // link mailed to an outside party may well be opened on the platform domain, and
  // the document they are signing belongs to one specific company.
  const brand = await customerBrand(currentTenantScope()?.tenantId ?? null);

  // Every terminal state closes the document surface. Completed parties receive
  // the sealed PDF by email; the bearer link is revoked by the database trigger.
  //
  // Each message keeps its ORIGINAL literal on the unbranded branch, so a
  // workspace without branding reads exactly as it did before — the branded
  // branch is an addition, never a rewrite of the default.
  if (req.deletedAt || ["completed", "declined", "expired", "voided", "rejected"].includes(req.status)) {
    return <Msg title="Document unavailable" body={brand.branded ? `This signing link is no longer active. Please contact ${brand.displayName}.` : "This signing link is no longer active. Please contact Denago Cape Town."} brand={brand} />;
  }
  if (req.expiresAt && req.expiresAt < new Date()) return <Msg title="Link expired" body={brand.branded ? `This signing link has expired. Please ask ${brand.displayName} to resend it.` : "This signing link has expired. Please ask Denago to resend it."} brand={brand} />;
  if (recipient.status === "signed") return <Msg title="Already signed ✓" body="You've completed this document — thank you. A copy will be emailed to you once everyone has signed." brand={brand} />;
  if (recipient.status === "declined") return <Msg title="Declined" body={brand.branded ? `You declined to sign this document. Contact ${brand.displayName} if this was a mistake.` : "You declined to sign this document. Contact Denago if this was a mistake."} brand={brand} />;
  if (recipient.role === "viewer") return <Msg title="View only" body="You've been added to view this document, no signature required." brand={brand} />;

  if (req.ordering === "sequential") {
    const waitingOn = req.recipients.find((r) => r.order < recipient.order && r.role !== "viewer" && r.status !== "signed");
    if (waitingOn) return <Msg title="Not your turn yet" body={`Waiting for ${waitingOn.name} to sign first — we'll notify you when it's your turn.`} brand={brand} />;
  }

  await recordView(recipient.id, req.id, recipient.name);
  const [sheets, stamps] = await Promise.all([renderRequestSigningSheets(req), signedFieldStamps(req.id, recipient.id)]);
  const myFields = req.fields
    .filter((f) => f.recipientId === recipient.id || f.recipientId === null)
    .map((f) => ({ id: f.id, kind: f.kind, label: f.label, required: f.required, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height }));

  return (
    <Shell brand={brand}>
      <IdentityGate token={token} initial={identityStatus(identity)}>
        <SignSurface token={token} title={req.title} recipientName={recipient.name} sheets={sheets} fields={myFields} stamps={stamps} senderName={brand.branded ? brand.displayName : undefined} />
      </IdentityGate>
    </Shell>
  );
}
