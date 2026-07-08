import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import CampaignComposer from "@/components/CampaignComposer";
import { isSmtpConfigured, renderTemplate, contactVars } from "@/lib/email";
import { isSmsConfigured } from "@/lib/sms";

// Sending iterates recipients synchronously — give the action room to run.
export const maxDuration = 60;

export default async function CampaignsPage() {
  await requireUser();
  const [tags, templates, campaigns, smtpConfigured, smsConfigured, allCount, vehicleOwnerCount] =
    await Promise.all([
      prisma.tag.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { contacts: true } } } }),
      prisma.emailTemplate.findMany({ orderBy: { name: "asc" } }),
      prisma.campaign.findMany({ orderBy: { createdAt: "desc" }, take: 30, include: { createdBy: true } }),
      isSmtpConfigured(),
      isSmsConfigured(),
      prisma.contact.count({ where: { marketingOptOut: false } }),
      prisma.contact.count({ where: { marketingOptOut: false, vehicles: { some: { deletedAt: null } } } }),
    ]);

  const audiences = [
    { value: "all", label: `All customers (${allCount})` },
    { value: "vehicle_owners", label: `Vehicle owners (${vehicleOwnerCount})` },
    ...tags.map((t) => ({ value: `tag:${t.id}`, label: `Tag: ${t.name} (${t._count.contacts})` })),
  ];

  // Preview templates with neutral placeholders so subjects/bodies read sensibly
  const sampleVars = contactVars({ firstName: "there", lastName: "" });
  const renderedTemplates = templates.map((t) => ({
    id: t.id,
    subject: renderTemplate(t.subject, sampleVars),
    body: renderTemplate(t.body, sampleVars),
  }));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Campaigns</h1>
        <p className="text-sm text-slate-400 mt-0.5">
          Bulk email or SMS to a customer segment. Opted-out customers are always excluded.
        </p>
      </div>

      {!smtpConfigured && !smsConfigured && (
        <div className="card border-amber-500/30 text-sm text-amber-300">
          Neither email nor SMS is configured yet — set them up in Settings before sending.
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <CampaignComposer
          audiences={audiences}
          templates={renderedTemplates}
          smtpConfigured={smtpConfigured}
          smsConfigured={smsConfigured}
        />

        <div className="card p-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 px-4 pt-4">
            Recent campaigns
          </p>
          {campaigns.length === 0 ? (
            <p className="text-sm text-slate-400 p-4">No campaigns sent yet.</p>
          ) : (
            <ul className="divide-y divide-slate-800 mt-2">
              {campaigns.map((c) => (
                <li key={c.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-sm font-medium">{c.name}</span>
                    <span className="badge bg-slate-800 text-slate-300 uppercase">{c.channel}</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {c.audience} · {c.sentCount}/{c.recipientCount} sent
                    {c.failedCount ? ` · ${c.failedCount} failed` : ""} ·{" "}
                    {c.sentAt?.toLocaleDateString("en-ZA") ?? "—"}
                    {c.createdBy ? ` · ${c.createdBy.name}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
