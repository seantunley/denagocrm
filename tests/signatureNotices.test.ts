import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanNotice, liveNotices, noticeState, NOTICE_MAX, type NoticeRow } from "../src/lib/signatureNotices";
import { extrasHtml, shortSignature } from "../src/lib/signaturePeople";
import { copyableSignature } from "../src/lib/signatureCopy";
import { DEFAULT_SIGNATURE_COMPANY } from "../src/lib/signature";

/**
 * Dated signature lines (Sean, 2026-11-20: "'On leave until 5 January, contact Thandi', or holiday trading hours, which
 * appear and disappear on schedule"). What these hold: a line shows only between its days (South African days); your
 * own comes before everyone's; it reaches replies; a copied signature never carries one; only this workspace's rows.
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const at = (iso: string) => new Date(iso);
const row = (over: Partial<NoticeRow>): NoticeRow => ({
  id: "n1", userId: null, text: "Holiday hours", startsAt: at("2026-12-20T00:00:00+02:00"), endsAt: at("2027-01-05T23:59:59.999+02:00"), createdAt: at("2026-11-20T10:00:00Z"), ...over,
});

test("a line shows from the first SA day to the end of the last, and not a moment either side", () => {
  const r = row({});
  assert.equal(noticeState(r, at("2026-12-19T23:59:59+02:00")), "scheduled");
  assert.equal(noticeState(r, at("2026-12-20T00:00:00+02:00")), "live");
  assert.equal(noticeState(r, at("2027-01-05T23:59:00+02:00")), "live");
  assert.equal(noticeState(r, at("2027-01-06T00:00:00+02:00")), "ended");
});

test("your own line first, then everyone's; someone else's never; two at most", () => {
  const now = at("2026-12-28T09:00:00+02:00");
  const rows = [
    row({ id: "a", userId: null, text: "Closed 24 Dec – 2 Jan" }),
    row({ id: "b", userId: "thandi", text: "Thandi is on leave" }),
    row({ id: "c", userId: "sipho", text: "On leave until 5 January — contact Thandi", endsAt: at("2027-01-05T23:59:59+02:00") }),
    row({ id: "d", userId: "sipho", text: "Back on 6 January", endsAt: at("2027-01-04T23:59:59+02:00") }),
    row({ id: "e", userId: null, text: "Not yet", startsAt: at("2027-02-01T00:00:00+02:00"), endsAt: at("2027-02-02T00:00:00+02:00") }),
  ];
  assert.deepEqual(liveNotices(rows, "sipho", now), ["Back on 6 January", "On leave until 5 January — contact Thandi"]);
  assert.deepEqual(liveNotices(rows, "lerato", now), ["Closed 24 Dec – 2 Jan"]);
  assert.deepEqual(liveNotices(rows, "lerato", at("2027-01-10T09:00:00+02:00")), []);
});

test("what may be saved: a line, real days in order, not over, not endless", () => {
  const now = at("2026-11-20T12:00:00+02:00");
  const ok = cleanNotice({ text: "  On leave\nuntil 5 January  ", startsOn: "2026-12-20", endsOn: "2027-01-05" }, now);
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.text, "On leave until 5 January");
  assert.equal(ok.ok && ok.startsAt.toISOString(), "2026-12-19T22:00:00.000Z");
  for (const [input, why] of [
    [{ text: "", startsOn: "2026-12-20", endsOn: "2027-01-05" }, /Type the line/],
    [{ text: "x".repeat(NOTICE_MAX + 1), startsOn: "2026-12-20", endsOn: "2027-01-05" }, /too long/],
    [{ text: "x", startsOn: "", endsOn: "2027-01-05" }, /first and the last day/],
    [{ text: "x", startsOn: "2026-11-01", endsOn: "2026-11-10" }, /already passed/],
    [{ text: "x", startsOn: "2027-01-05", endsOn: "2026-12-20" }, /before the first/],
    [{ text: "x", startsOn: "2026-12-01", endsOn: "2027-12-01" }, /at most/],
  ] as const) {
    const result = cleanNotice(input, now);
    assert.ok(!result.ok && why.test(result.error), JSON.stringify(input));
  }
});

test("the line is on the full signature and on replies, escaped; and never on a copied one", () => {
  const notices = ["On leave until 5 January — <contact> Thandi"];
  assert.match(extrasHtml({ notices }, "", "#123456"), /^<div[^>]*><strong style="color:#123456;">On leave until 5 January — &lt;contact&gt; Thandi<\/strong>/);
  assert.match(shortSignature({ name: "Sipho", email: "s@x.example", extras: { notices } }, { name: "Acme", switchboard: "" }, "#123456"), /On leave until 5 January/);
  const copied = copyableSignature({ name: "Sipho", email: "s@x.example", extras: { notices, hours: "Mon–Fri" } }, DEFAULT_SIGNATURE_COMPANY);
  assert.doesNotMatch(copied.html, /On leave/);
  assert.doesNotMatch(copied.text, /On leave/);
});

test("sends read today's lines; writes name the workspace; the table is walled off per workspace", () => {
  assert.match(code("src/lib/signatureSender.ts"), /const notices = await liveNoticesFor\(tenantId, userId\);/);
  const store = code("src/lib/signatureNoticeStore.ts");
  assert.match(store, /where: \{ tenantId, startsAt: \{ lte: now \}, endsAt: \{ gt: now \}, OR: \[\{ userId: null \}, \{ userId \}\] \}/);
  const actions = code("src/app/actions/signatureNotices.ts");
  assert.match(actions, /if \(forEveryone && !\(await isTenantOwner\(\)\)\) refuse\(/);
  assert.match(actions, /findFirst\(\{ where: \{ id, tenantId \}/, "row's workspace checked at the door");
  assert.match(actions, /row\.userId !== user\.id && !\(await isTenantOwner\(\)\)/);
  assert.match(actions, /isModuleEnabled\("signatures"\)/);
  const sql = code("prisma/migrations/20261120160000_signature_notices/migration.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "SignatureNotice"/);
  assert.match(sql, /ALTER TABLE "SignatureNotice" ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /ALTER TABLE "SignatureNotice" FORCE ROW LEVEL SECURITY;/);
});
