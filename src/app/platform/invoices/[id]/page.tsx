import { notFound } from "next/navigation";
import { basePrisma } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platformAuth";
import PrintActions from "@/components/PrintActions";
import TenantInvoiceDocument, { billToFor } from "@/components/TenantInvoiceDocument";

export const dynamic = "force-dynamic";

/** A workspace invoice as the platform sees it, ready to print or save as PDF. Outside the console shell. */
export default async function PlatformInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePlatformAdmin();
  const { id } = await params;
  const invoice = await basePrisma.tenantInvoice.findUnique({ where: { id } });
  if (!invoice) notFound();
  return (
    <div className="min-h-screen bg-white">
      <style>{`html, body { background:#ffffff !important; }`}</style>
      <PrintActions backHref={`/platform/tenants/${invoice.tenantId}`} backLabel="Back to workspace" />
      <TenantInvoiceDocument invoice={invoice} billTo={await billToFor(invoice.tenantId)} />
    </div>
  );
}
