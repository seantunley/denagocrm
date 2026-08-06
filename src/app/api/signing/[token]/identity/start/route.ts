import { z } from "zod";
import { isValidSignToken } from "@/lib/signing/tokens";
import { rateLimitSigning } from "@/lib/signing/throttle";
import { startIdentityChallenge } from "@/lib/signing/identity";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The caller names a CHANNEL, not a destination.
 *
 * "email" or "sms" is all this accepts; where the code actually goes is read
 * from the recipient row and the document's policy. A route that took an address
 * would let anyone holding the link have the verification code posted to
 * themselves, which would make the whole ceremony worse than useless.
 */
const bodySchema = z.object({ channel: z.enum(["email", "sms"]).default("email") });

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  const throttled = await rateLimitSigning(token);
  if (throttled) return throttled;

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return new Response("Invalid request", { status: 400 });

  return withTokenTenantScope(
    () => resolveSignRecipientTenant(token),
    async () => {
      const result = await startIdentityChallenge(token, parsed.data.channel);
      return Response.json(result, { status: result.ok ? 200 : 409 });
    },
    () => new Response("Not found", { status: 404 }),
  );
}
