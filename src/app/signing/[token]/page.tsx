import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { isValidSignToken } from "@/lib/signing/tokens";
import { renderRequestSigningSheets, signedFieldStamps } from "@/lib/signing/render";
import { recordView } from "@/lib/signing/events";
import { SignSurface } from "./SignSurface";

export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "#0f172a", color: "#e2e8f0", display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 16px", fontFamily: "Helvetica, Arial, sans-serif" }}>
      <div style={{ marginBottom: 20, fontWeight: 800, letterSpacing: 1, color: "#fff" }}>DENAGO <span style={{ color: "#ea580c" }}>CAPE TOWN</span></div>
      {children}
    </div>
  );
}
function Msg({ title, body }: { title: string; body: string }) {
  return (
    <Shell>
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

  const recipient = await prisma.signatureRecipient.findUnique({
    where: { token },
    include: { request: { include: { recipients: { orderBy: { order: "asc" } }, fields: true } } },
  });
  if (!recipient) notFound();
  const req = recipient.request;

  if (req.deletedAt || req.status === "voided") return <Msg title="Document unavailable" body="This signing link is no longer active. Please contact Denago Cape Town." />;
  if (req.expiresAt && req.expiresAt < new Date()) return <Msg title="Link expired" body="This signing link has expired. Please ask Denago to resend it." />;
  if (recipient.status === "signed") return <Msg title="Already signed ✓" body="You've completed this document — thank you. A copy will be emailed to you once everyone has signed." />;
  if (recipient.status === "declined") return <Msg title="Declined" body="You declined to sign this document. Contact Denago if this was a mistake." />;
  if (recipient.role === "viewer") return <Msg title="View only" body="You've been added to view this document, no signature required." />;

  if (req.ordering === "sequential") {
    const waitingOn = req.recipients.find((r) => r.order < recipient.order && r.role !== "viewer" && r.status !== "signed");
    if (waitingOn) return <Msg title="Not your turn yet" body={`Waiting for ${waitingOn.name} to sign first — we'll notify you when it's your turn.`} />;
  }

  await recordView(recipient.id, req.id, recipient.name);
  const [sheets, stamps] = await Promise.all([renderRequestSigningSheets(req), signedFieldStamps(req.id, recipient.id)]);
  const myFields = req.fields
    .filter((f) => f.recipientId === recipient.id || f.recipientId === null)
    .map((f) => ({ id: f.id, kind: f.kind, label: f.label, required: f.required, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height }));

  return (
    <Shell>
      <SignSurface token={token} title={req.title} recipientName={recipient.name} sheets={sheets} fields={myFields} stamps={stamps} />
    </Shell>
  );
}
