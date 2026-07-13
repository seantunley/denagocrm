import "server-only";
import { prisma } from "./db";
import { contactName, formatDate, formatZAR } from "./format";
import { type MergeContext } from "./mergeFields";

/**
 * Build the merge context for a document from its linked CRM records.
 * All resolution happens here, server-side, from approved sources only.
 */
export async function buildMergeContext(links: {
  contactId?: string | null;
  leadId?: string | null;
  quoteId?: string | null;
  userName?: string;
}): Promise<MergeContext> {
  const [contact, lead, quote] = await Promise.all([
    links.contactId ? prisma.contact.findUnique({ where: { id: links.contactId } }) : null,
    links.leadId
      ? prisma.lead.findUnique({ where: { id: links.leadId }, include: { product: true } })
      : null,
    links.quoteId
      ? prisma.quote.findUnique({ where: { id: links.quoteId }, include: { items: true } })
      : null,
  ]);

  // Lead can stand in for a missing contact
  const custName = contact ? contactName(contact) : lead?.name ?? "";
  const quoteTotal = quote
    ? quote.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0)
    : null;

  return {
    "company.name": "Denago Cape Town",
    "company.phone": "073 789 3438",
    "company.email": "sales@denagocpt.co.za",
    "company.address": "Unit 55, M5 Freeway Business Park, Maitland, Cape Town",
    "customer.name": custName,
    "customer.firstName": contact?.firstName ?? lead?.name?.split(/\s+/)[0] ?? "",
    "customer.email": contact?.email ?? lead?.email ?? "",
    "customer.phone": contact?.phone ?? lead?.phone ?? "",
    "customer.address": contact
      ? [contact.address, contact.suburb, contact.city, contact.province, contact.postalCode]
          .filter(Boolean)
          .join(", ")
      : "",
    "lead.title": lead?.title ?? "",
    "lead.product": lead?.product?.name ?? "",
    "lead.value": lead ? formatZAR(lead.valueCents) : "",
    "quote.number": quote ? `Q-${quote.number}` : "",
    "quote.total": quoteTotal !== null ? formatZAR(quoteTotal) : "",
    "quote.date": quote ? formatDate(quote.createdAt) : "",
    "user.name": links.userName ?? "",
    "date.today": formatDate(new Date()),
  };
}

/** BlockNote JSON → full styled HTML (A4 print CSS + Denago branding). */
export async function renderInstanceHtml(instance: {
  title: string;
  contentJson: unknown;
}): Promise<string> {
  const { ServerBlockNoteEditor } = await import("@blocknote/server-util");
  const editor = ServerBlockNoteEditor.create();
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const body = await editor.blocksToFullHTML(instance.contentJson as any);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(instance.title)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #111827; margin: 0; }
  .doc-header { display:flex; justify-content:space-between; align-items:center;
    border-bottom: 3px solid #ea580c; padding-bottom: 10px; margin-bottom: 18px; }
  .doc-header img { height: 40px; }
  .doc-header .title { font-size: 10pt; color:#6b7280; text-align:right; }
  .doc-footer { border-top: 2px solid #ea580c; margin-top: 28px; padding-top: 8px;
    font-size: 8pt; color:#6b7280; }
  .bn-container p { margin: 0 0 6px; line-height: 1.5; }
  h1 { font-size: 18pt; margin: 14px 0 8px; } h2 { font-size: 14pt; margin: 12px 0 6px; }
  h3 { font-size: 12pt; margin: 10px 0 5px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #d1d5db; padding: 5px 8px; font-size: 10pt; }
  img { max-width: 100%; }
</style></head>
<body>
  <div class="doc-header">
    <img src="${process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za"}/branding/denago-cape-town-logo.png" alt="Denago Cape Town" />
    <div class="title">${escapeHtml(instance.title)}</div>
  </div>
  ${body}
  <div class="doc-footer">
    Denago Cape Town — Authorized Denago EV Dealer · Unit 55, M5 Freeway Business Park, Maitland ·
    073 789 3438 · sales@denagocpt.co.za
  </div>
</body></html>`;
}

export type HtmlPdfOptions = {
  /** Repeating header/footer templates (Puppeteer syntax: use classes like
   *  pageNumber/totalPages). When set, margins must leave room for them. */
  headerTemplate?: string;
  footerTemplate?: string;
  margin?: { top?: string; bottom?: string; left?: string; right?: string };
};

/** HTML → PDF buffer. Serverless Chromium on Vercel, local Chrome in dev. */
export async function htmlToPdf(html: string, opts?: HtmlPdfOptions): Promise<Buffer> {
  const puppeteer = await import("puppeteer-core");
  let browser;
  if (process.env.VERCEL) {
    const chromium = (await import("@sparticuz/chromium")).default;
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  } else {
    // Local dev: use the machine's installed Chrome/Edge
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "/usr/bin/google-chrome",
    ];
    const fs = await import("fs");
    const exe = candidates.find((p) => fs.existsSync(p));
    if (!exe) throw new Error("No local Chrome/Edge found for PDF rendering");
    browser = await puppeteer.launch({ executablePath: exe, headless: true });
  }
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 30000 });
    const useFrame = Boolean(opts?.headerTemplate || opts?.footerTemplate);
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      ...(useFrame
        ? {
            displayHeaderFooter: true,
            headerTemplate: opts?.headerTemplate ?? "<span></span>",
            footerTemplate: opts?.footerTemplate ?? "<span></span>",
            margin: opts?.margin ?? { top: "26mm", bottom: "20mm", left: "0", right: "0" },
          }
        : {}),
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
