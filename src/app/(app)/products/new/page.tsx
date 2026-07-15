import Link from "next/link";
import { ArrowLeft, BadgeDollarSign, ClipboardList, PackageCheck, Palette } from "lucide-react";
import ProductForm from "@/components/ProductForm";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { SectionHeading, Surface } from "@/components/visual-system";
import { requireOwner } from "@/lib/auth";

const productJourney = [
  { icon: ClipboardList, label: "Available to sales", detail: "The model appears in lead and quote product selection immediately." },
  { icon: Palette, label: "Choices stay controlled", detail: "Configured colours become consistent selectable preferences instead of free text." },
  { icon: PackageCheck, label: "Ready for stock intake", detail: "Physical units can be registered against the correct catalogue model." },
];

export default async function NewProductPage() {
  await requireOwner();

  return (
    <div className="space-y-6">
      <Link href="/products" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" />
        Back to product catalogue
      </Link>
      <PageHeader
        title="Add a catalogue product"
        description="Create the shared model record used across sales, stock, quotes and registered customer vehicles."
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <ProductForm variant="page" />

        <aside className="space-y-4 xl:sticky xl:top-6">
          <Surface className="relative overflow-hidden p-5">
            <div className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-primary/10 blur-3xl" />
            <SectionHeading title="One model, every workflow" description="Catalogue quality prevents duplicate names and inconsistent customer choices downstream." />
            <ol className="relative mt-5 space-y-5 before:absolute before:bottom-5 before:left-[17px] before:top-5 before:w-px before:bg-border">
              {productJourney.map(({ icon: Icon, label, detail }, index) => (
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
              <span className="grid size-9 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary"><BadgeDollarSign className="size-4" /></span>
              <p className="text-sm font-semibold text-foreground">Defaults, not restrictions</p>
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">Base price starts a quote quickly while individual deal pricing remains editable.</p>
          </Surface>
          <Link href="/products" className={buttonVariants({ variant: "ghost", className: "w-full" })}>Cancel and return</Link>
        </aside>
      </div>
    </div>
  );
}
