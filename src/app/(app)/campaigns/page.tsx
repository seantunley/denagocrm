import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import Tabs from "@/components/Tabs";
import CampaignComposer from "@/components/CampaignComposer";
import SegmentBuilder from "@/components/SegmentBuilder";
import TemplateManager from "@/components/TemplateManager";
import { isSmtpConfigured } from "@/lib/email";
import { isSmsConfigured } from "@/lib/sms";
import { resolveContacts, type SegmentCriteria } from "@/lib/campaigns";
import { deleteSegment, setMarketingOptOut } from "@/app/actions/campaigns";
import { contactName, formatDateTime } from "@/lib/format";

// First send batch runs inside the send action — give it room.
export const maxDuration = 60;

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-slate-800 text-slate-400",
  queued: "bg-sky-500/15 text-sky-300",
  sending: "bg-amber-500/15 text-amber-300",
  sent: "bg-emerald-500/15 text-emerald-300",
};

function criteriaSummary(c: SegmentCriteria): string {
  const parts: string[] = [];
  if (c.source) parts.push(`source ${c.source}`);
  if (c.tagId) parts.push("tagged");
  if (c.province) parts.push(c.province);
  if (c.hasVehicle) parts.push("owns cart");
  if (c.serviceDue) parts.push("service due");
  if (c.wonOnly) parts.push("bought before");
  return parts.join(" · ") || "all subscribers";
}

export default async function CampaignsPage() {
  await requireUser();
  const [
    tags,
    templates,
    segmentsRaw,
    campaigns,
    subscribed,
    unsubscribed,
    reachable,
    optedOut,
    agg,
    smtpConfigured,
    smsConfigured,
  ] = await Promise.all([
    prisma.tag.findMany({ orderBy: { name: "asc" } }),
    prisma.emailTemplate.findMany({ orderBy: { name: "asc" } }),
    prisma.segment.findMany({ orderBy: { name: "asc" } }),
    prisma.campaign.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { createdBy: true } }),
    prisma.contact.findMany({
      where: { marketingOptOut: false, OR: [{ email: { not: null } }, { phone: { not: null } }] },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.contact.findMany({ where: { marketingOptOut: true }, orderBy: { updatedAt: "desc" }, take: 200 }),
    prisma.contact.count({ where: { marketingOptOut: false } }),
    prisma.contact.count({ where: { marketingOptOut: true } }),
    prisma.campaign.aggregate({ _sum: { sentCount: true, openCount: true, clickCount: true }, _count: true }),
    isSmtpConfigured(),
    isSmsConfigured(),
  ]);

  const segments = await Promise.all(
    segmentsRaw.map(async (s) => {
      const criteria = JSON.parse(s.criteria) as SegmentCriteria;
      return { id: s.id, name: s.name, criteria, count: (await resolveContacts(criteria, "any")).length };
    })
  );

  const totalSent = agg._sum.sentCount ?? 0;
  const openRate = totalSent > 0 ? Math.round(((agg._sum.openCount ?? 0) / totalSent) * 100) : 0;
  const clickRate = totalSent > 0 ? Math.round(((agg._sum.clickCount ?? 0) / totalSent) * 100) : 0;

  const configWarning =
    !smtpConfigured && !smsConfigured ? (
      <div className="card border-amber-500/30 text-sm text-amber-300">
        Neither email nor SMS is configured yet — set them up in Settings before sending.
      </div>
    ) : null;

  // ---- Tab: New campaign ----
  const newCampaign = (
    <div className="space-y-4">
      {configWarning}
      <CampaignComposer
        templates={templates.map((t) => ({ id: t.id, subject: t.subject, body: t.body }))}
        segments={segments.map((s) => ({ id: s.id, name: `${s.name} (${s.count})` }))}
        smtpConfigured={smtpConfigured}
        smsConfigured={smsConfigured}
      />
    </div>
  );

  // ---- Tab: Campaigns list ----
  const campaignsList = (
    <div className="card p-0 overflow-x-auto">
      <table className="table-base">
        <thead>
          <tr>
            <th>Status</th>
            <th>Name</th>
            <th>Audience</th>
            <th className="text-right">Sent</th>
            <th className="text-right">Opened</th>
            <th className="text-right">Clicked</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {campaigns.length === 0 && (
            <tr><td colSpan={7} className="text-center text-slate-400 py-8">No campaigns yet.</td></tr>
          )}
          {campaigns.map((c) => {
            const oRate = c.sentCount > 0 ? Math.round((c.openCount / c.sentCount) * 100) : 0;
            const cRate = c.sentCount > 0 ? Math.round((c.clickCount / c.sentCount) * 100) : 0;
            return (
              <tr key={c.id}>
                <td><span className={`badge ${STATUS_BADGE[c.status] ?? "bg-slate-800"}`}>{c.status}</span></td>
                <td>
                  <Link href={`/campaigns/${c.id}`} className="font-medium text-orange-400 hover:underline">{c.name}</Link>
                  <span className="text-xs text-slate-500 ml-2 uppercase">{c.channel}</span>
                </td>
                <td className="text-slate-400">{c.audience}</td>
                <td className="text-right">{c.sentCount}/{c.recipientCount}</td>
                <td className="text-right">{c.channel === "email" && c.sentCount > 0 ? `${oRate}%` : "—"}</td>
                <td className="text-right">{c.channel === "email" && c.sentCount > 0 ? `${cRate}%` : "—"}</td>
                <td className="text-slate-400 text-xs">{formatDateTime(c.createdAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  // ---- Tab: Audiences ----
  const audiences = (
    <div className="space-y-4">
      <SegmentBuilder tags={tags.map((t) => ({ id: t.id, name: t.name }))} />
      <div className="card p-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 px-4 pt-4">Saved audiences</p>
        {segments.length === 0 ? (
          <p className="text-sm text-slate-400 p-4">No saved audiences yet — build one above.</p>
        ) : (
          <ul className="divide-y divide-slate-800 mt-2">
            {segments.map((s) => (
              <li key={s.id} className="px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{s.name}</p>
                  <p className="text-xs text-slate-400">{criteriaSummary(s.criteria)}</p>
                </div>
                <span className="text-sm text-slate-400">{s.count} recipient{s.count === 1 ? "" : "s"}</span>
                <form action={deleteSegment.bind(null, s.id)}>
                  <button className="btn-secondary btn-sm">Delete</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  // ---- Tab: Subscribers ----
  const subscribers = (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Subscribed</p><p className="text-2xl font-bold mt-1">{reachable}</p></div>
        <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Unsubscribed</p><p className="text-2xl font-bold mt-1">{optedOut}</p></div>
      </div>
      <p className="text-xs text-slate-500">
        Subscribers are customers who haven&apos;t opted out. They&apos;re the base every campaign
        draws from; opted-out customers are always excluded.
      </p>
      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Customer</th><th>Email</th><th>Phone</th><th></th></tr></thead>
          <tbody>
            {subscribed.length === 0 && (
              <tr><td colSpan={4} className="text-center text-slate-400 py-8">No subscribers yet.</td></tr>
            )}
            {subscribed.map((c) => (
              <tr key={c.id}>
                <td><Link href={`/contacts/${c.id}`} className="text-orange-400 hover:underline">{contactName(c)}</Link></td>
                <td className="text-slate-400">{c.email ?? "—"}</td>
                <td className="text-slate-400">{c.whatsapp ?? c.phone ?? "—"}</td>
                <td className="text-right">
                  <form action={setMarketingOptOut.bind(null, c.id, true)}>
                    <button className="btn-secondary btn-sm">Unsubscribe</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {unsubscribed.length > 0 && (
        <details className="card p-0">
          <summary className="px-4 py-3 text-sm font-medium cursor-pointer">Unsubscribed ({optedOut})</summary>
          <ul className="divide-y divide-slate-800">
            {unsubscribed.map((c) => (
              <li key={c.id} className="px-4 py-2.5 flex items-center gap-3">
                <span className="flex-1 min-w-0 text-sm">
                  <Link href={`/contacts/${c.id}`} className="text-orange-400 hover:underline">{contactName(c)}</Link>
                  <span className="text-xs text-slate-500 ml-2">{c.email ?? c.phone ?? ""}</span>
                </span>
                <form action={setMarketingOptOut.bind(null, c.id, false)}>
                  <button className="btn-secondary btn-sm">Resubscribe</button>
                </form>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );

  // ---- Tab: Templates ----
  const templatesTab = (
    <TemplateManager templates={templates.map((t) => ({ id: t.id, name: t.name, subject: t.subject, body: t.body }))} />
  );

  // ---- Tab: Analytics ----
  const analytics = (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Campaigns</p><p className="text-2xl font-bold mt-1">{agg._count}</p></div>
        <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Messages sent</p><p className="text-2xl font-bold mt-1">{totalSent}</p></div>
        <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Avg open rate</p><p className="text-2xl font-bold mt-1">{openRate}%</p></div>
        <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Avg click rate</p><p className="text-2xl font-bold mt-1">{clickRate}%</p></div>
        <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Subscribers</p><p className="text-2xl font-bold mt-1">{reachable}</p></div>
        <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Unsubscribed</p><p className="text-2xl font-bold mt-1">{optedOut}</p></div>
      </div>
      <p className="text-xs text-slate-500">
        Open rates are approximate (mail privacy features auto-load or block the tracking pixel).
        Clicks are the reliable signal. Per-campaign detail is on each campaign&apos;s page.
      </p>
      <div className="card p-0 overflow-x-auto">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 px-4 pt-4">Recent email campaigns</p>
        <table className="table-base mt-2">
          <thead><tr><th>Campaign</th><th className="text-right">Sent</th><th className="text-right">Open %</th><th className="text-right">Click %</th></tr></thead>
          <tbody>
            {campaigns.filter((c) => c.channel === "email").slice(0, 10).map((c) => (
              <tr key={c.id}>
                <td><Link href={`/campaigns/${c.id}`} className="text-orange-400 hover:underline">{c.name}</Link></td>
                <td className="text-right">{c.sentCount}</td>
                <td className="text-right">{c.sentCount > 0 ? Math.round((c.openCount / c.sentCount) * 100) : 0}%</td>
                <td className="text-right">{c.sentCount > 0 ? Math.round((c.clickCount / c.sentCount) * 100) : 0}%</td>
              </tr>
            ))}
            {campaigns.filter((c) => c.channel === "email").length === 0 && (
              <tr><td colSpan={4} className="text-center text-slate-400 py-6">No email campaigns yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Campaigns</h1>
        <p className="text-sm text-slate-400 mt-0.5">
          Email &amp; SMS marketing — audiences, templates, sending and analytics.
        </p>
      </div>
      <Tabs
        tabs={[
          { key: "new", label: "New campaign", content: newCampaign },
          { key: "campaigns", label: "Campaigns", count: campaigns.length, content: campaignsList },
          { key: "audiences", label: "Audiences", count: segments.length, content: audiences },
          { key: "subscribers", label: "Subscribers", count: reachable, content: subscribers },
          { key: "templates", label: "Templates", count: templates.length, content: templatesTab },
          { key: "analytics", label: "Analytics", content: analytics },
        ]}
      />
    </div>
  );
}
