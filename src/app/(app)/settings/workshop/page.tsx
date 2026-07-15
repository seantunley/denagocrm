import { Plus, Pencil, Warehouse, Wrench, Package } from "lucide-react";
import { requirePermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { getDefaultLabourRateCents } from "@/lib/workshop";
import {
  saveDefaultLabourRate,
  saveBay,
  deleteBay,
  savePackage,
  deletePackage,
  addPackageItem,
  deletePackageItem,
} from "@/app/actions/workshop";
import ConfirmDelete from "@/components/ConfirmDelete";
import ModalTrigger from "@/components/Modal";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { formatZAR } from "@/lib/format";
import { EmptyState, StatusPill } from "@/components/visual-system";

export const dynamic = "force-dynamic";

type Bay = { id: string; name: string; color: string; active: boolean; sortOrder: number; notes: string | null };

function BayForm({ bay }: { bay?: Bay }) {
  return (
    <form action={saveBay} className="card space-y-4">
      {bay && <input type="hidden" name="id" value={bay.id} />}
      <div>
        <label className="label" htmlFor="bay-name">Name</label>
        <input id="bay-name" name="name" className="input" required minLength={1} defaultValue={bay?.name} placeholder="Bay 1" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="bay-color">Colour</label>
          <input id="bay-color" type="color" name="color" className="input h-10 w-full p-1" defaultValue={bay?.color ?? "#0ea5e9"} />
        </div>
        <div>
          <label className="label" htmlFor="bay-order">Sort order</label>
          <input id="bay-order" type="number" name="sortOrder" className="input tabular-nums" defaultValue={bay?.sortOrder ?? 0} />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="bay-notes">Notes</label>
        <input id="bay-notes" name="notes" className="input" defaultValue={bay?.notes ?? ""} placeholder="Lift · alignment · diagnostics…" />
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" name="active" defaultChecked={bay ? bay.active : true} className="h-4 w-4" />
        Active (available for assignment)
      </label>
      <button className="btn-primary w-full">{bay ? "Save bay" : "Create bay"}</button>
    </form>
  );
}

function PackageForm({ pkg }: { pkg?: { id: string; name: string; description: string | null; active: boolean } }) {
  return (
    <form action={savePackage} className="card space-y-4">
      {pkg && <input type="hidden" name="id" value={pkg.id} />}
      <div>
        <label className="label" htmlFor="pkg-name">Name</label>
        <input id="pkg-name" name="name" required className="input" defaultValue={pkg?.name} placeholder="Minor service" />
      </div>
      <div>
        <label className="label" htmlFor="pkg-desc">Description</label>
        <input id="pkg-desc" name="description" className="input" defaultValue={pkg?.description ?? ""} placeholder="What's included" />
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" name="active" defaultChecked={pkg ? pkg.active : true} className="h-4 w-4" />
        Active (available to apply)
      </label>
      <button className="btn-primary w-full">{pkg ? "Save package" : "Create package"}</button>
    </form>
  );
}

export default async function WorkshopSettingsPage() {
  await requirePermission("workshop.manage");
  const [rateCents, bays, packages] = await Promise.all([
    getDefaultLabourRateCents(),
    prisma.workshopBay.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.servicePackage.findMany({ orderBy: { name: "asc" }, include: { items: true } }),
  ]);

  return (
    <div className="space-y-10">
      <PageHeader title="Workshop" description="Default labour rate and the physical bays jobs are scheduled into." />

      {/* Labour rate ───────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Wrench className="size-4 text-muted-foreground" />
          <h2 className="font-semibold tracking-tight">Default labour rate</h2>
        </div>
        <p className="text-sm text-slate-400">Used to value logged technician time. Individual job cards can override it.</p>
        <form action={saveDefaultLabourRate} className="card flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-48">
            <label className="label" htmlFor="labourRate">Rate per hour (R)</label>
            <input id="labourRate" name="labourRate" className="input tabular-nums" inputMode="decimal" defaultValue={(rateCents / 100).toFixed(2)} />
          </div>
          <button className="btn-primary">Save rate</button>
        </form>
      </section>

      {/* Bays ──────────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold tracking-tight">Workshop bays</h2>
            <p className="text-sm text-slate-400 mt-0.5">Assign job cards to a bay to see what each work area is doing.</p>
          </div>
          <ModalTrigger label={<><Plus className="size-4" />New bay</>} title="New bay" buttonClass={buttonVariants({ size: "sm" })}>
            <BayForm />
          </ModalTrigger>
        </div>
        {bays.length === 0 ? (
          <EmptyState icon={Warehouse} title="No bays yet" description="Create your first workshop bay to start scheduling jobs into it." />
        ) : (
          <div className="card p-0 divide-y divide-slate-800">
            {bays.map((bay) => (
              <div key={bay.id} className="flex items-center justify-between gap-3 p-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="inline-block size-3 shrink-0 rounded-full" style={{ backgroundColor: bay.color }} />
                  <div className="min-w-0">
                    <p className="font-medium truncate">{bay.name}</p>
                    {bay.notes && <p className="text-xs text-slate-500 truncate">{bay.notes}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <StatusPill tone={bay.active ? "success" : "neutral"}>{bay.active ? "Active" : "Inactive"}</StatusPill>
                  <ModalTrigger label={<><Pencil className="size-4" />Edit</>} title={`Edit ${bay.name}`} buttonClass={buttonVariants({ size: "sm", variant: "outline" })}>
                    <BayForm bay={bay} />
                  </ModalTrigger>
                  <ConfirmDelete action={deleteBay.bind(null, bay.id)} title={`Delete ${bay.name}?`} description="Job cards in this bay will be unassigned." triggerClass="text-red-400 text-sm" />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Service packages ──────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold tracking-tight">Service packages</h2>
            <p className="text-sm text-slate-400 mt-0.5">Preset bundles of parts &amp; labour that drop onto a job card in one click.</p>
          </div>
          <ModalTrigger label={<><Plus className="size-4" />New package</>} title="New service package" buttonClass={buttonVariants({ size: "sm" })}>
            <PackageForm />
          </ModalTrigger>
        </div>
        {packages.length === 0 ? (
          <EmptyState icon={Package} title="No packages yet" description="Create a bundle like “Minor service” to apply it in one click." />
        ) : (
          <div className="space-y-3">
            {packages.map((pkg) => {
              const total = pkg.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
              return (
                <div key={pkg.id} className="card space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <p className="font-medium truncate">{pkg.name}</p>
                      {!pkg.active && <StatusPill tone="neutral">Inactive</StatusPill>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-sm font-medium tabular-nums">{formatZAR(total)}</span>
                      <ModalTrigger label={<><Pencil className="size-4" />Edit</>} title={`Edit ${pkg.name}`} buttonClass={buttonVariants({ size: "sm", variant: "outline" })}>
                        <PackageForm pkg={pkg} />
                      </ModalTrigger>
                      <ConfirmDelete action={deletePackage.bind(null, pkg.id)} title={`Delete ${pkg.name}?`} description="Removes the package. Job cards keep any lines already added." triggerClass="text-red-400 text-sm" />
                    </div>
                  </div>
                  {pkg.items.length > 0 && (
                    <div className="divide-y divide-border text-sm">
                      {pkg.items.map((i) => (
                        <div key={i.id} className="flex items-center justify-between gap-3 py-1.5">
                          <span className="min-w-0 truncate text-muted-foreground"><span className="capitalize">{i.kind}</span> · {i.qty}× {i.description}</span>
                          <span className="flex items-center gap-2 shrink-0">
                            <span className="tabular-nums">{formatZAR(Math.round(i.qty * i.unitPriceCents))}</span>
                            <form action={deletePackageItem.bind(null, i.id)}><button className="text-xs text-slate-600 hover:text-red-500">✕</button></form>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  <form action={addPackageItem.bind(null, pkg.id)} className="flex flex-wrap items-end gap-2">
                    <select name="kind" defaultValue="part" className="input w-24">
                      <option value="part">Part</option>
                      <option value="labour">Labour</option>
                    </select>
                    <input name="description" required placeholder="Description" className="input flex-1 min-w-40" />
                    <input name="qty" type="number" min={0.5} step={0.5} defaultValue={1} className="input w-20 tabular-nums" />
                    <input name="unitPrice" inputMode="decimal" placeholder="Unit R" className="input w-24 tabular-nums" />
                    <button className="btn-secondary btn-sm">Add item</button>
                  </form>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
