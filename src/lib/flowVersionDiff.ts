import type { Flow, FlowNode } from "./flow";

/**
 * VERSION DIFF (Node-RED review 2026-11-02, Sean's item 7): what changed between two versions of a flow — steps added,
 * removed or edited (and which of their settings), connections made or broken, a new start — in words, not JSON. The
 * Versions page shows each version against the one before it, and "Preview restore" shows the draft against a version
 * before it is copied in. Pure: no database, so the page and the tests share it.
 */

/** A step in a few words — the analytics report and the diff name steps the same way. */
export function nodeLabel(node: FlowNode | undefined, nodeId: string): string {
  if (!node) return nodeId;
  if (node.type === "message" || node.type === "handoff") return node.text?.trim().slice(0, 70) || nodeId;
  if (node.type === "choice" || node.type === "capture" || node.type === "captureFile" || node.type === "slots") return node.text.trim().slice(0, 70) || nodeId;
  if (node.type === "answer") return node.answerSource ? `Answer: ${node.answerSource}` : node.text?.trim().slice(0, 70) || nodeId;
  if (node.type === "booking") return `CRM action: ${node.action ?? "service"}`;
  if (node.type === "journey") return `Journey: ${node.journeyId}`;
  if (node.type === "condition") return `Condition: ${node.condition.variable} ${node.condition.operator}`;
  if (node.type === "image") return node.caption?.trim().slice(0, 70) || "Image";
  if (node.type === "document") return `Document: ${node.fileName || "file"}`.slice(0, 70);
  if (node.type === "contactCard") return node.staffUserId ? "Contact card (staff member)" : "Contact card";
  if (node.type === "ai") return "AI conversation";
  if (node.type === "goto") return `Go to: ${node.targetLabel || node.target}`.slice(0, 70);
  if (node.type === "end") return "End";
  // Every other step type used to fall through to "End" here.
  if (node.type === "set") return `Save ${node.variable}`;
  if (node.type === "switch") return `Switch on ${node.variable}`;
  if (node.type === "http") return `API request: ${node.method} ${node.url}`.slice(0, 70);
  if (node.type === "knowledge") return "Knowledge answer";
  if (node.type === "extract") return `Read ${node.fields.join(", ")}`.slice(0, 70);
  if (node.type === "delay") return `Wait ${node.seconds}s`;
  if (node.type === "subflow") return "Run subflow";
  return nodeId;
}

type Connection = { key: string; text: string };

/** Every wire in a flow, keyed by step + outlet + target (an option's id, not its label: renaming it is an edit). */
function connections(flow: Flow): Connection[] {
  const out: Connection[] = [];
  const name = (id: string) => `“${nodeLabel(flow.nodes[id], id)}”`;
  for (const [id, node] of Object.entries(flow.nodes)) {
    const add = (outlet: string, via: string, to: unknown) => {
      if (typeof to === "string" && to) out.push({ key: `${id}|${outlet}|${to}`, text: `${name(id)} ${via}→ ${name(to)}` });
    };
    const n = node as Record<string, unknown>;
    add("next", "", n.next);
    add("true", "if yes ", n.trueNext);
    add("false", "if no ", n.falseNext);
    add("failure", "if it fails ", n.failureNext);
    add("unavailable", "if none available ", n.unavailableNext);
    add("handoff", "on handoff ", n.handoffNext);
    add("default", "otherwise ", n.defaultNext);
    if (node.type === "choice") node.options.forEach((o) => add(`opt:${o.id}`, `on “${o.label}” `, o.next));
    if (node.type === "switch") node.cases.forEach((c) => add(`case:${c.id}`, `on “${c.label || c.value}” `, c.next));
    if (node.type === "goto") add("goto", "jumps ", node.target);
  }
  return out;
}

const WIRING = new Set(["next", "trueNext", "falseNext", "failureNext", "unavailableNext", "handoffNext", "defaultNext", "target", "targetLabel"]);
const FIELD_NAMES: Record<string, string> = {
  text: "wording", options: "choices", cases: "cases", variable: "saved as", value: "value", format: "answer format",
  url: "address", method: "method", headers: "headers", body: "request body", saveAs: "saved as", caption: "caption",
  documentId: "file", fileName: "file", journeyId: "Journey", condition: "condition", action: "action", seconds: "wait",
  failureText: "failure message", noneText: "none-available message", noMatchText: "no-match message", query: "question",
  instruction: "instruction", fields: "fields", flowId: "subflow", staffUserId: "contact card", reason: "handoff reason",
  summary: "handoff summary", answerSource: "answer source", type: "step type",
};

/** Which settings of a step differ — wires are reported as connections, and options/cases are compared without them. */
function changedFields(before: FlowNode, after: FlowNode): string[] {
  const strip = (node: FlowNode) => {
    const copy: Record<string, unknown> = { ...node };
    for (const key of ["options", "cases"]) {
      if (Array.isArray(copy[key])) copy[key] = (copy[key] as Record<string, unknown>[]).map(({ next: _next, ...rest }) => rest);
    }
    return copy;
  };
  const a = strip(before);
  const b = strip(after);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== "id" && !WIRING.has(k));
  const fields = keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => FIELD_NAMES[k] ?? k);
  return [...new Set(fields)];
}

export type FlowVersionDiff = {
  comparable: boolean;
  startChanged: { from: string; to: string } | null;
  added: string[];
  removed: string[];
  changed: { label: string; fields: string[] }[];
  connectionsAdded: string[];
  connectionsRemoved: string[];
};

function parse(definition: string): Flow | null {
  try {
    const flow = JSON.parse(definition) as Flow;
    return flow?.start && flow?.nodes && typeof flow.nodes === "object" ? flow : null;
  } catch {
    return null;
  }
}

/** `before` → `after`, as the steps and wires that differ. */
export function diffFlowVersions(beforeDefinition: string, afterDefinition: string): FlowVersionDiff {
  const before = parse(beforeDefinition);
  const after = parse(afterDefinition);
  if (!before || !after) return { comparable: false, startChanged: null, added: [], removed: [], changed: [], connectionsAdded: [], connectionsRemoved: [] };
  const ids = (flow: Flow) => new Set(Object.keys(flow.nodes));
  const beforeIds = ids(before);
  const afterIds = ids(after);
  const beforeWires = connections(before);
  const afterWires = connections(after);
  const beforeKeys = new Set(beforeWires.map((w) => w.key));
  const afterKeys = new Set(afterWires.map((w) => w.key));
  return {
    comparable: true,
    startChanged: before.start === after.start ? null : { from: nodeLabel(before.nodes[before.start], before.start), to: nodeLabel(after.nodes[after.start], after.start) },
    added: [...afterIds].filter((id) => !beforeIds.has(id)).map((id) => nodeLabel(after.nodes[id], id)),
    removed: [...beforeIds].filter((id) => !afterIds.has(id)).map((id) => nodeLabel(before.nodes[id], id)),
    changed: [...beforeIds]
      .filter((id) => afterIds.has(id))
      .map((id) => ({ label: nodeLabel(after.nodes[id], id), fields: changedFields(before.nodes[id], after.nodes[id]) }))
      .filter((c) => c.fields.length > 0),
    connectionsAdded: afterWires.filter((w) => !beforeKeys.has(w.key)).map((w) => w.text),
    connectionsRemoved: beforeWires.filter((w) => !afterKeys.has(w.key)).map((w) => w.text),
  };
}

export const noDifferences = (diff: FlowVersionDiff) =>
  diff.comparable && !diff.startChanged && !diff.added.length && !diff.removed.length && !diff.changed.length && !diff.connectionsAdded.length && !diff.connectionsRemoved.length;
