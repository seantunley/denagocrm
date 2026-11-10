/**
 * WHAT THE AI FLOW DESIGNER MAY BUILD (lib/flowAiDraft). One entry per step type the engine knows — `satisfies` makes
 * a new step type a compile error here until someone decides how the AI may use it, so the designer can no longer fall
 * behind the builder silently (it knew 13 of ~30 types until 2026-11-04). `null` = never authored by the AI.
 *
 * No server code: tested directly (tests/flowAiNodes.test.ts).
 */
import type { Flow, FlowNode } from "./flow";
import type { FlowIssue } from "./flowValidation";
import { connectionAllows } from "./flowConnections";

export const AI_NODE_SPECS = {
  message: `{id,type:"message",text,next?}`,
  choice: `{id,type:"choice",text,options:[{id,label,description?,next?}],noReply?:{minutes,next},elseNext?} — elseNext: where a typed reply that matches no option goes (e.g. the ai step)`,
  capture: `{id,type:"capture",text,variable,format?:"text"|"email"|"phone"|"number"|"date",next?,noReply?:{minutes,next}}`,
  captureFile: `{id,type:"captureFile",text,variable,next?,noReply?:{minutes,next}}`,
  image: `{id,type:"image",url,caption?,next?}`,
  document: `{id,type:"document",documentId:"<DOCUMENTS id>",moreDocuments?:[{documentId:"<DOCUMENTS id>"}],caption?,next?} — sends the business's own files, one message each`,
  contactCard: `{id,type:"contactCard",staffUserId?:"<STAFF id; omit for the business's card>",next?}`,
  answer: `{id,type:"answer",text?,answerSource?:"pricelist"|"colours",next?}`,
  set: `{id,type:"set",variable,value,next?} — value may use {{variables}}`,
  switch: `{id,type:"switch",variable,cases:[{id,value,label?,next?}],defaultNext?} — exact match, ignoring case`,
  http: `{id,type:"http",method:"GET"|"POST"|"PUT"|"PATCH"|"DELETE",url:"https://<that connection's host>/…",connectionId:"<CONNECTIONS id>",body?,saveAs?,failureText?,next?,failureNext?} — ONLY with a listed connection, on its host; never put keys or tokens anywhere`,
  knowledge: `{id,type:"knowledge",query,saveAs?,noMatchText?,next?,failureNext?} — answers from the business's approved knowledge`,
  extract: `{id,type:"extract",instruction,sourceVariable?,fields:["field_name"],failureText?,next?,failureNext?} — AI reads named values out of what the customer wrote`,
  delay: `{id,type:"delay",seconds:1..604800,next?} — a pause inside the conversation`,
  subflow: `{id,type:"subflow",flowId:"<FLOWS id>",failureText?,next?,failureNext?}`,
  booking: `{id,type:"booking",action?:"service"|"demo"|"lead"|"lookup"|"cancel",text?,failureText?,next?,failureNext?,unavailableNext?}`,
  slots: `{id,type:"slots",action?:"book"|"reschedule",text,noneText?,failureText?,next?,failureNext?,unavailableNext?}`,
  journey: `{id,type:"journey",journeyId:"<JOURNEYS id>",after?:{amount,unit:"minutes"|"hours"|"days"},handOver?:["variable"],text?,failureText?,next?,failureNext?,unavailableNext?}`,
  condition: `{id,type:"condition",condition:{variable,operator:"equals"|"not_equals"|"contains"|"exists"|"empty",value?},trueNext?,falseNext?}`,
  ai: `{id,type:"ai",handoffNext?}`,
  handoff: `{id,type:"handoff",text?,reason?,summary?}`,
  hours: `{id,type:"hours",holidaysClosed?:boolean,openNext?,closedNext?} — open or closed by the chatbot's office hours`,
  goto: `{id,type:"goto",target:"<another node id>"} — jump without a wire, e.g. back to the menu`,
  notify: `{id,type:"notify",userId:"<STAFF id>",text,next?} — tells one staff member; the customer carries on`,
  crm: `{id,type:"crm",action:"tag"|"assign"|"stage",tagName?(tag),userId?:"<STAFF id>"(assign),stageId?:"<STAGES id>"(stage),text?,failureText?,next?,failureNext?}`,
  // Canvas annotations: a person's notes on the canvas, not behaviour.
  note: null,
  group: null,
  end: `{id,type:"end"}`,
} satisfies Record<FlowNode["type"], string | null>;

export type FlowAiRef = { id: string; name: string };
/** The records an AI draft may point at — this workspace's own, loaded by the caller. */
export type FlowAiRefs = {
  journeys: FlowAiRef[];
  flows: FlowAiRef[];
  staff: FlowAiRef[];
  stages: FlowAiRef[];
  documents: FlowAiRef[];
  connections: (FlowAiRef & { host: string })[];
  tags: string[];
};

/** The step reference for the prompt. */
export function aiNodeGuide(): string {
  return Object.values(AI_NODE_SPECS).filter((spec): spec is string => spec !== null).map((spec) => {
    const type = /type:"([a-zA-Z]+)"/.exec(spec)?.[1];
    return `- ${type}: ${spec}`;
  }).join("\n");
}

/** Each list the AI may choose from, `[id] name`, or a line saying there is none (so it uses no such step). */
export function aiRefsGuide(refs: FlowAiRefs): string {
  const list = (title: string, rows: { id: string; name: string; host?: string }[], none: string) =>
    `${title}:\n${rows.length ? rows.slice(0, 80).map((r) => `[${r.id}] ${r.name}${r.host ? ` (host ${r.host})` : ""}`).join("\n") : `(none — ${none})`}`;
  return [
    list("JOURNEYS (active)", refs.journeys, "do not create a journey step"),
    list("FLOWS (for subflow)", refs.flows, "do not create a subflow step"),
    list("STAFF (for notify, contactCard, crm assign)", refs.staff, "do not create notify or crm assign steps"),
    list("STAGES (for crm stage)", refs.stages, "do not create a crm stage step"),
    list("DOCUMENTS", refs.documents, "do not create a document step"),
    list("CONNECTIONS (for http)", refs.connections, "do not create an http step"),
    `EXISTING TAGS (prefer these for crm tag): ${refs.tags.slice(0, 60).join(", ") || "(none)"}`,
  ].join("\n\n");
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A draft step the AI wrote or changed that points at anything not on its lists — or uses a type it may not author —
 * is refused. A step carried over unchanged from the saved draft is the owner's own and is left alone.
 */
export function aiDraftIssues(flow: Flow, previous: Flow | null, refs: FlowAiRefs): FlowIssue[] {
  const ids = (rows: FlowAiRef[]) => new Set(rows.map((r) => r.id));
  const flows = ids(refs.flows), staff = ids(refs.staff), stages = ids(refs.stages), documents = ids(refs.documents);
  const issues: FlowIssue[] = [];
  const refuse = (node: FlowNode, code: string, message: string) => issues.push({ severity: "error", code: `ai.${code}`, message, nodeId: node.id });
  for (const node of Object.values(flow.nodes ?? {})) {
    if (!node || typeof node !== "object") continue;
    if (previous?.nodes?.[node.id] && same(previous.nodes[node.id], node)) continue;
    const spec = (AI_NODE_SPECS as Record<string, string | null>)[node.type];
    if (spec === undefined || spec === null) { refuse(node, "type", `The flow assistant may not create a “${node.type}” step.`); continue; }
    // Journeys: checked over EVERY step by flowAiDraft's own allow-list (journey.ai_unapproved).
    if (node.type === "subflow" && !flows.has(node.flowId)) refuse(node, "subflow", "AI draft referenced a flow that is not in this workspace.");
    if (node.type === "document" && (!documents.has(node.documentId) || (node.moreDocuments ?? []).some((file) => !documents.has(file?.documentId ?? "")))) {
      refuse(node, "document", "AI draft referenced a document that is not one of the business's files.");
    }
    if (node.type === "contactCard" && node.staffUserId && !staff.has(node.staffUserId)) refuse(node, "staff", "AI draft referenced someone who is not on the staff list.");
    if (node.type === "notify" && !(node.userId && staff.has(node.userId))) refuse(node, "staff", "AI draft's alert must go to someone on the staff list.");
    if (node.type === "crm" && node.action === "assign" && !(node.userId && staff.has(node.userId))) refuse(node, "staff", "AI draft assigned a salesperson who is not on the staff list.");
    if (node.type === "crm" && node.action === "stage" && !(node.stageId && stages.has(node.stageId))) refuse(node, "stage", "AI draft referenced a pipeline stage that does not exist.");
    if (node.type === "http") {
      const connection = refs.connections.find((c) => c.id === node.connectionId);
      if (!connection) refuse(node, "http_connection", "AI drafts may only call a saved connection.");
      else if (!connectionAllows(connection, node.url)) refuse(node, "http_host", `That connection may only be used with ${connection.host}.`);
    }
  }
  return issues;
}

/** Fill the display copies the canvas shows (names), from the same lists — the AI only writes ids. */
export function withAiRefLabels(flow: Flow, refs: FlowAiRefs): Flow {
  const name = (rows: FlowAiRef[], id?: string) => rows.find((r) => r.id === id)?.name;
  for (const node of Object.values(flow.nodes ?? {})) {
    if (node?.type === "notify") node.userLabel = name(refs.staff, node.userId) ?? node.userLabel;
    if (node?.type === "crm") { node.userLabel = name(refs.staff, node.userId) ?? node.userLabel; node.stageLabel = name(refs.stages, node.stageId) ?? node.stageLabel; }
    if (node?.type === "document") {
      node.fileName = name(refs.documents, node.documentId) ?? node.fileName;
      for (const file of node.moreDocuments ?? []) file.fileName = name(refs.documents, file.documentId) ?? file.fileName;
    }
    if (node?.type === "http") node.connectionName = name(refs.connections, node.connectionId) ?? node.connectionName;
  }
  return flow;
}
