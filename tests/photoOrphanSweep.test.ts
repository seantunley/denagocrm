import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ORPHAN_GRACE_MS, isPastGrace, parsePhotoPath } from "../src/lib/photoOrphanRules";

const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const T = "tenant_a";
const HOUR = 60 * 60 * 1000;

/**
 * Direct upload puts the file in the store BEFORE the action that files it runs.
 * A phone that loses signal, locks, or has its PWA closed in between leaves an
 * object nothing points at: invisible in the app, undeletable through it, and
 * billed forever. The old FormData path could not do this — it wrote the file and
 * the row in one request and rolled the file back if the row failed.
 */

test("only the direct-upload namespace is a sweep candidate", () => {
  assert.deepEqual(parsePhotoPath(`uploads/${T}/delivery/q_1/a.jpg`), { tenantId: T, kind: "delivery", recordId: "q_1" });
  assert.deepEqual(parsePhotoPath(`uploads/${T}/inspection/i_1/a.jpg`), { tenantId: T, kind: "inspection", recordId: "i_1" });
  assert.deepEqual(parsePhotoPath(`uploads/${T}/jobcard-checkout/j_1/a.jpg`), { tenantId: T, kind: "jobcard-checkout", recordId: "j_1" });
});

test("nothing else is ever a sweep candidate", () => {
  // This store also holds legacy pre-namespacing documents, backups and managed
  // objects. The sweep issues DELETES, so anything it cannot positively identify
  // must be skipped rather than guessed at.
  for (const p of [
    `uploads/${T}/legacy.pdf`,
    `uploads/${T}/invoice/q_1/a.pdf`,
    "backups/2026-08-11.sql",
    "managed/thing.json",
    `uploads/${T}/delivery/q_1`,
    "uploads",
    "",
  ]) {
    assert.equal(parsePhotoPath(p), null, `"${p}" must not be swept`);
  }
});

test("an object still inside its grace period is never deleted", () => {
  const now = 1_000 * HOUR;
  assert.equal(isPastGrace(new Date(now - HOUR), now), false, "an hour old is still in flight");
  assert.equal(isPastGrace(new Date(now - 23 * HOUR), now), false);
  assert.equal(isPastGrace(new Date(now - 25 * HOUR), now), true);
});

test("an object with no upload time is kept, not guessed at", () => {
  // The store should always report one. If it ever does not, treating the
  // omission as "old" would let a store-side bug delete photos.
  assert.equal(isPastGrace(null, Date.now()), false);
});

test("the grace period is long enough to survive a bad signal", () => {
  // Erring long costs a day of storage; erring short loses evidence somebody
  // drove to a customer's premises to collect.
  assert.ok(ORPHAN_GRACE_MS >= HOUR, "an hour is not enough for a phone on a bad connection");
  assert.equal(ORPHAN_GRACE_MS, 24 * HOUR);
});

test("a claimed photo is recognised from BOTH places a URL can be stored", () => {
  // Document.storedName holds delivery and job-card photos;
  // JobCardInspectionItem.photoStoredName holds inspection photos. Checking only
  // the first would delete every inspection photo ever taken.
  const lib = src("src/lib/photoOrphans.ts");
  assert.ok(lib.includes("document.findFirst({ where: { storedName: url, tenantId }"));
  assert.ok(lib.includes("jobCardInspectionItem.findFirst({ where: { photoStoredName: url, tenantId }"));
});

test("a tenant-scoped sweep cannot delete past its own workspace", () => {
  const lib = src("src/lib/photoOrphans.ts");
  assert.ok(lib.includes('const prefix = opts.tenantId ? `uploads/${opts.tenantId}/` : "uploads/";'));
  assert.ok(
    lib.includes("if (opts.tenantId && parsed.tenantId !== opts.tenantId) continue;"),
    "the path must be re-checked even after a scoped list — the store is not the boundary",
  );
});

test("the sweep deletes only after both the age and the claim check", () => {
  const lib = src("src/lib/photoOrphans.ts")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");
  const age = lib.indexOf("isPastGrace(");
  const claim = lib.indexOf("await isClaimed(");
  const del = lib.indexOf("await deleteFile(");
  assert.ok(age !== -1 && claim !== -1 && del !== -1);
  assert.ok(age < del, "an object inside its grace period must never reach the delete");
  assert.ok(claim < del, "a claimed object must never reach the delete");
});

test("the sweep is scheduled, or it does not run", () => {
  const vercel = JSON.parse(src("vercel.json")) as { crons: { path: string; schedule: string }[] };
  const entry = vercel.crons.find((c) => c.path === "/api/cron/photo-orphans");
  assert.ok(entry, "an unscheduled cron route is dead code");
  assert.match(entry.schedule, /^\d+ \d+ \* \* \*$/, "daily suits a 24h grace period");
});

test("the cron route refuses an unauthorised caller", () => {
  const route = src("src/app/api/cron/photo-orphans/route.ts");
  assert.ok(route.includes('if (!isAuthorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });'));
  assert.ok(route.includes("tenantId,"), "the slice's tenant must be passed in, not re-derived inside a delete loop");
});
