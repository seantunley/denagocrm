import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { SendVoidBar, RecipientControls } from "./SigningClient";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { StatusPill } from "@/components/visual-system";
import { FileCheck2, FileText } from "lucide-react";

export const dynamic = "force-dynamic";

const RSTATUS: Record<string, string> = {
  pending: "text-slate-400", sent: "text-blue-300", viewed: "text-indigo-300", signed: "text-emerald-300", declined: "text-red-300",
};

export default async function SignatureDetail({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const req = await prisma.signatureRequest.findUnique({
    where: { id },
    include: { recipients: { orderBy: { order: "asc" } }, events: { orderBy: { createdAt: "asc" } }, fields: true },
  });
  if (!req || req.deletedAt) notFound();

  const card = "rounded-xl border border-border bg-card p-4 shadow-sm";
  const closed = req.status === "completed" || req.status === "voided";

  return (
    <EntityDetailShell
      backHref="/signatures"
      backLabel="Signatures"
      eyebrow="Signing request"
      title={req.title}
      status={<StatusPill tone={req.status === "completed" ? "success" : req.status === "declined" || req.status === "voided" ? "danger" : req.status === "draft" ? "neutral" : "info"}>{req.status.replace("_", " ")}</StatusPill>}
      description={`${req.ordering === "sequential" ? "Sequential" : "Parallel"} signing workflow`}
      facts={[
        { label: "Signers", value: req.recipients.filter((recipient) => recipient.role !== "viewer").length },
        { label: "Fields", value: req.fields.length },
        { label: "Completed", value: req.recipients.filter((recipient) => recipient.status === "signed").length },
        { label: "Mode", value: req.ordering },
      ]}
      actions={<SendVoidBar requestId={req.id} status={req.status} />}
    >

      <div className={card}>
        <div className="flex flex-wrap gap-2">
          {req.documentId && <a className="btn-secondary btn-sm" href={`/api/files/${req.documentId}`} target="_blank" rel="noreferrer"><FileText className="size-4" />Unsigned PDF</a>}
          {req.signedDocId && <a className="btn-primary btn-sm" href={`/api/files/${req.signedDocId}`} target="_blank" rel="noreferrer"><FileCheck2 className="size-4" />Signed PDF</a>}
          {req.signedPdfHash && <span className="self-center text-[10px] text-muted-foreground">sha256 {req.signedPdfHash.slice(0, 16)}…</span>}
        </div>
      </div>

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
                {r.signedAt ? `Signed ${formatDateTime(r.signedAt)}${r.signerIp ? ` · IP ${r.signerIp}` : ""}` : r.viewedAt ? `Viewed ${formatDateTime(r.viewedAt)}` : "Not yet opened"}
              </div>
              {r.role !== "viewer" && r.status !== "signed" && !closed && (
                <RecipientControls recipientId={r.id} requestId={req.id} email={r.email ?? ""} phone={r.phone ?? ""} inPersonHref={`/signatures/${req.id}/sign/${r.id}`} />
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className={card}>
        <p className="mb-3 text-sm font-semibold text-foreground">Audit trail</p>
        <ol className="space-y-2">
          {req.events.map((e) => (
            <li key={e.id} className="flex items-start gap-3 text-[12px]">
              <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary/70" />
              <div>
                <span className="font-medium text-foreground">{e.type.replace("_", " ")}</span>
                <span className="text-muted-foreground"> · {e.actor}{e.channel ? ` · ${e.channel}` : ""}{e.ip ? ` · ${e.ip}` : ""}</span>
                <div className="text-[10px] text-muted-foreground/70">{formatDateTime(e.createdAt)}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </EntityDetailShell>
  );
}
