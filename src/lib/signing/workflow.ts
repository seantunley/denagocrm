import "server-only";
import { prisma } from "@/lib/db";
import { completeSignatureRequest } from "./complete";
import { notifyNextInSequence } from "./dispatch";
import { advanceWorkflow } from "@/lib/signflow/runtime";

/** Called after a recipient signs: complete the request if everyone's done, else advance. */
export async function advanceAfterSignature(requestId: string): Promise<void> {
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId }, include: { recipients: true } });
  // Never advance a closed request. If a void/decline landed after the signer's
  // claim committed, this stops it short of completeSignatureRequest().
  if (!req || req.status === "completed" || req.status === "voided" || req.status === "declined") return;
  // Interpreter-driven workflows (approvals / branches) advance node-by-node.
  if (req.workflowGraphJson) { await advanceWorkflow(requestId); return; }
  const signers = req.recipients.filter((r) => r.role !== "viewer");
  const allSigned = signers.length > 0 && signers.every((r) => r.status === "signed");
  if (allSigned) { await completeSignatureRequest(requestId); return; }
  await prisma.signatureRequest.updateMany({ where: { id: requestId, status: { in: ["sent", "viewed"] } }, data: { status: "in_progress" } });
  if (req.ordering === "sequential") await notifyNextInSequence(requestId);
}
