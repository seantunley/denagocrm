// Document template config — pure types + defaults (client-safe).
// Templates are DocTemplateRecord rows: many per type, one default per type.

export type DocKey =
  | "quote"
  | "invoice"
  | "agreement"
  | "indemnity"
  | "delivery"
  | "jobcard"
  | "service-report"
  | "warranty-claim";

export type SignaturePosition = "left-right" | "right-left" | "strip";
export type HeaderStyle = "dark" | "light" | "accent";
export type TypographyStyle = "modern" | "classic";
export type DocumentDensity = "comfortable" | "compact";

export type TemplateAppearance = {
  accentColor: string;
  headerStyle: HeaderStyle;
  typography: TypographyStyle;
  density: DocumentDensity;
};

export type DocTemplate = {
  logoUrl: string | null; // null = built-in Denago logo
  documentTitle: string | null; // null = the document type's standard title
  sectionHeading: string | null; // optional heading above the editable body copy
  intro: string | null; // line under the header
  bodyText: string | null; // the document's own text (indemnity terms, agreement clauses…)
  terms: string | null; // quote/invoice terms override
  footerLines: string[];
  sections: Record<string, boolean>;
  signature: { position: SignaturePosition; dealerCounterSign: boolean };
  appearance: TemplateAppearance;
};

type DocDef = {
  label: string;
  group: "Sales" | "Fulfilment" | "Workshop";
  description: string;
  sections: { id: string; label: string }[];
  defaultBody?: string;
  defaultIntro?: string;
};

export const DOC_DEFS: Record<DocKey, DocDef> = {
  quote: {
    label: "Quote",
    group: "Sales",
    description: "The quotation the customer receives, signs online and gets as a PDF.",
    sections: [
      { id: "body", label: "Additional content" },
      { id: "terms", label: "Terms & conditions" },
      { id: "signatures", label: "Signature block" },
      { id: "footer", label: "Branded footer" },
    ],
  },
  invoice: {
    label: "Invoice",
    group: "Sales",
    description: "Branded invoice generated from an accepted quote.",
    sections: [
      { id: "banking", label: "Banking details" },
      { id: "terms", label: "Payment terms" },
      { id: "footer", label: "Branded footer" },
    ],
    defaultBody:
      "Banking details:\nBank: (add your bank)\nAccount: (add account number)\nBranch: (add branch code)\nReference: your invoice number",
    defaultIntro: "Thank you for your business.",
  },
  agreement: {
    label: "Sales agreement",
    group: "Sales",
    description: "Purchase contract for a cart sale — clauses below are fully editable.",
    sections: [
      { id: "items", label: "Vehicle & items table" },
      { id: "clauses", label: "Agreement clauses" },
      { id: "signatures", label: "Signature block" },
      { id: "footer", label: "Branded footer" },
    ],
    defaultBody:
      "1. The purchaser agrees to buy the vehicle(s) described above at the stated price.\n2. Ownership passes on receipt of full payment.\n3. The vehicle carries the manufacturer's warranty as per the warranty schedule.\n4. Delivery takes place at the agreed address or at Denago Cape Town, Maitland.\n5. This agreement is governed by the laws of the Republic of South Africa.",
  },
  indemnity: {
    label: "Test-drive indemnity",
    group: "Sales",
    description: "Waiver the customer signs before a test drive.",
    sections: [
      { id: "waiver", label: "Waiver text" },
      { id: "signatures", label: "Signature block" },
      { id: "footer", label: "Branded footer" },
    ],
    defaultBody:
      "I, the undersigned, acknowledge that I am test-driving the vehicle entirely at my own risk. I confirm that I hold a valid driver's licence, will follow all instructions given by Denago Cape Town staff, and accept liability for any damage caused by my negligence during the test drive. Denago Cape Town, its owners and employees are indemnified against any claim for injury, loss or damage arising from the test drive, to the fullest extent permitted by law.",
    defaultIntro: "Please read and sign before the test drive.",
  },
  delivery: {
    label: "Delivery note",
    group: "Fulfilment",
    description: "Handover document for a delivery — items, checklist and signatures.",
    sections: [
      { id: "items", label: "Items being delivered" },
      { id: "prices", label: "Show prices on items" },
      { id: "checklist", label: "Handover checklist" },
      { id: "signatures", label: "Signature block" },
      { id: "footer", label: "Branded footer" },
    ],
    defaultIntro: "Please inspect your cart on handover and note anything unusual below.",
  },
  jobcard: {
    label: "Job card",
    group: "Workshop",
    description: "The workshop job card print-out with technician and customer sign-off.",
    sections: [
      { id: "signatures", label: "Signature block" },
      { id: "footer", label: "Branded footer" },
    ],
  },
  "service-report": {
    label: "Service report",
    group: "Workshop",
    description: "Given to the customer after a service: work done, parts, next service due.",
    sections: [
      { id: "items", label: "Work & parts table" },
      { id: "prices", label: "Show prices" },
      { id: "nextdue", label: "Next service due" },
      { id: "signatures", label: "Signature block" },
      { id: "footer", label: "Branded footer" },
    ],
    defaultIntro: "Summary of the work carried out on your vehicle.",
  },
  "warranty-claim": {
    label: "Warranty claim",
    group: "Workshop",
    description: "Claim form for a warranty fault — for the customer and the manufacturer.",
    sections: [
      { id: "vehicle", label: "Vehicle & warranty details" },
      { id: "signatures", label: "Signature block" },
      { id: "footer", label: "Branded footer" },
    ],
    defaultIntro: "Warranty claim as recorded by Denago Cape Town.",
  },
};

export const DOC_GROUPS: { name: DocDef["group"]; keys: DocKey[] }[] = [
  { name: "Sales", keys: ["quote", "invoice", "agreement", "indemnity"] },
  { name: "Fulfilment", keys: ["delivery"] },
  { name: "Workshop", keys: ["jobcard", "service-report", "warranty-claim"] },
];

export const SIGNATURE_POSITIONS: { id: SignaturePosition; label: string }[] = [
  { id: "left-right", label: "Customer left · Denago right" },
  { id: "right-left", label: "Denago left · Customer right" },
  { id: "strip", label: "Full-width strip" },
];

export function defaultTemplate(key: DocKey): DocTemplate {
  const def = DOC_DEFS[key];
  return {
    logoUrl: null,
    documentTitle: null,
    sectionHeading: null,
    intro: def.defaultIntro ?? null,
    bodyText: def.defaultBody ?? null,
    terms: null,
    footerLines: [
      "Unit 55, M5 Freeway Business Park, Maitland, Cape Town · 073 789 3438",
      "sales@denagocpt.co.za · denagocpt.co.za",
    ],
    sections: Object.fromEntries(def.sections.map((s) => [s.id, s.id !== "prices"])),
    signature: { position: "left-right", dealerCounterSign: true },
    appearance: {
      accentColor: "#ea580c",
      headerStyle: "dark",
      typography: "modern",
      density: "comfortable",
    },
  };
}

/** Merge stored JSON over the defaults so new fields never break old data. */
export function mergeTemplate(key: DocKey, raw: unknown): DocTemplate {
  const base = defaultTemplate(key);
  if (!raw) return base;
  try {
    const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<DocTemplate>;
    return {
      ...base,
      ...parsed,
      sections: { ...base.sections, ...(parsed.sections ?? {}) },
      signature: { ...base.signature, ...(parsed.signature ?? {}) },
      appearance: { ...base.appearance, ...(parsed.appearance ?? {}) },
    };
  } catch {
    return base;
  }
}

export const isDocKey = (k: string): k is DocKey => k in DOC_DEFS;
