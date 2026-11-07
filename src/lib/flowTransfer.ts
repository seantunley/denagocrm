import { documentFiles, type Flow, type FlowNode } from "./flow";
import { secretLookingHeaders } from "./flowConnections";

/**
 * EXPORT / IMPORT A FLOW (Node-RED's import/export; Sean, 2026-11-04) — as a file, which is also how a finished flow
 * (e.g. the QR brochure pack) is copied to another workspace: export there, import here.
 *
 * A flow names things that belong to ONE workspace — a document, a Journey, a subflow, a staff member, a pipeline
 * stage, an API connection. On import each is checked against the importing workspace: one that exists there is
 * kept, one that doesn't is cleared, and the builder's own checks then say which steps need re-picking. Nothing is
 * ever pointed at another workspace's record. Subflow version pins are dropped (a publish pins them again), and a
 * key typed into API headers never leaves in an export.
 */
export const FLOW_FILE_KIND = "denagocrm-chatbot-flow";
export const FLOW_FILE_MAX_BYTES = 500_000;
export const FLOW_FILE_MAX_STEPS = 250;

export type FlowFile = { kind: typeof FLOW_FILE_KIND; version: 1; exportedAt: string; name: string; channel: string; flow: Flow & { positions?: Record<string, unknown> } };

export type RefKind = "document" | "journey" | "subflow" | "staff" | "stage" | "connection";
export type FlowRef = { nodeId: string; kind: RefKind; id: string };

/** Every workspace record a flow points at. */
export function workspaceRefs(flow: Flow): FlowRef[] {
  const refs: FlowRef[] = [];
  const add = (nodeId: string, kind: RefKind, id: unknown) => { if (typeof id === "string" && id) refs.push({ nodeId, kind, id }); };
  for (const node of Object.values(flow.nodes)) {
    const n = node as Record<string, unknown>;
    if (node.type === "document") for (const file of documentFiles(node)) add(node.id, "document", file.documentId);
    if (node.type === "journey") add(node.id, "journey", node.journeyId);
    if (node.type === "subflow") add(node.id, "subflow", node.flowId);
    if (node.type === "contactCard") add(node.id, "staff", node.staffUserId);
    if (node.type === "crm") { add(node.id, "staff", node.userId); add(node.id, "stage", node.stageId); }
    if (node.type === "http") add(node.id, "connection", node.connectionId);
    if (n.type === "notify") add(node.id, "staff", n.userId);
  }
  return refs;
}

/** The flow with every reference NOT in `keep` ("kind:id") cleared, and how many were cleared. */
export function clearForeignRefs(flow: Flow, keep: ReadonlySet<string>): { flow: Flow; cleared: number } {
  let cleared = 0;
  const gone = (kind: RefKind, id: unknown) => typeof id === "string" && id !== "" && !keep.has(`${kind}:${id}`) && ++cleared > 0;
  const nodes: Record<string, FlowNode> = {};
  for (const [key, node] of Object.entries(flow.nodes)) {
    const n = { ...node } as Record<string, unknown>;
    if (node.type === "document" && gone("document", node.documentId)) { n.documentId = ""; delete n.fileName; }
    if (node.type === "document" && Array.isArray(node.moreDocuments)) {
      const kept = node.moreDocuments.filter((file) => !gone("document", file?.documentId));
      if (kept.length) n.moreDocuments = kept;
      else delete n.moreDocuments;
    }
    if (node.type === "journey" && gone("journey", node.journeyId)) n.journeyId = "";
    if (node.type === "subflow") { if (gone("subflow", node.flowId)) n.flowId = ""; delete n.versionId; delete n.version; }
    if (node.type === "contactCard" && gone("staff", node.staffUserId)) delete n.staffUserId;
    if (node.type === "crm") { if (gone("staff", node.userId)) { delete n.userId; delete n.userLabel; } if (gone("stage", node.stageId)) { delete n.stageId; delete n.stageLabel; } }
    if (node.type === "http" && gone("connection", node.connectionId)) { delete n.connectionId; delete n.connectionName; }
    if (n.type === "notify" && gone("staff", n.userId)) { delete n.userId; delete n.userLabel; }
    nodes[key] = n as FlowNode;
  }
  return { flow: { ...flow, nodes }, cleared };
}

/** Any key typed into an API step's headers, removed — never exported, never imported (PR #973). */
export function withoutSecretHeaders<T extends Flow>(flow: T): T {
  const nodes: Record<string, FlowNode> = {};
  for (const [key, node] of Object.entries(flow.nodes ?? {})) {
    nodes[key] = node.type === "http" && secretLookingHeaders(node.headers).length ? ({ ...node, headers: undefined } as FlowNode) : node;
  }
  return { ...flow, nodes };
}

/** What goes in the file: the draft, minus any key typed into API headers. */
export function toFlowFile(input: { name: string; channel: string; definition: string }, now = new Date()): FlowFile {
  const flow = withoutSecretHeaders(JSON.parse(input.definition) as FlowFile["flow"]);
  return { kind: FLOW_FILE_KIND, version: 1, exportedAt: now.toISOString(), name: input.name, channel: input.channel, flow };
}

/** A file read back: a flow, or why it isn't one. */
export function parseFlowFile(text: string): { ok: true; file: FlowFile } | { ok: false; error: string } {
  if (text.length > FLOW_FILE_MAX_BYTES) return { ok: false, error: "That file is too big to be a chatbot flow." };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: "That isn't a chatbot flow file (it can't be read)." }; }
  const file = raw as Partial<FlowFile>;
  if (file?.kind !== FLOW_FILE_KIND || file.version !== 1) return { ok: false, error: "That isn't a chatbot flow file exported from the CRM." };
  const flow = file.flow;
  if (!flow || typeof flow.start !== "string" || !flow.nodes || typeof flow.nodes !== "object" || !flow.nodes[flow.start]) return { ok: false, error: "That flow file is damaged — it has no starting step." };
  if (Object.keys(flow.nodes).length > FLOW_FILE_MAX_STEPS) return { ok: false, error: `That flow has more than ${FLOW_FILE_MAX_STEPS} steps.` };
  for (const [key, node] of Object.entries(flow.nodes)) {
    if (!node || typeof node !== "object" || (node as { id?: unknown }).id !== key || typeof (node as { type?: unknown }).type !== "string") return { ok: false, error: "That flow file is damaged — a step can't be read." };
  }
  return { ok: true, file: { kind: FLOW_FILE_KIND, version: 1, exportedAt: String(file.exportedAt ?? ""), name: String(file.name ?? "Imported flow").slice(0, 80), channel: String(file.channel ?? "whatsapp"), flow } };
}

/** "Rover XL brochure.flow.json" — what the download is called. */
export const flowFileName = (name: string) => `${name.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Chatbot flow"}.flow.json`;
