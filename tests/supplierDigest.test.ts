import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { digestWeekDue, eachPage, isoWeekKey, supplierDigestEmail, SUPPLIER_DIGEST_SWITCH } from "../src/lib/supplierDigestRules";
import { AUTOMATIONS } from "../src/lib/automationRegister";

/** The owner's weekly supplier-papers email (review section E, 2026-11-09). */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const TZ = "Africa/Johannesburg";

test("ISO weeks, including the year boundary", () => {
  assert.equal(isoWeekKey(2026, 11, 9), "2026-W46");
  assert.equal(isoWeekKey(2027, 1, 1), "2026-W53", "1 Jan 2027 is a Friday in 2026's last week");
  assert.equal(isoWeekKey(2026, 12, 28), "2026-W53");
});

test("due from 07:00 on Monday (workspace time), once a week, catching up later in a missed week", () => {
  // Monday 9 Nov 2026: 04:59Z is 06:59 in Johannesburg — not yet; 05:00Z is 07:00 — due.
  assert.equal(digestWeekDue(new Date("2026-11-09T04:59:00Z"), TZ, "2026-W45"), null);
  assert.equal(digestWeekDue(new Date("2026-11-09T05:00:00Z"), TZ, "2026-W45"), "2026-W46");
  assert.equal(digestWeekDue(new Date("2026-11-09T05:30:00Z"), TZ, "2026-W46"), null, "already sent this week");
  assert.equal(digestWeekDue(new Date("2026-11-11T10:00:00Z"), TZ, "2026-W45"), "2026-W46", "a missed Monday catches up");
  assert.equal(digestWeekDue(new Date("2026-11-09T05:00:00Z"), TZ, null), "2026-W46", "first ever");
});

test("the email lists deals and their missing papers, and says nothing when nothing is missing", () => {
  assert.equal(supplierDigestEmail({ brand: "Denago", origin: "https://crm", deals: [] }), null);
  assert.equal(supplierDigestEmail({ brand: "Denago", origin: "https://crm", deals: [{ quoteNumber: 1, customer: "A", href: "/deals/q", missing: [] }] }), null);
  const mail = supplierDigestEmail({
    brand: "Denago",
    origin: "https://crm.example",
    deals: [{ quoteNumber: 1029, customer: "Mrs Smith", href: "/deals/q1", missing: ["Supplier invoice — Wrap Studio", "Proof of payment — supplier — Wrap Studio"] }],
  })!;
  assert.equal(mail.subject, "Denago: 2 supplier papers missing on 1 deal");
  assert.match(mail.text, /Q-1029 · Mrs Smith\n  - Supplier invoice — Wrap Studio\n  - Proof of payment — supplier — Wrap Studio\n  https:\/\/crm\.example\/deals\/q1/);
  assert.match(mail.text, /Switch this weekly email off in Settings → Automatic jobs & messages/);
});

test("visible and switchable, on the automations cron, Suppliers module only, once a week by claim", () => {
  const entry = AUTOMATIONS.find((a) => a.key === "supplier-digest");
  assert.equal(entry?.setting?.key, SUPPLIER_DIGEST_SWITCH);
  assert.equal(entry?.reaches, "staff");
  assert.deepEqual(entry?.phases, ["supplier-digest"]);
  const cron = read("src/app/api/cron/automations/route.ts");
  assert.match(cron, /on\("suppliers"\) \? await phase\("supplier-digest", \(\) => runSupplierDigest\(tenantId\), null\) : null/);
  const lib = read("src/lib/supplierDigest.ts");
  assert.match(lib, /if \(!\(await automationOn\(SUPPLIER_DIGEST_SWITCH, tenantId\)\)\) return \{ skipped: "switched-off" \};/);
  assert.match(lib, /updateMany\(\{ where: \{ tenantId, key: SUPPLIER_DIGEST_LAST_WEEK, value: stored\.value \}, data: \{ value: week \} \}\)/);
  assert.ok(lib.indexOf("Claim this week before anything goes out") < lib.indexOf("await sendEmail("));
  assert.match(lib, /!item\.key\.startsWith\("none:"\)/, "only suppliers actually on a deal");
});

test("paging reaches every qualifying quote — 250 of them, in pages of 100 (review #1047)", async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ id: `q${String(i).padStart(4, "0")}` }));
  const asked: (string | null)[] = [];
  const visited: string[] = [];
  await eachPage(
    100,
    async (after) => {
      asked.push(after);
      return rows.filter((row) => after === null || row.id > after).slice(0, 100);
    },
    (page) => { visited.push(...page.map((row) => row.id)); },
  );
  assert.equal(visited.length, 250);
  assert.deepEqual(visited, rows.map((row) => row.id));
  assert.deepEqual(asked, [null, "q0099", "q0199"]);
});

test("an exact multiple of the page size ends on an empty page, not a missed one", async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: `q${String(i).padStart(4, "0")}` }));
  let visited = 0;
  let pages = 0;
  await eachPage(100, async (after) => { pages++; return rows.filter((row) => after === null || row.id > after).slice(0, 100); }, (page) => { visited += page.length; });
  assert.equal(visited, 200);
  assert.equal(pages, 3);
});

test("the digest pages through every deal — no cap on how many quotes it looks at", () => {
  const digest = read("src/lib/supplierDigest.ts");
  assert.doesNotMatch(digest, /take: 100\b/);
  assert.match(digest, /await eachPage\(\s*DIGEST_PAGE,/);
  assert.match(digest, /\.\.\.\(after \? \{ id: \{ gt: after \} \} : \{\}\)/);
  assert.match(digest, /orderBy: \{ id: "asc" \},\s*take: DIGEST_PAGE/);
  // One deal across two pages is listed once.
  assert.match(digest, /const seen = new Set<string>\(\);[\s\S]*missingOnPage\(tenantId, accepted, types, seen\)/);
});
