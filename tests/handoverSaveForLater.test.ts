import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mergeRunEntries } from "../src/lib/checklists/mergeRunEntries";

/**
 * Sean, 2026-11-12, on a live handover: "Save for later does nothing and saves
 * nothing. Wipes all the progress" (reopened with Carry on), and "app says online
 * but photos are not uploading".
 */
const src = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const runner = src("src/components/checklists/ChecklistRunner.tsx");
const e = (id: string, status: string, photos: string[] = []) => ({ id, status, photoCount: photos.length, photos: photos.map((p) => ({ id: p, url: `u/${p}` })) });

test("a reopen never loses an answer: each step takes whichever copy has one", () => {
  // Server: steps 1–4 done. Phone: an older copy (1–2 done) plus step 5 done since.
  const server = [e("s1", "done", ["a"]), e("s2", "done", ["b"]), e("s3", "done", ["c"]), e("s4", "done", ["d", "f"]), e("s5", "pending")];
  const phone = [e("s1", "done", ["a"]), e("s2", "done"), e("s3", "pending"), e("s4", "pending"), e("s5", "done")];
  const merged = mergeRunEntries(server, phone);
  assert.deepEqual(merged.map((x) => x.status), ["done", "done", "done", "done", "done"]);
  assert.deepEqual(merged[3].photos.map((p) => p.id), ["d", "f"]);
  assert.equal(merged[3].photoCount, 2);
  assert.equal(merged[1].photoCount, 1, "the server's photo is kept");
  // The phone's newer answer wins where both have one.
  const skipped = mergeRunEntries([e("s1", "done")], [{ ...e("s1", "skipped") }]);
  assert.equal(skipped[0].status, "skipped");
  // Wired into the reopen, both for a saved phone copy and for this screen's own copy.
  assert.match(runner, /mergeRunEntries\(fromServer\.entries, stored\.entries\)/);
  assert.match(runner, /mergeRunEntries\(fromServer\.entries, session\.entries\)/);
});

test("the server never turns an answered step back into 'not done'", () => {
  const actions = src("src/app/actions/checklistRuns.ts");
  assert.match(actions, /select: \{ id: true, itemIdSnapshot: true, status: true \}/);
  assert.match(actions, /update: entry\.status === "pending" && \(storedStatus\.get\(entry\.id\) \?\? "pending"\) !== "pending" \? \{\} : answers,/);
});

test("Save for later keeps the sheet open: the page refreshes when it closes", () => {
  const save = runner.slice(runner.indexOf("async function saveProgress("), runner.indexOf("function sendInBackground("));
  assert.doesNotMatch(save, /router\.refresh\(\)/, "refreshing on save unmounted the sheet of a new run");
  assert.match(save, /refreshOnClose\.current = true;/);
  const close = runner.slice(runner.indexOf("function onOpenChange("), runner.indexOf("function patch("));
  assert.match(close, /if \(refreshOnClose\.current\) \{\s*refreshOnClose\.current = false;\s*router\.refresh\(\);/);
});

test("photos go up as they are taken while online — run first, then the photos", () => {
  const bg = runner.slice(runner.indexOf("function sendInBackground("));
  assert.match(bg, /if \(typeof navigator !== "undefined" && !navigator\.onLine\) return;/);
  assert.ok(bg.indexOf("await syncChecklistRun(") < bg.indexOf("await drain("), "the entry must exist before its upload is authorised");
  const accept = runner.slice(runner.indexOf("async function acceptFiles("), runner.indexOf("async function sendNow("));
  assert.match(accept, /if \(added\.some\(\(capture\) => capture\.state === "queued"\)\) \{\s*sendInBackground\(/);
  // Save and Finish wait for a background send, so the two never overlap.
  const sync = runner.slice(runner.indexOf("async function syncAndUpload("));
  assert.ok(sync.indexOf("await background.current;") < sync.indexOf("await syncChecklistRun("));
});

test("the photo upload's Vercel Blob API call is on the content policy", () => {
  assert.match(src("src/lib/csp.ts"), /connect-src 'self' [^`]*\$\{VERCEL_BLOB_API\}/);
  assert.match(src("src/lib/csp.ts"), /const VERCEL_BLOB_API = "https:\/\/vercel\.com\/api\/blob\/";/);
});
