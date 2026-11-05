import Link from "next/link";
import { basePrisma } from "@/lib/db";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { formatDate, formatZAR } from "@/lib/format";
import { usageFor } from "@/lib/usage";
import { invoiceSettings } from "@/lib/platformInvoiceSettings";
import { METER_IDS, METERS, invoiceNumber, planAmounts, usageMonth, usedUnits, type MeterId } from "@/lib/usageMeters";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import {
  createTenantInvoiceAction,
  markTenantInvoicePaidAction,
  setInvoiceSettingsAction,
  setTenantPlanAction,
  voidTenantInvoiceAction,
} from "@/app/actions/platformBilling";

const BILLABLE = METER_IDS.filter((id) => METERS[id].billable);
const units = (n: number) => n.toLocaleString("en-ZA", { maximumFractionDigits: 2 });
const rands = (c: number | undefined) => (c === undefined ? "" : String(c / 100));

/** Months counted back from this one, newest first: [0, 1, 2] → "2026-11", "2026-10", "2026-09". */
function monthsBack(backs: number[]): string[] {
  const now = new Date();
  return backs.map((back) => usageMonth(new Date(now.getFullYear(), now.getMonth() - back, 15)));
}
const recentMonths = () => monthsBack([0, 1, 2]);

/** Platform console → a workspace → Billing: its plan, what it used, and its invoices. */
export default async function BillingTab({ tenantId }: { tenantId: string }) {
  const [thisMonth, lastMonth] = recentMonths();
  const [tenant, usageNow, usageLast, invoices, settings] = await Promise.all([
    basePrisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { planName: true, planMonthlyCents: true, planIncluded: true, planOverage: true, platformAi: true },
    }),
    usageFor(tenantId, thisMonth),
    usageFor(tenantId, lastMonth),
    basePrisma.tenantInvoice.findMany({ where: { tenantId }, orderBy: { number: "desc" }, take: 24 }),
    invoiceSettings(),
  ]);
  const included = planAmounts(tenant.planIncluded);
  const overage = planAmounts(tenant.planOverage);
  const founding = tenantId === DEFAULT_TENANT_ID;

  const usageRow = (id: MeterId) => (
    <tr key={id}>
      <td data-primary className="py-2">{METERS[id].label}</td>
      <td className="py-2 text-right tabular-nums">{units(usedUnits(id, usageNow[id]))}</td>
      <td className="py-2 text-right tabular-nums">{units(usedUnits(id, usageLast[id]))}</td>
      <td className="py-2 text-right tabular-nums text-muted-foreground">
        {METERS[id].billable && included[id] !== undefined ? units(included[id]!) : "—"}
      </td>
      <td className="py-2 text-xs text-muted-foreground">{METERS[id].unitLabel}</td>
    </tr>
  );

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h3 className="font-semibold">Usage</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Counted as it happens, per calendar month. AI is the cost at Anthropic&apos;s list prices for the model used;
          WhatsApp and SMS count messages sent through this workspace&apos;s own accounts.
        </p>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b border-border/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="py-2 font-semibold">Meter</th>
              <th className="py-2 text-right font-semibold">{thisMonth}</th>
              <th className="py-2 text-right font-semibold">{lastMonth}</th>
              <th className="py-2 text-right font-semibold">Included</th>
              <th className="py-2 pl-3 font-semibold">Unit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">{METER_IDS.map(usageRow)}</tbody>
        </table>
      </div>

      <SaveForm action={setTenantPlanAction.bind(null, tenantId)} success="Plan saved" resetOnSuccess={false} className="card space-y-4 p-5">
        <div>
          <h3 className="font-semibold">Plan</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Leave the fee blank for no plan. Usage over an allowance is billed only where an overage price is set. A change
            applies to the whole of {thisMonth} and the months after it; months already past are invoiced on the terms they had.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            Plan name
            <input name="planName" className="input mt-1" defaultValue={tenant.planName ?? ""} placeholder="e.g. Professional" />
          </label>
          <label className="block text-sm">
            Monthly fee (R, excl. VAT)
            <input name="planMonthly" inputMode="decimal" className="input mt-1" defaultValue={rands(tenant.planMonthlyCents ?? undefined)} placeholder="0.00" />
          </label>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="py-2 font-semibold">Meter</th>
              <th className="py-2 font-semibold">Included each month</th>
              <th className="py-2 font-semibold">Price over (R per unit)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {BILLABLE.map((id) => (
              <tr key={id}>
                <td className="py-2 pr-3">
                  {METERS[id].label}
                  <span className="block text-xs text-muted-foreground">per {METERS[id].unitLabel}</span>
                </td>
                <td className="py-2 pr-3">
                  <input name={`included_${id}`} inputMode="decimal" className="input" defaultValue={included[id] ?? ""} aria-label={`${METERS[id].label} included`} />
                </td>
                <td className="py-2">
                  <input name={`overage_${id}`} inputMode="decimal" className="input" defaultValue={rands(overage[id])} aria-label={`${METERS[id].label} price over`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {founding ? (
          <p className="text-xs text-muted-foreground">This is the founding workspace: it always uses its own AI and voice keys.</p>
        ) : (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="platformAi" defaultChecked={tenant.platformAi} className="mt-0.5" />
            <span>
              Platform supplies AI &amp; voice
              <span className="block text-xs text-muted-foreground">
                With no key of its own, this workspace uses yours (Anthropic and ElevenLabs). It never sees the key. Its own key,
                if it adds one, always wins. Usage is metered either way.
              </span>
            </span>
          </label>
        )}
        <SaveButton className="btn-primary btn-sm">Save plan</SaveButton>
      </SaveForm>

      <div className="card space-y-4 p-5">
        <h3 className="font-semibold">Invoices</h3>
        <SaveForm action={createTenantInvoiceAction.bind(null, tenantId)} success="Invoice created" className="flex flex-wrap items-end gap-2">
          <label className="block text-sm">
            Month
            <select name="period" className="input mt-1" defaultValue={lastMonth}>
              {monthsBack([1, 2, 3]).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <SaveButton pendingLabel="Creating…" className="btn-secondary btn-sm">Create invoice</SaveButton>
          <p className="w-full text-xs text-muted-foreground">
            A month can be invoiced once it has ended ({thisMonth} is still being counted).
          </p>
        </SaveForm>
        {invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <ul className="divide-y divide-border/50 text-sm">
            {invoices.map((invoice) => (
              <li key={invoice.id} className="flex flex-wrap items-center gap-3 py-2">
                <Link href={`/platform/invoices/${tenantId}/${invoice.id}`} className="font-medium text-primary hover:underline">
                  {invoiceNumber(invoice.number)}
                </Link>
                <span className="text-muted-foreground">{invoice.period}</span>
                <span className="tabular-nums">{formatZAR(invoice.totalCents)}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] uppercase">
                  {invoice.status}
                  {invoice.status === "paid" && invoice.paidAt ? ` ${formatDate(invoice.paidAt)}` : ""}
                </span>
                <span className="ml-auto flex gap-2">
                  {invoice.status === "issued" && (
                    <SaveForm action={markTenantInvoicePaidAction.bind(null, tenantId, invoice.id)} success="Marked paid">
                      <SaveButton pendingLabel="Saving…" className="btn-secondary btn-sm">Mark paid</SaveButton>
                    </SaveForm>
                  )}
                  {invoice.status !== "void" && (
                    <SaveForm action={voidTenantInvoiceAction.bind(null, tenantId, invoice.id)} success="Invoice voided">
                      <SaveButton pendingLabel="Voiding…" className="btn-secondary btn-sm">Void</SaveButton>
                    </SaveForm>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <SaveForm action={setInvoiceSettingsAction.bind(null, tenantId)} success="Invoice details saved" resetOnSuccess={false} className="card space-y-3 p-5">
        <div>
          <h3 className="font-semibold">Invoice from</h3>
          <p className="mt-1 text-xs text-muted-foreground">Printed at the top of every workspace&apos;s invoice: your business name, address, VAT number and bank details. Shared by all workspaces.</p>
        </div>
        <textarea name="fromText" rows={6} className="input" defaultValue={settings.fromText} />
        <label className="block text-sm">
          VAT rate (%)
          <input name="vatRatePct" inputMode="decimal" className="input mt-1 max-w-[8rem]" defaultValue={settings.vatRatePct} />
        </label>
        <SaveButton className="btn-secondary btn-sm">Save invoice details</SaveButton>
      </SaveForm>
    </div>
  );
}
