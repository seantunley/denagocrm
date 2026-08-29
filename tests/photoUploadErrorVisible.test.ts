import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const shipped = (file: string) =>
  src(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * "The upload did not complete. The technical reason is recorded in Settings →
 * System Log." — with nothing in the System Log.
 *
 * Three separate things conspired, and each one destroyed the evidence a bit
 * further:
 *
 *  1. The catch bound NO error (`catch {`), so the one fact worth having was
 *     discarded at the moment it existed.
 *  2. reportPhotoUploadFailure was never told a reason, so even a successful
 *     write said only "A photo did not reach blob storage" — the symptom the
 *     person was already looking at.
 *  3. That reporter opened with `await actingTenantId()`, which THROWS when the
 *     sign-in resolves no workspace — one of the very failures worth reporting.
 *     The client's `.catch(() => {})` then swallowed that too.
 *
 * So the message promised an answer that the code had already guaranteed would
 * not be there.
 */

test("the browser keeps the error it caught instead of discarding it", () => {
  const code = shipped("src/components/DirectPhotoUploader.tsx");
  // Scoped to send(). The two catches outside it are legitimate fallbacks that
  // lose nothing: preparePhoto returns the original file when the image cannot
  // be decoded, and reasonOf falls through when a value will not serialise.
  const send = code.slice(code.indexOf("async function send()"));
  assert.ok(send.length > 0, "send() not found — was it renamed?");

  assert.equal(
    [...send.matchAll(/\}\s*catch\s*\{/g)].length,
    0,
    "a catch in the upload path that binds no error can never report what went wrong",
  );
  assert.ok(send.includes("} catch (error) {"), "the upload catches must bind the error");
  assert.ok(send.includes("reasonOf(error)"), "and reduce it to something showable");
});

test("the reason is shown on screen, not only promised in a log", () => {
  const code = shipped("src/components/DirectPhotoUploader.tsx");
  assert.ok(
    code.includes("`The upload did not complete: ${reason}`"),
    "the person must be told the reason where they are standing",
  );
  assert.ok(
    !code.includes("The technical reason is recorded in Settings"),
    "a message must not promise a log entry the code cannot guarantee was written",
  );
});

test("an all-failed batch says why rather than pointing elsewhere", () => {
  const code = shipped("src/components/DirectPhotoUploader.tsx");
  assert.ok(code.includes("firstFailure"), "the first real reason must be kept");
  assert.ok(code.includes("`No photos were uploaded: ${firstFailure}`"));
});

/*
 * The server-side half of this — that a row is written even when the workspace
 * and the record check both fail — is covered in photoFailureReport.test.ts,
 * which RUNS that path rather than reading it.
 *
 * The three assertions that used to sit here checked the order of statements in
 * the action's source. They passed while the bug was still live: the ordering
 * they described was correct, and the code still could not reach the log,
 * because requireQuoteAccess re-enters the same tenant resolution that had
 * already thrown. Source order was the wrong thing to assert, so it is not
 * asserted somewhere else — it is replaced by executing the failure.
 */
