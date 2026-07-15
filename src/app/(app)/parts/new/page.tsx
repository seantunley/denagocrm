import Link from "next/link";
import { ArrowLeft, BadgeDollarSign, BellRing, ClipboardCheck, PackageOpen } from "lucide-react";
import { createPart } from "@/app/actions/parts";
import PartForm from "@/components/PartForm";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { SectionHeading, Surface } from "@/components/visual-system";
import { requirePermission } from "@/lib/permissions";

const partJourney = [
  { icon: ClipboardCheck, label: "Available on job cards", detail: "Technicians can select the part and its selling price during workshop capture." },
  { icon: PackageOpen, label: "Opening balance recorded", detail: "The quantity becomes the starting point for stock adjustments." },
  { icon: BellRing, label: "Low-stock monitoring", detail: "A reorder threshold surfaces replenishment warnings before parts run out." },
];

export default async function NewPartPage() {
  await requirePermission("parts.manage");

  return (
    <div className="space-y-6">
      <Link href="/parts" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" />
        Back to parts
      </Link>
      <PageHeader
        title="Add a workshop part"
        description="Create a clear parts record with pricing, storage location, opening stock and replenishment controls."
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <PartForm action={createPart} variant="page" />

        <aside className="space-y-4 xl:sticky xl:top-6">
          <Surface className="relative overflow-hidden p-5">
            <div className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-primary/10 blur-3xl" />
            <SectionHeading title="How this part is used" description="One record supports workshop billing, stock control and purchasing decisions." />
            <ol className="relative mt-5 space-y-5 before:absolute before:bottom-5 before:left-[17px] before:top-5 before:w-px before:bg-border">
              {partJourney.map(({ icon: Icon, label, detail }, index) => (
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
              <span className="grid size-9 place-items-center rounded-xl border border-amber-400/20 bg-amber-400/10 text-amber-300"><BadgeDollarSign className="size-4" /></span>
              <p className="text-sm font-semibold text-foreground">Pricing stays editable</p>
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">Cost, selling price and stock levels can be refined later from Manage on the Parts page.</p>
          </Surface>
          <Link href="/parts" className={buttonVariants({ variant: "ghost", className: "w-full" })}>Cancel and return</Link>
        </aside>
      </div>
    </div>
  );
}
