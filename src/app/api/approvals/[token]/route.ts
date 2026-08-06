import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { isValidSignToken, hashSignToken } from "@/lib/signing/tokens";
import { approveStep, rejectStep, canActOnStep } from "@/lib/signing/approvals";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveApprovalStepTenant } from "@/lib/tokenTenant";
import { throttlePublic } from "@/lib/publicThrottle";
import { PUBLIC_ACTION_POLICY } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().max(500).optional() });

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  const throttled = await throttlePublic("approvals", token, PUBLIC_ACTION_POLICY);
  if (throttled) return throttled;
  return withTokenTenantScope(
    () => resolveApprovalStepTenant(token),
    () => handle(token, request),
    () => new Response("Not found", { status: 404 }),
  );
}

async function handle(token: string, request: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in is required", { status: 401 });
  const step = await prisma.approvalStep.findUnique({ where: { token: hashSignToken(token) } });
  if (!step) return new Response("Not found", { status: 404 });
  if (!canActOnStep(step, user)) return new Response("Not authorised for this approval", { status: 403 });
  if (step.status !== "pending") return new Response("This approval has already been actioned.", { status: 409 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response("Invalid request", { status: 400 });
  const result = parsed.data.decision === "approve"
    ? await approveStep(step.id, { userId: user.id, name: user.name })
    : await rejectStep(step.id, { userId: user.id, name: user.name }, parsed.data.reason || "");
  return result.ok ? Response.json({ ok: true }) : new Response(result.error || "Could not action approval", { status: 409 });
}
