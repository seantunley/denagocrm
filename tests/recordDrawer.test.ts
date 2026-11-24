import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatRecordRef, fullRecordHref, neighbour, parseRecordRef, withOpenRecord } from "../src/lib/records/ref";
import { availableActions, RECORD_ACTIONS } from "../src/lib/records/actions";

/** Wave 2 (denagocrm-intelligent-workspaces-wave-2.md): W2-01 contextual drawer, W2-02 contextual actions. */
const src = (rel: string) => readFileSync(rel, "utf8");

test("the open record lives in the URL, and nothing else in the URL is touched", () => {
  assert.deepEqual(parseRecordRef("lead:ckx9abc123"), { type: "lead", id: "ckx9abc123" });
  for (const bad of [null, "", "lead", "lead:", ":abc123", "quote:abc123", "lead:../../x", "lead:a b c d e f", "lead:abc"]) {
    assert.equal(parseRecordRef(bad), null, String(bad));
  }
  const ref = { type: "lead" as const, id: "ckx9abc123" };
  assert.equal(formatRecordRef(ref), "lead:ckx9abc123");
  assert.equal(fullRecordHref(ref), "/leads/ckx9abc123");
  // Filters, search and page survive opening and closing.
  assert.equal(withOpenRecord("?view=all&page=3&q=ford", ref), "?view=all&page=3&q=ford&open=lead%3Ackx9abc123");
  assert.equal(withOpenRecord("?view=all&open=lead%3Ackx9abc123", null), "?view=all");
  assert.equal(withOpenRecord("?open=lead%3Ackx9abc123", null), "");
});

test("Next and Previous follow the list as it was shown", () => {
  const order = ["lead:a1aaaa", "lead:b2bbbb", "lead:c3cccc"];
  assert.equal(neighbour(order, "lead:b2bbbb", 1), "lead:c3cccc");
  assert.equal(neighbour(order, "lead:b2bbbb", -1), "lead:a1aaaa");
  assert.equal(neighbour(order, "lead:c3cccc", 1), null);
  assert.equal(neighbour(order, "lead:zzzzzz", 1), "lead:a1aaaa", "a record opened from a link starts the list");
  const nav = src("src/components/records/drawerNav.ts");
  // Opening pushes one history entry (Back closes); stepping replaces it.
  assert.match(nav, /if \(already\) window\.history\.replaceState/);
  assert.match(nav, /window\.history\.pushState\(null, "", url\)/);
  // The order is captured when a record opens, so a row that leaves the list after being done doesn't lose our place.
  assert.match(src("src/components/records/RecordDrawer.tsx"), /setOrder\(\(previous\) => \(previous\.includes\(key\) \? previous : listedRecords\(\)\)\)/);
});

test("actions are offered on the backing action's own permissions, and nothing new can change a record", () => {
  const has = (keys: string[]) => (key: string) => keys.includes(key);
  assert.deepEqual(availableActions("lead", has([])), []);
  assert.deepEqual(availableActions("lead", has(["leads.edit"])), ["contact"]);
  assert.deepEqual(availableActions("lead", has(["activities.manage"])), ["schedule", "completeActivity"]);
  assert.deepEqual(availableActions("lead", has(["leads.change_stage", "leads.assign"])), ["changeStage", "assignOwner"]);
  // Each descriptor names real, existing server actions…
  const actionFiles = ["activities", "leads", "communications", "emails", "whatsapp"].map((f) => src(`src/app/actions/${f}.ts`)).join("\n");
  for (const action of RECORD_ACTIONS) {
    for (const fn of action.backedBy) assert.match(actionFiles, new RegExp(`export async function ${fn}\\(`), `${action.id} → ${fn}`);
  }
  // …and the drawer calls only those: no new endpoint, no direct database write.
  const view = src("src/components/records/LeadPeekView.tsx");
  for (const fn of ["completeActivity(", "scheduleFollowUp(", "moveLead(", "assignLead("]) assert.ok(view.includes(fn), fn);
  assert.match(view, /<ContactComposer/);
  assert.doesNotMatch(view + src("src/components/records/RecordDrawer.tsx"), /prisma|fetch\(/);
  // The record write grants mirror the backing actions' own (CUSTOMER_RECORD_WRITE_PERMISSIONS, inbox.reply).
  assert.deepEqual([...RECORD_ACTIONS.find((a) => a.id === "contact")!.permissions], ["contacts.edit", "leads.edit", "inbox.reply"]);
  assert.match(src("src/lib/permissions.ts"), /CUSTOMER_RECORD_WRITE_PERMISSIONS = \[\s*"contacts\.edit",\s*"leads\.edit",\s*\]/);
});

test("the drawer's read checks the workspace and THIS record's access before reading it; a refused record says nothing about it", () => {
  const action = src("src/app/actions/recordPeek.ts");
  assert.match(action, /return withActingStaffScope\(async \(\) => \{\s*const user = await requireUser\(\);/);
  // One answer for deleted, another workspace's, or not yours.
  assert.equal(action.match(/return gone;|: gone;/g)?.length, 2);
  const peek = src("src/lib/records/leadPeek.ts");
  assert.ok(peek.indexOf("await canAccessLead(user, leadId)") < peek.indexOf("prisma.lead.findFirst"), "access is checked first");
  // Every read names the acting workspace.
  const reads = peek.match(/prisma\.\w+\.(findFirst|findMany)\(\{\s*where: \{[^}]*/g) ?? [];
  assert.equal(reads.length, 5);
  for (const read of reads) assert.match(read, /tenantId/, read);
  // The customer's contact details only when the person may open that customer; activities only those they may see.
  assert.match(peek, /const customer = mayOpenCustomer \? lead\.contact : null;/);
  assert.match(peek, /seesActivities \? getAccessibleActivityIds\(user\)/);
  // Loaded one record at a time, on demand — and a slow answer for an earlier row is thrown away.
  const drawer = src("src/components/records/RecordDrawer.tsx");
  assert.match(drawer, /const mine = \+\+request\.current;/);
  assert.match(drawer, /if \(mine !== request\.current\) return;\s*setResult\(\{ key, value \}\);/);
});

test("nothing is shown as done until its action has succeeded; Next is offered after, never instead", () => {
  const view = src("src/components/records/LeadPeekView.tsx");
  assert.doesNotMatch(view, /useEffect/, "nothing runs on its own");
  // Mark done stays planned when the action refuses (e.g. work dated for a later day).
  assert.match(view, /if \(result && "error" in result && result\.error\) setError\(result\.error\);\s*else \{/);
  // "Next deal" only appears in the banner that a successful action sets.
  assert.match(view, /\{did && \([\s\S]{0,700}Next deal\s*<ArrowRight/);
  assert.equal(view.match(/Next deal\s*<ArrowRight/g)?.length, 1);
  const composer = src("src/components/records/ContactComposer.tsx");
  assert.match(composer, /if \(channel === "whatsapp" && result\.ok !== WHATSAPP_SENT\) \{\s+setNotice\(/);
});

test("on Today, a deal's name opens it beside the list; the full page is still a real link", () => {
  const page = src("src/app/(app)/today/page.tsx");
  assert.match(page, /<OpenRecordLink record=\{\{ type: "lead", id: lead\.id \}\}/);
  assert.match(page, /<RecordDrawer \/>/);
  assert.match(src("src/components/TodayRow.tsx"), /data-record-open=\{`lead:\$\{composer\.leadId\}`\}/);
  const link = src("src/components/records/OpenRecordLink.tsx");
  assert.match(link, /href=\{fullRecordHref\(record\)\}/);
  assert.match(link, /event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey/);
  assert.match(src("src/components/records/RecordDrawer.tsx"), /Open full record/);
});
