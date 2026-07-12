import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatZAR } from "@/lib/format";
import { saveTargets } from "@/app/actions/targets";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

const METRICS = [
  { id: "leads", label: "New leads", kind: "count" as const },
  { id: "sales_value", label: "Sales value (won)", kind: "money" as const },
  { id: "deliveries", label: "Deliveries", kind: "count" as const },
  { id: "services", label: "Services completed", kind: "count" as const },
];

export default async function TargetsPage() {
  const user = await requireUser();
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [targets, leads, wonLeads, deliveries, services] = await Promise.all([
    prisma.target.findMany({ where: { period } }),
    prisma.lead.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.lead.findMany({
      where: { status: "won", updatedAt: { gte: monthStart } },
      select: { valueCents: true },
    }),
    prisma.quote.count({ where: { deliveredAt: { gte: monthStart } } }),
    prisma.serviceRecord.count({ where: { serviceDate: { gte: monthStart } } }),
  ]);

  const targetMap = new Map(targets.map((t) => [t.metric, t.value]));
  const salesValue = wonLeads.reduce((s, l) => s + l.valueCents, 0);
  const actuals: Record<string, number> = {
    leads,
    sales_value: salesValue,
    deliveries,
    services,
  };

  const monthName = now.toLocaleDateString("en-ZA", { month: "long", year: "numeric" });

  return (
    <div className="space-y-6">
      <PageHeader title={`Targets — ${monthName}`} description="This month’s goals and live progress across sales and service." />

      <div className="grid sm:grid-cols-2 gap-4">
        {METRICS.map((m) => {
          const actual = actuals[m.id] ?? 0;
          const target = targetMap.get(m.id) ?? 0;
          const pct = target > 0 ? Math.min(100, Math.round((actual / target) * 100)) : 0;
          const fmt = (v: number) => (m.kind === "money" ? formatZAR(v) : v.toLocaleString());
          const hit = target > 0 && actual >= target;
          return (
            <div key={m.id} className="card">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-300">{m.label}</p>
                {target > 0 && (
                  <span className={`badge ${hit ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800 text-slate-400"}`}>
                    {pct}%
                  </span>
                )}
              </div>
              <p className="text-2xl font-semibold tracking-[-0.035em] mt-1">
                {fmt(actual)}
                {target > 0 && (
                  <span className="text-sm text-slate-500 font-normal"> / {fmt(target)}</span>
                )}
              </p>
              <div className="mt-3 h-2 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className={`h-full ${hit ? "bg-emerald-500" : "bg-orange-500"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {target === 0 && (
                <p className="text-xs text-slate-500 mt-2">No target set for this month.</p>
              )}
            </div>
          );
        })}
      </div>

      {user.role === "owner" && (
        <div className="card">
          <h2 className="font-semibold mb-3">Set this month&apos;s targets</h2>
          <form action={saveTargets.bind(null, period)} className="grid sm:grid-cols-2 gap-3">
            {METRICS.map((m) => (
              <div key={m.id}>
                <label className="label">
                  {m.label} {m.kind === "money" ? "(R)" : ""}
                </label>
                <input
                  name={m.id}
                  className="input"
                  inputMode={m.kind === "money" ? "decimal" : "numeric"}
                  defaultValue={
                    targetMap.has(m.id)
                      ? m.kind === "money"
                        ? String((targetMap.get(m.id) ?? 0) / 100)
                        : String(targetMap.get(m.id))
                      : ""
                  }
                  placeholder="0"
                />
              </div>
            ))}
            <div className="sm:col-span-2">
              <button className="btn-primary">Save targets</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
