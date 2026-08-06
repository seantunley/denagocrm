import "server-only";
import { prisma } from "@/lib/db";
import { queueSigningLinkDeliveries, signUrl } from "./delivery";
import { logSignEvent } from "./events";
import { CLOSED_REQUEST_STATUSES, isRequestClosed } from "./status";
export { signUrl };

export interface NotifyOutcome { reachable: boolean; delivered: boolean }
export interface DispatchResult { targeted: number; notified: number; unreachable: number }

export async function notifyRecipient(recipientId: string, opts?: { reminder?: boolean }): Promise<NotifyOutcome> {
  const recipient = await prisma.signatureRecipient.findUnique({ where: { id: recipientId }, include: { request: true } });
  if (!recipient || recipient.role === "viewer" || isRequestClosed(recipient.request.status) || ["signed", "declined"].includes(recipient.status)) {
    return { reachable: false, delivered: false };
  }
  if (recipient.request.workflowGraphJson && (!recipient.nodeId || recipient.nodeId !== recipient.request.currentNodeId)) {
    return { reachable: false, delivered: false };
  }
  if (!opts?.reminder) {
    const claim = await prisma.signatureRecipient.updateMany({ where: { id: recipientId, status: "pending" }, data: { status: "sending", sendingAt: new Date() } });
    if (claim.count !== 1 && !["sending", "sent", "viewed"].includes(recipient.status)) return { reachable: true, delivered: false };
  }
  const queued = await queueSigningLinkDeliveries(recipientId, Boolean(opts?.reminder));
  if (!queued.reachable) {
    await prisma.signatureRecipient.updateMany({ where: { id: recipientId, status: "sending" }, data: { status: "pending", sendingAt: null } });
    return { reachable: false, delivered: false };
  }
  // An idempotency conflict means another caller already created or processed the
  // same delivery. Never turn an empty target list into a global worker sweep.
  if (queued.jobIds.length === 0) return { reachable: true, delivered: ["sent", "viewed"].includes(recipient.status) };
  const { processSigningOutbox } = await import("./outboxWorker");
  const result = await processSigningOutbox({ onlyIds: queued.jobIds, limit: queued.jobIds.length });
  const delivered = result.completed > 0;
  if (!delivered && !opts?.reminder) {
    await prisma.signatureRecipient.updateMany({ where: { id: recipientId, status: "sending" }, data: { status: "pending", sendingAt: null } });
  }
  return { reachable: true, delivered };
}

export async function dispatchRequest(requestId: string, opts?: { reminder?: boolean }): Promise<DispatchResult> {
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId }, include: { recipients: { orderBy: { order: "asc" } } } });
  if (!req || isRequestClosed(req.status)) return { targeted: 0, notified: 0, unreachable: 0 };
  if (!opts?.reminder) {
    const claim = await prisma.signatureRequest.updateMany({
      where: { id: requestId, status: { notIn: [...CLOSED_REQUEST_STATUSES, "sent", "viewed", "in_progress", "active"] } },
      data: { status: "dispatching" },
    });
    if (claim.count !== 1) return { targeted: 0, notified: 0, unreachable: 0 };
  }
  const signers = req.recipients.filter((recipient) => recipient.role !== "viewer" && !["signed", "declined"].includes(recipient.status));
  const targets = req.workflowGraphJson
    ? signers.filter((recipient) => recipient.nodeId && recipient.nodeId === req.currentNodeId).slice(0, 1)
    : req.ordering === "sequential" ? signers.slice(0, 1) : signers;
  let notified = 0; let unreachable = 0;
  for (const target of targets) {
    const outcome = await notifyRecipient(target.id, { reminder: opts?.reminder });
    if (!outcome.reachable) unreachable += 1;
    else if (outcome.delivered) notified += 1;
  }
  if (!opts?.reminder) {
    await prisma.signatureRequest.updateMany({
      where: { id: requestId, status: "dispatching" },
      data: notified > 0 ? { status: "active", sentAt: req.sentAt ?? new Date() } : { status: "prepared" },
    });
  }
  return { targeted: targets.length, notified, unreachable };
}

const STALE_SENDING_MINUTES = 10;
export async function recoverStaleSigningClaims(): Promise<{ requests: number; recipients: number }> {
  const staleBefore = new Date(Date.now() - STALE_SENDING_MINUTES * 60_000);
  const requests = await prisma.signatureRequest.updateMany({ where: { status: "dispatching", updatedAt: { lt: staleBefore } }, data: { status: "prepared" } });
  const rows = await prisma.signatureRecipient.findMany({ where: { status: "sending", sendingAt: { lt: staleBefore } }, select: { id: true, requestId: true } });
  let recipients = 0;
  for (const row of rows) {
    const update = await prisma.signatureRecipient.updateMany({ where: { id: row.id, status: "sending" }, data: { status: "pending", sendingAt: null } });
    if (update.count) { recipients += 1; await logSignEvent(row.requestId, { type: "stale_claim_recovered", recipientId: row.id, actor: "system" }); }
  }
  return { requests: requests.count, recipients };
}

export async function notifyNextInSequence(requestId: string): Promise<void> {
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId }, include: { recipients: { orderBy: { order: "asc" } } } });
  if (!req || req.ordering !== "sequential" || req.workflowGraphJson || isRequestClosed(req.status)) return;
  const next = req.recipients.find((recipient) => recipient.role !== "viewer" && !["signed", "declined"].includes(recipient.status));
  if (next) await notifyRecipient(next.id, { reminder: ["sent", "viewed"].includes(next.status) && !next.viewedAt });
}
