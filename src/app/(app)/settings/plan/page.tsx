import Link from "next/link";
import { redirect } from "next/navigation";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { basePrisma } from "@/lib/db";
import { formatZAR } from "@/lib/format";
import { usageFor } from "@/lib/usage";
import { METER_IDS, METERS, invoiceNumber, planAmounts, usageMonth, usedUnits } from "@/lib/usageMeters";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";

export const dynamic = "force-dynamic";

const units = (n: number) => n.toLocaleString("en-ZA", { maximumFractionDigits: 2 });

/** The workspace owner's view of its plan: what's included, what it has used this month, and its invoices. */
export default async function PlanPage() {
  await requireTenantOwner();
  const tenantId = await getActiveTenantId();
  if (!tenantId) redirect("/settings");
  const month = usageMonth();
  const [tenant, usage, invoices] = await Promise.all([
    basePrisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { planName: true, planMonthlyCents: true, planIncluded: true, planOverage: true, platformAi: true },
    }),
    usageFor(tenantId, month),
    basePrisma.tenantInvoice.findMany({ where: { tenantId }, orderBy: { number: "desc" }, take: 24 }),
  ]);
  const included = planAmounts(tenant.planIncluded);
  const overage = planAmounts(tenant.planOverage);

  return (
    <SettingsWorkspace current="plan" title="Plan & billing" description="Your plan, what you've used this month, and your invoices." groups={SETTINGS_NAV_GROUPS}>
      <div className="card p-5">
        <h3 className="font-semibold">{tenant.planName || "No plan set"}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {tenant.planMonthlyCents ? `${formatZAR(tenant.planMonthlyCents)} a month, excl. VAT.` : "Nothing is billed until a plan is set up for you."}
          {tenant.platformAi && " AI and voice are supplied with your plan; add your own keys under Integrations to use those instead."}
        </p>
      </div>

      <div className="card p-5">
        <h3 className="font-semibold">Usage in {month}</h3>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b border-border/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="py-2 font-semibold">What</th>
              <th className="py-2 text-right font-semibold">Used</th>
              <th className="py-2 text-right font-semibold">Included</th>
              <th className="py-2 text-right font-semibold">Price over</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {METER_IDS.map((id) => (
              <tr key={id}>
                <td className="py-2">
                  {METERS[id].label}
                  <span className="block text-xs text-muted-foreground">per {METERS[id].unitLabel}</span>
                </td>
                <td className="py-2 text-right tabular-nums">{units(usedUnits(id, usage[id]))}</td>
                <td className="py-2 text-right tabular-nums">{included[id] !== undefined ? units(included[id]!) : "—"}</td>
                <td className="py-2 text-right tabular-nums">{overage[id] ? formatZAR(overage[id]!) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card p-5">
        <h3 className="font-semibold">Invoices</h3>
        {invoices.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border/50 text-sm">
            {invoices.map((invoice) => (
              <li key={invoice.id} className="flex flex-wrap items-center gap-3 py-2">
                <Link href={`/settings/plan/invoices/${invoice.id}`} className="font-medium text-primary hover:underline">
                  {invoiceNumber(invoice.number)}
                </Link>
                <span className="text-muted-foreground">{invoice.period}</span>
                <span className="tabular-nums">{formatZAR(invoice.totalCents)}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] uppercase">{invoice.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsWorkspace>
  );
}
