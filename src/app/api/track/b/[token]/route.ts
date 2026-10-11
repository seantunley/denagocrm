import { NextRequest, NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/campaigns";
import { logError } from "@/lib/errorLog";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignatureBannerTenant } from "@/lib/tokenTenant";
import { recordBannerClick } from "@/lib/signatureBannerStore";

const BANNER_TOKEN = /^[A-Za-z0-9_-]{24,64}$/;

/**
 * A click on an email signature banner (lib/signatureBanners.ts). Public — the
 * customer's browser opens it — so it does two things only: count the click, and
 * send the customer to the address STORED on the banner.
 *
 * The destination is never read from the request. The campaign tracker next
 * door (/api/track/c) carries it as `?u=` and needs a whole allow-list to stop
 * that being abused as a redirect; a banner has one destination, so there is
 * nothing to pass. `?e=` only names the email the banner was in, and is looked
 * up inside the banner's own workspace — a wrong value attributes nothing.
 *
 * An unknown token, a banner whose address is no longer a plain https link, or
 * any failure all land on the app's home page.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let destination: string | null = null;
  if (BANNER_TOKEN.test(token)) {
    destination = await withTokenTenantScope(
      () => resolveSignatureBannerTenant(token),
      () => recordBannerClick(token, req.nextUrl.searchParams.get("e")),
      () => null,
    ).catch(async (error) => {
      // The customer still lands somewhere sensible; the failure is ours to see.
      // Logged by reason only — the link carries no customer details to leak.
      await logError("signature-banner", error, "a banner click could not be recorded").catch(() => {});
      return null;
    });
  }
  return NextResponse.redirect(destination ?? appBaseUrl(), { status: 302, headers: { "Cache-Control": "no-store" } });
}
