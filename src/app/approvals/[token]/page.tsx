import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { isValidSignToken, hashSignToken } from "@/lib/signing/tokens";
import { renderRequestDocHtml } from "@/lib/signing/render";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveApprovalStepTenant } from "@/lib/tokenTenant";
import { ApprovalSurface } from "./ApprovalSurface";
import { isRequestClosed } from "@/lib/signing/status";

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
    <Shell><div style={{ maxWidth: 460, background: "#1e293b", border: "1px solid #334155", borderRadius: 12, padding: 28, textAlign: "center" }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 14, color: "#94a3b8" }}>{body}</div>
    </div></Shell>
  );
}

export default async function ApprovalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isValidSignToken(token)) notFound();
  // Phase C no-user edge: derive the approval's tenant first, then load + render
  // inside that scope (shared resolver with the POST route). Dormant no-op when
  // off; 404 under enforcement for an unknown/untenanted token.
  return withTokenTenantScope(
    () => resolveApprovalStepTenant(token),
    () => renderApprovalPage(token),
    () => notFound(),
  );
}

async function renderApprovalPage(token: string) {
  const step = await prisma.approvalStep.findUnique({ where: { token: hashSignToken(token) }, include: { request: true } });
  if (!step) notFound();
  if (step.status === "approved") return <Msg title="Approved ✓" body="You have already approved this document. Thank you." />;
  if (step.status === "rejected") return <Msg title="Rejected" body="You have already rejected this document." />;
  // EVERY terminal state, not only voided. A completed or declined request kept
  // rendering its document to anyone still holding a pending approval link.
  if (isRequestClosed(step.request.status) || step.request.deletedAt || step.tokenRevokedAt) {
    return <Msg title="No longer active" body="This request is closed." />;
  }

  const docHtml = await renderRequestDocHtml(step.request);

  return (
    <Shell>
      <ApprovalSurface token={token} title={step.request.title} label={step.label} assignee={step.assigneeName ?? ""} docHtml={docHtml} />
    </Shell>
  );
}
