import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import CampaignComposer from "@/components/CampaignComposer";
import { isSmtpConfigured } from "@/lib/email";
import { isSmsConfigured } from "@/lib/sms";

// The first send batch runs inside the send action — give it room.
export const maxDuration = 60;

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-slate-800 text-slate-400",
  queued: "bg-sky-500/15 text-sky-300",
  sending: "bg-amber-500/15 text-amber-300",
  sent: "bg-emerald-500/15 text-emerald-300",
};

export default async function CampaignsPage() {
  await requireUser();
  const [tags, templates, segments, campaigns, smtpConfigured, smsConfigured] = await Promise.all([
    prisma.tag.findMany({ orderBy: { name: "asc" } }),
    prisma.emailTemplate.findMany({ orderBy: { name: "asc" } }),
    prisma.segment.findMany({ orderBy: { name: "asc" } }),
    prisma.campaign.findMany({ orderBy: { createdAt: "desc" }, take: 30, include: { createdBy: true } }),
    isSmtpConfigured(),
    isSmsConfigured(),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Campaigns</h1>
        <p className="text-sm text-slate-400 mt-0.5">
          Rich email or SMS to a customer segment, with open &amp; click tracking. Opted-out
          customers are always excluded and every email carries an unsubscribe link.
        </p>
      </div>

      {!smtpConfigured && !smsConfigured && (
        <div className="card border-amber-500/30 text-sm text-amber-300">
          Neither email nor SMS is configured yet — set them up in Settings before sending.
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <CampaignComposer
          tags={tags.map((t) => ({ id: t.id, name: t.name }))}
          templates={templates.map((t) => ({ id: t.id, subject: t.subject, body: t.body }))}
          segments={segments.map((s) => ({ id: s.id, name: s.name, criteria: s.criteria }))}
          smtpConfigured={smtpConfigured}
          smsConfigured={smsConfigured}
        />

        <div className="card p-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 px-4 pt-4">
            Campaigns
          </p>
          {campaigns.length === 0 ? (
            <p className="text-sm text-slate-400 p-4">No campaigns yet.</p>
          ) : (
            <ul className="divide-y divide-slate-800 mt-2">
              {campaigns.map((c) => {
                const openRate = c.sentCount > 0 ? Math.round((c.openCount / c.sentCount) * 100) : 0;
                return (
                  <li key={c.id} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <Link href={`/campaigns/${c.id}`} className="text-sm font-medium text-orange-400 hover:underline">
                        {c.name}
                      </Link>
                      <span className={`badge ${STATUS_BADGE[c.status] ?? "bg-slate-800"}`}>{c.status}</span>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {c.channel.toUpperCase()} · {c.audience} · {c.sentCount}/{c.recipientCount} sent
                      {c.channel === "email" && c.sentCount > 0 ? ` · ${openRate}% opened` : ""}
                      {c.failedCount ? ` · ${c.failedCount} failed` : ""}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
