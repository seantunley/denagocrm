import {
  BadgeDollarSign,
  CalendarDays,
  Check,
  Gauge,
  Target,
  Truck,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatZAR } from "@/lib/format";
import { saveTargets } from "@/app/actions/targets";
import { SectionHeading, StatusPill, Surface } from "@/components/visual-system";
import { WorkspaceHero } from "@/components/workspace-hero";

export const dynamic = "force-dynamic";

const METRICS: Array<{
  id: "leads" | "sales_value" | "deliveries" | "services";
  label: string;
  description: string;
  kind: "count" | "money";
  icon: LucideIcon;
}> = [
  { id: "leads", label: "New leads", description: "Opportunities created this month", kind: "count", icon: Users },
  { id: "sales_value", label: "Sales value", description: "Value of deals marked as won", kind: "money", icon: BadgeDollarSign },
  { id: "deliveries", label: "Deliveries", description: "Quotes completed and delivered", kind: "count", icon: Truck },
  { id: "services", label: "Services completed", description: "Service records completed this month", kind: "count", icon: Wrench },
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

  const targetMap = new Map(targets.map((target) => [target.metric, target.value]));
  const actuals: Record<string, number> = {
    leads,
    sales_value: wonLeads.reduce((sum, lead) => sum + lead.valueCents, 0),
    deliveries,
    services,
  };
  const configured = METRICS.filter((metric) => (targetMap.get(metric.id) ?? 0) > 0);
  const achieved = configured.filter((metric) => actuals[metric.id] >= (targetMap.get(metric.id) ?? 0)).length;
  const overallProgress = configured.length
    ? Math.round(configured.reduce((sum, metric) => sum + Math.min(1, actuals[metric.id] / (targetMap.get(metric.id) ?? 1)), 0) / configured.length * 100)
    : 0;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysRemaining = Math.max(0, daysInMonth - now.getDate());
  const monthName = now.toLocaleDateString("en-ZA", { month: "long", year: "numeric" });

  return (
    <div className="space-y-6">
      <WorkspaceHero
        icon={Target}
        eyebrow="Monthly performance"
        title="Targets"
        description={configured.length
          ? `Live progress against your ${monthName} sales and service plan.`
          : `Set your ${monthName} plan and turn live CRM activity into a shared scorecard.`}
        actions={user.role === "owner" ? <a href="#monthly-plan" className="btn-primary btn-sm"><Gauge className="size-4" /> Set monthly plan</a> : undefined}
        stats={[
          { label: "Plan progress", value: configured.length ? `${overallProgress}%` : "Not set", detail: configured.length ? `${achieved} goals achieved` : "Add monthly targets", icon: Gauge, tone: configured.length ? "primary" : "warning" },
          { label: "Goals achieved", value: `${achieved} / ${configured.length || 4}`, detail: "Configured measures", icon: Check, tone: achieved > 0 && achieved === configured.length ? "success" : "default" },
          { label: "Days remaining", value: daysRemaining, detail: monthName, icon: CalendarDays },
          { label: "Configured", value: `${configured.length} / ${METRICS.length}`, detail: "Live CRM measures", icon: Target },
        ]}
      />

      <div className={`grid items-start gap-6 ${user.role === "owner" ? "xl:grid-cols-[minmax(0,1fr)_22rem]" : ""}`}>
        <div className="space-y-4">
          <SectionHeading title="Goal progress" description="Actual performance updates automatically from CRM activity." />
          <div className="grid gap-4 sm:grid-cols-2">
            {METRICS.map((metric) => {
              const actual = actuals[metric.id] ?? 0;
              const target = targetMap.get(metric.id) ?? 0;
              const rawPercent = target > 0 ? Math.round(actual / target * 100) : 0;
              const progress = Math.min(100, rawPercent);
              const hit = target > 0 && actual >= target;
              const remaining = Math.max(0, target - actual);
              const formatValue = (value: number) => metric.kind === "money" ? formatZAR(value) : value.toLocaleString("en-ZA");
              const Icon = metric.icon;

              return (
                <Surface key={metric.id} className="group relative p-5 transition-colors hover:border-white/15">
                  <div className="flex items-start justify-between gap-4">
                    <span className={`grid size-10 shrink-0 place-items-center rounded-xl border ${hit ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300" : "border-primary/20 bg-primary/10 text-primary"}`}>
                      {hit ? <Check className="size-[18px]" /> : <Icon className="size-[18px]" />}
                    </span>
                    {target > 0 ? <StatusPill tone={hit ? "success" : rawPercent >= 70 ? "warning" : "neutral"}>{rawPercent}%</StatusPill> : <StatusPill>Not set</StatusPill>}
                  </div>
                  <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{metric.label}</p>
                  <p className="mt-1 text-2xl font-semibold tracking-[-0.04em] tabular-nums text-foreground">{formatValue(actual)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{target > 0 ? `${formatValue(target)} target` : metric.description}</p>
                  <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted/70">
                    <div className={`h-full rounded-full transition-[width] ${hit ? "bg-emerald-400" : "bg-primary"}`} style={{ width: `${progress}%` }} />
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {target === 0 ? "Add a target to start tracking progress." : hit ? "Target achieved" : `${formatValue(remaining)} still needed`}
                  </p>
                </Surface>
              );
            })}
          </div>
        </div>

        {user.role === "owner" && (
          <div id="monthly-plan" className="scroll-mt-6 xl:sticky xl:top-6">
          <Surface className="p-5">
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary"><Target className="size-4" /></span>
              <div><h2 className="font-semibold tracking-tight">Set monthly targets</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Update the plan without changing recorded actuals.</p></div>
            </div>
            <form action={saveTargets.bind(null, period)} className="mt-5 space-y-4">
              {METRICS.map((metric) => (
                <div key={metric.id}>
                  <label htmlFor={`target-${metric.id}`} className="label">{metric.label} {metric.kind === "money" ? "(R)" : ""}</label>
                  <input
                    id={`target-${metric.id}`}
                    name={metric.id}
                    className="input"
                    inputMode={metric.kind === "money" ? "decimal" : "numeric"}
                    min="0"
                    defaultValue={targetMap.has(metric.id) ? metric.kind === "money" ? String((targetMap.get(metric.id) ?? 0) / 100) : String(targetMap.get(metric.id)) : ""}
                    placeholder="0"
                  />
                </div>
              ))}
              <button className="btn-primary w-full"><Gauge className="size-4" /> Save monthly plan</button>
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><CalendarDays className="size-3.5" /> Applies to {monthName} only.</p>
            </form>
          </Surface>
          </div>
        )}
      </div>
    </div>
  );
}
