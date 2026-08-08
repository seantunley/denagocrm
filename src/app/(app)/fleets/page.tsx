import Link from "next/link";
import { requireRoute } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { activeTenantPredicate } from "@/lib/tenantPredicate";
import { DEFAULT_FLEET_TYPE, FLEET_TYPES, FLEET_TYPE_LABELS, fleetTypeLabel } from "@/lib/fleetTypes";
import { contactName } from "@/lib/format";
import { createFleet } from "@/app/actions/fleets";
import { WorkspaceHero } from "@/components/workspace-hero";
import { MobileDataCard, MobileDataField, MobileDataFields, MobileDataHeader, MobileDataList, ResponsiveDataView } from "@/components/responsive-patterns";
import { EmptyState, SectionHeading, StatusPill, Surface } from "@/components/visual-system";
import { Building2, CarFront, Plus, UsersRound, Warehouse } from "lucide-react";
import RecordContextMenu from "@/components/RecordContextMenu";

export const dynamic = "force-dynamic";

export default async function FleetsPage() {
  await requireRoute("/fleets");
  // Both lists name the tenant themselves. The db.ts guard scopes nothing while
  // enforcement is off, so without this the workspace would list every tenant's
  // fleets — and every tenant's customers in the primary-contact picker.
  const tenant = activeTenantPredicate("Fleets workspace");
  const [fleets, contacts] = await Promise.all([
    prisma.fleet.findMany({
      where: { ...tenant },
      orderBy: { name: "asc" },
      include: { _count: { select: { vehicles: true } } },
    }),
    prisma.contact.findMany({ where: { ...tenant }, orderBy: { firstName: "asc" }, take: 500 }),
  ]);
  const vehicleCount = fleets.reduce((total, fleet) => total + fleet._count.vehicles, 0);
  const fleetTypes = new Set(fleets.map((fleet) => fleet.type).filter(Boolean)).size;

  return (
    <div className="space-y-6">
      <WorkspaceHero
        icon={Warehouse}
        eyebrow="Managed mobility"
        title="Fleets"
        description="Manage estates, golf courses, lodges, resorts and business accounts with linked vehicles and service visibility."
        stats={[
          { label: "Managed fleets", value: fleets.length, detail: "Active customer accounts", icon: Warehouse, tone: "primary" },
          { label: "Fleet vehicles", value: vehicleCount, detail: "Linked across all fleets", icon: CarFront },
          { label: "Account types", value: fleetTypes, detail: "Operational segments", icon: Building2 },
          { label: "Contact pool", value: contacts.length, detail: "Available account contacts", icon: UsersRound },
        ]}
      />

      <Surface className="p-5">
        <SectionHeading title={<span className="inline-flex items-center gap-2"><Plus className="size-4 text-primary" /> Create a fleet</span>} description="Open a managed account and optionally connect its primary customer contact." />
        <form action={createFleet} className="mt-4 grid gap-2 sm:grid-cols-3">
          <input name="name" className="input" placeholder="Fleet name (e.g. De Zalze Estate)" required />
          <select name="type" className="input" defaultValue={DEFAULT_FLEET_TYPE}>
            {FLEET_TYPES.map((t) => (
              <option key={t} value={t}>
                {FLEET_TYPE_LABELS[t]}
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
            <button className="btn-primary"><Plus className="size-4" /> Create fleet</button>
          </div>
        </form>
      </Surface>

      {fleets.length === 0 ? <EmptyState icon={Warehouse} title="No fleets yet" description="Create the first managed estate, golf course, lodge, resort or business fleet above." /> : <ResponsiveDataView
        mobile={<MobileDataList>{fleets.map((fleet) => <RecordContextMenu key={fleet.id} label={fleet.name} href={`/fleets/${fleet.id}`}><MobileDataCard>
          <MobileDataHeader
            title={<Link href={`/fleets/${fleet.id}`} className="text-primary">{fleet.name}</Link>}
            detail="Open the fleet workspace to manage vehicles and service status."
            aside={fleet.type ? <StatusPill tone="info">{fleetTypeLabel(fleet.type)}</StatusPill> : undefined}
          />
          <MobileDataFields>
            <MobileDataField label="Vehicles">{fleet._count.vehicles}</MobileDataField>
            <MobileDataField label="Account type">{fleetTypeLabel(fleet.type) ?? "Not set"}</MobileDataField>
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
                <td className="text-slate-400">{fleetTypeLabel(f.type) ?? "—"}</td>
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
