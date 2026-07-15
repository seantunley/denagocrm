import { Plus, Pencil, Warehouse, Wrench } from "lucide-react";
import { requirePermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { getDefaultLabourRateCents } from "@/lib/workshop";
import { saveDefaultLabourRate, saveBay, deleteBay } from "@/app/actions/workshop";
import ConfirmDelete from "@/components/ConfirmDelete";
import ModalTrigger from "@/components/Modal";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
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

export default async function WorkshopSettingsPage() {
  await requirePermission("workshop.manage");
  const [rateCents, bays] = await Promise.all([
    getDefaultLabourRateCents(),
    prisma.workshopBay.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
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
    </div>
  );
}
