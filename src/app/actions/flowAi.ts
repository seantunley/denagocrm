"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { generateFlowDraft } from "@/lib/flowAiDraft";
import { enabledFlowChannels } from "@/lib/flowValidationServer";
import { flowErrors } from "@/lib/flowValidation";
import { flowScope, journeyScope } from "@/lib/flowScope";
import { withActingStaffScope } from "@/lib/actingScope";

export type FlowAiDraftState = { ok?: string; error?: string; warnings?: string[] };

/** Replace the SAVED DRAFT only after the generated graph compiles. */
export async function generateFlowDraftAction(
  flowId: string,
  _previous: FlowAiDraftState | undefined,
  formData: FormData,
): Promise<FlowAiDraftState> {
  return withActingStaffScope(async () => {
    const owner = await requireOwner();
    const instruction = String(formData.get("instruction") ?? "").trim();
    if (instruction.length < 8) return { error: "Describe the change you want in a little more detail." };
    const scope = await flowScope();

    const [row, channels, journeys] = await Promise.all([
      prisma.botFlow.findFirst({ where: { id: flowId, ...scope } }),
      enabledFlowChannels(),
      prisma.journey.findMany({ where: { status: "active", ...(await journeyScope()) }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    if (!row) return { error: "Flow not found." };
    const originalDefinition = row.definition;
    const generated = await generateFlowDraft({ instruction, currentDefinition: originalDefinition, channels, journeys });
    if (!generated) return { error: "The flow assistant could not produce a valid graph. Nothing was changed." };

    const errors = flowErrors(generated.issues);
    if (errors.length) {
      return {
        error: `The generated graph failed the compiler: ${errors.slice(0, 3).map((item) => item.message).join(" · ")}`,
        warnings: generated.issues.filter((item) => item.severity === "warning").slice(0, 5).map((item) => item.message),
      };
    }

    const updated = await prisma.botFlow.updateMany({
      where: { id: flowId, definition: originalDefinition, ...scope },
      data: { definition: JSON.stringify(generated.flow) },
    });
    if (updated.count !== 1) return { error: "The draft changed while the assistant was working. Nothing was overwritten — run it again on the latest draft." };

    await logAudit({ action: "bot.flow_ai_drafted", summary: `AI updated chatbot flow draft “${row.name}”: ${instruction.slice(0, 120)}`, user: owner });
    revalidatePath(`/bot-builder/${flowId}`);
    revalidatePath("/bot-builder");
    const warnings = generated.issues.filter((item) => item.severity === "warning").slice(0, 5).map((item) => item.message);
    return { ok: "Draft replaced. Review it in the canvas and simulator before publishing.", ...(warnings.length ? { warnings } : {}) };
  });
}
