import Link from "next/link";
import { requireCrm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { contactName } from "@/lib/format";
import { createFleet } from "@/app/actions/fleets";
import { PageHeader } from "@/components/page-header";
import { MobileDataCard, MobileDataField, MobileDataFields, MobileDataHeader, MobileDataList, ResponsiveDataView } from "@/components/responsive-patterns";
import { EmptyState, StatusPill } from "@/components/visual-system";
import { Warehouse } from "lucide-react";
import RecordContextMenu from "@/components/RecordContextMenu";

export const dynamic = "force-dynamic";

export const FLEET_TYPES = ["estate", "golf-course", "resort", "business", "other"];

export default async function FleetsPage() {
  await requireCrm();
  const [fleets, contacts] = await Promise.all([
    prisma.fleet.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { vehicles: true } } },
    }),
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title="Fleets" description={`${fleets.length} managed fleet${fleets.length === 1 ? "" : "s"} · Estates, golf courses, resorts and business accounts.`} />

      <div className="card">
        <h2 className="font-semibold mb-3">New fleet</h2>
        <form action={createFleet} className="grid sm:grid-cols-3 gap-2">
          <input name="name" className="input" placeholder="Fleet name (e.g. De Zalze Estate)" required />
          <select name="type" className="input" defaultValue="estate">
            {FLEET_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select name="contactId" className="input" defaultValue="">
            <option value="">Primary contact (optional)…</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {contactName(c)}
              </option>
            ))}
          </select>
          <div className="sm:col-span-3">
            <button className="btn-primary">Create fleet</button>
          </div>
        </form>
      </div>

      {fleets.length === 0 ? <EmptyState icon={Warehouse} title="No fleets yet" description="Create the first managed estate, golf course, resort or business fleet above." /> : <ResponsiveDataView
        mobile={<MobileDataList>{fleets.map((fleet) => <RecordContextMenu key={fleet.id} label={fleet.name} href={`/fleets/${fleet.id}`}><MobileDataCard>
          <MobileDataHeader
            title={<Link href={`/fleets/${fleet.id}`} className="text-primary">{fleet.name}</Link>}
            detail="Open the fleet workspace to manage vehicles and service status."
            aside={fleet.type ? <StatusPill tone="info">{fleet.type}</StatusPill> : undefined}
          />
          <MobileDataFields>
            <MobileDataField label="Vehicles">{fleet._count.vehicles}</MobileDataField>
            <MobileDataField label="Account type"><span className="capitalize">{fleet.type ?? "Not set"}</span></MobileDataField>
          </MobileDataFields>
          <Link href={`/fleets/${fleet.id}`} className="btn-secondary w-full">Open fleet</Link>
        </MobileDataCard></RecordContextMenu>)}</MobileDataList>}
        desktop={<div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Fleet</th>
              <th>Type</th>
              <th className="text-right">Carts</th>
            </tr>
          </thead>
          <tbody>
            {fleets.length === 0 && (
              <tr>
                <td colSpan={3} className="text-center text-slate-400 py-8">
                  No fleets yet — create one above.
                </td>
              </tr>
            )}
            {fleets.map((f) => (
              <RecordContextMenu key={f.id} label={f.name} href={`/fleets/${f.id}`}>
              <tr tabIndex={0} className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
                <td>
                  <Link href={`/fleets/${f.id}`} className="font-medium text-orange-400 hover:underline">
                    {f.name}
                  </Link>
                </td>
                <td className="text-slate-400 capitalize">{f.type ?? "—"}</td>
                <td className="text-right">{f._count.vehicles}</td>
              </tr>
              </RecordContextMenu>
            ))}
          </tbody>
        </table>
      </div>}
      />}
    </div>
  );
}
