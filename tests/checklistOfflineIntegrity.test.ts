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

test("connectivity is permanently visible in both app headers — a dot on the avatar, spelled out in the account menu", () => {
  // Sean, 2026-11-12: the "Online" badge became a dot on the avatar (option 2).
  // AccountMenu renders in BOTH headers (mobile and desktop), so both show status.
  const shell = src("src/components/AppShell.tsx");
  assert.doesNotMatch(shell, /<ConnectivityIndicator /, "no separate badge any more");
  assert.equal((shell.match(/<AccountCluster /g) ?? []).length, 2, "mobile and desktop both carry the account menu");
  const menu = src("src/components/AccountMenu.tsx");
  assert.match(menu, /const connectivity = useConnectivity\(\{ tenantId, userId: user\.id \}\);/);
  assert.match(menu, /<ConnectivityDot state=\{connectivity\} \/>/);
  assert.match(menu, /aria-label=\{`Account — \$\{user\.name\}\. \$\{status\}`\}/, "screen readers hear the state on the button");
  assert.match(menu, /<p aria-live="polite"[^>]*>[\s\S]*?\{status\}/, "and the menu says it in words");
  const indicator = src("src/components/ConnectivityIndicator.tsx");
  assert.match(indicator, /offlinePendingCount/);
  assert.match(indicator, /state\.online \? "bg-emerald-400" : "bg-amber-400"/);
  assert.match(indicator, /motion-safe:animate-ping/, "the busy ring never moves under reduced motion");
});

test("the connection in words", async () => {
  const { connectivityText } = await import("../src/components/ConnectivityIndicator");
  assert.equal(connectivityText({ online: true, pending: 0, syncing: false }), "Online — everything saved");
  assert.equal(connectivityText({ online: true, pending: 3, syncing: false }), "Online — 3 changes waiting to sync");
  assert.equal(connectivityText({ online: true, pending: 1, syncing: true }), "Syncing — 1 change waiting to sync");
  assert.equal(connectivityText({ online: false, pending: 0, syncing: false }), "Offline — work is saved on this device");
  assert.equal(connectivityText({ online: false, pending: 2, syncing: false }), "Offline — 2 changes waiting to sync, saved on this device");
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
