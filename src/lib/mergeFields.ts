// Merge-field registry for the Document Studio.
// Server-owned and allow-listed: documents may only reference these keys —
// user text can never reach arbitrary object paths (spec §8).

export type MergeFieldDef = { key: string; label: string; group: string };

export const MERGE_FIELDS: MergeFieldDef[] = [
  // Company (from the editable Company Profile — keep in sync with companyTokens())
  { key: "company.name", label: "Company name", group: "Company" },
  { key: "company.tagline", label: "Company tagline", group: "Company" },
  { key: "company.phone", label: "Company phone", group: "Company" },
  { key: "company.email", label: "Company email", group: "Company" },
  { key: "company.address", label: "Company address", group: "Company" },
  { key: "company.website", label: "Company website", group: "Company" },
  { key: "company.facebook", label: "Company Facebook", group: "Company" },
  { key: "company.instagram", label: "Company Instagram", group: "Company" },
  // Customer
  { key: "customer.name", label: "Customer full name", group: "Customer" },
  { key: "customer.firstName", label: "Customer first name", group: "Customer" },
  { key: "customer.email", label: "Customer email", group: "Customer" },
  { key: "customer.phone", label: "Customer phone", group: "Customer" },
  { key: "customer.address", label: "Customer address", group: "Customer" },
  // Lead / deal
  { key: "lead.title", label: "Deal title", group: "Deal" },
  { key: "lead.product", label: "Product of interest", group: "Deal" },
  { key: "lead.value", label: "Deal value", group: "Deal" },
  // Quote
  { key: "quote.number", label: "Quote number", group: "Quote" },
  { key: "quote.total", label: "Quote total", group: "Quote" },
  { key: "quote.date", label: "Quote date", group: "Quote" },
  // Document / misc
  { key: "user.name", label: "Prepared by (you)", group: "Document" },
  { key: "date.today", label: "Today's date", group: "Document" },
];

export type MergeContext = Record<string, string>;

const TOKEN = /\{\{\s*([a-zA-Z]+\.[a-zA-Z]+)\s*\}\}/g;
const ALLOWED = new Set(MERGE_FIELDS.map((f) => f.key));

/** Replace {{tokens}} in a text with context values. Unknown keys stay visible. */
export function resolveTokens(text: string, ctx: MergeContext): string {
  return text.replace(TOKEN, (whole, key: string) =>
    ALLOWED.has(key) ? (ctx[key] ?? "—") : whole
  );
}

/** Walk BlockNote JSON and resolve every text node's tokens (pure, no eval). */
export function resolveBlocks(blocks: unknown, ctx: MergeContext): unknown {
  if (Array.isArray(blocks)) return blocks.map((b) => resolveBlocks(b, ctx));
  if (blocks && typeof blocks === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(blocks as Record<string, unknown>)) {
      out[k] = k === "text" && typeof v === "string" ? resolveTokens(v, ctx) : resolveBlocks(v, ctx);
    }
    return out;
  }
  return blocks;
}

/** Which allow-listed tokens appear in a document (for pre-generation warnings). */
export function usedTokens(blocks: unknown): string[] {
  const found = new Set<string>();
  (function walk(n: unknown) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        if (k === "text" && typeof v === "string") {
          for (const m of v.matchAll(TOKEN)) if (ALLOWED.has(m[1])) found.add(m[1]);
        } else walk(v);
      }
    }
  })(blocks);
  return [...found];
}
