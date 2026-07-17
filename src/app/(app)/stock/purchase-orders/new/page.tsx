import Link from "next/link";
import { ArrowLeft, CircleDollarSign, PackageCheck, ShoppingCart, Truck } from "lucide-react";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { createPurchaseOrder } from "@/app/actions/stock";
import PurchaseOrderBuilder from "@/components/PurchaseOrderBuilder";
import { PageHeader } from "@/components/page-header";
import { SectionHeading, Surface } from "@/components/visual-system";

export default async function NewPurchaseOrderPage() {
  await requirePermission("stock.manage");
  const products = await prisma.product.findMany({
    where: { active: true, deletedAt: null },
    include: { colors: true },
    orderBy: { name: "asc" },
  });

  return (
    <div className="denago-workspace space-y-6">
      <Link href="/stock/purchase-orders" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" /> Back to purchase orders
      </Link>
      <PageHeader title="New purchase order" description="Create a multi-line supplier order with expected landed-cost inputs and independent receipt tracking." />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <PurchaseOrderBuilder
          action={createPurchaseOrder}
          products={products.map((product) => ({
            id: product.id,
            name: product.name,
            colors: product.colors.map((color) => color.name),
          }))}
        />
        <aside className="space-y-4 xl:sticky xl:top-6">
          <Surface className="p-5">
            <SectionHeading title="Controlled purchasing" description="The order records commercial intent; stock units only become live inventory when physically received." />
            <ol className="mt-5 space-y-4">
              {[
                [ShoppingCart, "Build the order", "Add every model and colour with its quantity and unit cost."],
                [Truck, "Track supplier progress", "Confirm, mark in transit and update expected arrival dates."],
                [PackageCheck, "Receive actual units", "Partial receipts create only the physical units that arrived."],
                [CircleDollarSign, "Calculate landed cost", "Freight, duties and receiving overhead flow into unit valuation."],
              ].map(([Icon, title, detail], index) => (
                <li key={String(title)} className="flex gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-muted/40 text-muted-foreground"><Icon className="size-4" /></span>
                  <div><p className="text-sm font-medium text-foreground">{index + 1}. {String(title)}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{String(detail)}</p></div>
                </li>
              ))}
            </ol>
          </Surface>
          <Surface className="border-sky-400/20 bg-sky-400/5 p-5">
            <p className="text-sm font-semibold text-sky-100">Legacy orders remain supported</p>
            <p className="mt-2 text-xs leading-5 text-sky-100/70">Existing purchase orders that already contain incoming unit placeholders can still be received through the upgraded workflow.</p>
          </Surface>
        </aside>
      </div>
    </div>
  );
}
