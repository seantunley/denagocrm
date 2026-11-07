import { prisma } from "./db";
import { documentFiles, type Flow } from "./flow";
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

/**
 * THE LIBRARY TOO (Sean, 2026-11-02: the QR template's "File to send" was empty while Documents → Library held eight
 * brochures and two price lists). The Library is its own store (LibraryDocument, versioned) — the same files email
 * attaches — and it is exactly what a flow should send. A step points at the library DOCUMENT, so its newest version
 * goes out without editing the flow. A deleted one, or one with no file, is not sendable.
 */
function libraryWhere(tenantId: string) {
  return { tenantId, deletedAt: null, versions: { some: {} } };
}

/** The builder's dropdown: Library files first (name and category), then general files; current versions only. */
export async function flowDocumentOptions(tenantId: string): Promise<{ id: string; name: string }[]> {
  const [library, rows] = await Promise.all([
    prisma.libraryDocument.findMany({ where: libraryWhere(tenantId), select: { id: true, name: true, category: true }, orderBy: [{ category: "asc" }, { name: "asc" }], take: 300 }),
    prisma.document.findMany({
      where: { ...flowDocumentWhere(tenantId), replacedById: null },
      select: { id: true, fileName: true },
      orderBy: { createdAt: "desc" },
      take: 300,
    }),
  ]);
  return [
    ...library.map((doc) => ({ id: doc.id, name: `${doc.name} — Library${doc.category ? ` · ${doc.category}` : ""}` })),
    ...rows.map((row) => ({ id: row.id, name: row.fileName })),
  ];
}

/** Errors for document nodes pointing at a file this workspace may not send. */
export async function flowDocumentIssues(flow: Flow, tenantId: string): Promise<FlowIssue[]> {
  const nodes = Object.values(flow.nodes ?? {}).filter((node) => node?.type === "document");
  // Saved drafts are untrusted JSON: only string ids reach the query.
  const ids = [...new Set(nodes.flatMap((node) => (node.type === "document" ? documentFiles(node).map((file) => file.documentId) : [])))];
  const found = new Set<string>();
  if (ids.length) {
    const [general, library] = await Promise.all([
      prisma.document.findMany({ where: { ...flowDocumentWhere(tenantId), id: { in: ids } }, select: { id: true } }),
      prisma.libraryDocument.findMany({ where: { ...libraryWhere(tenantId), id: { in: ids } }, select: { id: true } }),
    ]);
    for (const row of [...general, ...library]) found.add(row.id);
  }
  return nodes.flatMap((node) => {
    if (node.type !== "document") return [];
    if (!node.documentId || typeof node.documentId !== "string") return [{ severity: "error" as const, code: "document.missing", message: "Send a document needs a file chosen.", nodeId: node.id }];
    // Every file on the step, the extra ones too.
    return documentFiles(node).every((file) => found.has(file.documentId))
      ? []
      : [{ severity: "error" as const, code: "document.unavailable", message: "A chosen file is not one of this workspace's documents (it was deleted, or belongs to a customer record or another workspace).", nodeId: node.id }];
  });
}

/**
 * The file to send NOW for a flow document node — tenant-checked again at send
 * time, and following "replaced by a newer version" so an updated brochure goes
 * out without editing the flow. Null when it is gone or not sendable.
 */
export async function resolveFlowDocument(tenantId: string, documentId: string) {
  // A Library file: its newest version, in this workspace, not deleted.
  const library = await prisma.libraryDocument.findFirst({
    where: { ...libraryWhere(tenantId), id: documentId },
    select: { versions: { orderBy: { version: "desc" }, take: 1, select: { id: true, fileName: true, storedName: true, mimeType: true } } },
  });
  const latest = library?.versions[0];
  if (latest) return { ...latest, replacedById: null };

  const select = { id: true, fileName: true, storedName: true, mimeType: true, replacedById: true } as const;
  let doc = await prisma.document.findFirst({ where: { ...flowDocumentWhere(tenantId), id: documentId }, select });
  for (let hops = 0; doc?.replacedById && hops < 10; hops++) {
    const newer = await prisma.document.findFirst({ where: { ...flowDocumentWhere(tenantId), id: doc.replacedById }, select });
    if (!newer) break;
    doc = newer;
  }
  return doc;
}
