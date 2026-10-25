import "server-only";
import { prisma } from "./db";
import { matchCatalogueProduct } from "./assistantActions";
import { ciExactIdFilter } from "./ciExact";

/**
 * Finding catalogue products for the assistant — across the WHOLE catalogue.
 *
 * Both readers used to take the first N products by name and look inside that:
 * the quote builder the first 200, the knowledge lookup the first 60. A product
 * past the cut could not be quoted even by its exact id, and was never shown
 * (review of #876). Here the database does the looking, so the size of the
 * catalogue does not decide what can be found.
 *
 * Everything goes through the workspace's own client: another workspace's
 * product reads as missing. Only products ON SALE (active, not in the bin).
 */

const ON_SALE = { active: true, deletedAt: null };
const QUOTE_FIELDS = { id: true, name: true, basePriceCents: true, colors: { select: { name: true } } } as const;
export type QuoteProduct = { id: string; name: string; basePriceCents: number; colors: { name: string }[] };

/**
 * The one product a quote line means, or null.
 *
 * The RULE is matchCatalogueProduct's and nobody else's: the id; else the same
 * name ignoring case and spacing; else the only product whose name contains it.
 * This only fetches the few rows that rule could choose between — by id, by the
 * exact name, by the name contained — two of each at most, because all the rule
 * needs to know about a name is whether it means one product or more than one.
 */
export async function resolveCatalogueProduct(line: { productId?: string; product?: string }): Promise<QuoteProduct | null> {
  const wanted = (line.product ?? "").replace(/\s+/g, " ").trim();
  const [byId, exact, containing] = await Promise.all([
    line.productId ? prisma.product.findMany({ where: { id: line.productId, ...ON_SALE }, take: 1, select: QUOTE_FIELDS }) : [],
    // The exact name, case folded in SQL on both sides (lib/ciExact.ts) — not
    // `equals` + `mode: "insensitive"`, which is an unescaped ILIKE where `_` and
    // `%` are wildcards. The helper returns ids only; the workspace's own client
    // then decides which of them this workspace may see and has on sale.
    // ponytail: the helper caps at 200 ids across ALL workspaces, so a name shared
    // by more than 200 workspaces' products could miss this one — then the
    // "contains" query below still finds it if it is the only one here.
    wanted ? prisma.product.findMany({ where: { ...ON_SALE, ...(await ciExactIdFilter("productName", wanted)) }, take: 2, select: QUOTE_FIELDS }) : [],
    wanted ? prisma.product.findMany({ where: { ...ON_SALE, name: { contains: wanted, mode: "insensitive" } }, take: 2, select: QUOTE_FIELDS }) : [],
  ]);
  const candidates = new Map<string, QuoteProduct>();
  for (const product of [...byId, ...exact, ...containing]) candidates.set(product.id, product);
  return matchCatalogueProduct([...candidates.values()], line);
}

/** How many products the knowledge lookup shows at once. A whole small catalogue; otherwise the ones that match. */
export const KNOWLEDGE_WHOLE_CATALOGUE = 15;
export const KNOWLEDGE_MATCHES = 40;
// The colours too (Sean, 2026-10-24: asked for a Rover XL in grey, DAX said "the catalogue doesn't list available
// colours" — it didn't, to DAX: they were never selected — and the quote stalled on it).
const KNOWLEDGE_FIELDS = {
  id: true, name: true, category: true, basePriceCents: true, description: true, showcaseTagline: true, showcaseSpecs: true,
  colors: { select: { name: true }, orderBy: { name: "asc" } },
} as const;

/**
 * Products for the knowledge lookup: all of a small catalogue, or — from a
 * large one — those whose name, category or description contains a word of the
 * topic, wherever they sit in the alphabet. With no usable word, the first few
 * by name, so "what do you sell?" still shows something.
 */
export async function knowledgeProducts(words: readonly string[]) {
  const total = await prisma.product.count({ where: ON_SALE });
  if (total <= KNOWLEDGE_WHOLE_CATALOGUE || words.length === 0) {
    return prisma.product.findMany({ where: ON_SALE, orderBy: { name: "asc" }, take: total <= KNOWLEDGE_WHOLE_CATALOGUE ? KNOWLEDGE_WHOLE_CATALOGUE : KNOWLEDGE_MATCHES, select: KNOWLEDGE_FIELDS });
  }
  return prisma.product.findMany({
    where: {
      ...ON_SALE,
      OR: words.flatMap((word) => [
        { name: { contains: word, mode: "insensitive" as const } },
        { category: { contains: word, mode: "insensitive" as const } },
        { description: { contains: word, mode: "insensitive" as const } },
      ]),
    },
    orderBy: { name: "asc" },
    take: KNOWLEDGE_MATCHES,
    select: KNOWLEDGE_FIELDS,
  });
}
