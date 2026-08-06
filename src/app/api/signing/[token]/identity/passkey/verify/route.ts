import { z } from "zod";
import { isValidSignToken } from "@/lib/signing/tokens";
import { verifyPasskeySigning } from "@/lib/signing/passkeyIdentity";
import { identityCookieHeader } from "@/lib/signing/identity";
import { rateLimitSigning } from "@/lib/signing/throttle";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";

export const runtime = "nodejs";
const schema = z.object({ response: z.record(z.string(), z.unknown()) });
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  const throttled = await rateLimitSigning(`passkey-verify:${token}`); if (throttled) return throttled;
  return withTokenTenantScope(() => resolveSignRecipientTenant(token), async () => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response("Invalid passkey response", { status: 400 });
    try {
      const result = await verifyPasskeySigning(token, parsed.data.response as never);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": identityCookieHeader(result.cookie, result.maxAge) } });
    } catch (error) { return new Response(error instanceof Error ? error.message : "Passkey verification failed", { status: 409 }); }
  }, () => new Response("Not found", { status: 404 }));
}
