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
import { CLASSIC_FOOTER_HEIGHT, FOOTER_BAND_HEIGHT, SHOWCASE_COMPACT_HEADER_HEIGHT, SHOWCASE_INSET, acceptanceFieldRects, acceptanceHeight } from "./showcaseRender";
import { SHOWCASE_FOOTER_IMAGE, SHOWCASE_HEADER_IMAGE } from "./showcaseAssets";
import { inlineLegacyText } from "./inlineLegacyText";
import { DOC_DEFS } from "../docTemplates";

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
    // Written in by BUILDERS below (inlineLegacyText), edited here like any text.
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

/** The top of the indemnity: who is driving what, and when. */
function indemnityHead(): DocumentBlock[][] {
  return [
    [banner("TEST-DRIVE INDEMNITY", "")],
    [small(text("Date: {{date.today}}"))],
    [note("Please read and sign before the test drive.")],
    [
      infoCard("DRIVER", "{{customer.name}}", "{{customer.lines}}"),
      infoCard("VEHICLE", "{{vehicle}}", "{{vehicle.lines}}", INK),
    ],
  ];
}

function indemnityWaiver(): DocumentBlock[] {
  return [infoCard(
    "INDEMNITY & WAIVER",
    "",
    "I, the undersigned, acknowledge that I am test-driving the vehicle entirely at my own risk. I confirm that I hold a valid driver's licence, will follow all instructions given by {{company.name}} staff, and accept liability for any damage caused by my negligence during the test drive. {{company.name}}, its owners and employees are indemnified against any claim for injury, loss or damage arising from the test drive, to the fullest extent permitted by law.",
    SLATE,
  )];
}

function indemnityTemplate(): DocumentModel {
  return documentModel("Test-drive indemnity", [
    ...indemnityHead(),
    [infoCard(
      "TO BE COMPLETED BY THE DRIVER",
      "",
      "Driver's licence number: ______________________________\n\nID / passport number: ______________________________",
      SLATE,
    )],
    indemnityWaiver(),
    [smallSignLine("Driver signature · Date"), smallSignLine("For {{company.name}} · Date")],
    [footer()],
  ]);
}

/**
 * Where the driver signs on the screen version: page coordinates, inside the
 * room SIGN_ROOM keeps open between the waiver and the footer.
 *
 * Signature fields sit at fixed places on the page while the text above them
 * flows, so the two can only be kept apart by leaving room. What moves the text
 * is small and known — none to three lines under the driver's name, none to two
 * under the vehicle, and a waiver that runs a line or two longer for a long
 * company name. Measured in a browser, the waiver ends between 344px (nothing
 * but a name) and 450px (everything, and a 64-character company name) down the
 * page; the room is that 106px range plus the 94px the label and box take, and
 * the box sits where it is inside the room at both ends.
 *
 * ponytail: a fixed place, so text taller than that range would run under the
 * box. If the standard wording grows, re-measure — or give the signing engine
 * fields that flow with a block, which it does not have.
 */
export const INDEMNITY_SIGN_Y = 504;
const SIGN_ROOM = 220;

/**
 * The standard indemnity for signing on a SCREEN — the printed one without the
 * two parts that only work with a pen: the lines to write a licence and ID
 * number on (the booking holds the licence number, and it prints under the
 * driver's details), and the ruled signature lines. In their place the driver
 * has a signature box and a date under the waiver, on the same page: the
 * engine's own fallback is a page of its own for signatures, which here would
 * be a second sheet holding one box.
 *
 * Only the fallback: a workspace that has published its own indemnity layout
 * signs that one, exactly as drawn.
 */
export function indemnityTemplateForScreen(): DocumentModel {
  const room = newBlock("spacer");
  if (room.type === "spacer") room.height = SIGN_ROOM;
  const doc = documentModel("Test-drive indemnity", [...indemnityHead(), indemnityWaiver(), [room], [footer()]]);
  // The party, not a person: who the driver is comes from the booking when the
  // indemnity is made (signing/templateRecipients.ts).
  const driver = newRecipient({ party: "customer", name: "Driver", color: "#2563eb" });
  doc.recipients = [driver];
  const label = (x: number, value: string) => {
    const block = text(value);
    if (block.type === "text") block.value = [{ type: "p", children: [{ text: value, bold: true }] }];
    return { id: uid(), x, y: INDEMNITY_SIGN_Y - 30, width: 250, block: small(block) };
  };
  const at = (x: number, y: number) => ({ mode: "page" as const, blockId: null, x, y });
  doc.pages[0].floatingBlocks.push(label(70, "Driver's signature"), label(360, "Date"));
  doc.pages[0].overlayFields.push(
    newOverlayField("signature", { recipientId: driver.id, label: "Driver's signature", anchor: at(70, INDEMNITY_SIGN_Y), width: 250, height: 64 }),
    newOverlayField("date", { recipientId: driver.id, label: "Date", anchor: at(360, INDEMNITY_SIGN_Y + 13), width: 160, height: 38 }),
  );
  return doc;
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
    // Tokens, not literals — see factory.ts standardQuoteTemplate.
    "Quote valid until {{quote.validUntil}}.",
    "50% deposit to secure build slot; balance on delivery.",
    "Prices are recommended retail, including {{quote.vatRate}} VAT, and subject to change without notice.",
    "Denago EVs are Low-Speed Vehicles for private-property use and are not road registered.",
    "E & O.E.",
  ]);
  if (quoteTerms.type === "terms") quoteTerms.look = "showcase";

  const customer = newRecipient({ name: "Customer", role: "signer", party: "customer", color: "#2563eb" });
  const onLines = acceptanceFieldRects({ x: acceptX, y: cardsY, width: cardW });

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
      anchor: { mode: "page", blockId: null, x: onLines.signature.x, y: onLines.signature.y },
      width: onLines.signature.width, height: onLines.signature.height,
    }),
    newOverlayField("date", {
      recipientId: customer.id, label: "Date",
      anchor: { mode: "page", blockId: null, x: onLines.date.x, y: onLines.date.y },
      width: onLines.date.width, height: onLines.date.height,
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

/**
 * The invoice, laid out as Sean's mock-up (2026-10-07), in the "classic" look:
 * the photo header band (logo, TAX INVOICE, the labelled invoice number), a grey
 * info strip, BILL TO / FROM as plain columns, a light-headed table, subtotal and
 * VAT over the dark TOTAL DUE bar (amount in orange — Sean), then BANKING DETAILS
 * (label/value rows, the reference picked out) beside PAYMENT TERMS, a thank-you
 * line and a slim footer. No vehicle showcase, no acceptance, no signers.
 *
 * Every word is ordinary editable text in the document editor; "(add …)" lines
 * are there to be replaced once — the bank details and the VAT number.
 *
 * A long invoice moves the payment section to a second page under a compact
 * header (overflowGroups); the row counts are measured in headless Chrome
 * (tests/showcaseInvoice.test.ts).
 */
export const INVOICE_ROWS_ABOVE_CARDS = 4;
export const INVOICE_ROWS_ABOVE_FOOTER = 9;

function showcaseInvoiceTemplate(): DocumentModel {
  const PAGE = PAGE_SIZES.A4;
  const inset = SHOWCASE_INSET;
  const contentW = PAGE.w - inset * 2;
  const gap = 28;
  const cardW = Math.floor((contentW - gap) / 2);
  // The bottom of the page, upwards: footer line, thank-you line, the payment
  // section (banking details sized for six lines and the reference box), a rule.
  const footerY = PAGE.h - 1 - CLASSIC_FOOTER_HEIGHT;
  const thanksY = footerY - 38;
  const cardsH = 176;
  const cardsY = thanksY - 14 - cardsH;
  const ruleY = cardsY - 18;
  const content = { top: 0, right: inset, bottom: 0, left: inset };
  const padded = (blocks: DocumentBlock[], padding = content) => {
    const row = newRow([newColumn(100, blocks)]);
    row.settings = { ...row.settings, padding };
    return row;
  };
  const classicCard = (label: string, name: string, lines: string, divider = false) => {
    const block = infoCard(label, name, lines);
    if (block.type === "infoCard") {
      block.look = "classic";
      if (divider) block.divider = true;
    }
    return block;
  };

  const header = newBlock("showcaseHeader");
  if (header.type === "showcaseHeader") {
    header.style = "classic";
    header.title = "TAX INVOICE";
    header.subtitle = "{{company.name}}";
    header.numberLabel = "Invoice number";
    header.docNumber = "{{invoice.number}}";
    header.bgImage = SHOWCASE_HEADER_IMAGE;
  }
  const strip = newBlock("infoStrip");
  if (strip.type === "infoStrip") {
    strip.style = "classic";
    strip.items = [
      { icon: "calendar", label: "INVOICE DATE", value: "{{invoice.date}}", sub: "" },
      { icon: "calendarCheck", label: "QUOTE REFERENCE", value: "{{quote.number}}", sub: "" },
      { icon: "user", label: "PREPARED BY", value: "{{preparedBy}}", sub: "" },
    ];
  }
  const billTo = classicCard("BILL TO", "{{customer.name}}", "{{invoice.billedTo}}");
  const from = classicCard("FROM", "{{company.name}}", "{{company.address}}\nVAT No: (add your VAT number)\nT: {{company.phone}}\nE: {{company.email}}", true);
  const parties = newRow([newColumn(50, [billTo]), newColumn(50, [from])]);
  parties.settings = { ...parties.settings, gap, padding: { top: 20, right: inset, bottom: 6, left: inset } };

  const items = newBlock("lineItems");
  if (items.type === "lineItems") {
    items.look = "classic";
    items.columns = [
      { key: "description", header: "Description", align: "left", showIf: "" },
      { key: "qty", header: "Qty", align: "right", showIf: "" },
      { key: "unitPrice", header: "Unit price", align: "right", showIf: "" },
      { key: "total", header: "Total", align: "right", showIf: "" },
    ];
  }
  const totals = newBlock("totalsBox");
  totals.settings = { width: 46, horizontalAlignment: "right" };
  if (totals.type === "totalsBox") {
    totals.style = "classic";
    totals.totalLabel = "TOTAL DUE";
  }

  const banking = classicCard(
    "BANKING DETAILS",
    "",
    "Bank: (add your bank)\nAccount name: {{company.name}}\nAccount number: (add your account number)\nBranch code: (add your branch code)\nAccount type: (add the account type)\nReference: {{invoice.number}}",
  );
  const payment = classicCard(
    "PAYMENT TERMS",
    "",
    "Payment due within 7 days of the invoice date.\nPlease use the reference shown when making payment.\nPrices are subject to our standard terms and conditions.\nE & O.E.",
    true,
  );
  const rule = newBlock("divider");
  const thanks = text("Thank you for your business.");
  const footerBand = newBlock("footerBand");
  if (footerBand.type === "footerBand") {
    footerBand.style = "classic";
    footerBand.subtitle = "{{company.name}}   ·   {{company.website}}   ·   Invoice {{invoice.number}}";
  }

  const page = newPage([
    padded([header], { top: 0, right: 0, bottom: 0, left: 0 }),
    padded([strip], { top: 0, right: 0, bottom: 0, left: 0 }),
    parties,
    padded([items]),
    padded([totals]),
  ]);
  const ruleFloat = { id: uid(), x: inset, y: ruleY, width: contentW, block: rule };
  const bankingFloat = { id: uid(), x: inset, y: cardsY, width: cardW, block: banking };
  const paymentFloat = { id: uid(), x: inset + cardW + gap, y: cardsY, width: cardW, block: payment };
  const thanksFloat = { id: uid(), x: inset, y: thanksY, width: contentW, block: thanks };
  const footerFloat = { id: uid(), x: 0, y: footerY, width: PAGE.w, block: footerBand };
  page.floatingBlocks = [ruleFloat, bankingFloat, paymentFloat, thanksFloat, footerFloat];
  const continuationHeader = newBlock("showcaseHeader");
  if (continuationHeader.type === "showcaseHeader") {
    continuationHeader.title = "TAX INVOICE";
    continuationHeader.docNumber = "{{invoice.number}}";
    continuationHeader.bgImage = SHOWCASE_HEADER_IMAGE;
    continuationHeader.compact = true;
  }
  page.overflowGroups = [
    {
      maxItems: INVOICE_ROWS_ABOVE_CARDS,
      floatIds: [ruleFloat.id, bankingFloat.id, paymentFloat.id, thanksFloat.id],
      fieldIds: [],
      topOnNextPage: SHOWCASE_COMPACT_HEADER_HEIGHT + 24,
      nextPageFloats: [
        { id: uid(), x: 0, y: 0, width: PAGE.w, block: continuationHeader },
        { id: uid(), x: 0, y: footerY, width: PAGE.w, block: { ...footerBand, id: uid() } },
      ],
    },
    { maxItems: INVOICE_ROWS_ABOVE_FOOTER, floatIds: [footerFloat.id], fieldIds: [], drop: true },
  ];

  return {
    schemaVersion: 1,
    title: "Tax invoice",
    style: { fontFamily: "sans", pageSize: "A4", margin: 0, accent: ACCENT, ink: INK },
    recipients: [],
    pages: [page],
    header: [],
    footer: [],
  };
}

/** What a workspace has that changes its standard documents. */
export type StandardTemplateOptions = { automotive?: boolean };

// The invoice and agreement start with their text written in, edited where it
// prints — not read from the old form editor (inlineLegacyText).
const BUILDERS: Record<StandardDocKey, (options: StandardTemplateOptions) => DocumentModel> = {
  quote: (options) => standardQuoteTemplate(options),
  invoice: () => showcaseInvoiceTemplate(),
  agreement: (options) => inlineLegacyText("agreement", agreementTemplate(), {
    intro: { text: DOC_DEFS.agreement.defaultIntro ?? "", on: true },
    clauses: { text: (options.automotive ? DOC_DEFS.agreement.automotiveBody : DOC_DEFS.agreement.defaultBody) ?? "", on: true },
  }) as DocumentModel,
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

export function standardTemplateFor(key: StandardDocKey, options: StandardTemplateOptions = {}): DocumentModel {
  return BUILDERS[key](options);
}
