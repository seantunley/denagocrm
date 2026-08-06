import Link from "next/link";
import { Prisma } from "@prisma/client";
import { requireAnyPermission } from "@/lib/permissions";
import { prisma, basePrisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { ApprovalActions } from "./ApprovalActions";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileSignature,
  FileText,
  LockKeyhole,
  Send,
  ShieldCheck,
  Timer,
  Workflow,
} from "lucide-react";
import RecordContextMenu from "@/components/RecordContextMenu";
import { WorkspaceHero } from "@/components/workspace-hero";
import { EmptyState, SectionHeading, StatusPill, Surface } from "@/components/visual-system";

export const dynamic = "force-dynamic";

const RECIPIENT_STATUS: Record<string, { dot: string; label: string }> = {
  signed: { dot: "bg-emerald-400", label: "signed" },
  declined: { dot: "bg-red-400", label: "declined" },
  viewed: { dot: "bg-sky-400", label: "viewed" },
  sent: { dot: "bg-amber-400", label: "sent, not signed" },
  pending: { dot: "bg-slate-500", label: "not sent" },
};

const ACTIVE = ["prepared", "dispatching", "active", "sent", "viewed", "signing", "signatures_complete", "rendering", "sealed", "distributing"];
const PROCESSING = ["signatures_complete", "rendering", "sealed", "distributing"];

function signerDetail(x: { status: string; signedAt: Date | null; viewedAt: Date | null; declinedAt: Date | null }): string {
  if (x.status === "signed" && x.signedAt) return `signed ${formatDateTime(x.signedAt)}`;
  if (x.status === "declined") return x.declinedAt ? `declined ${formatDateTime(x.declinedAt)}` : "declined";
  if (x.viewedAt) return `opened ${formatDateTime(x.viewedAt)} · not signed`;
  if (x.status === "sent") return "sent · not opened yet";
  return "not sent yet";
}

function requestTone(status: string): "neutral" | "info" | "warning" | "success" | "danger" {
  if (status === "completed") return "success";
  if (["declined", "rejected", "failed_manual_intervention"].includes(status)) return "danger";
  if (["signing", "signatures_complete", "rendering", "distributing"].includes(status)) return "warning";
  if (["prepared", "dispatching", "active", "sent", "viewed", "sealed"].includes(status)) return "info";
  return "neutral";
}

function phaseLabel(status: string): string {
  const labels: Record<string, string> = {
    prepared: "Prepared",
    dispatching: "Dispatching",
    active: "Awaiting signer",
    signing: "Signing in progress",
    signatures_complete: "Signatures captured",
    rendering: "Rendering final PDF",
    sealed: "Cryptographically sealed",
    distributing: "Verifying & distributing",
    completed: "Completed & anchored",
    failed_manual_intervention: "Manual intervention required",
  };
  return labels[status] || status.replaceAll("_", " ");
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

type Ops = { envelopeId: string; pendingJobs: bigint; deadJobs: bigint; failedDeliveries: bigint };

export default async function SignaturesPage() {
  await requireAnyPermission("signing.view", "signing.manage");
  const [requests, pendingApprovals, operations] = await Promise.all([
    prisma.signatureRequest.findMany({
      where: { deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 200,
      include: { recipients: true },
    }),
    prisma.approvalStep.findMany({
      where: { status: "pending", request: { deletedAt: null, status: { notIn: ["voided", "completed", "rejected", "declined", "failed_manual_intervention"] } } },
      include: { request: { select: { id: true, title: true } } },
      orderBy: { createdAt: "asc" },
      take: 100,
    }),
    basePrisma.$queryRaw<Ops[]>(Prisma.sql`
      SELECT q.id AS "envelopeId",
        count(j.id) FILTER (WHERE j.status IN ('pending','leased','retry'))::bigint AS "pendingJobs",
        count(j.id) FILTER (WHERE j.status='dead_letter')::bigint AS "deadJobs",
        (SELECT count(*) FROM "SigningDelivery" d WHERE d."envelopeId"=q.id AND d.status IN ('failed','dead_letter'))::bigint AS "failedDeliveries"
      FROM "SignatureRequest" q LEFT JOIN "SigningOutboxJob" j ON j."envelopeId"=q.id
      WHERE q."deletedAt" IS NULL GROUP BY q.id
    `),
  ]);
  const zero = BigInt(0);
  const ops = new Map(operations.map((row) => [row.envelopeId, row]));
  const total = requests.length;
  const completed = requests.filter((request) => request.status === "completed").length;
  const active = requests.filter((request) => ACTIVE.includes(request.status)).length;
  const processing = requests.filter((request) => PROCESSING.includes(request.status)).length;
  const alerts = requests.filter((request) => request.status === "failed_manual_intervention" || Number(ops.get(request.id)?.deadJobs || zero) > 0).length;
  const completionRate = total ? Math.round((completed / total) * 100) : 0;
  const times = requests
    .filter((request) => request.status === "completed" && request.sentAt && request.completedAt)
    .map((request) => (request.completedAt!.getTime() - request.sentAt!.getTime()) / 3_600_000);
  const medHours = median(times);

  return <div className="space-y-6">
    <WorkspaceHero
      icon={FileSignature}
      eyebrow="High-trust document execution"
      title="Signatures"
      description="Identity verification, immutable custody, cryptographic sealing, durable delivery and independently verifiable evidence."
      actions={<>
        <Link href="/settings/signing" className="btn-secondary btn-sm"><ShieldCheck className="size-4" /> Trust operations</Link>
        <Link href="/settings/signing-workflows" className="btn-secondary btn-sm"><Workflow className="size-4" /> Workflows</Link>
        <Link href="/documents" className="btn-primary btn-sm"><FileText className="size-4" /> Open documents</Link>
      </>}
      stats={[
        { label: "Active", value: active, detail: processing ? `${processing} sealing or distributing` : "Awaiting signer action", icon: Clock3, tone: active ? "warning" : "success" },
        { label: "Completed", value: completed, detail: `${completionRate}% anchored completion`, icon: CheckCircle2, tone: "success" },
        { label: "Median time", value: medHours == null ? "—" : medHours < 1 ? `${Math.round(medHours * 60)}m` : `${medHours.toFixed(1)}h`, detail: "Sent to final anchor", icon: Timer },
        { label: "Alerts", value: alerts, detail: alerts ? "Operator attention required" : "Custody healthy", icon: alerts ? AlertTriangle : ShieldCheck, tone: alerts ? "warning" : "success" },
      ]}
    />

    {pendingApprovals.length > 0 && <Surface className="overflow-hidden border-amber-500/25 bg-amber-500/[0.05]">
      <div className="border-b border-amber-500/15 p-4"><SectionHeading title={<span className="inline-flex items-center gap-2"><ShieldCheck className="size-4 text-amber-300" /> Pending approvals</span>} description={`${pendingApprovals.length} approval gate${pendingApprovals.length === 1 ? "" : "s"} holding workflow progress.`} /></div>
      <ul className="divide-y divide-border/60 px-4">{pendingApprovals.map((step) => <li key={step.id} className="flex flex-wrap items-center gap-3 py-3.5"><div className="min-w-0 flex-1"><Link href={`/signatures/${step.request.id}`} className="truncate text-[13px] font-medium hover:text-primary">{step.request.title}</Link><div className="text-[11px] text-muted-foreground">{step.label}{step.assigneeName ? ` · ${step.assigneeName}` : ""}</div></div><ApprovalActions stepId={step.id} /></li>)}</ul>
    </Surface>}

    <Surface className="overflow-hidden">
      <div className="border-b border-border p-4"><SectionHeading title={<span className="inline-flex items-center gap-2"><FileSignature className="size-4 text-primary" /> Signing requests</span>} description="Signer progress and every trust phase from preparation through external evidence anchoring." /></div>
      {!requests.length ? <EmptyState icon={FileSignature} title="No signature requests yet" description="Open a document and choose Send for signing to start a tracked request." action={<Link href="/documents" className="btn-primary btn-sm">Open documents</Link>} className="m-4" /> :
      <ul className="divide-y divide-border/60">{requests.map((request) => {
        const signers = [...request.recipients].filter((recipient) => recipient.role !== "viewer").sort((a, b) => a.order - b.order);
        const signed = signers.filter((recipient) => recipient.status === "signed").length;
        const pct = signers.length ? Math.round((signed / signers.length) * 100) : 0;
        const state = ops.get(request.id);
        const dead = Number(state?.deadJobs || zero);
        const deliveryFailures = Number(state?.failedDeliveries || zero);
        const pending = Number(state?.pendingJobs || zero);
        const nextUp = request.ordering === "sequential" && ACTIVE.includes(request.status) ? signers.find((recipient) => !["signed", "declined"].includes(recipient.status)) || null : null;
        return <RecordContextMenu key={request.id} label={request.title} href={`/signatures/${request.id}`}><li className="group flex flex-col gap-3 p-4 transition-colors hover:bg-muted/20 sm:flex-row sm:items-start">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-muted/35 text-muted-foreground group-hover:border-primary/25 group-hover:text-primary">{request.status === "completed" ? <LockKeyhole className="size-4" /> : <FileSignature className="size-4" />}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><Link href={`/signatures/${request.id}`} className="truncate text-[13px] font-medium hover:text-primary">{request.title}</Link><StatusPill tone={requestTone(request.status)}>{phaseLabel(request.status)}</StatusPill>{dead ? <StatusPill tone="danger">{dead} dead letter{dead === 1 ? "" : "s"}</StatusPill> : null}{deliveryFailures ? <StatusPill tone="danger">{deliveryFailures} delivery failure{deliveryFailures === 1 ? "" : "s"}</StatusPill> : null}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">{signed}/{signers.length} signed · {request.ordering}{request.sentAt ? ` · sent ${formatDateTime(request.sentAt)}` : ""}{request.completedAt ? ` · finalized ${formatDateTime(request.completedAt)}` : ` · updated ${formatDateTime(request.updatedAt)}`}{pending ? ` · ${pending} durable job${pending === 1 ? "" : "s"} pending` : ""}</div>
            {signers.length ? <div className="mt-1.5 h-1 w-full max-w-xs overflow-hidden rounded-full bg-border/60"><div className="h-full rounded-full bg-emerald-500/70" style={{ width: `${pct}%` }} /></div> : null}
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">{signers.map((recipient) => { const meta = RECIPIENT_STATUS[recipient.status] || RECIPIENT_STATUS.pending; const isNext = nextUp?.id === recipient.id; return <span key={recipient.id} className={`inline-flex items-center gap-1.5 text-[11px] ${isNext ? "font-semibold text-amber-200" : "text-muted-foreground"}`}><span className={`size-1.5 rounded-full ${meta.dot}`} />{recipient.name}<span className="text-muted-foreground/60">· {isNext ? "up next · " : ""}{signerDetail(recipient)}</span></span>; })}</div>
          </div>
          <Link href={`/signatures/${request.id}`} className="btn-secondary btn-sm shrink-0 self-start">{request.status === "completed" ? <><LockKeyhole className="size-3.5" /> Evidence</> : <><Send className="size-3.5" /> Open</>}</Link>
        </li></RecordContextMenu>;
      })}</ul>}
    </Surface>
  </div>;
}
