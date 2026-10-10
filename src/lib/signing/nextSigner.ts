import "server-only";
import { prisma } from "@/lib/db";

/**
 * The next recipient who may act, in signing order. Viewers never sign, and a
 * sequential envelope only ever has one live signer — so this is the single
 * "who is up" answer the countersign, the send button and every resend key off.
 *
 * It lives here rather than beside one caller because every place that delivers
 * a signing link has to ask it, and the one that did not (the Signatures page's
 * Resend) mailed the customer their link while an approval was still pending.
 */
export async function nextSigner(requestId: string) {
  const request = await prisma.signatureRequest.findUnique({
    where: { id: requestId },
    select: { workflowGraphJson: true, currentNodeId: true },
  });
  // A workflow envelope has a live node, and recipient ORDER is not it: a graph
  // with branches pre-creates a recipient for every path, so the lowest unsigned
  // order can easily be someone on a branch the condition did not take. Ask the
  // interpreter which node it is actually sitting on.
  if (request?.workflowGraphJson) {
    if (!request.currentNodeId) return null; // not advanced yet — nobody is up
    return prisma.signatureRecipient.findFirst({
      where: {
        requestId,
        nodeId: request.currentNodeId,
        role: { not: "viewer" },
        status: { notIn: ["signed", "declined"] },
      },
    });
  }
  return prisma.signatureRecipient.findFirst({
    where: { requestId, role: { not: "viewer" }, status: { notIn: ["signed", "declined"] } },
    orderBy: { order: "asc" },
  });
}
