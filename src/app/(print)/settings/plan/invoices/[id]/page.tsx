import { notFound } from "next/navigation";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { basePrisma } from "@/lib/db";
import PrintActions from "@/components/PrintActions";
import TenantInvoiceDocument, { billToFor } from "@/components/TenantInvoiceDocument";

export const dynamic = "force-dynamic";

/** One of this workspace's invoices, owner only, ready to print or save as PDF. */
export default async function WorkspaceInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  await requireTenantOwner();
  const tenantId = await getActiveTenantId();
  const { id } = await params;
  // The row's own tenantId is checked here, not just the caller's role: an owner of one workspace must
  // never open another workspace's invoice by its id.
  const invoice = tenantId ? await basePrisma.tenantInvoice.findFirst({ where: { id, tenantId } }) : null;
  if (!invoice) notFound();
  return (
    <>
      <PrintActions backHref="/settings/plan" backLabel="Back to Plan & billing" />
      <TenantInvoiceDocument invoice={invoice} billTo={await billToFor(invoice.tenantId)} />
    </>
  );
}
