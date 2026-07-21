"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { DEFAULT_FLOW } from "@/lib/flow";

/** Create a new flow (from the default) and open it in the builder. */
export async function createFlow(formData: FormData) {
  await requireOwner();
  const name = String(formData.get("name") ?? "").trim() || "New flow";
  const count = await prisma.botFlow.count();
  const flow = await prisma.botFlow.create({
    data: { name, definition: JSON.stringify(DEFAULT_FLOW), active: count === 0 },
  });
  redirect(`/bot-builder/${flow.id}`);
}

/** Persist a flow's definition (JSON: { start, nodes, positions }). */
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
  await prisma.botFlow.update({ where: { id }, data: { definition: JSON.stringify(parsed) } });
  await logAudit({ action: "bot.flow_saved", summary: "Chatbot flow updated", user: owner });
  revalidatePath(`/bot-builder/${id}`);
  return { ok: true };
}

/** Revert a flow to the built-in default definition. */
export async function resetFlow(id: string) {
  await requireOwner();
  await prisma.botFlow.update({ where: { id }, data: { definition: JSON.stringify(DEFAULT_FLOW) } });
  revalidatePath(`/bot-builder/${id}`);
}

export async function renameFlow(id: string, formData: FormData) {
  await requireOwner();
  const name = String(formData.get("name") ?? "").trim();
  if (name) await prisma.botFlow.update({ where: { id }, data: { name } });
  revalidatePath("/bot-builder");
}

export async function deleteFlow(id: string) {
  await requireOwner();
  await prisma.botFlow.delete({ where: { id } });
  revalidatePath("/bot-builder");
}

export async function duplicateFlow(id: string) {
  await requireOwner();
  const src = await prisma.botFlow.findUnique({ where: { id } });
  if (!src) return;
  await prisma.botFlow.create({
    data: { name: `${src.name} (copy)`, definition: src.definition, channel: src.channel, active: false },
  });
  revalidatePath("/bot-builder");
}

/** Make one flow the live WhatsApp flow (only one active per channel). */
export async function setActiveFlow(id: string) {
  await requireOwner();
  const flow = await prisma.botFlow.findUnique({ where: { id } });
  if (!flow) return;
  await prisma.botFlow.updateMany({ where: { channel: flow.channel }, data: { active: false } });
  await prisma.botFlow.update({ where: { id }, data: { active: true } });
  revalidatePath("/bot-builder");
}
