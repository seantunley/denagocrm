import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  CircleDollarSign,
  Clock3,
  ContactRound,
  Gauge,
} from "lucide-react";
import { createLead } from "@/app/actions/leads";
import LeadForm from "@/components/LeadForm";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { SectionHeading, Surface } from "@/components/visual-system";
import { prisma } from "@/lib/db";
import { contactName } from "@/lib/format";
import { requirePermission } from "@/lib/permissions";

const leadJourney = [
  { icon: ContactRound, label: "One customer timeline", detail: "An existing contact is linked, or a new profile is created automatically." },
  { icon: Gauge, label: "Visible in the pipeline", detail: "The opportunity appears immediately in the selected sales stage." },
  { icon: Clock3, label: "Ready for a next action", detail: "The owner can schedule a call, test drive or follow-up from the lead." },
];

export default async function NewLeadPage() {
  await requirePermission("leads.create");
  const [products, stages, contacts, users] = await Promise.all([
    prisma.product.findMany({
      where: { active: true },
      include: { colors: true },
      orderBy: { name: "asc" },
    }),
    prisma.pipelineStage.findMany({ orderBy: { order: "asc" } }),
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
    prisma.user.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="space-y-6">
      <Link
        href="/leads"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to pipeline
      </Link>

      <PageHeader
        title="Create a sales opportunity"
        description="Capture the customer’s intent, preferred Denago model and the value your team should follow through."
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <LeadForm
          action={createLead}
          products={products.map((product) => ({
            id: product.id,
            name: product.name,
            basePriceCents: product.basePriceCents,
            colors: product.colors.map((color) => color.name),
          }))}
          stages={stages.map((stage) => ({ id: stage.id, name: stage.name }))}
          contacts={contacts.map((contact) => ({ id: contact.id, label: contactName(contact) }))}
          users={users.map((user) => ({ id: user.id, name: user.name }))}
          submitLabel="Create lead"
          variant="page"
        />

        <aside className="space-y-4 xl:sticky xl:top-6">
          <Surface className="relative overflow-hidden p-5">
            <div className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-primary/10 blur-3xl" />
            <SectionHeading
              title="How this lead starts"
              description="Saving creates a live opportunity, not a disconnected enquiry."
            />
            <ol className="relative mt-5 space-y-5 before:absolute before:bottom-5 before:left-[17px] before:top-5 before:w-px before:bg-border">
              {leadJourney.map(({ icon: Icon, label, detail }, index) => (
                <li key={label} className="relative flex gap-3">
                  <span className="relative z-10 grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground">
                    <Icon className="size-4" />
                  </span>
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
              <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-amber-400/20 bg-amber-400/10 text-amber-300">
                <CircleDollarSign className="size-4" />
              </span>
              <div>
                <p className="text-sm font-semibold text-foreground">Value is a forecast</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Use the best estimate you have.</p>
              </div>
            </div>
            <p className="mt-4 text-xs leading-5 text-muted-foreground">
              Catalogue pricing gives you a useful starting point. The opportunity value can be refined as the deal develops.
            </p>
          </Surface>

          <Link href="/leads" className={buttonVariants({ variant: "ghost", className: "w-full" })}>
            Cancel and return
            <ArrowRight className="size-4" />
          </Link>
        </aside>
      </div>
    </div>
  );
}
