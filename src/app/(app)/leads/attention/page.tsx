import Link from "next/link";
import { AlertTriangle, ArrowLeft, BellOff, Clock } from "lucide-react";
import { requireAnyPermission } from "@/lib/permissions";
import { loadAttentionList } from "@/lib/attention/load";
import { attentionBandLabel, type AttentionBand } from "@/lib/attention/score";
import { formatZAR } from "@/lib/format";
import SnoozeAttentionButton from "@/components/SnoozeAttentionButton";
import { PageHeader } from "@/components/page-header";

/**
 * The Attention Centre.
 *
 * ── WHY A PAGE, NOT A FILTER OR A PANEL ─────────────────────────────────────
 *
 * A FILTER is the thing being replaced: it cannot rank, cannot explain, and hides
 * every card you are not looking at — destroying the board's spatial meaning at
 * the moment you most want context.
 *
 * A SIDE PANEL competes for horizontal space on a board that is already a
 * horizontally-scrolling strip of `w-[min(88vw,22rem)]` columns; on a laptop it
 * costs a whole column. It also implies "context for the board", when this list is
 * cross-stage by nature.
 *
 * A DIGEST is a delivery channel for this data, not a surface — and it needs the
 * ranking to exist first.
 *
 * A page gets a URL to bookmark and link, its own guard mirroring `/leads`, and
 * room for the reasons, which are the product.
 */

const BAND_STYLES: Record<AttentionBand, string> = {
  urgent: "border-red-500/40 bg-red-500/10 text-red-400",
  act: "border-orange-500/40 bg-orange-500/10 text-orange-400",
  watch: "border-slate-500/40 bg-slate-500/10 text-slate-300",
  none: "border-slate-700 bg-slate-800 text-slate-400",
};

export default async function AttentionPage() {
  // The same guard `/leads` uses. This page shows lead titles and values, so it
  // is exactly as sensitive as the board it is reached from.
  const user = await requireAnyPermission("leads.view_all", "leads.view_owned");
  const { leads, snoozedCount } = await loadAttentionList(user);

  return (
    <div className="space-y-5">
      {/*
        The shared PageHeader, not a hand-rolled one. `visualConsistencyGuardrail`
        enforces this and caught the first version of this page — every screen
        uses it so headers stay aligned, and a bespoke header here would have been
        one more thing to chase the next time the shell changes.
      */}
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

      {snoozedCount > 0 && (
        // Surfaced rather than silently omitted: a shorter list than expected is
        // indistinguishable from a broken one, and a snooze somebody else set is
        // exactly the thing you would want to know about.
        <p className="rounded-xl border border-border bg-muted/10 px-3 py-2 text-xs text-slate-400">
          <BellOff className="mr-1 inline size-3.5" />
          {snoozedCount} {snoozedCount === 1 ? "deal is" : "deals are"} snoozed and not shown.
        </p>
      )}

      {leads.length === 0 ? (
        <div className="card text-center">
          <p className="text-sm font-medium">Nothing is waiting.</p>
          <p className="mt-1 text-xs text-slate-400">
            Every open deal has a next step, no overdue work and no unanswered customer.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {leads.map((lead) => (
            <li key={lead.id} className="card flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`badge border ${BAND_STYLES[lead.band]}`}
                    // The number is deliberately secondary to the reasons below —
                    // it orders the list and nothing more.
                    title={`Score ${lead.score} of 100`}
                  >
                    {attentionBandLabel(lead.band)}
                  </span>
                  <Link href={`/leads/${lead.id}`} className="truncate font-semibold hover:underline">
                    {lead.title}
                  </Link>
                  <span className="text-xs text-slate-500">{lead.stageName}</span>
                  {lead.valueCents > 0 && (
                    <span className="text-xs tabular-nums text-slate-400">
                      {formatZAR(lead.valueCents)}
                    </span>
                  )}
                </div>
                <ul className="mt-2 space-y-1">
                  {lead.signals.map((signal) => (
                    <li key={signal.kind} className="flex items-start gap-1.5 text-xs text-slate-300">
                      <Clock className="mt-0.5 size-3 shrink-0 text-slate-500" />
                      <span>{signal.detail}</span>
                    </li>
                  ))}
                </ul>
                {lead.ownerName && (
                  <p className="mt-2 text-[11px] text-slate-500">Owner: {lead.ownerName}</p>
                )}
              </div>
              <SnoozeAttentionButton leadId={lead.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
