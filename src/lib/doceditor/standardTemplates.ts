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

function terms(title: string, items: string[]): DocumentBlock {
  const block = newBlock("terms");
  if (block.type === "terms") {
    block.title = title;
    block.items = items.map((item) => ({ text: item }));
  }
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

function invoiceTemplate(): DocumentModel {
  return documentModel("Standard invoice", [
    [banner("INVOICE", "{{quote.number}}")],
    [text("Invoice date: {{quote.date}}"), text("Prepared by: {{preparedBy}}", "right")],
    [
      infoCard("BILLED TO", "{{customer.name}}", "{{customer.phone}}\n{{customer.email}}\n{{customer.address}}"),
      infoCard("FROM", "{{company.name}}", "{{company.address}}\n{{company.phone}} · {{company.email}}", INK),
    ],
    [lineItems()],
    [totalBand("TOTAL DUE INCL. VAT", "{{quote.total}}")],
    [terms("BANKING & PAYMENT", [
      "Bank: (add your banking details in the template)",
      "Reference: use the document number shown above.",
      "Prices include 15% VAT.",
      "Payment due on presentation unless otherwise agreed.",
    ])],
    [footer()],
  ]);
}

function agreementTemplate(): DocumentModel {
  return documentModel("Sales agreement", [
    [banner("SALES AGREEMENT", "{{quote.number}}")],
    [
      infoCard("BUYER", "{{customer.name}}", "{{customer.phone}}\n{{customer.email}}\n{{customer.address}}"),
      infoCard("SELLER", "{{company.name}}", "{{company.address}}\n{{company.phone}}", INK),
    ],
    [heading("Vehicle & items")],
    [lineItems()],
    [totalBand("TOTAL INCL. VAT", "{{quote.total}}")],
    [terms("AGREEMENT CLAUSES", [
      "The buyer agrees to purchase the vehicle(s) and items listed above at the stated price.",
      "A 50% deposit secures the order; the balance is payable on delivery.",
      "Denago EVs are Low-Speed Vehicles for private-property use and are not road registered.",
      "Warranty: 12 months limited; battery 24 months.",
      "This agreement is governed by the laws of South Africa.",
    ])],
    signatureStrip("Buyer signature & date", "For {{company.name}} & date"),
    [footer()],
  ]);
}

// ── Indemnity + warranty claim: laid out like their legacy print pages ──
const SLATE = "#64748b";

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
function signLine(label: string): DocumentBlock {
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
    [signLine("Driver signature · Date"), signLine("For {{company.name}} · Date")],
    [footer()],
  ]);
}

function deliveryTemplate(): DocumentModel {
  return documentModel("Delivery note", [
    [banner("DELIVERY NOTE", "{{quote.number}}")],
    [
      infoCard("DELIVER TO", "{{customer.name}}", "{{customer.phone}}\n{{customer.address}}"),
      infoCard("FROM", "{{company.name}}", "{{company.address}}\n{{company.phone}}", INK),
    ],
    [heading("Items delivered")],
    [lineItems()],
    [terms("HANDOVER CHECKLIST", [
      "Vehicle inspected and free of visible damage at handover.",
      "Charger and accessories supplied.",
      "Operation, charging and safety explained to the customer.",
      "Warranty and service schedule handed over.",
    ])],
    signatureStrip("Received by (customer) & date", "Delivered by (for {{company.name}}) & date"),
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

function serviceReportTemplate(): DocumentModel {
  return documentModel("Service report", [
    [banner("SERVICE REPORT", "{{jobcard.number}}")],
    [
      infoCard("CUSTOMER", "{{customer.name}}", "{{customer.phone}}"),
      infoCard("VEHICLE", "{{vehicle}}", "VIN {{vehicle.vin}} · {{jobcard.km}}", INK),
    ],
    [text("Serviced: {{jobcard.completed}}"), text("Technician: {{technician}}", "right")],
    [heading("Work performed & parts")],
    [lineItems()],
    [terms("NEXT SERVICE", [
      "We recommend the next service per the maintenance schedule.",
      "Use the company contact details in the footer to book.",
    ])],
    signatureStrip("Customer & date", "For {{company.name}} & date"),
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
    [signLine("Customer · Date"), signLine("For {{company.name}} · Date")],
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
