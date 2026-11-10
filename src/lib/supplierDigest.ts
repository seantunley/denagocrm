import "server-only";
import { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "./db";
import { automationOn } from "./automationSwitch";
import { getRegionalSettings, getSetting } from "./settings";
import { DOCUMENT_TYPES_KEY, parseDocumentTypes } from "./documentLabels";
import { dealFileChecklist, type DealFileConfig } from "./dealFile";
import { getDealFileConfig } from "./dealFileConfig";
import { loadBillToFleets, quoteBillTo } from "./quoteBillTo";
import { sendEmail } from "./email";
import { tenantOrigin } from "./tenantOrigin";
import { brandForTenant, DEFAULT_BRAND } from "./tenantBrand";
import {
  digestWeekDue,
  SUPPLIER_DIGEST_LAST_WEEK,
  SUPPLIER_DIGEST_SWITCH,
  supplierDigestEmail,
  eachPage,
  type DigestDeal,
} from "./supplierDigestRules";

const DELIVERED_WITHIN_DAYS = 30;

/**
 * Deals in progress — an accepted quote not yet delivered, or delivered in the last 30 days — and the supplier
 * papers each is still missing from a supplier ON it (declared, or named on one of its documents). A deal with no
 * supplier on it is not listed: "a supplier quote from someone" on every deal would bury the real gaps.
 */
export async function missingSupplierPapers(tenantId: string): Promise<DigestDeal[]> {
  const since = new Date(Date.now() - DELIVERED_WITHIN_DAYS * 86_400_000);
  const types = parseDocumentTypes(await getSetting(DOCUMENT_TYPES_KEY));
  const config = await getDealFileConfig();
  const deals: DigestDeal[] = [];
  // Across pages: a deal with two accepted quotes is listed once, whichever page each lands on.
  const seen = new Set<string>();
  // EVERY qualifying deal, in pages of DIGEST_PAGE — a cap here silently left older deals out of the email.
  await eachPage(
    DIGEST_PAGE,
    (after) =>
      prisma.quote.findMany({
        where: {
          tenantId, deletedAt: null, supersededAt: null, status: "accepted",
          OR: [{ deliveredAt: null }, { deliveredAt: { gte: since } }],
          ...(after ? { id: { gt: after } } : {}),
        },
        select: { id: true, number: true, leadId: true, fleetId: true, contact: true, lead: true },
        orderBy: { id: "asc" },
        take: DIGEST_PAGE,
      }),
    async (accepted) => {
      deals.push(...(await missingOnPage(tenantId, accepted, types, config, seen)));
    },
  );
  // Newest deal first, as the page order no longer is.
  return deals.sort((a, b) => b.quoteNumber - a.quoteNumber);
}

const DIGEST_PAGE = 100;

type AcceptedQuote = Prisma.QuoteGetPayload<{ select: { id: true; number: true; leadId: true; fleetId: true; contact: true; lead: true } }>;

async function missingOnPage(tenantId: string, accepted: AcceptedQuote[], types: string[], config: DealFileConfig, seen: Set<string>): Promise<DigestDeal[]> {
  const leadIds = [...new Set(accepted.flatMap((quote) => (quote.leadId ? [quote.leadId] : [])))];
  const quoteIds = accepted.map((quote) => quote.id);
  // The customer as every quote document names it — the fleet account when billed to one (quoteBillTo).
  const fleets = await loadBillToFleets(prisma, accepted.map((quote) => quote.fleetId));
  const [allQuotes, links] = await Promise.all([
    prisma.quote.findMany({
      where: { tenantId, deletedAt: null, OR: [{ leadId: { in: leadIds } }, { id: { in: quoteIds } }] },
      select: { id: true, leadId: true, number: true, status: true, invoicedAt: true, deliverySignatureRef: true },
    }),
    prisma.dealVendor.findMany({
      where: { tenantId, OR: [{ leadId: { in: leadIds } }, { quoteId: { in: quoteIds } }] },
      select: { leadId: true, quoteId: true, vendor: { select: { id: true, name: true, requiredDocuments: true } } },
    }),
  ]);
  const docs = await prisma.document.findMany({
    where: { tenantId, quoteId: { in: allQuotes.map((quote) => quote.id) }, deletedAt: null, replacedById: null },
    select: { quoteId: true, tag: true, vendorId: true, vendor: { select: { name: true, requiredDocuments: true } } },
  });

  const deals: DigestDeal[] = [];
  for (const quote of accepted) {
    const root = quote.leadId ?? quote.id;
    if (seen.has(root)) continue;
    seen.add(root);
    const dealQuotes = allQuotes.filter((q) => (q.leadId ?? q.id) === root);
    const dealQuoteIds = new Set(dealQuotes.map((q) => q.id));
    const declared = links.filter((link) => link.leadId === root || link.quoteId === root).map((link) => link.vendor);
    const checklist = dealFileChecklist(
      dealQuotes,
      docs.filter((doc) => doc.quoteId && dealQuoteIds.has(doc.quoteId)).map((doc) => ({
        tag: doc.tag, vendorId: doc.vendorId, vendorName: doc.vendor?.name ?? null, vendorRequiredDocuments: doc.vendor?.requiredDocuments ?? null,
      })),
      types,
      config,
      declared,
    );
    // A named supplier's lines only — the unnamed set (no supplier on the deal) has vendorId null.
    const missing = checklist.filter((item) => !item.done && item.supplier?.vendorId).map((item) => item.label);
    if (missing.length) {
      deals.push({
        quoteNumber: quote.number,
        customer: quoteBillTo(quote, quote.fleetId ? fleets.get(quote.fleetId) ?? null : null).name || "Customer",
        href: `/deals/${quote.id}`,
        missing,
      });
    }
  }
  return deals;
}

/**
 * The automations cron's "supplier-digest" phase, once per workspace per tick: on Monday from 07:00 (workspace
 * time) — or the first tick after it this week — email the owner what is missing. The week is CLAIMED before
 * sending (conditionally, on the value read), so two ticks can't both send; a failed send hands it back.
 */
export async function runSupplierDigest(tenantId: string | null): Promise<{ sent: number } | { skipped: string }> {
  if (!tenantId) return { skipped: "no-workspace" };
  if (!(await automationOn(SUPPLIER_DIGEST_SWITCH, tenantId))) return { skipped: "switched-off" };
  const { timeZone } = await getRegionalSettings();
  const stored = await basePrisma.appSetting.findUnique({ where: { tenantId_key: { tenantId, key: SUPPLIER_DIGEST_LAST_WEEK } }, select: { value: true } });
  const week = digestWeekDue(new Date(), timeZone, stored?.value ?? null);
  if (!week) return { skipped: "not-due" };

  // Claim this week before anything goes out.
  if (stored) {
    const claimed = await basePrisma.appSetting.updateMany({ where: { tenantId, key: SUPPLIER_DIGEST_LAST_WEEK, value: stored.value }, data: { value: week } });
    if (claimed.count !== 1) return { skipped: "claimed" };
  } else {
    try {
      await basePrisma.appSetting.create({ data: { tenantId, key: SUPPLIER_DIGEST_LAST_WEEK, value: week } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { skipped: "claimed" };
      throw error;
    }
  }
  const handBack = () =>
    stored
      ? basePrisma.appSetting.updateMany({ where: { tenantId, key: SUPPLIER_DIGEST_LAST_WEEK, value: week }, data: { value: stored.value } })
      : basePrisma.appSetting.deleteMany({ where: { tenantId, key: SUPPLIER_DIGEST_LAST_WEEK, value: week } });

  try {
    const owner = await basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { owner: { select: { email: true } } } });
    if (!owner?.owner?.email) return { skipped: "no-owner-email" };
    const [deals, origin, brand] = await Promise.all([
      missingSupplierPapers(tenantId),
      tenantOrigin(tenantId),
      brandForTenant(tenantId).catch(() => DEFAULT_BRAND),
    ]);
    const email = supplierDigestEmail({ brand: brand.displayName, origin: origin || "", deals });
    if (!email) return { sent: 0 };
    const sent = await sendEmail({ to: owner.owner.email, subject: email.subject, text: email.text });
    if (!sent.ok) throw new Error(sent.error ?? "the mail server refused the supplier digest");
    return { sent: 1 };
  } catch (error) {
    await handBack().catch(() => {});
    throw error;
  }
}
