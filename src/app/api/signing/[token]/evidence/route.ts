import { isValidSignToken, hashSignToken } from "@/lib/signing/tokens";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";
import { requireIdentityForToken } from "@/lib/signing/identity";
import { prisma } from "@/lib/db";
import { buildPortableEvidenceBundle } from "@/lib/signing/evidenceBundle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  return withTokenTenantScope(
    () => resolveSignRecipientTenant(token),
    async () => {
      try { await requireIdentityForToken(token); }
      catch (error) { return new Response(error instanceof Error ? error.message : "Verification required", { status: 403 }); }
      const recipient = await prisma.signatureRecipient.findUnique({ where: { token: hashSignToken(token) }, include: { request: true } });
      if (!recipient || recipient.request.status !== "completed") return new Response("Evidence bundle is available after completion", { status: 409 });
      const bundle = await buildPortableEvidenceBundle(recipient.requestId);
      return new Response(JSON.stringify(bundle), {
        headers: {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="${recipient.request.title.replace(/[^a-z0-9_-]+/gi, "-")}-evidence.json"`,
          "cache-control": "private, no-store",
        },
      });
    },
    () => new Response("Not found", { status: 404 }),
  );
}
