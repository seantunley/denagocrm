import { ZipWriter, Uint8ArrayReader } from "@zip.js/zip.js";
import { prisma } from "@/lib/db";
import { withActingStaffScope } from "@/lib/actingScope";
import { actingTenantId } from "@/lib/actingTenant";
import { requireQuoteReadAccess, requireRoute } from "@/lib/permissions";
import { isSameOrigin } from "@/lib/sameOrigin";
import { loadDealFile } from "@/lib/dealFileData";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { isAutomotiveOwnedDocument } from "@/lib/modules/registry";
import { openFileStream } from "@/lib/storage";
import { quotePdf } from "@/lib/quotePdf";
import { quotePdfFileName } from "@/lib/quoteEmail";
import { getCompanyProfile } from "@/lib/companyProfile";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import { payableTotalCents } from "@/lib/pricing";
import { getRegionalSettings } from "@/lib/settings";
import { formatDate, formatDateTime, formatZAR } from "@/lib/format";
import { withCurrency } from "@/lib/currencyRules";
import { isPersonLabel, SYSTEM_TAG_LABELS } from "@/lib/documentLabels";
import { logAudit } from "@/lib/audit";
import { logError } from "@/lib/errorLog";
import { coverSheetPdf } from "@/lib/dealFileCover";
import { dealZipFileName, humanBytes, zipPasswordProblem, zipPaths } from "@/lib/dealFileZipRules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Quotation PDFs are rendered first; big scans then stream through.
export const maxDuration = 300;

const text = (body: string, status: number) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/**
 * The deal file as ONE password-protected ZIP (Sean, 2026-11-09): a cover sheet with the checklist as it stands and
 * an index, each current quote's quotation PDF, and every document filed on the deal — exactly what the deal page
 * shows THIS person (lib/dealFileData.ts loadDealFile). AES-256, with the password typed for this download only: it
 * arrives in the POST body, goes to the encryptor, and is never stored, logged or audited.
 *
 * POST (a password is never put in a URL), same-site only — a route gets no CSRF check from Next.js.
 * STREAMED: Vercel caps a buffered response at 4.5 MB, and a deal's scans pass that easily.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withActingStaffScope(async () => {
    if (!isSameOrigin(request.headers)) return text("Download the deal file from its page.", 403);
    const { id } = await context.params;
    await requireRoute("/deals");
    const user = await requireQuoteReadAccess(id);
    const tenantId = await actingTenantId();
    const quote = await prisma.quote.findUnique({
      where: { id },
      select: { id: true, tenantId: true, number: true, leadId: true, contactId: true, fleetId: true, deletedAt: true, contact: true, lead: true },
    });
    // The row's own workspace, at the door — not just "this person may read a quote with this id".
    if (!quote || quote.deletedAt || quote.tenantId !== tenantId) return text("That deal is no longer there.", 404);

    const form = await request.formData();
    const password = String(form.get("password") ?? "");
    const problem = zipPasswordProblem(password, String(form.get("confirm") ?? ""));
    if (problem) return text(problem, 400);

    const file = await loadDealFile(quote, user);
    const automotiveOn = await isModuleEnabled("automotive");
    const [company, moneyFmt, fleet] = await Promise.all([getCompanyProfile(), getRegionalSettings(), loadBillToFleet(prisma, quote.fleetId)]);
    const notes: string[] = [];

    // 1. Each current quote's quotation — the same PDF the quote email attaches. Made now, before streaming starts.
    const quotations: { folder: string; name: string; bytes: Uint8Array; type: string }[] = [];
    for (const dealQuote of file.dealQuotes.filter((q) => q.supersededAt == null)) {
      const rendered = await quotePdf(dealQuote.id);
      if (rendered.ok) quotations.push({ folder: `Q-${dealQuote.number}`, name: quotePdfFileName(dealQuote.number, company.name), bytes: new Uint8Array(rendered.pdf), type: "Quotation (from the CRM)" });
      else notes.push(`The quotation PDF for Q-${dealQuote.number} could not be made${rendered.reason === "no_document" ? " (no quote layout is set in Document Studio)" : ""}.`);
    }
    // 2. Every filed document the page lists — except automotive paperwork while that module is off (as /api/files).
    const numberOf = new Map(file.dealQuotes.map((q) => [q.id, q.number]));
    const documents = file.documents.filter((doc) => automotiveOn || !isAutomotiveOwnedDocument(doc));
    if (documents.length < file.documents.length) notes.push(`${file.documents.length - documents.length} automotive document(s) left out: the Automotive module is off.`);
    const typeOf = (tag: string | null) => (tag ? (isPersonLabel(tag) ? tag : SYSTEM_TAG_LABELS[tag] ?? tag) : "Not labelled");

    const paths = zipPaths([
      ...quotations.map((q) => ({ folder: q.folder, name: q.name })),
      ...documents.map((doc) => ({ folder: doc.quoteId && numberOf.has(doc.quoteId) ? `Q-${numberOf.get(doc.quoteId)}` : null, name: doc.fileName })),
    ]);
    const quotationPaths = paths.slice(0, quotations.length);
    const documentPaths = paths.slice(quotations.length);

    const customer = quoteBillTo(quote, fleet).name || "Customer";
    const cover = (missing: string[]) =>
      coverSheetPdf({
        brand: company.name,
        title: `Q-${quote.number} · ${customer}`,
        generatedAt: formatDateTime(new Date(), moneyFmt),
        generatedBy: user.name,
        quotes: file.dealQuotes.map((q) => ({
          label: `Q-${q.number}`,
          status: q.supersededAt ? `${q.status}, replaced by a revision` : q.status,
          total: formatZAR(payableTotalCents(q), withCurrency(moneyFmt, q.currency)),
          created: formatDate(q.createdAt, moneyFmt),
        })),
        checklist: file.checklist.map((item) => ({ label: item.label, done: item.done, detail: item.detail })),
        suppliers: file.declaredVendors.map((vendor) => vendor.name),
        files: [
          ...quotations.map((q, i) => ({ path: quotationPaths[i], type: q.type, detail: "" })),
          ...documents.map((doc, i) => ({
            path: documentPaths[i],
            type: typeOf(doc.tag),
            detail: [doc.vendor?.name, `uploaded ${formatDate(doc.createdAt, moneyFmt)} by ${doc.uploadedBy.name}`, humanBytes(doc.sizeBytes), missing.includes(doc.id) ? "MISSING FROM STORAGE — not in this ZIP" : null].filter(Boolean).join(" · "),
          })),
        ],
        notes: [...notes, ...(missing.length ? [`${missing.length} file(s) could not be read from storage and are not in this ZIP.`] : [])],
      });

    await logAudit({
      action: "deal.file_downloaded",
      summary: `Downloaded the deal file for Q-${quote.number} as a password-protected ZIP (${quotations.length + documents.length} files)`,
      ...(quote.leadId ? { leadId: quote.leadId } : {}),
      ...(quote.contactId ? { contactId: quote.contactId } : {}),
      user,
      entityType: "Quote",
      entityId: quote.id,
    });

    // 3. Stream: files first, then the cover sheet — written LAST so it can say truthfully what made it in.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const zip = new ZipWriter(writable, { password, encryptionStrength: 3, zipCrypto: false, useWebWorkers: false });
    void (async () => {
      const missing: string[] = [];
      try {
        for (const [i, q] of quotations.entries()) await zip.add(quotationPaths[i], new Uint8ArrayReader(q.bytes));
        for (const [i, doc] of documents.entries()) {
          let stream: ReadableStream<Uint8Array>;
          try {
            stream = await openFileStream(doc.storedName, doc.tenantId);
          } catch {
            missing.push(doc.id);
            continue;
          }
          await zip.add(documentPaths[i], stream);
        }
        await zip.add(`00 Cover sheet - Q-${quote.number}.pdf`, new Uint8ArrayReader(await cover(missing)));
        await zip.close();
      } catch (error) {
        // Names only — never the password or a document's contents.
        await logError("deal-file-zip", error instanceof Error ? error.name : "error", `quote=${quote.id}`, { tenantId, alert: false }).catch(() => {});
        await writable.abort(error).catch(() => {});
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(dealZipFileName(quote.number))}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
