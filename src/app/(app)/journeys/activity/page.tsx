import Link from "next/link";
import { Activity, ArrowLeft, TriangleAlert } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { recentTraceEvents, triggerHealth } from "@/lib/journeyTrace";
import { PageHeader } from "@/components/page-header";
import { EmptyState, StatusPill } from "@/components/visual-system";

export const dynamic = "force-dynamic";

/**
 * The journey activity trace, after Home Assistant's automation traces.
 *
 * The engine already recorded every event, run and step; nothing showed them.
 * So a journey that never ran looked exactly like one that ran and matched
 * nobody — which is how journeys built on event triggers sat active, enrolling
 * nobody, for as long as it took someone to notice by hand.
 *
 * The trigger table is deliberately first. "Never fired" is the answer that
 * identifies broken wiring, and a list of runs can never give it to you: an
 * empty run list looks identical either way.
 */
export default async function JourneyActivityPage() {
  await requireOwner();
  const [health, events] = await Promise.all([triggerHealth(), recentTraceEvents({ limit: 60 })]);
  const neverFired = health.filter((row) => !row.everSeen);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Journey activity"
        description="What fired, what each journey decided, and why. Every event the engine has seen."
      >
        <Link href="/journeys" className="btn-secondary btn-sm">
          <ArrowLeft className="size-4" />
          Back to journeys
        </Link>
      </PageHeader>

      {neverFired.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-300">
            <TriangleAlert className="size-4" />
            {neverFired.length} trigger{neverFired.length === 1 ? "" : "s"} the builder offers
            {neverFired.length === 1 ? " has" : " have"} never fired
          </p>
          <p className="mt-1 text-xs leading-5 text-amber-200/80">
            A journey built on one of these will activate, look correct, and enrol nobody — there is
            no error to see, because nothing ever reaches it. Either the event is genuinely rare in
            this workspace, or nothing in the app emits it yet.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {neverFired.map((row) => (
              <span key={row.trigger} className="rounded bg-amber-500/15 px-2 py-0.5 font-mono text-[11px] text-amber-200">
                {row.trigger}
              </span>
            ))}
          </div>
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Triggers — last 30 days</h2>
        {/* A list, not a table: three short fields that wrap cleanly on a phone
            beat a grid that has to scroll sideways to show its own verdict. */}
        <ul className="divide-y divide-border/50">
          {health.map((row) => (
            <li key={row.trigger} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="font-mono text-[12px] text-foreground">{row.trigger}</span>
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {row.events} event{row.events === 1 ? "" : "s"}
              </span>
              <span className="ml-auto">
                {!row.everSeen ? (
                  <StatusPill tone="warning">Never fired</StatusPill>
                ) : row.events === 0 ? (
                  <StatusPill tone="neutral">Quiet</StatusPill>
                ) : (
                  <StatusPill tone="success">Firing</StatusPill>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Recent events</h2>
        {events.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No events yet"
            description="Nothing has emitted a journey event. Until something does, no journey can enrol anyone."
          />
        ) : (
          <ul className="space-y-2">
            {events.map((event) => (
              <li key={event.id} className="rounded-lg border border-border/60 bg-background/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[12px] font-medium text-foreground">{event.type}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {event.entityType} · {event.entityId.slice(0, 8)}
                  </span>
                  <StatusPill tone={event.status === "failed" ? "danger" : event.status === "processed" ? "success" : "neutral"}>
                    {event.status}
                  </StatusPill>
                  <span className="ml-auto text-[11px] text-muted-foreground">{formatDateTime(event.createdAt)}</span>
                </div>

                {event.error && <p className="mt-1.5 text-xs text-red-400">⚠ {event.error}</p>}

                {event.decisions === null ? (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Recorded before decision tracing existed — no verdicts were kept for this event.
                  </p>
                ) : event.decisions.length === 0 ? (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    No active journey was considered. Nothing is listening.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1">
                    {event.decisions.map((decision) => (
                      <li key={decision.journeyId} className="flex flex-wrap items-baseline gap-2 text-[12px]">
                        <span className={decision.enrolled ? "text-emerald-400" : "text-muted-foreground"}>
                          {decision.enrolled ? "✓" : "—"}
                        </span>
                        <span className="text-foreground">{decision.journeyName}</span>
                        <span className="text-[11px] text-muted-foreground">{decision.reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
