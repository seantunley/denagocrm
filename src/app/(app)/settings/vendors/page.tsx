import { requireTenantOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { Surface } from "@/components/visual-system";
import ModalTrigger from "@/components/Modal";
import ConfirmDelete from "@/components/ConfirmDelete";
import { saveVendor, deleteVendor } from "@/app/actions/vendors";

export const dynamic = "force-dynamic";

function VendorFields({ vendor }: { vendor?: { name: string; phone: string | null; email: string | null; notes: string | null } }) {
  return (
    <>
      <div><label className="label">Name</label><input name="name" className="input" required maxLength={120} defaultValue={vendor?.name} placeholder="Denago, Cape Carts Transport, Wrap Studio" /></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label className="label">Phone</label><input name="phone" className="input" maxLength={40} defaultValue={vendor?.phone ?? ""} /></div>
        <div><label className="label">Email</label><input name="email" type="email" className="input" maxLength={160} defaultValue={vendor?.email ?? ""} /></div>
      </div>
      <div><label className="label">Notes</label><textarea name="notes" className="input min-h-16" maxLength={1000} defaultValue={vendor?.notes ?? ""} /></div>
    </>
  );
}

/**
 * The businesses the workspace buys from or pays — the OEM, a delivery company, a wrap shop (Sean, 2026-11-09).
 * A supplier document in a deal's file names one, and the deal file then asks for that supplier's quote, invoice
 * and proof of payment.
 */
export default async function VendorsSettingsPage() {
  await requireTenantOwner();
  const tenantId = await actingTenantId();
  const vendors = await prisma.vendor.findMany({
    where: { tenantId, deletedAt: null },
    orderBy: { name: "asc" },
    include: { _count: { select: { documents: { where: { deletedAt: null } } } } },
  });

  return (
    <SettingsWorkspace
      current="vendors"
      title="Suppliers"
      description="Who you buy from or pay on a deal — the OEM, the delivery company, a wrap shop. Upload a supplier quote, invoice or proof of payment with the supplier chosen, and the deal file checks each supplier has all three."
      groups={SETTINGS_NAV_GROUPS}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Surface className="p-4">
          <h2 className="font-semibold">{vendors.length} supplier{vendors.length === 1 ? "" : "s"}</h2>
          {vendors.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">None yet — add the first one.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border/70">
              {vendors.map((vendor) => (
                <li key={vendor.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{vendor.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[vendor.phone, vendor.email, `${vendor._count.documents} document${vendor._count.documents === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <ModalTrigger label="Edit" title={`Edit ${vendor.name}`} buttonClass="btn-secondary btn-sm">
                    <SaveForm action={saveVendor.bind(null, vendor.id)} success="Supplier saved" className="grid gap-3 p-4">
                      <VendorFields vendor={vendor} />
                      <SaveButton className="btn-primary btn-sm">Save</SaveButton>
                    </SaveForm>
                  </ModalTrigger>
                  <ConfirmDelete
                    action={deleteVendor.bind(null, vendor.id)}
                    title={`Delete supplier “${vendor.name}”?`}
                    description="It moves to the Trash and can be restored. Documents already filed keep naming it."
                    triggerClass="btn-secondary btn-sm text-red-300"
                  />
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
