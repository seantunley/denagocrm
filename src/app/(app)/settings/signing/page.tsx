import { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { PageHeader } from "@/components/page-header";
import { retrySigningJob, queueEnvelopeReconciliation, setLegalHold, approveLegalDestruction, executeLegalDestruction } from "@/app/actions/signingOperations";

export const dynamic = "force-dynamic";

async function tenantOperator() {
  const user = await requirePermission("signing.manage");
  const record = await basePrisma.user.findUnique({ where: { id: user.id }, select: { tenantId: true } });
  if (!record?.tenantId) throw new Error("No active tenant");
  return { user, tenantId: record.tenantId };
}

export default async function SigningOperationsPage() {
  const { tenantId } = await tenantOperator();
  const [jobs, failures, artifacts, destruction, counts] = await Promise.all([
    basePrisma.$queryRaw<Array<{ id: string; envelopeId: string | null; jobType: string; status: string; attempts: number; lastError: string | null; updatedAt: Date }>>(Prisma.sql`
      SELECT id,"envelopeId","jobType",status,attempts,"lastError","updatedAt" FROM "SigningOutboxJob"
       WHERE "tenantId"=${tenantId} AND status IN ('dead_letter','retry') ORDER BY "updatedAt" DESC LIMIT 50
    `),
    basePrisma.$queryRaw<Array<{ id: string; title: string; status: string; failureCode: string | null; failedAt: Date | null }>>(Prisma.sql`
      SELECT id,title,status,"failureCode","failedAt" FROM "SignatureRequest"
       WHERE "tenantId"=${tenantId} AND ("failureCode" IS NOT NULL OR status='failed_manual_intervention')
       ORDER BY COALESCE("failedAt","updatedAt") DESC LIMIT 50
    `),
    basePrisma.$queryRaw<Array<{ id: string; envelopeId: string; objectRef: string; sha256: string; retentionClass: string; retainUntil: Date; legalHold: boolean; createdAt: Date }>>(Prisma.sql`
      SELECT id,"envelopeId","objectRef",sha256,"retentionClass","retainUntil","legalHold","createdAt"
        FROM "LegalArtifact" WHERE "tenantId"=${tenantId} AND "destroyedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 50
    `),
    basePrisma.$queryRaw<Array<{ id: string; artifactId: string; reason: string; status: string; requestedById: string; approvedById: string | null; requestedAt: Date }>>(Prisma.sql`
      SELECT id,"artifactId",reason,status,"requestedById","approvedById","requestedAt"
        FROM "LegalArtifactDestructionRequest" WHERE "tenantId"=${tenantId} AND status IN ('pending','approved') ORDER BY "requestedAt" DESC
    `),
    basePrisma.$queryRaw<Array<{ dead: bigint; retry: bigint; failedDelivery: bigint; integrity: bigint }>>(Prisma.sql`
      SELECT
        (SELECT count(*) FROM "SigningOutboxJob" WHERE "tenantId"=${tenantId} AND status='dead_letter')::bigint AS dead,
        (SELECT count(*) FROM "SigningOutboxJob" WHERE "tenantId"=${tenantId} AND status='retry')::bigint AS retry,
        (SELECT count(*) FROM "SigningDelivery" WHERE "tenantId"=${tenantId} AND status IN ('failed','dead_letter'))::bigint AS "failedDelivery",
        (SELECT count(*) FROM "SignatureRequest" WHERE "tenantId"=${tenantId} AND "failureCode" IS NOT NULL)::bigint AS integrity
    `),
  ]);
  const zero = BigInt(0);
  const summary = counts[0] || { dead: zero, retry: zero, failedDelivery: zero, integrity: zero };
  return <div className="space-y-8 p-6">
    <PageHeader
      title="Signing trust operations"
      description="Durable jobs, artifact integrity, legal retention and dual-control destruction."
    />
    <div className="grid gap-3 md:grid-cols-4">{[
      ["Dead letters", summary.dead], ["Jobs retrying", summary.retry], ["Failed deliveries", summary.failedDelivery], ["Integrity alerts", summary.integrity],
    ].map(([label, value]) => <div key={String(label)} className="rounded-xl border p-4"><div className="text-sm text-muted-foreground">{String(label)}</div><div className="text-2xl font-bold">{String(value)}</div></div>)}</div>

    <section><h2 className="mb-3 text-lg font-semibold">Recovery queue</h2><div className="space-y-2">{jobs.length ? jobs.map((job) => <div key={job.id} className="rounded-xl border p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><strong>{job.jobType}</strong> · {job.status} · attempt {job.attempts}<div className="text-muted-foreground">{job.lastError || "No error detail"}</div></div>
      <form action={retrySigningJob}><input type="hidden" name="jobId" value={job.id}/><button className="rounded-md border px-3 py-2">Requeue</button></form></div>
    </div>) : <p className="text-sm text-muted-foreground">No retrying or dead-letter signing jobs.</p>}</div></section>

    <section><h2 className="mb-3 text-lg font-semibold">Envelope integrity alerts</h2><div className="space-y-2">{failures.length ? failures.map((failure) => <div key={failure.id} className="rounded-xl border p-4 text-sm flex flex-wrap justify-between gap-3"><div><strong>{failure.title}</strong><div className="text-muted-foreground">{failure.status} · {failure.failureCode}</div></div><form action={queueEnvelopeReconciliation}><input type="hidden" name="envelopeId" value={failure.id}/><button className="rounded-md border px-3 py-2">Verify again</button></form></div>) : <p className="text-sm text-muted-foreground">No known envelope integrity failures.</p>}</div></section>

    <section><h2 className="mb-3 text-lg font-semibold">Immutable legal artifacts</h2><div className="space-y-2">{artifacts.map((artifact) => <div key={artifact.id} className="rounded-xl border p-4 text-sm flex flex-wrap justify-between gap-3"><div><strong>{artifact.sha256.slice(0, 20)}…</strong><div className="text-muted-foreground">{artifact.retentionClass} · retain until {artifact.retainUntil.toISOString().slice(0, 10)} · {artifact.legalHold ? "LEGAL HOLD" : "normal retention"}</div></div><form action={setLegalHold}><input type="hidden" name="artifactId" value={artifact.id}/><input type="hidden" name="hold" value={artifact.legalHold ? "false" : "true"}/><button className="rounded-md border px-3 py-2">{artifact.legalHold ? "Release hold" : "Place hold"}</button></form></div>)}</div></section>

    <section><h2 className="mb-3 text-lg font-semibold">Dual-control destruction</h2><div className="space-y-2">{destruction.length ? destruction.map((item) => <div key={item.id} className="rounded-xl border p-4 text-sm flex flex-wrap justify-between gap-3"><div><strong>{item.status}</strong> · {item.reason}<div className="text-muted-foreground">Artifact {item.artifactId}</div></div>{item.status === "pending" ? <form action={approveLegalDestruction}><input type="hidden" name="requestId" value={item.id}/><button className="rounded-md border px-3 py-2">Approve independently</button></form> : <form action={executeLegalDestruction}><input type="hidden" name="requestId" value={item.id}/><button className="rounded-md border px-3 py-2">Execute & certify</button></form>}</div>) : <p className="text-sm text-muted-foreground">No pending destruction approvals.</p>}</div></section>
  </div>;
}
