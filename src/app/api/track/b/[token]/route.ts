import { NextRequest, NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/campaigns";
import { logError } from "@/lib/errorLog";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignatureBannerTenant } from "@/lib/tokenTenant";
import { recordBannerClick, resolveBannerLink } from "@/lib/signatureBannerStore";
import { BANNER_REF, bannerClickDestination } from "@/lib/signatureBanners";

/**
 * A click on an email signature banner (lib/signatureBanners.ts). Public — the
 * customer's browser opens it — so it does two things only: send the customer to
 * the address STORED for this link, and count the click.
 *
 * The destination is never read from the request. The campaign tracker next
 * door (/api/track/c) carries it as `?u=` and needs a whole allow-list to stop
 * that being abused as a redirect; a banner link has one destination, frozen
 * when the email was sent, so there is nothing to pass. `?e=` only names the
 * email the banner was in, and is looked up inside the banner's own workspace —
 * a wrong value attributes nothing.
 *
 * IN THAT ORDER. The destination is resolved first and the customer is sent
 * there whatever happens to the counting: a failed write is our problem to see
 * in the error log, not a reason to drop somebody who clicked a promotion onto
 * the CRM's home page. Only an unknown token, or an address that is no longer a
 * plain https link, lands on home.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let destination: string | null = null;
  if (BANNER_REF.test(token)) {
    destination = await withTokenTenantScope(
      () => resolveSignatureBannerTenant(token),
      () =>
        bannerClickDestination(
          {
            resolve: resolveBannerLink,
            record: recordBannerClick,
            // Logged by reason only — the link carries no customer details to leak.
            onRecordError: (error) => logError("signature-banner", error, "a banner click could not be recorded"),
          },
          token,
          req.nextUrl.searchParams.get("e"),
        ),
      () => null,
    ).catch(async (error) => {
      await logError("signature-banner", error, "a banner link could not be resolved").catch(() => {});
      return null;
    });
  }
  return NextResponse.redirect(destination ?? appBaseUrl(), { status: 302, headers: { "Cache-Control": "no-store" } });
}
