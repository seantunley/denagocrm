import { z } from "zod";
import { prisma } from "@/lib/db";
import { isValidSignToken } from "@/lib/signing/tokens";
import { approveStep, rejectStep } from "@/lib/signing/approvals";
import { reqMeta } from "@/lib/signing/events";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveApprovalStepTenant } from "@/lib/tokenTenant";
import { throttlePublic } from "@/lib/publicThrottle";
import { PUBLIC_ACTION_POLICY } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  decision: z.enum(["approve", "reject"]),
  name: z.string().trim().min(2).max(120).optional(),
  reason: z.string().trim().max(500).optional(),
}).strict();

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  const throttled = await throttlePublic("approvals", token, PUBLIC_ACTION_POLICY);
  if (throttled) return throttled;
  return withTokenTenantScope(
    () => resolveApprovalStepTenant(token),
    () => handleApproval(token, req),
    () => new Response("Not found", { status: 404 }),
  );
}

async function handleApproval(token: string, req: Request): Promise<Response> {
  const step = await prisma.approvalStep.findUnique({ where: { token } });
  if (!step || !step.tenantId) return new Response("Not found", { status: 404 });
  if (step.status !== "pending") return new Response("This approval has already been actioned.", { status: 409 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response("Invalid request", { status: 400 });
  const { decision, name, reason } = parsed.data;
  const meta = await reqMeta();
  const actor = {
    name: name || step.assigneeName || "Approver",
    ip: meta.ip,
    userAgent: meta.ua,
    channel: "web" as const,
  };
  const result = decision === "approve"
    ? await approveStep(step.id, actor)
    : await rejectStep(step.id, actor, reason ?? "");
  if (!result.ok) return new Response(result.error ?? "Could not action this approval.", { status: 409 });
  return Response.json({ ok: true });
}
