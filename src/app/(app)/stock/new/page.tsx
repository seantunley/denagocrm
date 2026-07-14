import Link from "next/link";
import { ArrowLeft, BadgeDollarSign, CircleCheck, PackageCheck, ScanLine } from "lucide-react";
import { addStockUnit } from "@/app/actions/stock";
import StockUnitForm from "@/components/StockUnitForm";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { SectionHeading, Surface } from "@/components/visual-system";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";

const stockJourney = [
  { icon: CircleCheck, label: "Available immediately", detail: "The unit enters live floor stock with its arrival time recorded." },
  { icon: ScanLine, label: "Ready to reserve", detail: "Sales can allocate the exact serialised unit to an open lead." },
  { icon: BadgeDollarSign, label: "Included in valuation", detail: "Acquisition cost supports inventory value and deal-margin reporting." },
];

export default async function NewStockUnitPage() {
  await requirePermission("stock.manage");
  const products = await prisma.product.findMany({
    where: { active: true },
    include: { colors: true },
    orderBy: { name: "asc" },
  });

  return (
    <div className="space-y-6">
      <Link href="/stock" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" />
        Back to stock
      </Link>
      <PageHeader
        title="Add a stock unit"
        description="Register one physical Denago unit already on the floor and make it available to the sales team."
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <StockUnitForm
          action={addStockUnit}
          products={products.map((product) => ({
            id: product.id,
            name: product.name,
            colors: product.colors.map((color) => color.name),
          }))}
          variant="page"
        />

        <aside className="space-y-4 xl:sticky xl:top-6">
          <Surface className="relative overflow-hidden p-5">
            <div className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-primary/10 blur-3xl" />
            <SectionHeading title="When you save" description="The unit becomes an operational stock record, not only a catalogue entry." />
            <ol className="relative mt-5 space-y-5 before:absolute before:bottom-5 before:left-[17px] before:top-5 before:w-px before:bg-border">
              {stockJourney.map(({ icon: Icon, label, detail }, index) => (
                <li key={label} className="relative flex gap-3">
                  <span className="relative z-10 grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground"><Icon className="size-4" /></span>
                  <div className="min-w-0 pt-0.5">
                    <p className="text-sm font-medium text-foreground">{index + 1}. {label}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Surface>
          <Surface className="p-5" inset>
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-xl border border-sky-400/20 bg-sky-400/10 text-sky-300"><PackageCheck className="size-4" /></span>
              <p className="text-sm font-semibold text-foreground">One physical unit</p>
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">Use Purchase order on the Stock page when you need to record multiple incoming units.</p>
          </Surface>
          <Link href="/stock" className={buttonVariants({ variant: "ghost", className: "w-full" })}>Cancel and return</Link>
        </aside>
      </div>
    </div>
  );
}
