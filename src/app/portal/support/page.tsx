import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Headphones, LifeBuoy, MessagesSquare } from "lucide-react";
import { basePrisma, prisma } from "@/lib/db";
import { getPortalContact } from "@/lib/portal";
import { requirePortalScope } from "@/lib/portalAccess";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { PortalCaseForm } from "@/components/PortalExpansionForms";
import { contactName, formatDate } from "@/lib/format";
import { EmptyState, PortalPageHeader, SectionHeading, StatusPill, Surface } from "@/components/visual-system";

type CaseRow = {
  id: string;
  number: bigint;
  subject: string;
  type: string;
  priority: string;
  status: string;
  contactId: string;
  vehicleId: string | null;
  updatedAt: Date;
};

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (["closed", "resolved", "completed"].includes(status)) return "success";
  if (["urgent", "escalated", "cancelled"].includes(status)) return "danger";
  if (["waiting", "pending"].includes(status)) return "warning";
  if (["open", "in_progress"].includes(status)) return "info";
  return "neutral";
}

export default async function PortalSupportPage() {
  const contact = await getPortalContact();
  if (!contact) redirect("/portal/login");
  const scope = await requirePortalScope();
  const automotiveOn = await isModuleEnabled("automotive");

  const [contacts, vehicles, cases] = await Promise.all([
    prisma.contact.findMany({ where: { id: { in: scope.contactIds }, deletedAt: null }, orderBy: { firstName: "asc" } }),
    prisma.vehicle.findMany({
      where: {
        deletedAt: null,
        OR: [
          { contactId: { in: scope.contactIds } },
          ...(scope.fleetIds.length ? [{ fleetId: { in: scope.fleetIds } }] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
    }),
    basePrisma.$queryRaw<CaseRow[]>`
      SELECT DISTINCT c."id", c."number", c."subject", c."type", c."priority", c."status",
        c."contactId", c."vehicleId", c."updatedAt"
      FROM "CustomerCase" c
      LEFT JOIN "Vehicle" v ON v."id" = c."vehicleId"
      WHERE c."contactId" = ANY(${scope.contactIds}::text[])
         OR (v."fleetId" IS NOT NULL AND v."fleetId" = ANY(${scope.fleetIds}::text[]))
      ORDER BY c."updatedAt" DESC
      LIMIT 100
    `,
  ]);

  return (
    <div className="space-y-10">
      <PortalPageHeader eyebrow="We're here to help" title={automotiveOn ? "Support & warranty" : "Support"} description="Submit a request, track its progress and keep the conversation with our team in one secure place." />

      <Surface className="space-y-5 p-5 sm:p-6">
        <SectionHeading title="Start a new request" description="Tell us what you need and we’ll route it to the right Denago specialist." action={<span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary"><LifeBuoy className="size-5" /></span>} />
        <PortalCaseForm
          automotive={automotiveOn}
          contacts={contacts.map((row) => ({ id: row.id, label: contactName(row) }))}
          vehicles={automotiveOn ? vehicles.map((row) => ({ id: row.id, label: `${row.model}${row.regNumber ? ` (${row.regNumber})` : ""}` })) : []}
        />
      </Surface>

      <section className="space-y-3">
        <SectionHeading title="Your conversations" description="Support, warranty, delivery and document requests linked to your account." action={<MessagesSquare className="size-5 text-muted-foreground" />} />
        {cases.length === 0 ? (
          <EmptyState icon={Headphones} title="No support requests yet" description="When you contact us through the portal, the conversation and its progress will appear here." className="py-10" />
        ) : (
          <Surface className="divide-y divide-border">
            {cases.map((item) => (
              <Link key={item.id} href={`/portal/support/${item.id}`} className="group block px-4 py-4 transition-colors hover:bg-white/[0.025] sm:px-5">
                <div className="flex items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-white/[0.07] bg-white/[0.035] text-slate-400"><Headphones className="size-4" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">C-{item.number.toString()} · {item.subject}</p>
                    <p className="mt-1 text-xs text-slate-400">{item.type} · {item.priority} · updated {formatDate(item.updatedAt)}</p>
                  </div>
                  <StatusPill tone={statusTone(item.status)}>{item.status.replaceAll("_", " ")}</StatusPill>
                  <ArrowRight className="size-4 shrink-0 text-slate-600 transition-transform group-hover:translate-x-0.5 group-hover:text-orange-400" />
                </div>
              </Link>
            ))}
          </Surface>
        )}
      </section>
    </div>
  );
}
