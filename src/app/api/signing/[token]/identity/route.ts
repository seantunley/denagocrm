import { z } from "zod";
import { isValidSignToken } from "@/lib/signing/tokens";
import { issueOtp, verifyOtp, identityCookieHeader } from "@/lib/signing/identity";
import { rateLimitSigning } from "@/lib/signing/throttle";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const method = z.enum(["email", "sms"]);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send"), method }),
  z.object({ action: z.literal("verify"), method, code: z.string().regex(/^\d{6}$/) }),
]);

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  const throttled = await rateLimitSigning(`identity:${token}`);
  if (throttled) return throttled;
  return withTokenTenantScope(
    () => resolveSignRecipientTenant(token),
    async () => {
      const parsed = schema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return new Response("Invalid identity request", { status: 400 });
      try {
        if (parsed.data.action === "send") {
          const result = await issueOtp(token, parsed.data.method);
          return Response.json({ ok: true, masked: result.masked, expiresAt: result.expiresAt.toISOString() });
        }
        const result = await verifyOtp(token, parsed.data.method, parsed.data.code);
        return new Response(JSON.stringify({ ok: true, complete: result.complete, verifiedMethods: result.verifiedMethods }), {
          headers: { "content-type": "application/json", "set-cookie": identityCookieHeader(result.cookie, result.maxAge) },
        });
      } catch (error) {
        return new Response(error instanceof Error ? error.message : "Identity verification failed", { status: 409 });
      }
    },
    () => new Response("Not found", { status: 404 }),
  );
}
