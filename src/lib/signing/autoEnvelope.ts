import "server-only";
import { prisma } from "@/lib/db";
import { quoteTotalCents } from "@/lib/pricing";
import { contactName } from "@/lib/format";
import { getBuilderTemplate } from "@/lib/docbuilder/store";
import { parseDocument, type DocumentModel } from "@/lib/doceditor/model";
import { standardQuoteTemplate, newBlock, newRow, newColumn, newPage, newRecipient, newOverlayField, uid } from "@/lib/doceditor/factory";
import { parseGraph, type WorkflowGraph } from "@/lib/signflow/model";
import { compileWorkflow, type ResolvedSigner, type WorkflowContext } from "@/lib/signflow/compile";

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
  ordering: "parallel" | "sequential";
  /** True when Denago co-signs first (order 0) via the hub before the customer. */
  cosign: boolean;
  /** Present when a saved workflow drove the recipient chain (else the built-in default). */
  signers?: ResolvedSigner[];
  /** Frozen workflow graph — present when the request must run through the interpreter (has approval/branch nodes). */
  frozen?: { graph: WorkflowGraph; vars: WorkflowContext };
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

/** A small bold heading placed freely on the page (used to label signature areas). */
function headingFloat(x: number, y: number, text: string) {
  const b = newBlock("text");
  if (b.type === "text") b.value = [{ type: "p", children: [{ text, bold: true }] }];
  return { id: uid(), x, y, width: 250, block: b };
}

/**
 * Two-party co-sign layout: Denago (signs first) + the customer, each with a
 * labelled signature block, plus the customer's date. Sequential ordering so the
 * customer is only notified once Denago has signed — and they then see Denago's
 * signature already on the document.
 */
function makeCosignable(doc: DocumentModel, denago: { name: string; email: string | null }, customer: { name: string; email: string | null }): { doc: DocumentModel; denagoId: string; customerId: string } {
  const denagoR = newRecipient({ name: denago.name || "Denago Cape Town", email: denago.email ?? "", role: "signer", color: "#020617" });
  const customerR = newRecipient({ name: customer.name || "Customer", email: customer.email ?? "", role: "signer", color: "#2563eb" });
  doc.recipients = [denagoR, customerR]; // index 0 signs first

  const last = doc.pages[doc.pages.length - 1];
  const denagoSig = newOverlayField("signature", { id: uid(), recipientId: denagoR.id, required: true, label: denagoR.name, anchor: { mode: "page", blockId: null, x: 70, y: 985 }, width: 250, height: 60 });
  const custSig = newOverlayField("signature", { id: uid(), recipientId: customerR.id, required: true, label: customerR.name, anchor: { mode: "page", blockId: null, x: 430, y: 985 }, width: 250, height: 60 });
  const custDate = newOverlayField("date", { id: uid(), recipientId: customerR.id, required: true, label: "Date", anchor: { mode: "page", blockId: null, x: 430, y: 1058 }, width: 160, height: 38 });
  last.overlayFields = [...last.overlayFields, denagoSig, custSig, custDate];
  last.floatingBlocks = [...last.floatingBlocks, headingFloat(70, 952, "For Denago Cape Town"), headingFloat(430, 952, "For the Customer")];
  return { doc, denagoId: denagoR.id, customerId: customerR.id };
}

/** Numeric + string facts a workflow's conditions test against, from the quote. */
async function quoteWorkflowContext(quoteId: string): Promise<WorkflowContext> {
  const q = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: { items: true, lead: { include: { product: true } }, contact: { include: { tags: true } } },
  });
  const total = quoteTotalCents(q?.items ?? []) / 100;
  const segment = (q?.contact?.tags ?? []).map((t) => t.name).join(",") || "retail";
  const product = q?.lead?.product?.name ?? q?.items?.[0]?.description ?? "";
  return { total, discount: 0, segment, product }; // discount: no per-quote discount field yet
}

async function staffMap(): Promise<Record<string, { name: string; email: string | null }>> {
  const users = await prisma.user.findMany({ select: { id: true, name: true, email: true } });
  return Object.fromEntries(users.map((u) => [u.id, { name: u.name, email: u.email }]));
}

const RECIPIENT_PALETTE = ["#020617", "#2563eb", "#7c3aed", "#db2777", "#16a34a", "#ea580c"];

/** Lay out one signature block (+ date) per resolved signer and wire recipients. */
function makeWorkflowSignable(doc: DocumentModel, signers: ResolvedSigner[]): DocumentModel {
  doc.recipients = signers.map((s, i) => newRecipient({ name: s.name, email: s.email ?? "", role: s.role === "approver" ? "approver" : "signer", color: RECIPIENT_PALETTE[i % RECIPIENT_PALETTE.length] }));
  const last = doc.pages[doc.pages.length - 1];
  const fields = [...last.overlayFields];
  const floats = [...last.floatingBlocks];
  signers.forEach((s, i) => {
    const col = i % 2, rowIdx = Math.floor(i / 2);
    const x = col === 0 ? 70 : 430;
    const yBase = 900 + rowIdx * 150;
    const rid = doc.recipients[i].id;
    floats.push(headingFloat(x, yBase - 28, s.label || s.name));
    fields.push(newOverlayField("signature", { id: uid(), recipientId: rid, required: true, label: s.label || s.name, anchor: { mode: "page", blockId: null, x, y: yBase }, width: 250, height: 60 }));
    fields.push(newOverlayField("date", { id: uid(), recipientId: rid, required: false, label: "Date", anchor: { mode: "page", blockId: null, x, y: yBase + 68 }, width: 150, height: 34 }));
  });
  last.overlayFields = fields;
  last.floatingBlocks = floats;
  return doc;
}

export async function resolveEnvelope(opts: {
  quoteId?: string | null;
  jobCardId?: string | null;
  templateId?: string | null;
  /** A saved signing workflow to compile into the recipient chain. */
  workflowId?: string | null;
  /** The Denago rep initiating — becomes the first (co-sign) signer on standard quotes. */
  signer?: { name: string; email: string | null } | null;
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
  const synthesised = !doc;
  if (!doc) doc = quoteId ? standardQuoteTemplate() : standardJobCardTemplate();
  doc.title = customer.title;

  // Recipient chain, in priority order:
  //  1. an explicit saved workflow (compiled against the quote),
  //  2. else the built-in Denago-first co-sign for synthesised quotes,
  //  3. else the single-customer signer (assigned templates, job cards).
  let ordering: "parallel" | "sequential" = "parallel";
  let cosign = false;
  let signers: ResolvedSigner[] | undefined;
  let frozen: { graph: WorkflowGraph; vars: WorkflowContext } | undefined;

  if (quoteId && opts.workflowId) {
    const wf = await prisma.signWorkflow.findUnique({ where: { id: opts.workflowId } });
    const graph = wf && !wf.deletedAt ? parseGraph(wf.graphJson) : null;
    if (graph) {
      const [vars, staff] = await Promise.all([quoteWorkflowContext(quoteId), staffMap()]);
      const compiled = compileWorkflow(graph, { vars, customer: { name: customer.customerName, email: customer.customerEmail }, staff });
      if (compiled.signers.length > 0) {
        doc = makeWorkflowSignable(doc, compiled.signers);
        ordering = "sequential";
        cosign = true;
        signers = compiled.signers;
        // Freeze the graph + vars: if it has approval/branch nodes the request runs
        // through the interpreter rather than a static sequential dispatch.
        const hasApprovalOrBranch = Object.values(graph.nodes).some((n) => n.type === "approval" || n.type === "condition");
        if (hasApprovalOrBranch) frozen = { graph, vars };
      }
    }
  }

  if (!signers) {
    if (synthesised && quoteId && opts.signer) {
      ({ doc } = makeCosignable(doc, { name: opts.signer.name, email: opts.signer.email }, { name: customer.customerName, email: customer.customerEmail }));
      ordering = "sequential";
      cosign = true;
    } else {
      doc = ensureSignable(doc, { name: customer.customerName, email: customer.customerEmail, phone: customer.customerPhone });
    }
  }

  return {
    doc,
    title: customer.title,
    contactId: customer.contactId,
    customerName: customer.customerName,
    customerEmail: customer.customerEmail,
    customerPhone: customer.customerPhone,
    refLabel: customer.refLabel,
    ordering,
    cosign,
    signers,
    frozen,
  };
}
