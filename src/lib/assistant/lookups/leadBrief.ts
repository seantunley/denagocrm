import "server-only";
import { z } from "zod";
import { prisma } from "../../db";
import { formatZAR } from "../../format";
import { withCurrency } from "../../currencyRules";
import { payableTotalCents } from "../../pricing";
import { nurtureReasonLabel } from "../../leadNurture";
import { listActingTenantStaff, resolveTenantActor } from "../../tenantActor";
import { WHO_LEGEND, messageAuthor, whoLogged } from "../../assistantWho";
import { OPENED_LEGEND, openedFact } from "../../emailOpenTracking";
import { quoteSends } from "../../quoteEmailStatus";
import { receiptFact } from "../../deliveryReceipts";
import { getRegionalSettings } from "../../settings";
import { isModuleEnabled } from "../../modules/enabled";
import { accessibleTestDriveWhere } from "../../testDriveAccess";
import { getAccessibleLeadIds, getAccessibleQuoteIds, hasAnyPermission } from "../../permissions";
import { leadBriefArgs } from "../../crmAssistantPlan";
import { ToolOutput, User, fuzzy, dateKey, daysAgo, clip, signingFor, viewedByCustomer, quoteFacts, refused } from "../lookupKit";
import { quoteContents } from "./quotes";
import { customersNamed, nearlyNamed } from "./customers";

/**
 * One lead in depth — what a colleague would read before saying "here's what
 * I'd do": the deal, every recent message both ways, its quotes (opened?
 * signed?), its activities and any research. Phone numbers and emails are left
 * out: nothing here needs them to reason, so they don't go to ChatGPT.
 */
export async function leadBrief(user: User, raw: z.infer<typeof leadBriefArgs>): Promise<ToolOutput> {
  const { lead: needle } = leadBriefArgs.parse(raw);
  const looksLikeId = /^c[a-z0-9]{20,}$/i.test(needle);
  // By name, or — for an id — the customer that id names (the bubble on a customer page).
  const customersFor = (ownId?: string | null) => (looksLikeId ? customersNamed(user, "", ownId ?? needle) : customersNamed(user, needle, ownId));
  const customersOnly = (customers: Awaited<ReturnType<typeof customersNamed>>, why: string): ToolOutput => ({
    truncated: false,
    rows: [],
    data: [{
      note: `${why} ${customers.length === 1 ? "A customer record matches" : `${customers.length} customer records match`}. There is no deal to report on — which stops nothing: a quote can be made for the customer directly (quote_build with the contactId; no lead is needed), and a note can go on them (customer_note with the contactId)${customers.length > 1 ? " — ask which one first" : ""}.`,
      customers,
    }],
  });
  // Someone who may open customers but not leads still has customers to ask
  // about. Refusing here, before looking, turned "you can't see leads" into "you
  // can't see this customer" — who they can.
  if (!(await hasAnyPermission(user, "leads.view_all", "leads.view_owned"))) {
    const customers = await customersFor();
    return customers.length ? customersOnly(customers, "You can't see leads here.") : refused("leads");
  }
  const ids = await getAccessibleLeadIds(user);
  const visible = ids === null ? {} : { id: { in: ids } };
  const matches = await prisma.lead.findMany({
    where: {
      deletedAt: null,
      ...visible,
      ...(looksLikeId
        // A lead id, or a customer's id (from the bubble on a customer page).
        ? { OR: [{ id: needle }, { contactId: needle }] }
        : {
            OR: [
              { name: fuzzy(needle) },
              { title: fuzzy(needle) },
              { contact: { OR: [{ firstName: fuzzy(needle) }, { lastName: fuzzy(needle) }] } },
            ],
          }),
    },
    orderBy: { updatedAt: "desc" },
    take: 5,
    select: { id: true, title: true, name: true, status: true, stage: { select: { name: true } } },
  });
  if (matches.length === 0) {
    // No lead — but the person may be a CUSTOMER with no deal (a service customer,
    // someone whose lead was deleted, the owner's own test record). Saying only
    // "no lead matches" read as "no such person", and left nothing to hang a note on.
    const customers = await customersFor();
    if (customers.length === 0) {
      // NOTHING by that exact name — but maybe by a close spelling (Sean, 2026-10-23: a voice note's "Werner
      // Killian" was the CRM's "Werner Kilian", and DAX said there was no such customer). Offered as a choice —
      // the closest few, not a request to spell it again (Sean, 2026-10-29: "clive jammim").
      const close = looksLikeId ? [] : await nearlyNamed(user, needle, ids);
      if (close.length) {
        const offer = close.slice(0, 3).map((match) => match.name).join(", or ");
        return {
          truncated: false,
          rows: [],
          data: [{
            note: `Nothing is named exactly "${needle}", but ${close.length === 1 ? "this name is close" : `these ${close.length} names are close, closest first`} — most likely the same person, misspelt (a voice note often is). Do NOT say there is no such customer, do NOT ask them to spell it or type it again, and do not act on a guess: offer ${close.length === 1 ? "it" : "them"} as a choice — "Did you mean ${offer}?" — and once they pick one, use lead_brief with its id.`,
            closeMatches: close,
          }],
        };
      }
      return { truncated: false, rows: [], data: [{ note: `No lead or customer you can see matches "${needle}".` }] };
    }
    return customersOnly(customers, `No lead you can see matches "${needle}".`);
  }
  // Several match ("Lisa"): read the likeliest — an open lead, the most recently
  // worked — in full, and name the rest. Stopping at a list of names left the
  // answer with no quotes or messages to answer from.
  const [best, ...others] = [...matches].sort((a, b) => Number(a.status !== "open") - Number(b.status !== "open"));

  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: best.id },
    select: {
      id: true, title: true, name: true, status: true, valueCents: true, currency: true, quantity: true, source: true,
      notes: true, research: true, researchedAt: true, createdAt: true, stageEnteredAt: true,
      wonAt: true, lostAt: true, lostReason: true,
      nurtureSince: true, nurtureReason: true, nurtureInterest: true, nurtureTrigger: true, nurtureReviewAt: true,
      contactId: true,
      stage: { select: { name: true } },
      product: { select: { name: true } },
      assignedTo: { select: { name: true } },
      createdBy: { select: { id: true, name: true } },
    },
  });
  // The lead's own messages and activities AND the customer's that aren't on any
  // lead: an inbound Messenger/Instagram message matches the customer first, and
  // the customer panel books follow-ups with no lead (leadIdle.ts counts both).
  // Not the customer's OTHER leads — those are other deals.
  const theirs = { OR: [{ leadId: lead.id }, ...(lead.contactId ? [{ contactId: lead.contactId, leadId: null }] : [])] };
  const [communications, activities] = await Promise.all([
    prisma.communication.findMany({
      where: theirs,
      orderBy: { occurredAt: "desc" },
      take: 15,
      select: {
        occurredAt: true, direction: true, type: true, subject: true, body: true, user: { select: { id: true, name: true } },
        // Whether an email we sent was opened (lib/emailOpenTracking.ts).
        openToken: true, messageId: true, seenAt: true, openCount: true,
        // …and whether the customer's mail server refused it (lib/emailBounce.ts).
        bouncedAt: true, bounceReason: true,
        // WhatsApp / Messenger: how far it got on their phone (lib/deliveryReceipts.ts).
        deliveredAt: true,
      },
    }),
    prisma.activity.findMany({
      where: theirs,
      orderBy: { dueDate: "desc" },
      take: 10,
      select: {
        type: true, summary: true, status: true, dueDate: true, doneAt: true, note: true,
        assignedTo: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    }),
  ]);
  // The account automated entries are filed under (assistantWho.ts): a row in its
  // name is that person OR nobody. If it cannot be established — the lookup fails,
  // or finds nobody — it is null, and then NO name is given as certain: "could not
  // check" must not read as "checked, and a person wrote it".
  const standInId = (await resolveTenantActor().catch(() => null))?.id ?? null;
  // Test drives for this lead, through the test-drive page's own visibility rule.
  const testDrives = (await isModuleEnabled("automotive"))
    ? await prisma.testDriveBooking.findMany({
        where: { leadId: lead.id, deletedAt: null, ...(await accessibleTestDriveWhere(user)) },
        orderBy: { scheduledStart: "desc" },
        take: 5,
        select: { status: true, scheduledStart: true, salesOutcome: true, customerFeedback: true, salespersonId: true, demoVehicle: { select: { name: true } } },
      })
    : [];
  // A test drive names its salesperson by id only; the workspace's own staff list puts a name to it.
  const staffName = testDrives.length ? new Map((await listActingTenantStaff().catch(() => [])).map((s) => [s.id, s.name])) : new Map<string, string>();
  const quotes = (await hasAnyPermission(user, "quotes.view_all", "quotes.view_owned"))
    ? await quotesForLead(user, lead.id)
    : [];
  // The CUSTOMER behind this lead, and any other customer of the same name — a
  // lead matching does not mean the deal is what they meant to write on.
  const customerRecords = await customersFor(lead.contactId);

  const moneyFmt = await getRegionalSettings();
  return {
    truncated: false,
    data: [{
      ...(customerRecords.length
        ? {
            customerRecords,
            customerRecordsNote: "Customer records for this name. A note on the CUSTOMER is customer_note with the contactId; a note on this deal is note with the lead id. Use the customer when they say \"customer\" or \"contact\", and ask which one if several match.",
          }
        : {}),
      ...(others.length
        ? {
            matched: `${matches.length} leads match "${needle}" — this is the likeliest (open, most recently worked).`,
            otherMatches: others.map((m) => ({ id: m.id, link: `/leads/${m.id}`, customer: m.name, lead: m.title, status: m.status, stage: m.stage.name })),
          }
        : {}),
      id: lead.id,
      link: `/leads/${lead.id}`,
      lead: lead.title,
      customer: lead.name,
      status: lead.status,
      stage: lead.stage.name,
      daysInStage: daysAgo(lead.stageEnteredAt),
      value: formatZAR(lead.valueCents, withCurrency(moneyFmt, lead.currency)),
      quantity: lead.quantity,
      product: lead.product?.name ?? null,
      source: lead.source,
      assignedTo: lead.assignedTo?.name ?? "unassigned",
      created: dateKey(lead.createdAt),
      // A lead from the website, a chatbot or an import has no person behind it either.
      ...(whoLogged(lead.createdBy, standInId) ? { createdBy: whoLogged(lead.createdBy, standInId) } : {}),
      ...(lead.wonAt ? { won: dateKey(lead.wonAt) } : {}),
      ...(lead.lostAt ? { lost: dateKey(lead.lostAt), lostReason: lead.lostReason } : {}),
      // PARKED, not lost (NURTURE_RULE): why, what they want, when to follow up, and the day it is looked at again.
      ...(lead.status === "nurture"
        ? { nurture: { since: lead.nurtureSince ? dateKey(lead.nurtureSince) : null, why: nurtureReasonLabel(lead.nurtureReason), interest: lead.nurtureInterest, followUpWhen: lead.nurtureTrigger, reviewOn: lead.nurtureReviewAt ? dateKey(lead.nurtureReviewAt) : null } }
        : {}),
      notes: clip(lead.notes, 800),
      research: lead.research ? { when: dateKey(lead.researchedAt), summary: clip(lead.research, 1500) } : null,
      who: WHO_LEGEND,
      opens: OPENED_LEGEND,
      messages: communications.map((c) => {
        // Whose words, and who recorded them — not the same for a call a member of staff logged.
        const { from, loggedBy } = messageAuthor(c, standInId);
        return {
          when: dateKey(c.occurredAt),
          from,
          ...(loggedBy ? { loggedBy } : {}),
          channel: c.type,
          text: clip([c.subject, c.body].filter(Boolean).join(" — "), 300),
          ...openedFact(c),
          ...receiptFact(c),
        };
      }),
      activities: activities.map((a) => {
        const scheduledBy = whoLogged(a.createdBy, standInId);
        return {
          type: a.type,
          summary: a.summary,
          status: a.status,
          due: dateKey(a.dueDate),
          ...(a.doneAt ? { done: dateKey(a.doneAt) } : {}),
          // Whose it is to do — a person, always: an activity is assigned to someone.
          assignedTo: a.assignedTo?.name ?? null,
          ...(scheduledBy ? { scheduledBy } : {}),
          note: clip(a.note, 200),
        };
      }),
      quotes,
      testDrives: testDrives.map((t) => ({
        when: dateKey(t.scheduledStart),
        status: t.status,
        vehicle: t.demoVehicle?.name ?? null,
        ...(staffName.get(t.salespersonId) ? { salesperson: staffName.get(t.salespersonId) } : {}),
        outcome: t.salesOutcome,
        feedback: clip(t.customerFeedback, 200),
      })),
    }],
    rows: [lead, ...others].map((l) => ({
      label: `${l.name} — ${l.title}`,
      detail: l === lead ? `${lead.stage.name} · ${formatZAR(lead.valueCents, withCurrency(moneyFmt, lead.currency))} · ${lead.assignedTo?.name ?? "unassigned"}` : `${l.stage.name} · ${l.status}`,
      href: `/leads/${l.id}`,
    })),
  };
}

export async function quotesForLead(user: User, leadId: string) {
  const ids = await getAccessibleQuoteIds(user);
  const quotes = await prisma.quote.findMany({
    where: { leadId, deletedAt: null, supersededAt: null, ...(ids === null ? {} : { id: { in: ids } }) },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true, number: true, status: true, createdAt: true, validUntil: true, viewedAt: true, signedAt: true, declinedAt: true,
      declineReason: true, changeRequestNote: true,
      invoicedAt: true, depositPaidAt: true, deliveryScheduledFor: true, deliveredAt: true,
      taxInclusive: true, currency: true, depositType: true, depositValue: true, items: true, fees: true, contactId: true, leadId: true,
    },
  });
  const signing = await signingFor(quotes.map((q) => q.id));
  const sends = await quoteSends(quotes);
  const moneyFmt = await getRegionalSettings();
  return quotes.map((q) => ({
    quote: `Q-${q.number}`,
    link: `/quotes/${q.id}`,
    ...quoteFacts(q, signing.get(q.id)),
    ...(sends.has(q.id) ? { sendStatus: sends.get(q.id)!.status } : {}),
    total: formatZAR(payableTotalCents(q), withCurrency(moneyFmt, q.currency)),
    ...quoteContents(q, withCurrency(moneyFmt, q.currency)),
    created: dateKey(q.createdAt),
    validUntil: q.validUntil ? dateKey(q.validUntil) : null,
    viewedByCustomer: viewedByCustomer(q, signing.get(q.id)),
    ...(q.declinedAt ? { declined: dateKey(q.declinedAt), reason: clip(q.declineReason, 200) } : {}),
    ...(q.changeRequestNote ? { changeRequested: clip(q.changeRequestNote, 200) } : {}),
    ...(q.status === "accepted"
      ? {
          invoiced: q.invoicedAt ? dateKey(q.invoicedAt) : "no",
          deposit: q.depositPaidAt ? `paid ${dateKey(q.depositPaidAt)}` : "not paid",
          delivery: q.deliveredAt ? `delivered ${dateKey(q.deliveredAt)}` : q.deliveryScheduledFor ? `booked ${dateKey(q.deliveryScheduledFor)}` : "not booked",
        }
      : {}),
  }));
}
