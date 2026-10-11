import { after, NextRequest, NextResponse } from "next/server";
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
 * IN THAT ORDER, AND WITHOUT WAITING. The destination is resolved (one read),
 * the redirect is returned, and only then — after the response — is the click
 * counted, the timeline stamped and the sender notified. A failed or slow write
 * is ours to see in the error log; it never delays or loses the page somebody
 * clicked for. Only an unknown token, or an address that is no longer a plain
 * https link, lands on home.
 *
 * What a replayed or scanned link may write is bounded in the recording itself
 * (lib/signatureBanners.ts): not by IP — mail gateways share addresses — but by
 * what one email and one banner can count.
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
            // Runs after the response has gone (below), by which time this request's
            // workspace scope is over — so the recording opens its own, on the
            // workspace the link was just resolved to. No second lookup of the token.
            record: (link, emailRef) =>
              withTokenTenantScope(
                async () => ({ tenantId: link.tenantId }),
                () => recordBannerClick(link, emailRef),
                () => undefined,
              ),
            // Logged by reason only — the link carries no customer details to leak.
            onRecordError: (error) => logError("signature-banner", error, "a banner click could not be recorded"),
            // The platform's run-after-the-response hook: the customer is not kept waiting for our bookkeeping.
            defer: (work) => after(work),
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
