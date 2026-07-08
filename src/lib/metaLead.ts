/** Parsing helpers for Meta (Facebook / Instagram) Lead Ads field data. */

export type FieldData = { name: string; values: string[] };

const KNOWN = [
  "full_name", "full name", "name", "email", "e-mail", "phone", "mobile",
  "model", "product", "bike", "cart", "colour", "color",
  "message", "comment", "question", "enquiry", "note",
];

function pick(fields: FieldData[], ...keys: string[]): string | null {
  for (const key of keys) {
    const f = fields.find((x) => x.name.toLowerCase().includes(key));
    if (f && f.values?.[0]) return f.values[0];
  }
  return null;
}

/** Meta sends "ig"/"fb" (or "instagram"/"facebook") — map to our source. */
export function metaSource(platform?: string): "facebook" | "instagram" {
  const p = (platform ?? "").toLowerCase();
  return p === "ig" || p.includes("insta") ? "instagram" : "facebook";
}

/**
 * Pulls identity fields plus ANY free-text answer — including custom questions
 * that Meta names oddly (e.g. "0") — so a message like "Personal for golf &
 * estate use" isn't lost.
 */
export function parseLeadFields(fields: FieldData[]) {
  const name = pick(fields, "full_name", "full name", "name");
  const email = pick(fields, "email", "e-mail");
  const phone = pick(fields, "phone", "mobile");
  const model = pick(fields, "model", "product", "bike", "cart");
  const color = pick(fields, "colour", "color");
  const primaryMsg = pick(fields, "message", "comment", "question", "enquiry", "note");

  const captured = new Set([name, email, phone, model, color, primaryMsg].filter(Boolean) as string[]);
  const extras = fields
    .filter((f) => {
      const v = f.values?.[0]?.trim();
      if (!v || captured.has(v)) return false;
      return !KNOWN.some((k) => f.name.toLowerCase().includes(k));
    })
    .map((f) => f.values.join(", "));

  const message = [primaryMsg, ...extras].filter(Boolean).join("\n\n") || null;
  return { name, email, phone, model, color, message };
}
