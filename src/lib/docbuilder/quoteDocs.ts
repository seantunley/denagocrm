import { DEFAULT_REGIONAL, formatDate, formatZAR, type Regional } from "@/lib/format";
import type { QuoteBillTo } from "@/lib/quoteBillTo";
import type { DocTemplate } from "@/lib/docTemplates";

/**
 * Merge tokens for the documents printed FROM a quote — invoice and sales
 * agreement. Pure, so the numbering and wording can be tested without a database.
 *
 * Every value here is exactly what the fixed React print pages print today
 * (app/(print)/quotes/[id]/invoice|agreement), so a doc-editor layout built from
 * these tokens says the same thing as the page it replaces.
 */

export const invoiceNumber = (quoteNumber: number) => `INV-${quoteNumber}`;
export const agreementNumber = (quoteNumber: number) => `SA-${quoteNumber}`;

/**
 * THE SAFE SWITCH for the invoice / agreement print pages: where to send the
 * request so it prints from the single editor, or null to print the old fixed
 * layout exactly as before.
 *
 * Only a PUBLISHED default template switches it. `?tpl=` is Settings → Documents
 * previewing an OLD template, and `?legacy=1` is the builder route handing back a
 * layout it could not render — both must stay on the old page.
 */
export async function builderDocRedirect(
  quoteId: string,
  key: "invoice" | "agreement",
  search: { tpl?: string; legacy?: string },
  publishedTemplate: () => Promise<unknown>,
): Promise<string | null> {
  if (search.tpl || search.legacy) return null;
  return (await publishedTemplate()) ? `/quotes/${quoteId}/doc/${key}` : null;
}

/** The lines under a party's name, blanks dropped — an infoCard prints one per line. */
const lines = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join("\n");

export function quoteDocTokens(
  quote: { number: number; status: string; invoicedAt?: Date | null },
  billTo: QuoteBillTo,
  money: { depositCents: number; balanceCents: number },
  now: Date = new Date(),
  r: Regional = DEFAULT_REGIONAL,
): Record<string, string> {
  const party = [
    billTo.attention ? `Attention: ${billTo.attention}` : "",
    billTo.phone,
    billTo.email,
    // Street, then town — one comma-joined line wrapped badly (Sean, 2026-10-07).
    ...(billTo.addressLines?.length ? billTo.addressLines : [billTo.address]),
  ];
  const vat = billTo.vatNumber ? `VAT no: ${billTo.vatNumber}` : "";
  return {
    "quote.status": quote.status,
    "quote.deposit": formatZAR(money.depositCents, r),
    "quote.balance": formatZAR(money.balanceCents, r),
    "invoice.number": invoiceNumber(quote.number),
    // An invoice is dated when it was raised; one not yet raised is dated today.
    "invoice.date": formatDate(quote.invoicedAt ?? now, r),
    "invoice.billedTo": lines([...party, vat]),
    "agreement.number": agreementNumber(quote.number),
    "agreement.date": formatDate(now, r),
    "agreement.purchaser": lines([
      ...party,
      billTo.registrationNumber ? `Reg. no: ${billTo.registrationNumber}` : "",
      vat,
    ]),
  };
}

/**
 * The owner-written text of the invoice / agreement — banking details, payment
 * terms, clauses, intro line — as tokens. Today that text lives on the document's
 * DocTemplate (Settings → Documents) and the print page reads it from there, so
 * the builder layout reads the same text rather than asking for it to be typed
 * twice. A section switched off there comes through empty, which hides the
 * conditional block wrapping it.
 */
export function legacyDocTextTokens(key: "invoice" | "agreement", tpl: DocTemplate): {
  tokens: Record<string, string>;
  vars: Record<string, Record<string, string>>;
} {
  const on = (section: string) => tpl.sections[section] !== false;
  const text: Record<string, string> =
    key === "invoice"
      ? {
          intro: tpl.intro ?? "",
          bankingDetails: on("banking") ? tpl.bodyText ?? "" : "",
          paymentTerms: on("terms") ? tpl.terms ?? "" : "",
        }
      : {
          intro: tpl.intro ?? "",
          clauses: on("clauses") ? tpl.bodyText ?? "" : "",
        };
  return {
    tokens: Object.fromEntries(Object.entries(text).map(([k, v]) => [`${key}.${k}`, v])),
    vars: { [key]: text },
  };
}
