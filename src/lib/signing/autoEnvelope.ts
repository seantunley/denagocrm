import "server-only";
import { prisma } from "@/lib/db";
import { contactName } from "@/lib/format";
import { getBuilderTemplate } from "@/lib/docbuilder/store";
import { parseDocument, type DocumentModel } from "@/lib/doceditor/model";
import { standardQuoteTemplate, newBlock, newRow, newColumn, newPage, newRecipient, newOverlayField, uid } from "@/lib/doceditor/factory";

/**
 * Resolves the document to send for signing for a quote / job card. If a doc-editor
 * template is assigned we use it as-is; otherwise we synthesise the branded standard
 * layout so every record is signable without hand-building a template first.
 *
 * Either way we guarantee the envelope is *signable*: if it carries no recipients,
 * we inject the record's customer as the signer plus a signature + date field. This
 * is what gives the hub parity with the legacy one-tap `/sign` flow.
 */

export type EnvelopeResolution = {
  doc: DocumentModel;
  title: string;
  contactId: string | null;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  refLabel: string;
};

/** Customer identity for a quote (contact first, else the originating lead). */
async function quoteCustomer(quoteId: string) {
  const q = await prisma.quote.findUnique({ where: { id: quoteId }, include: { contact: true, lead: true } });
  if (!q) return null;
  return {
    title: `Quote Q-${q.number}`,
    refLabel: `Q-${q.number}`,
    contactId: q.contactId ?? null,
    customerName: q.contact ? contactName(q.contact) : q.lead?.name ?? "",
    customerEmail: q.contact?.email ?? q.lead?.email ?? null,
    customerPhone: q.contact?.phone ?? q.lead?.phone ?? null,
  };
}

async function jobCardCustomer(jobCardId: string) {
  const jc = await prisma.jobCard.findUnique({ where: { id: jobCardId }, include: { contact: true } });
  if (!jc) return null;
  return {
    title: `Job card #${jc.number}`,
    refLabel: `#${jc.number}`,
    contactId: jc.contactId ?? null,
    customerName: contactName(jc.contact),
    customerEmail: jc.contact.email ?? null,
    customerPhone: jc.contact.phone ?? null,
  };
}

/** A compact branded job-card layout (there is no standard job-card preset). */
function standardJobCardTemplate(): DocumentModel {
  const banner = newBlock("banner");
  if (banner.type === "banner") { banner.title = "JOB CARD"; banner.docNumber = "{{jobcard.number}}"; }
  const infoCard = (label: string, name: string, lines: string, accent: string) => {
    const b = newBlock("infoCard");
    if (b.type === "infoCard") { b.label = label; b.name = name; b.lines = lines; b.accent = accent; }
    return b;
  };
  const desc = newBlock("text");
  if (desc.type === "text") desc.value = [{ type: "p", children: [{ text: "Work requested: {{jobcard.description}}" }] }];
  const total = newBlock("totalBand");
  if (total.type === "totalBand") { total.label = "TOTAL INCL. VAT"; total.amount = "{{jobcard.total}}"; }
  total.settings = { width: 55, horizontalAlignment: "right" };
  const terms = newBlock("terms");
  if (terms.type === "terms") terms.items = [
    { text: "I authorise the work described above and confirm the vehicle details are correct." },
    { text: "Prices include 15% VAT." },
  ];
  return {
    schemaVersion: 1,
    title: "Job card",
    style: { fontFamily: "sans", pageSize: "A4", margin: 40, accent: "#ea580c", ink: "#020617" },
    recipients: [],
    pages: [newPage([
      newRow([newColumn(100, [banner])]),
      newRow([
        newColumn(50, [infoCard("CUSTOMER", "{{customer.name}}", "{{customer.phone}}\n{{customer.email}}", "#ea580c")]),
        newColumn(50, [infoCard("VEHICLE", "{{vehicle}}", "VIN {{vehicle.vin}}\nReg {{vehicle.reg}}", "#020617")]),
      ]),
      newRow([newColumn(100, [desc])]),
      newRow([newColumn(100, [newBlock("lineItems")])]),
      newRow([newColumn(100, [total])]),
      newRow([newColumn(100, [terms])]),
      newRow([newColumn(100, [newBlock("footer")])]),
    ])],
    header: [],
    footer: [],
  };
}

/**
 * Guarantee the document can be signed: if it has no recipients, add the record's
 * customer as the signer and drop a signature + date field on the last page.
 */
function ensureSignable(doc: DocumentModel, customer: { name: string; email: string | null; phone: string | null }): DocumentModel {
  if (doc.recipients.length > 0) return doc;
  const recipient = newRecipient({ name: customer.name || "Customer", email: customer.email ?? "", role: "signer" });
  doc.recipients = [recipient];
  const last = doc.pages[doc.pages.length - 1];
  const sig = newOverlayField("signature", { id: uid(), recipientId: recipient.id, required: true, label: "Signature", anchor: { mode: "page", blockId: null, x: 430, y: 980 } });
  const date = newOverlayField("date", { id: uid(), recipientId: recipient.id, required: true, label: "Date", anchor: { mode: "page", blockId: null, x: 430, y: 1064 } });
  last.overlayFields = [...last.overlayFields, sig, date];
  return doc;
}

export async function resolveEnvelope(opts: {
  quoteId?: string | null;
  jobCardId?: string | null;
  templateId?: string | null;
}): Promise<EnvelopeResolution | null> {
  const { quoteId, jobCardId, templateId } = opts;
  const customer = quoteId ? await quoteCustomer(quoteId) : jobCardId ? await jobCardCustomer(jobCardId) : null;
  if (!customer) return null;

  // Assigned template wins; else synthesise the branded standard layout.
  let doc: DocumentModel | null = null;
  if (templateId) {
    const tpl = await getBuilderTemplate(templateId);
    if (tpl) doc = parseDocument(tpl.data);
  }
  if (!doc) doc = quoteId ? standardQuoteTemplate() : standardJobCardTemplate();

  doc.title = customer.title;
  doc = ensureSignable(doc, { name: customer.customerName, email: customer.customerEmail, phone: customer.customerPhone });

  return {
    doc,
    title: customer.title,
    contactId: customer.contactId,
    customerName: customer.customerName,
    customerEmail: customer.customerEmail,
    customerPhone: customer.customerPhone,
    refLabel: customer.refLabel,
  };
}
