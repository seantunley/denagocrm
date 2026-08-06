import "server-only";
import { prisma } from "@/lib/db";
import { completeSignatureRequest } from "./complete";
import { notifyNextInSequence } from "./dispatch";
import { isRequestClosed } from "./status";
import { advanceWorkflow } from "@/lib/signflow/runtime";

/** Called after a signer commits. A DB trigger also enqueues this operation in the
 * same transaction, so a process death between commit and this call is recoverable. */
export async function advanceAfterSignature(requestId: string): Promise<void> {
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId }, include: { recipients: true } });
  if (!req || isRequestClosed(req.status)) return;
  if (req.status === "signatures_complete") { await completeSignatureRequest(requestId); return; }
  if (["rendering", "sealed", "distributing"].includes(req.status)) return;
  if (req.workflowGraphJson) { await advanceWorkflow(requestId); return; }
  const signers = req.recipients.filter((recipient) => recipient.role !== "viewer");
  const allSigned = signers.length > 0 && signers.every((recipient) => recipient.status === "signed");
  if (allSigned) {
    await prisma.signatureRequest.updateMany({
      where: { id: requestId, status: { in: ["prepared", "dispatching", "active", "sent", "viewed", "signing"] } },
      data: { status: "signatures_complete" },
    });
    await completeSignatureRequest(requestId);
    return;
  }
  await prisma.signatureRequest.updateMany({
    where: { id: requestId, status: { in: ["sent", "viewed", "active"] } },
    data: { status: "signing" },
  });
  if (req.ordering === "sequential") await notifyNextInSequence(requestId);
}
