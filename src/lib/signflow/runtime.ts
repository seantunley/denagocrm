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
import { CLOSED_REQUEST_STATUSES, isRequestClosed } from "@/lib/signing/status";

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

/**
 * Materialise + notify the actionable node the interpreter has arrived at.
 *
 * `notify: false` advances the graph WITHOUT contacting anyone. The record's
 * signature card now shows the countersigned document before it goes out, and
 * the interpreter's own notification pre-empted that — the customer received
 * their signing link while the sender was still looking at the review screen.
 * The explicit send notifies whoever the graph has arrived at.
 */
async function materialise(requestId: string, node: SignNode, notify: boolean): Promise<void> {
  if (node.type === "signer" || (node.type === "approval" && node.mode === "signature")) {
    // Pre-created recipient — activate + notify it.
    if (!notify) return;
    const recipient = await prisma.signatureRecipient.findFirst({ where: { requestId, nodeId: node.id } });
    if (recipient) await notifyRecipient(recipient.id);
    return;
  }
  if (node.type === "approval") {
    // Re-check the parent request is still open — a void/decline could have closed
    // it between the transition claim and here, and we must not create + notify an
    // approval step for a dead request.
    const parent = await prisma.signatureRequest.findUnique({ where: { id: requestId }, select: { status: true } });
    if (!parent || isRequestClosed(parent.status)) return;
    // Decision approval — materialise the step IDEMPOTENTLY. advanceWorkflow can
    // run concurrently (e.g. two signing-start repairs), and advanceWorkflow()
    // isn't itself serialized, so create the step via createMany + skipDuplicates
    // against the @@unique([requestId, nodeId]) constraint: exactly one row (one
    // token) is ever created for a node. Only the call that actually inserted it
    // logs + notifies, so no duplicate approver emails / tokens either.
    const label = node.label || "Approval";
    const created = await prisma.approvalStep.createMany({
      data: [{
        requestId, nodeId: node.id, label, mode: "decision",
        assigneeType: node.who.mode === "staff" ? "staff" : node.who.mode === "owner" ? "owner" : "role",
        assigneeUserId: node.who.userId ?? null,
        assigneeRole: node.who.role ?? null,
        assigneeName: node.who.name ?? null,
        assigneeEmail: node.who.email ?? null,
        token: newSignToken(),
      }],
      skipDuplicates: true,
    });
    if (created.count === 0) return; // another advance already materialised + notified this node
    const step = await prisma.approvalStep.findFirst({ where: { requestId, nodeId: node.id } });
    if (!step) return;
    await logSignEvent(requestId, { type: "approval_requested", actor: "system", metadata: { label, stepId: step.id } });
    await notifyApprover(step.id);
  }
}

/**
 * Advance the workflow: look at the current node's outcome, follow the right edge,
 * and materialise the next actionable step (or complete / reject the request).
 * Called on send (currentNodeId null → start) and after every step resolves.
 */
export async function advanceWorkflow(
  requestId: string,
  opts?: { notify?: boolean },
): Promise<void> {
  const notify = opts?.notify ?? true;
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId } });
  if (!req || !req.workflowGraphJson) return;
  if (isRequestClosed(req.status)) return;
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
    // When the current node is NOT yet resolved we re-materialise it (idempotently)
    // rather than bailing, so a crash between the transition commit and the first
    // materialise() self-heals: a decision node with no ApprovalStep gets one, a
    // signer that was never notified gets notified. materialise() is a no-op once
    // the node is already materialised.
    if (cur.type === "signer") {
      const r = await prisma.signatureRecipient.findFirst({ where: { requestId, nodeId: cur.id } });
      if (r?.status === "declined") { await rejectRequest(requestId); return; } // a declined signer rejects the request
      if (r?.status !== "signed") { await materialise(requestId, cur, notify); return; } // not resolved yet — heal
      fromEdge = cur.next;
    } else if (cur.type === "approval") {
      if (cur.mode === "signature") {
        const r = await prisma.signatureRecipient.findFirst({ where: { requestId, nodeId: cur.id } });
        if (r?.status === "declined") { fromEdge = cur.whenRejected; }
        else if (r?.status === "signed") { fromEdge = cur.whenApproved; }
        else { await materialise(requestId, cur, notify); return; } // pending — heal
      } else {
        const s = await prisma.approvalStep.findFirst({ where: { requestId, nodeId: cur.id }, orderBy: { createdAt: "desc" } });
        if (s?.status === "rejected") fromEdge = cur.whenRejected;
        else if (s?.status === "approved") fromEdge = cur.whenApproved;
        else { await materialise(requestId, cur, notify); return; } // pending or never materialised — heal
      }
    } else {
      return;
    }
  }

  const next = walkToActionable(graph, fromEdge, vars);
  if (next.kind === "end") {
    // completeSignatureRequest atomically claims completion (status NOT IN closed,
    // count === 1), so two concurrent advances reaching the end can't both
    // complete. currentNodeId is deliberately left as-is: nulling it would read as
    // "start" and let a third advance re-enter from the beginning before
    // completion flips the status.
    await completeSignatureRequest(requestId);
    return;
  }
  if (next.kind === "dead") {
    // A rejected branch with nowhere to go → treat as rejected.
    await rejectRequest(requestId);
    return;
  }
  // ATOMICALLY claim the transition FROM the node we observed to the next node.
  // advanceWorkflow isn't otherwise serialized (concurrent signing-start repairs
  // can both call it), so only the caller that wins this conditional move (from
  // this exact currentNodeId, request still open) materialises + notifies — the
  // others no-op. This prevents duplicate signing-link notifications, and the
  // status guard drops the advance if a concurrent void/decline closed the
  // request between our read and the claim.
  const claimed = await prisma.signatureRequest.updateMany({
    where: { id: requestId, currentNodeId: req.currentNodeId, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
    data: { currentNodeId: next.node.id, status: "in_progress" },
  });
  if (claimed.count !== 1) return;
  await materialise(requestId, next.node, notify);
}

/**
 * Idempotently heal a workflow request on the next signing-start. advanceWorkflow
 * is now fully self-healing, so this just re-runs the interpreter, which covers
 * EVERY crash point:
 *   - currentNodeId null                → advance from the start;
 *   - current node RESOLVED, not advanced (crash before advanceWorkflow ran) →
 *     advance past it;
 *   - current node PENDING, not materialised (crash before materialise ran) →
 *     re-materialise it.
 * All idempotent (createMany skipDuplicates for approvals; notifyRecipient's
 * at-most-once claim for signers; conditional currentNodeId claim for advances).
 * A no-op on a non-workflow or closed request.
 */
export async function repairWorkflow(
  requestId: string,
  opts?: { notify?: boolean },
): Promise<void> {
  await advanceWorkflow(requestId, opts);
}

async function rejectRequest(requestId: string): Promise<void> {
  // Conditional: only reject a still-open request, so a concurrent void (which
  // committed "voided" between advanceWorkflow's read and here) isn't overwritten
  // back to "rejected".
  const claimed = await prisma.signatureRequest.updateMany({
    where: { id: requestId, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
    data: { status: "rejected", currentNodeId: null },
  });
  if (claimed.count !== 1) return;
  await logSignEvent(requestId, { type: "rejected", actor: "system" });
  await notifyCreatorRejected(requestId).catch(() => {});
}
