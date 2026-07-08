import Link from "next/link";
import { requireCrm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { contactName } from "@/lib/format";
import { createFleet } from "@/app/actions/fleets";

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
      <div>
        <h1 className="text-2xl font-bold">Fleets</h1>
        <p className="text-sm text-slate-400 mt-0.5">
          Group many carts under one account — estates, golf courses, resorts and businesses — for a
          fleet-level service view.
        </p>
      </div>

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

      <div className="card p-0 overflow-x-auto">
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
              <tr key={f.id}>
                <td>
                  <Link href={`/fleets/${f.id}`} className="font-medium text-orange-400 hover:underline">
                    {f.name}
                  </Link>
                </td>
                <td className="text-slate-400 capitalize">{f.type ?? "—"}</td>
                <td className="text-right">{f._count.vehicles}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
