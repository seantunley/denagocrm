"use server";

import { redirect } from "next/navigation";
import { basePrisma, prisma } from "@/lib/db";
import { requireTenantOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { getSetting } from "@/lib/settings";
import { withActingStaffScope } from "@/lib/actingScope";
import { builderTenantId, flowScope, journeyScope } from "@/lib/flowScope";
import { flowDocumentIssues } from "@/lib/flowDocuments";
import { FLOW_CONNECTIONS_KEY, parseConnections } from "@/lib/flowConnections";
import { FLOW_CHANNELS } from "@/lib/flowRouting";
import type { FlowChannel } from "@/lib/flowValidation";
import { FLOW_FILE_MAX_BYTES, clearForeignRefs, flowFileName, parseFlowFile, toFlowFile, withoutSecretHeaders, workspaceRefs, type RefKind } from "@/lib/flowTransfer";

/** Export a flow's draft as a file (lib/flowTransfer). Owner only, this workspace's flow only; logged. */
export async function exportFlow(id: string): Promise<{ error?: string; fileName?: string; content?: string }> {
  return withActingStaffScope(async () => {
    const owner = await requireTenantOwner();
    const row = await prisma.botFlow.findFirst({ where: { id, ...(await flowScope()) }, select: { name: true, channel: true, definition: true } });
    if (!row) return { error: "Flow not found." };
    let content: string;
    try { content = JSON.stringify(toFlowFile(row), null, 2); } catch { return { error: "This flow's draft can't be read, so it can't be exported." }; }
    await logAudit({ action: "bot.flow_exported", summary: `Chatbot flow “${row.name}” exported as a file`, user: owner });
    return { fileName: flowFileName(row.name), content };
  });
}

/**
 * Import a flow file as a NEW DRAFT — never live until published. Every workspace record it names is checked
 * against THIS workspace: kept if it exists here, cleared if not (the builder then lists what to re-pick).
 */
export async function importFlow(formData: FormData): Promise<{ error?: string } | void> {
  const id = await withActingStaffScope(async (): Promise<{ error: string } | { id: string }> => {
    const owner = await requireTenantOwner();
    const tenantId = await builderTenantId();
    const upload = formData.get("file");
    if (!(upload instanceof File) || upload.size === 0) return { error: "Choose a flow file (.flow.json) to import." };
    if (upload.size > FLOW_FILE_MAX_BYTES) return { error: "That file is too big to be a chatbot flow." };
    const parsed = parseFlowFile(await upload.text());
    if (!parsed.ok) return { error: parsed.error };
    const { file } = parsed;

    const refs = workspaceRefs(file.flow);
    const ids = (kind: RefKind) => [...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id))];
    const keep = new Set<string>();
    const found = (kind: RefKind, rows: { id: string }[]) => rows.forEach((row) => keep.add(`${kind}:${row.id}`));
    if (ids("document").length) {
      const missing = new Set((await flowDocumentIssues(file.flow, tenantId)).map((issue) => issue.nodeId));
      for (const ref of refs) if (ref.kind === "document" && !missing.has(ref.nodeId)) keep.add(`document:${ref.id}`);
    }
    if (ids("journey").length) found("journey", await prisma.journey.findMany({ where: { id: { in: ids("journey") }, ...(await journeyScope()) }, select: { id: true } }));
    if (ids("subflow").length) found("subflow", await prisma.botFlow.findMany({ where: { id: { in: ids("subflow") }, ...(await flowScope()) }, select: { id: true } }));
    if (ids("staff").length) found("staff", (await basePrisma.tenantMember.findMany({ where: { tenantId, userId: { in: ids("staff") } }, select: { userId: true } })).map((m) => ({ id: m.userId })));
    if (ids("stage").length) found("stage", await prisma.pipelineStage.findMany({ where: { id: { in: ids("stage") }, tenantId }, select: { id: true } }));
    if (ids("connection").length) found("connection", parseConnections(await getSetting(FLOW_CONNECTIONS_KEY)).filter((c) => ids("connection").includes(c.id)));
    const { flow, cleared } = clearForeignRefs(withoutSecretHeaders(file.flow), keep);

    const channel = (FLOW_CHANNELS as readonly string[]).includes(file.channel) ? (file.channel as FlowChannel) : "whatsapp";
    const name = `${file.name} (imported)`.slice(0, 100);
    const row = await prisma.botFlow.create({ data: { name, definition: JSON.stringify(flow), channel, active: false, tenantId } });
    await logAudit({
      action: "bot.flow_imported",
      summary: `Chatbot flow “${name}” imported from a file as a draft${cleared ? ` — ${cleared} link${cleared === 1 ? "" : "s"} to another workspace's records cleared, to re-pick` : ""}`,
      user: owner,
    });
    return { id: row.id };
  });
  if ("error" in id) return id;
  redirect(`/bot-builder/${id.id}`);
}
