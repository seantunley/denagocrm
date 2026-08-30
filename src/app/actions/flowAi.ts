"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { generateFlowDraft } from "@/lib/flowAiDraft";
import { enabledFlowChannels, validateFlowForEnabledChannels } from "@/lib/flowValidationServer";
import { flowErrors } from "@/lib/flowValidation";
import { flowScope, journeyScope } from "@/lib/flowScope";
import { withActingStaffScope } from "@/lib/actingScope";
import { diffFlowDefinitions, flowDefinitionHash, signFlowProposal, verifyFlowProposal, type FlowProposalDiff } from "@/lib/flowAiProposal";
import type { Flow } from "@/lib/flow";

export type FlowAiProposalView = FlowProposalDiff & { token: string; expiresAt: string };
export type FlowAiDraftState = { ok?: string; error?: string; warnings?: string[]; proposal?: FlowAiProposalView };

/** Generate a signed proposal. This action deliberately performs no draft write. */
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

    const definition = JSON.stringify(generated.flow);
    const signed = signFlowProposal({ flowId, ownerId: owner.id, baseHash: flowDefinitionHash(originalDefinition), definition, instruction });
    const diff = diffFlowDefinitions(originalDefinition, definition);
    const warnings = generated.issues.filter((item) => item.severity === "warning").slice(0, 5).map((item) => item.message);
    return { ok: "Proposal ready. Review the changes before applying them.", proposal: { ...signed, ...diff }, ...(warnings.length ? { warnings } : {}) };
  });
}

export async function applyFlowDraftProposalAction(
  flowId: string,
  _previous: FlowAiDraftState | undefined,
  formData: FormData,
): Promise<FlowAiDraftState> {
  return withActingStaffScope(async () => {
    const owner = await requireOwner();
    const token = String(formData.get("proposalToken") ?? "");
    const proposal = verifyFlowProposal(token);
    if (!proposal || proposal.flowId !== flowId || proposal.ownerId !== owner.id) return { error: "This AI proposal is invalid or expired. Generate it again." };
    let flow: Flow;
    try { flow = JSON.parse(proposal.definition) as Flow; } catch { return { error: "This AI proposal is malformed. Nothing was changed." }; }

    const issues = await validateFlowForEnabledChannels(flow);
    const errors = flowErrors(issues);
    if (errors.length) return { error: `This proposal is no longer safe to apply: ${errors.slice(0, 3).map((item) => item.message).join(" · ")}` };

    const scope = await flowScope();
    const row = await prisma.botFlow.findFirst({ where: { id: flowId, ...scope } });
    if (!row) return { error: "Flow not found." };
    if (flowDefinitionHash(row.definition) !== proposal.baseHash) return { error: "The draft changed after this proposal was generated. Nothing was overwritten — generate a new proposal." };

    const updated = await prisma.botFlow.updateMany({ where: { id: flowId, definition: row.definition, ...scope }, data: { definition: proposal.definition } });
    if (updated.count !== 1) return { error: "The draft changed while the proposal was being applied. Nothing was overwritten." };

    await logAudit({ action: "bot.flow_ai_drafted", summary: `Applied AI chatbot proposal to “${row.name}”: ${proposal.instruction.slice(0, 120)}`, user: owner });
    revalidatePath(`/bot-builder/${flowId}`);
    revalidatePath("/bot-builder");
    return { ok: "AI proposal applied to the saved draft. Review and test it before publishing." };
  });
}
