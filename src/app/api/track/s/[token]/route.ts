import { after, NextRequest, NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/campaigns";
import { logError } from "@/lib/errorLog";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignatureLinkTenant } from "@/lib/tokenTenant";
import { recordSignatureLinkClick, resolveSignatureLink } from "@/lib/signatureLinkStore";
import { SIGNATURE_LINK_REF } from "@/lib/signatureLinks";

/**
 * A click on a link in someone's email signature (lib/signatureLinks.ts, item 11). Public — the customer's browser
 * opens it — so, like the banner route next door (/api/track/b): send them to the address STORED for this token (never
 * one read from the request, so it can't be used as an open redirect), answer at once, and count the click only after
 * the response has gone. An unknown token lands on home.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let destination: string | null = null;
  if (SIGNATURE_LINK_REF.test(token)) {
    destination = await withTokenTenantScope(
      () => resolveSignatureLinkTenant(token),
      async () => {
        const link = await resolveSignatureLink(token);
        if (!link) return null;
        // After the response, in a scope of its own on the link's workspace: the customer never waits for the count.
        after(() =>
          withTokenTenantScope(
            async () => ({ tenantId: link.tenantId }),
            () => recordSignatureLinkClick(link),
            () => undefined,
          ).catch((error) => logError("signature-link", error, "a signature link click could not be recorded")),
        );
        return link.url;
      },
      () => null,
    ).catch(async (error) => {
      await logError("signature-link", error, "a signature link could not be resolved").catch(() => {});
      return null;
    });
  }
  return NextResponse.redirect(destination ?? appBaseUrl(), { status: 302, headers: { "Cache-Control": "no-store" } });
}
