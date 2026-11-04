"use server";

import { prisma } from "@/lib/db";
import { requireTenantOwner } from "@/lib/auth";
import { withActingStaffScope } from "@/lib/actingScope";
import { builderTenantId, flowScope } from "@/lib/flowScope";
import { listReplayConversations, replayConversation, type ReplayConversation, type ReplayResult } from "@/lib/flowReplay";

/** The flow must be this workspace's (the same door as the simulator). */
async function ownedFlow(flowId: string): Promise<string | null> {
  await requireTenantOwner();
  const row = await prisma.botFlow.findFirst({ where: { id: flowId, ...(await flowScope()) }, select: { id: true } });
  return row ? builderTenantId() : null;
}

export async function listFlowReplays(flowId: string): Promise<ReplayConversation[]> {
  return withActingStaffScope(async () => {
    const tenantId = await ownedFlow(flowId);
    return tenantId ? listReplayConversations(tenantId, flowId) : [];
  });
}

export async function replayFlowConversation(flowId: string, eventId: string): Promise<ReplayResult> {
  return withActingStaffScope(async () => {
    const tenantId = await ownedFlow(flowId);
    if (!tenantId) return { ok: false, error: "Flow not found." };
    try {
      return await replayConversation(tenantId, flowId, eventId);
    } catch {
      return { ok: false, error: "The replay stopped — try again." };
    }
  });
}
