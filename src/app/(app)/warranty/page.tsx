import Link from "next/link";
import { prisma } from "@/lib/db";
import { contactName, formatDate } from "@/lib/format";
import { computeWarranty, warrantyColors, warrantyLabels, claimColors } from "@/lib/warranty";
import { createRecall, deleteRecall } from "@/app/actions/warranty";
import RecallNotifyButton from "@/components/RecallNotifyButton";
import { PageHeader } from "@/components/page-header";
import {
  getAccessibleVehicleIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function WarrantyPage() {
  const user = await requireAnyPermission("warranty.view", "warranty.manage");
  const [vehicleIds, canManage] = await Promise.all([
    getAccessibleVehicleIds(user),
    hasPermission(user, "warranty.manage"),
  ]);
  const vehicleScope = vehicleIds === null ? {} : { id: { in: vehicleIds } };

  const [vehicles, claims, recalls] = await Promise.all([
    prisma.vehicle.findMany({ where: vehicleScope, include: { contact: true } }),
    prisma.warrantyClaim.findMany({
      where: {
        status: { in: ["open", "approved"] },
        ...(vehicleIds === null ? {} : { vehicleId: { in: vehicleIds } }),
      },
      orderBy: { claimedAt: "desc" },
      include: { vehicle: { include: { contact: true } } },
    }),
    prisma.recall.findMany({ orderBy: { createdAt: "desc" } }),
  ]);

  const expiring = vehicles
    .map((vehicle) => ({ vehicle, warranty: computeWarranty(vehicle) }))
    .filter(({ warranty }) => warranty.status === "expiring" || warranty.status === "expired")
    .sort((a, b) => (a.warranty.daysRemaining ?? 0) - (b.warranty.daysRemaining ?? 0));
  const modelCounts = new Map<string, number>();
  for (const vehicle of vehicles) modelCounts.set(vehicle.model, (modelCounts.get(vehicle.model) ?? 0) + 1);
  const models = [...modelCounts.keys()].sort();

  return (
    <div className="space-y-8">
      <PageHeader
        title="Warranty & recalls"
        description={`${expiring.length} accessible expiring · ${claims.length} open claims · ${recalls.length} recall bulletins`}
      />

      <section className="space-y-3">
        <h2 className="font-semibold">Warranties expiring or expired ({expiring.length})</h2>
        <div className="card p-0 overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>Cart</th><th>Owner</th><th>Status</th><th>Expiry</th></tr></thead>
            <tbody>
              {expiring.length === 0 && <tr><td colSpan={4} className="text-center text-slate-400 py-6">No accessible warranties expiring soon.</td></tr>}
              {expiring.map(({ vehicle, warranty }) => (
                <tr key={vehicle.id}>
                  <td><Link href={`/vehicles/${vehicle.id}`} className="text-orange-400 hover:underline font-medium">{vehicle.model}</Link></td>
                  <td><Link href={`/contacts/${vehicle.contactId}`} className="hover:underline">{contactName(vehicle.contact)}</Link></td>
                  <td><span className={`badge ${warrantyColors[warranty.status]}`}>{warrantyLabels[warranty.status]}</span></td>
                  <td className="text-slate-300">
                    {warranty.expiryDate ? formatDate(warranty.expiryDate) : "—"}
                    {warranty.daysRemaining != null && <span className="text-xs text-slate-500 ml-1">({warranty.daysRemaining < 0 ? `${-warranty.daysRemaining}d ago` : `in ${warranty.daysRemaining}d`})</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Open warranty claims ({claims.length})</h2>
        <div className="card p-0 overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>Cart</th><th>Owner</th><th>Fault</th><th>Status</th><th>Opened</th><th /></tr></thead>
            <tbody>
              {claims.length === 0 && <tr><td colSpan={6} className="text-center text-slate-400 py-6">No accessible open claims.</td></tr>}
              {claims.map((claim) => (
                <tr key={claim.id}>
                  <td><Link href={`/vehicles/${claim.vehicleId}`} className="text-orange-400 hover:underline font-medium">{claim.vehicle.model}</Link></td>
                  <td>{contactName(claim.vehicle.contact)}</td>
                  <td className="text-slate-300 max-w-xs truncate" title={claim.description}>{claim.description}</td>
                  <td><span className={`badge ${claimColors[claim.status]}`}>{claim.status}</span></td>
                  <td className="text-slate-400">{formatDate(claim.claimedAt)}</td>
                  <td className="text-right"><a href={`/warranty/${claim.id}/print`} target="_blank" rel="noreferrer" className="text-xs text-orange-400 hover:underline">Print claim</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Recalls & service bulletins</h2>
        {canManage && (
          <div className="card">
            <form action={createRecall} className="grid sm:grid-cols-2 gap-2">
              <input name="title" className="input" placeholder="Title (e.g. Brake cable inspection)" required />
              <select name="model" className="input" required defaultValue="">
                <option value="" disabled>Affected model…</option>
                {models.map((model) => <option key={model} value={model}>{model} ({modelCounts.get(model)})</option>)}
              </select>
              <textarea name="description" className="input sm:col-span-2" rows={2} placeholder="What owners need to know and do" required />
              <div className="sm:col-span-2"><button className="btn-primary">Create bulletin</button></div>
            </form>
          </div>
        )}

        <div className="space-y-2">
          {recalls.length === 0 && <p className="text-sm text-slate-400">No recalls or bulletins yet.</p>}
          {recalls.map((recall) => (
            <div key={recall.id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{recall.title}</p>
                  <p className="text-xs text-slate-500">{recall.model} · {modelCounts.get(recall.model) ?? 0} accessible carts{recall.notifiedAt ? ` · notified ${formatDate(recall.notifiedAt)}` : ""}</p>
                </div>
                {canManage && (
                  <div className="flex items-center gap-3">
                    <RecallNotifyButton recallId={recall.id} affected={modelCounts.get(recall.model) ?? 0} />
                    <form action={deleteRecall.bind(null, recall.id)}><button className="text-xs text-red-400 hover:text-red-300">Delete</button></form>
                  </div>
                )}
              </div>
              <p className="text-sm text-slate-300 mt-2 whitespace-pre-wrap">{recall.description}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
