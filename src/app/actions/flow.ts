"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";

/** Persist the chatbot flow (JSON: { start, nodes, positions }). */
export async function saveFlow(json: string): Promise<{ ok?: boolean; error?: string }> {
  const owner = await requireOwner();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: "Invalid flow data." };
  }
  const f = parsed as { start?: string; nodes?: Record<string, unknown> };
  if (!f.start || !f.nodes || typeof f.nodes !== "object") return { error: "Flow needs a start node." };
  if (!f.nodes[f.start]) return { error: "The start node is missing." };
  await putSetting("BOT_FLOW", JSON.stringify(parsed));
  await logAudit({ action: "bot.flow_saved", summary: "Chatbot flow updated", userName: owner.name });
  revalidatePath("/bot-builder");
  return { ok: true };
}

/** Revert to the built-in default flow. */
export async function resetFlow() {
  await requireOwner();
  await putSetting("BOT_FLOW", "");
  revalidatePath("/bot-builder");
}
