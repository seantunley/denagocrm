import { formatZAR } from "./format";

export type BotProductFact = {
  name: string;
  model?: string | null;
  description?: string | null;
  basePriceCents?: number | null;
  seats?: number | null;
  rangeKm?: number | null;
  topSpeedKmh?: number | null;
  brochureUrl?: string | null;
  colors?: { name: string }[];
};

/**
 * Render only fields maintained by Products. Missing values stay missing: the AI
 * is explicitly told not to infer stock, finance, road-legal status or any other
 * property that is not represented here or in Approved Knowledge.
 */
export function renderBotProductFacts(products: BotProductFact[], maxChars = 14_000): string {
  let out = "";
  for (const product of products) {
    const lines = [
      `[${product.name}]`,
      product.model && product.model !== product.name ? `Model: ${product.model}` : null,
      product.basePriceCents ? `Price: from ${formatZAR(product.basePriceCents)}` : null,
      product.seats != null ? `Seats: ${product.seats}` : null,
      product.rangeKm != null ? `Range: ${product.rangeKm} km` : null,
      product.topSpeedKmh != null ? `Top speed: ${product.topSpeedKmh} km/h` : null,
      product.colors?.length ? `Colours: ${product.colors.map((colour) => colour.name).join(", ")}` : null,
      product.brochureUrl ? `Brochure: ${product.brochureUrl}` : null,
      product.description?.trim() ? `Description: ${product.description.trim().slice(0, 700)}` : null,
    ].filter((line): line is string => Boolean(line));
    const block = lines.join("\n") + "\n\n";
    if (out.length + block.length > maxChars) break;
    out += block;
  }
  return out.trim();
}
