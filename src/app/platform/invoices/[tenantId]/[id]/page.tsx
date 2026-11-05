import { notFound } from "next/navigation";
import { basePrisma } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platformAuth";
import PrintActions from "@/components/PrintActions";
import TenantInvoiceDocument, { billToFor } from "@/components/TenantInvoiceDocument";

export const dynamic = "force-dynamic";

/** A workspace invoice as the platform sees it, ready to print or save as PDF. Outside the console shell. */
export default async function PlatformInvoicePage({ params }: { params: Promise<{ tenantId: string; id: string }> }) {
  await requirePlatformAdmin();
  const { tenantId, id } = await params;
  const invoice = await basePrisma.tenantInvoice.findFirst({ where: { id, tenantId } });
  if (!invoice) notFound();
  return (
    <div className="min-h-screen bg-white">
      <style>{`html, body { background:#ffffff !important; }`}</style>
      <PrintActions backHref={`/platform/tenants/${tenantId}`} backLabel="Back to workspace" />
      <TenantInvoiceDocument invoice={invoice} billTo={await billToFor(tenantId)} />
    </div>
  );
}
