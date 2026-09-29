import Link from "next/link";
import { ArrowLeft, CalendarCheck2, CarFront, History, MessageSquareHeart, ShieldCheck } from "lucide-react";
import { createVehicle } from "@/app/actions/vehicles";
import VehicleForm from "@/components/VehicleForm";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { SectionHeading, Surface } from "@/components/visual-system";
import { prisma } from "@/lib/db";
import { contactName } from "@/lib/format";
import { getAccessibleContactIds, requirePermission } from "@/lib/permissions";
import { vehiclesAwaitingRegistration } from "@/lib/deliveryVehicles";

const vehicleJourney = [
  { icon: History, label: "Customer garage", detail: "The vehicle becomes part of the owner’s permanent sales and service timeline." },
  { icon: CalendarCheck2, label: "Service baseline", detail: "Mileage and intervals establish when the vehicle is next due for attention." },
  { icon: ShieldCheck, label: "Warranty-ready identity", detail: "VIN, registration and delivery data support future service and warranty claims." },
];

export default async function NewVehiclePage({
  searchParams,
}: {
  searchParams: Promise<{ contactId?: string; productId?: string; color?: string; quoteId?: string; seq?: string }>;
}) {
  const user = await requirePermission("vehicles.manage");
  const { contactId, productId, color, quoteId, seq } = await searchParams;
  const accessibleContactIds = await getAccessibleContactIds(user);
  const [contacts, products] = await Promise.all([
    prisma.contact.findMany({
      where: accessibleContactIds === null ? {} : { id: { in: accessibleContactIds } },
      orderBy: { firstName: "asc" },
      take: 500,
    }),
    prisma.product.findMany({ where: { active: true }, include: { colors: true }, orderBy: { name: "asc" } }),
  ]);

  /*
   * A delivery of several vehicles arrives here once PER VEHICLE.
   *
   * The queue is re-derived from the quote rather than passed in the URL, so the
   * position cannot be edited into something the quote never sold, and a refresh
   * lands on the same vehicle. `seq` is only an index into it.
   *
   * A quote that is not readable in this workspace simply yields no queue, and
   * the page falls back to the plain form — the guarded client already refuses
   * anything outside the caller's tenant, so there is nothing extra to check.
   */
  const quote = quoteId
    ? await prisma.quote.findFirst({
        where: { id: quoteId },
        include: { items: { include: { product: true }, orderBy: { sortOrder: "asc" } } },
      })
    : null;
  const queue = quote ? vehiclesAwaitingRegistration(quote.items) : [];
  const position = Math.max(0, Number.parseInt(seq ?? "0", 10) || 0);
  const current = queue[position] ?? null;

  const preselected =
    products.find((product) => product.id === (current?.productId ?? productId)) ?? null;

  return (
    <div className="space-y-6">
      <Link href="/vehicles" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" />
        Back to vehicles
      </Link>
      <PageHeader
        title={
          queue.length > 1
            ? `Register vehicle ${position + 1} of ${queue.length}`
            : "Register a customer vehicle"
        }
        description={
          queue.length > 1
            ? `This delivery included ${queue.length} vehicles. Each one needs its own record — VIN, registration and mileage differ per unit, and so does its warranty and service history.`
            : "Connect the vehicle to its owner and establish the identity, warranty and service data the team will rely on."
        }
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <VehicleForm
          action={createVehicle}
          contacts={contacts.map((contact) => ({ id: contact.id, label: contactName(contact) }))}
          products={products.map((product) => ({
            id: product.id,
            name: product.name,
            colors: product.colors.map((item) => item.name),
          }))}
          defaults={{
            contactId: contactId ?? "",
            productId: current?.productId ?? productId ?? "",
            // The catalogue name when the queue knows it, so unit 2 of 2 arrives
            // pre-filled the same way unit 1 did.
            model: current?.model ?? preselected?.name ?? "",
            color: current?.color || color || "",
          }}
          hiddenFields={
            queue.length > 0 && quoteId
              ? { deliveryQuoteId: quoteId, deliverySeq: String(position) }
              : undefined
          }
          submitLabel={
            queue.length > 1 && position + 1 < queue.length
              ? `Register vehicle ${position + 1} and continue`
              : "Register vehicle"
          }
          showInitialKm
          variant="page"
        />

        <aside className="space-y-4 xl:sticky xl:top-6">
          <Surface className="relative overflow-hidden p-5">
            <div className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-primary/10 blur-3xl" />
            <SectionHeading title="Registration creates" description="The vehicle becomes an active relationship and service record immediately." />
            <ol className="relative mt-5 space-y-5 before:absolute before:bottom-5 before:left-[17px] before:top-5 before:w-px before:bg-border">
              {vehicleJourney.map(({ icon: Icon, label, detail }, index) => (
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
              <span className="grid size-9 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary"><MessageSquareHeart className="size-4" /></span>
              <p className="text-sm font-semibold text-foreground">Delivery follow-up</p>
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">For a new delivery, the review request and delivery survey can be triggered automatically after registration.</p>
          </Surface>
          <Link href="/vehicles" className={buttonVariants({ variant: "ghost", className: "w-full" })}>
            <CarFront className="size-4" />
            Cancel and return
          </Link>
        </aside>
      </div>
    </div>
  );
}
