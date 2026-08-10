"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { DEFAULT_FLOW } from "@/lib/flow";
import { flowTemplate } from "@/lib/flowTemplates";
import { publishFlowSnapshot } from "@/lib/flowPublishing";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { writeTenantId } from "@/lib/tenantWrite";

/** Create a new draft from one of the shipped, compiler-checked templates. */
export async function createFlow(formData: FormData) {
  const owner = await requireOwner();
  const template = flowTemplate(String(formData.get("templateId") ?? "general"));
  const requestedName = String(formData.get("name") ?? "").trim();
  const name = requestedName || template.name;
  const count = await prisma.botFlow.count();
  const flow = await prisma.botFlow.create({
    data: {
      name,
      definition: JSON.stringify(template.definition),
      active: count === 0,
      // Stamp the owner at creation. The db.ts guard does not while enforcement is
      // dormant, so every flow made since the 20260722146000 backfill was
      // tenantless — which is what silently broke Publish, and what forces the
      // legacy NULL-tolerant rule everywhere a flow is read.
      tenantId: writeTenantId() ?? DEFAULT_TENANT_ID,
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
}

/** Persist a flow's DRAFT definition (JSON: { start, nodes, positions }). */
export async function saveFlow(
  id: string,
  json: string,
  /** The draft's `updatedAt` as it was when this canvas loaded it. Required. */
  expectedUpdatedAt: string,
): Promise<{ ok?: boolean; error?: string; conflict?: boolean; updatedAt?: string }> {
  const owner = await requireOwner();
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
      where: { id, updatedAt: expected },
      data: { definition },
    });
    if (written.count !== 1) return null;
    // Read inside the transaction, so it is the row this write produced. The
    // updateMany above holds the row lock until commit.
    const row = await tx.botFlow.findUnique({ where: { id }, select: { updatedAt: true } });
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
}

/** Revert a flow draft to the built-in default definition. Published versions are immutable. */
export async function resetFlow(
  id: string,
  /** The draft's `updatedAt` as it was when this canvas loaded it. Required. */
  expectedUpdatedAt: string,
): Promise<{ ok?: boolean; error?: string; conflict?: boolean; updatedAt?: string }> {
  await requireOwner();
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
      where: { id, updatedAt: expected },
      data: { definition: JSON.stringify(DEFAULT_FLOW) },
    });
    if (written.count !== 1) return null;
    const row = await tx.botFlow.findUnique({ where: { id }, select: { updatedAt: true } });
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
}

export async function renameFlow(id: string, formData: FormData) {
  await requireOwner();
  const name = String(formData.get("name") ?? "").trim();
  if (name) await prisma.botFlow.update({ where: { id }, data: { name } });
  revalidatePath("/bot-builder");
}

export async function deleteFlow(id: string) {
  await requireOwner();
  const [flow, publishedVersion] = await Promise.all([
    prisma.botFlow.findUnique({ where: { id } }),
    prisma.botFlowVersion.findFirst({ where: { flowId: id }, select: { id: true } }),
  ]);
  // Published snapshots may still be referenced by active BotSession pins. A
  // flow that has ever been published therefore remains as immutable history.
  if (!flow || flow.active || publishedVersion) return;
  await prisma.botFlow.delete({ where: { id } });
  revalidatePath("/bot-builder");
}

export async function duplicateFlow(id: string) {
  await requireOwner();
  const src = await prisma.botFlow.findUnique({ where: { id } });
  if (!src) return;
  await prisma.botFlow.create({
    data: { name: `${src.name} (copy)`, definition: src.definition, channel: src.channel, active: false, tenantId: writeTenantId() ?? DEFAULT_TENANT_ID },
  });
  revalidatePath("/bot-builder");
}

/** Publish this draft as a NEW immutable live version for its channel. */
export async function setActiveFlow(id: string) {
  const owner = await requireOwner();
  const published = await publishFlowSnapshot(id, owner.id).catch(() => null);
  if (!published) return;
  await logAudit({
    action: "bot.flow_published",
    summary: `Chatbot flow published as version ${published.version}`,
    user: owner,
  });
  revalidatePath("/bot-builder");
  revalidatePath(`/bot-builder/${id}`);
}
