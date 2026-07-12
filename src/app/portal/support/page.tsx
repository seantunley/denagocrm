import Link from "next/link";
import { redirect } from "next/navigation";
import { basePrisma, prisma } from "@/lib/db";
import { getPortalContact } from "@/lib/portal";
import { requirePortalScope } from "@/lib/portalAccess";
import { PortalCaseForm } from "@/components/PortalExpansionForms";
import { contactName, formatDate } from "@/lib/format";

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

export default async function PortalSupportPage() {
  const contact = await getPortalContact();
  if (!contact) redirect("/portal/login");
  const scope = await requirePortalScope();

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
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Support & warranty</h1>
        <p className="text-sm text-slate-400 mt-1">Submit a request, track its status and continue the conversation with our team.</p>
      </div>

      <section className="card space-y-4">
        <h2 className="font-semibold">New request</h2>
        <PortalCaseForm
          contacts={contacts.map((row) => ({ id: row.id, label: contactName(row) }))}
          vehicles={vehicles.map((row) => ({ id: row.id, label: `${row.model}${row.regNumber ? ` (${row.regNumber})` : ""}` }))}
        />
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Your cases</h2>
        {cases.length === 0 ? (
          <div className="card text-sm text-slate-400">No support cases yet.</div>
        ) : (
          <div className="card p-0 divide-y divide-slate-800">
            {cases.map((item) => (
              <Link key={item.id} href={`/portal/support/${item.id}`} className="block px-4 py-3 hover:bg-slate-900/60">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">C-{item.number.toString()} · {item.subject}</p>
                    <p className="text-xs text-slate-400 mt-1">{item.type} · {item.priority} · updated {formatDate(item.updatedAt)}</p>
                  </div>
                  <span className="badge bg-slate-800 text-slate-300">{item.status}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
