import "server-only";
import { prisma } from "@/lib/db";
import { embedStoredImage } from "@/lib/storedImage";
import type { QuoteForPrint } from "@/components/print/QuotePrintDoc";
import type { MergeContext } from "./merge";
import { primaryVehicleProductId, showcaseFromProduct } from "./vehicleShowcase";

/**
 * Add the quote's primary vehicle to its merge context as `vars.showcase`, for
 * the vehicleShowcase block.
 *
 * The first charged catalogue line wins; a quote with no product line falls back
 * to the lead's product of interest. The photo is EMBEDDED as a data URL: the
 * PDF renderer and the public signing page cannot read the private store.
 * No vehicle, no photo, or an unreadable photo → the block hides those parts.
 */
export async function withVehicleShowcase(ctx: MergeContext, quote: QuoteForPrint): Promise<MergeContext> {
  const productId = primaryVehicleProductId(quote.items);
  // A normal tenant-scoped read: a product id from another workspace resolves to
  // nothing and the lead's product (or no showcase at all) is used instead.
  const product = (productId ? await prisma.product.findUnique({ where: { id: productId } }) : null) ?? quote.lead?.product ?? null;
  if (!product) return ctx;
  const image = await embedStoredImage(product.showcaseImageRef, product.tenantId);
  return { ...ctx, vars: { ...ctx.vars, showcase: showcaseFromProduct(product, image) } };
}
