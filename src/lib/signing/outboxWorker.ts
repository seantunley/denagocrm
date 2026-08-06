import "server-only";
import { runInTenantScope } from "@/lib/tenantScope";
import { prisma } from "@/lib/db";
import { leaseSigningJobs, completeSigningJob, failSigningJob, type SigningOutboxJob } from "./outbox";
import { performSigningLinkDelivery, performCompletedDelivery } from "./delivery";
import { performApprovalDelivery } from "./approvalDelivery";
import { advanceAfterSignature } from "./workflow";
import { runPostCompletion } from "./postComplete";
import { anchorEvidence } from "./evidenceBundle";
import { reconcileEnvelope } from "./reconcile";
import { finalizeSigningCompletion } from "./finalizeCompletion";

async function handle(job: SigningOutboxJob): Promise<void> {
  switch (job.jobType) {
    case "advance_after_signature":
      if (!job.envelopeId) throw new Error("Advance job has no envelope");
      await advanceAfterSignature(job.envelopeId);
      return;
    case "deliver_signing_link":
      await performSigningLinkDelivery(job);
      return;
    case "deliver_completed":
      await performCompletedDelivery(job);
      return;
    case "deliver_approval":
      await performApprovalDelivery(job);
      return;
    case "finalize_completion":
      if (!job.envelopeId) throw new Error("Finalization job has no envelope");
      await finalizeSigningCompletion(job.envelopeId, job.id);
      return;
    case "anchor_evidence":
      if (!job.envelopeId) throw new Error("Anchor job has no envelope");
      await anchorEvidence(job.envelopeId);
      return;
    case "reconcile_envelope":
      if (!job.envelopeId) throw new Error("Reconciliation job has no envelope");
      if (!(await reconcileEnvelope(job.envelopeId)).ok) throw new Error("Envelope artifact reconciliation failed");
      return;
    case "post_complete": {
      if (!job.envelopeId) throw new Error("Post-completion job has no envelope");
      const payload = job.payload as Partial<Parameters<typeof runPostCompletion>[0]>;
      if (payload.id === job.envelopeId && typeof payload.title === "string") {
        await runPostCompletion({
          id: payload.id,
          title: payload.title,
          quoteId: payload.quoteId ?? null,
          jobCardId: payload.jobCardId ?? null,
          signedByName: payload.signedByName ?? null,
          signedPdfHash: payload.signedPdfHash ?? null,
          signedDocId: payload.signedDocId ?? null,
          sourceSigned: payload.sourceSigned === true,
          wonLeadId: payload.wonLeadId ?? null,
        });
        return;
      }
      // Historic/recovered jobs without the completion payload must not re-fire
      // source side effects. Reconciliation can repopulate the payload manually.
      const request = await prisma.signatureRequest.findUnique({ where: { id: job.envelopeId }, select: { id: true, title: true, quoteId: true, jobCardId: true, signedPdfHash: true, signedDocId: true } });
      if (!request?.signedPdfHash) throw new Error("Completed request state is incomplete");
      await runPostCompletion({ ...request, signedByName: null, sourceSigned: false, wonLeadId: null });
      return;
    }
    default:
      throw new Error(`Unknown signing outbox job: ${(job as SigningOutboxJob).jobType}`);
  }
}

export async function processSigningOutbox(options?: { limit?: number; onlyIds?: string[] }): Promise<{ leased: number; completed: number; failed: number }> {
  const jobs = await leaseSigningJobs(options?.limit ?? 20, options?.onlyIds);
  let completed = 0; let failed = 0;
  for (const job of jobs) {
    try {
      await runInTenantScope({ tenantId: job.tenantId, system: false }, () => handle(job));
      await completeSigningJob(job.id);
      completed += 1;
    } catch (error) {
      await failSigningJob(job, error);
      failed += 1;
    }
  }
  return { leased: jobs.length, completed, failed };
}
