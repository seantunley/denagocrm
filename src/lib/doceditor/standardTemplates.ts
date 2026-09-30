/**
 * Standard builder templates for every operational document type, stored in the
 * current doceditor DocumentModel format. They mirror the live documents so the
 * builder starts from a useful layout rather than a blank page.
 */
import type { DocumentBlock, DocumentModel } from "./model";
import {
  newBlock,
  newColumn,
  newPage,
  newRow,
  standardQuoteTemplate,
} from "./factory";

export type StandardDocKey =
  | "quote"
  | "invoice"
  | "agreement"
  | "indemnity"
  | "delivery"
  | "jobcard"
  | "service-report"
  | "warranty-claim";

const INK = "#020617";
const ACCENT = "#ea580c";

function text(value: string, align: "left" | "center" | "right" = "left"): DocumentBlock {
  const block = newBlock("text");
  if (block.type === "text") block.value = [{ type: "p", align, children: [{ text: value }] }];
  return block;
}

function heading(value: string): DocumentBlock {
  const block = newBlock("heading");
  if (block.type === "heading") block.value = [{ type: "h2", children: [{ text: value }] }];
  return block;
}

function banner(title: string, docNumber: string): DocumentBlock {
  const block = newBlock("banner");
  if (block.type === "banner") {
    block.title = title;
    block.docNumber = docNumber;
    block.bg = INK;
    block.accent = ACCENT;
    block.showLogo = true;
  }
  return block;
}

function infoCard(label: string, name: string, lines: string, accent = ACCENT): DocumentBlock {
  const block = newBlock("infoCard");
  if (block.type === "infoCard") {
    block.label = label;
    block.name = name;
    block.lines = lines;
    block.accent = accent;
  }
  return block;
}

function lineItems(): DocumentBlock {
  return newBlock("lineItems");
}

function totalBand(label: string, amount: string): DocumentBlock {
  const block = newBlock("totalBand");
  if (block.type === "totalBand") {
    block.label = label;
    block.amount = amount;
    block.color = ACCENT;
  }
  block.settings = { width: 55, horizontalAlignment: "right" };
  return block;
}

function footer(): DocumentBlock {
  return newBlock("footer");
}

function signatureStrip(leftLabel: string, rightLabel: string): DocumentBlock[] {
  return [
    text(`\n${leftLabel}\n\n_______________________`),
    text(`\n${rightLabel}\n\n_______________________`),
  ];
}

function documentModel(title: string, blocks: DocumentBlock[][]): DocumentModel {
  return {
    schemaVersion: 1,
    title,
    style: { fontFamily: "sans", pageSize: "A4", margin: 40, accent: ACCENT, ink: INK },
    recipients: [],
    pages: [
      newPage(
        blocks.map((row) =>
          newRow(
            row.length === 1
              ? [newColumn(100, row)]
              : row.map((block) => newColumn(Math.floor(100 / row.length), [block])),
          ),
        ),
      ),
    ],
    header: [],
    footer: [],
  };
}

// ── invoice / sales agreement: laid out as the fixed print pages print them ──

const SLATE = "#64748b";

/** Renders only when `when` is truthy against the bound record. */
function conditional(when: string, blocks: DocumentBlock[]): DocumentBlock {
  const block = newBlock("conditional");
  if (block.type === "conditional") {
    block.when = when;
    block.blocks = blocks;
  }
  return block;
}

/** A labelled grey box of multi-line text (infoCard keeps the token's line breaks). */
function textBox(label: string, body: string): DocumentBlock {
  return infoCard(label, "", body, SLATE);
}

function italic(value: string): DocumentBlock {
  const block = newBlock("text");
  if (block.type === "text") block.value = [{ type: "p", children: [{ text: value, italic: true }] }];
  return block;
}

/** A signature line with its label underneath. */
function signLine(label: string): DocumentBlock {
  const block = newBlock("text");
  if (block.type === "text") {
    block.value = [
      { type: "p", children: [{ text: "" }] },
      { type: "p", children: [{ text: "________________________________" }] },
      { type: "p", children: [{ text: label }] },
    ];
  }
  return block;
}

/** Subtotal and VAT above the total, only when the rows are ex-VAT (documentTotals). */
function exclusiveTaxLines(): DocumentBlock {
  const lines = newBlock("text");
  if (lines.type === "text") {
    lines.value = [
      { type: "p", align: "right", children: [{ text: "Subtotal: {{quote.subtotal}}" }] },
      { type: "p", align: "right", children: [{ text: "VAT: {{quote.vat}}" }] },
    ];
  }
  const block = conditional("!quote.taxInclusive", [lines]);
  block.settings = { width: 55, horizontalAlignment: "right" };
  return block;
}

function invoiceTemplate(): DocumentModel {
  return documentModel("Standard invoice", [
    [banner("INVOICE", "{{invoice.number}}")],
    [
      text("Date: {{invoice.date}}"),
      text("Reference: {{quote.number}}", "center"),
      text("Billed to: {{customer.name}}", "right"),
    ],
    [conditional("invoice.intro", [italic("{{invoice.intro}}")])],
    [
      infoCard("BILLED TO", "{{customer.name}}", "{{invoice.billedTo}}"),
      infoCard("INVOICE DETAILS", "Invoice {{invoice.number}}", "Quote {{quote.number}}\nStatus: {{quote.status}}", INK),
    ],
    [lineItems()],
    [exclusiveTaxLines()],
    [totalBand("TOTAL INCL. VAT", "{{quote.total}}")],
    // Both texts come from Settings → Documents → Invoice, as on the old page.
    [conditional("invoice.paymentTerms", [textBox("PAYMENT TERMS", "{{invoice.paymentTerms}}")])],
    [conditional("invoice.bankingDetails", [textBox("PAYMENT DETAILS", "{{invoice.bankingDetails}}")])],
    [signLine("Received by · Date")],
    [footer()],
  ]);
}

function agreementTemplate(): DocumentModel {
  return documentModel("Sales agreement", [
    [banner("SALES AGREEMENT", "{{agreement.number}}")],
    [text("Date: {{agreement.date}}"), text("Reference: {{quote.number}}", "right")],
    [conditional("agreement.intro", [italic("{{agreement.intro}}")])],
    [
      infoCard("PURCHASER", "{{customer.name}}", "{{agreement.purchaser}}"),
      infoCard("SELLER", "{{company.name}}", "{{company.tagline}}\n{{company.address}}", INK),
    ],
    [lineItems()],
    [exclusiveTaxLines()],
    [totalBand("PURCHASE PRICE", "{{quote.total}}")],
    // The clauses come from Settings → Documents → Sales agreement, as on the old page.
    [conditional("agreement.clauses", [textBox("TERMS OF SALE", "{{agreement.clauses}}")])],
    [signLine("Purchaser signature · Date"), signLine("For {{company.name}} · Date")],
    [footer()],
  ]);
}

// ── Indemnity + warranty claim: laid out like their legacy print pages ──

/** Small text, as the legacy meta strip under the banner. */
function small(block: DocumentBlock): DocumentBlock {
  block.settings = { ...block.settings, fontScale: 0.8 };
  return block;
}

/** Small italic note, as the legacy "intro" line under the banner. */
function note(value: string): DocumentBlock {
  const block = newBlock("text");
  if (block.type === "text") block.value = [{ type: "p", children: [{ text: value, italic: true }] }];
  return small(block);
}

/** A signature line with its label beneath. Paragraphs, because "\n" in a text leaf does not break. */
function smallSignLine(label: string): DocumentBlock {
  const block = newBlock("text");
  if (block.type === "text") {
    block.value = ["", "", "________________________________________", label].map((line) => ({
      type: "p",
      children: [{ text: line }],
    }));
  }
  return small(block);
}

function indemnityTemplate(): DocumentModel {
  return documentModel("Test-drive indemnity", [
    [banner("TEST-DRIVE INDEMNITY", "")],
    [small(text("Date: {{date.today}}"))],
    [note("Please read and sign before the test drive.")],
    [
      infoCard("DRIVER", "{{customer.name}}", "{{customer.lines}}"),
      infoCard("VEHICLE", "{{vehicle}}", "{{vehicle.lines}}", INK),
    ],
    [infoCard(
      "TO BE COMPLETED BY THE DRIVER",
      "",
      "Driver's licence number: ______________________________\n\nID / passport number: ______________________________",
      SLATE,
    )],
    [infoCard(
      "INDEMNITY & WAIVER",
      "",
      "I, the undersigned, acknowledge that I am test-driving the vehicle entirely at my own risk. I confirm that I hold a valid driver's licence, will follow all instructions given by {{company.name}} staff, and accept liability for any damage caused by my negligence during the test drive. {{company.name}}, its owners and employees are indemnified against any claim for injury, loss or damage arising from the test drive, to the fullest extent permitted by law.",
      SLATE,
    )],
    [smallSignLine("Driver signature · Date"), smallSignLine("For {{company.name}} · Date")],
    [footer()],
  ]);
}

/** Description + quantity only: a delivery note and a service report list what, not what it cost. */
function packingList(): DocumentBlock {
  const block = newBlock("lineItems");
  if (block.type === "lineItems") block.columns = block.columns.filter((c) => c.key === "description" || c.key === "qty");
  return block;
}

// Mirrors the fixed delivery-note print: meta line, deliver-to / details cards,
// packing list, the guided handover checklist and signature, sign-off lines.
function deliveryTemplate(): DocumentModel {
  return documentModel("Delivery note", [
    [banner("DELIVERY NOTE", "{{delivery.number}}")],
    [text("{{delivery.meta}}")],
    [
      infoCard("DELIVER TO", "{{customer.name}}", "{{delivery.deliverTo}}"),
      infoCard("DELIVERY DETAILS", "", "{{delivery.details}}", INK),
    ],
    [packingList()],
    [newBlock("handoverChecklist")],
    signatureStrip("Received in good order — customer & date", "Driver & date"),
    [footer()],
  ]);
}

function jobcardTemplate(): DocumentModel {
  return documentModel("Job card", [
    [banner("JOB CARD", "{{jobcard.number}}")],
    [
      infoCard("CUSTOMER", "{{customer.name}}", "{{customer.phone}}\n{{customer.email}}"),
      infoCard("VEHICLE", "{{vehicle}}", "VIN {{vehicle.vin}} · Reg {{vehicle.reg}}\nColour {{vehicle.color}}", INK),
    ],
    [text("Opened: {{jobcard.opened}}"), text("Technician: {{technician}}", "right")],
    [heading("Work requested")],
    [text("{{jobcard.description}}")],
    [heading("Parts & labour")],
    [lineItems()],
    [totalBand("TOTAL INCL. VAT", "{{jobcard.total}}")],
    signatureStrip("Customer sign-off & date", "Technician & date"),
    [footer()],
  ]);
}

// Mirrors the fixed service-report print: meta line, customer / vehicle cards,
// work carried out, parts & labour, next service due, sign-off lines.
function serviceReportTemplate(): DocumentModel {
  return documentModel("Service report", [
    [banner("SERVICE REPORT", "{{service.number}}")],
    [text("{{service.meta}}")],
    [
      infoCard("CUSTOMER", "{{customer.name}}", "{{service.customerLines}}"),
      infoCard("VEHICLE", "{{vehicle}}", "{{service.vehicleLines}}", INK),
    ],
    [conditional("service.hasSummary", [infoCard("WORK CARRIED OUT", "", "{{service.work}}", INK)])],
    [conditional("jobcard.lines.length > 0", [packingList()])],
    [conditional("service.hasNextDue", [infoCard("NEXT SERVICE DUE", "{{service.nextDue}}", "")])],
    signatureStrip("Customer & date", "Technician & date"),
    [footer()],
  ]);
}

function warrantyClaimTemplate(): DocumentModel {
  // The resolution box only prints once there is one, as on the legacy page.
  const resolution = newBlock("conditional");
  if (resolution.type === "conditional") {
    resolution.when = "claim.hasResolution";
    resolution.blocks = [infoCard("RESOLUTION", "", "{{claim.resolutionLine}}", SLATE)];
  }
  return documentModel("Warranty claim", [
    [banner("WARRANTY CLAIM", "{{claim.number}}")],
    [small(text("Claimed: {{claim.date}}")), small(text("Status: {{claim.status}}", "right"))],
    [note("Warranty claim as recorded by {{company.name}}.")],
    [
      infoCard("CUSTOMER", "{{customer.name}}", "{{customer.lines}}"),
      infoCard("VEHICLE & WARRANTY", "{{vehicle}}", "{{vehicle.lines}}", INK),
    ],
    [infoCard("REPORTED FAULT", "", "{{claim.description}}", SLATE)],
    [resolution],
    [smallSignLine("Customer · Date"), smallSignLine("For {{company.name}} · Date")],
    [footer()],
  ]);
}

const BUILDERS: Record<StandardDocKey, () => DocumentModel> = {
  quote: standardQuoteTemplate,
  invoice: invoiceTemplate,
  agreement: agreementTemplate,
  indemnity: indemnityTemplate,
  delivery: deliveryTemplate,
  jobcard: jobcardTemplate,
  "service-report": serviceReportTemplate,
  "warranty-claim": warrantyClaimTemplate,
};

export const STANDARD_TEMPLATE_KEYS = Object.keys(BUILDERS) as StandardDocKey[];

export const STANDARD_TEMPLATE_NAMES: Record<StandardDocKey, string> = {
  quote: "Quotation",
  invoice: "Invoice",
  agreement: "Sales agreement",
  indemnity: "Test-drive indemnity",
  delivery: "Delivery note",
  jobcard: "Job card",
  "service-report": "Service report",
  "warranty-claim": "Warranty claim",
};

export function standardTemplateFor(key: StandardDocKey): DocumentModel {
  return BUILDERS[key]();
}
