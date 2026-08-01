import "server-only";
import { prisma } from "@/lib/db";
import { payableTotalCents } from "@/lib/pricing";
import { contactName } from "@/lib/format";
import { listTenantStaff } from "@/lib/tenantActor";
import { getBuilderTemplate } from "@/lib/docbuilder/store";
import { type DocumentModel, type Recipient } from "@/lib/doceditor/model";
import { readTemplateDocument } from "@/lib/doceditor/legacy";
import {
  standardQuoteTemplate,
  newBlock,
  newRow,
  newColumn,
  newPage,
  newRecipient,
  newOverlayField,
  uid,
} from "@/lib/doceditor/factory";
import { parseGraph, type WorkflowGraph } from "@/lib/signflow/model";
import {
  compileWorkflow,
  type ResolvedSigner,
  type WorkflowContext,
} from "@/lib/signflow/compile";
import {
  hasSendReadyRecipients,
  recipientIdsWithFields,
  remapTemplateSigningRecipients,
} from "@/lib/signing/templateRecipients";

/**
 * Resolves the document to send for signing for a quote / job card. If a doc-editor
 * template is assigned we use it; otherwise we synthesise the branded standard
 * layout so every record is signable without hand-building a template first.
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
  cosign: boolean;
  signers?: ResolvedSigner[];
  frozen?: { graph: WorkflowGraph; vars: WorkflowContext };
};

async function quoteCustomer(quoteId: string) {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: { contact: true, lead: true },
  });
  if (!quote) return null;
  return {
    title: `Quote Q-${quote.number}`,
    refLabel: `Q-${quote.number}`,
    contactId: quote.contactId ?? null,
    customerName: quote.contact
      ? contactName(quote.contact)
      : quote.lead?.name ?? "",
    customerEmail: quote.contact?.email ?? quote.lead?.email ?? null,
    customerPhone: quote.contact?.phone ?? quote.lead?.phone ?? null,
  };
}

async function jobCardCustomer(jobCardId: string) {
  const jobCard = await prisma.jobCard.findUnique({
    where: { id: jobCardId },
    include: { contact: true },
  });
  if (!jobCard) return null;
  return {
    title: `Job card #${jobCard.number}`,
    refLabel: `#${jobCard.number}`,
    contactId: jobCard.contactId ?? null,
    customerName: contactName(jobCard.contact),
    customerEmail: jobCard.contact.email ?? null,
    customerPhone: jobCard.contact.phone ?? null,
  };
}

function standardJobCardTemplate(): DocumentModel {
  const banner = newBlock("banner");
  if (banner.type === "banner") {
    banner.title = "JOB CARD";
    banner.docNumber = "{{jobcard.number}}";
  }
  const infoCard = (
    label: string,
    name: string,
    lines: string,
    accent: string,
  ) => {
    const block = newBlock("infoCard");
    if (block.type === "infoCard") {
      block.label = label;
      block.name = name;
      block.lines = lines;
      block.accent = accent;
    }
    return block;
  };
  const description = newBlock("text");
  if (description.type === "text") {
    description.value = [
      {
        type: "p",
        children: [{ text: "Work requested: {{jobcard.description}}" }],
      },
    ];
  }
  const total = newBlock("totalBand");
  if (total.type === "totalBand") {
    total.label = "TOTAL INCL. VAT";
    total.amount = "{{jobcard.total}}";
  }
  total.settings = { width: 55, horizontalAlignment: "right" };
  const terms = newBlock("terms");
  if (terms.type === "terms") {
    terms.items = [
      {
        text: "I authorise the work described above and confirm the vehicle details are correct.",
      },
      { text: "Prices include 15% VAT." },
    ];
  }
  return {
    schemaVersion: 1,
    title: "Job card",
    style: {
      fontFamily: "sans",
      pageSize: "A4",
      margin: 40,
      accent: "#ea580c",
      ink: "#020617",
    },
    recipients: [],
    pages: [
      newPage([
        newRow([newColumn(100, [banner])]),
        newRow([
          newColumn(50, [
            infoCard(
              "CUSTOMER",
              "{{customer.name}}",
              "{{customer.phone}}\n{{customer.email}}",
              "#ea580c",
            ),
          ]),
          newColumn(50, [
            infoCard(
              "VEHICLE",
              "{{vehicle}}",
              "VIN {{vehicle.vin}}\nReg {{vehicle.reg}}",
              "#020617",
            ),
          ]),
        ]),
        newRow([newColumn(100, [description])]),
        newRow([newColumn(100, [newBlock("lineItems")])]),
        newRow([newColumn(100, [total])]),
        newRow([newColumn(100, [terms])]),
        newRow([newColumn(100, [newBlock("footer")])]),
      ]),
    ],
    header: [],
    footer: [],
  };
}

function headingFloat(x: number, y: number, text: string) {
  const block = newBlock("text");
  if (block.type === "text") {
    block.value = [
      { type: "p", children: [{ text, bold: true }] },
    ];
  }
  return { id: uid(), x, y, width: 250, block };
}

function addRequiredSigningFields(
  doc: DocumentModel,
  recipient: Recipient,
  options: {
    x: number;
    y: number;
    label: string;
    requireDate?: boolean;
  },
): void {
  const fields = doc.pages.flatMap((page) => page.overlayFields);
  const recipientFields = fields.filter(
    (field) => field.recipientId === recipient.id,
  );
  const hasSignature = recipientFields.some((field) =>
    ["signature", "initials", "stamp"].includes(field.kind),
  );
  const hasDate = recipientFields.some((field) => field.kind === "date");
  const last = doc.pages[doc.pages.length - 1];

  if (!hasSignature) {
    last.overlayFields.push(
      newOverlayField("signature", {
        id: uid(),
        recipientId: recipient.id,
        required: true,
        label: options.label,
        anchor: {
          mode: "page",
          blockId: null,
          x: options.x,
          y: options.y,
        },
        width: 250,
        height: 60,
      }),
    );
    last.floatingBlocks.push(
      headingFloat(options.x, options.y - 33, options.label),
    );
  }
  if (options.requireDate && !hasDate) {
    last.overlayFields.push(
      newOverlayField("date", {
        id: uid(),
        recipientId: recipient.id,
        required: true,
        label: "Date",
        anchor: {
          mode: "page",
          blockId: null,
          x: options.x,
          y: options.y + 73,
        },
        width: 160,
        height: 38,
      }),
    );
  }
}

function ensureSignable(
  doc: DocumentModel,
  customer: { name: string; email: string | null; phone: string | null },
): DocumentModel {
  const signingRecipients = doc.recipients.filter(
    (recipient) => recipient.role !== "viewer",
  );
  if (signingRecipients.length === 0) {
    const customerRecipient = newRecipient({
      name: customer.name || "Customer",
      email: customer.email ?? "",
      role: "signer",
    });
    doc.recipients = [
      customerRecipient,
      ...doc.recipients.filter((recipient) => recipient.role === "viewer"),
    ];
    addRequiredSigningFields(doc, customerRecipient, {
      x: 430,
      y: 980,
      label: customerRecipient.name,
      requireDate: true,
    });
    return doc;
  }

  const idsWithFields = recipientIdsWithFields(doc);
  signingRecipients.forEach((recipient, index) => {
    if (!idsWithFields.has(recipient.id)) {
      addRequiredSigningFields(doc, recipient, {
        x: index % 2 === 0 ? 70 : 430,
        y: 900 + Math.floor(index / 2) * 150,
        label: recipient.name || "Signer",
        requireDate: true,
      });
    }
  });
  return doc;
}

function makeCosignable(
  doc: DocumentModel,
  denago: { name: string; email: string | null },
  customer: { name: string; email: string | null },
): { doc: DocumentModel; denagoId: string; customerId: string } {
  const dealerRecipient = newRecipient({
    name: denago.name || "Denago Cape Town",
    email: denago.email ?? "",
    role: "signer",
    color: "#020617",
  });
  const customerRecipient = newRecipient({
    name: customer.name || "Customer",
    email: customer.email ?? "",
    role: "signer",
    color: "#2563eb",
  });

  remapTemplateSigningRecipients(doc, [dealerRecipient, customerRecipient]);
  addRequiredSigningFields(doc, dealerRecipient, {
    x: 70,
    y: 985,
    label: `For ${dealerRecipient.name}`,
  });
  addRequiredSigningFields(doc, customerRecipient, {
    x: 430,
    y: 985,
    label: customerRecipient.name,
    requireDate: true,
  });

  return {
    doc,
    denagoId: dealerRecipient.id,
    customerId: customerRecipient.id,
  };
}

async function quoteWorkflowContext(
  quoteId: string,
): Promise<WorkflowContext> {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: {
      items: true,
      fees: { orderBy: { sortOrder: "asc" } },
      lead: { include: { product: true } },
      contact: { include: { tags: true } },
    },
  });
  // Routing rules key off deal size; the subtotal understated it whenever a
  // quote carried a delivery charge.
  const total = (quote ? payableTotalCents(quote) : 0) / 100;
  const segment =
    (quote?.contact?.tags ?? []).map((tag) => tag.name).join(",") ||
    "retail";
  const product =
    quote?.lead?.product?.name ?? quote?.items?.[0]?.description ?? "";
  return { total, discount: 0, segment, product };
}

async function staffMap(): Promise<
  Record<string, { name: string; email: string | null }>
> {
  // Scope to THIS tenant's active, non-disabled members so a workflow's staff
  // assignee can only resolve to a name/email within the tenant (never a
  // cross-tenant or disabled user).
  const users = await listTenantStaff();
  return Object.fromEntries(
    users.map((user) => [
      user.id,
      { name: user.name, email: user.email },
    ]),
  );
}

const RECIPIENT_PALETTE = [
  "#020617",
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#16a34a",
  "#ea580c",
];

function makeWorkflowSignable(
  doc: DocumentModel,
  signers: ResolvedSigner[],
): DocumentModel {
  const recipients = signers.map((signer, index) =>
    newRecipient({
      name: signer.name,
      email: signer.email ?? "",
      role: signer.role === "approver" ? "approver" : "signer",
      color: RECIPIENT_PALETTE[index % RECIPIENT_PALETTE.length],
    }),
  );
  remapTemplateSigningRecipients(doc, recipients);

  signers.forEach((signer, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    addRequiredSigningFields(doc, recipients[index], {
      x: column === 0 ? 70 : 430,
      y: 900 + row * 150,
      label: signer.label || signer.name,
      requireDate: false,
    });
  });
  return doc;
}

export async function resolveEnvelope(opts: {
  quoteId?: string | null;
  jobCardId?: string | null;
  templateId?: string | null;
  workflowId?: string | null;
  signer?: { name: string; email: string | null } | null;
}): Promise<EnvelopeResolution | null> {
  const { quoteId, jobCardId, templateId } = opts;
  const customer = quoteId
    ? await quoteCustomer(quoteId)
    : jobCardId
      ? await jobCardCustomer(jobCardId)
      : null;
  if (!customer) return null;

  let doc: DocumentModel | null = null;
  if (templateId) {
    const template = await getBuilderTemplate(templateId);
    if (template) {
      const read = readTemplateDocument(template.data, template.name);
      // A CHOSEN template that cannot be read faithfully must stop the
      // envelope, not fall through to the standard layout below. This document
      // gets rendered, mailed and signed: quietly substituting a different one
      // means the customer signs something other than what was selected.
      // resolveEnvelope's null already surfaces as "Could not prepare the
      // document."
      if (read.status === "unsupported") return null;
      doc = read.status === "ok" ? read.doc : null;
    }
  }
  // Reached only when no template was chosen, or the chosen row is gone —
  // never as a stand-in for one we failed to read.
  if (!doc) doc = quoteId ? standardQuoteTemplate() : standardJobCardTemplate();
  doc.title = customer.title;
  const templateHasReadyRecipients = hasSendReadyRecipients(doc);

  let ordering: "parallel" | "sequential" = "parallel";
  let cosign = false;
  let signers: ResolvedSigner[] | undefined;
  let frozen: { graph: WorkflowGraph; vars: WorkflowContext } | undefined;

  if (quoteId && opts.workflowId) {
    const workflow = await prisma.signWorkflow.findUnique({
      where: { id: opts.workflowId },
    });
    const graph =
      workflow && !workflow.deletedAt
        ? parseGraph(workflow.graphJson)
        : null;
    if (graph) {
      const [vars, staff] = await Promise.all([
        quoteWorkflowContext(quoteId),
        staffMap(),
      ]);
      const compiled = compileWorkflow(graph, {
        vars,
        customer: {
          name: customer.customerName,
          email: customer.customerEmail,
        },
        staff,
      });
      if (compiled.signers.length > 0) {
        doc = makeWorkflowSignable(doc, compiled.signers);
        ordering = "sequential";
        cosign = true;
        signers = compiled.signers;
        const hasApprovalOrBranch = Object.values(graph.nodes).some(
          (node) => node.type === "approval" || node.type === "condition",
        );
        if (hasApprovalOrBranch) frozen = { graph, vars };
      }
    }
  }

  if (!signers) {
    if (!templateHasReadyRecipients && quoteId && opts.signer) {
      ({ doc } = makeCosignable(
        doc,
        { name: opts.signer.name, email: opts.signer.email },
        {
          name: customer.customerName,
          email: customer.customerEmail,
        },
      ));
      ordering = "sequential";
      cosign = true;
    } else {
      doc = ensureSignable(doc, {
        name: customer.customerName,
        email: customer.customerEmail,
        phone: customer.customerPhone,
      });
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
