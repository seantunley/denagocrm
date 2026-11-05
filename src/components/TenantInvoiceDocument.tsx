import type { TenantInvoice } from "@prisma/client";
import { formatDate, formatZAR } from "@/lib/format";
import { invoiceNumber, type InvoiceLine } from "@/lib/usageMeters";

/** One platform → workspace invoice on white paper. Used by the platform console and the workspace's own Plan page. */
export default function TenantInvoiceDocument({ invoice, billTo }: { invoice: TenantInvoice; billTo: string }) {
  const lines = (Array.isArray(invoice.lines) ? invoice.lines : []) as unknown as InvoiceLine[];
  return (
    <div className="mx-auto w-full max-w-3xl p-8 text-sm text-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <p className="whitespace-pre-line text-slate-700">{invoice.fromText}</p>
        <div className="text-right">
          <h1 className="text-2xl font-semibold">Tax invoice</h1>
          <p className="mt-1 font-medium">{invoiceNumber(invoice.number)}</p>
          <p className="text-slate-600">Issued {formatDate(invoice.issuedAt)}</p>
          <p className="text-slate-600">For {invoice.period}</p>
          {invoice.status !== "issued" && (
            <p className={invoice.status === "void" ? "mt-1 font-semibold text-red-600" : "mt-1 font-semibold text-emerald-700"}>
              {invoice.status === "void" ? "VOID" : `PAID ${invoice.paidAt ? formatDate(invoice.paidAt) : ""}`}
            </p>
          )}
        </div>
      </div>
      <div className="mt-8">
        <p className="text-xs uppercase tracking-wide text-slate-500">Bill to</p>
        <p className="whitespace-pre-line">{billTo}</p>
      </div>
      <table className="mt-8 w-full">
        <thead>
          <tr className="border-b border-slate-300 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2">Description</th>
            <th className="py-2 text-right">Qty</th>
            <th className="py-2 text-right">Unit</th>
            <th className="py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {lines.map((line, i) => (
            <tr key={i}>
              <td className="py-2 pr-3">{line.label}</td>
              <td className="py-2 text-right tabular-nums">{line.quantity}</td>
              <td className="py-2 text-right tabular-nums">{formatZAR(line.unitCents)}</td>
              <td className="py-2 text-right tabular-nums">{formatZAR(line.totalCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ml-auto mt-4 w-64 space-y-1 tabular-nums">
        <p className="flex justify-between"><span>Subtotal</span><span>{formatZAR(invoice.subtotalCents)}</span></p>
        <p className="flex justify-between"><span>VAT ({invoice.vatRatePct}%)</span><span>{formatZAR(invoice.vatCents)}</span></p>
        <p className="flex justify-between border-t border-slate-300 pt-1 font-semibold"><span>Total</span><span>{formatZAR(invoice.totalCents)}</span></p>
      </div>
    </div>
  );
}

/** The workspace's name and, when its Company profile has one, its address — for "Bill to". */
export async function billToFor(tenantId: string): Promise<string> {
  const { basePrisma } = await import("@/lib/db");
  const [tenant, address] = await Promise.all([
    basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, brandDisplayName: true } }),
    basePrisma.appSetting.findUnique({ where: { tenantId_key: { tenantId, key: "COMPANY_ADDRESS" } }, select: { value: true } }),
  ]);
  return [tenant?.brandDisplayName || tenant?.name || "", address?.value ?? ""].filter(Boolean).join("\n");
}
