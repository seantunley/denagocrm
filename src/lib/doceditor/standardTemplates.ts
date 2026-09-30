/**
 * Standard builder templates for every operational document type, stored in the
 * current doceditor DocumentModel format. They mirror the live documents so the
 * builder starts from a useful layout rather than a blank page.
 */
import type { DocumentBlock, DocumentModel } from "./model";
import { PAGE_SIZES } from "./model";
import {
  newBlock,
  newColumn,
  newOverlayField,
  newPage,
  newRecipient,
  newRow,
  standardQuoteTemplate,
  uid,
} from "./factory";
import { ACCEPTANCE_GEOMETRY, FOOTER_BAND_HEIGHT, SHOWCASE_COMPACT_HEADER_HEIGHT, SHOWCASE_INSET, acceptanceHeight } from "./showcaseRender";
import { SHOWCASE_FOOTER_IMAGE, SHOWCASE_HEADER_IMAGE } from "./showcaseAssets";

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
// (SLATE is declared once, above, with the invoice/agreement helpers.)

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

/**
 * A SMALL signature line with its label beneath, as the indemnity and warranty
 * legacy pages print it. Paragraphs, because "\n" in a text leaf does not break.
 * Distinct from signLine (invoice/agreement): #673 and #674 each added a helper
 * by that name, and the merge kept both.
 */
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

/**
 * Mirrors the fixed job-card printout (app/(print)/jobcards/[id]/print): same
 * sections, order and wording. Sections the printout shows only sometimes are
 * conditionals on the vars jobCardPrintFields adds.
 */
function jobcardTemplate(): DocumentModel {
  const label = (value: string): DocumentBlock => {
    const block = newBlock("text");
    if (block.type === "text") block.value = [{ type: "p", children: [{ text: value.toUpperCase(), bold: true }] }];
    return block;
  };
  const when = (expr: string, blocks: DocumentBlock[]): DocumentBlock => {
    const block = newBlock("conditional");
    if (block.type === "conditional") {
      block.when = expr;
      block.blocks = blocks;
    }
    return block;
  };
  const right = (block: DocumentBlock): DocumentBlock => {
    block.settings = { width: 45, horizontalAlignment: "right" };
    return block;
  };
  const signature = newBlock("image");
  if (signature.type === "image") {
    signature.src = "{{jobcard.signature}}";
    signature.alt = "Signature";
    signature.widthPct = 30;
  }
  const one = (...blocks: DocumentBlock[]) => newRow([newColumn(100, blocks)]);
  const doc = documentModel("Job card", []);
  doc.pages = [
    newPage([
      one(banner("JOB CARD", "{{jobcard.number}}"), text("{{jobcard.stage}}", "right")),
      newRow([
        newColumn(50, [infoCard("CUSTOMER", "{{customer.name}}", "{{customer.phone}}\n{{customer.email}}\n{{customer.address}}")]),
        newColumn(50, [infoCard("VEHICLE", "{{vehicle.title}}", "{{vehicle.lines}}", INK)]),
      ]),
      one(label("Work requested"), text("{{jobcard.description}}")),
      one(lineItems()),
      one(
        right(text("Parts: {{jobcard.parts}}", "right")),
        right(text("Labour: {{jobcard.labour}}", "right")),
        right(when("jobcard.other != 0", [text("Other: {{jobcard.other}}", "right")])),
        totalBand("TOTAL", "{{jobcard.total}}"),
      ),
      one(when("jobcard.hasService", [
        label("Service record"),
        text("{{service.line}}"),
        when("jobcard.hasServiceDetails", [text("{{service.details}}")]),
        text("Next service due: {{service.nextDue}}"),
      ])),
      one(when("jobcard.hasNotes", [label("Notes"), text("{{jobcard.notes}}")])),
      one(when("jobcard.signed", [signature, text("{{jobcard.signedLine}}")])),
      newRow(
        ["Technician signature · Date", "Customer signature · Date"].map((line) =>
          newColumn(50, [when("!jobcard.signed", [text("________________________________"), text(line)])]),
        ),
      ),
      one(footer(), text("{{company.name}} · Job card {{jobcard.number}} · Generated {{date.today}}", "center")),
    ]),
  ];
  return doc;
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
    [smallSignLine("Customer · Date"), smallSignLine("For {{company.name}} · Date")],
    [footer()],
  ]);
}

/**
 * The premium "showcase" quotation: dark header band, info strip, a vehicle hero
 * bound to the quote's primary vehicle (its Product's photo, tagline and specs),
 * line items, a totals box, terms + acceptance cards and a dark footer band.
 *
 * NOT one of BUILDERS — it is an alternative quote layout the owner applies in
 * the editor (Palette → Layouts), so the live default quote template is never
 * touched by this code.
 *
 * GEOMETRY. The page has NO margin: the header and footer bands run edge to
 * edge and the hero photo bleeds off the right edge, as in the design. Every
 * other section shares one content column, inset SHOWCASE_INSET px each side —
 * the content rows by their own padding, the floating cards by their x/width.
 *
 * The bottom band (terms, acceptance, footer) is FLOATING at fixed page
 * coordinates, because the customer's signature and date are overlay fields at
 * page coordinates and must sit on the acceptance card's lines however long the
 * flowed content above is. The flow therefore has a height budget: three
 * line-item/fee rows fit above the bottom band on one A4 sheet.
 */
/**
 * Line-item/fee rows: with the full-height hero; on one page at all (the hero
 * shrinking); and above page 1's footer band once the cards have moved on.
 */
export const SHOWCASE_ROWS_FULL_HERO = 3;
export const SHOWCASE_ROWS_ABOVE_CARDS = 6;
export const SHOWCASE_ROWS_ABOVE_FOOTER = 9;

export function showcaseQuoteTemplate(): DocumentModel {
  const PAGE = PAGE_SIZES.A4;
  const inset = SHOWCASE_INSET;
  const contentW = PAGE.w - inset * 2;
  const gap = 14;
  const cardW = Math.floor((contentW - gap) / 2);
  // PAGE.h is the rounded A4 height (1123 vs the exact 1122.52), so stop a
  // pixel short of the sheet edge or the band spills onto a second sheet.
  const footerY = PAGE.h - 1 - FOOTER_BAND_HEIGHT;
  const cardsY = footerY - 14 - acceptanceHeight();
  const acceptX = inset + cardW + gap;
  const content = { top: 0, right: inset, bottom: 0, left: inset };
  const padded = (blocks: DocumentBlock[], padding = content) => {
    const row = newRow([newColumn(100, blocks)]);
    row.settings = { ...row.settings, padding };
    return row;
  };

  const vehicle = (part: "details" | "image") => {
    const block = newBlock("vehicleShowcase");
    if (block.type === "vehicleShowcase") {
      block.part = part;
      block.imageHeight = 356; // with the text column beside it, leaves room for three table rows
      block.imageFit = "cover"; // scenic product photos fill the hero and fade into the page
      // One table row is ~33px: each extra row takes that from the hero instead.
      block.shrink = { afterRows: SHOWCASE_ROWS_FULL_HERO, untilRows: SHOWCASE_ROWS_ABOVE_CARDS, perRow: 33, minHeight: 260 };
    }
    return block;
  };
  const header = newBlock("showcaseHeader");
  if (header.type === "showcaseHeader") header.bgImage = SHOWCASE_HEADER_IMAGE;
  const footerBand = newBlock("footerBand");
  if (footerBand.type === "footerBand") footerBand.bgImage = SHOWCASE_FOOTER_IMAGE;
  const preparedFor = infoCard("PREPARED FOR", "{{customer.name}}", "{{customer.phone}}\n{{customer.email}}");
  if (preparedFor.type === "infoCard") preparedFor.look = "showcase";
  const items = newBlock("lineItems");
  if (items.type === "lineItems") {
    items.look = "showcase";
    items.headerBg = "#0b1220";
    items.columns = [
      { key: "description", header: "Description", align: "left", showIf: "" },
      { key: "qty", header: "Qty", align: "right", showIf: "" },
      { key: "unitPrice", header: "Unit price (incl. VAT)", align: "right", showIf: "" },
      { key: "total", header: "Total (incl. VAT)", align: "right", showIf: "" },
    ];
  }
  const totals = newBlock("totalsBox");
  totals.settings = { width: 46, horizontalAlignment: "right" };
  // The standard quote's terms, each its own bullet.
  const quoteTerms = terms("QUOTATION TERMS", [
    "Quote valid for 14 days.",
    "50% deposit to secure build slot; balance on delivery.",
    "Prices are recommended retail, including 15% VAT, and subject to change without notice.",
    "Denago EVs are Low-Speed Vehicles for private-property use and are not road registered.",
    "E & O.E.",
  ]);
  if (quoteTerms.type === "terms") quoteTerms.look = "showcase";

  const customer = newRecipient({ name: "Customer", role: "signer", party: "customer", color: "#2563eb" });
  const g = ACCEPTANCE_GEOMETRY;
  const lineX = acceptX + g.padX + g.labelW + g.gap;
  const lineW = cardW - g.padX * 2 - g.labelW - g.gap;
  const sigTop = cardsY + g.pad + g.headerH + g.headerGap + g.textH + g.nameRowH;

  const hero = newRow([newColumn(44, [preparedFor, vehicle("details")]), newColumn(56, [vehicle("image")])]);
  // Inset on the left only: the photo bleeds to the right page edge.
  hero.settings = { ...hero.settings, gap: 0, padding: { top: 0, right: 0, bottom: 0, left: inset } };

  const page = newPage([
    padded([header], { top: 0, right: 0, bottom: 0, left: 0 }),
    padded([newBlock("infoStrip")]),
    hero,
    padded([items]),
    padded([totals]),
  ]);
  const termsFloat = { id: uid(), x: inset, y: cardsY, width: cardW, block: quoteTerms };
  const acceptFloat = { id: uid(), x: acceptX, y: cardsY, width: cardW, block: newBlock("acceptance") };
  const footerFloat = { id: uid(), x: 0, y: footerY, width: PAGE.w, block: footerBand };
  page.floatingBlocks = [termsFloat, acceptFloat, footerFloat];
  page.overlayFields = [
    newOverlayField("signature", {
      recipientId: customer.id, label: "Customer signature",
      anchor: { mode: "page", blockId: null, x: lineX, y: sigTop + 2 }, width: lineW, height: g.sigRowH - 4,
    }),
    newOverlayField("date", {
      recipientId: customer.id, label: "Date",
      anchor: { mode: "page", blockId: null, x: lineX, y: sigTop + g.sigRowH + 1 }, width: Math.min(160, lineW), height: g.dateRowH - 2,
    }),
  ];
  // Longer quotes, in two steps (row counts measured in headless Chrome — see
  // the PR and tests):
  //  1. Beyond SHOWCASE_ROWS_FULL_HERO rows the hero shrinks (block `shrink`),
  //     so up to SHOWCASE_ROWS_ABOVE_CARDS rows still fit on ONE page.
  //  2. Beyond that the hero returns to full size and the cards (with the
  //     signature and date fields) continue on a proper second page: a compact
  //     header band at the top, the cards under it, the footer band at the foot.
  //     Page 1 keeps its own footer band while the table leaves room for it.
  const continuationHeader = newBlock("showcaseHeader");
  if (continuationHeader.type === "showcaseHeader") {
    continuationHeader.bgImage = SHOWCASE_HEADER_IMAGE;
    continuationHeader.compact = true;
  }
  page.overflowGroups = [
    {
      maxItems: SHOWCASE_ROWS_ABOVE_CARDS,
      floatIds: [termsFloat.id, acceptFloat.id],
      fieldIds: page.overlayFields.map((f) => f.id),
      topOnNextPage: SHOWCASE_COMPACT_HEADER_HEIGHT + 24,
      nextPageFloats: [
        { id: uid(), x: 0, y: 0, width: PAGE.w, block: continuationHeader },
        { id: uid(), x: 0, y: footerY, width: PAGE.w, block: { ...footerBand, id: uid() } },
      ],
    },
    { maxItems: SHOWCASE_ROWS_ABOVE_FOOTER, floatIds: [footerFloat.id], fieldIds: [], drop: true },
  ];

  return {
    schemaVersion: 1,
    title: "Showcase quotation",
    style: { fontFamily: "sans", pageSize: "A4", margin: 0, accent: ACCENT, ink: INK },
    recipients: [customer],
    pages: [page],
    header: [],
    footer: [],
  };
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
