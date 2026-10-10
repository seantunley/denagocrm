import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { zipStore } from "../src/lib/zip";
import {
  FAILED_STEP_STATUSES,
  FINISHING_GRACE_MS,
  FOLLOW_UP_STEPS,
  allSignersSigned,
  failureInWords,
  finishingStalled,
  stuckExplanation,
  stuckHeadline,
  stuckLabel,
  stuckProgress,
  worstStep,
} from "../src/lib/signing/stuckText";
import { AUDIT_FILE, SIGNED_FILE, TIMESTAMP_FILE, evidenceReadme, eventInWords, identityInWords, type EvidenceReadme } from "../src/lib/signing/evidenceText";

/**
 * A signed document that did not finish, and the proof that one did.
 *
 * The database half is scripts/test-signing-proof.ts. This is everything that
 * can be decided without one: what a stuck request is called, what the evidence
 * pack says, that the archive it comes in is a real archive, and that the doors
 * to all of it are guarded.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function fnBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} not found — was it renamed?`);
  const end = source.indexOf("\nexport ", start + 1);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

/* ── the archive ─────────────────────────────────────────────────────────── */

/** Read a ZIP back the way an unzipper does: from the directory at the END. */
function unzip(archive: Buffer): Array<{ name: string; data: Buffer; crc: number; method: number }> {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50, "no end-of-directory record");
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  assert.equal(at + archive.readUInt32LE(end + 12), end, "the directory must run right up to its end record");
  const files = [];
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50, `directory entry ${i} is malformed`);
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.toString("utf8", at + 46, at + 46 + nameLength);
    assert.equal(archive.readUInt32LE(local), 0x04034b50, `${name}: no local header where the directory points`);
    assert.equal(archive.readUInt32LE(local + 14), crc, `${name}: the two headers disagree about the checksum`);
    assert.equal(archive.toString("utf8", local + 30, local + 30 + nameLength), name, `${name}: the two headers disagree about the name`);
    const start = local + 30 + nameLength + archive.readUInt16LE(local + 28);
    files.push({ name, data: archive.subarray(start, start + size), crc, method });
    at += 46 + nameLength;
  }
  return files;
}

test("the evidence archive is a real ZIP, and every file comes back byte for byte", () => {
  const pdf = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 31) % 256)); // every byte value, like a real PDF
  const at = new Date("2026-10-10T12:34:56Z");
  const archive = zipStore([
    { name: "README.txt", data: Buffer.from("Evidence\r\n"), modified: at },
    { name: "Signed document.pdf", data: pdf, modified: at },
    { name: "Überprüfung — 証拠.json", data: Buffer.from("{}"), modified: at },
    { name: "empty.tst", data: Buffer.alloc(0), modified: at },
  ]);
  const files = unzip(archive);
  assert.deepEqual(files.map((file) => file.name), ["README.txt", "Signed document.pdf", "Überprüfung — 証拠.json", "empty.tst"]);
  for (const file of files) {
    assert.equal(file.method, 0, `${file.name} must be stored, not compressed`);
    assert.equal(crc32(file.data), file.crc, `${file.name}: the checksum does not match its bytes`);
  }
  assert.ok(files[1].data.equals(pdf), "the sealed PDF must come back unchanged — its hash is the evidence");
  assert.deepEqual(zipStore([{ name: "a", data: pdf, modified: at }]), zipStore([{ name: "a", data: pdf, modified: at }]), "the same files must give the same archive");
  assert.equal(unzip(zipStore([])).length, 0, "an empty archive is still a valid one");
});

/* ── what "stuck" means ──────────────────────────────────────────────────── */

const signed = (minutesAgo: number, role = "signer") => ({ role, status: "signed", signedAt: new Date(Date.UTC(2026, 9, 10, 12, 0) - minutesAgo * 60_000) });
const NOW = new Date(Date.UTC(2026, 9, 10, 12, 0));

test("everyone has signed only when every SIGNER has", () => {
  assert.equal(allSignersSigned([{ role: "signer", status: "signed" }, { role: "viewer", status: "sent" }]), true);
  assert.equal(allSignersSigned([{ role: "signer", status: "signed" }, { role: "approver", status: "viewed" }]), false);
  assert.equal(allSignersSigned([{ role: "viewer", status: "sent" }]), false, "nobody to wait for is not 'all signed'");
  assert.equal(allSignersSigned([]), false);
});

test("a fully signed request is stalled once it has had time to finish — and not while it waits on a person", () => {
  const open = { status: "in_progress", closed: false, approvals: [] as Array<{ status: string }> };
  assert.equal(finishingStalled({ ...open, recipients: [signed(30), signed(20)] }, NOW), true);
  assert.equal(finishingStalled({ ...open, recipients: [signed(30), signed(1)] }, NOW), false, "it may be finishing right now");
  assert.equal(finishingStalled({ ...open, recipients: [signed(30), signed(1)] }, NOW, 0), true, "straight after a retry there is no grace");
  assert.equal(finishingStalled({ ...open, recipients: [signed(30), { role: "signer", status: "viewed", signedAt: null }] }, NOW), false);
  assert.equal(finishingStalled({ ...open, recipients: [signed(30)], approvals: [{ status: "approved" }, { status: "pending" }] }, NOW), false, "an approval is a person, not a failure");
  assert.equal(finishingStalled({ ...open, recipients: [signed(30)], approvals: [{ status: "approved" }] }, NOW), true);
  assert.equal(finishingStalled({ status: "completed", closed: true, approvals: [], recipients: [signed(30)] }, NOW), false);
  assert.ok(FINISHING_GRACE_MS >= 60_000 && FINISHING_GRACE_MS <= 10 * 60_000, "minutes: long enough to finish, short enough to notice");
});

test("a stuck request is described by what is safe and what is missing — never as a lost signature", () => {
  assert.equal(stuckHeadline("advance_signature", true), "Everyone signed, but it could not be finished");
  assert.equal(stuckHeadline("advance_signature", false), "Signed, but the next step did not run");
  assert.equal(stuckHeadline("approval_notify", false), "The approver could not be emailed");
  assert.equal(stuckLabel("advance_signature", true), "Signed — not finished");
  assert.equal(stuckLabel("approval_notify", false), "Approver not emailed");
  for (const jobType of [...FOLLOW_UP_STEPS, "something_new"]) {
    for (const everyone of [true, false]) {
      assert.match(stuckExplanation(jobType, everyone), /recorded|waiting/, `${jobType}: must say what was kept`);
      assert.doesNotMatch(stuckExplanation(jobType, everyone) + stuckHeadline(jobType, everyone), /lost|sign again|re-sign/i);
      assert.ok(stuckLabel(jobType, everyone).length <= 24, "a pill, not a sentence");
    }
  }
  assert.equal(stuckProgress({ status: "transition_retry", attempts: 1 }, "14:30"), "Tried 1 time so far. It tries again by itself — next at 14:30.");
  assert.equal(stuckProgress({ status: "dead", attempts: 12 }, "14:30"), "It was tried 12 times and has stopped trying by itself.");
});

test("a failure is told as what kind it was — the driver's own message stays in the log", () => {
  const busy = "The record was busy — something else was saving it at the same moment. This usually clears by itself.";
  assert.equal(failureInWords("\nInvalid `prisma.$executeRaw()` invocation:\n\n\nRaw query failed. Code: `55P03`. Message: `ERROR: canceling statement due to lock timeout`"), busy);
  assert.equal(failureInWords("Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction."), busy);
  assert.equal(failureInWords("No deliverable email for approval “Manager approval”"), "An email could not be sent. Check the address and the mail settings.");
  assert.equal(failureInWords("SMTP did not accept recipient abc"), "An email could not be sent. Check the address and the mail settings.");
  // Specific before general: this mentions a PDF, and is a storage failure.
  assert.equal(failureInWords("the sealed PDF could not be read: ENOENT"), "A file could not be saved or read.");
  assert.equal(failureInWords("Protocol error (Page.printToPDF): Target closed"), "The PDF could not be made.");
  assert.equal(failureInWords("fetch failed"), "It took too long, or a service it needs did not answer.");
  assert.equal(failureInWords("Cannot read properties of undefined"), "An unexpected error.");
  assert.equal(failureInWords(null), "No reason was recorded.");
  assert.equal(failureInWords("   "), "No reason was recorded.");
  for (const message of ["lock timeout", "smtp", "ENOENT", "puppeteer", "timeout", "anything"]) {
    assert.doesNotMatch(failureInWords(message), /prisma|invocation|`|\n/, "no driver text reaches the screen");
  }
  // The screen and the toast both use it; neither prints the raw message.
  assert.match(shipped("src/app/actions/signhub.ts"), /`It failed again\. \$\{failureInWords\(worst\.lastError\)\}`/);
  const detail = shipped("src/app/(app)/signatures/[id]/page.tsx");
  assert.match(detail, /What went wrong: \{failureInWords\(stuck\.step\.lastError\)\}/);
  assert.doesNotMatch(detail, /\{stuck\.step\.lastError[^)]/, "the raw message is not rendered");
});

test("with several failed steps the one shown is the one blocking the most", () => {
  const steps = [
    { jobType: "decline_notify", status: "dead" },
    { jobType: "advance_signature", status: "transition_retry" },
    { jobType: "advance_signature", status: "dead" },
  ];
  assert.deepEqual(worstStep(steps), { jobType: "advance_signature", status: "dead" });
  assert.equal(worstStep([]), null);
  assert.deepEqual([...FAILED_STEP_STATUSES], ["transition_retry", "dead"]);
});

/* ── a job whose worker died is claimable again ──────────────────────────── */

test("both workers reclaim a job left 'running' by a worker that died, and only once its lease is out", () => {
  // The lease test was always in the claim. It could never apply, because the
  // status list excluded the only state a lease is held in — so a job cut off
  // mid-run was never retried and never reported.
  const lease = String.raw`[\s\S]*?"availableAt" <= NOW\(\)\s+AND \("leaseUntil" IS NULL OR "leaseUntil" < NOW\(\)\)`;
  assert.match(shipped("src/lib/signing/transitionWorker.ts"), new RegExp(String.raw`"status" IN \('transition','transition_retry','transition_running'\)` + lease));
  assert.match(shipped("src/lib/signing/jobWorker.ts"), new RegExp(String.raw`"status" IN \('pending','retry','running'\)` + lease));
});

/* ── retry goes through the queue's own door ─────────────────────────────── */

test("Retry is the worker, under the request's own access check — not a second way to finish a document", () => {
  const body = fnBody(shipped("src/app/actions/signhub.ts"), "retryStuckSteps");
  assert.match(body, /resolveSignatureRequestAccess\(/, "capability AND record access, like every other action here");
  assert.match(body, /reviveStuckSteps\(requestId, req\.tenantId\)/, "the tenant comes from the row that passed the check");
  assert.match(body, /runSigningTransitionJobs\(req\.tenantId\)/);
  assert.doesNotMatch(body, /completeSignatureRequest|advanceAfterSignature|advanceWorkflow/, "finishing is the worker's job: its lease, its bookkeeping");
  assert.ok(body.indexOf("resolveSignatureRequestAccess(") < body.indexOf("reviveStuckSteps("), "nothing is revived before access is decided");
  assert.match(body, /finishingStalled\([\s\S]*?, 0\)/, "the outcome is read from the request afterwards, with no grace");
  assert.match(body, /logAudit\(/);
});

test("the Retry button is only offered to someone the action will accept", () => {
  const list = shipped("src/app/(app)/signatures/page.tsx");
  assert.match(list, /const canRetry = await hasPermission\(user, "signing\.manage"\)/);
  assert.match(list, /\{r\.retry && \([\s\S]*?retryStuckSteps\.bind\(null, r\.id\)/);
  const detail = shipped("src/app/(app)/signatures/[id]/page.tsx");
  assert.match(detail, /const canManage = await hasPermission\(user, "signing\.manage"\)/);
  assert.match(detail, /\{canManage && \([\s\S]*?retryStuckSteps\.bind\(null, req\.id\)/);
});

test("the list finds stuck requests by state as well as by failed job, inside the viewer's own records", () => {
  const list = shipped("src/app/(app)/signatures/page.tsx");
  const query = list.slice(list.indexOf("const needsAttention"), list.indexOf("const canRetry"));
  assert.match(query, /AND: \[mine\]/, "what needs attention is still limited to what this person may open");
  assert.match(query, /finishingStalledWhere\(\)/, "a dead worker leaves no failed job to find");
  assert.match(query, /id: \{ in: failedRequestIds \}/);
});

/* ── the evidence pack ───────────────────────────────────────────────────── */

const PACK: EvidenceReadme = {
  title: "Quote Q-2003",
  reference: "req_123",
  workspace: "Denago Cape Town",
  preparedAt: "10 Oct 2026, 14:30",
  preparedBy: "Thandi Mokoena",
  timeZone: "Africa/Johannesburg",
  sha256: "ab".repeat(32),
  fileMatches: true,
  sizeBytes: 123456,
  sealedAt: "10 Oct 2026, 14:05",
  certificate: { subject: "CN=Denago Cape Town", fingerprint: "cd".repeat(32), trusted: false },
  timestamp: { authority: "http://tsa.example", at: "10 Oct 2026, 14:05", verified: true },
  check: { at: "10 Oct 2026, 14:31", valid: true, errors: [] },
  hasAuditFile: true,
  signers: [
    { name: "Aisha Khan", role: "signer", status: "signed", signedAt: "10 Oct 2026, 14:04", ip: "203.0.113.9", identityMethod: "email_otp", identityVerifiedAt: "10 Oct 2026, 14:03", witness: null, consent: "I agree to sign electronically.", declineReason: null },
    { name: "Ben Dlamini", role: "signer", status: "signed", signedAt: "10 Oct 2026, 14:05", ip: null, identityMethod: null, identityVerifiedAt: null, witness: null, consent: null, declineReason: null },
  ],
  events: [
    { at: "10 Oct 2026, 14:00", type: "sent", actor: "Denago: Thandi", channel: "email", ip: null, delivered: true },
    { at: "10 Oct 2026, 14:00", type: "sent", actor: "Denago: Thandi", channel: "whatsapp", ip: null, delivered: false },
    { at: "10 Oct 2026, 14:04", type: "signed", actor: "Aisha Khan", channel: "web", ip: "203.0.113.9", delivered: null },
  ],
};

test("the pack's first page says what is in it, who signed, and how to check each part", () => {
  const page = evidenceReadme(PACK);
  for (const file of [SIGNED_FILE, AUDIT_FILE, TIMESTAMP_FILE, "README.txt"]) assert.ok(page.includes(file), `${file} is not described`);
  assert.match(page, new RegExp(`SHA-256 {8}${"ab".repeat(32)}`));
  assert.match(page, /They match: it has not changed\./);
  assert.match(page, /Aisha Khan \(signer\)\r\n {4}Signed 10 Oct 2026, 14:04, from IP address 203\.0\.113\.9\r\n {4}Identity checked by a one-time code sent to the email address on file \(10 Oct 2026, 14:03\)\.\r\n {4}Agreed to: "I agree to sign electronically\."/);
  assert.match(page, /Sent by email \(accepted\) — Denago: Thandi/);
  assert.match(page, /Sent by whatsapp \(FAILED\)/);
  assert.match(page, /certutil -hashfile "Signed document\.pdf" SHA256/);
  assert.match(page, new RegExp(`openssl ts -reply -in ${TIMESTAMP_FILE.replace(".", "\\.")} -token_in -text`), "the stored value is a token, so openssl needs -token_in");
  assert.match(page, /All times are Africa\/Johannesburg time\./);
  assert.match(page, /It is not legal advice\./);
  assert.doesNotMatch(page.replace(/\r\n/g, ""), /[\r\n]/, "one kind of line ending, so Notepad shows it properly");
});

test("the pack never claims more than was recorded", () => {
  // Possession of the link is said as that, not dressed up as a check.
  assert.match(evidenceReadme(PACK), /Ben Dlamini \(signer\)\r\n {4}Signed 10 Oct 2026, 14:05\r\n {4}Opened with the unique signing link sent to this person\. No further identity check was asked for\./);
  assert.equal(identityInWords({ identityMethod: "in_person", identityVerifiedAt: null, witness: "Thandi Mokoena" }), "Signed in person, in the presence of Thandi Mokoena");
  assert.equal(identityInWords({ identityMethod: "in_person", identityVerifiedAt: null, witness: null }), "Signed in person, in the presence of a member of staff");

  const altered = evidenceReadme({ ...PACK, fileMatches: false });
  assert.match(altered, /WARNING: the file in this pack does NOT match/);
  assert.doesNotMatch(altered, /They match/);

  const failedCheck = evidenceReadme({ ...PACK, check: { at: "10 Oct 2026, 14:31", valid: false, errors: ["sealed PDF hash mismatch"] } });
  assert.match(failedCheck, /FAILED: sealed PDF hash mismatch\./);

  const noStamp = evidenceReadme({ ...PACK, timestamp: null, hasAuditFile: false });
  assert.match(noStamp, /Time-stamp {5}none\./);
  assert.ok(!noStamp.includes(TIMESTAMP_FILE) && !noStamp.includes(AUDIT_FILE), "a file that is not in the pack must not be described");
  assert.doesNotMatch(noStamp, /^3\. /m, "steps are numbered for what is actually there");

  const unverified = evidenceReadme({ ...PACK, timestamp: { authority: null, at: null, verified: false } });
  assert.match(unverified, /COULD NOT BE VERIFIED/);

  // "The signer's identity is unknown" is true of the company's own certificate only.
  assert.match(evidenceReadme(PACK), /identity is unknown/);
  assert.doesNotMatch(evidenceReadme({ ...PACK, certificate: { ...PACK.certificate!, trusted: true } }), /identity is unknown/);

  const declined = evidenceReadme({ ...PACK, signers: [{ ...PACK.signers[0], status: "declined", declineReason: "Price changed" }, { ...PACK.signers[1], status: "sent" }] });
  assert.match(declined, /Declined\. Their reason: "Price changed"/);
  assert.match(declined, /Ben Dlamini \(signer\)\r\n {4}Did not sign\./);
});

test("every event is put into words, and one nobody has named yet is still shown", () => {
  for (const type of ["created", "sent", "reminded", "opened", "identity_challenge_sent", "identity_verified", "field_filled", "signed", "declined", "approval_requested", "approval_sent", "approved", "rejected", "voided", "expired", "completed", "post_completion", "completion_blocked", "recovery_attempt", "stale_claim_recovered"]) {
    assert.doesNotMatch(eventInWords(type), /_/, `${type} reads as a raw code`);
  }
  assert.equal(eventInWords("some_new_event"), "some new event");
});

/* ── the door to the pack ────────────────────────────────────────────────── */

test("the evidence pack is a staff download: signed in, permitted, and theirs to open", () => {
  const route = shipped("src/app/api/signatures/[id]/evidence/route.ts");
  const order = ["return withActingStaffScope(async () => {", "getCurrentUser()", 'hasAnyPermission(user, "signing.view", "signing.manage")', "canAccessSignatureRequest(user, req)", "buildEvidencePack("].map((needle) => {
    const at = route.indexOf(needle);
    assert.notEqual(at, -1, `${needle} is missing`);
    return at;
  });
  // The workspace is bound FIRST. A route handler has no layout above it, and the
  // permission lookup counts a role only in the workspace being acted in — with
  // no workspace it found no roles and answered Forbidden to every non-owner.
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the workspace is bound before the checks, and nothing is read from storage before all three");
  assert.match(route, /!req \|\| req\.deletedAt \|\| !\(await canAccessSignatureRequest\(user, req\)\)[\s\S]*?"Not found"/, "missing and not-yours answer the same");
  assert.match(route, /req\.status !== "completed"/);
  assert.match(route, /logAudit\(\{\s*action: "signing\.evidence_exported"/);
  assert.match(route, /"Cache-Control": "private, no-store"/);

  // /api/signing is public to the proxy (the signers' tokened routes). This must not sit under it.
  const proxy = shipped("src/proxy.ts");
  const publicPaths = [...proxy.slice(proxy.indexOf("const PUBLIC_PATHS"), proxy.indexOf("];", proxy.indexOf("const PUBLIC_PATHS"))).matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]);
  assert.ok(publicPaths.includes("/api/signing"), "the test is reading the real list");
  const target = "/api/signatures/abc/evidence";
  assert.deepEqual(publicPaths.filter((p) => target === p || target.startsWith(`${p}/`)), [], "the evidence route must stay behind a session");
});

test("the pack re-hashes the file it is about to hand over", () => {
  const source = shipped("src/lib/signing/evidence.ts");
  assert.match(source, /fileMatches: Boolean\(evidence\.sha256\) && crypto\.createHash\("sha256"\)\.update\(pdf\)\.digest\("hex"\) === evidence\.sha256/);
  assert.match(source, /readFile\(req\.signedPdfRef, req\.tenantId\)/, "the stored object must belong to the request's own workspace");
  assert.match(source, /verifyTimestampToken\(req\.timestampToken, Buffer\.from\(sha256, "hex"\)\)/, "'verified' is checked now, not read from a column");
});
