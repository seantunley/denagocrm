import Link from "next/link";
import { prisma } from "@/lib/db";
import ModalTrigger from "@/components/Modal";
import ProductForm from "@/components/ProductForm";
import { formatZAR } from "@/lib/format";

export default async function ProductsPage() {
  const products = await prisma.product.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { colors: true, _count: { select: { leads: true, vehicles: true } } },
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Products</h1>
        <ModalTrigger label="+ New product" title="New product">
          <ProductForm />
        </ModalTrigger>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Model</th>
              <th>Category</th>
              <th>Colours</th>
              <th>Base price</th>
              <th>Leads</th>
              <th>Vehicles</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {products.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-slate-400 py-8">
                  No products yet — add your Denago models.
                </td>
              </tr>
            )}
            {products.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link href={`/products/${p.id}`} className="font-medium text-orange-400 hover:underline">
                    {p.name}
                  </Link>
                  {p.sku && <span className="text-xs text-slate-400 ml-2">{p.sku}</span>}
                </td>
                <td>{p.category ?? "—"}</td>
                <td>
                  <div className="flex gap-1 flex-wrap">
                    {p.colors.map((c) => (
                      <span key={c.id} className="badge bg-slate-800 text-slate-400">
                        {c.name}
                      </span>
                    ))}
                    {p.colors.length === 0 && "—"}
                  </div>
                </td>
                <td>{p.basePriceCents ? formatZAR(p.basePriceCents) : "—"}</td>
                <td>{p._count.leads}</td>
                <td>{p._count.vehicles}</td>
                <td>
                  <span
                    className={`badge ${
                      p.active
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-slate-800 text-slate-400"
                    }`}
                  >
                    {p.active ? "Active" : "Archived"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
