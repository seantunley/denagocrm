import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("the complete offline run, not only photo blobs, is durable and scoped", () => {
  const store = src("src/lib/checklists/deviceStore.ts");
  assert.match(store, /entries: DeviceSessionEntry\[\]/, "answers and immutable entry ids must survive a reload");
  assert.match(store, /templateVersion: number/, "the rendered revision must survive a reload");
  assert.match(store, /scopeKey: string/);
  assert.match(store, /tenantId: string/);
  assert.match(store, /userId: string/);
  assert.match(store, /expiresAt: string/);
  assert.match(store, /new Date\(now\.getTime\(\) \+ OFFLINE_TTL_MS\)/, "offline work must expire after the shared 72-hour TTL");
});

test("login scope changes and sign-out remove device-held customer evidence", () => {
  const store = src("src/lib/checklists/deviceStore.ts");
  const menu = src("src/components/AccountMenu.tsx");
  assert.match(store, /row\.scopeKey !== wanted \|\| Date\.parse\(row\.expiresAt\) <= now/g);
  assert.match(menu, /offlinePendingCount\(\{ tenantId, userId: user\.id \}\)/);
  assert.match(menu, /Discard offline work and sign out\?/);
  assert.match(menu, /await clearChecklistDeviceData\(\)/);
});

test("offline recovery never lets a clean device cache shadow server truth", () => {
  const runner = src("src/components/checklists/ChecklistRunner.tsx");
  assert.match(runner, /stored\?\.dirty/);
  assert.match(runner, /await deleteDeviceSession\(scope, active\.runId\)/);
  assert.match(runner, /persistTail\.current = write\.catch/);
});

test("connectivity is permanently visible in both app headers", () => {
  const shell = src("src/components/AppShell.tsx");
  const indicator = src("src/components/ConnectivityIndicator.tsx");
  assert.equal((shell.match(/<ConnectivityIndicator /g) ?? []).length, 2, "mobile and desktop both need status");
  assert.match(indicator, /"Online" : "Offline"/);
  assert.match(indicator, /offlinePendingCount/);
});

test("all four configured checklist hosts are mounted on their record surfaces", () => {
  const deliveries = src("src/app/(app)/deliveries/page.tsx");
  const jobcard = src("src/app/(app)/jobcards/[id]/page.tsx");
  const vehicle = src("src/app/(app)/vehicles/[id]/page.tsx");
  assert.match(deliveries, /hostType="quote\.delivery"/);
  assert.match(jobcard, /hostType="jobcard\.checkin"/);
  assert.match(jobcard, /hostType="jobcard\.checkout"/);
  assert.match(vehicle, /hostType="vehicle\.condition"/);
});

test("help centre covers offline capture, recovery, expiry and administration", () => {
  const help = src("src/lib/help/articles/offline-checklists.ts");
  for (const phrase of ["72 hours", "Offline", "shared device", "visibility rules", "signature"]) {
    assert.match(help, new RegExp(phrase, "i"));
  }
});
