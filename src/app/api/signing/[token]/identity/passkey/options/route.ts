import { isValidSignToken } from "@/lib/signing/tokens";
import { passkeySigningOptions } from "@/lib/signing/passkeyIdentity";
import { rateLimitSigning } from "@/lib/signing/throttle";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";

export const runtime = "nodejs";
export async function POST(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  const throttled = await rateLimitSigning(`passkey-options:${token}`); if (throttled) return throttled;
  return withTokenTenantScope(() => resolveSignRecipientTenant(token), async () => {
    try { return Response.json(await passkeySigningOptions(token)); }
    catch (error) { return new Response(error instanceof Error ? error.message : "Passkey unavailable", { status: 409 }); }
  }, () => new Response("Not found", { status: 404 }));
}
