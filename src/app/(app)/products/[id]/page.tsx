import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  updateProduct,
  addProductColor,
  deleteProductColor,
  deleteProduct,
} from "@/app/actions/products";
import ConfirmDelete from "@/components/ConfirmDelete";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { StatusPill } from "@/components/visual-system";
import { formatZAR } from "@/lib/format";

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const product = await prisma.product.findUnique({
    where: { id },
    include: { colors: true, _count: { select: { leads: true, vehicles: true } } },
  });
  if (!product) notFound();

  return (
    <EntityDetailShell
      backHref="/products"
      backLabel="Products"
      eyebrow="Product catalogue"
      title={product.name}
      status={<StatusPill tone={product.active ? "success" : "neutral"}>{product.active ? "Active" : "Inactive"}</StatusPill>}
      description={product.sku ? `SKU ${product.sku}` : "No SKU recorded"}
      facts={[
        { label: "Base price", value: formatZAR(product.basePriceCents) },
        { label: "Colours", value: product.colors.length },
        { label: "Open leads", value: product._count.leads },
        { label: "Vehicles", value: product._count.vehicles },
      ]}
      actions={<ConfirmDelete
          action={deleteProduct.bind(null, product.id)}
          title={`Delete product ${product.name}?`}
          description="The product moves to the Trash for 60 days. Existing leads and vehicles keep their link to it."
        />}
    >

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <form action={updateProduct.bind(null, product.id)} className="card space-y-4">
          <h2 className="font-semibold">Details</h2>
          <div>
            <label className="label">Model name *</label>
            <input name="name" className="input" required defaultValue={product.name} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">SKU</label>
              <input name="sku" className="input" defaultValue={product.sku ?? ""} />
            </div>
            <div>
              <label className="label">Category</label>
              <input name="category" className="input" defaultValue={product.category ?? ""} />
            </div>
          </div>
          <div>
            <label className="label">Base price (R)</label>
            <input
              name="basePrice"
              className="input"
              inputMode="decimal"
              defaultValue={product.basePriceCents ? String(product.basePriceCents / 100) : ""}
            />
          </div>
          <div>
            <label className="label">Description</label>
            <textarea
              name="description"
              className="input"
              rows={3}
              defaultValue={product.description ?? ""}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              name="active"
              id="active"
              defaultChecked={product.active}
              className="h-4 w-4"
            />
            <label htmlFor="active" className="text-sm text-slate-400">
              Active (available for new leads)
            </label>
          </div>
          <button className="btn-primary">Save changes</button>
        </form>

        <div className="card">
          <h2 className="font-semibold mb-4">Colours</h2>
          <ul className="space-y-2 mb-4">
            {product.colors.length === 0 && (
              <li className="text-sm text-slate-400">No colours defined.</li>
            )}
            {product.colors.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2">
                <span className="badge bg-slate-800 text-slate-300">{c.name}</span>
                <ConfirmDelete
                  action={deleteProductColor.bind(null, c.id, product.id)}
                  title={`Remove colour ${c.name}?`}
                  description="This cannot be undone."
                  trigger="✕"
                  triggerClass="text-xs text-slate-600 hover:text-red-500 cursor-pointer"
                />
              </li>
            ))}
          </ul>
          <form action={addProductColor.bind(null, product.id)} className="flex gap-2">
            <input name="name" className="input" placeholder="Add colour…" required />
            <button className="btn-secondary">Add</button>
          </form>
          <p className="text-xs text-slate-400 mt-3">
            Used by {product._count.leads} lead(s) and {product._count.vehicles} vehicle(s).
          </p>
        </div>
      </div>
    </EntityDetailShell>
  );
}
