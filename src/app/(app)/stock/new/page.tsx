import Link from "next/link";
import { ArrowLeft, BadgeDollarSign, CircleCheck, PackageCheck, ScanLine } from "lucide-react";
import { addStockUnit } from "@/app/actions/stock";
import StockUnitForm from "@/components/StockUnitForm";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { SectionHeading, Surface } from "@/components/visual-system";
import { prisma } from "@/lib/db";
import { getStockLocations } from "@/lib/stockPlatform";
import { requirePermission } from "@/lib/permissions";

const stockJourney = [
  { icon: CircleCheck, label: "Available immediately", detail: "The unit enters live floor stock with an arrival movement and location." },
  { icon: ScanLine, label: "Controlled identity", detail: "A unique internal stock number is generated and duplicate active serials are blocked." },
  { icon: BadgeDollarSign, label: "Included in valuation", detail: "Landed cost supports inventory value, ageing and actual deal-margin reporting." },
];

export default async function NewStockUnitPage() {
  await requirePermission("stock.manage");
  const [products, locations] = await Promise.all([
    prisma.product.findMany({
      where: { active: true, deletedAt: null },
      include: { colors: true },
      orderBy: { name: "asc" },
    }),
    getStockLocations(),
  ]);

  return (
    <div className="denago-workspace space-y-6">
      <Link href="/stock" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" /> Back to stock
      </Link>
      <PageHeader
        title="Add a stock unit"
        description="Register one physical Denago unit already on the floor and place it into the controlled inventory workflow."
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <StockUnitForm
          action={addStockUnit}
          products={products.map((product) => ({
            id: product.id,
            name: product.name,
            colors: product.colors.map((color) => color.name),
          }))}
          locations={locations.map((location) => ({
            id: location.id,
            name: location.name,
            type: location.type,
            isDefault: location.isDefault,
          }))}
          variant="page"
        />

        <aside className="space-y-4 xl:sticky xl:top-6">
          <Surface className="relative overflow-hidden p-5">
            <div className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-primary/10 blur-3xl" />
            <SectionHeading title="When you save" description="The record becomes operational stock, not only a catalogue entry." />
            <ol className="relative mt-5 space-y-5 before:absolute before:bottom-5 before:left-[17px] before:top-5 before:w-px before:bg-border">
              {stockJourney.map(({ icon: Icon, label, detail }, index) => (
                <li key={label} className="relative flex gap-3">
                  <span className="relative z-10 grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground"><Icon className="size-4" /></span>
                  <div className="min-w-0 pt-0.5"><p className="text-sm font-medium text-foreground">{index + 1}. {label}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p></div>
                </li>
              ))}
            </ol>
          </Surface>
          <Surface className="p-5" inset>
            <div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-xl border border-sky-400/20 bg-sky-400/10 text-sky-300"><PackageCheck className="size-4" /></span><p className="text-sm font-semibold text-foreground">One physical unit</p></div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">Use Purchase orders when recording supplier orders, partial deliveries or multiple models.</p>
            <Link href="/stock/purchase-orders/new" className={buttonVariants({ variant: "outline", size: "sm", className: "mt-4 w-full" })}>Create purchase order</Link>
          </Surface>
          <Link href="/stock" className={buttonVariants({ variant: "ghost", className: "w-full" })}>Cancel and return</Link>
        </aside>
      </div>
    </div>
  );
}
