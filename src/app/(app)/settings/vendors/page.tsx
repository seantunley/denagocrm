import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { requireTenantOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { StatusPill, Surface } from "@/components/visual-system";
import VendorFields from "@/components/VendorFields";
import { saveVendor } from "@/app/actions/vendors";
import { vendorKindLabel } from "@/lib/vendors";

export const dynamic = "force-dynamic";

/**
 * The businesses the workspace buys from or pays — the OEM, a delivery company, a wrap shop (Sean, 2026-11-09).
 * Deals declare them so their file asks for each one's quote, invoice and proof of payment; purchase orders name them.
 */
export default async function VendorsSettingsPage() {
  await requireTenantOwner();
  if (!(await isModuleEnabled("suppliers"))) notFound();
  const tenantId = await actingTenantId();
  const vendors = await prisma.vendor.findMany({
    where: { tenantId, deletedAt: null },
    orderBy: { name: "asc" },
    include: { _count: { select: { documents: { where: { deletedAt: null } }, deals: true, purchaseOrders: { where: { deletedAt: null } } } } },
  });

  return (
    <SettingsWorkspace
      current="vendors"
      title="Suppliers"
      description="Who you buy from or pay — the OEM, the delivery company, a wrap shop. Put them on a deal and its file asks for each one's quote, invoice and proof of payment. Purchase orders name them too."
      groups={SETTINGS_NAV_GROUPS}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <Surface className="p-4">
          <h2 className="font-semibold">{vendors.length} supplier{vendors.length === 1 ? "" : "s"}</h2>
          {vendors.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">None yet — add the first one.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border/70">
              {vendors.map((vendor) => (
                <li key={vendor.id}>
                  <Link href={`/settings/vendors/${vendor.id}`} className="flex flex-wrap items-center gap-3 rounded-lg px-1 py-2 text-sm hover:bg-muted/30">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{vendor.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {[
                          `${vendor._count.deals} deal${vendor._count.deals === 1 ? "" : "s"}`,
                          `${vendor._count.documents} document${vendor._count.documents === 1 ? "" : "s"}`,
                          `${vendor._count.purchaseOrders} purchase order${vendor._count.purchaseOrders === 1 ? "" : "s"}`,
                        ].join(" · ")}
                      </p>
                    </div>
                    <StatusPill tone="neutral">{vendorKindLabel(vendor.kind)}</StatusPill>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Surface>

        <Surface className="p-4">
          <h2 className="font-semibold">Add a supplier</h2>
          <SaveForm action={saveVendor.bind(null, null)} success="Supplier added" className="mt-3 grid gap-3">
            <VendorFields />
            <SaveButton className="btn-primary btn-sm">Add supplier</SaveButton>
          </SaveForm>
        </Surface>
      </div>
    </SettingsWorkspace>
  );
}
