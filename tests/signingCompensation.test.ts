import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { signedPdfIsUnreferenced } from "../src/lib/signing/compensate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
/** Source with comments stripped — a naive regex otherwise matches the very
 *  comment that documents the fix. */
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * Quote Q-1010, production, 2026-08-04: the completion transaction COMMITTED and
 * the sealed PDF was deleted anyway, because the compensating delete treated a
 * thrown error as proof of rollback. The request read `completed`, the Document
 * row was intact with sizeBytes written from inside the transaction, and the
 * blob 404'd. See SIGNING-PDF-LOSS-INCIDENT.md.
 *
 * These tests hold both halves of that incident closed: the blob is not deleted
 * under a committed row, and a completion that commits without fanning out can
 * still be found and re-driven.
 */

const BLOB = "https://store.example/uploads/abc.pdf";

/* ── the delete decision ───────────────────────────────────────────────── */

test("a committed row keeps its blob — the Q-1010 regression", async () => {
  // Exactly the incident: the transaction committed, the row names this blob,
  // and the client was told it failed.
  assert.equal(
    await signedPdfIsUnreferenced(BLOB, async () => ({ signedPdfRef: BLOB })),
    false,
    "the row references this blob — deleting it destroys a signed contract under a record that says it exists",
  );
});

test("a failed verification keeps the blob", async () => {
  // This is NOT a corner case: the lookup usually fails for the same reason the
  // commit acknowledgement was lost — the connection is gone. Guessing "delete"
  // here reproduces the incident precisely.
  assert.equal(
    await signedPdfIsUnreferenced(BLOB, async () => {
      throw new Error("connection terminated");
    }),
    false,
    "an unanswerable question must never be answered with a delete",
  );
});

test("an unreadable answer keeps the blob", async () => {
  const malformed = async () => ({ somethingElse: true }) as unknown as { signedPdfRef: string | null };
  assert.equal(await signedPdfIsUnreferenced(BLOB, malformed), false, "no answer is not a 'no'");
  assert.equal(
    await signedPdfIsUnreferenced("", async () => ({ signedPdfRef: null })),
    false,
    "a blob we cannot even name must not be deleted",
  );
});

test("a genuinely unreferenced blob is still cleaned up", async () => {
  // The fix must not become "never delete" — a real rollback should still not
  // leak. Each of these is a positive answer that nothing references it.
  assert.equal(
    await signedPdfIsUnreferenced(BLOB, async () => null),
    true,
    "no request row at all — nothing can reference the blob",
  );
  assert.equal(
    await signedPdfIsUnreferenced(BLOB, async () => ({ signedPdfRef: null })),
    true,
    "the row references nothing — the transaction rolled back as assumed",
  );
  assert.equal(
    await signedPdfIsUnreferenced(BLOB, async () => ({ signedPdfRef: "https://store.example/uploads/other.pdf" })),
    true,
    "a concurrent completion won and filed its own upload — ours is genuinely orphaned",
  );
});

test("the completion path asks before it deletes", () => {
  const complete = shipped("src/lib/signing/complete.ts");
  const start = complete.indexOf("} catch (err) {");
  assert.notEqual(start, -1, "the completion catch block is gone — was it restructured?");
  const block = complete.slice(start, complete.indexOf("\n  }", start));

  assert.match(
    block,
    /signedPdfIsUnreferenced\(/,
    "the catch must consult the database before deleting",
  );
  const guard = block.indexOf("signedPdfIsUnreferenced(");
  const del = block.indexOf("deleteFile(");
  assert.notEqual(guard, -1, "the check is missing entirely");
  assert.notEqual(del, -1, "the delete is gone — a genuine rollback would now leak its blob");
  // The property that matters: nothing can reach the delete without passing
  // through the check first. An unguarded delete IS the bug.
  assert.ok(del > guard, "the delete must come after the check, not before it");
  assert.match(
    block.slice(guard, del),
    /\)\)\s*\{\s*$/m,
    "the delete must sit inside the check's block, not merely after it",
  );
});

/* ── the stranded-completion sweep ─────────────────────────────────────── */

test("the completion event is written LAST, so its absence is a real signal", () => {
  // The detector is "status completed, but no completed event". That only means
  // "the fan-out never finished" if the event is written after the fan-out.
  // Written first — as it used to be — the sweep would find nothing and the
  // customer would still never receive their contract.
  const complete = shipped("src/lib/signing/complete.ts");
  const event = complete.indexOf('type: "completed"');
  const fanout = complete.indexOf("runPostCompletion(");
  const email = complete.indexOf("sendEmail(");
  assert.notEqual(event, -1, "the completed event is gone");
  assert.ok(event > fanout, "the completed event must be written AFTER runPostCompletion");
  assert.ok(event > email, "the completed event must be written AFTER the recipient emails");
});

test("the sweep detects exactly the stranded shape, and settles first", () => {
  const recover = shipped("src/lib/signing/recoverCompletions.ts");
  assert.match(recover, /status:\s*"completed"/, "it must look at completed requests");
  assert.match(
    recover,
    /events:\s*\{\s*none:\s*\{\s*type:\s*"completed"\s*\}\s*\}/,
    "the detector is the ABSENCE of the completion event",
  );
  assert.match(
    recover,
    /completedAt:\s*\{\s*lt:\s*cutoff\s*\}/,
    "a completion still in flight must not be swept, or the sweep double-sends a healthy request's email",
  );
});

test("the sweep marks success only after the work, and bounds its retries", () => {
  const recover = shipped("src/lib/signing/recoverCompletions.ts");
  const redrive = recover.indexOf("await redrive(req)");
  const mark = recover.indexOf('type: "completed"', redrive);
  assert.ok(redrive !== -1 && mark > redrive, "the completion marker must be written after the re-drive, not before");

  assert.match(recover, /FOR UPDATE/, "two crons must not both decide to send — the claim takes the row lock");
  assert.match(
    recover,
    /attempts >= MAX_RECOVERY_ATTEMPTS/,
    "at-least-once delivery needs a cap, or a permanently broken request mails someone forever",
  );
  // The attempt marker is written inside the claim transaction, before the work,
  // which is what makes the cap hold across crashes.
  const claim = recover.slice(recover.indexOf("async function claimAttempt"));
  assert.match(claim, /RECOVERY_ATTEMPT/, "the attempt must be recorded in the claim");
});

test("a request whose sealed PDF is gone is left stranded, not marked recovered", () => {
  // Q-1010 is this case. Marking it recovered would send "your signed document
  // is attached" with nothing attached, and hide the one record that needs a
  // person to look at it.
  const recover = shipped("src/lib/signing/recoverCompletions.ts");
  const redrive = recover.slice(recover.indexOf("async function redrive"));
  const readAt = redrive.indexOf("readFile(");
  const sendAt = redrive.indexOf("sendEmail(");
  assert.ok(readAt !== -1 && sendAt > readAt, "the PDF must be read BEFORE any email is sent");
  assert.match(redrive, /if \(!req\.signedPdfRef\) throw/, "no stored PDF must abort the re-drive");
});

test("the sweep runs on the cron", () => {
  assert.match(
    shipped("src/app/api/cron/automations/route.ts"),
    /phase\("stranded-completions", recoverStrandedCompletions/,
    "a recovery nothing calls recovers nothing",
  );
});
