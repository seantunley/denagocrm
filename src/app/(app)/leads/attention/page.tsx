import Link from "next/link";
import { AlertTriangle, ArrowLeft, Clock, RotateCcw } from "lucide-react";
import { hasPermission, requireAnyPermission } from "@/lib/permissions";
import { loadAttentionList, type SetAsideLead } from "@/lib/attention/load";
import { attentionBandLabel, type AttentionBand } from "@/lib/attention/score";
import { formatDate, formatZAR } from "@/lib/format";
import SetAsideAttentionButton from "@/components/SetAsideAttentionButton";
import RestoreAttentionButton from "@/components/RestoreAttentionButton";
import { PageHeader } from "@/components/page-header";
import AttentionLiveRefresh from "@/components/AttentionLiveRefresh";
import AttentionQuickAssign from "@/components/AttentionQuickAssign";
import { listActingTenantStaff } from "@/lib/tenantActor";
import type { AttentionCategory } from "@/lib/attention/score";

/**
 * The Attention Centre.
 *
 * ── WHY A PAGE, NOT A FILTER OR A PANEL ─────────────────────────────────────
 *
 * A FILTER is the thing being replaced: it cannot rank, cannot explain, and hides
 * every card you are not looking at. A SIDE PANEL costs a whole column on a board
 * that already scrolls horizontally, and implies "context for the board" when this
 * list is cross-stage by nature. A DIGEST is a delivery channel for this data, not
 * a surface, and needs the ranking to exist first.
 *
 * ── WHAT EACH ROW LEADS WITH, AND WHY IT CHANGED ────────────────────────────
 *
 * The first version led with `Lead.title`, which is usually the PRODUCT — so two
 * deals for the same model rendered as two identical rows and the list was
 * unreadable at exactly the moment it had several things to show. It leads with
 * the person now, the way the board's own cards always have, with the opportunity
 * second and only when it says something the name does not.
 */

const BAND_STYLES: Record<AttentionBand, string> = {
  urgent: "border-red-500/40 bg-red-500/10 text-red-400",
  act: "border-orange-500/40 bg-orange-500/10 text-orange-400",
  watch: "border-slate-500/40 bg-slate-500/10 text-slate-300",
  none: "border-slate-700 bg-slate-800 text-slate-400",
};

/**
 * A signal's sentence can quote a free-text note somebody typed — an activity
 * summary is often a paragraph. Clamped to two lines with the full text on hover,
 * so one chatty note cannot push the next four deals off the screen.
 */
const DETAIL_CLAMP = "line-clamp-2";

export default async function AttentionPage({
  searchParams,
}: {
  searchParams: Promise<{ owner?: string; category?: string }>;
}) {
  // The same guard `/leads` uses. This page shows customer names and deal values,
  // so it is exactly as sensitive as the board it is reached from.
  const user = await requireAnyPermission("leads.view_all", "leads.view_owned");
  // ── WHY THE CONTROLS NEED THEIR OWN CHECK ─────────────────────────────────
  //
  // Viewing and setting aside are different permissions. The page renders for
  // anyone who may SEE leads, but every set-aside action calls
  // `requireLeadAccess(leadId, "leads.edit")` — so a read-only viewer could open
  // a dialog, type a reason, submit, and be refused. That is a worse experience
  // than not being offered the button: the work is wasted and the refusal reads
  // as a fault rather than as a rule.
  //
  // ONE CHECK, NOT ONE PER ROW, and that is not a shortcut.
  // `requireLeadAccess` is `requirePermission(...)` AND `canAccessLead(...)`, and
  // `canAccessLead` resolves through the very same `getAccessibleLeadIds` the
  // loader already applied to build this list. Every row here is therefore
  // access-checked already; the only thing left to establish is the permission.
  //
  // This is a courtesy, not the rule. The actions keep their own checks — a
  // hidden button is not a permission.
  const canEdit = await hasPermission(user, "leads.edit");
  const [{ owner = "mine", category = "all" }, canAssign, users, result] = await Promise.all([
    searchParams,
    hasPermission(user, "leads.assign"),
    listActingTenantStaff(),
    loadAttentionList(user),
  ]);
  const selectedCategory = (["customer", "commitment", "workflow"] as string[]).includes(category)
    ? category as AttentionCategory
    : null;
  const leads = result.leads.filter((lead) => {
    if (owner === "mine" && lead.ownerId !== user.id) return false;
    if (owner === "unassigned" && lead.ownerId !== null) return false;
    if (selectedCategory && !lead.signals.some((signal) => signal.category === selectedCategory)) return false;
    return true;
  });
  const { snoozed, dismissed } = result;
  const href = (nextOwner: string, nextCategory: string) =>
    `/leads/attention?owner=${encodeURIComponent(nextOwner)}&category=${encodeURIComponent(nextCategory)}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-orange-400" />
            Attention
          </span>
        }
        description="Open deals with something waiting on them, most pressing first."
      >
        <Link href="/leads" className="btn-secondary btn-sm">
          <ArrowLeft className="size-4" /> Back to the board
        </Link>
        <AttentionLiveRefresh />
      </PageHeader>

      <nav className="flex flex-wrap gap-2" aria-label="Attention filters">
        {[
          ["mine", "Mine"],
          ["unassigned", "Unassigned"],
          ["all", "Everyone"],
        ].map(([value, label]) => (
          <Link key={value} href={href(value, category)} className={owner === value ? "btn-primary btn-sm" : "btn-secondary btn-sm"}>
            {label}
          </Link>
        ))}
        <span className="mx-1 border-l border-border" />
        {[
          ["all", "All reasons"],
          ["customer", "Customer waiting"],
          ["commitment", "Commitments"],
          ["workflow", "Workflow"],
        ].map(([value, label]) => (
          <Link key={value} href={href(owner, value)} className={category === value ? "btn-primary btn-sm" : "btn-secondary btn-sm"}>
            {label}
          </Link>
        ))}
      </nav>

      {leads.length === 0 ? (
        <div className="card text-center">
          <p className="text-sm font-medium">Nothing is waiting.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Every open deal has a next step, no overdue work and no unanswered customer.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {leads.map((lead) => (
            <li key={lead.id} className="card flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className={`badge border ${BAND_STYLES[lead.band]}`}
                    // The number is deliberately secondary to the reasons below —
                    // it orders the list and nothing more.
                    title={`Score ${lead.score} of 100`}
                  >
                    {attentionBandLabel(lead.band)}
                  </span>
                  {/* WHO, first and largest. See the header note. */}
                  <Link href={`/leads/${lead.id}`} className="truncate font-semibold hover:underline">
                    {lead.name}
                  </Link>
                  <span className="text-xs text-muted-foreground">{lead.stageName}</span>
                  {lead.valueCents > 0 && (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatZAR(lead.valueCents)}
                    </span>
                  )}
                </div>
                {lead.opportunity && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{lead.opportunity}</p>
                )}
                <ul className="mt-2 space-y-1">
                  {lead.signals.map((signal) => (
                    <li key={signal.key} className="rounded-lg border border-border/60 p-2 text-xs text-foreground/80">
                      <div className="flex items-start gap-1.5">
                        <Clock className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                        <span className={DETAIL_CLAMP} title={signal.detail}>{signal.detail}</span>
                      </div>
                      <details className="mt-1 pl-4 text-muted-foreground">
                        <summary className="cursor-pointer">Context</summary>
                        <p className="mt-1 whitespace-pre-wrap">{signal.context}</p>
                      </details>
                      <div className="mt-2 flex flex-wrap items-center gap-2 pl-4">
                        <Link href={signal.actionHref} className="btn-primary btn-sm">{signal.actionLabel}</Link>
                        {canEdit && (
                          <>
                            <SetAsideAttentionButton leadId={lead.id} name={lead.name} mode="snooze" signalKey={signal.key} signalKind={signal.kind} />
                            <SetAsideAttentionButton leadId={lead.id} name={lead.name} mode="dismiss" signalKey={signal.key} signalKind={signal.kind} />
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                {lead.repeatedSnooze && (
                  <p className="mt-2 flex items-center gap-1 text-xs font-medium text-amber-300">
                    <RotateCcw className="size-3.5" /> Snoozed repeatedly — decide whether to progress or close.
                  </p>
                )}
                {lead.ownerName && (
                  <p className="mt-2 text-[11px] text-muted-foreground">Owner: {lead.ownerName}</p>
                )}
              </div>
              {canAssign && <AttentionQuickAssign leadId={lead.id} ownerId={lead.ownerId} users={users} />}
            </li>
          ))}
        </ul>
      )}

      {/*
        Set-aside deals, shown WITH their reasons and kept as two lists.
        "Back on the 19th" and "does not belong here" answer different questions,
        and a shorter list than expected is otherwise indistinguishable from a
        broken one. Collapsed so they do not compete with the live list.
      */}
      <SetAside
        title={`${snoozed.length} snoozed`}
        rows={snoozed}
        // The date it RETURNS is the useful fact for a snooze, so it leads.
        when={(at) => `back ${formatDate(at)}`}
        empty={snoozed.length === 0}
        // The LISTS stay for everyone — knowing a deal was set aside, and why, is
        // information a read-only viewer is entitled to. Only the way back is
        // gated, because restoring is a write.
        canEdit={canEdit}
      />
      <SetAside
        title={`${dismissed.length} dismissed`}
        rows={dismissed}
        when={(at) => `dismissed ${formatDate(at)}`}
        empty={dismissed.length === 0}
        canEdit={canEdit}
      />
    </div>
  );
}

/** One collapsible list of set-aside deals, with a way back for each. */
function SetAside({
  title,
  rows,
  when,
  empty,
  canEdit,
}: {
  title: string;
  rows: SetAsideLead[];
  when: (at: Date) => string;
  empty: boolean;
  /** Required, not defaulted: a new caller must decide rather than inherit `true`. */
  canEdit: boolean;
}) {
  if (empty) return null;
  return (
    <details className="rounded-xl border border-border bg-muted/10 p-3">
      <summary className="cursor-pointer text-xs font-medium">{title}</summary>
      <ul className="mt-3 space-y-2">
        {rows.map((lead) => (
          <li
            key={lead.key}
            className="flex items-start justify-between gap-3 border-t border-border pt-2 first:border-0 first:pt-0"
          >
            <div className="min-w-0">
              <Link href={`/leads/${lead.id}`} className="text-sm font-medium hover:underline">
                {lead.name}
              </Link>
              <span className="ml-2 text-[11px] text-muted-foreground">{when(lead.at)}</span>
              <p className="mt-0.5 text-xs text-muted-foreground">“{lead.reason}”</p>
              <p className="mt-0.5 text-xs text-foreground/70">{lead.signalDetail}</p>
            </div>
            {canEdit && <RestoreAttentionButton leadId={lead.id} name={lead.name} signalKey={lead.signalKey} />}
          </li>
        ))}
      </ul>
    </details>
  );
}
