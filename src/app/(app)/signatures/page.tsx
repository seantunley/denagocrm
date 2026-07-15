import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { ApprovalActions } from "./ApprovalActions";
import { PageHeader } from "@/components/page-header";
import { ShieldCheck } from "lucide-react";

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

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export default async function SignaturesPage() {
  await requireOwner();
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
              const signers = r.recipients.filter((x) => x.role !== "viewer");
              const signed = signers.filter((x) => x.status === "signed").length;
              return (
                <li key={r.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <Link href={`/signatures/${r.id}`} className="truncate text-[13px] font-medium text-foreground hover:text-primary">{r.title}</Link>
                    <div className="text-[11px] text-muted-foreground">{signed}/{signers.length} signed · {r.ordering} · updated {formatDate(r.updatedAt)}</div>
                  </div>
                  <span className={`rounded px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[r.status] ?? "bg-slate-700/40 text-slate-300"}`}>{r.status.replace("_", " ")}</span>
                  <Link href={`/signatures/${r.id}`} className="btn-secondary btn-sm">Open</Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {declined > 0 && <p className="text-xs text-red-300/80">{declined} request{declined > 1 ? "s" : ""} declined — follow up from the detail view.</p>}
    </div>
  );
}
