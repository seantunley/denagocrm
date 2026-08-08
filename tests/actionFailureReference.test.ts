import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  ActionRefusal,
  NotAuthenticated,
  REFERENCE_ALPHABET,
  REFERENCE_LENGTH,
  classifyFailure,
  failureReference,
} from "../src/lib/actionFailure";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * "Something went wrong. Please try again."
 *
 * That sentence was the entire diagnostic output of every unexpected server
 * action failure. It cannot distinguish a database outage from an expired session
 * from a browser tab older than the running deployment, it gives nobody anything
 * to quote, and its one piece of advice — try again — is wrong for two of those
 * three.
 *
 * It cost a real afternoon. A tenant logo would not save; the toast said that;
 * the cause was a tab twenty minutes older than the build, so the action id it
 * called no longer existed and the request never reached any of our code. There
 * was no log line to find, because nothing had been logged.
 */

test("an unexpected failure produces a log line and a message sharing one reference", () => {
  const failure = classifyFailure(new Error("boom"), "K7QP2M");
  assert.equal(failure.kind, "unexpected");
  assert.ok(failure.kind === "unexpected");
  // The same reference in both, or it correlates nothing — which is the entire
  // reason it exists.
  assert.match(failure.logLine, /K7QP2M/);
  assert.match(failure.message, /K7QP2M/);
  assert.doesNotMatch(failure.message, /nothing was saved/i, "see the non-atomic test below");
});

test("the message NEVER carries the error's own detail", () => {
  // Each of these is a real shape: a driver error with a password, a Postgres
  // error naming a table and constraint, a fetch failure naming an internal host.
  for (const error of [
    new Error("connect ECONNREFUSED 10.0.0.1:5432 password=hunter2"),
    new Error('insert or update on table "AuditLog" violates foreign key constraint "AuditLog_tenantId_leadId_fkey"'),
    new Error("fetch failed: http://internal-billing.svc.cluster.local/charge"),
  ]) {
    const failure = classifyFailure(error, "ABCDEF");
    assert.ok(failure.kind === "unexpected");
    for (const secret of ["hunter2", "AuditLog", "internal-billing", "5432", "ECONNREFUSED"]) {
      assert.ok(
        !failure.message.includes(secret),
        `the message must not leak ${secret}: ${failure.message}`,
      );
    }
    // …and the log line must be the thing that CAN be searched for.
    assert.match(failure.logLine, /^\[action-failure ABCDEF\]$/);
  }
});

test("a refusal is shown verbatim and is NOT logged as a fault", () => {
  const failure = classifyFailure(new ActionRefusal("The logo must be smaller than 1 MB."), "ZZZZZZ");
  assert.equal(failure.kind, "refusal");
  assert.equal(failure.message, "The logo must be smaller than 1 MB.");
  // No reference: a refusal is a correct outcome, and offering a reference for it
  // would send someone hunting for a log line that should not exist.
  assert.doesNotMatch(failure.message, /ZZZZZZ|Reference/);
});

test("an ended session says sign in, not try again", () => {
  const failure = classifyFailure(new NotAuthenticated("Not authorized: platform admin access required."), "QQQQQQ");
  assert.equal(failure.kind, "signed-out");
  assert.match(failure.message, /sign in again/i, "the remedy must be the one that works");
  assert.doesNotMatch(failure.message, /try again\b(?!.*sign)/i);
  // The guard's own wording is written for a log, not a person, and must not be
  // what gets shown.
  assert.doesNotMatch(failure.message, /Not authorized|platform admin/i);
});

test("a generated reference is readable, unambiguous, and does not repeat", () => {
  const refs = Array.from({ length: 500 }, () => failureReference());
  for (const ref of refs) {
    assert.equal(ref.length, REFERENCE_LENGTH);
    for (const char of ref) {
      assert.ok(REFERENCE_ALPHABET.includes(char), `${char} is not in the alphabet`);
    }
  }
  // This gets read off a screen and typed into a message. O/0 and I/1 are where
  // that goes wrong, and a vowel lets a reference come out as a word.
  for (const bad of ["0", "O", "1", "I", "A", "E", "U"]) {
    assert.ok(!REFERENCE_ALPHABET.includes(bad), `${bad} is ambiguous or vowel-forming`);
  }
  // Not a uniqueness guarantee — just enough entropy that two failures in a day
  // of logs are distinguishable.
  assert.ok(new Set(refs).size > 490, `references collide too often: ${new Set(refs).size}/500`);
});

/** Wiring. The rules above are useless if the action wrapper does not apply them. */

test("asActionResult logs the unexpected case and rethrows framework signals first", () => {
  const code = src("src/lib/actionResult.ts");
  assert.match(code, /console\.error\(failure\.logLine, error\)/, "the real error must reach the log");
  assert.match(code, /unstable_rethrow\(error\)/, "redirect() and notFound() must keep propagating");
  const body = code.slice(code.indexOf("} catch (error) {"));
  assert.ok(
    body.indexOf("unstable_rethrow") < body.indexOf("classifyFailure"),
    "rethrow must come BEFORE classifying, or a redirect is logged as a failure",
  );
});

test("the platform guard raises NotAuthenticated, not a bare Error", () => {
  const auth = src("src/lib/platformAuth.ts");
  assert.match(auth, /throw new NotAuthenticated\(/);
  assert.doesNotMatch(
    auth,
    /if \(!admin\) throw new Error\(/,
    "a bare Error here is what produced the generic toast for a signed-out admin",
  );
});

/**
 * The client half: a throw that arrives in the browser did NOT fail inside the
 * action, because those return a value now. It is a call that never landed —
 * overwhelmingly a tab older than the deployment.
 */

test("a call that never reached the server says so, and says what fixes it", () => {
  const file = src("src/components/actionError.ts");
  assert.match(file, /ACTION_NOT_DELIVERED/);
  // The SENTENCE, not the file: the comment above it explains why it must not
  // claim nothing was saved, so matching the whole file fails on the explanation.
  const sentence = /ACTION_NOT_DELIVERED =\s*\n?\s*"([^"]+)"/.exec(file)?.[1] ?? "";
  assert.ok(sentence, "the sentence must be readable");
  assert.match(sentence, /refresh/i, "a stale tab is fixed by refreshing — say it");
  assert.doesNotMatch(sentence, /nothing was saved/i, "a dropped response may still have been applied");
});

test("the generic sentence is gone from the shared form and confirm dialog", () => {
  for (const file of ["src/components/SaveForm.tsx", "src/components/ConfirmActionDialog.tsx"]) {
    const code = src(file);
    assert.match(code, /ACTION_NOT_DELIVERED/, `${file} must use the shared sentence`);
    // The comments explain the old sentence, so match the CALL, not the prose.
    assert.doesNotMatch(
      code,
      /toast\.error\("Something went wrong/,
      `${file} must no longer toast the generic failure`,
    );
  }
});

/**
 * A FAILURE MESSAGE MAY NOT PROMISE A ROLLBACK.
 *
 * The first version of this said "Something went wrong and nothing was saved."
 * That is a claim about database state, and classifyFailure is in no position to
 * make it: most actions are several steps and only some are wrapped in a
 * transaction. markWon creates the contact, updates the lead, queues journey
 * work, writes the audit row and triggers a survey — a throw at step four leaves
 * the first three committed.
 *
 * Telling the salesperson nothing happened invites the retry that duplicates
 * them, which is precisely how the duplicate leads got made on 2026-08-07. The
 * message that caused that incident and the message reporting it were about to be
 * the same sentence.
 */

test("the unexpected-failure message never claims the write was rolled back", () => {
  const failure = classifyFailure(new Error("audit write failed after the lead was updated"), "K7QP2M");
  assert.ok(failure.kind === "unexpected");
  for (const promise of [/nothing was saved/i, /no changes were made/i, /rolled back/i, /has been undone/i]) {
    assert.doesNotMatch(
      failure.message,
      promise,
      `the message must not promise a rollback it cannot deliver: ${failure.message}`,
    );
  }
});

test("it tells the person to CHECK, which is the only always-safe instruction", () => {
  const failure = classifyFailure(new Error("boom"), "K7QP2M");
  assert.ok(failure.kind === "unexpected");
  assert.match(failure.message, /check the record/i, "look before retrying");
  // "Try again" alone is what turned a half-applied action into two.
  assert.doesNotMatch(failure.message, /^try again|please try again\.?$/i);
  assert.match(failure.message, /K7QP2M/, "and the reference must survive the rewording");
});

test("the not-delivered message is state-neutral too", () => {
  // A stale action id means nothing ran. A connection dropped AFTER the server
  // processed it means the write happened and only the reply was lost. The
  // browser cannot tell those apart, so it must not assert either.
  const message = src("src/components/actionError.ts");
  const sentence = /ACTION_NOT_DELIVERED =\s*\n?\s*"([^"]+)"/.exec(message)?.[1] ?? "";
  assert.ok(sentence, "the sentence must be readable");
  assert.doesNotMatch(sentence, /nothing was saved/i);
  assert.match(sentence, /may not have been applied/i, "say it is UNKNOWN, not that it failed");
  assert.match(sentence, /refresh/i, "and keep the advice that fixes the common case");
});

test("a refusal and an ended session may still speak in absolutes", () => {
  // These are thrown by guards BEFORE any write, so they are the two cases where
  // saying nothing happened is actually true. Neither should acquire the hedging
  // the unexpected case needs.
  const refusal = classifyFailure(new ActionRefusal("The logo must be smaller than 1 MB."), "AAAAAA");
  assert.equal(refusal.message, "The logo must be smaller than 1 MB.");
  const signedOut = classifyFailure(new NotAuthenticated("nope"), "AAAAAA");
  assert.ok(signedOut.kind === "signed-out");
  assert.match(signedOut.message, /sign in again/i);
});
