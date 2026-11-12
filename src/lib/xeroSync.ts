import "server-only";
import { revalidatePath } from "next/cache";
import { ActionRefusal, refuse } from "@/lib/actionResult";
import { basePrisma, prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { logError } from "@/lib/errorLog";
import { formatZAR } from "@/lib/format";
import { withCurrency } from "@/lib/currencyRules";
import { QUOTE_GONE } from "@/lib/quoteDelivery";
import { getRegionalSettings, getWorkspaceSetting, putWorkspaceSetting } from "@/lib/settings";
import { deleteFile, saveFile } from "@/lib/storage";
import { XeroNotConnected, paymentsComeFromXero, xeroClient, type XeroClient } from "@/lib/xero";
import { lockQuoteLedger } from "@/lib/quoteLedger";
import {
  XERO_AUTO_CHECKED_AT_KEY,
  XERO_AUTO_CHECK_KEY,
  XERO_PAYMENT_METHOD,
  XERO_UNCONFIRMED,
  nextXeroRefreshBatch,
  planXeroPaymentSync,
  receivedAfterSync,
  xeroInvoiceCancelled,
  xeroPaymentsComplete,
  xeroPdfFileName,
  xeroSendUncertain,
  xeroStatusLabel,
  type CrmPaymentState,
  type XeroInvoiceSummary,
} from "@/lib/xeroInvoice";

/**
 * Bringing a Xero invoice's state back into the CRM — its number, status, PDF and
 * payments. Shared by the person-pressed Refresh / Refresh all (actions/xero.ts)
 * and the hourly automatic check (api/cron/xero-payments). A server-only library,
 * NOT a "use server" file: everything exported from one of those is callable from
 * the browser, and these take no permission check of their own — their callers do.
 *
 * Who did it (`actor`): the person who pressed, or null for the automatic check —
 * audited as such. The automatic check never files a PDF (a document needs a real
 * uploader); it remembers which status the filed PDF shows (Quote.xeroPdfStatus),
 * so the next Refresh by a person files Xero's newer one.
 */
export type XeroActor = { id: string; name: string } | null;

/**
 * File Xero's PDF on the CUSTOMER (and the quote) as the accounting invoice. A
 * newer copy — after the invoice was approved or paid in Xero — becomes the one
 * on the record, and the older goes to the Trash (60 days), so there is only ever
 * one Xero PDF per invoice.
 */
async function fileXeroPdf(input: {
  tenantId: string;
  quote: { id: string; number: number; contactId: string | null };
  invoice: XeroInvoiceSummary;
  pdf: Buffer;
  user: { id: string; name: string };
}): Promise<void> {
  const fileName = xeroPdfFileName(input.invoice.number, input.quote.number);
  const storedName = await saveFile(input.pdf, fileName, "application/pdf", input.tenantId);
  try {
    // Filed only if the invoice STILL links this Xero invoice, checked under the
    // quote's row lock: a PDF fetched over a connection that has since been
    // switched to another organisation (forgetXeroLinks clears the link, locking
    // the same row), or for an invoice another send has since replaced, is
    // dropped — never filed on the customer (review of #1067).
    const filed = await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${input.quote.id} AND "tenantId" = ${input.tenantId} FOR UPDATE`;
      const stillLinked = await tx.quote.count({ where: { id: input.quote.id, tenantId: input.tenantId, xeroInvoiceId: input.invoice.id } });
      if (stillLinked !== 1) return false;
      const document = await tx.document.create({
        data: {
          tenantId: input.tenantId,
          fileName,
          storedName,
          mimeType: "application/pdf",
          sizeBytes: input.pdf.length,
          contactId: input.quote.contactId,
          quoteId: input.quote.id,
          tag: "accounting-invoice",
          uploadedById: input.user.id,
        },
        select: { id: true },
      });
      // ONE Xero PDF per invoice (Sean, 2026-11-11: "it files two copies"): the older
      // copy goes to the Trash — recoverable for 60 days — still linked to the newer
      // one, instead of staying in the Documents list beside it.
      await tx.document.updateMany({
        where: { tenantId: input.tenantId, quoteId: input.quote.id, tag: "accounting-invoice", deletedAt: null, id: { not: document.id } },
        data: { replacedById: document.id, deletedAt: new Date(), deletedByName: "Xero", deleteReason: "Replaced by Xero's newer PDF of this invoice" },
      });
      // Which of Xero's states the filed PDF shows — so a status the automatic check
      // brought back (without filing) still gets its PDF on the next Refresh.
      await tx.quote.updateMany({ where: { id: input.quote.id, tenantId: input.tenantId }, data: { xeroPdfStatus: input.invoice.status } });
      return true;
    });
    if (!filed) throw new Error("the invoice no longer links this Xero invoice — PDF not filed");
  } catch (error) {
    await deleteFile(storedName).catch(() => {});
    throw error;
  }
}

/**
 * "Payments get recorded in Xero and pushed back to the CRM" (Sean, 2026-11-11):
 * bring EVERY payment Xero has on this invoice into the CRM, so the CRM invoice
 * and statement match Xero — the earliest as the deposit (the step the Deliveries
 * board waits on), the rest as payments, each remembered by its Xero PaymentID so
 * nothing comes in twice; a payment removed in Xero is voided here (kept, marked).
 * Money recorded by hand that a Xero payment of the same amount accounts for is
 * LINKED, never duplicated; any that none accounts for is reported, never dropped
 * (planXeroPaymentSync).
 *
 * Under the quote's ledger lock (quoteLedger.ts), and only while the quote STILL
 * links the Xero invoice the payments were read from — an organisation switch
 * (forgetXeroLinks) updates the same row, so its payments can't land after it
 * (review of #1071). Never past the CRM invoice's total: Xero showing more is a
 * mismatch a person must look at, so nothing is brought. Only while payments come
 * from Xero (Settings → Integrations → Xero). Null = nothing to say.
 */
export async function syncPaymentsFromXero(input: {
  tenantId: string;
  quoteId: string;
  invoice: XeroInvoiceSummary;
  user: XeroActor;
}): Promise<string | null> {
  if (!(await paymentsComeFromXero(input.tenantId))) return null;
  // A partial answer from Xero must never clear a deposit or void a payment (review of #1071).
  if (!xeroPaymentsComplete(input.invoice)) {
    const fmt = withCurrency(await getRegionalSettings(), null);
    return `Xero says ${formatZAR(input.invoice.amountPaidCents, fmt)} has been paid, but its payment details don't add up to that — nothing was changed here. Press Refresh again later.`;
  }
  const done = await prisma.$transaction(async (tx) => {
    const ledger = await lockQuoteLedger(tx, input.quoteId, input.tenantId);
    if (!ledger || ledger.quote.xeroInvoiceId !== input.invoice.id) return null;
    const q = ledger.quote;
    const state: CrmPaymentState = {
      deposit: { paidAt: q.depositPaidAt, cents: q.depositPaidCents, xeroPaymentId: q.xeroDepositPaymentId, createdFromXero: q.xeroDepositCreated },
      payments: ledger.payments.map((p) => ({
        id: p.id, xeroPaymentId: p.xeroPaymentId, amountCents: p.amountCents, receivedAt: p.receivedAt, voidedAt: p.voidedAt,
        createdFromXero: p.method === XERO_PAYMENT_METHOD,
      })),
    };
    const plan = planXeroPaymentSync(state, input.invoice.payments);
    if (receivedAfterSync(state, plan) > ledger.totalCents) return { kind: "too-much" as const, quote: q, plan };
    const ours = { id: input.quoteId, tenantId: input.tenantId, xeroInvoiceId: input.invoice.id };
    const d = plan.deposit;
    if (d.kind === "set") {
      await tx.quote.updateMany({
        where: ours,
        data: { depositPaidAt: d.at, depositPaidCents: d.cents, xeroDepositPaymentId: d.xeroPaymentId, xeroDepositCreated: d.createdFromXero },
      });
    }
    if (d.kind === "link") await tx.quote.updateMany({ where: ours, data: { xeroDepositPaymentId: d.xeroPaymentId, xeroDepositCreated: false } });
    if (d.kind === "update") await tx.quote.updateMany({ where: ours, data: { depositPaidCents: d.cents, depositPaidAt: d.at } });
    if (d.kind === "clear") await tx.quote.updateMany({ where: ours, data: { depositPaidAt: null, depositPaidCents: null, xeroDepositPaymentId: null, xeroDepositCreated: false } });
    // Recorded by hand, its Xero match gone: the deposit stays; only the link goes.
    if (d.kind === "unlink") await tx.quote.updateMany({ where: ours, data: { xeroDepositPaymentId: null, xeroDepositCreated: false } });
    if (plan.unlink.length) {
      await tx.quotePayment.updateMany({ where: { id: { in: plan.unlink }, tenantId: input.tenantId, quoteId: input.quoteId }, data: { xeroPaymentId: null } });
    }
    // The payment that became the deposit: retired as a payment, so the money is counted once.
    if (plan.promote) {
      await tx.quotePayment.updateMany({
        where: { id: plan.promote, tenantId: input.tenantId, quoteId: input.quoteId, voidedAt: null },
        data: { voidedAt: new Date(), voidedByName: "Xero", voidReason: "Became the deposit — the earlier payment was removed in Xero" },
      });
    }
    for (const { paymentId, xero } of plan.restore) {
      await tx.quotePayment.updateMany({
        where: { id: paymentId, tenantId: input.tenantId, quoteId: input.quoteId },
        data: { voidedAt: null, voidedByName: null, voidReason: null, amountCents: xero.amountCents, receivedAt: xero.date },
      });
    }
    for (const x of plan.create) {
      await tx.quotePayment.create({
        data: {
          // The QUOTE's workspace, verbatim — the payment is the invoice's.
          tenantId: q.tenantId ?? input.tenantId,
          quoteId: input.quoteId,
          amountCents: x.amountCents,
          receivedAt: x.date,
          method: XERO_PAYMENT_METHOD,
          reference: x.reference,
          note: null,
          createdById: null,
          createdByName: "Xero",
          xeroPaymentId: x.id,
        },
      });
    }
    // Linked — or RE-linked, when Xero replaced the payment it was matched to (its old link goes).
    for (const { paymentId, xero } of plan.link) {
      await tx.quotePayment.updateMany({ where: { id: paymentId, tenantId: input.tenantId, quoteId: input.quoteId, voidedAt: null }, data: { xeroPaymentId: xero.id } });
    }
    for (const { paymentId, xero } of plan.update) {
      await tx.quotePayment.updateMany({ where: { id: paymentId, tenantId: input.tenantId, quoteId: input.quoteId }, data: { amountCents: xero.amountCents, receivedAt: xero.date } });
    }
    if (plan.void.length) {
      await tx.quotePayment.updateMany({
        where: { id: { in: plan.void }, tenantId: input.tenantId, quoteId: input.quoteId, voidedAt: null },
        data: { voidedAt: new Date(), voidedByName: "Xero", voidReason: "Removed in Xero" },
      });
    }
    await tx.quote.updateMany({ where: ours, data: { xeroAmountPaidCents: input.invoice.amountPaidCents } });
    return { kind: "synced" as const, quote: q, plan };
  });
  if (!done) return null;
  const fmt = withCurrency(await getRegionalSettings(), done.quote.currency);
  const money = (cents: number) => formatZAR(cents, fmt);
  if (done.kind === "too-much") {
    const handDeposit = done.plan.unmatched.depositCents;
    const handPayments = done.plan.unmatched.payments;
    if (handDeposit || handPayments.length) {
      // Money recorded by hand that Xero split differently (Sean, 2026-11-11) — not "Xero has too much".
      const ours = [handDeposit ? `deposit ${money(handDeposit)}` : "", ...handPayments.map((p) => `payment ${money(p.amountCents)}`)].filter(Boolean).join(", ");
      const xeros = input.invoice.payments.map((p) => money(p.amountCents)).join(", ") || "none";
      return `The CRM's own records for this invoice (${ours}) are split differently from Xero's payments (${xeros}), so they can't be matched — counting both would go past the invoice total, so nothing was changed. To line them up: untick "Payments come from Xero" in Settings → Integrations → Xero, void the CRM's records on this invoice, tick it again and press Refresh — or record the payments in Xero the same way the CRM has them.`;
    }
    return `Xero shows more received (${money(input.invoice.amountPaidCents)}) than this invoice's total — nothing was brought back. Check the invoice in Xero.`;
  }
  const { plan } = done;
  const said: string[] = [];
  if (plan.deposit.kind === "set") said.push(`deposit ${money(plan.deposit.cents)}`);
  if (plan.deposit.kind === "update") said.push(`deposit changed to ${money(plan.deposit.cents)}`);
  if (plan.deposit.kind === "clear") said.push("deposit removed (no longer in Xero)");
  if (plan.create.length) said.push(`${plan.create.length} payment${plan.create.length === 1 ? "" : "s"} (${money(plan.create.reduce((s, x) => s + x.amountCents, 0))})`);
  if (plan.update.length) said.push(`${plan.update.length} payment${plan.update.length === 1 ? "" : "s"} corrected`);
  if (plan.void.length) said.push(`${plan.void.length} payment${plan.void.length === 1 ? "" : "s"} voided (removed in Xero)`);
  if (plan.restore.length) said.push(`${plan.restore.length} payment${plan.restore.length === 1 ? "" : "s"} restored`);
  const linked = plan.link.length + (plan.deposit.kind === "link" ? 1 : 0);
  if (said.length || linked) {
    await logAudit({
      action: "quote.xero_payments_synced",
      summary: `Q-${done.quote.number}: from Xero${input.user ? "" : " (automatic check)"} — ${[...said, linked ? `${linked} recorded by hand matched to Xero` : ""].filter(Boolean).join(", ")}`,
      contactId: done.quote.contactId,
      leadId: done.quote.leadId,
      user: input.user,
    });
    revalidatePath("/deliveries");
    revalidatePath("/invoices");
    revalidatePath(`/deals/${input.quoteId}`);
  }
  const unmatched = [
    plan.unmatched.depositCents ? `a deposit of ${money(plan.unmatched.depositCents)}` : "",
    ...plan.unmatched.payments.map((p) => `a payment of ${money(p.amountCents)}`),
  ].filter(Boolean);
  return [
    said.length ? `Brought back from Xero: ${said.join(", ")}.` : "",
    unmatched.length ? `Recorded by hand in the CRM but not in Xero: ${unmatched.join(", ")} — record it in Xero (or void it in the CRM) so the two match.` : "",
    input.invoice.amountCreditedCents ? `Xero also has ${money(input.invoice.amountCreditedCents)} in credits on it — credits aren't brought back.` : "",
  ].filter(Boolean).join(" ") || null;
}

/** Fetch and file the PDF; a failure here never undoes the invoice — it is said, and Refresh tries again. */
export async function tryFilePdf(client: XeroClient, input: Omit<Parameters<typeof fileXeroPdf>[0], "pdf">): Promise<boolean> {
  try {
    await fileXeroPdf({ ...input, pdf: await client.getInvoicePdf(input.invoice.id) });
    return true;
  } catch (err) {
    await logError("xero-pdf", err, `quote=${input.quote.id} invoice=${input.invoice.id}`, { tenantId: input.tenantId, alert: false });
    return false;
  }
}

/**
 * Statuses a "Refresh all" (and the automatic check) has nothing to learn from:
 * cancelled, or a send still to settle. PAID too — once its payments have been
 * brought back (xeroAmountPaidCents set); one paid before payments came from Xero
 * is still taken, to bring them.
 */
export const REFRESH_ALL_SKIPS = ["PAID", "VOIDED", "DELETED", "SENDING", XERO_UNCONFIRMED];
/** One request at a time, capped per batch — Xero allows 60 calls a minute. Each batch moves on (xeroCheckedAt). */
export const REFRESH_ALL_CAP = 25;

/**
 * The hourly automatic payments check (api/cron/xero-payments), for ONE workspace:
 * while payments come from Xero and the owner hasn't switched it off (Settings →
 * Integrations → Xero — visible, switchable), the same routine as "Refresh all"
 * over its open invoices in Xero, and once a day each over its PAID ones (a
 * payment reversed in Xero) — up to 25 a run, never-tried / longest-ago-tried
 * first, each marked tried before it's tried, so successive runs reach them all.
 * Audited as the automatic check (no person); never files a PDF (xeroPdfStatus).
 * Stops early when the run's time is nearly up, or when Xero says the connection
 * is gone. Records when it last ran, for Settings.
 */
export async function runAutomaticXeroCheck(
  tenantId: string,
  shouldStop: () => boolean,
): Promise<{ checked: number; failed: number } | { skipped: string }> {
  if (!(await paymentsComeFromXero(tenantId))) return { skipped: "payments-not-from-xero" };
  if ((await getWorkspaceSetting(tenantId, XERO_AUTO_CHECK_KEY)) === "off") return { skipped: "switched-off" };
  // Paid invoices too, about once a day each — oldest-checked first, inside the same 25 a run.
  const open = await prisma.quote.findMany({
    where: openXeroInvoicesWhere(tenantId, null, new Date(Date.now() - XERO_PAID_REVISIT_MS)),
    select: { id: true, xeroCheckedAt: true },
  });
  let checked = 0;
  let failed = 0;
  if (open.length) {
    const batch = nextXeroRefreshBatch(open, REFRESH_ALL_CAP);
    let client: XeroClient;
    try {
      client = await xeroClient(tenantId);
    } catch (err) {
      if (err instanceof XeroNotConnected) return { skipped: "not-connected" };
      throw err;
    }
    await prisma.quote.updateMany({ where: { tenantId, id: { in: batch.map((q) => q.id) } }, data: { xeroCheckedAt: new Date() } });
    for (const quote of batch) {
      if (shouldStop()) break;
      try {
        await refreshOneFromXero(client, tenantId, quote.id, null);
        checked += 1;
      } catch (err) {
        failed += 1;
        if (err instanceof XeroNotConnected) break; // the connection is gone — Settings already says "Reconnect needed"
        if (!(err instanceof ActionRefusal || (err instanceof Error && err.message.startsWith("Xero:")))) {
          await logError("xero-auto-check", err, `quote=${quote.id}`, { tenantId, alert: false });
        }
      }
    }
  }
  await putWorkspaceSetting(tenantId, XERO_AUTO_CHECKED_AT_KEY, new Date().toISOString());
  return { checked, failed };
}

/** How often the automatic check looks again at an invoice that is already PAID in Xero. */
export const XERO_PAID_REVISIT_MS = 24 * 60 * 60 * 1000;

/**
 * The open invoices in Xero a refresh is worth trying — in this workspace (and, for a person, only theirs).
 * `paidCheckedBefore`: also a PAID one last checked before then — a payment
 * reversed or refunded in Xero turns it unpaid, and only a look brings that back
 * (review of #1073). The automatic check passes it; Refresh all doesn't.
 */
export function openXeroInvoicesWhere(tenantId: string, accessible: string[] | null, paidCheckedBefore?: Date) {
  return {
    tenantId,
    status: "accepted",
    deletedAt: null,
    supersededAt: null,
    xeroInvoiceId: { not: null },
    OR: [
      { xeroStatus: { notIn: REFRESH_ALL_SKIPS } },
      { xeroStatus: "PAID", xeroAmountPaidCents: null },
      ...(paidCheckedBefore ? [{ xeroStatus: "PAID", OR: [{ xeroCheckedAt: null }, { xeroCheckedAt: { lt: paidCheckedBefore } }] }] : []),
    ],
    ...(accessible === null ? {} : { id: { in: accessible } }),
  };
}

/**
 * Refresh ONE invoice from Xero — Xero's number, status and total; its newest PDF
 * when the filed one shows an older state (or none is filed yet) — a person's
 * Refresh only; and its payments, brought back into the CRM (syncPaymentsFromXero).
 * Refuses (ActionRefusal) or throws Xero's error; the callers say it.
 */
export async function refreshOneFromXero(
  client: XeroClient,
  tenantId: string,
  quoteId: string,
  user: XeroActor,
): Promise<{ message: string; paymentsSaid: boolean }> {
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, tenantId },
    select: { id: true, number: true, contactId: true, currency: true, xeroInvoiceId: true, xeroInvoiceNumber: true, xeroStatus: true, xeroPdfStatus: true },
  });
  if (!quote) refuse(QUOTE_GONE);
  if (!quote.xeroInvoiceId) refuse(`Q-${quote.number} has not been sent to Xero yet.`);
  // Mid-send or unfinished: the linked invoice is the voided one being replaced —
  // Refresh would only read that back. Send settles it.
  if (xeroSendUncertain(quote.xeroStatus)) refuse("A send to Xero is in progress or didn't finish — press Send invoice to Xero to settle it.");
  const invoice = await client.getInvoice(quote.xeroInvoiceId);
  const updated = await prisma.quote.updateMany({
    // Only the state that was read: a send that claimed it meanwhile keeps its claim.
    where: { id: quoteId, tenantId, xeroInvoiceId: quote.xeroInvoiceId, xeroStatus: quote.xeroStatus },
    data: { xeroInvoiceNumber: invoice.number, xeroStatus: invoice.status, xeroTotalCents: invoice.totalCents },
  });
  // Nothing matched: a send took it over, or Xero was reconnected to another
  // organisation meanwhile — stop here; nothing from this read is kept or filed.
  if (updated.count !== 1) refuse("This invoice changed while it was being refreshed (a send, or Xero was reconnected) — reload the page.");
  revalidatePath("/deliveries");
  revalidatePath("/invoices");
  if (quote.contactId) revalidatePath(`/contacts/${quote.contactId}`);
  if (xeroInvoiceCancelled(invoice.status)) {
    // Voided in Xero: the CRM invoice is free again (xeroLockReason). No PDF of a voided invoice is filed.
    if (quote.xeroStatus !== invoice.status) await logAudit({ action: "quote.xero_voided", summary: `Q-${quote.number}: Xero invoice ${invoice.number ?? invoice.id} is ${xeroStatusLabel(invoice.status).toLowerCase()} in Xero — unlocked in the CRM`, contactId: quote.contactId, user });
    return { message: `Xero: ${invoice.number ?? "invoice"} · ${xeroStatusLabel(invoice.status)}. This invoice can be changed in the CRM again, or sent to Xero again.`, paymentsSaid: false };
  }
  // An invoice linked to Xero BEFORE sending marked it invoiced (#1071) has no
  // invoice date, so it would sit in "Awaiting payment" and never take a deposit.
  // A live Xero invoice IS the invoice: mark it — never over an existing date, and
  // only while the quote still links THIS Xero invoice (review of #1071).
  const marked = await prisma.quote.updateMany({
    where: { id: quoteId, tenantId, xeroInvoiceId: invoice.id, invoicedAt: null },
    data: { invoicedAt: new Date() },
  });
  if (marked.count === 1) {
    await logAudit({ action: "fulfilment.invoiced", summary: `Q-${quote.number} invoiced — in Xero as ${invoice.number ?? "an invoice"}`, contactId: quote.contactId, user });
  }
  // The filed PDF is refreshed when it shows an older state of the invoice than Xero
  // now has (xeroPdfStatus) — including one the automatic check moved on without
  // filing — or when none is filed. Only a person's Refresh files (a real uploader).
  const filed = await prisma.document.count({ where: { tenantId, quoteId, tag: "accounting-invoice", deletedAt: null } });
  const pdfStale = filed === 0 || quote.xeroPdfStatus !== invoice.status || invoice.number !== quote.xeroInvoiceNumber;
  const pdfFiled = user && pdfStale ? await tryFilePdf(client, { tenantId, quote, invoice, user }) : false;
  const fromXero = await syncPaymentsFromXero({ tenantId, quoteId, invoice, user });
  return {
    message: [`Xero: ${invoice.number ?? "invoice"} · ${xeroStatusLabel(invoice.status)}${pdfFiled ? " — latest PDF filed on the customer." : ""}`, fromXero ?? ""]
      .filter(Boolean)
      .join(" "),
    paymentsSaid: Boolean(fromXero),
  };
}
