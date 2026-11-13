import "server-only";
import { brandForTenant, brandLogoAsset } from "./tenantBrand";
import { readManagedBlob } from "./storage";
import { pdfImageHostAllowed } from "./pdfImageHosts";
import { verifiedTenantHosts } from "./tenantOrigin";
import { logError } from "./errorLog";

/**
 * The business's logo as PNG bytes, for the header of an assistant report.
 *
 * react-pdf draws PNG and JPEG only, and a workspace's logo may be an SVG or a
 * WebP, so whatever is found is converted to a small PNG first.
 *
 * WHERE IT LOOKS, in the order the Company Profile itself resolves a logo
 * (lib/companyProfile.ts):
 *
 *   1. The workspace's own logo, when it is the one uploaded for its brand —
 *      read straight from storage by its own key. No HTTP request, so there is
 *      no URL to get wrong.
 *   2. A logo URL the workspace typed into its Company Profile — fetched ONLY
 *      from a host this deployment already vouches for (pdfImageHostAllowed: our
 *      own origin, the upload store, the workspace's verified domains). A URL
 *      anywhere else is not fetched: a server that will GET whatever address a
 *      setting holds is how an internal service gets reached from outside.
 *
 * NEVER THROWS. A report with the business's name and no picture is a report; a
 * report that fails because a logo was slow is not. Every miss is logged, so a
 * missing logo is findable.
 */

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 4000;
/** Drawn 36pt tall; three times that keeps it sharp in print. */
const LOGO_HEIGHT_PX = 108;
const LOGO_MAX_WIDTH_PX = 390;

async function brandLogoBytes(tenantId: string): Promise<Buffer | null> {
  const brand = await brandForTenant(tenantId);
  const asset = brand.tenantId ? brandLogoAsset(brand.logoRef) : null;
  if (!asset) return null;
  return readManagedBlob(`branding/${tenantId}/${asset}`);
}

async function typedLogoBytes(logoUrl: string): Promise<Buffer | null> {
  let url: URL;
  try {
    url = new URL(logoUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const tenantHosts = await verifiedTenantHosts();
  if (!pdfImageHostAllowed(url.hostname, { appUrl: process.env.NEXT_PUBLIC_APP_URL, configured: process.env.PDF_IMAGE_HOSTS, tenantHosts })) return null;
  // No redirects: an allowed host that redirects elsewhere would undo the check above.
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) return null;
  if (Number(response.headers.get("content-length") ?? 0) > MAX_LOGO_BYTES) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes.length > MAX_LOGO_BYTES ? null : bytes;
}

async function toPng(bytes: Buffer): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(bytes, { limitInputPixels: 40_000_000 })
    .resize({ height: LOGO_HEIGHT_PX, width: LOGO_MAX_WIDTH_PX, fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer();
}

export async function reportLogoPng(tenantId: string, companyLogoUrl: string | null | undefined): Promise<Buffer | null> {
  try {
    const bytes = (await brandLogoBytes(tenantId)) ?? (companyLogoUrl ? await typedLogoBytes(companyLogoUrl) : null);
    if (!bytes || !bytes.length || bytes.length > MAX_LOGO_BYTES) return null;
    return await toPng(bytes);
  } catch (error) {
    await logError("assistant-report", "logo could not be drawn", error instanceof Error ? error.name : "unknown").catch(() => {});
    return null;
  }
}
