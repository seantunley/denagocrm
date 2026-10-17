import Link from "next/link";
import {
  ArrowRight, CalendarDays, CheckCircle2, CircleDollarSign, Clock4, FileSignature, Flame, SquareKanban, Sun, Target, UserPlus,
} from "lucide-react";
import { formatZAR, formatZARCompact } from "@/lib/format";
import { ActivityRow } from "@/components/dashboard/sections";
import { PipelineSnapshot, Stagger, StaggerItem, StatSparkCard } from "@/components/dashboard/widgets";
import type { HomeFocus } from "@/lib/home/focus";
import type { HomeNumber } from "@/lib/home/focusRules";

/**
 * The home screen: a glance, then a queue.
 *
 *  1. A summary band — the greeting, one sentence that sums the day up, and how
 *     far along the month's target is. Its colour is the day's mood.
 *  2. A handful of numbers, each with what it is measured against and each a
 *     link to the records behind it.
 *  3. "Do next": the deals most worth contacting, best first, each with its
 *     reason and one action. The first is the one to start with, and looks it.
 *  4. Beside it: today's agenda, what is waiting on others, and the pipeline's
 *     shape — the one chart on the page.
 *
 * Uncluttered is not the same as flat. There is colour, movement and one real
 * picture here; what there is NOT is a second chart, a feed, or a number that
 * goes nowhere.
 */

const ICONS: Record<HomeNumber["key"], React.ReactNode> = {
  sales: <CircleDollarSign />, pipeline: <SquareKanban />, "new-leads": <UserPlus />, overdue: <Clock4 />, waiting: <FileSignature />,
};

const MOOD = {
  calm: { dot: "bg-emerald-400", glow: "from-emerald-500/15", ring: "border-emerald-500/20", word: "All clear" },
  busy: { dot: "bg-primary", glow: "from-primary/20", ring: "border-primary/25", word: "Worth your time today" },
  behind: { dot: "bg-red-400", glow: "from-red-500/15", ring: "border-red-500/25", word: "Catch up first" },
} as const;

/** The month's target as a ring. Drawn here, in SVG: no chart library for one arc. */
function TargetRing({ progress, label }: { progress: number; label: string }) {
  const R = 46, C = 2 * Math.PI * R;
  return (
    // Targets is a desktop page (lib/phoneScope.ts): on a phone the progress is shown, but it opens nothing.
    <Link href="/targets" className="group flex shrink-0 items-center gap-4 max-md:pointer-events-none" aria-label={`Sales target: ${label}`}>
      <div className="relative size-28">
        <svg viewBox="0 0 110 110" className="size-28 -rotate-90">
          <circle cx="55" cy="55" r={R} fill="none" stroke="currentColor" strokeWidth="9" className="text-foreground/10" />
          <circle cx="55" cy="55" r={R} fill="none" stroke="var(--primary)" strokeWidth="9" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - progress)} className="transition-[stroke-dashoffset] duration-700" />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums text-foreground">{Math.round(progress * 100)}%</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">of target</span>
        </div>
      </div>
      <div className="hidden min-w-0 sm:block">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">This month</p>
        <p className="mt-0.5 text-sm text-foreground group-hover:underline">{label}</p>
      </div>
    </Link>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function FocusHome({
  focus, mine, canSeeTeam, greeting, firstName,
}: { focus: HomeFocus; mine: boolean; canSeeTeam: boolean; greeting: string; firstName: string }) {
  const mood = MOOD[focus.mood];
  const sales = focus.numbers.find((n) => n.key === "sales");
  const [first, ...rest] = focus.queue;

  return (
    <div className="space-y-5">
      {/* ── the summary band ── */}
      <header className={`relative overflow-hidden rounded-2xl border ${mood.ring} bg-card p-5 sm:p-6`}>
        <div aria-hidden className={`pointer-events-none absolute -right-24 -top-32 size-96 rounded-full bg-gradient-to-br ${mood.glow} to-transparent blur-3xl`} />
        <div aria-hidden className="pointer-events-none absolute -bottom-40 left-1/3 size-80 rounded-full bg-gradient-to-tr from-primary/10 to-transparent blur-3xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-6">
          <div className="min-w-0 flex-1 basis-80">
            <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <span className={`size-2 rounded-full ${mood.dot}`} aria-hidden />
              {mood.word}
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{greeting}, {firstName}</h1>
            {/* One sentence does the job of several charts: how much needs you, and of what kind. */}
            <p className="mt-2 max-w-2xl text-base text-foreground/80">{focus.brief}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {focus.seesLeads && <Link href={mine ? "/today" : "/today?view=all"} className="btn-primary btn-sm"><Sun className="size-4" aria-hidden />Start my day</Link>}
              {focus.agenda && <Link href="/calendar" className="btn-secondary btn-sm"><CalendarDays className="size-4" aria-hidden />Calendar</Link>}
            </div>
          </div>
          {sales?.progress !== undefined ? (
            <TargetRing progress={sales.progress} label={`${sales.value} sold — ${sales.context}`} />
          ) : sales ? (
            <Link href="/targets" className="group flex shrink-0 items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground max-md:hidden">
              <Target className="size-5 text-primary" aria-hidden />
              <span><span className="block font-medium text-foreground">{sales.value} sold this month</span>Set a target to track progress</span>
            </Link>
          ) : null}
        </div>
      </header>

      {/* ── a handful of numbers ── */}
      {focus.numbers.length > 0 && (
        // On a phone the numbers are one row that scrolls sideways, so the queue — the reason to open this
        // page — is not pushed down a screen. From a tablet up they are a grid.
        <section aria-label="At a glance">
          <Stagger className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-1 [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0 xl:grid-cols-5">
            {focus.numbers.map((n) => (
              <StaggerItem key={n.key} className="min-w-[11rem] shrink-0 snap-start sm:min-w-0 sm:shrink">
                <StatSparkCard
                  icon={ICONS[n.key]}
                  stat={{ label: n.label, value: n.amount, display: n.display, delta: n.delta, href: n.href, spark: focus.sparks[n.key] ?? [], tone: n.alert ? "warn" : "default", context: n.context }}
                />
              </StaggerItem>
            ))}
          </Stagger>
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        {/* ── do next ── */}
        {focus.seesLeads && (
          <section aria-labelledby="do-next" className="min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-5 lg:col-span-2 lg:self-start">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 id="do-next" className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Flame className="size-4 text-primary" aria-hidden />
                Do next
              </h2>
              {canSeeTeam && (
                <nav className="flex gap-1 rounded-lg bg-muted/50 p-0.5 text-xs" aria-label="Whose deals">
                  <Link href="/" aria-current={mine ? "page" : undefined} className={`rounded-md px-2.5 py-1 font-medium ${mine ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>Mine</Link>
                  <Link href="/?view=all" aria-current={mine ? undefined : "page"} className={`rounded-md px-2.5 py-1 font-medium ${mine ? "text-muted-foreground hover:text-foreground" : "bg-background text-foreground shadow-sm"}`}>Everyone</Link>
                </nav>
              )}
            </div>

            {!first ? (
              // A quiet list is a good result, and should look like one.
              <div className="flex flex-col items-center gap-2 rounded-xl bg-emerald-500/5 px-4 py-10 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-emerald-500/15"><CheckCircle2 className="size-6 text-emerald-400" aria-hidden /></span>
                <p className="text-base font-semibold text-foreground">You&apos;re clear.</p>
                <p className="max-w-sm text-sm text-muted-foreground">{mine ? "None of your open deals has a reason to contact them today." : "No open deal you can see has a reason to contact them today."}</p>
              </div>
            ) : (
              <Stagger className="space-y-2">
                {/* The first one is where to start, and looks it. */}
                <StaggerItem>
                  <div className="relative overflow-hidden rounded-xl border border-primary/30 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">Start here</p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-3">
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/20 text-sm font-semibold text-primary" aria-hidden>{initials(first.name)}</span>
                      <div className="min-w-0 flex-1 basis-48">
                        <p className="flex flex-wrap items-baseline gap-x-2">
                          <Link href={`/leads/${first.id}`} className="truncate text-lg font-semibold text-foreground hover:underline">{first.name}</Link>
                          {first.valueCents > 0 && <span className="text-sm font-medium tabular-nums text-foreground/80">{formatZAR(first.valueCents)}</span>}
                          <span className="text-xs text-muted-foreground">{first.stageName}{!mine && first.assignedToName ? ` · ${first.assignedToName}` : ""}</span>
                        </p>
                        {/* Why it is here. A ranked list with no reasons is a list nobody trusts. */}
                        <ul className="mt-1.5 flex flex-wrap gap-1.5">
                          {first.reasons.slice(0, 3).map((reason, i) => (
                            <li key={reason} className={`rounded-full px-2.5 py-0.5 text-xs ${i === 0 ? "bg-primary/20 font-medium text-primary" : "bg-muted text-foreground/80"}`}>{reason}</li>
                          ))}
                        </ul>
                      </div>
                      <Link href={`/leads/${first.id}`} className="btn-primary btn-sm w-full shrink-0 justify-center sm:w-auto">
                        {first.action}
                        <ArrowRight className="size-4" aria-hidden />
                      </Link>
                    </div>
                  </div>
                </StaggerItem>
                {rest.map((lead) => (
                  // On a phone the action sits under the reason, full width, so neither squeezes the other.
                  <StaggerItem key={lead.id}>
                    <div className="group flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-transparent px-3 py-2.5 transition-colors hover:border-border hover:bg-muted/40">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground/80" aria-hidden>{initials(lead.name)}</span>
                      <div className="min-w-0 flex-1 basis-40">
                        <p className="flex flex-wrap items-baseline gap-x-2">
                          <Link href={`/leads/${lead.id}`} className="truncate text-sm font-medium text-foreground hover:underline">{lead.name}</Link>
                          {lead.valueCents > 0 && <span className="text-xs tabular-nums text-muted-foreground">{formatZARCompact(lead.valueCents)}</span>}
                          {!mine && lead.assignedToName && <span className="text-xs text-muted-foreground">· {lead.assignedToName}</span>}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground"><span className="text-primary">{lead.reasons[0]}</span>{lead.reasons[1] ? ` · ${lead.reasons[1]}` : ""}</p>
                      </div>
                      <Link href={`/leads/${lead.id}`} className="btn-secondary btn-sm w-full shrink-0 justify-center sm:w-auto">
                        {lead.action}
                        <ArrowRight className="size-3.5" aria-hidden />
                      </Link>
                    </div>
                  </StaggerItem>
                ))}
              </Stagger>
            )}
            {first && (
              <Link href={mine ? "/today" : "/today?view=all"} className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                {focus.queueMore > 0 ? `See ${focus.queueMore} more` : "Open the full list"}
                <ArrowRight className="size-3" aria-hidden />
              </Link>
            )}
          </section>
        )}

        {/* ── today, waiting, and the pipeline's shape ── */}
        <div className={`min-w-0 space-y-5 ${focus.seesLeads ? "" : "lg:col-span-3"}`}>
          {focus.agenda && (
            <section aria-labelledby="today-agenda" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 id="today-agenda" className="flex items-center gap-2 text-sm font-semibold text-foreground"><CalendarDays className="size-4 text-[var(--chart-2)]" aria-hidden />Today</h2>
                <Link href="/calendar" className="text-xs font-medium text-primary hover:underline">Calendar</Link>
              </div>
              {focus.agenda.length === 0 ? (
                <p className="rounded-lg bg-muted/40 px-3 py-4 text-center text-sm text-muted-foreground">Nothing planned for today.</p>
              ) : (
                <ul className="space-y-0.5">
                  {focus.agenda.slice(0, 6).map((a) => <ActivityRow key={a.id} a={a} highlightOverdue />)}
                </ul>
              )}
              {focus.agenda.length > 6 && <Link href="/activities" className="mt-2 inline-block text-xs font-medium text-primary hover:underline">See {focus.agenda.length - 6} more</Link>}
            </section>
          )}

          {focus.waitingSignature !== null && (
            <section aria-labelledby="waiting-on-others" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
              <h2 id="waiting-on-others" className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground"><Clock4 className="size-4 text-[var(--chart-4)]" aria-hidden />Waiting on others</h2>
              <Link href="/signatures" className="flex items-center gap-3 rounded-xl bg-muted/40 px-3 py-3 text-sm transition-colors hover:bg-muted/70">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--chart-4)_20%,transparent)]"><FileSignature className="size-4 text-[var(--chart-4)]" aria-hidden /></span>
                <span className="flex-1 text-foreground">{focus.waitingSignature === 0 ? "Nothing out for signature" : `${focus.waitingSignature} ${focus.waitingSignature === 1 ? "quote" : "quotes"} out for signature`}</span>
                <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
              </Link>
            </section>
          )}

          {focus.stages.length > 0 && (
            <section aria-labelledby="pipeline-shape" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 id="pipeline-shape" className="flex items-center gap-2 text-sm font-semibold text-foreground"><SquareKanban className="size-4 text-[var(--chart-3)]" aria-hidden />Pipeline</h2>
                <Link href="/leads" className="text-xs font-medium text-primary hover:underline">Board</Link>
              </div>
              <PipelineSnapshot segments={focus.stages} totalValue={formatZARCompact(focus.stages.reduce((sum, s) => sum + s.value, 0))} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
