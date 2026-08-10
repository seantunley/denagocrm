"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { DEFAULT_FLOW } from "@/lib/flow";
import { flowTemplate } from "@/lib/flowTemplates";
import { publishFlowSnapshot } from "@/lib/flowPublishing";
// `requireOwner()` proves the caller is AN owner, not WHICH workspace's flows they
// may touch. The db.ts guard would add that predicate, but only under tenant
// enforcement, which is off in production — so every query below names the tenant
// itself. BotFlow.tenantId is nullable (legacy single-tenant rows), hence the
// founding-tenant-owns-NULL rule rather than strict equality.
import { builderOwnedWhere, builderTenantId } from "@/lib/flowTenantScopeServer";

/** Create a new draft from one of the shipped, compiler-checked templates. */
export async function createFlow(formData: FormData) {
  const owner = await requireOwner();
  const template = flowTemplate(String(formData.get("templateId") ?? "general"));
  const requestedName = String(formData.get("name") ?? "").trim();
  const name = requestedName || template.name;
  const count = await prisma.botFlow.count({ where: builderOwnedWhere() });
  const flow = await prisma.botFlow.create({
    data: {
      tenantId: builderTenantId(),
      name,
      definition: JSON.stringify(template.definition),
      active: count === 0,
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
export async function saveFlow(id: string, json: string): Promise<{ ok?: boolean; error?: string }> {
  const owner = await requireOwner();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: "Invalid flow data." };
  }
  const f = parsed as { start?: string; nodes?: Record<string, unknown> };
  if (!f.start || !f.nodes || !f.nodes[f.start]) return { error: "Flow needs a valid start node." };
  const saved = await prisma.botFlow.updateMany({
    where: { id, ...builderOwnedWhere() },
    data: { definition: JSON.stringify(parsed) },
  });
  if (saved.count !== 1) return { error: "Flow not found." };
  await logAudit({ action: "bot.flow_saved", summary: "Chatbot flow draft updated", user: owner });
  revalidatePath(`/bot-builder/${id}`);
  revalidatePath("/bot-builder");
  return { ok: true };
}

/** Revert a flow draft to the built-in default definition. Published versions are immutable. */
export async function resetFlow(id: string) {
  await requireOwner();
  await prisma.botFlow.updateMany({ where: { id, ...builderOwnedWhere() }, data: { definition: JSON.stringify(DEFAULT_FLOW) } });
  revalidatePath(`/bot-builder/${id}`);
  revalidatePath("/bot-builder");
}

export async function renameFlow(id: string, formData: FormData) {
  await requireOwner();
  const name = String(formData.get("name") ?? "").trim();
  if (name) await prisma.botFlow.updateMany({ where: { id, ...builderOwnedWhere() }, data: { name } });
  revalidatePath("/bot-builder");
}

export async function deleteFlow(id: string) {
  await requireOwner();
  const [flow, publishedVersion] = await Promise.all([
    prisma.botFlow.findFirst({ where: { id, ...builderOwnedWhere() } }),
    // BotFlowVersion.tenantId is NOT NULL → strict. Unscoped, this also read as a
    // cross-tenant DELETE VETO: another workspace's version of a same-named flow id
    // could block a legitimate delete, and worse, the delete itself matched any id.
    prisma.botFlowVersion.findFirst({ where: { tenantId: builderTenantId(), flowId: id }, select: { id: true } }),
  ]);
  // Published snapshots may still be referenced by active BotSession pins. A
  // flow that has ever been published therefore remains as immutable history.
  if (!flow || flow.active || publishedVersion) return;
  await prisma.botFlow.deleteMany({ where: { id, ...builderOwnedWhere() } });
  revalidatePath("/bot-builder");
}

export async function duplicateFlow(id: string) {
  await requireOwner();
  const src = await prisma.botFlow.findFirst({ where: { id, ...builderOwnedWhere() } });
  if (!src) return;
  await prisma.botFlow.create({
    data: { tenantId: builderTenantId(), name: `${src.name} (copy)`, definition: src.definition, channel: src.channel, active: false },
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
