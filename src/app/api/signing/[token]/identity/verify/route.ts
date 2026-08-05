import { z } from "zod";
import { isValidSignToken } from "@/lib/signing/tokens";
import { rateLimitSigning } from "@/lib/signing/throttle";
import { verifyEmailOtp } from "@/lib/signing/identity";
import { reqMeta } from "@/lib/signing/events";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  const throttled = await rateLimitSigning(token);
  if (throttled) return throttled;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response("Enter the six-digit code", { status: 400 });

  return withTokenTenantScope(
    () => resolveSignRecipientTenant(token),
    async () => {
      const meta = await reqMeta();
      const result = await verifyEmailOtp(token, parsed.data.code, { ip: meta.ip, userAgent: meta.ua });
      return Response.json(result, { status: result.ok ? 200 : 409 });
    },
    () => new Response("Not found", { status: 404 }),
  );
}
