"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { enabledFlowChannels } from "@/lib/flowValidationServer";
import { flowErrors, validateFlow } from "@/lib/flowValidation";
import { flowScope } from "@/lib/flowScope";
import {
  flowSnippetsSettingKey,
  getFlowSnippets,
  insertFlowSnippet,
  newFlowSnippet,
  type FlowSnippet,
} from "@/lib/flowSnippets";

function parseDefinition(raw: string): FlowSnippet["definition"] | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed?.start && parsed?.nodes ? parsed as FlowSnippet["definition"] : null;
  } catch {
    return null;
  }
}

export async function saveCurrentFlowAsSnippet(flowId: string, formData: FormData) {
  const owner = await requireOwner();
  const scope = await flowScope();
  const row = await prisma.botFlow.findFirst({ where: { id: flowId, ...scope } });
  if (!row) return;
  const definition = parseDefinition(row.definition);
  if (!definition) return;
  const errors = flowErrors(validateFlow(definition, await enabledFlowChannels()));
  if (errors.length) return;

  const name = String(formData.get("name") ?? "").trim().slice(0, 180) || `${row.name} block`;
  const description = String(formData.get("description") ?? "").trim().slice(0, 500) || undefined;
  const snippets = await getFlowSnippets();
  snippets.unshift(newFlowSnippet({ name, description, definition }));
  await putSetting(await flowSnippetsSettingKey(), JSON.stringify(snippets.slice(0, 100)));
  await logAudit({ action: "bot.flow_block_saved", summary: `Saved reusable flow block “${name}” from “${row.name}”`, user: owner });
  revalidatePath(`/bot-builder/${flowId}/blocks`);
}

export async function insertSavedFlowSnippet(flowId: string, snippetId: string) {
  const owner = await requireOwner();
  const scope = await flowScope();
  const [row, snippets] = await Promise.all([
    prisma.botFlow.findFirst({ where: { id: flowId, ...scope } }),
    getFlowSnippets(),
  ]);
  const snippet = snippets.find((item) => item.id === snippetId);
  if (!row || !snippet) return;
  const current = parseDefinition(row.definition);
  if (!current) return;
  const merged = insertFlowSnippet(current, snippet.definition);

  // Do not overwrite a canvas save that landed while this request was reading.
  const updated = await prisma.botFlow.updateMany({
    where: { id: flowId, definition: row.definition, ...scope },
    data: { definition: JSON.stringify(merged.definition) },
  });
  if (updated.count !== 1) return;

  await logAudit({
    action: "bot.flow_block_inserted",
    summary: `Inserted reusable block “${snippet.name}” into “${row.name}” as ${merged.insertedNodeIds.length} copied node${merged.insertedNodeIds.length === 1 ? "" : "s"}`,
    user: owner,
  });
  revalidatePath(`/bot-builder/${flowId}`);
  revalidatePath(`/bot-builder/${flowId}/blocks`);
  revalidatePath("/bot-builder");
}

export async function deleteFlowSnippet(snippetId: string) {
  const owner = await requireOwner();
  const snippets = await getFlowSnippets();
  const current = snippets.find((item) => item.id === snippetId);
  if (!current) return;
  await putSetting(await flowSnippetsSettingKey(), JSON.stringify(snippets.filter((item) => item.id !== snippetId)));
  await logAudit({ action: "bot.flow_block_deleted", summary: `Deleted reusable flow block “${current.name}”`, user: owner });
  revalidatePath("/bot-builder");
}
