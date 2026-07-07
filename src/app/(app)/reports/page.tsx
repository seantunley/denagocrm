import { subDays, subMonths, startOfMonth, format } from "date-fns";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import Tabs from "@/components/Tabs";
import { formatZAR } from "@/lib/format";

function Bar({ value, max, color = "bg-orange-600" }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-2.5 rounded-full bg-slate-800 overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default async function ReportsPage() {
  await requireUser();
  const now = new Date();
  const d90 = subDays(now, 90);
  const thisMonth = startOfMonth(now);

  const [leads90, openLeads, stages, quotes, completedJobCards, wonAll] = await Promise.all([
    prisma.lead.findMany({
      where: { createdAt: { gte: d90 } },
      include: { product: true },
    }),
    prisma.lead.findMany({ where: { status: "open" }, include: { stage: true } }),
    prisma.pipelineStage.findMany({ orderBy: { order: "asc" } }),
    prisma.quote.findMany({ include: { items: true } }),
    prisma.jobCard.findMany({
      where: { status: "completed", completedAt: { gte: subMonths(thisMonth, 5) } },
      include: { items: true },
    }),
    prisma.lead.findMany({ where: { status: "won" }, include: { product: true } }),
  ]);

  // Lead sources (90 days) with conversion
  const sources = new Map<string, { total: number; won: number }>();
  for (const l of leads90) {
    const s = sources.get(l.source) ?? { total: 0, won: 0 };
    s.total++;
    if (l.status === "won") s.won++;
    sources.set(l.source, s);
  }
  const sourceRows = [...sources.entries()].sort((a, b) => b[1].total - a[1].total);
  const maxSource = Math.max(1, ...sourceRows.map(([, v]) => v.total));

  // Pipeline by stage
  const stageRows = stages.map((s) => {
    const inStage = openLeads.filter((l) => l.stageId === s.id);
    return {
      name: s.name,
      color: s.color,
      count: inStage.length,
      value: inStage.reduce((sum, l) => sum + l.valueCents, 0),
    };
  });
  const maxStage = Math.max(1, ...stageRows.map((r) => r.value));

  // Won / lost
  const won90 = leads90.filter((l) => l.status === "won");
  const lost90 = leads90.filter((l) => l.status === "lost");
  const closed90 = won90.length + lost90.length;
  const winRate = closed90 > 0 ? Math.round((won90.length / closed90) * 100) : null;
  const wonValue90 = won90.reduce((s, l) => s + l.valueCents, 0);

  const lostReasons = new Map<string, number>();
  for (const l of lost90) {
    const r = l.lostReason?.trim() || "No reason recorded";
    lostReasons.set(r, (lostReasons.get(r) ?? 0) + 1);
  }
  const lostRows = [...lostReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  // Sales by model (all time, won leads)
  const byModel = new Map<string, { count: number; value: number }>();
  for (const l of wonAll) {
    const key = l.product?.name ?? "Other / unspecified";
    const m = byModel.get(key) ?? { count: 0, value: 0 };
    m.count++;
    m.value += l.valueCents;
    byModel.set(key, m);
  }
  const modelRows = [...byModel.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8);
  const maxModel = Math.max(1, ...modelRows.map(([, v]) => v.count));

  // Quotes — superseded versions don't count; only the latest of each chain
  const quoteCounts = { draft: 0, sent: 0, accepted: 0, declined: 0 };
  let acceptedValue = 0;
  for (const q of quotes) {
    if (q.supersededAt) continue;
    quoteCounts[q.status as keyof typeof quoteCounts] =
      (quoteCounts[q.status as keyof typeof quoteCounts] ?? 0) + 1;
    if (q.status === "accepted")
      acceptedValue += q.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
  }
  const decided = quoteCounts.accepted + quoteCounts.declined;
  const quoteRate = decided > 0 ? Math.round((quoteCounts.accepted / decided) * 100) : null;

  // Workshop revenue by month (last 6 months)
  const workshopMonths: { label: string; value: number; count: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const mStart = subMonths(thisMonth, i);
    const mEnd = subMonths(thisMonth, i - 1);
    const inMonth = completedJobCards.filter(
      (j) => j.completedAt && j.completedAt >= mStart && j.completedAt < mEnd
    );
    workshopMonths.push({
      label: format(mStart, "MMM"),
      count: inMonth.length,
      value: inMonth.reduce(
        (s, j) => s + j.items.reduce((si, it) => si + it.qty * it.unitPriceCents, 0),
        0
      ),
    });
  }
  const maxWorkshop = Math.max(1, ...workshopMonths.map((m) => m.value));

  const workshopRevenue6mo = workshopMonths.reduce((s2, m) => s2 + m.value, 0);
  const workshopJobs6mo = workshopMonths.reduce((s2, m) => s2 + m.count, 0);
  const avgJobValue = workshopJobs6mo > 0 ? workshopRevenue6mo / workshopJobs6mo : 0;
  const thisMonthShop = workshopMonths[workshopMonths.length - 1];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Reports</h1>

      <Tabs
        tabs={[
          {
            key: "sales",
            label: "Sales",
            content: (
              <div className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <StatCard label="Leads (90 days)" value={String(leads90.length)} />
                  <StatCard
                    label="Win rate (90 days)"
                    value={winRate != null ? `${winRate}%` : "—"}
                    sub={`${won90.length} won · ${lost90.length} lost`}
                  />
                  <StatCard label="Sales value (90 days)" value={formatZAR(wonValue90)} />
                  <StatCard
                    label="Quote acceptance"
                    value={quoteRate != null ? `${quoteRate}%` : "—"}
                    sub={`${quoteCounts.accepted} accepted · ${formatZAR(Math.round(acceptedValue))}`}
                  />
                </div>

                <div className="grid lg:grid-cols-2 gap-4">
                  <div className="card p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">
                      Where leads come from (90 days)
                    </p>
                    {sourceRows.length === 0 ? (
                      <p className="text-sm text-slate-400">No leads yet.</p>
                    ) : (
                      <div className="space-y-2.5">
                        {sourceRows.map(([source, v]) => (
                          <div key={source}>
                            <div className="flex justify-between text-sm mb-0.5">
                              <span className="capitalize">{source}</span>
                              <span className="text-slate-400 text-xs">
                                {v.total} lead{v.total !== 1 ? "s" : ""}
                                {v.won > 0 ? ` · ${v.won} won` : ""}
                              </span>
                            </div>
                            <Bar value={v.total} max={maxSource} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="card p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">
                      Open pipeline by stage
                    </p>
                    <div className="space-y-2.5">
                      {stageRows.map((r) => (
                        <div key={r.name}>
                          <div className="flex justify-between text-sm mb-0.5">
                            <span className="flex items-center gap-2">
                              <span
                                className="h-2 w-2 rounded-full"
                                style={{ backgroundColor: r.color }}
                              />
                              {r.name}
                            </span>
                            <span className="text-slate-400 text-xs">
                              {r.count} · {formatZAR(r.value)}
                            </span>
                          </div>
                          <Bar value={r.value} max={maxStage} />
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="card p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">
                      Sales by model (all time)
                    </p>
                    {modelRows.length === 0 ? (
                      <p className="text-sm text-slate-400">No sales recorded yet.</p>
                    ) : (
                      <div className="space-y-2.5">
                        {modelRows.map(([model, v]) => (
                          <div key={model}>
                            <div className="flex justify-between text-sm mb-0.5">
                              <span className="truncate">{model}</span>
                              <span className="text-slate-400 text-xs">
                                {v.count} · {formatZAR(v.value)}
                              </span>
                            </div>
                            <Bar value={v.count} max={maxModel} color="bg-emerald-600" />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="card p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">
                      Why leads are lost (90 days)
                    </p>
                    {lostRows.length === 0 ? (
                      <p className="text-sm text-slate-400">No lost leads — long may it last.</p>
                    ) : (
                      <ul>
                        {lostRows.map(([reason, count]) => (
                          <li
                            key={reason}
                            className="flex justify-between text-sm border-b border-slate-800/60 py-1.5 last:border-0"
                          >
                            <span className="truncate">{reason}</span>
                            <span className="text-slate-400 ml-4">{count}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            ),
          },
          {
            key: "service",
            label: "Service",
            content: (
              <div className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <StatCard
                    label="Workshop revenue (6 mo)"
                    value={formatZAR(Math.round(workshopRevenue6mo))}
                  />
                  <StatCard label="Jobs completed (6 mo)" value={String(workshopJobs6mo)} />
                  <StatCard label="Avg job value" value={formatZAR(Math.round(avgJobValue))} />
                  <StatCard
                    label="This month"
                    value={formatZAR(Math.round(thisMonthShop?.value ?? 0))}
                    sub={`${thisMonthShop?.count ?? 0} job${(thisMonthShop?.count ?? 0) !== 1 ? "s" : ""} completed`}
                  />
                </div>

                <div className="card p-4 max-w-3xl">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">
                    Workshop revenue by month
                  </p>
                  <div className="space-y-2.5">
                    {workshopMonths.map((mo) => (
                      <div key={mo.label}>
                        <div className="flex justify-between text-sm mb-0.5">
                          <span>{mo.label}</span>
                          <span className="text-slate-400 text-xs">
                            {mo.count} job{mo.count !== 1 ? "s" : ""} ·{" "}
                            {formatZAR(Math.round(mo.value))}
                          </span>
                        </div>
                        <Bar value={mo.value} max={maxWorkshop} color="bg-blue-600" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  );
}
