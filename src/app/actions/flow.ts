"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { DEFAULT_FLOW } from "@/lib/flow";
import { flowTemplate } from "@/lib/flowTemplates";
import { publishFlowSnapshot } from "@/lib/flowPublishing";
import { FlowPublishValidationError } from "@/lib/flowValidationServer";
import { flowErrors, type FlowIssue } from "@/lib/flowValidation";
import { builderTenantId, flowScope } from "@/lib/flowScope";
import { withActingStaffScope } from "@/lib/actingScope";
import { FLOW_CHANNELS, FLOW_ROUTE_KINDS, normalizeRoutePattern, type FlowRouteKind } from "@/lib/flowRouting";
import type { FlowChannel } from "@/lib/flowValidation";

/** Create a new draft from one of the shipped, compiler-checked templates. */
export async function createFlow(formData: FormData) {
  return withActingStaffScope(async () => {
    const owner = await requireOwner();
    const scope = await flowScope();
    const template = flowTemplate(String(formData.get("templateId") ?? "general"));
    const requestedName = String(formData.get("name") ?? "").trim();
    const name = requestedName || template.name;
    const requestedChannel = String(formData.get("channel") ?? "whatsapp") as FlowChannel;
    const channel = FLOW_CHANNELS.includes(requestedChannel) ? requestedChannel : "whatsapp";
    const count = await prisma.botFlow.count({ where: scope });
    const flow = await prisma.botFlow.create({
      data: {
        name,
        definition: JSON.stringify(template.definition),
        channel,
        active: count === 0,
        // Stamp the owner at creation. The db.ts guard does not while enforcement is
        // dormant, so every flow made since the 20260722146000 backfill was
        // tenantless — which is what silently broke Publish, and what forces the
        // legacy NULL-tolerant rule everywhere a flow is read.
        tenantId: await builderTenantId(),
      },
    });
    // Preserve the old "first flow is live" behaviour, but publish the exact
    // selected template as an immutable snapshot rather than swapping in default.
    if (count === 0) await publishFlowSnapshot(flow.id, owner.id);
    await logAudit({
      action: "bot.flow_created",
      summary: `Chatbot flow “${name}” created from ${template.name} template`,
      user: owner,
    });
    redirect(`/bot-builder/${flow.id}`);
  });
}

/** Persist a flow's DRAFT definition (JSON: { start, nodes, positions }). */
export async function saveFlow(
  id: string,
  json: string,
  /** The draft's `updatedAt` as it was when this canvas loaded it. Required. */
  expectedUpdatedAt: string,
): Promise<{ ok?: boolean; error?: string; conflict?: boolean; updatedAt?: string }> {
  return withActingStaffScope(async () => {
    const owner = await requireOwner();
    const scope = await flowScope();
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { error: "Invalid flow data." };
    }
    const f = parsed as { start?: string; nodes?: Record<string, unknown> };
    if (!f.start || !f.nodes || !f.nodes[f.start]) return { error: "Flow needs a valid start node." };

    const expected = new Date(expectedUpdatedAt);
    // No unfenced path. An optional stamp meant the server still allowed a caller to
    // opt out of the exact invariant this exists to enforce.
    if (Number.isNaN(expected.getTime())) {
      return { error: "This editor is out of date — reload the page before saving." };
    }

    const definition = JSON.stringify(parsed);
    // The conditional write and reading back the revision it produced must be ONE
    // transaction. As two statements, another legitimate writer could land between
    // them; this tab would then adopt THEIR timestamp without ever having seen their
    // definition, and its next save would overwrite their work without a conflict —
    // the same lost update in a narrower window.
    const result = await prisma.$transaction(async (tx) => {
      const written = await tx.botFlow.updateMany({
        where: { id, updatedAt: expected, ...scope },
        data: { definition },
      });
      if (written.count !== 1) return null;
      // Read inside the transaction, so it is the row this write produced. The
      // updateMany above holds the row lock until commit.
      const row = await tx.botFlow.findFirst({ where: { id, ...scope }, select: { updatedAt: true } });
      return row?.updatedAt ?? null;
    });

    if (!result) {
      return {
        conflict: true,
        error: "This draft was changed somewhere else after you opened it. Reload to see the newer version — your changes have not been saved.",
      };
    }

    await logAudit({ action: "bot.flow_saved", summary: "Chatbot flow draft updated", user: owner });
    revalidatePath(`/bot-builder/${id}`);
    revalidatePath("/bot-builder");
    // Hand back the stamp this write produced, so the next save fences against it.
    return { ok: true, updatedAt: result.toISOString() };
  });
}

/** Revert a flow draft to the built-in default definition. Published versions are immutable. */
export async function resetFlow(
  id: string,
  /** The draft's `updatedAt` as it was when this canvas loaded it. Required. */
  expectedUpdatedAt: string,
): Promise<{ ok?: boolean; error?: string; conflict?: boolean; updatedAt?: string }> {
  return withActingStaffScope(async () => {
    await requireOwner();
    const scope = await flowScope();
    // Reset is a draft writer too — the most destructive one — so it carries the
    // same MANDATORY fence as Save. An optional stamp with an unconditional `else`
    // left the authoritative action still able to overwrite newer work.
    const expected = new Date(expectedUpdatedAt);
    if (Number.isNaN(expected.getTime())) {
      return { conflict: true, error: "This editor is out of date — reload the page before resetting." };
    }

    // Same one-transaction rule as saveFlow: the stamp handed back must be the one
    // THIS write produced, or the canvas adopts a later writer's revision unseen.
    const result = await prisma.$transaction(async (tx) => {
      const written = await tx.botFlow.updateMany({
        where: { id, updatedAt: expected, ...scope },
        data: { definition: JSON.stringify(DEFAULT_FLOW) },
      });
      if (written.count !== 1) return null;
      const row = await tx.botFlow.findFirst({ where: { id, ...scope }, select: { updatedAt: true } });
      return row?.updatedAt ?? null;
    });

    if (!result) {
      return {
        conflict: true,
        error: "This draft was changed somewhere else after you opened it. Reload to see the newer version — it has not been reset.",
      };
    }

    revalidatePath(`/bot-builder/${id}`);
    revalidatePath("/bot-builder");
    // Hand back the new stamp, or the canvas would still hold the pre-Reset
    // revision and its next save would report a conflict against its own Reset.
    return { ok: true, updatedAt: result.toISOString() };
  });
}

export async function renameFlow(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    await requireOwner();
    const scope = await flowScope();
    const name = String(formData.get("name") ?? "").trim();
    if (name) await prisma.botFlow.updateMany({ where: { id, ...scope }, data: { name } });
    revalidatePath("/bot-builder");
  });
}

export async function deleteFlow(id: string) {
  return withActingStaffScope(async () => {
    await requireOwner();
    const scope = await flowScope();
    const [flow, publishedVersion] = await Promise.all([
      prisma.botFlow.findFirst({ where: { id, ...scope } }),
      prisma.botFlowVersion.findFirst({ where: { flowId: id }, select: { id: true } }),
    ]);
    // Published snapshots may still be referenced by active BotSession pins. A
    // flow that has ever been published therefore remains as immutable history.
    if (!flow || flow.active || publishedVersion) return;
    await prisma.botFlow.deleteMany({ where: { id, ...scope } });
    revalidatePath("/bot-builder");
  });
}

export async function duplicateFlow(id: string) {
  return withActingStaffScope(async () => {
    await requireOwner();
    const scope = await flowScope();
    const src = await prisma.botFlow.findFirst({ where: { id, ...scope } });
    if (!src) return;
    await prisma.botFlow.create({
      data: { name: `${src.name} (copy)`, definition: src.definition, channel: src.channel, active: false, tenantId: await builderTenantId() },
    });
    revalidatePath("/bot-builder");
  });
}

export async function addFlowRoute(formData: FormData) {
  return withActingStaffScope(async () => {
    const owner = await requireOwner();
    const tenantId = await builderTenantId();
    const channel = String(formData.get("channel") ?? "") as FlowChannel;
    const kind = String(formData.get("kind") ?? "") as FlowRouteKind;
    const pattern = normalizeRoutePattern(String(formData.get("pattern") ?? ""));
    const flowId = String(formData.get("flowId") ?? "");
    const priority = Math.max(0, Math.min(10_000, Number.parseInt(String(formData.get("priority") ?? "100"), 10) || 100));
    if (!FLOW_CHANNELS.includes(channel) || !FLOW_ROUTE_KINDS.includes(kind) || pattern.length < 2 || !flowId) return { error: "Complete every route field with a valid value." };

    const flow = await prisma.botFlow.findFirst({ where: { id: flowId, tenantId, channel } });
    if (!flow) return { error: "Flow not found for this channel." };
    const published = await prisma.botFlowPublication.findUnique({ where: { tenantId_channel: { tenantId, channel } }, select: { flowId: true } });
    if (!published || published.flowId !== flowId) return { error: "Publish this flow as the channel default before routing traffic to it." };
    await prisma.botFlowRoute.upsert({
      where: { tenantId_channel_kind_pattern: { tenantId, channel, kind, pattern } },
      update: { flowId, priority, enabled: true },
      create: { tenantId, channel, kind, pattern, flowId, priority },
    });
    await logAudit({ action: "bot.flow_route_saved", summary: `Chatbot ${channel} ${kind} route “${pattern}” → “${flow.name}”`, user: owner });
    revalidatePath("/bot-builder/routes");
    return { success: "Route saved" };
  });
}

export async function setFlowRouteEnabled(id: string, enabled: boolean) {
  return withActingStaffScope(async () => {
    await requireOwner();
    const tenantId = await builderTenantId();
    await prisma.botFlowRoute.updateMany({ where: { id, tenantId }, data: { enabled } });
    revalidatePath("/bot-builder/routes");
  });
}

export async function deleteFlowRoute(id: string) {
  return withActingStaffScope(async () => {
    const owner = await requireOwner();
    const tenantId = await builderTenantId();
    const route = await prisma.botFlowRoute.findFirst({ where: { id, tenantId } });
    if (!route) return;
    await prisma.botFlowRoute.deleteMany({ where: { id, tenantId } });
    await logAudit({ action: "bot.flow_route_deleted", summary: `Deleted chatbot ${route.channel} ${route.kind} route “${route.pattern}”`, user: owner });
    revalidatePath("/bot-builder/routes");
  });
}

/** Publish this draft as a NEW immutable live version for its channel. */
export type PublishFlowState = { ok?: string; error?: string; issues?: FlowIssue[] };

/**
 * Publish this draft as a NEW immutable live version for its channel.
 *
 * This used to `.catch(() => null)` and return silently, which threw away the one
 * thing the operator needed. The server validates MORE than the editor can — it
 * checks that every referenced Journey is still active, re-reads the exact draft
 * inside the transaction, and refuses a graph whose failing action would announce
 * success — so a correct refusal appeared as a button that did nothing at all.
 *
 * publishFlowSnapshot already throws FlowPublishValidationError carrying the exact
 * issues, plus specific conditions like FLOW_CHANGED_DURING_PUBLISH. Surface them.
 */
export async function setActiveFlow(id: string, _previous?: PublishFlowState): Promise<PublishFlowState> {
  return withActingStaffScope(async () => {
    const owner = await requireOwner();
    let published: Awaited<ReturnType<typeof publishFlowSnapshot>>;
    try {
      published = await publishFlowSnapshot(id, owner.id);
    } catch (error) {
      if (error instanceof FlowPublishValidationError) {
        const errors = flowErrors(error.issues);
        return {
          error: `This flow cannot be published yet: ${errors.slice(0, 3).map((issue) => issue.message).join(" · ")}`,
          issues: error.issues,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message === "FLOW_CHANGED_DURING_PUBLISH") {
        return { error: "The draft changed while it was being published. Reload and publish again — nothing was published." };
      }
      if (message === "FLOW_NOT_FOUND") return { error: "That flow no longer exists." };
      // An unexpected failure is still reported rather than swallowed.
      return { error: "Publishing failed. Nothing was published; please try again." };
    }
    await logAudit({
      action: "bot.flow_published",
      summary: `Chatbot flow published as version ${published.version}`,
      user: owner,
    });
    revalidatePath("/bot-builder");
    revalidatePath(`/bot-builder/${id}`);
    return { ok: `Published as version ${published.version}.` };
  });
}
