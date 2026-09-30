import "server-only";
import { prisma } from "@/lib/db";
import { embedStoredImage } from "@/lib/storedImage";
import { feeRows, includedLines } from "@/lib/pricing";
import { resolveOverflowGroups } from "@/lib/doceditor/overflow";
import type { QuoteForPrint } from "@/components/print/QuotePrintDoc";
import type { DocumentModel } from "@/lib/doceditor/model";
import { freezeVehicleShowcase, hasVehicleShowcase } from "@/lib/signing/freezeDocument";
import type { MergeContext } from "./merge";
import { primaryVehicleProductId, showcaseFromProduct, type VehicleShowcaseData } from "./vehicleShowcase";

type QuoteVehicleSource = Pick<QuoteForPrint, "items" | "lead">;

/**
 * The quote's primary vehicle with its photo EMBEDDED as a data URL (the PDF
 * renderer and the public signing page cannot read the private store).
 *
 * The first charged catalogue line wins; a quote with no product line falls back
 * to the lead's product of interest. A normal tenant-scoped read: a product id
 * from another workspace resolves to nothing and the fallback is used.
 */
async function quoteVehicle(quote: QuoteVehicleSource): Promise<VehicleShowcaseData | null> {
  const productId = primaryVehicleProductId(quote.items);
  const product = (productId ? await prisma.product.findUnique({ where: { id: productId } }) : null) ?? quote.lead?.product ?? null;
  if (!product) return null;
  return showcaseFromProduct(product, await embedStoredImage(product.showcaseImageRef, product.tenantId));
}

/**
 * Add the quote's primary vehicle to its merge context as `vars.showcase`, for
 * the vehicleShowcase block of a LIVE render (print, preview, PDF export).
 * A signing snapshot never uses this — its blocks carry the frozen vehicle.
 */
export async function withVehicleShowcase(ctx: MergeContext, quote: QuoteForPrint): Promise<MergeContext> {
  const vehicle = await quoteVehicle(quote);
  return vehicle ? { ...ctx, vars: { ...ctx.vars, showcase: vehicle } } : ctx;
}

/**
 * Send time: freeze the vehicle the signer is being shown into the snapshot's
 * vehicleShowcase blocks (see freezeVehicleShowcase). Resolved exactly as a live
 * render would show it — including the name-only fallback — so the document
 * does not change at the moment it is sent. A document with no showcase block is
 * returned untouched, without a query.
 */
export async function freezeQuoteShowcase(doc: DocumentModel, quoteId: string | null | undefined): Promise<DocumentModel> {
  const showcase = hasVehicleShowcase(doc);
  const overflow = doc.pages.some((page) => page.overflowGroups);
  if (!showcase && !overflow) return doc;
  const quote = quoteId
    ? await prisma.quote.findUnique({ where: { id: quoteId }, include: { items: true, fees: true, lead: { include: { product: true } } } })
    : null;
  // The page layout is resolved HERE, once, for the number of rows the quote
  // has now: the signature fields are created from this snapshot, so they must
  // already be on the page (and at the spot) where they will be signed. Counted
  // exactly as buildQuoteContext builds the table: charged lines + fee rows.
  let frozen = resolveOverflowGroups(doc, quote ? includedLines(quote.items).length + feeRows(quote.fees).length : 0);
  if (!showcase) return frozen;
  let vehicle = quote ? await quoteVehicle(quote) : null;
  if (!vehicle && quote) {
    // The live renderer's fallback is the {{vehicle}} token: the lead's product
    // name, else the first charged line — and with no product, only the latter.
    const name = includedLines(quote.items)[0]?.description?.trim();
    if (name) vehicle = { name, tagline: "", description: "", image: null, specs: [] };
  }
  frozen = freezeVehicleShowcase(frozen, vehicle);
  return frozen;
}
