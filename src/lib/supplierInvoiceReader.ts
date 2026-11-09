import "server-only";
import { basePrisma } from "./db";
import { getProviderKey } from "./settings";
import { openStoredFile } from "./storage";
import { recordAiUsage } from "./systemHealth";
import { logError } from "./errorLog";
import { isModuleEnabled } from "./modules/enabled";
import { INVOICE_READING_PROMPT, isSupplierInvoice, nothingRead, parseInvoiceReading } from "./supplierInvoiceRules";

const READ_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * Read a supplier invoice document with AI and keep what it says — as "read", for a person to confirm. Never
 * overwrites one a person has confirmed. Runs as the document's own workspace (explicit tenantId on every query),
 * so it is safe after the response, outside the request's scope. Nothing about the invoice's contents is logged.
 *
 * Returns what happened, for the "Read invoice" button to say.
 */
export async function readSupplierInvoice(documentId: string, tenantId: string): Promise<"read" | "unreadable" | "confirmed-already" | "not-an-invoice" | "not-configured"> {
  const doc = await basePrisma.document.findFirst({
    where: { id: documentId, tenantId, deletedAt: null },
    select: { id: true, tag: true, storedName: true, mimeType: true, sizeBytes: true },
  });
  if (!doc || !isSupplierInvoice(doc.tag)) return "not-an-invoice";
  if (!(await isModuleEnabled("suppliers"))) return "not-configured";
  const existing = await basePrisma.supplierInvoice.findFirst({ where: { documentId, tenantId }, select: { status: true } });
  if (existing?.status === "confirmed") return "confirmed-already";
  const apiKey = await getProviderKey("ANTHROPIC_API_KEY");
  if (!apiKey) return "not-configured";

  const keep = async (fields: ReturnType<typeof parseInvoiceReading>, status: "read" | "unreadable") => {
    const data = { ...fields, status, readAt: new Date(), confirmedAt: null, confirmedById: null };
    // Conditional: a person who confirmed it meanwhile wins.
    const updated = await basePrisma.supplierInvoice.updateMany({ where: { documentId, tenantId, status: { not: "confirmed" } }, data });
    if (updated.count === 0 && !existing) await basePrisma.supplierInvoice.create({ data: { tenantId, documentId, ...data } }).catch(() => {});
  };
  const empty = { invoiceNumber: null, invoiceDate: null, dueDate: null, totalCents: null, currency: null };

  const kind = doc.mimeType === "application/pdf" ? "pdf" : IMAGE_TYPES.has(doc.mimeType) ? "image" : null;
  if (!kind || doc.sizeBytes > READ_MAX_BYTES) {
    await keep(empty, "unreadable");
    return "unreadable";
  }
  try {
    const { stream } = await openStoredFile(doc.storedName, tenantId);
    const data = Buffer.from(await new Response(stream).arrayBuffer()).toString("base64");
    const source = { type: "base64", media_type: doc.mimeType, data };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(45_000),
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: [
            kind === "pdf" ? { type: "document", source } : { type: "image", source },
            { type: "text", text: INVOICE_READING_PROMPT },
          ],
        }],
      }),
    });
    if (!res.ok) {
      // The status only — the body can quote the document.
      await logError("supplier-invoice-read", `Anthropic API ${res.status}`, `document=${documentId}`, { tenantId, alert: false });
      return "unreadable";
    }
    const json = await res.json();
    await recordAiUsage(json.usage, json.model);
    const fields = parseInvoiceReading(String(json.content?.find?.((block: { type?: string }) => block.type === "text")?.text ?? ""));
    const status = nothingRead(fields) ? "unreadable" : "read";
    await keep(fields, status);
    return status;
  } catch (error) {
    await logError("supplier-invoice-read", error instanceof Error ? error.name : "error", `document=${documentId}`, { tenantId, alert: false });
    return "unreadable";
  }
}
