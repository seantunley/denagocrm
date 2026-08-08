import Link from "next/link";
import { requireAnyPermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { formatDate, formatDateTime } from "@/lib/format";
import { isRequestClosed } from "@/lib/signing/status";
import { ApprovalActions } from "./ApprovalActions";
import {
  CheckCircle2,
  Clock3,
  FileSignature,
  FileText,
  ShieldCheck,
  Timer,
  Workflow,
} from "lucide-react";
import RecordContextMenu from "@/components/RecordContextMenu";
import { WorkspaceHero } from "@/components/workspace-hero";
import { EmptyState, SectionHeading, StatusPill, Surface } from "@/components/visual-system";

export const dynamic = "force-dynamic";

// Per-recipient status → dot colour + label, for the signer chips on each row.
const RECIPIENT_STATUS: Record<string, { dot: string; label: string }> = {
  signed: { dot: "bg-emerald-400", label: "signed" },
  declined: { dot: "bg-red-400", label: "declined" },
  viewed: { dot: "bg-sky-400", label: "viewed" },
  sent: { dot: "bg-amber-400", label: "sent, not signed" },
  pending: { dot: "bg-slate-500", label: "not sent" },
};

type RequestView = "completed" | "voided" | "in-progress";

const REQUEST_VIEWS: Array<{ value: RequestView; label: string }> = [
  { value: "completed", label: "Completed" },
  { value: "voided", label: "Voided" },
  { value: "in-progress", label: "In Progress" },
];

function requestView(status: string): RequestView {
  if (status === "completed") return "completed";
  // Declined, rejected and expired requests are also closed without completion,
  // so keep them with the voided outcomes instead of presenting them as active.
  if (isRequestClosed(status)) return "voided";
  return "in-progress";
}

// A precise per-signer state line: signed/declined/opened(not signed)/sent(not
// opened)/not sent — with the exact date + time so you can see where a request
// is stuck.
function signerDetail(x: {
  status: string;
  signedAt: Date | null;
  viewedAt: Date | null;
  declinedAt: Date | null;
}): string {
  if (x.status === "signed" && x.signedAt) return `signed ${formatDateTime(x.signedAt)}`;
  if (x.status === "declined") return x.declinedAt ? `declined ${formatDateTime(x.declinedAt)}` : "declined";
  if (x.viewedAt) return `opened ${formatDateTime(x.viewedAt)} · not signed`;
  if (x.status === "sent") return "sent · not opened yet";
  return "not sent yet";
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function requestTone(status: string): "neutral" | "info" | "warning" | "success" | "danger" {
  if (status === "completed") return "success";
  if (["declined", "rejected"].includes(status)) return "danger";
  if (status === "in_progress") return "warning";
  if (["sent", "viewed"].includes(status)) return "info";
  return "neutral";
}

export default async function SignaturesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  await requireAnyPermission("signing.view", "signing.manage");
  const requestedStatus = (await searchParams).status;
  const activeView: RequestView =
    typeof requestedStatus === "string" && REQUEST_VIEWS.some((view) => view.value === requestedStatus)
      ? (requestedStatus as RequestView)
      : "in-progress";
  const requests = await prisma.signatureRequest.findMany({
    where: { deletedAt: null },
    orderBy: { updatedAt: "desc" },
    take: 200,
    include: { recipients: true },
  });

  const pendingApprovals = await prisma.approvalStep.findMany({
    where: { status: "pending", request: { deletedAt: null, status: { notIn: ["voided", "completed", "rejected", "declined"] } } },
    include: { request: { select: { id: true, title: true } } },
    orderBy: { createdAt: "asc" },
    take: 100,
  });

  const total = requests.length;
  const completed = requests.filter((r) => r.status === "completed").length;
  const declined = requests.filter((r) => r.status === "declined").length;
  const active = requests.filter((r) => ["sent", "viewed", "in_progress"].includes(r.status)).length;
  const completionRate = total ? Math.round((completed / total) * 100) : 0;
  const times = requests
    .filter((r) => r.status === "completed" && r.sentAt && r.completedAt)
    .map((r) => (r.completedAt!.getTime() - r.sentAt!.getTime()) / 3600000);
  const medHours = median(times);
  const requestsByView = REQUEST_VIEWS.reduce<Record<RequestView, typeof requests>>(
    (grouped, view) => {
      grouped[view.value] = requests.filter((request) => requestView(request.status) === view.value);
      return grouped;
    },
    { completed: [], voided: [], "in-progress": [] },
  );
  const visibleRequests = requestsByView[activeView];
  const activeViewLabel = REQUEST_VIEWS.find((view) => view.value === activeView)?.label ?? "In Progress";
  const fallbackView = REQUEST_VIEWS.find(
    (view) => view.value !== activeView && requestsByView[view.value].length > 0,
  );

  return (
    <div className="space-y-6">
      <WorkspaceHero
        icon={FileSignature}
        eyebrow="Document execution"
        title="Signatures"
        description="Send documents for signing, track progress, and keep a complete in-house audit trail."
        actions={
          <>
            <Link href="/settings/signing-workflows" className="btn-secondary btn-sm">
              <Workflow className="size-4" /> Workflows
            </Link>
            <Link href="/documents" className="btn-primary btn-sm">
              <FileText className="size-4" /> Open documents
            </Link>
          </>
        }
        stats={[
          { label: "Requests", value: total, detail: `${requests.filter((request) => request.status === "draft").length} draft`, icon: FileText },
          { label: "Awaiting", value: active, detail: active ? "Needs signer action" : "Nothing outstanding", icon: Clock3, tone: active ? "warning" : "success" },
          { label: "Completed", value: completed, detail: `${completionRate}% completion`, icon: CheckCircle2, tone: "success" },
          { label: "Median time", value: medHours == null ? "—" : medHours < 1 ? `${Math.round(medHours * 60)}m` : `${medHours.toFixed(1)}h`, detail: "Sent to completed", icon: Timer },
        ]}
      />

      {pendingApprovals.length > 0 && (
        <Surface className="overflow-hidden border-amber-500/25 bg-amber-500/[0.05]">
          <div className="border-b border-amber-500/15 p-4">
            <SectionHeading
              title={<span className="inline-flex items-center gap-2"><ShieldCheck className="size-4 text-amber-300" /> Pending approvals</span>}
              description={`${pendingApprovals.length} approval ${pendingApprovals.length === 1 ? "gate is" : "gates are"} holding document delivery.`}
            />
          </div>
          <ul className="divide-y divide-border/60 px-4">
            {pendingApprovals.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-3.5">
                <div className="min-w-0 flex-1">
                  <Link href={`/signatures/${s.request.id}`} className="truncate text-[13px] font-medium text-foreground hover:text-primary">{s.request.title}</Link>
                  <div className="text-[11px] text-muted-foreground">{s.label} · requested {formatDate(s.createdAt)}{s.assigneeName ? ` · ${s.assigneeName}` : ""}</div>
                </div>
                <ApprovalActions stepId={s.id} />
              </li>
            ))}
          </ul>
        </Surface>
      )}

      <Surface className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-end lg:justify-between">
          <SectionHeading
            title={<span className="inline-flex items-center gap-2"><FileSignature className="size-4 text-primary" /> Signing requests</span>}
            description={
              activeView === "in-progress"
                ? `${visibleRequests.length} request${visibleRequests.length === 1 ? "" : "s"} currently moving through the signing workflow.`
                : activeView === "completed"
                  ? `${visibleRequests.length} request${visibleRequests.length === 1 ? "" : "s"} completed successfully.`
                  : `${visibleRequests.length} request${visibleRequests.length === 1 ? "" : "s"} closed without completion${declined ? `, including ${declined} declined` : ""}.`
            }
          />
          <nav className="flex max-w-full gap-1 overflow-x-auto rounded-lg border border-border bg-muted/25 p-1" aria-label="Signing request status">
            {REQUEST_VIEWS.map((view) => {
              const active = activeView === view.value;
              return (
                <Link
                  key={view.value}
                  href={`/signatures?status=${view.value}`}
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
                >
                  {view.label}
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${active ? "bg-primary-foreground/15 text-primary-foreground" : "bg-background/70 text-muted-foreground"}`}>
                    {requestsByView[view.value].length}
                  </span>
                </Link>
              );
            })}
          </nav>
        </div>
        {requests.length === 0 ? (
          <EmptyState
            icon={FileSignature}
            title="No signature requests yet"
            description="Open a document in the editor and choose “Send for signing” to start a tracked request."
            action={<Link href="/documents" className="btn-primary btn-sm">Open documents</Link>}
            className="m-4"
          />
        ) : visibleRequests.length === 0 ? (
          <EmptyState
            icon={FileSignature}
            title={`No ${activeViewLabel.toLowerCase()} requests`}
            description="Choose another status to see the rest of your signing requests."
            action={fallbackView ? <Link href={`/signatures?status=${fallbackView.value}`} className="btn-secondary btn-sm">View {fallbackView.label.toLowerCase()}</Link> : undefined}
            className="m-4"
          />
        ) : (
          <ul className="divide-y divide-border/60">
            {visibleRequests.map((r) => {
              const signers = [...r.recipients]
                .filter((x) => x.role !== "viewer")
                .sort((a, b) => a.order - b.order);
              const viewers = r.recipients.filter((x) => x.role === "viewer");
              const signed = signers.filter((x) => x.status === "signed").length;
              const pct = signers.length ? Math.round((signed / signers.length) * 100) : 0;
              const isActive = ["sent", "viewed", "in_progress"].includes(r.status);
              // Sequential runs pause on the first unfinished signer — that's who we wait on.
              const nextUp =
                r.ordering === "sequential" && isActive
                  ? signers.find((x) => x.status !== "signed" && x.status !== "declined") ?? null
                  : null;
              return (
                <RecordContextMenu key={r.id} label={r.title} href={`/signatures/${r.id}`}>
                <li className="group flex flex-col gap-3 p-4 transition-colors hover:bg-muted/20 sm:flex-row sm:items-start">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-muted/35 text-muted-foreground group-hover:border-primary/25 group-hover:text-primary">
                    <FileSignature className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link href={`/signatures/${r.id}`} className="truncate text-[13px] font-medium text-foreground hover:text-primary">{r.title}</Link>
                      <StatusPill tone={requestTone(r.status)}>{r.status.replace("_", " ")}</StatusPill>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {signed}/{signers.length} signed · {r.ordering}
                      {viewers.length > 0 ? ` · ${viewers.length} viewer${viewers.length > 1 ? "s" : ""}` : ""}
                      {r.sentAt ? ` · sent ${formatDateTime(r.sentAt)}` : ""}
                      {r.completedAt ? ` · completed ${formatDateTime(r.completedAt)}` : ` · updated ${formatDateTime(r.updatedAt)}`}
                    </div>
                    {signers.length > 0 && (
                      <div className="mt-1.5 h-1 w-full max-w-xs overflow-hidden rounded-full bg-border/60" aria-hidden="true">
                        <div className="h-full rounded-full bg-emerald-500/70" style={{ width: `${pct}%` }} />
                      </div>
                    )}
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                      {signers.map((x) => {
                        const meta = RECIPIENT_STATUS[x.status] ?? RECIPIENT_STATUS.pending;
                        const isNext = nextUp?.id === x.id;
                        return (
                          <span key={x.id} className={`inline-flex items-center gap-1.5 text-[11px] ${isNext ? "font-semibold text-amber-200" : "text-muted-foreground"}`} title={x.email ?? undefined}>
                            <span className={`size-1.5 shrink-0 rounded-full ${meta.dot}`} aria-hidden="true" />
                            {x.name}
                            {x.role === "approver" ? " (approver)" : ""}
                            <span className="text-muted-foreground/60">· {isNext ? `up next · ${signerDetail(x)}` : signerDetail(x)}</span>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  <Link href={`/signatures/${r.id}`} className="btn-secondary btn-sm shrink-0 self-start">Open</Link>
                </li>
                </RecordContextMenu>
              );
            })}
          </ul>
        )}
      </Surface>
    </div>
  );
}
