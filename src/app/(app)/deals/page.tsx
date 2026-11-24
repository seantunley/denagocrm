import Link from "next/link";
import { AlertTriangle, Briefcase, CalendarDays, Filter, Layers, Plus, Truck, Wallet, Zap } from "lucide-react";
import { requireRoute } from "@/lib/permissions";
import { loadDealsCentre } from "@/lib/dealsCentre";
import { BLOCKER_INFO, DEALS_VIEWS, dealTotals, dealsView } from "@/lib/dealsCentreRules";
import { BLOCKER_KEYS, DEFAULT_MILESTONE_LABELS, MILESTONE_KEYS, type BlockerKey } from "@/lib/dealMilestones";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { financeStatusShort, financeTone } from "@/lib/dealFinanceRules";
import { johannesburgStartOfDay } from "@/lib/activityDay";
import { pageWindow, parsePage } from "@/lib/listPaging";
import { getRegionalSettings } from "@/lib/settings";
import { withCurrency } from "@/lib/currencyRules";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { EmptyState, MetricCard, StatusPill } from "@/components/visual-system";
import { MobileDataCard, MobileDataHeader, MobileDataList, ResponsiveDataView } from "@/components/responsive-patterns";
import { CardEmpty, CardRow, CentreCards, CentreHeader, CentreMain, Panel, StatRow, ViewChips } from "@/components/centre";
import ListPager from "@/components/ListPager";

export const metadata = { title: "Deals" };

const statusTone = (status: string) =>
  status === "accepted" ? "success" : status === "declined" || status === "cancelled" ? "danger" : status === "sent" ? "info" : "neutral";

/**
 * The Deals Centre (brief §3; layout from Sean's mockups, 2026-11-24): every quote
 * you can see as a deal — what it is worth, what has come in, what is still owed,
 * how far along it is and what is in the way. Each row opens the deal page; nothing
 * here is a record of its own.
 */
export default async function DealsPage({ searchParams }: { searchParams: Promise<{ show?: string; q?: string; page?: string; blocker?: string }> }) {
  // The same door as the deal page: quotes.view_all or quotes.view_owned (ROUTE_RULES "/deals").
  const user = await requireRoute("/deals");
  const params = await searchParams;
  const view = dealsView(params.show, await isModuleEnabled("finance"));
  const q = params.q?.trim() || undefined;
  const blocker = BLOCKER_KEYS.find((key) => key === params.blocker) as BlockerKey | undefined;
  const [{ rows, inPlay, counts, blockers, financeOn }, regional] = await Promise.all([loadDealsCentre(user, view, { q, blocker }), getRegionalSettings()]);
  const { page, skip, take } = pageWindow(parsePage(params.page), rows.length);
  const shown = rows.slice(skip, skip + take);
  const money = (cents: number, currency: string | null) => formatZAR(cents, withCurrency(regional, currency));
  const views = DEALS_VIEWS.filter((option) => option.key !== "finance" || financeOn);
  const qs = (extra: Record<string, string>) => `/deals?${new URLSearchParams({ ...(q ? { q } : {}), ...extra }).toString()}`;

  // Headline money is the base currency; other currencies are named beside it, never added.
  const inPlayTotals = dealTotals(inPlay);
  const base = inPlayTotals.find((t) => (t.currency ?? regional.currency) === regional.currency);
  const othersOwed = inPlayTotals.filter((t) => t !== base && t.owed > 0).map((t) => money(t.owed, t.currency));

  const now = new Date();
  const weekEnd = new Date(johannesburgStartOfDay(now).getTime() + 7 * 86_400_000);
  const thisWeek = inPlay
    .filter((row) => row.deliveryScheduledFor && row.deliveryScheduledFor >= johannesburgStartOfDay(now) && row.deliveryScheduledFor < weekEnd)
    .sort((a, b) => a.deliveryScheduledFor!.getTime() - b.deliveryScheduledFor!.getTime());
  const byStep = MILESTONE_KEYS.slice(1).map((key) => {
    const label = DEFAULT_MILESTONE_LABELS[key];
    const at = inPlay.filter((row) => row.milestone === label);
    return { label, count: at.length, cents: at.filter((r) => (r.currency ?? regional.currency) === regional.currency).reduce((s, r) => s + r.totalCents, 0) };
  });
  const widest = Math.max(1, ...byStep.map((s) => s.count));

  return (
    <div className="space-y-5">
      <CentreHeader
        title="Deals Centre"
        description="Commercial, finance and fulfilment for every deal you can see."
        note="Read from each quote, its payments, stock, finance and delivery"
        actions={<Link href="/quotes" className="btn-primary btn-sm"><Plus className="size-4" />New quote</Link>}
      />

      <StatRow>
        <MetricCard icon={Layers} label="Active deals" value={counts.active} detail="Sent, or accepted and not delivered" accent />
        <MetricCard icon={AlertTriangle} label="Blocked" value={counts.blocked} detail="Accepted, something in the way" />
        <MetricCard icon={Truck} label="Ready for delivery" value={counts.ready} detail="Nothing left in the way" />
        <MetricCard
          icon={Wallet}
          label="Outstanding"
          value={money(base?.owed ?? 0, base?.currency ?? null)}
          detail={othersOwed.length ? `Owed on accepted deals + ${othersOwed.join(" + ")}` : "Owed on accepted deals"}
        />
      </StatRow>

      <CentreMain
        aside={
          <Panel icon={AlertTriangle} title="Operational blockers" description="What is stopping deals in play, and where it is fixed.">
            {BLOCKER_KEYS.filter((key) => blockers[key] > 0).length === 0 ? (
              <CardEmpty>Nothing in the way of any deal.</CardEmpty>
            ) : (
              <ul className="space-y-2">
                {BLOCKER_KEYS.filter((key) => blockers[key] > 0).map((key) => (
                  <li key={key} className="rounded-lg border border-border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium">{BLOCKER_INFO[key].title}</p>
                      <StatusPill tone="warning">{blockers[key]} deal{blockers[key] === 1 ? "" : "s"}</StatusPill>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{BLOCKER_INFO[key].detail}</p>
                    <p className="mt-1.5 flex gap-3 text-xs">
                      <Link href={qs({ show: "active", blocker: key })} className="text-primary hover:underline">View deals</Link>
                      {BLOCKER_INFO[key].action && <Link href={BLOCKER_INFO[key].action!.href} className="text-primary hover:underline">{BLOCKER_INFO[key].action!.label}</Link>}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        }
      >
        <Panel icon={Zap} title="Deals worklist" description="Every deal with its money, progress, finance, delivery and what is in the way.">
          <ViewChips
            label="Deal views"
            active={view}
            chips={views.map((option) => ({ key: option.key, label: option.label, hint: option.hint, href: qs({ show: option.key }), count: counts[option.key] }))}
          />
          <form method="GET" className="mb-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="show" value={view} />
            <input name="q" defaultValue={q ?? ""} className="input w-72" placeholder="Search quote number, customer or fleet" aria-label="Search deals" />
            <button className="btn-secondary btn-sm">Search</button>
            {(q || blocker) && <Link href={`/deals?show=${view}`} className="btn-secondary btn-sm">Clear</Link>}
            {blocker && <span className="text-xs text-muted-foreground">Only: {BLOCKER_INFO[blocker].title.toLowerCase()}</span>}
          </form>

          {shown.length === 0 ? (
            <EmptyState icon={Briefcase} title="No deals in this view" description={views.find((option) => option.key === view)?.hint ?? ""} />
          ) : (
            <ResponsiveDataView
              mobile={
                <MobileDataList>
                  {shown.map((row) => (
                    <MobileDataCard key={row.id}>
                      <MobileDataHeader
                        title={<Link href={`/deals/${row.id}`} className="text-primary hover:underline">{row.customer ? contactName(row.customer) : "No customer"}</Link>}
                        detail={`Q-${row.number} · ${money(row.totalCents, row.currency)}`}
                        aside={<StatusPill tone={row.ready ? "success" : statusTone(row.status)}>{row.ready ? "Ready" : row.milestone}</StatusPill>}
                      />
                      {row.blockers.length > 0 && <p className="text-xs text-amber-700 dark:text-amber-400">{row.blockers.map((b) => b.text).join(" · ")}</p>}
                    </MobileDataCard>
                  ))}
                </MobileDataList>
              }
              desktop={
                <div className="overflow-x-auto">
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>Deal / customer</th>
                        <th className="text-right">Value</th>
                        <th>Progress</th>
                        {financeOn && <th>Finance</th>}
                        <th className="text-right">Owed</th>
                        <th>Delivery</th>
                        <th>In the way</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <Link href={`/deals/${row.id}`} className="font-medium text-primary hover:underline">{row.customer ? contactName(row.customer) : "No customer"}</Link>
                            <p className="text-xs text-muted-foreground">Q-{row.number}{row.owner ? ` · ${row.owner.split(/\s+/)[0]}` : ""}</p>
                          </td>
                          <td className="whitespace-nowrap text-right tabular-nums">{money(row.totalCents, row.currency)}</td>
                          <td className="min-w-36">
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span>{row.deliveredAt ? "Delivered" : row.milestone}</span>
                              <span className="tabular-nums text-muted-foreground" title="Steps done out of the steps that apply to this deal">{row.progress.done}/{row.progress.of}</span>
                            </div>
                            <div className="mt-1 h-1.5 rounded-full bg-muted">
                              <div className="h-1.5 rounded-full bg-primary" style={{ width: `${(row.progress.done / Math.max(1, row.progress.of)) * 100}%` }} />
                            </div>
                          </td>
                          {financeOn && (
                            <td className="whitespace-nowrap">{row.financeStatus ? <StatusPill tone={financeTone(row.financeStatus)}>{financeStatusShort(row.financeStatus)}</StatusPill> : <span className="text-muted-foreground">—</span>}</td>
                          )}
                          <td className="whitespace-nowrap text-right tabular-nums">{row.status === "accepted" ? money(Math.max(0, row.balanceCents), row.currency) : "—"}</td>
                          <td className="whitespace-nowrap text-sm">
                            {row.deliveredAt ? (
                              <span className="text-muted-foreground">Delivered {formatDate(row.deliveredAt)}</span>
                            ) : row.deliveryScheduledFor ? (
                              row.deliveryScheduledFor < johannesburgStartOfDay(now) ? (
                                <StatusPill tone="danger">{formatDate(row.deliveryScheduledFor)} · overdue</StatusPill>
                              ) : (
                                <StatusPill tone="info">{formatDate(row.deliveryScheduledFor)}</StatusPill>
                              )
                            ) : row.status === "accepted" ? (
                              <StatusPill tone="warning">Not booked</StatusPill>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="text-sm">
                            {row.ready ? (
                              <StatusPill tone="success">Ready for delivery</StatusPill>
                            ) : row.blockers.length ? (
                              <span className="flex flex-wrap gap-1">
                                {row.blockers.map((b) => (
                                  <StatusPill key={b.key} tone={b.key === "accept" ? "neutral" : "warning"}>{b.text}</StatusPill>
                                ))}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              }
            />
          )}
          <ListPager path="/deals" page={page} total={rows.length} className="mt-2" />
        </Panel>
      </CentreMain>

      <CentreCards>
        <Panel icon={Filter} title="Deals by step" description="Deals in play at each step of the way.">
          <ul className="space-y-2">
            {byStep.map((step) => (
              <li key={step.label} className="text-xs">
                <div className="flex justify-between gap-2">
                  <span>{step.label}</span>
                  <span className="tabular-nums text-muted-foreground">{step.count} · {money(step.cents, null)}</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-muted">
                  <div className="h-2 rounded-full bg-primary" style={{ width: `${(step.count / widest) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel icon={CalendarDays} title="Delivering this week" description="Deliveries booked for the next seven days." action={<Link href="/deliveries" className="text-primary hover:underline">Delivery board</Link>}>
          {thisWeek.length === 0 ? (
            <CardEmpty>No deliveries booked this week.</CardEmpty>
          ) : (
            thisWeek.slice(0, 4).map((row) => (
              <CardRow
                key={row.id}
                href={`/deals/${row.id}`}
                title={`${row.customer ? contactName(row.customer) : "No customer"} · ${money(row.totalCents, row.currency)}`}
                detail={row.ready ? "Ready to hand over" : row.blockers.map((b) => b.text).join(" · ")}
                aside={<StatusPill tone={row.ready ? "success" : "warning"}>{formatDate(row.deliveryScheduledFor)}</StatusPill>}
              />
            ))
          )}
        </Panel>
        <Panel icon={Wallet} title="Money in deals" description="Deals in play, per currency — never added across currencies.">
          {inPlayTotals.length === 0 ? (
            <CardEmpty>No deals in play.</CardEmpty>
          ) : (
            inPlayTotals.map((t) => (
              <dl key={t.currency ?? "base"} className="mb-2 grid grid-cols-2 gap-y-1 text-sm">
                {inPlayTotals.length > 1 && <dt className="col-span-2 text-xs font-medium text-muted-foreground">{t.currency ?? regional.currency}</dt>}
                <dt title="Accepted quotes: what has been sold.">Committed</dt><dd className="text-right font-semibold tabular-nums">{money(t.committed, t.currency)}</dd>
                <dt title="Deposits and payments in against accepted deals.">Received</dt><dd className="text-right tabular-nums">{money(t.received, t.currency)}</dd>
                <dt title="Still owed on accepted deals.">Owed</dt><dd className="text-right tabular-nums">{money(t.owed, t.currency)}</dd>
                <dt className="text-muted-foreground" title="Sent and not accepted yet: on the table, not sold.">Proposed</dt><dd className="text-right tabular-nums text-muted-foreground">{money(t.proposed, t.currency)}</dd>
              </dl>
            ))
          )}
        </Panel>
      </CentreCards>
    </div>
  );
}
