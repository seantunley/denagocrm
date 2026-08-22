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

test("the failure report carries the reason the browser saw", () => {
  const actions = shipped("src/app/actions/photoUploads.ts");
  assert.ok(actions.includes("reason?: string"), "the reporter must accept one");
  assert.ok(actions.includes("A photo did not reach blob storage: ${reason}"), "and lead with it");
  assert.ok(actions.includes("source=browser"), "marked as client-reported, not a server observation");
  assert.ok(actions.includes(".slice(0, 300)"), "client text going into a log row must be capped");
});

/*
 * The recorder has to survive the failure it is recording. This is the one that
 * made the log empty rather than merely unhelpful.
 */
test("an unresolvable workspace no longer stops the report being written", () => {
  const actions = shipped("src/app/actions/photoUploads.ts");
  const opening = actions.slice(0, actions.indexOf("if (target.kind === \"delivery\")"));
  assert.ok(
    /try\s*\{\s*tenantId = await actingTenantId\(\);\s*\}\s*catch\s*\{/.test(opening),
    "actingTenantId throws with no workspace — that must not abort the report",
  );
  assert.ok(actions.includes("let tenantId: string | null = null;"), "the row is written unattributed rather than not at all");
});

test("but the permission check never becomes optional", () => {
  // It is what stops this being an endpoint for writing arbitrary log rows. Only
  // the tenant-ownership re-check — defence in depth on top of it — is skipped
  // when there is no tenant to check against.
  const actions = shipped("src/app/actions/photoUploads.ts");
  assert.ok(actions.includes('await requireQuoteAccess(target.recordId, "deliveries.manage");'));
  assert.ok(actions.includes('await requireJobCardAccess(jobCardId, "jobcards.manage");'));

  const gate = actions.indexOf("requireQuoteAccess");
  const ownership = actions.indexOf("basePrisma.quote.findFirst");
  assert.ok(gate < ownership, "the permission check must run before the ownership read");

  // The permission calls must NOT sit behind the `if (tenantId)` guard.
  assert.ok(
    !/if \(tenantId\) \{\s*await require/.test(actions),
    "a missing tenant must not skip the authorisation gate",
  );
});
