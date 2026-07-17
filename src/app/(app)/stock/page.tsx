import Link from "next/link";
import { PackagePlus, ShoppingCart } from "lucide-react";
import { prisma } from "@/lib/db";
import ModalTrigger from "@/components/Modal";
import StockUnitForm from "@/components/StockUnitForm";
import { formatZAR } from "@/lib/format";
import {
  createPurchaseOrder,
  receivePurchaseOrder,
  cancelPurchaseOrder,
  addStockUnit,
  updateStockUnit,
  reserveUnit,
  markUnitSold,
  deleteStockUnit,
  addStockStatus,
  removeStockStatus,
  setStockStatus,
} from "@/app/actions/stock";
import { getStockStatuses } from "@/lib/stockStatuses";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import { Settings2 } from "lucide-react";

/** Translucent pill background from a status hex colour (e.g. #34d399 -> #34d39926). */
const statusStyle = (color: string) => ({ backgroundColor: `${color}26`, color });

function ProductSelect({ products }: { products: { id: string; name: string }[] }) {
  return (
    <select name="productId" className="input" required defaultValue="">
      <option value="" disabled>Select model…</option>
      {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
    </select>
  );
}

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const statuses = await getStockStatuses();
  const statusMap = new Map(statuses.map((s) => [s.slug, s]));
  const labelOf = (slug: string) => statusMap.get(slug)?.label ?? slug;
  const colorOf = (slug: string) => statusMap.get(slug)?.color ?? "#64748b";
  const filterSlugs = ["all", ...statuses.map((s) => s.slug)];
  // Statuses a user can set by hand — reserving/selling go through their own flows.
  const assignable = statuses.filter((s) => s.slug !== "reserved" && s.slug !== "sold");
  const filter = filterSlugs.includes(status ?? "") ? status! : "all";

  const [products, leads, units, openPos, counts] = await Promise.all([
    prisma.product.findMany({ where: { active: true }, orderBy: { name: "asc" }, include: { colors: true } }),
    prisma.lead.findMany({ where: { status: "open" }, orderBy: { createdAt: "desc" }, take: 300 }),
    prisma.stockUnit.findMany({
      where: filter === "all" ? {} : { status: filter },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      include: { product: true, reservedForLead: true, purchaseOrder: true },
    }),
    prisma.purchaseOrder.findMany({
      where: { status: "ordered" },
      orderBy: { orderedAt: "asc" },
      include: { _count: { select: { units: true } }, units: { take: 1, include: { product: true } } },
    }),
    prisma.stockUnit.groupBy({ by: ["status"], _count: true }),
  ]);

  const countOf = (s: string) => counts.find((c) => c.status === s)?._count ?? 0;
  return (
    <div className="space-y-5">
      <PageHeader title="Stock" description={`${countOf("available")} available · ${countOf("incoming")} incoming · ${countOf("reserved")} reserved`}>
          <ModalTrigger label={<><ShoppingCart className="size-4" />Purchase order</>} title="New purchase order" buttonClass={buttonVariants({ size: "sm" })}>
            <form action={createPurchaseOrder} className="card space-y-3">
              <p className="text-sm text-slate-400">
                Records carts on order. They arrive as <b>On order</b> stock; mark the order
                received to move them to <b>Available</b>.
              </p>
              <div>
                <label className="label">Model *</label>
                <ProductSelect products={products} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Colour</label>
                  <input name="color" className="input" placeholder="e.g. Matte black" />
                </div>
                <div>
                  <label className="label">Quantity *</label>
                  <input name="qty" type="number" min="1" defaultValue="1" className="input" required />
                </div>
                <div>
                  <label className="label">Unit cost (R)</label>
                  <input name="cost" className="input" placeholder="0.00" />
                </div>
                <div>
                  <label className="label">Expected date</label>
                  <input name="expectedAt" type="date" className="input" />
                </div>
                <div>
                  <label className="label">Supplier</label>
                  <input name="supplier" className="input" defaultValue="Denago" />
                </div>
                <div>
                  <label className="label">Order ref</label>
                  <input name="reference" className="input" placeholder="Supplier PO no." />
                </div>
              </div>
              <div>
                <label className="label">Notes</label>
                <input name="notes" className="input" />
              </div>
              <button className="btn-primary">Create order</button>
            </form>
          </ModalTrigger>
          <ModalTrigger label={<><PackagePlus className="size-4" />Add unit</>} title="Add stock unit" buttonClass={buttonVariants({ variant: "outline", size: "sm" })}>
            <StockUnitForm
              action={addStockUnit}
              products={products.map((product) => ({
                id: product.id,
                name: product.name,
                colors: product.colors.map((color) => color.name),
              }))}
              variant="dialog"
            />
          </ModalTrigger>
          <ModalTrigger label={<><Settings2 className="size-4" />Statuses</>} title="Stock statuses" buttonClass={buttonVariants({ variant: "outline", size: "sm" })}>
            <div className="space-y-4">
              <div className="card space-y-2">
                <p className="text-sm font-semibold">Current statuses</p>
                <ul className="divide-y divide-slate-800">
                  {statuses.map((s) => (
                    <li key={s.slug} className="flex items-center gap-2 py-2">
                      <span className="badge" style={statusStyle(s.color)}>{s.label}</span>
                      {s.system ? (
                        <span className="ml-auto text-[11px] text-slate-500">Built-in · locked</span>
                      ) : (
                        <form action={removeStockStatus.bind(null, s.slug)} className="ml-auto">
                          <button className="btn-danger btn-sm">Remove</button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] text-slate-500">
                  The four built-in statuses drive receiving, reserving and selling, so they can&apos;t be removed.
                  Removing a custom status moves any units on it back to <b>Available</b>.
                </p>
              </div>
              <form action={addStockStatus} className="card space-y-3">
                <p className="text-sm font-semibold">Add a status</p>
                <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
                  <div>
                    <label className="label">Name</label>
                    <input name="label" className="input" placeholder="e.g. In transit, Damaged, Demo" required />
                  </div>
                  <div>
                    <label className="label">Colour</label>
                    <input name="color" type="color" defaultValue="#64748b" className="input h-10 w-16 p-1" />
                  </div>
                </div>
                <button className="btn-primary btn-sm">Add status</button>
              </form>
            </div>
          </ModalTrigger>
      </PageHeader>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(["available", "incoming", "reserved", "sold"] as const).map((s) => (
          <Link
            key={s}
            href={`/stock?status=${s}`}
            className="card p-4 hover:border-slate-700 transition-colors"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {labelOf(s)}
            </p>
            <p className="text-2xl font-semibold tracking-[-0.035em] mt-1">{countOf(s)}</p>
          </Link>
        ))}
      </div>

      {/* Open purchase orders */}
      {openPos.length > 0 && (
        <div className="card p-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 px-4 pt-4">
            On order
          </p>
          <ul className="divide-y divide-slate-800 mt-2">
            {openPos.map((po) => (
              <li key={po.id} className="px-4 py-3 flex items-center gap-3 flex-wrap">
                <span className="text-sm flex-1 min-w-0">
                  <b>{po._count.units}×</b> {po.units[0]?.product.name ?? "unit"}
                  {po.reference ? ` · ${po.reference}` : ""}
                  {po.expectedAt ? (
                    <span className="text-slate-400">
                      {" "}· expected {po.expectedAt.toLocaleDateString("en-ZA")}
                    </span>
                  ) : null}
                </span>
                <form action={receivePurchaseOrder.bind(null, po.id)}>
                  <button className="btn-primary btn-sm">Mark received</button>
                </form>
                <form action={cancelPurchaseOrder.bind(null, po.id)}>
                  <button className="btn-secondary btn-sm">Cancel</button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Filter chips */}
      <div className="flex gap-2 flex-wrap">
        {filterSlugs.map((f) => (
          <Link
            key={f}
            href={f === "all" ? "/stock" : `/stock?status=${f}`}
            className={`badge ${
              filter === f ? "bg-orange-600 text-white" : "bg-slate-800 text-slate-300"
            }`}
          >
            {f === "all" ? "All" : labelOf(f)}
          </Link>
        ))}
      </div>

      {/* Units table */}
      <ResponsiveEntityTable>
        <table className="table-base">
          <thead>
            <tr>
              <th>Model</th>
              <th>Colour</th>
              <th>Serial / VIN</th>
              <th>Status</th>
              <th>Reserved / sold for</th>
              <th>Cost</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {units.length === 0 && (
              <tr>
                <td data-empty colSpan={7} className="text-center text-slate-400 py-8">
                  No stock here yet.
                </td>
              </tr>
            )}
            {units.map((u) => (
              <tr key={u.id}>
                <td data-primary data-label="Model" className="font-medium">{u.product.name}</td>
                <td data-label="Colour">{u.color ?? "—"}</td>
                <td data-label="Serial / VIN" className="text-slate-400">{u.serial ?? "—"}</td>
                <td data-label="Status">
                  <span className="badge" style={statusStyle(colorOf(u.status))}>{labelOf(u.status)}</span>
                </td>
                <td data-label="Reserved / sold for" className="text-slate-400">
                  {u.reservedForLead ? (
                    <Link href={`/leads/${u.reservedForLead.id}`} className="text-orange-400 hover:underline">
                      {u.reservedForLead.name}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td data-label="Cost">{u.costCents ? formatZAR(u.costCents) : "—"}</td>
                <td data-actions className="text-right">
                  <ModalTrigger label="Manage" title={`${u.product.name}${u.serial ? ` · ${u.serial}` : ""}`} buttonClass="btn-secondary btn-sm">
                    <div className="space-y-4">
                      <form action={updateStockUnit.bind(null, u.id)} className="card space-y-3">
                        <p className="font-semibold text-sm">Details</p>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="label">Serial / VIN</label>
                            <input name="serial" className="input" defaultValue={u.serial ?? ""} />
                          </div>
                          <div>
                            <label className="label">Colour</label>
                            <input name="color" className="input" defaultValue={u.color ?? ""} />
                          </div>
                          <div>
                            <label className="label">Cost (R)</label>
                            <input name="cost" className="input" defaultValue={u.costCents ? (u.costCents / 100).toFixed(2) : ""} />
                          </div>
                          <div>
                            <label className="label">Notes</label>
                            <input name="notes" className="input" defaultValue={u.notes ?? ""} />
                          </div>
                        </div>
                        <button className="btn-secondary btn-sm">Save details</button>
                      </form>

                      {u.status !== "sold" && (
                        <form action={reserveUnit.bind(null, u.id)} className="card space-y-2">
                          <p className="font-semibold text-sm">Reserve for a lead</p>
                          <select name="leadId" className="input" required defaultValue="">
                            <option value="" disabled>
                              Select lead…
                            </option>
                            {leads.map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.title} — {l.name}
                              </option>
                            ))}
                          </select>
                          <button className="btn-primary btn-sm">Reserve</button>
                        </form>
                      )}

                      <div className="card space-y-3">
                        <p className="font-semibold text-sm">Status</p>
                        <div className="flex gap-2 flex-wrap">
                          {u.status !== "sold" && (
                            <form action={markUnitSold.bind(null, u.id)}>
                              <button className="btn bg-emerald-700 text-white hover:bg-emerald-600 btn-sm">
                                Mark sold
                              </button>
                            </form>
                          )}
                          <form action={deleteStockUnit.bind(null, u.id)}>
                            <button className="btn-danger btn-sm">Remove</button>
                          </form>
                        </div>
                        {/* Set any organizational status (reserving / selling use their own flows above). */}
                        <form action={setStockStatus.bind(null, u.id)} className="flex items-end gap-2">
                          <div className="flex-1">
                            <label className="label">Set status</label>
                            <select name="status" className="input" defaultValue={assignable.some((s) => s.slug === u.status) ? u.status : "available"}>
                              {assignable.map((s) => (
                                <option key={s.slug} value={s.slug}>{s.label}</option>
                              ))}
                            </select>
                          </div>
                          <button className="btn-secondary btn-sm">Apply</button>
                        </form>
                      </div>
                    </div>
                  </ModalTrigger>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveEntityTable>
    </div>
  );
}
