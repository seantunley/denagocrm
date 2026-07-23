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
import { PageHeader } from "@/components/page-header";
import { MobileDataCard, MobileDataField, MobileDataFields, MobileDataHeader, MobileDataList, ResponsiveDataView } from "@/components/responsive-patterns";
import { EmptyState, StatusPill } from "@/components/visual-system";
import { Megaphone } from "lucide-react";
import RecordContextMenu from "@/components/RecordContextMenu";

// First send batch runs inside the send action — give it room.
export const maxDuration = 60;

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
    campaigns.length === 0 ? <EmptyState icon={Megaphone} title="No campaigns yet" description="Create a campaign to start measuring delivery and engagement." /> : <ResponsiveDataView
      mobile={<MobileDataList>{campaigns.map((campaign) => {
        const openRate = campaign.sentCount > 0 ? Math.round((campaign.openCount / campaign.sentCount) * 100) : 0;
        const campaignClickRate = campaign.sentCount > 0 ? Math.round((campaign.clickCount / campaign.sentCount) * 100) : 0;
        return <RecordContextMenu key={campaign.id} label={campaign.name} href={`/campaigns/${campaign.id}`}><MobileDataCard>
          <MobileDataHeader
            title={<Link href={`/campaigns/${campaign.id}`} className="text-primary">{campaign.name}</Link>}
            detail={`${campaign.channel.toUpperCase()} · ${campaign.audience}`}
            aside={<StatusPill tone={campaign.status === "sent" ? "success" : campaign.status === "sending" ? "warning" : "info"}>{campaign.status}</StatusPill>}
          />
          <MobileDataFields>
            <MobileDataField label="Delivered">{campaign.sentCount}/{campaign.recipientCount}</MobileDataField>
            <MobileDataField label="Created">{formatDateTime(campaign.createdAt)}</MobileDataField>
            {campaign.channel === "email" && <MobileDataField label="Opened">{openRate}%</MobileDataField>}
            {campaign.channel === "email" && <MobileDataField label="Clicked">{campaignClickRate}%</MobileDataField>}
          </MobileDataFields>
          <Link href={`/campaigns/${campaign.id}`} className="btn-secondary w-full">View campaign</Link>
        </MobileDataCard></RecordContextMenu>;
      })}</MobileDataList>}
      desktop={<div className="card p-0 overflow-x-auto">
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
            <tr><td colSpan={7} className="text-center text-muted-foreground py-8">No campaigns yet.</td></tr>
          )}
          {campaigns.map((c) => {
            const oRate = c.sentCount > 0 ? Math.round((c.openCount / c.sentCount) * 100) : 0;
            const cRate = c.sentCount > 0 ? Math.round((c.clickCount / c.sentCount) * 100) : 0;
            return (
              <RecordContextMenu key={c.id} label={c.name} href={`/campaigns/${c.id}`}>
              <tr tabIndex={0} className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
                <td><StatusPill tone={c.status === "sent" ? "success" : c.status === "sending" ? "warning" : c.status === "queued" ? "info" : "neutral"}>{c.status}</StatusPill></td>
                <td>
                  <Link href={`/campaigns/${c.id}`} className="font-medium text-primary hover:underline">{c.name}</Link>
                  <span className="text-xs text-muted-foreground ml-2 uppercase">{c.channel}</span>
                </td>
                <td className="text-muted-foreground">{c.audience}</td>
                <td className="text-right">{c.sentCount}/{c.recipientCount}</td>
                <td className="text-right">{c.channel === "email" && c.sentCount > 0 ? `${oRate}%` : "—"}</td>
                <td className="text-right">{c.channel === "email" && c.sentCount > 0 ? `${cRate}%` : "—"}</td>
                <td className="text-muted-foreground text-xs">{formatDateTime(c.createdAt)}</td>
              </tr>
              </RecordContextMenu>
            );
          })}
        </tbody>
      </table>
    </div>}
    />
  );

  // ---- Tab: Audiences ----
  const audiences = (
    <div className="space-y-4">
      <SegmentBuilder tags={tags.map((t) => ({ id: t.id, name: t.name }))} />
      <div className="card p-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-4 pt-4">Saved audiences</p>
        {segments.length === 0 ? (
          <p className="text-sm text-muted-foreground p-4">No saved audiences yet — build one above.</p>
        ) : (
          <ul className="divide-y divide-border/50 mt-2">
            {segments.map((s) => (
              <li key={s.id} className="px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{s.name}</p>
                  <p className="text-xs text-muted-foreground">{criteriaSummary(s.criteria)}</p>
                </div>
                <span className="text-sm text-muted-foreground">{s.count} recipient{s.count === 1 ? "" : "s"}</span>
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
        <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Subscribed</p><p className="text-2xl font-semibold tracking-[-0.035em] mt-1">{reachable}</p></div>
        <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Unsubscribed</p><p className="text-2xl font-semibold tracking-[-0.035em] mt-1">{optedOut}</p></div>
      </div>
      <p className="text-xs text-muted-foreground">
        Subscribers are customers who haven&apos;t opted out. They&apos;re the base every campaign
        draws from; opted-out customers are always excluded.
      </p>
      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Customer</th><th>Email</th><th>Phone</th><th></th></tr></thead>
          <tbody>
            {subscribed.length === 0 && (
              <tr><td colSpan={4} className="text-center text-muted-foreground py-8">No subscribers yet.</td></tr>
            )}
            {subscribed.map((c) => (
              <tr key={c.id}>
                <td><Link href={`/contacts/${c.id}`} className="text-primary hover:underline">{contactName(c)}</Link></td>
                <td className="text-muted-foreground">{c.email ?? "—"}</td>
                <td className="text-muted-foreground">{c.whatsapp ?? c.phone ?? "—"}</td>
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
          <ul className="divide-y divide-border/50">
            {unsubscribed.map((c) => (
              <li key={c.id} className="px-4 py-2.5 flex items-center gap-3">
                <span className="flex-1 min-w-0 text-sm">
                  <Link href={`/contacts/${c.id}`} className="text-primary hover:underline">{contactName(c)}</Link>
                  <span className="text-xs text-muted-foreground ml-2">{c.email ?? c.phone ?? ""}</span>
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
        <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Campaigns</p><p className="text-2xl font-semibold tracking-[-0.035em] mt-1">{agg._count}</p></div>
        <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Messages sent</p><p className="text-2xl font-semibold tracking-[-0.035em] mt-1">{totalSent}</p></div>
        <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Avg open rate</p><p className="text-2xl font-semibold tracking-[-0.035em] mt-1">{openRate}%</p></div>
        <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Avg click rate</p><p className="text-2xl font-semibold tracking-[-0.035em] mt-1">{clickRate}%</p></div>
        <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Subscribers</p><p className="text-2xl font-semibold tracking-[-0.035em] mt-1">{reachable}</p></div>
        <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Unsubscribed</p><p className="text-2xl font-semibold tracking-[-0.035em] mt-1">{optedOut}</p></div>
      </div>
      <p className="text-xs text-muted-foreground">
        Open rates are approximate (mail privacy features auto-load or block the tracking pixel).
        Clicks are the reliable signal. Per-campaign detail is on each campaign&apos;s page.
      </p>
      <div className="card p-0 overflow-x-auto">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-4 pt-4">Recent email campaigns</p>
        <table className="table-base mt-2">
          <thead><tr><th>Campaign</th><th className="text-right">Sent</th><th className="text-right">Open %</th><th className="text-right">Click %</th></tr></thead>
          <tbody>
            {campaigns.filter((c) => c.channel === "email").slice(0, 10).map((c) => (
              <tr key={c.id}>
                <td><Link href={`/campaigns/${c.id}`} className="text-primary hover:underline">{c.name}</Link></td>
                <td className="text-right">{c.sentCount}</td>
                <td className="text-right">{c.sentCount > 0 ? Math.round((c.openCount / c.sentCount) * 100) : 0}%</td>
                <td className="text-right">{c.sentCount > 0 ? Math.round((c.clickCount / c.sentCount) * 100) : 0}%</td>
              </tr>
            ))}
            {campaigns.filter((c) => c.channel === "email").length === 0 && (
              <tr><td colSpan={4} className="text-center text-muted-foreground py-6">No email campaigns yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <PageHeader title="Campaigns" description={`${campaigns.length} campaigns · ${reachable} reachable subscribers · Email and SMS performance.`} />
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
