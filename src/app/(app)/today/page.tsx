import Link from "next/link";
import { Sun } from "lucide-react";
import {
  CUSTOMER_RECORD_WRITE_PERMISSIONS,
  getAccessibleContactIds,
  hasAnyPermission,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { loadTodayLeads, TODAY_CANDIDATE_CAP } from "@/lib/leadScoreLoader";
import { formatZAR } from "@/lib/format";
import { prisma } from "@/lib/db";
import { withCurrency } from "@/lib/currencyRules";
import { getRegionalSettings } from "@/lib/settings";
import { isSmtpConfigured } from "@/lib/email";
import { isWhatsAppConfigured } from "@/lib/whatsapp";
import { getCompanyProfile } from "@/lib/companyProfile";
import { addWorkingDays, defaultChannel, nextStepDefault, todayChannels, todayDrafts } from "@/lib/todayAction";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/visual-system";
import { LeadScoreBadge } from "@/components/LeadScoreBadge";
import TodayRow from "@/components/TodayRow";

/**
 * Today — who to contact next, best first.
 *
 * Where the Attention Centre lists everything that is WRONG with a deal, this
 * ranks the deals most worth a rep's next call, engagement first (see
 * src/lib/leadScore.ts). Each row says why it is here and what to do, because a
 * ranked list without reasons is a list nobody trusts.
 *
 * And each row DOES it (Sean, 2026-11-06): its button opens a composer under the
 * row — call log, WhatsApp or email — with the deal's context filled in, logs or
 * sends on one click, books the next step and leaves the list (lib/todayAction.ts).
 */

/** A day's worth of calls, not the whole pipeline. */
const SHOWN = 50;

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  // The same guard `/leads` and `/leads/attention` use: this page shows customer
  // names and deal values, so it is exactly as sensitive as the board.
  const user = await requireAnyPermission("leads.view_all", "leads.view_owned");
  const { view } = await searchParams;
  const mine = view !== "all";
  const now = new Date();
  const { leads, truncated } = await loadTodayLeads(user, { mine }, now);
  const shown = leads.slice(0, SHOWN);

  const leadIds = shown.map((lead) => lead.id);
  // Only customers this viewer may open — the lead page's rule. A customer's own
  // WhatsApps would otherwise leak their timing through whether WhatsApp is offered.
  const openableContacts = await getAccessibleContactIds(user);
  const contactIds = [
    ...new Set(
      shown
        .map((lead) => lead.contactId)
        .filter((id): id is string => Boolean(id) && (openableContacts === null || openableContacts.includes(id as string))),
    ),
  ];
  const [canWriteRecord, canWhatsApp, canSchedule, smtpConfigured, whatsappConfigured, company, quotes, waByLead, waByContact, moneyFmt] =
    await Promise.all([
      // What addCommunication and sendEmailAction require; what sendWhatsAppMessage requires; what scheduleFollowUp requires.
      hasAnyPermission(user, ...CUSTOMER_RECORD_WRITE_PERMISSIONS),
      hasPermission(user, "inbox.reply"),
      hasPermission(user, "activities.manage"),
      isSmtpConfigured(),
      isWhatsAppConfigured(),
      getCompanyProfile(),
      leadIds.length
        ? prisma.quote.findMany({
            where: { leadId: { in: leadIds }, deletedAt: null, status: "sent", signedAt: null, supersededAt: null },
            select: { leadId: true, number: true },
            orderBy: { createdAt: "desc" },
          })
        : [],
      // WhatsApp's 24 hours run from the customer's last WhatsApp, on whichever record it was filed.
      leadIds.length
        ? prisma.communication.groupBy({ by: ["leadId"], where: { leadId: { in: leadIds }, type: "whatsapp", direction: "inbound" }, _max: { occurredAt: true } })
        : [],
      contactIds.length
        ? prisma.communication.groupBy({ by: ["contactId"], where: { contactId: { in: contactIds }, type: "whatsapp", direction: "inbound" }, _max: { occurredAt: true } })
        : [],
      getRegionalSettings(),
    ]);
  const quoteOf = new Map<string, number>();
  for (const quote of quotes) if (quote.leadId && !quoteOf.has(quote.leadId)) quoteOf.set(quote.leadId, quote.number);
  const waLead = new Map(waByLead.map((row) => [row.leadId as string, row._max.occurredAt]));
  const waContact = new Map(waByContact.map((row) => [row.contactId as string, row._max.occurredAt]));
  const senderFirstName = user.name.trim().split(/\s+/)[0] || user.name;
  const retryDate = addWorkingDays(now, 1);

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Sun className="size-5 text-primary" />
            Today
          </span>
        }
        description="Open deals most worth contacting next — customers who just engaged first, then anything slipping. Each button does the job here: log the call or send the message, and the next step is booked."
      />

      <nav className="flex flex-wrap gap-2" aria-label="Whose deals">
        <Link href="/today" className={mine ? "btn-primary btn-sm" : "btn-secondary btn-sm"}>Mine</Link>
        <Link href="/today?view=all" className={mine ? "btn-secondary btn-sm" : "btn-primary btn-sm"}>
          Everyone I can see
        </Link>
      </nav>

      {truncated && (
        <p className="text-xs text-muted-foreground">
          Ranked from the {TODAY_CANDIDATE_CAP} most recently updated open deals.
        </p>
      )}

      {shown.length === 0 ? (
        <EmptyState
          icon={Sun}
          title="Nothing to chase right now."
          description={
            mine
              ? "None of your open deals has a reason to contact them today."
              : "No open deal you can see has a reason to contact them today."
          }
          action={
            mine ? (
              <Link href="/today?view=all" className="btn-secondary btn-sm">Show everyone I can see</Link>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-2">
          {shown.map((lead) => {
            const wa = [waLead.get(lead.id), lead.contactId ? waContact.get(lead.contactId) : null]
              .filter((at): at is Date => Boolean(at))
              .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
            const channels = todayChannels({
              email: lead.email,
              phone: lead.phone,
              lastWhatsAppInboundAt: wa,
              canWriteRecord,
              canWhatsApp,
              smtpConfigured,
              whatsappConfigured,
              now,
            });
            const quoteNumber = quoteOf.get(lead.id) ?? null;
            return (
              <TodayRow
                key={lead.id}
                leadId={lead.id}
                action={lead.action}
                channels={channels}
                initialChannel={defaultChannel(lead.action, channels)}
                email={lead.email}
                phone={lead.phone}
                drafts={todayDrafts({
                  action: lead.action,
                  firstName: lead.firstName,
                  opportunity: lead.opportunity,
                  quoteNumber,
                  senderFirstName,
                  company: company.name,
                })}
                nextStep={canSchedule ? nextStepDefault(lead.action, now, quoteNumber) : null}
                retryDate={retryDate}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <LeadScoreBadge score={lead.score} />
                    <Link href={`/leads/${lead.id}`} className="truncate font-semibold hover:underline">
                      {lead.name}
                    </Link>
                    <span className="text-xs text-muted-foreground">{lead.stageName}</span>
                    {lead.valueCents > 0 && (
                      <span className="text-xs tabular-nums text-muted-foreground">{formatZAR(lead.valueCents, withCurrency(moneyFmt, lead.currency))}</span>
                    )}
                  </div>
                  {lead.opportunity && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{lead.opportunity}</p>
                  )}
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {lead.reasons.map((reason) => (
                      <li key={reason} className="rounded-md border border-border/60 px-2 py-0.5 text-xs text-foreground/80">
                        {reason}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {lead.assignedToName ? `Owner: ${lead.assignedToName}` : "Unassigned"}
                  </p>
                </div>
              </TodayRow>
            );
          })}
        </ul>
      )}
    </div>
  );
}
