import Link from "next/link";
import { AlertTriangle, ArrowLeft, Clock } from "lucide-react";
import { requireAnyPermission } from "@/lib/permissions";
import { loadAttentionList } from "@/lib/attention/load";
import { attentionBandLabel, type AttentionBand } from "@/lib/attention/score";
import { formatZAR } from "@/lib/format";
import DismissAttentionButton from "@/components/DismissAttentionButton";
import RestoreAttentionButton from "@/components/RestoreAttentionButton";
import { PageHeader } from "@/components/page-header";

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

export default async function AttentionPage() {
  // The same guard `/leads` uses. This page shows customer names and deal values,
  // so it is exactly as sensitive as the board it is reached from.
  const user = await requireAnyPermission("leads.view_all", "leads.view_owned");
  const { leads, dismissed } = await loadAttentionList(user);

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
      </PageHeader>

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
                    <li key={signal.kind} className="flex items-start gap-1.5 text-xs text-foreground/80">
                      <Clock className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                      <span className={DETAIL_CLAMP} title={signal.detail}>
                        {signal.detail}
                      </span>
                    </li>
                  ))}
                </ul>
                {lead.ownerName && (
                  <p className="mt-2 text-[11px] text-muted-foreground">Owner: {lead.ownerName}</p>
                )}
              </div>
              <DismissAttentionButton leadId={lead.id} name={lead.name} />
            </li>
          ))}
        </ul>
      )}

      {dismissed.length > 0 && (
        // Shown WITH the reasons, not counted. "Why is this not here" is the
        // question the reason exists to answer, and a bare number cannot — a
        // shorter list than expected is otherwise indistinguishable from a broken
        // one. Collapsed by default so it does not compete with the live list.
        <details className="rounded-xl border border-border bg-muted/10 p-3">
          <summary className="cursor-pointer text-xs font-medium">
            {dismissed.length} dismissed
          </summary>
          <ul className="mt-3 space-y-2">
            {dismissed.map((lead) => (
              <li key={lead.id} className="flex items-start justify-between gap-3 border-t border-border pt-2 first:border-0 first:pt-0">
                <div className="min-w-0">
                  <Link href={`/leads/${lead.id}`} className="text-sm font-medium hover:underline">
                    {lead.name}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted-foreground">“{lead.reason}”</p>
                </div>
                <RestoreAttentionButton leadId={lead.id} name={lead.name} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
