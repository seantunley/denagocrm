import { prisma } from "@/lib/db";
import { Plus } from "lucide-react";
import ModalTrigger from "@/components/Modal";
import PartForm from "@/components/PartForm";
import { formatZAR } from "@/lib/format";
import { createPart, updatePart, adjustPartStock, deletePart } from "@/app/actions/parts";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";

function PartFields({ p }: { p?: { name: string; sku: string | null; priceCents: number; costCents: number; reorderAt: number | null; location: string | null; notes: string | null; stockQty?: number } }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="label">Name *</label>
          <input name="name" className="input" required defaultValue={p?.name ?? ""} />
        </div>
        <div>
          <label className="label">SKU / code</label>
          <input name="sku" className="input" defaultValue={p?.sku ?? ""} />
        </div>
        <div>
          <label className="label">Location</label>
          <input name="location" className="input" defaultValue={p?.location ?? ""} placeholder="Shelf / bin" />
        </div>
        <div>
          <label className="label">Sell price (R)</label>
          <input name="price" className="input" defaultValue={p ? (p.priceCents / 100).toFixed(2) : ""} />
        </div>
        <div>
          <label className="label">Cost (R)</label>
          <input name="cost" className="input" defaultValue={p ? (p.costCents / 100).toFixed(2) : ""} />
        </div>
        {p === undefined && (
          <div>
            <label className="label">Opening stock</label>
            <input name="stockQty" type="number" className="input" defaultValue="0" />
          </div>
        )}
        <div>
          <label className="label">Reorder at</label>
          <input name="reorderAt" type="number" className="input" defaultValue={p?.reorderAt ?? ""} placeholder="Low-stock alert" />
        </div>
        <div className="col-span-2">
          <label className="label">Notes</label>
          <input name="notes" className="input" defaultValue={p?.notes ?? ""} />
        </div>
      </div>
    </>
  );
}

export default async function PartsPage() {
  const parts = await prisma.part.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
  });
  const lowCount = parts.filter((p) => p.reorderAt != null && p.stockQty <= p.reorderAt).length;

  return (
    <div className="space-y-5">
      <PageHeader title="Parts" description={lowCount > 0 ? `${lowCount} part${lowCount === 1 ? "" : "s"} at or below reorder level` : "Workshop parts inventory is healthy."}>
        <ModalTrigger label={<><Plus className="size-4" />New part</>} title="New part" buttonClass={buttonVariants({ size: "sm" })}>
          <PartForm action={createPart} variant="dialog" />
        </ModalTrigger>
      </PageHeader>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Part</th>
              <th>SKU</th>
              <th>Location</th>
              <th className="text-right">In stock</th>
              <th className="text-right">Sell</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {parts.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-400 py-8">
                  No parts yet — add the parts you keep on hand.
                </td>
              </tr>
            )}
            {parts.map((p) => {
              const low = p.reorderAt != null && p.stockQty <= p.reorderAt;
              return (
                <tr key={p.id}>
                  <td className="font-medium">{p.name}</td>
                  <td className="text-slate-400">{p.sku ?? "—"}</td>
                  <td className="text-slate-400">{p.location ?? "—"}</td>
                  <td className="text-right">
                    <span className={low ? "text-amber-400 font-semibold" : ""}>{p.stockQty}</span>
                    {low && <span title="At/below reorder level"> ⚠</span>}
                  </td>
                  <td className="text-right">{formatZAR(p.priceCents)}</td>
                  <td className="text-right">
                    <ModalTrigger label="Manage" title={p.name} buttonClass="btn-secondary btn-sm">
                      <div className="space-y-4">
                        <form action={adjustPartStock.bind(null, p.id)} className="card space-y-2">
                          <p className="font-semibold text-sm">Adjust stock (now {p.stockQty})</p>
                          <div className="flex items-end gap-2">
                            <div className="flex-1">
                              <label className="label">Change (+ received, − correction)</label>
                              <input name="delta" type="number" className="input" placeholder="e.g. 10 or -1" />
                            </div>
                            <button className="btn-primary btn-sm">Apply</button>
                          </div>
                        </form>
                        <form action={updatePart.bind(null, p.id)} className="card space-y-3">
                          <p className="font-semibold text-sm">Details</p>
                          <PartFields p={p} />
                          <button className="btn-secondary btn-sm">Save</button>
                        </form>
                        <form action={deletePart.bind(null, p.id)}>
                          <button className="btn-danger btn-sm">Remove part</button>
                        </form>
                      </div>
                    </ModalTrigger>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
