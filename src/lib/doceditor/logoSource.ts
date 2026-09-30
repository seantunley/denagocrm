import { storedFileSrc } from "@/lib/storedFileSrc";

/**
 * What a workspace logo URL (Company Profile `logoUrl`, or a frozen brand's)
 * points at, as far as a DOCUMENT is concerned. Pure, so the rule is testable.
 *
 *  - data      an inline `data:image/…` — used as-is;
 *  - stored    one of our stored files — read with the owner check and embedded;
 *  - brand     the tenant brand route `/api/brand/logo/<tenant>[?a=<asset>]` —
 *              that asset's bytes, embedded;
 *  - public    a `/branding/<file>` asset of this app — read from `public/`;
 *  - external  ANYTHING else, an outside https link included. Documents never
 *              use these: not hot-linked (the signing page would make a
 *              third-party request, and a "frozen" signed document could change
 *              or lose its logo whenever that host did) and not fetched either
 *              (an admin-typed URL fetched server-side is an SSRF lever). The
 *              tenant's uploaded brand logo, or the built-in one, is used instead.
 */
export type LogoSource =
  | { kind: "none" | "data" | "stored" | "external" }
  | { kind: "brand"; tenantId: string; asset: string | null }
  | { kind: "public"; file: string };

const BRAND_LOGO_PATH = /^\/api\/brand\/logo\/([A-Za-z0-9_-]+)$/;
const PUBLIC_BRANDING = /^\/branding\/([A-Za-z0-9._-]+\.(?:png|jpe?g|webp))$/i;

export function classifyLogoUrl(logoUrl: string | null | undefined): LogoSource {
  const url = logoUrl?.trim();
  if (!url) return { kind: "none" };
  if (/^data:image\/(png|jpe?g|webp|gif|svg\+xml);/i.test(url)) return { kind: "data" };
  if (storedFileSrc(url) !== url) return { kind: "stored" };
  let parsed: URL;
  try {
    parsed = new URL(url, "https://relative.invalid");
  } catch {
    return { kind: "external" };
  }
  // A path of OUR app, on whatever host it was written with (the seeded Denago
  // profile names crm.denagocpt.co.za). Both are public assets of this
  // deployment, read locally — the host in the URL is never contacted.
  const brand = BRAND_LOGO_PATH.exec(parsed.pathname);
  if (brand) return { kind: "brand", tenantId: brand[1], asset: parsed.searchParams.get("a") };
  const file = PUBLIC_BRANDING.exec(parsed.pathname);
  if (file) return { kind: "public", file: file[1] };
  return { kind: "external" };
}
