import "server-only";
import { prisma } from "./db";
import { contactName, formatDate, formatZAR } from "./format";
import { payableTotalCents } from "./pricing";
import { type MergeContext } from "./mergeFields";
import { getCompanyProfile, companyTokens } from "./companyProfile";

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
  const [contact, lead, quote, company] = await Promise.all([
    links.contactId ? prisma.contact.findUnique({ where: { id: links.contactId } }) : null,
    links.leadId
      ? prisma.lead.findUnique({ where: { id: links.leadId }, include: { product: true } })
      : null,
    links.quoteId
      ? prisma.quote.findUnique({ where: { id: links.quoteId }, include: { items: true, fees: { orderBy: { sortOrder: "asc" } } } })
      : null,
    getCompanyProfile(),
  ]);

  // Lead can stand in for a missing contact
  const custName = contact ? contactName(contact) : lead?.name ?? "";
  const quoteTotal = quote ? payableTotalCents(quote) : null;

  return {
    ...companyTokens(company), // company.* now from the editable Company Profile
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

  // Header logo + footer are driven by the editable Company Profile (the single
  // source of truth) — not hard-coded — so changing Settings > Company updates
  // finalized Studio documents too.
  const company = await getCompanyProfile();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za";
  const logoSrc = company.logoUrl?.trim() || `${appUrl}/branding/denago-cape-town-logo.png`;
  const footer = escapeHtml(
    [
      [company.name, company.tagline].filter((s) => s && s.trim()).join(" — "),
      company.address,
      company.phone,
      company.email,
    ]
      .filter((s) => s && s.trim())
      .join(" · "),
  );

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
    <img src="${escapeHtml(logoSrc)}" alt="${escapeHtml(company.name)}" />
    <div class="title">${escapeHtml(instance.title)}</div>
  </div>
  ${body}
  <div class="doc-footer">
    ${footer}
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

/** Block localhost + private / link-local IP literals to prevent SSRF from image URLs. */
/**
 * Hosts headless Chromium may load a subresource from while rendering a
 * template.
 *
 * This replaces a DENYLIST of private ranges, which could not work. Two reasons,
 * both demonstrated against the old function before it was removed:
 *
 *  - It matched on the HOSTNAME STRING, and DNS is resolved by Chromium
 *    afterwards. A name that A-records to 169.254.169.254 sailed through, as did
 *    `metadata.google.internal`. No amount of regex fixes that.
 *  - Even as a string matcher it missed every alternative IP encoding —
 *    `2852039166`, `0xA9FEA9FE`, `0251.0376.0251.0376` and
 *    `[::ffff:169.254.169.254]` are all 169.254.169.254 to Chromium and none
 *    matched. It also missed 100.64.0.0/10 and fe80::, while wrongly blocking
 *    any public host beginning "fc"/"fd" (fda.example.com).
 *
 * An allowlist has no DNS problem, because the permitted NAMES are not
 * attacker-influenced. Templates are authored by docbuilder.manage holders and
 * their images are meant to be the company logo or an uploaded asset — verified
 * that no template in the database references any external image at all, so this
 * takes nothing away that is in use.
 */
function pdfImageHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const allowed = [
    // our own origin (the logo and any /branding asset)
    (() => {
      try {
        return new URL(process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za").hostname;
      } catch {
        return "crm.denagocpt.co.za";
      }
    })(),
    // uploaded assets live in Vercel Blob
    ".blob.vercel-storage.com",
    // operator escape hatch — a CDN the company actually uses
    ...(process.env.PDF_IMAGE_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  ];
  return allowed.some((entry) => (entry.startsWith(".") ? host.endsWith(entry) : host === entry));
}

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
    // Harden: templates are untrusted content. No scripting, and https only to a
    // host we have vouched for — see pdfImageHostAllowed for why this is an
    // allowlist and not a denylist of private ranges.
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const url = r.url();
      if (url.startsWith("data:")) return void r.continue();
      try {
        const u = new URL(url);
        if (u.protocol !== "https:" || u.username || u.password) return void r.abort();
        if (!pdfImageHostAllowed(u.hostname)) return void r.abort();
        return void r.continue();
      } catch { return void r.abort(); }
    });
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
