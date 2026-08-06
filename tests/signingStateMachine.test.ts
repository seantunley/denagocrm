import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

test("completion never renders from live source context", () => {
  const completion = read("src/lib/signing/complete.ts");
  assert.doesNotMatch(completion, /bindCtx\(/);
  assert.match(completion, /Envelope has no frozen canonical source/);
  assert.match(completion, /status: "sealed"/);
  assert.match(completion, /status='distributing'/);
});

test("final completion waits for durable jobs then anchors the final event", () => {
  const finalizer = read("src/lib/signing/finalizeCompletion.ts");
  const eventIndex = finalizer.indexOf("'completed'");
  const anchorIndex = finalizer.indexOf("await anchorEvidence");
  const statusIndex = finalizer.lastIndexOf("status='completed'");
  assert.ok(eventIndex > 0 && anchorIndex > eventIndex && statusIndex > anchorIndex);
  assert.match(finalizer, /dead_letter/);
  assert.match(finalizer, /failed_manual_intervention/);
});

test("storage deletion is retain-on-uncertainty", () => {
  const storage = read("src/lib/storage.ts");
  const custody = read("src/lib/signing/artifactCustody.ts");
  assert.match(storage, /isStorageRefReferenced/);
  assert.match(custody, /reference verification failed; retaining object/);
  assert.match(custody, /return true/);
});
