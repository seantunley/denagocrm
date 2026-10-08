import Link from "next/link";
import { ArrowRight, Sun } from "lucide-react";
import { requireAnyPermission } from "@/lib/permissions";
import { loadTodayLeads, TODAY_CANDIDATE_CAP } from "@/lib/leadScoreLoader";
import { formatZAR } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/visual-system";
import { LeadScoreBadge } from "@/components/LeadScoreBadge";

/**
 * Today — who to contact next, best first.
 *
 * Where the Attention Centre lists everything that is WRONG with a deal, this
 * ranks the deals most worth a rep's next call, engagement first (see
 * src/lib/leadScore.ts). Each row says why it is here and what to do, because a
 * ranked list without reasons is a list nobody trusts.
 */

/** A day's worth of calls, not the whole pipeline. */
const SHOWN = 50;

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  // The same guard `/leads` and `/leads/attention` use: this page shows customer
  // names and deal values, so it is exactly as sensitive as the board.
  const user = await requireAnyPermission("leads.view_all", "leads.view_owned");
  const { view } = await searchParams;
  const mine = view !== "all";
  const { leads, truncated } = await loadTodayLeads(user, { mine });
  const shown = leads.slice(0, SHOWN);

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Sun className="size-5 text-primary" />
            Today
          </span>
        }
        description="Open deals most worth contacting next — customers who just engaged first, then anything slipping."
      />

      <nav className="flex flex-wrap gap-2" aria-label="Whose deals">
        <Link href="/today" className={mine ? "btn-primary btn-sm" : "btn-secondary btn-sm"}>Mine</Link>
        <Link href="/today?view=all" className={mine ? "btn-secondary btn-sm" : "btn-primary btn-sm"}>
          Everyone I can see
        </Link>
      </nav>

      {truncated && (
        <p className="text-xs text-muted-foreground">
          Ranked from the {TODAY_CANDIDATE_CAP} most recently updated open deals.
        </p>
      )}

      {shown.length === 0 ? (
        <EmptyState
          icon={Sun}
          title="Nothing to chase right now."
          description={
            mine
              ? "None of your open deals has a reason to contact them today."
              : "No open deal you can see has a reason to contact them today."
          }
          action={
            mine ? (
              <Link href="/today?view=all" className="btn-secondary btn-sm">Show everyone I can see</Link>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-2">
          {shown.map((lead) => (
            <li key={lead.id} className="card flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <LeadScoreBadge score={lead.score} />
                  <Link href={`/leads/${lead.id}`} className="truncate font-semibold hover:underline">
                    {lead.name}
                  </Link>
                  <span className="text-xs text-muted-foreground">{lead.stageName}</span>
                  {lead.valueCents > 0 && (
                    <span className="text-xs tabular-nums text-muted-foreground">{formatZAR(lead.valueCents)}</span>
                  )}
                </div>
                {lead.opportunity && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{lead.opportunity}</p>
                )}
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {lead.reasons.map((reason) => (
                    <li key={reason} className="rounded-md border border-border/60 px-2 py-0.5 text-xs text-foreground/80">
                      {reason}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {lead.assignedToName ? `Owner: ${lead.assignedToName}` : "Unassigned"}
                </p>
              </div>
              <Link href={`/leads/${lead.id}`} className="btn-primary btn-sm shrink-0">
                {lead.action}
                <ArrowRight className="size-4" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
