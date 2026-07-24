import Link from "next/link";
import { requireAnyPermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { formatDate, formatDateTime } from "@/lib/format";
import { ApprovalActions } from "./ApprovalActions";
import { PageHeader } from "@/components/page-header";
import { ShieldCheck } from "lucide-react";
import RecordContextMenu from "@/components/RecordContextMenu";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-slate-700/40 text-slate-300",
  sent: "bg-blue-500/15 text-blue-300",
  viewed: "bg-indigo-500/15 text-indigo-300",
  in_progress: "bg-amber-500/15 text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-300",
  declined: "bg-red-500/15 text-red-300",
  expired: "bg-slate-600/30 text-slate-400",
  voided: "bg-slate-600/30 text-slate-400",
  rejected: "bg-rose-500/15 text-rose-300",
};

// Per-recipient status → dot colour + label, for the signer chips on each row.
const RECIPIENT_STATUS: Record<string, { dot: string; label: string }> = {
  signed: { dot: "bg-emerald-400", label: "signed" },
  declined: { dot: "bg-red-400", label: "declined" },
  viewed: { dot: "bg-sky-400", label: "viewed" },
  sent: { dot: "bg-amber-400", label: "sent, not signed" },
  pending: { dot: "bg-slate-500", label: "not sent" },
};

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

export default async function SignaturesPage() {
  await requireAnyPermission("signing.view", "signing.manage");
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

  const card = "rounded-xl border border-border bg-card p-4 shadow-sm";
  const stat = "rounded-xl border border-border bg-card p-4 text-center";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Signatures"
        description="Send documents for signing, track progress, and keep a complete in-house audit trail."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className={stat}><div className="text-2xl font-bold text-foreground">{total}</div><div className="text-xs text-muted-foreground">Total</div></div>
        <div className={stat}><div className="text-2xl font-bold text-amber-300">{active}</div><div className="text-xs text-muted-foreground">Awaiting</div></div>
        <div className={stat}><div className="text-2xl font-bold text-emerald-300">{completed}</div><div className="text-xs text-muted-foreground">Completed</div></div>
        <div className={stat}><div className="text-2xl font-bold text-foreground">{completionRate}%</div><div className="text-xs text-muted-foreground">Completion</div></div>
        <div className={stat}><div className="text-2xl font-bold text-foreground">{medHours == null ? "—" : medHours < 1 ? `${Math.round(medHours * 60)}m` : `${medHours.toFixed(1)}h`}</div><div className="text-xs text-muted-foreground">Median time</div></div>
      </div>

      {pendingApprovals.length > 0 && (
        <div className={`${card} border-amber-500/30 bg-amber-500/[0.06]`}>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-200"><ShieldCheck className="size-4" aria-hidden="true" />Pending approvals ({pendingApprovals.length})</h2>
          <ul className="divide-y divide-border/50">
            {pendingApprovals.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <Link href={`/signatures/${s.request.id}`} className="truncate text-[13px] font-medium text-foreground hover:text-primary">{s.request.title}</Link>
                  <div className="text-[11px] text-muted-foreground">{s.label} · requested {formatDate(s.createdAt)}{s.assigneeName ? ` · ${s.assigneeName}` : ""}</div>
                </div>
                <ApprovalActions stepId={s.id} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={card}>
        {requests.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground/70">Nothing yet. Open a document in the editor and choose “Send for signing”.</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {requests.map((r) => {
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
                <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link href={`/signatures/${r.id}`} className="truncate text-[13px] font-medium text-foreground hover:text-primary">{r.title}</Link>
                      <span className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[r.status] ?? "bg-slate-700/40 text-slate-300"}`}>{r.status.replace("_", " ")}</span>
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
      </div>

      {declined > 0 && <p className="text-xs text-red-300/80">{declined} request{declined > 1 ? "s" : ""} declined — follow up from the detail view.</p>}
    </div>
  );
}
