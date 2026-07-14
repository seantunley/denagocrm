import { z } from "zod";
import { prisma } from "@/lib/db";
import { isValidSignToken } from "@/lib/signing/tokens";
import { approveStep, rejectStep } from "@/lib/signing/approvals";
import { reqMeta } from "@/lib/signing/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  decision: z.enum(["approve", "reject"]),
  name: z.string().max(120).optional(),
  reason: z.string().max(500).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });

  const step = await prisma.approvalStep.findUnique({ where: { token } });
  if (!step) return new Response("Not found", { status: 404 });
  if (step.status !== "pending") return new Response("This approval has already been actioned.", { status: 409 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response("Invalid request", { status: 400 });
  const { decision, name, reason } = parsed.data;

  const meta = await reqMeta();
  const by = { name: name?.trim() || step.assigneeName || "Approver" };
  const res = decision === "approve"
    ? await approveStep(step.id, by)
    : await rejectStep(step.id, by, reason ?? "");
  void meta;
  if (!res.ok) return new Response(res.error ?? "Could not action this approval.", { status: 409 });
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}
