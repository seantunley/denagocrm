import { prisma } from "./db";
import { createLeadRecord } from "./leadCreate";

export type IntakeLead = {
  name: string;
  email?: string | null;
  phone?: string | null;
  message?: string | null;
  model?: string | null;
  color?: string | null;
  source: string;
  externalId?: string | null;
  raw?: unknown;
};

/**
 * Creates a lead in the first pipeline stage, matching the product by model name.
 *
 * Product matching, the derived title and the intake `raw` payload are what this
 * path genuinely adds; the row, the audit entry, the push and the automations
 * are the shared job of createLeadRecord.
 */
export async function createIntakeLead(input: IntakeLead) {
  let productId: string | null = null;
  let valueCents = 0;
  if (input.model) {
    const products = await prisma.product.findMany({ where: { active: true } });
    const needle = input.model.toLowerCase();
    const match =
      products.find((p) => p.name.toLowerCase() === needle) ??
      products.find(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          needle.includes(p.name.toLowerCase())
      );
    if (match) {
      productId = match.id;
      valueCents = match.basePriceCents;
    }
  }

  const titleParts = [input.model, input.color].filter(Boolean);
  const title = titleParts.length > 0 ? titleParts.join(" – ") : input.name;

  return createLeadRecord({
    title,
    name: input.name,
    email: input.email ?? null,
    phone: input.phone ?? null,
    source: input.source,
    productId,
    color: input.color ?? null,
    valueCents,
    notes: input.message ?? null,
    externalId: input.externalId ?? null,
    raw: input.raw,
    audit: {
      action: "lead.received",
      summary: `Lead “${title}” received via ${input.source}`,
      userName: "System",
    },
  });
}
