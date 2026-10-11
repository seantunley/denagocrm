import Link from "next/link";
import { ArrowRight, ArrowDownRight, ArrowUpRight, CheckCircle2, FileSignature } from "lucide-react";
import { formatZAR } from "@/lib/format";
import { LeadScoreBadge } from "@/components/LeadScoreBadge";
import { ActivityRow } from "@/components/dashboard/sections";
import type { HomeFocus } from "@/lib/home/focus";
import type { HomeNumber } from "@/lib/home/focusRules";

/**
 * The home screen's working area: a glance, then a queue.
 *
 *  1. A handful of numbers — each with what it is measured against, each a link
 *     to the records behind it. Never a bare figure, never a dead one.
 *  2. "Do next": the deals most worth contacting, best first, each with its
 *     reason and one action. This gets the most room; it is why the page is opened.
 *  3. Beside it, today's agenda and what is waiting on somebody else.
 *
 * Deliberately plain: one accent, red only where something needs the viewer,
 * space rather than boxes. Charts and everything else live one click away.
 */

function NumberTile({ n }: { n: HomeNumber }) {
  const Trend = n.direction === "up" ? ArrowUpRight : n.direction === "down" ? ArrowDownRight : null;
  return (
    <Link href={n.href} className="group min-w-0 rounded-xl px-3 py-2.5 transition-colors hover:bg-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
      <p className="truncate text-xs text-muted-foreground">{n.label}</p>
      <p className={`mt-0.5 truncate text-2xl font-semibold tabular-nums tracking-tight ${n.alert ? "text-red-400" : "text-foreground"}`}>{n.value}</p>
      {n.progress !== undefined && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(n.progress * 100)} aria-label={`${n.label}: ${n.context}`}>
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(n.progress * 100)}%` }} />
        </div>
      )}
      <p className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground">
        {Trend && <Trend className={`size-3.5 shrink-0 ${n.direction === "up" ? "text-emerald-400" : "text-muted-foreground"}`} aria-hidden />}
        <span className="truncate">{n.context}</span>
      </p>
    </Link>
  );
}

export function FocusHome({ focus, mine, canSeeTeam }: { focus: HomeFocus; mine: boolean; canSeeTeam: boolean }) {
  return (
    <div className="space-y-6">
      {focus.numbers.length > 0 && (
        <section aria-label="At a glance" className="grid grid-cols-2 gap-x-2 gap-y-1 border-y border-border/60 py-2 sm:grid-cols-3 lg:grid-cols-5">
          {focus.numbers.map((n) => <NumberTile key={n.key} n={n} />)}
        </section>
      )}

      <div className="grid gap-8 lg:grid-cols-3">
        {focus.seesLeads && (
          <section aria-labelledby="do-next" className="min-w-0 lg:col-span-2">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="do-next" className="text-sm font-semibold text-foreground">Do next</h2>
              {canSeeTeam && (
                <nav className="flex gap-1 text-xs" aria-label="Whose deals">
                  <Link href="/" aria-current={mine ? "page" : undefined} className={`rounded-md px-2 py-1 ${mine ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>Mine</Link>
                  <Link href="/?view=all" aria-current={mine ? undefined : "page"} className={`rounded-md px-2 py-1 ${mine ? "text-muted-foreground hover:text-foreground" : "bg-accent text-foreground"}`}>Everyone</Link>
                </nav>
              )}
            </div>
            {focus.queue.length === 0 ? (
              // A quiet list is a good result, and should look like one.
              <div className="flex items-center gap-3 rounded-xl border border-border/60 px-4 py-6">
                <CheckCircle2 className="size-5 shrink-0 text-emerald-400" aria-hidden />
                <div>
                  <p className="text-sm font-medium text-foreground">You&apos;re clear.</p>
                  <p className="text-xs text-muted-foreground">{mine ? "None of your open deals has a reason to contact them today." : "No open deal you can see has a reason to contact them today."}</p>
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-border/60 border-y border-border/60">
                {focus.queue.map((lead) => (
                  <li key={lead.id} className="flex items-center gap-3 py-3">
                    <LeadScoreBadge score={lead.score} />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-baseline gap-x-2">
                        <Link href={`/leads/${lead.id}`} className="truncate text-sm font-medium text-foreground hover:underline">{lead.name}</Link>
                        {lead.valueCents > 0 && <span className="text-xs tabular-nums text-muted-foreground">{formatZAR(lead.valueCents)}</span>}
                        {!mine && lead.assignedToName && <span className="text-xs text-muted-foreground">· {lead.assignedToName}</span>}
                      </p>
                      {/* Why it is here. A ranked list with no reasons is a list nobody trusts. */}
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{lead.reasons.slice(0, 2).join(" · ")}</p>
                    </div>
                    <Link href={`/leads/${lead.id}`} className="btn-secondary btn-sm shrink-0">
                      {lead.action}
                      <ArrowRight className="size-3.5" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {(focus.queueMore > 0 || focus.queue.length > 0) && (
              <Link href={mine ? "/today" : "/today?view=all"} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                {focus.queueMore > 0 ? `See ${focus.queueMore} more` : "Open the full list"}
                <ArrowRight className="size-3" aria-hidden />
              </Link>
            )}
          </section>
        )}

        <div className={`min-w-0 space-y-6 ${focus.seesLeads ? "" : "lg:col-span-3"}`}>
          {focus.agenda && (
            <section aria-labelledby="today-agenda">
              <div className="mb-3 flex items-center justify-between">
                <h2 id="today-agenda" className="text-sm font-semibold text-foreground">Today</h2>
                <Link href="/calendar" className="text-xs font-medium text-primary hover:underline">Calendar</Link>
              </div>
              {focus.agenda.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing planned for today.</p>
              ) : (
                <ul className="space-y-0.5">
                  {focus.agenda.slice(0, 6).map((a) => <ActivityRow key={a.id} a={a} highlightOverdue />)}
                </ul>
              )}
              {focus.agenda.length > 6 && <Link href="/activities" className="mt-2 inline-block text-xs font-medium text-primary hover:underline">See {focus.agenda.length - 6} more</Link>}
            </section>
          )}

          {focus.waitingSignature !== null && (
            <section aria-labelledby="waiting-on-others">
              <h2 id="waiting-on-others" className="mb-3 text-sm font-semibold text-foreground">Waiting on others</h2>
              <Link href="/signatures" className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-accent/40">
                <FileSignature className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex-1 text-foreground">{focus.waitingSignature === 0 ? "Nothing out for signature" : `${focus.waitingSignature} ${focus.waitingSignature === 1 ? "quote" : "quotes"} out for signature`}</span>
                <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
              </Link>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
