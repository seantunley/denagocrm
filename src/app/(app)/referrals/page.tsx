import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { redeemReferral } from "@/app/actions/referrals";
import { contactName, formatDate } from "@/lib/format";

export const metadata = { title: "Referrals — DenagoCRM" };

const statusBadge: Record<string, string> = {
  pending: "bg-slate-800 text-slate-300",
  earned: "bg-amber-500/15 text-amber-300",
  redeemed: "bg-emerald-500/15 text-emerald-300",
};
const statusLabel: Record<string, string> = {
  pending: "pending",
  earned: "fee due",
  redeemed: "redeemed",
};
const order: Record<string, number> = { earned: 0, pending: 1, redeemed: 2 };

export default async function ReferralsPage() {
  await requireUser();
  const referrals = await prisma.referral.findMany({
    include: { referrer: true, lead: true, contact: true },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  const sorted = [...referrals].sort(
    (a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3)
  );

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold">Referrals</h1>
        <p className="text-sm text-slate-400 mt-1">
          Every customer has a unique code (on their contact page). When a referred deal is won
          the fee becomes due here — redeem it with a note of what was given.
        </p>
      </div>

      <div className="card p-0">
        <table className="table-base">
          <thead>
            <tr>
              <th>Referrer</th>
              <th>Referred</th>
              <th>Status</th>
              <th>Dates</th>
              <th className="text-right">Fee</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-slate-400 py-8">
                  No referrals yet — share customers&apos; codes to get the ball rolling.
                </td>
              </tr>
            )}
            {sorted.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link
                    href={`/contacts/${r.referrerId}`}
                    className="text-orange-400 hover:underline font-medium"
                  >
                    {contactName(r.referrer)}
                  </Link>
                  <p className="text-xs text-slate-500">{r.referrer.referralCode}</p>
                </td>
                <td>
                  {r.lead ? (
                    <Link href={`/leads/${r.lead.id}`} className="text-orange-400 hover:underline">
                      {r.lead.name}
                    </Link>
                  ) : r.contact ? (
                    <Link
                      href={`/contacts/${r.contact.id}`}
                      className="text-orange-400 hover:underline"
                    >
                      {contactName(r.contact)}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <span className={`badge ${statusBadge[r.status] ?? statusBadge.pending}`}>
                    {statusLabel[r.status] ?? r.status}
                  </span>
                </td>
                <td className="text-xs text-slate-400">
                  referred {formatDate(r.createdAt)}
                  {r.earnedAt ? ` · won ${formatDate(r.earnedAt)}` : ""}
                  {r.redeemedAt ? ` · redeemed ${formatDate(r.redeemedAt)}` : ""}
                </td>
                <td className="text-right">
                  {r.status === "earned" ? (
                    <form
                      action={redeemReferral.bind(null, r.id)}
                      className="flex items-center gap-1.5 justify-end"
                    >
                      <input
                        name="note"
                        required
                        className="input btn-sm w-44 text-xs"
                        placeholder="What was given? e.g. R1,000 voucher"
                      />
                      <button className="btn-primary btn-sm">Redeem</button>
                    </form>
                  ) : r.status === "redeemed" ? (
                    <span className="text-xs text-slate-400">{r.redeemedNote}</span>
                  ) : (
                    <span className="text-xs text-slate-600">awaiting won deal</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
