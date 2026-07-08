import Link from "next/link";
import { requireWorkshop } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { contactName, formatDate } from "@/lib/format";
import { computeWarranty, warrantyColors, warrantyLabels, claimColors } from "@/lib/warranty";
import { createRecall, deleteRecall } from "@/app/actions/warranty";
import RecallNotifyButton from "@/components/RecallNotifyButton";

export const dynamic = "force-dynamic";

export default async function WarrantyPage() {
  await requireWorkshop();

  const [vehicles, claims, recalls] = await Promise.all([
    prisma.vehicle.findMany({ include: { contact: true } }),
    prisma.warrantyClaim.findMany({
      where: { status: { in: ["open", "approved"] } },
      orderBy: { claimedAt: "desc" },
      include: { vehicle: { include: { contact: true } } },
    }),
    prisma.recall.findMany({ orderBy: { createdAt: "desc" } }),
  ]);

  const expiring = vehicles
    .map((v) => ({ v, w: computeWarranty(v) }))
    .filter(({ w }) => w.status === "expiring" || w.status === "expired")
    .sort((a, b) => (a.w.daysRemaining ?? 0) - (b.w.daysRemaining ?? 0));

  // Count carts per model for recall targeting
  const modelCounts = new Map<string, number>();
  for (const v of vehicles) modelCounts.set(v.model, (modelCounts.get(v.model) ?? 0) + 1);
  const models = [...modelCounts.keys()].sort();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Warranty &amp; recalls</h1>
        <p className="text-sm text-slate-400 mt-0.5">
          Expiring warranties, open claims, and recall / service bulletins.
        </p>
      </div>

      {/* Expiring warranties */}
      <section className="space-y-3">
        <h2 className="font-semibold">Warranties expiring or expired ({expiring.length})</h2>
        <div className="card p-0 overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Cart</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Expiry</th>
              </tr>
            </thead>
            <tbody>
              {expiring.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-center text-slate-400 py-6">
                    No warranties expiring soon.
                  </td>
                </tr>
              )}
              {expiring.map(({ v, w }) => (
                <tr key={v.id}>
                  <td>
                    <Link href={`/vehicles/${v.id}`} className="text-orange-400 hover:underline font-medium">
                      {v.model}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/contacts/${v.contactId}`} className="hover:underline">
                      {contactName(v.contact)}
                    </Link>
                  </td>
                  <td>
                    <span className={`badge ${warrantyColors[w.status]}`}>{warrantyLabels[w.status]}</span>
                  </td>
                  <td className="text-slate-300">
                    {w.expiryDate ? formatDate(w.expiryDate) : "—"}
                    {w.daysRemaining != null && (
                      <span className="text-xs text-slate-500 ml-1">
                        ({w.daysRemaining < 0 ? `${-w.daysRemaining}d ago` : `in ${w.daysRemaining}d`})
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Open claims */}
      <section className="space-y-3">
        <h2 className="font-semibold">Open warranty claims ({claims.length})</h2>
        <div className="card p-0 overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Cart</th>
                <th>Owner</th>
                <th>Fault</th>
                <th>Status</th>
                <th>Opened</th>
              </tr>
            </thead>
            <tbody>
              {claims.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-slate-400 py-6">
                    No open claims.
                  </td>
                </tr>
              )}
              {claims.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/vehicles/${c.vehicleId}`} className="text-orange-400 hover:underline font-medium">
                      {c.vehicle.model}
                    </Link>
                  </td>
                  <td>{contactName(c.vehicle.contact)}</td>
                  <td className="text-slate-300 max-w-xs truncate" title={c.description}>
                    {c.description}
                  </td>
                  <td>
                    <span className={`badge ${claimColors[c.status]}`}>{c.status}</span>
                  </td>
                  <td className="text-slate-400">{formatDate(c.claimedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recalls */}
      <section className="space-y-3">
        <h2 className="font-semibold">Recalls &amp; service bulletins</h2>
        <div className="card">
          <form action={createRecall} className="grid sm:grid-cols-2 gap-2">
            <input name="title" className="input" placeholder="Title (e.g. Brake cable inspection)" required />
            <select name="model" className="input" required defaultValue="">
              <option value="" disabled>
                Affected model…
              </option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m} ({modelCounts.get(m)})
                </option>
              ))}
            </select>
            <textarea
              name="description"
              className="input sm:col-span-2"
              rows={2}
              placeholder="What owners need to know and do"
              required
            />
            <div className="sm:col-span-2">
              <button className="btn-primary">Create bulletin</button>
            </div>
          </form>
        </div>

        <div className="space-y-2">
          {recalls.length === 0 && <p className="text-sm text-slate-400">No recalls or bulletins yet.</p>}
          {recalls.map((r) => (
            <div key={r.id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{r.title}</p>
                  <p className="text-xs text-slate-500">
                    {r.model} · {modelCounts.get(r.model) ?? 0} on file
                    {r.notifiedAt ? ` · notified ${formatDate(r.notifiedAt)}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <RecallNotifyButton recallId={r.id} affected={modelCounts.get(r.model) ?? 0} />
                  <form action={deleteRecall.bind(null, r.id)}>
                    <button className="text-xs text-red-400 hover:text-red-300">Delete</button>
                  </form>
                </div>
              </div>
              <p className="text-sm text-slate-300 mt-2 whitespace-pre-wrap">{r.description}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
