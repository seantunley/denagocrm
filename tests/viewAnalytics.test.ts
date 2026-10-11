import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { engagementLine, formatDuration, MAX_VIEW_SECONDS, mergeViewReport, summariseViews } from "../src/lib/signing/viewAnalytics";

/** Signing engagement: what is measured, what the browser's word is worth, and where the rows may live. */

const row = (start: string, end: string, seconds: number, maxPage: number) => ({ startedAt: new Date(start), lastSeenAt: new Date(end), seconds, maxPage });

test("empty views summarise to zeros, and say nothing", () => {
  const s = summariseViews([]);
  assert.deepEqual(s, { sessions: 0, totalSeconds: 0, maxPage: 0, firstOpened: null, lastSeen: null });
  assert.equal(engagementLine(s), "");
});

test("the summary adds sittings and caps each one at 30 minutes", () => {
  const s = summariseViews([row("2026-10-01T10:00:00Z", "2026-10-01T10:04:00Z", 240, 2), row("2026-10-01T11:00:00Z", "2026-10-01T11:02:00Z", 5000, 1), row("2026-10-01T09:00:00Z", "2026-10-01T09:00:05Z", -9, 1)]);
  assert.equal(s.sessions, 3);
  assert.equal(s.totalSeconds, 240 + MAX_VIEW_SECONDS);
  assert.equal(s.maxPage, 2);
  assert.equal(s.firstOpened?.toISOString(), "2026-10-01T09:00:00.000Z");
  assert.equal(s.lastSeen?.toISOString(), "2026-10-01T11:02:00.000Z");
});

test("a report from the browser can only move a sitting forwards, and never past its ceiling", () => {
  const now = { seconds: 120, maxPage: 3 };
  assert.deepEqual(mergeViewReport(now, { seconds: 150, page: 4 }), { seconds: 150, maxPage: 4 });
  // Late, out of order or repeated: nothing goes backwards.
  assert.deepEqual(mergeViewReport(now, { seconds: 30, page: 1 }), now);
  // Silly or hostile: bounded, and anything that is not a number is nothing.
  assert.deepEqual(mergeViewReport(now, { seconds: 9e9, page: 9e9 }), { seconds: MAX_VIEW_SECONDS, maxPage: 500 });
  assert.deepEqual(mergeViewReport(now, { seconds: -5, page: -2 }), now);
  assert.deepEqual(mergeViewReport(now, { seconds: "600", page: { $gt: 0 } }), now);
  assert.deepEqual(mergeViewReport(now, { seconds: Number.NaN, page: Number.POSITIVE_INFINITY }), now);
  assert.deepEqual(mergeViewReport({ seconds: 0, maxPage: 1 }, {}), { seconds: 0, maxPage: 1 });
});

test("durations and the line staff read", () => {
  assert.equal(formatDuration(45), "45 sec");
  assert.equal(formatDuration(120), "2 min");
  assert.equal(formatDuration(3720), "1 hr 2 min");
  const s = summariseViews([row("2026-10-01T10:00:00Z", "2026-10-01T10:04:00Z", 240, 2), row("2026-10-01T11:00:00Z", "2026-10-01T11:02:00Z", 60, 1)]);
  assert.equal(engagementLine(s), "Opened 2 times, about 5 min in view, reached page 2.");
  assert.equal(engagementLine(s, 3), "Opened 2 times, about 5 min in view, reached page 2 of 3.");
  // Opened and closed at once is "opened" — not "read for 2 seconds".
  assert.equal(engagementLine(summariseViews([row("2026-10-01T10:00:00Z", "2026-10-01T10:00:02Z", 2, 1)])), "Opened 1 time.");
  // A page beyond the document's last is not reported as one.
  assert.equal(engagementLine({ ...s, maxPage: 40 }, 3), "Opened 2 times, about 5 min in view, reached page 3 of 3.");
});

test("the table is a workspace's own: required workspace, row-level security enabled, policied and forced", () => {
  const sql = readFileSync("prisma/migrations/20261011100000_signature_view/migration.sql", "utf8");
  assert.match(sql, /"tenantId" TEXT NOT NULL/);
  assert.match(sql, /FOREIGN KEY \("tenantId"\) REFERENCES "Tenant"\("id"\) ON DELETE CASCADE/);
  assert.match(sql, /FOREIGN KEY \("recipientId"\) REFERENCES "SignatureRecipient"\("id"\) ON DELETE CASCADE/);
  assert.match(sql, /ALTER TABLE "SignatureView" ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /CREATE POLICY "SignatureView_tenant_isolation" ON "SignatureView"\s+USING \([\s\S]*?"tenantId" = current_setting\('app\.current_tenant', true\)\s*\)\s+WITH CHECK \(/);
  assert.match(sql, /ALTER TABLE "SignatureView" FORCE ROW LEVEL SECURITY;/);
  // Additive only, and nothing personal: this is an indication, not evidence.
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|"ip"|"userAgent"/i);
  const model = /model SignatureView \{([\s\S]*?)\n\}/.exec(readFileSync("prisma/schema.prisma", "utf8"))?.[1] ?? "";
  assert.match(model, /tenantId\s+String\s*\r?\n/, "the workspace is required");
  assert.doesNotMatch(model, /\bip\b|userAgent|sections/);
});

test("the public route trusts the link, not the id, and stores nothing about the device", () => {
  const route = readFileSync("src/app/api/signing/[token]/view/route.ts", "utf8");
  // The sitting is stamped with the workspace of the request it belongs to.
  assert.match(route, /data: \{ tenantId: request\.tenantId \?\? ownedWriteTenantId\(\), requestId: request\.id, recipientId: recipient\.id \}/);
  // An update names the recipient and the request the link resolves to — on the read AND on the write.
  assert.equal((route.match(/where: \{ id: (?:body\.viewId|view\.id), recipientId: recipient\.id, requestId: request\.id \}/g) ?? []).length, 2);
  assert.match(route, /\.\.\.mergeViewReport\(view, body\)/, "figures go through the one bounded merge");
  assert.match(route, /if \(sittings >= MAX_VIEWS_PER_RECIPIENT\) return Response\.json\(\{ ok: true \}\);/);
  assert.match(route, /recipient\.tokenRevokedAt \|\| request\.deletedAt \|\| isRequestClosed\(request\.status\)/);
  assert.doesNotMatch(route, /reqMeta|userAgent|\bip\b:/, "no IP address, no browser string");
  assert.match(route, /throttlePublic\("signing-view", token, SIGNING_READ_POLICY\)/);
});

test("the page measures what it reports, and does not report from a member of staff's device", () => {
  const beacon = readFileSync("src/app/signing/[token]/ViewBeacon.tsx", "utf8");
  assert.doesNotMatch(beacon, /page: 1\b|data-section/, "the furthest page is measured, not assumed");
  assert.match(beacon, /document\.querySelectorAll\("\[data-sign-page\]"\)\.forEach\(\(el\) => seen\.observe\(el\)\)/);
  assert.match(beacon, /if \(visibleSince !== null\) \{ visibleMs \+= Date\.now\(\) - visibleSince; visibleSince = null; \}/, "time stops counting when the tab is hidden");
  assert.match(beacon, /document\.removeEventListener\("visibilitychange", onVisibility\);/, "its listeners are removed");
  const surface = readFileSync("src/app/signing/[token]/SignSurface.tsx", "utf8");
  assert.match(surface, /\{!inPerson && <ViewBeacon token=\{token\} \/>\}/);
  assert.match(surface, /<div key=\{i\} data-sign-page=\{i \+ 1\} /);
});
