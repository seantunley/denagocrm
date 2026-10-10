/**
 * A SIGNED DOCUMENT THAT DID NOT FINISH — found, retried and proved, against a
 * real database.
 *
 * Three things here cannot be read off the source:
 *
 *   1. Whether a job whose worker died is ever picked up again. The claim is one
 *      SQL statement with a lease test in it; whether the lease test can ever
 *      apply depends on which statuses the statement considers.
 *   2. Whether the two ways of asking "is this request stalled?" — the `where`
 *      the list uses and the function the request page uses — give the same
 *      answer. They are written separately and must not drift.
 *   3. Whether the evidence shown for a completed document is that document's,
 *      under tenant enforcement, through the guarded client.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database. It works in
 * a workspace of its own, so running the workers here touches nobody else's
 * jobs. Signing evidence is append-only, so its rows stay behind in the
 * disposable database; every id is unique to the run.
 */
import crypto from "crypto";
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { newSignCapability } from "../src/lib/signing/tokenVault";
import { runSigningTransitionJobs } from "../src/lib/signing/transitionWorker";
import { runSigningJobs } from "../src/lib/signing/jobWorker";
import { finishingStalledWhere, reviveStuckSteps, stuckSteps } from "../src/lib/signing/stuck";
import { FINISHING_GRACE_MS, finishingStalled } from "../src/lib/signing/stuckText";
import { loadEvidence } from "../src/lib/signing/evidence";
import { isRequestClosed } from "../src/lib/signing/status";
import { buildSignEvent } from "../src/lib/signing/events";
import { COMPLETION_BLOCKED_EVENT } from "../src/lib/signing/complete";
import { prisma } from "../src/lib/db";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
  }
}

const MINUTE = 60_000;

async function main() {
  guardEnvironment();
  // The mode production runs in: the guarded client scopes by workspace.
  __setTenantEnforcingForTests(true);

  const staff = await basePrisma.user.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!staff) throw new Error("the seeded admin is missing — run the seed first");
  const tenantId = `tenant_proof_${SFX}`;
  await basePrisma.tenant.create({ data: { id: tenantId, name: `Proof test ${SFX}`, slug: tenantId } });
  const asTenant = <T>(fn: () => Promise<T>) => runInTenantScope({ tenantId, system: false }, fn);
  const asStranger = <T>(fn: () => Promise<T>) => runInTenantScope({ tenantId: `${tenantId}_other`, system: false }, fn);

  type Signer = { status: string; signedMinutesAgo?: number; role?: string };
  /** A request with its signers, written directly: only the state under test matters here. */
  async function request(opts: { status: string; signers: Signer[] }) {
    const created = await basePrisma.signatureRequest.create({
      data: { title: `Proof test ${SFX}`, tenantId, status: opts.status, identityMode: "link", ordering: "parallel", sentAt: new Date(), createdById: staff!.id },
    });
    for (const [index, signer] of opts.signers.entries()) {
      const capability = newSignCapability();
      await basePrisma.signatureRecipient.create({
        data: {
          requestId: created.id, tenantId, name: `Signer ${index + 1}`, role: signer.role ?? "signer", order: index, status: signer.status,
          signedAt: signer.status === "signed" ? new Date(Date.now() - (signer.signedMinutesAgo ?? 30) * MINUTE) : null,
          token: capability.digest, tokenCiphertext: capability.ciphertext,
        },
      });
    }
    return created.id;
  }
  let jobSeq = 0;
  /** A queue row in a chosen state — the states a failure or a dead worker leaves behind. */
  async function job(requestId: string, jobType: string, status: string, extra: { lastError?: string | null; leaseMinutes?: number | null; attempts?: number; payload?: object } = {}) {
    const id = `sj_proof_${SFX}_${jobSeq++}`;
    const lease = extra.leaseMinutes == null ? null : new Date(Date.now() + extra.leaseMinutes * MINUTE);
    await basePrisma.$executeRaw`
      INSERT INTO "SigningJob" ("id","tenantId","requestId","jobType","idempotencyKey","payload","status","attempts","availableAt","leaseUntil","leaseOwner","lastError")
      VALUES (${id}, ${tenantId}, ${requestId}, ${jobType}, ${id}, ${JSON.stringify(extra.payload ?? {})}::jsonb, ${status}, ${extra.attempts ?? 1},
              NOW() - INTERVAL '1 minute', ${lease}, ${lease ? "a-worker-that-died" : null}, ${extra.lastError ?? null})
    `;
    return id;
  }
  const jobRow = async (id: string) =>
    (await basePrisma.$queryRaw<Array<{ status: string; attempts: number; availableAt: Date; leaseUntil: Date | null }>>`
      SELECT "status","attempts","availableAt","leaseUntil" FROM "SigningJob" WHERE "id" = ${id} AND "tenantId" = ${tenantId}`)[0];

  console.log("\n== a job whose worker died is picked up again");
  const waiting = await request({ status: "sent", signers: [{ status: "signed" }, { status: "sent" }] });
  const orphan = await job(waiting, "advance_signature", "transition_running", { leaseMinutes: -5 });
  const live = await job(await request({ status: "sent", signers: [{ status: "signed" }, { status: "sent" }] }), "advance_signature", "transition_running", { leaseMinutes: 8 });
  const firstRun = await runSigningTransitionJobs(tenantId);
  check("the worker claims the job whose lease ran out", firstRun.claimed === 1, JSON.stringify(firstRun));
  const orphanAfter = await jobRow(orphan);
  check("…and finishes it", orphanAfter.status === "completed" && orphanAfter.attempts === 2, JSON.stringify(orphanAfter));
  check("…moving the request on", (await basePrisma.signatureRequest.findUnique({ where: { id: waiting }, select: { status: true } }))?.status === "in_progress");
  check("a job another worker is still running is left alone", (await jobRow(live)).status === "transition_running" && (await jobRow(live)).attempts === 1);

  const unaddressed = await request({ status: "sent", signers: [{ status: "sent" }] });
  await basePrisma.signatureRequest.update({ where: { id: unaddressed }, data: { status: "completed", completedAt: new Date(), signedPdfRef: `proof-${SFX}.pdf`, signedPdfHash: "ab".repeat(32) } });
  // The completion trigger queued this request's own jobs; park them so only the two under test are due.
  await basePrisma.$executeRaw`UPDATE "SigningJob" SET "availableAt" = NOW() + INTERVAL '1 day' WHERE "tenantId" = ${tenantId} AND "requestId" = ${unaddressed}`;
  const [someone] = await basePrisma.signatureRecipient.findMany({ where: { requestId: unaddressed }, select: { id: true } });
  const orphanCopy = await job(unaddressed, "completion_email", "running", { leaseMinutes: -5, payload: { recipientId: someone.id } });
  const liveCopy = await job(unaddressed, "completion_email", "running", { leaseMinutes: 8, payload: { recipientId: someone.id } });
  const secondRun = await runSigningJobs(tenantId);
  check("the completion worker does the same", secondRun.claimed === 1 && (await jobRow(orphanCopy)).status === "completed", JSON.stringify(secondRun));
  check("…and leaves a live one alone", (await jobRow(liveCopy)).status === "running");

  console.log("\n== failed follow-up steps");
  const stuckRequest = await request({ status: "in_progress", signers: [{ status: "signed" }, { status: "signed" }] });
  const failing = await job(stuckRequest, "advance_signature", "transition_retry", { lastError: "PDF renderer timed out", attempts: 3 });
  const gaveUp = await job(await request({ status: "sent", signers: [{ status: "sent" }] }), "approval_notify", "dead", { lastError: "No deliverable email", attempts: 12 });
  const waitedItsTurn = await job(await request({ status: "sent", signers: [{ status: "sent" }] }), "advance_signature", "transition_retry", { lastError: null });
  const done = await job(await request({ status: "sent", signers: [{ status: "sent" }] }), "advance_signature", "completed", { lastError: null });
  const otherQueue = await job(unaddressed, "post_completion", "dead", { lastError: "automation failed" });
  // `job` back-dates availableAt by a minute; push these out so "due now" below is the revive's doing.
  await basePrisma.$executeRaw`UPDATE "SigningJob" SET "availableAt" = NOW() + INTERVAL '6 hours' WHERE "id" IN (${failing}, ${gaveUp}, ${waitedItsTurn}) AND "tenantId" = ${tenantId}`;

  const listed = await asTenant(() => stuckSteps());
  const listedTypes = listed.map((step) => `${step.jobType}:${step.status}`).sort();
  check("a step that failed and one the queue gave up on are both listed", listedTypes.join(",") === "advance_signature:transition_retry,approval_notify:dead", listedTypes.join(","));
  check("…with how often they were tried and what was reported", listed.find((step) => step.requestId === stuckRequest)?.attempts === 3 && listed.find((step) => step.requestId === stuckRequest)?.lastError === "PDF renderer timed out");
  // Five jobs were planted (waitedItsTurn, done and otherQueue among them); exactly the two failures come back.
  check("a step that only waited its turn, a finished one and the other queue's are not", listed.length === 2 && [waitedItsTurn, done, otherQueue].every(Boolean));
  check("asking for one request returns only its steps", (await asTenant(() => stuckSteps([stuckRequest]))).length === 1);
  check("asking for no requests returns none without querying", (await asTenant(() => stuckSteps([]))).length === 0);
  check("another workspace sees none of them", (await asStranger(() => stuckSteps())).length === 0);

  check("another workspace cannot revive them", (await asStranger(() => reviveStuckSteps(stuckRequest, `${tenantId}_other`))) === 0 && (await jobRow(failing)).availableAt.getTime() > Date.now() + 5 * 60 * MINUTE);
  const revived = await asTenant(() => reviveStuckSteps(stuckRequest, tenantId));
  const failingAfter = await jobRow(failing);
  check("reviving makes the request's failed step due now", revived === 1 && failingAfter.status === "transition_retry" && failingAfter.availableAt.getTime() <= Date.now() + 1000, JSON.stringify(failingAfter));
  check("…and only that request's", (await jobRow(gaveUp)).status === "dead" && (await jobRow(gaveUp)).availableAt.getTime() > Date.now() + 5 * 60 * MINUTE);
  const [deadRequest] = await basePrisma.$queryRaw<Array<{ requestId: string }>>`SELECT "requestId" FROM "SigningJob" WHERE "id" = ${gaveUp} AND "tenantId" = ${tenantId}`;
  check("a step the queue gave up on can be revived too", (await asTenant(() => reviveStuckSteps(deadRequest.requestId, tenantId))) === 1 && (await jobRow(gaveUp)).status === "transition_retry");
  // Park them again: the remaining sections are not about these jobs.
  await basePrisma.$executeRaw`UPDATE "SigningJob" SET "status" = 'completed', "lastError" = NULL WHERE "id" IN (${failing}, ${gaveUp}) AND "tenantId" = ${tenantId}`;

  console.log("\n== the list and the page agree on what is stalled");
  const fixtures: Array<{ name: string; id: string; expect: boolean }> = [
    { name: "everyone signed half an hour ago, still open", expect: true, id: await request({ status: "in_progress", signers: [{ status: "signed" }, { status: "signed" }] }) },
    { name: "a viewer does not have to sign", expect: true, id: await request({ status: "in_progress", signers: [{ status: "signed" }, { status: "sent", role: "viewer" }] }) },
    { name: "the last signature was a minute ago — it is finishing", expect: false, id: await request({ status: "in_progress", signers: [{ status: "signed" }, { status: "signed", signedMinutesAgo: 1 }] }) },
    { name: "somebody has not signed", expect: false, id: await request({ status: "in_progress", signers: [{ status: "signed" }, { status: "viewed" }] }) },
    { name: "only viewers — nobody to wait for", expect: false, id: await request({ status: "sent", signers: [{ status: "sent", role: "viewer" }] }) },
    { name: "already completed", expect: false, id: await request({ status: "completed", signers: [{ status: "signed" }] }) },
    { name: "voided after signing", expect: false, id: await request({ status: "voided", signers: [{ status: "signed" }] }) },
  ];
  const awaitingApproval = await request({ status: "in_progress", signers: [{ status: "signed" }] });
  await basePrisma.approvalStep.create({
    data: { requestId: awaitingApproval, tenantId, nodeId: "gate", label: "Manager approval", assigneeType: "owner", token: newSignCapability().digest, status: "pending" },
  });
  fixtures.push({ name: "everyone signed, but an approval is pending — it waits on a person", expect: false, id: awaitingApproval });
  const blocked = await request({ status: "in_progress", signers: [{ status: "signed" }] });
  await basePrisma.signatureEvent.create({ data: { ...buildSignEvent(blocked, { type: COMPLETION_BLOCKED_EVENT, actor: "system" }), tenantId } });

  const now = new Date();
  // Awaited INSIDE the scope: a Prisma query runs when it is awaited, not when it is built.
  const fromList = new Set(
    (
      await asTenant(async () =>
        await prisma.signatureRequest.findMany({ where: { id: { in: [...fixtures.map((f) => f.id), blocked] }, ...finishingStalledWhere(now) }, select: { id: true } }),
      )
    ).map((row) => row.id),
  );
  for (const fixture of fixtures) {
    const row = await basePrisma.signatureRequest.findUnique({
      where: { id: fixture.id },
      select: { status: true, recipients: { select: { role: true, status: true, signedAt: true } }, approvals: { select: { status: true } } },
    });
    const fromPage = finishingStalled({ ...row!, closed: isRequestClosed(row!.status) }, now);
    check(`${fixture.name}: ${fixture.expect ? "stalled" : "not stalled"}`, fromList.has(fixture.id) === fixture.expect && fromPage === fixture.expect, `list ${fromList.has(fixture.id)}, page ${fromPage}`);
  }
  check("one completion already reported as blocked is left to that report", !fromList.has(blocked));
  check("the grace period is minutes, not hours", FINISHING_GRACE_MS >= MINUTE && FINISHING_GRACE_MS <= 10 * MINUTE);

  console.log("\n== evidence for a completed document");
  const sealedHash = crypto.createHash("sha256").update(`sealed-${SFX}`).digest("hex");
  const complete = await request({ status: "in_progress", signers: [{ status: "signed" }] });
  const completedAt = new Date();
  await basePrisma.signatureRequest.update({ where: { id: complete }, data: { status: "completed", completedAt, signedPdfRef: `sealed-${SFX}.pdf`, signedPdfHash: sealedHash } });
  const evidenceRequest = { id: complete, signedPdfHash: sealedHash, completedAt, timestampToken: null, timestampedAt: null, timestampAuthority: null };

  const before = await asTenant(() => loadEvidence(evidenceRequest));
  check("before the first check there is a fingerprint and nothing is claimed about the rest", before.sha256 === sealedHash && before.check === null && before.certificate === null && before.timestamp === null);
  check("the custody record says how long it is kept", Boolean(before.retainUntil) && before.retainUntil!.getFullYear() >= completedAt.getFullYear() + 6);

  const [artifact] = await basePrisma.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "LegalArtifact" WHERE "requestId" = ${complete} AND "tenantId" = ${tenantId}`;
  const validate = async (valid: boolean, errors: string[], chainVerified: boolean) => {
    const manifest = {
      certificate: { subject: "CN=Proof Test Seal, O=Proof Test", issuer: "CN=Proof Test Seal", fingerprintSha256: "cd".repeat(32), trusted: false },
      evidence: { chainLength: 7, chainVerified },
    };
    await basePrisma.$executeRaw`
      INSERT INTO "LegalArtifactValidation" ("id","tenantId","artifactId","observedSha256","manifestHash","manifest","valid","errors","createdAt")
      VALUES (${`lav_proof_${SFX}_${valid}`}, ${tenantId}, ${artifact.id}, ${sealedHash}, ${"ef".repeat(32)}, ${JSON.stringify(manifest)}::jsonb, ${valid}, ${JSON.stringify(errors)}::jsonb, ${valid ? new Date(Date.now() - MINUTE) : new Date()})
    `;
  };
  await validate(true, [], true);
  const checked = await asTenant(() => loadEvidence(evidenceRequest));
  check("after a check: who sealed it, and that file, seal and trail verified", checked.certificate?.name === "Proof Test Seal" && checked.certificate.fingerprint === "cd".repeat(32) && checked.certificate.trusted === false && checked.check?.valid === true && checked.check.chainLength === 7 && checked.check.chainVerified === true, JSON.stringify(checked.check));
  await validate(false, ["sealed PDF hash mismatch"], false);
  const failedCheck = await asTenant(() => loadEvidence(evidenceRequest));
  check("the LATEST check is the one shown, and a failed one says why", failedCheck.check?.valid === false && failedCheck.check.errors.join() === "sealed PDF hash mismatch" && failedCheck.check.chainVerified === false, JSON.stringify(failedCheck.check));
  const stranger = await asStranger(() => loadEvidence(evidenceRequest));
  check("another workspace reads none of it", stranger.check === null && stranger.certificate === null && stranger.retainUntil === null);
  const forged = await asTenant(() => loadEvidence({ ...evidenceRequest, timestampToken: Buffer.from("not a token").toString("base64"), timestampedAt: completedAt, timestampAuthority: "http://tsa.example.test" }));
  check("a time-stamp that does not verify is shown as unverified, never as proof", forged.timestamp?.verified === false);

  console.log(`\n${passed} passed, ${failed} failed`);
  await basePrisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await basePrisma.$disconnect().catch(() => {});
  process.exit(1);
});
