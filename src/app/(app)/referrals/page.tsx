import Link from "next/link";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { CheckCircle2, Clock3, Gift, HandCoins } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { redeemReferral } from "@/app/actions/referrals";
import { contactName, formatDate } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import {
  KpiGrid,
  MobileDataCard,
  MobileDataField,
  MobileDataFields,
  MobileDataHeader,
  MobileDataList,
  ResponsiveDataView,
} from "@/components/responsive-patterns";
import { EmptyState, MetricCard, StatusPill } from "@/components/visual-system";

export const metadata = { title: "Referrals — DenagoCRM" };

const statusLabel: Record<string, string> = {
  pending: "pending",
  earned: "fee due",
  redeemed: "redeemed",
};
const order: Record<string, number> = { earned: 0, pending: 1, redeemed: 2 };
const statusTone = (status: string) => status === "redeemed" ? "success" as const : status === "earned" ? "warning" as const : "neutral" as const;

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
  const earned = referrals.filter((referral) => referral.status === "earned").length;
  const pending = referrals.filter((referral) => referral.status === "pending").length;
  const redeemed = referrals.filter((referral) => referral.status === "redeemed").length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Referrals"
        description="Track customer introductions from shared referral code through won deal and reward redemption."
      />

      <KpiGrid className="xl:grid-cols-3">
        <MetricCard icon={HandCoins} label="Rewards due" value={earned} detail="Won referrals awaiting fulfilment" accent={earned > 0} />
        <MetricCard icon={Clock3} label="In progress" value={pending} detail="Introductions awaiting a won deal" />
        <MetricCard icon={CheckCircle2} label="Redeemed" value={redeemed} detail="Customer rewards already fulfilled" />
      </KpiGrid>

      {sorted.length === 0 ? (
        <EmptyState
          icon={Gift}
          title="No referrals to track yet"
          description="Each customer has a unique code on their contact record. Share it to connect a future lead and reward the introduction when the deal is won."
          action={<Link href="/contacts" className="btn-secondary">Browse customer contacts</Link>}
        />
      ) : (
        <ResponsiveDataView
          mobile={
            <MobileDataList>
              {sorted.map((referral) => {
                const referred = referral.lead?.name ?? (referral.contact ? contactName(referral.contact) : "Not linked");
                return (
                  <MobileDataCard key={referral.id}>
                    <MobileDataHeader
                      title={<Link href={`/contacts/${referral.referrerId}`} className="text-primary hover:underline">{contactName(referral.referrer)}</Link>}
                      detail={`Code ${referral.referrer.referralCode}`}
                      aside={<StatusPill tone={statusTone(referral.status)}>{statusLabel[referral.status] ?? referral.status}</StatusPill>}
                    />
                    <MobileDataFields>
                      <MobileDataField label="Referred record">{referred}</MobileDataField>
                      <MobileDataField label="Introduced">{formatDate(referral.createdAt)}</MobileDataField>
                      <MobileDataField label="Progress" wide>
                        {referral.earnedAt ? `Won ${formatDate(referral.earnedAt)}` : "Awaiting won deal"}
                        {referral.redeemedAt ? ` · Redeemed ${formatDate(referral.redeemedAt)}` : ""}
                      </MobileDataField>
                    </MobileDataFields>
                    {referral.status === "earned" && (
                      <SaveForm success="Referral redeemed" resetOnSuccess={false} action={redeemReferral.bind(null, referral.id)} className="space-y-2 border-t border-border pt-3">
                        <label className="label" htmlFor={`reward-${referral.id}`}>Reward provided</label>
                        <input id={`reward-${referral.id}`} name="note" required className="input" placeholder="e.g. R1,000 voucher" />
                        <SaveButton className="btn-primary w-full">Mark reward redeemed</SaveButton>
                      </SaveForm>
                    )}
                    {referral.status === "redeemed" && referral.redeemedNote && <p className="rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">Reward: {referral.redeemedNote}</p>}
                  </MobileDataCard>
                );
              })}
            </MobileDataList>
          }
          desktop={
            <div className="card p-0 overflow-x-auto">
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
                  <StatusPill tone={statusTone(r.status)}>{statusLabel[r.status] ?? r.status}</StatusPill>
                </td>
                <td className="text-xs text-slate-400">
                  referred {formatDate(r.createdAt)}
                  {r.earnedAt ? ` · won ${formatDate(r.earnedAt)}` : ""}
                  {r.redeemedAt ? ` · redeemed ${formatDate(r.redeemedAt)}` : ""}
                </td>
                <td className="text-right">
                  {r.status === "earned" ? (
                    <SaveForm
                      success="Referral redeemed"
                      resetOnSuccess={false}
                      action={redeemReferral.bind(null, r.id)}
                      className="flex items-center gap-1.5 justify-end"
                    >
                      <input
                        name="note"
                        required
                        className="input btn-sm w-44 text-xs"
                        placeholder="What was given? e.g. R1,000 voucher"
                      />
                      <SaveButton pendingLabel="Redeeming…" className="btn-primary btn-sm">
                        Redeem
                      </SaveButton>
                    </SaveForm>
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
          }
        />
      )}
    </div>
  );
}
