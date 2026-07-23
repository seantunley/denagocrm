import Link from "next/link";
import { Boxes, Plus } from "lucide-react";
import { prisma } from "@/lib/db";
import ModalTrigger from "@/components/Modal";
import ProductForm from "@/components/ProductForm";
import { formatZAR } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import {
  MobileDataCard,
  MobileDataField,
  MobileDataFields,
  MobileDataHeader,
  MobileDataList,
  ResponsiveDataView,
} from "@/components/responsive-patterns";
import { EmptyState, StatusPill } from "@/components/visual-system";
import RecordContextMenu from "@/components/RecordContextMenu";

export default async function ProductsPage() {
  const products = await prisma.product.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { colors: true, _count: { select: { leads: true, vehicles: true } } },
  });

  return (
    <div className="space-y-5">
      <PageHeader title="Product catalogue" description={`${products.filter((product) => product.active).length} active Denago models`}>
        <ModalTrigger label={<><Plus className="size-4" />New product</>} title="New product" buttonClass={buttonVariants({ size: "sm" })}>
          <ProductForm variant="dialog" />
        </ModalTrigger>
      </PageHeader>

      {products.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="Your catalogue is ready for its first model"
          description="Add the Denago models your team sells so stock, quotes, leads and customer vehicles all use the same product data."
          action={<Link href="/products/new" className={buttonVariants({ size: "sm" })}><Plus className="size-4" />Add first product</Link>}
        />
      ) : (
        <ResponsiveDataView
          mobile={
            <MobileDataList>
              {products.map((product) => (
                <RecordContextMenu key={product.id} label={product.name} href={`/products/${product.id}`}>
                <MobileDataCard>
                  <MobileDataHeader
                    title={<Link href={`/products/${product.id}`} className="text-primary hover:underline">{product.name}</Link>}
                    detail={product.sku || product.category || "Catalogue product"}
                    aside={<StatusPill tone={product.active ? "success" : "neutral"}>{product.active ? "Active" : "Archived"}</StatusPill>}
                  />
                  <MobileDataFields>
                    <MobileDataField label="Base price">{product.basePriceCents ? formatZAR(product.basePriceCents) : "Not set"}</MobileDataField>
                    <MobileDataField label="Usage">{product._count.leads} leads · {product._count.vehicles} vehicles</MobileDataField>
                    <MobileDataField label="Colours" wide>{product.colors.length ? product.colors.map((color) => color.name).join(", ") : "No choices configured"}</MobileDataField>
                  </MobileDataFields>
                </MobileDataCard>
                </RecordContextMenu>
              ))}
            </MobileDataList>
          }
          desktop={
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
            {products.map((p) => (
              <RecordContextMenu key={p.id} label={p.name} href={`/products/${p.id}`}>
              <tr tabIndex={0} className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
                <td>
                  <Link href={`/products/${p.id}`} className="font-medium text-primary hover:underline">
                    {p.name}
                  </Link>
                  {p.sku && <span className="text-xs text-muted-foreground ml-2">{p.sku}</span>}
                </td>
                <td>{p.category ?? "—"}</td>
                <td>
                  <div className="flex gap-1 flex-wrap">
                    {p.colors.map((c) => (
                      <span key={c.id} className="badge bg-muted text-muted-foreground">
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
                  <StatusPill tone={p.active ? "success" : "neutral"}>{p.active ? "Active" : "Archived"}</StatusPill>
                </td>
              </tr>
              </RecordContextMenu>
            ))}
          </tbody>
              </table>
            </div>
          }
        />
      )}
    </div>
  );
}
