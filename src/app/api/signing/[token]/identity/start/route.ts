import { isValidSignToken } from "@/lib/signing/tokens";
import { rateLimitSigning } from "@/lib/signing/throttle";
import { startEmailOtp } from "@/lib/signing/identity";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  const throttled = await rateLimitSigning(token);
  if (throttled) return throttled;

  return withTokenTenantScope(
    () => resolveSignRecipientTenant(token),
    async () => {
      const result = await startEmailOtp(token);
      return Response.json(result, { status: result.ok ? 200 : 409 });
    },
    () => new Response("Not found", { status: 404 }),
  );
}
