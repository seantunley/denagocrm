import "server-only";
import { prisma } from "@/lib/db";
import { parseGraph, type WorkflowGraph, type SignNode } from "./model";
import { evalCondition, type WorkflowContext } from "./compile";
import { newSignToken } from "@/lib/signing/tokens";
import { notifyRecipient } from "@/lib/signing/dispatch";
import { notifyApprover } from "@/lib/signing/approvals";
import { logSignEvent } from "@/lib/signing/events";
import { completeSignatureRequest } from "@/lib/signing/complete";
import { notifyCreatorRejected } from "@/lib/signing/notify";

/**
 * Runtime interpreter for workflow-driven signature requests. Unlike the static
 * compiled chain, this walks the frozen graph node-by-node as each step resolves,
 * so approval REJECTIONS can follow their own branch. Signer + signature-approval
 * nodes are pre-materialised as recipients (their doc blocks are laid out at send);
 * decision approvals are materialised as ApprovalStep rows on demand.
 */

export type FrozenWorkflow = { graph: WorkflowGraph; vars: WorkflowContext };

function parseFrozen(json: unknown): FrozenWorkflow | null {
  const w = json as { graph?: unknown; vars?: unknown } | null;
  if (!w || typeof w !== "object") return null;
  const graph = parseGraph(w.graph);
  if (!graph) return null;
  const vars = (w.vars ?? { total: 0, discount: 0, segment: "", product: "" }) as WorkflowContext;
  return { graph, vars };
}

type WalkResult = { kind: "node"; node: SignNode } | { kind: "end" } | { kind: "dead" };

/** From an edge target, skip deterministic nodes (start/condition) to the next actionable node. */
function walkToActionable(graph: WorkflowGraph, fromId: string | undefined, vars: WorkflowContext): WalkResult {
  let cur = fromId;
  const seen = new Set<string>();
  let guard = 0;
  while (cur && guard++ < 200) {
    if (seen.has(cur)) return { kind: "dead" };
    seen.add(cur);
    const node = graph.nodes[cur];
    if (!node) return { kind: "dead" };
    if (node.type === "start") { cur = node.next; continue; }
    if (node.type === "end") return { kind: "end" };
    if (node.type === "condition") { cur = evalCondition(node, vars) ? node.whenTrue : node.whenFalse; continue; }
    // signer or approval → actionable
    return { kind: "node", node };
  }
  return { kind: "dead" };
}

/** Signer + signature-mode approval nodes need a recipient + doc block; decision approvals don't. */
export function docSignerNodes(graph: WorkflowGraph): SignNode[] {
  return Object.values(graph.nodes).filter(
    (n) => n.type === "signer" || (n.type === "approval" && n.mode === "signature")
  );
}

/** Materialise + notify the actionable node the interpreter has arrived at. */
async function materialise(requestId: string, node: SignNode): Promise<void> {
  if (node.type === "signer" || (node.type === "approval" && node.mode === "signature")) {
    // Pre-created recipient — activate + notify it.
    const recipient = await prisma.signatureRecipient.findFirst({ where: { requestId, nodeId: node.id } });
    if (recipient) await notifyRecipient(recipient.id);
    return;
  }
  if (node.type === "approval") {
    // Decision approval — create the step + notify the approver.
    const label = node.label || "Approval";
    const step = await prisma.approvalStep.create({
      data: {
        requestId, nodeId: node.id, label, mode: "decision",
        assigneeType: node.who.mode === "staff" ? "staff" : node.who.mode === "owner" ? "owner" : "role",
        assigneeUserId: node.who.userId ?? null,
        assigneeRole: node.who.role ?? null,
        assigneeName: node.who.name ?? null,
        assigneeEmail: node.who.email ?? null,
        token: newSignToken(),
      },
    });
    await logSignEvent(requestId, { type: "approval_requested", actor: "system", metadata: { label, stepId: step.id } });
    await notifyApprover(step.id);
  }
}

/**
 * Advance the workflow: look at the current node's outcome, follow the right edge,
 * and materialise the next actionable step (or complete / reject the request).
 * Called on send (currentNodeId null → start) and after every step resolves.
 */
export async function advanceWorkflow(requestId: string): Promise<void> {
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId } });
  if (!req || !req.workflowGraphJson) return;
  if (req.status === "completed" || req.status === "voided" || req.status === "rejected" || req.status === "declined") return;
  const frozen = parseFrozen(req.workflowGraphJson);
  if (!frozen) return;
  const { graph, vars } = frozen;

  // Determine the edge to follow from the current node based on its resolution.
  let fromEdge: string | undefined;
  if (!req.currentNodeId) {
    fromEdge = graph.start;
  } else {
    const cur = graph.nodes[req.currentNodeId];
    if (!cur) return;
    if (cur.type === "signer") {
      const r = await prisma.signatureRecipient.findFirst({ where: { requestId, nodeId: cur.id } });
      if (r?.status === "declined") { await rejectRequest(requestId); return; } // a declined signer rejects the request
      if (r?.status !== "signed") return; // not resolved yet
      fromEdge = cur.next;
    } else if (cur.type === "approval") {
      if (cur.mode === "signature") {
        const r = await prisma.signatureRecipient.findFirst({ where: { requestId, nodeId: cur.id } });
        if (r?.status === "declined") { fromEdge = cur.whenRejected; }
        else if (r?.status === "signed") { fromEdge = cur.whenApproved; }
        else return; // pending
      } else {
        const s = await prisma.approvalStep.findFirst({ where: { requestId, nodeId: cur.id }, orderBy: { createdAt: "desc" } });
        if (s?.status === "rejected") fromEdge = cur.whenRejected;
        else if (s?.status === "approved") fromEdge = cur.whenApproved;
        else return; // pending
      }
    } else {
      return;
    }
  }

  const next = walkToActionable(graph, fromEdge, vars);
  if (next.kind === "end") {
    await prisma.signatureRequest.update({ where: { id: requestId }, data: { currentNodeId: null } });
    await completeSignatureRequest(requestId);
    return;
  }
  if (next.kind === "dead") {
    // A rejected branch with nowhere to go → treat as rejected.
    await rejectRequest(requestId);
    return;
  }
  await prisma.signatureRequest.update({ where: { id: requestId }, data: { currentNodeId: next.node.id, status: "in_progress" } });
  await materialise(requestId, next.node);
}

async function rejectRequest(requestId: string): Promise<void> {
  await prisma.signatureRequest.update({ where: { id: requestId }, data: { status: "rejected", currentNodeId: null } });
  await logSignEvent(requestId, { type: "rejected", actor: "system" });
  await notifyCreatorRejected(requestId).catch(() => {});
}
