import { prisma } from "./db";
import type { Flow } from "./flow";
import type { FlowIssue } from "./flowValidation";

/**
 * Which files a chatbot flow may send: the workspace's OWN general documents.
 *
 * One rule, used by the builder's dropdown, by save/publish, and again at send
 * time — three places that would otherwise drift. A file filed on a contact,
 * vehicle, job card or quote is a customer's record (an invoice, a proof of
 * payment, a licence) and must never be sendable to whoever messages the bot,
 * so it is excluded here rather than trusted to the dropdown. The tenant is
 * always named: a flow in workspace A can never send workspace B's file.
 */
export function flowDocumentWhere(tenantId: string) {
  return { tenantId, deletedAt: null, contactId: null, vehicleId: null, jobCardId: null, quoteId: null };
}

/** The builder's dropdown: current versions only, newest first. */
export async function flowDocumentOptions(tenantId: string): Promise<{ id: string; name: string }[]> {
  const rows = await prisma.document.findMany({
    where: { ...flowDocumentWhere(tenantId), replacedById: null },
    select: { id: true, fileName: true },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  return rows.map((row) => ({ id: row.id, name: row.fileName }));
}

/** Errors for document nodes pointing at a file this workspace may not send. */
export async function flowDocumentIssues(flow: Flow, tenantId: string): Promise<FlowIssue[]> {
  const nodes = Object.values(flow.nodes ?? {}).filter((node) => node?.type === "document");
  // Saved drafts are untrusted JSON: only string ids reach the query.
  const ids = [...new Set(nodes.map((node) => (node.type === "document" && typeof node.documentId === "string" ? node.documentId : "")).filter(Boolean))];
  const found = ids.length
    ? new Set((await prisma.document.findMany({ where: { ...flowDocumentWhere(tenantId), id: { in: ids } }, select: { id: true } })).map((row) => row.id))
    : new Set<string>();
  return nodes.flatMap((node) => {
    if (node.type !== "document") return [];
    if (!node.documentId || typeof node.documentId !== "string") return [{ severity: "error" as const, code: "document.missing", message: "Send a document needs a file chosen.", nodeId: node.id }];
    return found.has(node.documentId) ? [] : [{ severity: "error" as const, code: "document.unavailable", message: "The chosen file is not one of this workspace's documents (it was deleted, or belongs to a customer record or another workspace).", nodeId: node.id }];
  });
}

/**
 * The file to send NOW for a flow document node — tenant-checked again at send
 * time, and following "replaced by a newer version" so an updated brochure goes
 * out without editing the flow. Null when it is gone or not sendable.
 */
export async function resolveFlowDocument(tenantId: string, documentId: string) {
  const select = { id: true, fileName: true, storedName: true, mimeType: true, replacedById: true } as const;
  let doc = await prisma.document.findFirst({ where: { ...flowDocumentWhere(tenantId), id: documentId }, select });
  for (let hops = 0; doc?.replacedById && hops < 10; hops++) {
    const newer = await prisma.document.findFirst({ where: { ...flowDocumentWhere(tenantId), id: doc.replacedById }, select });
    if (!newer) break;
    doc = newer;
  }
  return doc;
}
