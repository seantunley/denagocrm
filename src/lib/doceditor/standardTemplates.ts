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

function text(
  value: string,
  align: "left" | "center" | "right" = "left",
): DocumentBlock {
  const block = newBlock("text");
  if (block.type === "text") {
    block.value = [{ type: "p", align, children: [{ text: value }] }];
  }
  return block;
}

function heading(value: string): DocumentBlock {
  const block = newBlock("heading");
  if (block.type === "heading") {
    block.value = [{ type: "h2", children: [{ text: value }] }];
  }
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

function infoCard(
  label: string,
  name: string,
  lines: string,
  accent = ACCENT,
): DocumentBlock {
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

/** Visual signature guides; the signing flow adds recipient-bound overlay fields. */
function signatureStrip(
  leftLabel: string,
  rightLabel: string,
): DocumentBlock[] {
  return [
    text(`\n${leftLabel}\n\n_______________________`),
    text(`\n${rightLabel}\n\n_______________________`),
  ];
}

function documentModel(
  title: string,
  blocks: DocumentBlock[][],
): DocumentModel {
  return {
    schemaVersion: 1,
    title,
    style: {
      fontFamily: "sans",
      pageSize: "A4",
      margin: 40,
      accent: ACCENT,
      ink: INK,
    },
    recipients: [],
    pages: [
      newPage(
        blocks.map((row) =>
          newRow(
            row.length === 1
              ? [newColumn(100, row)]
              : row.map((block) =>
                  newColumn(Math.floor(100 / row.length), [block]),
                ),
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
    [
      text("Invoice date: {{quote.date}}"),
      text("Prepared by: {{preparedBy}}", "right"),
    ],
    [
      infoCard(
        "BILLED TO",
        "{{customer.name}}",
        "{{customer.phone}}\n{{customer.email}}\n{{customer.address}}",
      ),
      infoCard(
        "FROM",
        "{{company.name}}",
        "{{company.address}}\n{{company.phone}} · {{company.email}}",
        INK,
      ),
    ],
    [lineItems()],
    [totalBand("TOTAL DUE INCL. VAT", "{{quote.total}}")],
    [
      terms("BANKING & PAYMENT", [
        "Bank: (add your banking details in the template)",
        "Reference: {{quote.number}}",
        "Prices include 15% VAT.",
        "Payment due on presentation unless otherwise agreed.",
      ]),
    ],
    [footer()],
  ]);
}

function agreementTemplate(): DocumentModel {
  return documentModel("Sales agreement", [
    [banner("SALES AGREEMENT", "{{quote.number}}")],
    [
      infoCard(
        "BUYER",
        "{{customer.name}}",
        "{{customer.phone}}\n{{customer.email}}\n{{customer.address}}",
      ),
      infoCard(
        "SELLER",
        "{{company.name}}",
        "{{company.address}}\n{{company.phone}}",
        INK,
      ),
    ],
    [heading("Vehicle & items")],
    [lineItems()],
    [totalBand("TOTAL INCL. VAT", "{{quote.total}}")],
    [
      terms("AGREEMENT CLAUSES", [
        "The buyer agrees to purchase the vehicle(s) and items listed above at the stated price.",
        "A 50% deposit secures the order; the balance is payable on delivery.",
        "Denago EVs are Low-Speed Vehicles for private-property use and are not road registered.",
        "Warranty: 12 months limited; battery 24 months.",
        "This agreement is governed by the laws of South Africa.",
      ]),
    ],
    signatureStrip("Buyer signature & date", "For {{company.name}} & date"),
    [footer()],
  ]);
}

function indemnityTemplate(): DocumentModel {
  return documentModel("Test-drive indemnity", [
    [banner("TEST-DRIVE INDEMNITY", "{{date.today}}")],
    [
      infoCard(
        "DRIVER",
        "{{customer.name}}",
        "{{customer.phone}}\n{{customer.email}}",
      ),
    ],
    [
      text(
        "I, the undersigned, acknowledge that I am about to operate an electric Low-Speed Vehicle supplied by {{company.name}} for the purpose of a demonstration drive.\n\n" +
          "I confirm that I hold a valid driver's licence, will operate the vehicle responsibly and on private property only, and accept full responsibility for any damage, injury or loss arising from my use of the vehicle during the demonstration.\n\n" +
          "I indemnify {{company.name}} against all claims arising from the demonstration drive.",
      ),
    ],
    signatureStrip(
      "Driver signature & date",
      "Witness (for {{company.name}}) & date",
    ),
    [footer()],
  ]);
}

function deliveryTemplate(): DocumentModel {
  return documentModel("Delivery note", [
    [banner("DELIVERY NOTE", "{{quote.number}}")],
    [
      infoCard(
        "DELIVER TO",
        "{{customer.name}}",
        "{{customer.phone}}\n{{customer.address}}",
      ),
      infoCard(
        "FROM",
        "{{company.name}}",
        "{{company.address}}\n{{company.phone}}",
        INK,
      ),
    ],
    [heading("Items delivered")],
    [lineItems()],
    [
      terms("HANDOVER CHECKLIST", [
        "Vehicle inspected and free of visible damage at handover.",
        "Charger and accessories supplied.",
        "Operation, charging and safety explained to the customer.",
        "Warranty and service schedule handed over.",
      ]),
    ],
    signatureStrip(
      "Received by (customer) & date",
      "Delivered by (for {{company.name}}) & date",
    ),
    [footer()],
  ]);
}

function jobcardTemplate(): DocumentModel {
  return documentModel("Job card", [
    [banner("JOB CARD", "{{jobcard.number}}")],
    [
      infoCard(
        "CUSTOMER",
        "{{customer.name}}",
        "{{customer.phone}}\n{{customer.email}}",
      ),
      infoCard(
        "VEHICLE",
        "{{vehicle}}",
        "VIN {{vehicle.vin}} · Reg {{vehicle.reg}}\nColour {{vehicle.color}}",
        INK,
      ),
    ],
    [
      text("Opened: {{jobcard.opened}}"),
      text("Technician: {{technician}}", "right"),
    ],
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
      infoCard(
        "VEHICLE",
        "{{vehicle}}",
        "VIN {{vehicle.vin}} · {{jobcard.km}}",
        INK,
      ),
    ],
    [
      text("Serviced: {{jobcard.completed}}"),
      text("Technician: {{technician}}", "right"),
    ],
    [heading("Work performed & parts")],
    [lineItems()],
    [
      terms("NEXT SERVICE", [
        "We recommend the next service per the maintenance schedule.",
        "Contact {{company.name}} on {{company.phone}} to book.",
      ]),
    ],
    signatureStrip("Customer & date", "For {{company.name}} & date"),
    [footer()],
  ]);
}

function warrantyClaimTemplate(): DocumentModel {
  return documentModel("Warranty claim", [
    [banner("WARRANTY CLAIM", "{{date.today}}")],
    [
      infoCard(
        "CUSTOMER",
        "{{customer.name}}",
        "{{customer.phone}}\n{{customer.email}}",
      ),
      infoCard(
        "VEHICLE & WARRANTY",
        "{{vehicle}}",
        "VIN {{vehicle.vin}} · Reg {{vehicle.reg}}",
        INK,
      ),
    ],
    [heading("Fault description")],
    [
      text(
        "Describe the fault, when it occurred and the conditions under which it happens.",
      ),
    ],
    [heading("Assessment")],
    [text("Technician assessment, parts required and recommended remedy.")],
    signatureStrip("Customer & date", "For {{company.name}} & date"),
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

export const STANDARD_TEMPLATE_KEYS = Object.keys(
  BUILDERS,
) as StandardDocKey[];

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
