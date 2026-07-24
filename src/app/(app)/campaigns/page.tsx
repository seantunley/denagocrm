import Link from "next/link";
import { redirect } from "next/navigation";
import {
  BarChart3,
  CheckCircle2,
  CircleOff,
  Mail,
  MailOpen,
  Megaphone,
  MessageSquareText,
  MousePointerClick,
  Plus,
  Send,
  Settings2,
  UserRoundCheck,
  UsersRound,
} from "lucide-react";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { resolveActingTenant } from "@/lib/tenantContext";
import Tabs from "@/components/Tabs";
import CampaignComposer from "@/components/CampaignComposer";
import SegmentBuilder from "@/components/SegmentBuilder";
import TemplateManager from "@/components/TemplateManager";
import { isSmtpConfigured } from "@/lib/email";
import { isSmsConfigured } from "@/lib/sms";
import { resolveContacts, type SegmentCriteria } from "@/lib/campaigns";
import { deleteSegment, setMarketingOptOut } from "@/app/actions/campaigns";
import { contactName, formatDateTime } from "@/lib/format";
import {
  MobileDataCard,
  MobileDataField,
  MobileDataFields,
  MobileDataHeader,
  MobileDataList,
  ResponsiveDataView,
} from "@/components/responsive-patterns";
import {
  EmptyState,
  FeedbackBanner,
  SectionHeading,
  StatusPill,
  Surface,
} from "@/components/visual-system";
import { WorkspaceHero } from "@/components/workspace-hero";
import RecordContextMenu from "@/components/RecordContextMenu";

// First send batch runs inside the send action — give it room.
export const maxDuration = 60;

const CAMPAIGN_TABS = ["overview", "new", "audiences", "subscribers", "templates"];

function percentage(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function criteriaSummary(criteria: SegmentCriteria): string {
  const parts: string[] = [];
  if (criteria.source) parts.push(`Source: ${criteria.source}`);
  if (criteria.tagId) parts.push("Tagged");
  if (criteria.province) parts.push(criteria.province);
  if (criteria.hasVehicle) parts.push("Owns a cart");
  if (criteria.serviceDue) parts.push("Service due");
  if (criteria.wonOnly) parts.push("Bought before");
  return parts.join(" · ") || "All opted-in subscribers";
}

function campaignTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "sent") return "success";
  if (status === "sending") return "warning";
  if (status === "failed") return "danger";
  if (status === "queued") return "info";
  return "neutral";
}

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await requireUser();
  const tenant = await resolveActingTenant(user.id);
  if ("error" in tenant) redirect("/");
  const tenantId = tenant.tenantId;
  const { tab } = await searchParams;
  const initialTab = tab && CAMPAIGN_TABS.includes(tab) ? tab : "overview";

  const [
    tags,
    templates,
    segmentsRaw,
    campaigns,
    subscribed,
    unsubscribed,
    reachable,
    optedOut,
    aggregate,
    smtpConfigured,
    smsConfigured,
  ] = await Promise.all([
    prisma.tag.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.emailTemplate.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.segment.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.campaign.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { createdBy: true },
    }),
    prisma.contact.findMany({
      where: {
        tenantId,
        marketingOptOut: false,
        OR: [{ email: { not: null } }, { phone: { not: null } }],
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.contact.findMany({
      where: { tenantId, marketingOptOut: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    }),
    prisma.contact.count({ where: { tenantId, marketingOptOut: false } }),
    prisma.contact.count({ where: { tenantId, marketingOptOut: true } }),
    prisma.campaign.aggregate({
      where: { tenantId },
      _sum: {
        recipientCount: true,
        sentCount: true,
        failedCount: true,
        openCount: true,
        clickCount: true,
      },
      _count: true,
    }),
    isSmtpConfigured(),
    isSmsConfigured(),
  ]);

  const segments = await Promise.all(
    segmentsRaw.map(async (segment) => {
      const criteria = JSON.parse(segment.criteria) as SegmentCriteria;
      return {
        id: segment.id,
        name: segment.name,
        criteria,
        count: (await resolveContacts(tenantId, criteria, "any")).length,
      };
    }),
  );

  const totalRecipients = aggregate._sum.recipientCount ?? 0;
  const totalSent = aggregate._sum.sentCount ?? 0;
  const totalFailed = aggregate._sum.failedCount ?? 0;
  const openRate = percentage(aggregate._sum.openCount ?? 0, totalSent);
  const clickRate = percentage(aggregate._sum.clickCount ?? 0, totalSent);
  const deliveryRate = percentage(totalSent, totalRecipients);
  const optOutRate = percentage(optedOut, reachable + optedOut);
  const activeCampaigns = campaigns.filter((campaign) =>
    ["queued", "sending"].includes(campaign.status),
  );
  const emailCampaigns = campaigns.filter((campaign) => campaign.channel === "email");

  const configurationWarning =
    !smtpConfigured && !smsConfigured ? (
      <FeedbackBanner
        tone="warning"
        title="No sending channel is configured"
      >
        Connect email or SMS in Settings before launching a campaign.
      </FeedbackBanner>
    ) : null;

  const campaignsList =
    campaigns.length === 0 ? (
      <EmptyState
        icon={Megaphone}
        title="No campaigns yet"
        description="Build your first campaign, choose an opted-in audience and start measuring engagement."
        action={
          <Link href="/campaigns?tab=new" className="btn-primary">
            <Plus className="size-4" />
            Create campaign
          </Link>
        }
      />
    ) : (
      <ResponsiveDataView
        mobile={
          <MobileDataList>
            {campaigns.map((campaign) => {
              const delivered = percentage(campaign.sentCount, campaign.recipientCount);
              const campaignOpenRate = percentage(campaign.openCount, campaign.sentCount);
              const campaignClickRate = percentage(campaign.clickCount, campaign.sentCount);
              const ChannelIcon = campaign.channel === "email" ? Mail : MessageSquareText;

              return (
                <RecordContextMenu
                  key={campaign.id}
                  label={campaign.name}
                  href={`/campaigns/${campaign.id}`}
                >
                  <MobileDataCard>
                    <MobileDataHeader
                      title={
                        <Link href={`/campaigns/${campaign.id}`} className="text-primary">
                          {campaign.name}
                        </Link>
                      }
                      detail={
                        <span className="flex items-center gap-1.5">
                          <ChannelIcon className="size-3.5" />
                          {campaign.channel === "email" ? "Email" : "SMS"} · {campaign.audience}
                        </span>
                      }
                      aside={
                        <StatusPill tone={campaignTone(campaign.status)}>
                          {campaign.status}
                        </StatusPill>
                      }
                    />
                    <div>
                      <div className="mb-1.5 flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Delivery progress</span>
                        <span className="font-medium tabular-nums">{delivered}%</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${Math.min(delivered, 100)}%` }}
                        />
                      </div>
                    </div>
                    <MobileDataFields>
                      <MobileDataField label="Delivered">
                        {campaign.sentCount}/{campaign.recipientCount}
                      </MobileDataField>
                      <MobileDataField label="Created">
                        {formatDateTime(campaign.createdAt)}
                      </MobileDataField>
                      {campaign.channel === "email" && (
                        <MobileDataField label="Opened">{campaignOpenRate}%</MobileDataField>
                      )}
                      {campaign.channel === "email" && (
                        <MobileDataField label="Clicked">{campaignClickRate}%</MobileDataField>
                      )}
                    </MobileDataFields>
                    <Link href={`/campaigns/${campaign.id}`} className="btn-secondary w-full">
                      View performance
                    </Link>
                  </MobileDataCard>
                </RecordContextMenu>
              );
            })}
          </MobileDataList>
        }
        desktop={
          <Surface className="p-0">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Audience</th>
                  <th>Delivery</th>
                  <th>Engagement</th>
                  <th>Created</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => {
                  const delivered = percentage(campaign.sentCount, campaign.recipientCount);
                  const campaignOpenRate = percentage(campaign.openCount, campaign.sentCount);
                  const campaignClickRate = percentage(campaign.clickCount, campaign.sentCount);
                  const ChannelIcon = campaign.channel === "email" ? Mail : MessageSquareText;

                  return (
                    <RecordContextMenu
                      key={campaign.id}
                      label={campaign.name}
                      href={`/campaigns/${campaign.id}`}
                    >
                      <tr
                        tabIndex={0}
                        className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                      >
                        <td>
                          <div className="flex items-center gap-3">
                            <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-muted/35 text-muted-foreground">
                              <ChannelIcon className="size-4" />
                            </span>
                            <div className="min-w-0">
                              <Link
                                href={`/campaigns/${campaign.id}`}
                                className="font-medium text-foreground hover:text-primary"
                              >
                                {campaign.name}
                              </Link>
                              <p className="mt-0.5 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                                {campaign.channel}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="max-w-[15rem] text-muted-foreground">
                          <span className="line-clamp-2">{campaign.audience}</span>
                        </td>
                        <td>
                          <div className="min-w-32">
                            <div className="flex justify-between text-xs">
                              <span className="tabular-nums">
                                {campaign.sentCount}/{campaign.recipientCount}
                              </span>
                              <span className="text-muted-foreground">{delivered}%</span>
                            </div>
                            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{ width: `${Math.min(delivered, 100)}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td>
                          {campaign.channel === "email" ? (
                            <div className="flex gap-2">
                              <span className="rounded-lg bg-muted/50 px-2 py-1 text-xs">
                                <span className="text-muted-foreground">Open</span>{" "}
                                <strong className="tabular-nums">{campaignOpenRate}%</strong>
                              </span>
                              <span className="rounded-lg bg-muted/50 px-2 py-1 text-xs">
                                <span className="text-muted-foreground">Click</span>{" "}
                                <strong className="tabular-nums">{campaignClickRate}%</strong>
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">Delivery only</span>
                          )}
                        </td>
                        <td>
                          <p className="text-xs">{formatDateTime(campaign.createdAt)}</p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {campaign.createdBy?.name ?? "Unknown owner"}
                          </p>
                        </td>
                        <td>
                          <StatusPill tone={campaignTone(campaign.status)}>
                            {campaign.status}
                          </StatusPill>
                        </td>
                      </tr>
                    </RecordContextMenu>
                  );
                })}
              </tbody>
            </table>
          </Surface>
        }
      />
    );

  const overview = (
    <div className="space-y-6">
      {configurationWarning}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(18rem,.6fr)]">
        <Surface className="p-5">
          <SectionHeading
            title="Delivery and engagement"
            description="All-time performance across email and SMS campaigns."
            action={<BarChart3 className="size-5 text-primary" />}
          />
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              {
                label: "Delivery rate",
                value: `${deliveryRate}%`,
                detail: `${totalSent.toLocaleString("en-ZA")} delivered`,
              },
              {
                label: "Failed",
                value: totalFailed.toLocaleString("en-ZA"),
                detail: totalFailed ? "Review campaign details" : "No failures recorded",
              },
              {
                label: "Email opens",
                value: `${openRate}%`,
                detail: `${emailCampaigns.length} email campaigns`,
              },
              {
                label: "Click-through",
                value: `${clickRate}%`,
                detail: "Most reliable intent signal",
              },
            ].map((metric) => (
              <div key={metric.label} className="rounded-xl border border-border/70 bg-muted/[0.16] p-3">
                <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {metric.label}
                </p>
                <p className="mt-2 text-xl font-semibold tracking-[-0.04em] tabular-nums">
                  {metric.value}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">{metric.detail}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[11px] leading-5 text-muted-foreground">
            Open rates are approximate because mail privacy features may preload or block
            tracking pixels. Clicks remain the stronger engagement signal.
          </p>
        </Surface>

        <Surface className="p-5">
          <SectionHeading
            title="Channel readiness"
            description="Sending infrastructure and audience consent."
            action={<Settings2 className="size-5 text-muted-foreground" />}
          />
          <div className="mt-5 space-y-2">
            {[
              { label: "Email", ready: smtpConfigured, icon: Mail },
              { label: "SMS", ready: smsConfigured, icon: MessageSquareText },
            ].map(({ label, ready, icon: Icon }) => (
              <div
                key={label}
                className="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/[0.16] p-3"
              >
                <span
                  className={`grid size-9 place-items-center rounded-xl border ${
                    ready
                      ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
                      : "border-border bg-muted/40 text-muted-foreground"
                  }`}
                >
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">
                    {ready ? "Connected and ready" : "Needs configuration"}
                  </p>
                </div>
                <StatusPill tone={ready ? "success" : "warning"}>
                  {ready ? "Ready" : "Off"}
                </StatusPill>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between rounded-xl border border-border/70 bg-muted/[0.16] p-3">
            <div>
              <p className="text-sm font-medium">Consent health</p>
              <p className="text-xs text-muted-foreground">
                {optOutRate}% of known subscribers opted out
              </p>
            </div>
            <StatusPill tone={optOutRate > 10 ? "warning" : "success"}>
              {reachable.toLocaleString("en-ZA")} reachable
            </StatusPill>
          </div>
        </Surface>
      </div>

      <div>
        <SectionHeading
          title="Recent campaigns"
          description="Monitor delivery, engagement and campaign ownership in one view."
          action={
            activeCampaigns.length ? (
              <StatusPill tone="warning">{activeCampaigns.length} in progress</StatusPill>
            ) : (
              <StatusPill tone="success">Queue clear</StatusPill>
            )
          }
          className="mb-4"
        />
        {campaignsList}
      </div>
    </div>
  );

  const newCampaign = (
    <div className="space-y-4">
      {configurationWarning}
      <CampaignComposer
        templates={templates.map((template) => ({
          id: template.id,
          subject: template.subject,
          body: template.body,
        }))}
        segments={segments.map((segment) => ({
          id: segment.id,
          name: `${segment.name} (${segment.count})`,
        }))}
        smtpConfigured={smtpConfigured}
        smsConfigured={smsConfigured}
      />
    </div>
  );

  const audiences = (
    <div className="space-y-6">
      <SegmentBuilder tags={tags.map((tag) => ({ id: tag.id, name: tag.name }))} />
      <div>
        <SectionHeading
          title="Saved audiences"
          description="Reusable customer groups for consistent campaign targeting."
          action={<StatusPill tone="info">{segments.length} saved</StatusPill>}
          className="mb-4"
        />
        {segments.length === 0 ? (
          <EmptyState
            icon={UsersRound}
            title="No saved audiences"
            description="Build an audience above using customer source, tags, province or lifecycle signals."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {segments.map((segment) => (
              <Surface key={segment.id} className="p-4">
                <div className="flex items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                    <UsersRound className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{segment.name}</p>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                      {criteriaSummary(segment.criteria)}
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">{segment.count}</span>
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-border/70 pt-3">
                  <span className="text-[11px] text-muted-foreground">
                    recipient{segment.count === 1 ? "" : "s"}
                  </span>
                  <form action={deleteSegment.bind(null, segment.id)}>
                    <button className="btn-secondary btn-sm">Delete</button>
                  </form>
                </div>
              </Surface>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const subscribers = (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          {
            label: "Reachable",
            value: reachable,
            detail: "Available for targeting",
            icon: UserRoundCheck,
            tone: "text-emerald-300",
          },
          {
            label: "Opted out",
            value: optedOut,
            detail: "Always excluded",
            icon: CircleOff,
            tone: "text-muted-foreground",
          },
          {
            label: "Consent rate",
            value: `${100 - optOutRate}%`,
            detail: "Across known preferences",
            icon: CheckCircle2,
            tone: "text-primary",
          },
          {
            label: "Saved audiences",
            value: segments.length,
            detail: "Reusable segments",
            icon: UsersRound,
            tone: "text-sky-300",
          },
        ].map(({ label, value, detail, icon: Icon, tone }) => (
          <Surface key={label} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {label}
                </p>
                <p className={`mt-2 text-2xl font-semibold tracking-[-0.04em] tabular-nums ${tone}`}>
                  {typeof value === "number" ? value.toLocaleString("en-ZA") : value}
                </p>
              </div>
              <Icon className="size-4 text-muted-foreground" />
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>
          </Surface>
        ))}
      </div>

      <div>
        <SectionHeading
          title="Marketing subscribers"
          description="Only opted-in customers with a reachable email address or phone number are shown."
          className="mb-4"
        />
        <ResponsiveDataView
          mobile={
            subscribed.length === 0 ? (
              <EmptyState
                icon={UsersRound}
                title="No reachable subscribers"
                description="Add contact details and consent before creating a campaign."
              />
            ) : (
              <MobileDataList>
                {subscribed.map((contact) => (
                  <MobileDataCard key={contact.id}>
                    <MobileDataHeader
                      title={
                        <Link href={`/contacts/${contact.id}`} className="text-primary">
                          {contactName(contact)}
                        </Link>
                      }
                      detail={contact.email ?? contact.whatsapp ?? contact.phone ?? "No channel"}
                      aside={<StatusPill tone="success">Subscribed</StatusPill>}
                    />
                    <MobileDataFields>
                      <MobileDataField label="Email">{contact.email ?? "—"}</MobileDataField>
                      <MobileDataField label="Phone">
                        {contact.whatsapp ?? contact.phone ?? "—"}
                      </MobileDataField>
                    </MobileDataFields>
                    <form action={setMarketingOptOut.bind(null, contact.id, true)}>
                      <button className="btn-secondary w-full">Unsubscribe</button>
                    </form>
                  </MobileDataCard>
                ))}
              </MobileDataList>
            )
          }
          desktop={
            <Surface className="p-0">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {subscribed.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-10 text-center text-muted-foreground">
                        No reachable subscribers yet.
                      </td>
                    </tr>
                  )}
                  {subscribed.map((contact) => (
                    <tr key={contact.id}>
                      <td>
                        <Link
                          href={`/contacts/${contact.id}`}
                          className="font-medium text-foreground hover:text-primary"
                        >
                          {contactName(contact)}
                        </Link>
                      </td>
                      <td className="text-muted-foreground">{contact.email ?? "—"}</td>
                      <td className="text-muted-foreground">
                        {contact.whatsapp ?? contact.phone ?? "—"}
                      </td>
                      <td>
                        <StatusPill tone="success">Subscribed</StatusPill>
                      </td>
                      <td className="text-right">
                        <form action={setMarketingOptOut.bind(null, contact.id, true)}>
                          <button className="btn-secondary btn-sm">Unsubscribe</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Surface>
          }
        />
      </div>

      {unsubscribed.length > 0 && (
        <details className="overflow-hidden rounded-2xl border border-border bg-card">
          <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-medium">
            <span>Unsubscribed customers</span>
            <StatusPill>{optedOut}</StatusPill>
          </summary>
          <ul className="divide-y divide-border/50 border-t border-border">
            {unsubscribed.map((contact) => (
              <li key={contact.id} className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1 text-sm">
                  <Link href={`/contacts/${contact.id}`} className="text-primary hover:underline">
                    {contactName(contact)}
                  </Link>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {contact.email ?? contact.phone ?? ""}
                  </span>
                </span>
                <form action={setMarketingOptOut.bind(null, contact.id, false)}>
                  <button className="btn-secondary btn-sm">Resubscribe</button>
                </form>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <WorkspaceHero
        icon={Megaphone}
        eyebrow="Lifecycle marketing"
        title="Campaign centre"
        description="Build opted-in audiences, launch email or SMS campaigns and understand which messages create customer intent."
        stats={[
          {
            label: "Reachable audience",
            value: reachable.toLocaleString("en-ZA"),
            detail: `${optedOut.toLocaleString("en-ZA")} opted out`,
            icon: UsersRound,
          },
          {
            label: "Messages sent",
            value: totalSent.toLocaleString("en-ZA"),
            detail: `${aggregate._count} campaigns`,
            icon: Send,
            tone: "primary",
          },
          {
            label: "Average opens",
            value: `${openRate}%`,
            detail: "Email campaigns",
            icon: MailOpen,
            tone: "success",
          },
          {
            label: "Click-through",
            value: `${clickRate}%`,
            detail: "Tracked customer intent",
            icon: MousePointerClick,
            tone: "warning",
          },
        ]}
        actions={
          <>
            <Link href="/settings?tab=integrations" className="btn-secondary">
              <Settings2 className="size-4" />
              Channels
            </Link>
            <Link href="/campaigns?tab=new" className="btn-primary">
              <Plus className="size-4" />
              Create campaign
            </Link>
          </>
        }
      />

      <Tabs
        initialKey={initialTab}
        tabs={[
          { key: "overview", label: "Overview", content: overview },
          { key: "new", label: "Create campaign", content: newCampaign },
          { key: "audiences", label: "Audiences", count: segments.length, content: audiences },
          {
            key: "subscribers",
            label: "Subscribers",
            count: reachable,
            content: subscribers,
          },
          {
            key: "templates",
            label: "Templates",
            count: templates.length,
            content: (
              <TemplateManager
                templates={templates.map((template) => ({
                  id: template.id,
                  name: template.name,
                  subject: template.subject,
                  body: template.body,
                }))}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
