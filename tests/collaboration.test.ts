import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mentionedIds, mentionQuery, pushFor, recordHref, snippetOf, watchTitle } from "../src/lib/collaborationRules";

const read = (path: string) => readFileSync(path, "utf8");
const staff = [
  { id: "u_thabo", name: "Thabo Nkosi" },
  { id: "u_anna", name: "Anna" },
];

test("a note names only staff picked from the list whose @Name is still in it", () => {
  assert.deepEqual(mentionedIds("@Thabo Nkosi can you call?", ["u_thabo"], staff), ["u_thabo"]);
  assert.deepEqual(mentionedIds("can you call?", ["u_thabo"], staff), [], "deleting the name un-mentions them");
  assert.deepEqual(mentionedIds("@Thabo Nkosi @Anna", ["u_thabo", "u_anna", "u_anna"], staff), ["u_thabo", "u_anna"], "once each");
  assert.deepEqual(mentionedIds("@Mallory", ["u_mallory"], staff), [], "an id that isn't this workspace's staff names nobody");
});

test("the @ list opens only on an @ starting a word", () => {
  assert.deepEqual(mentionQuery("Hi @tha", 7), { start: 3, query: "tha" });
  assert.deepEqual(mentionQuery("@", 1), { start: 0, query: "" });
  assert.equal(mentionQuery("mail sean@denago", 16), null, "an email address isn't a mention");
  assert.equal(mentionQuery("@thabo\nnext", 11), null, "a new line ends it");
});

test("what the bell and the phone say", () => {
  assert.equal(snippetOf("  call   him\nback "), "call him back");
  assert.equal(snippetOf(""), null);
  assert.equal(snippetOf("x".repeat(400))!.length, 160);
  assert.equal(watchTitle("stage", "Golf cart for Lee", "Quoted"), "Golf cart for Lee moved to Quoted");
  assert.equal(watchTitle("reply", "Lee Smith"), "Lee Smith replied");
  assert.equal(recordHref("jobcard", "j1"), "/jobcards/j1");
  // A phone can show this on a locked screen: never the customer.
  assert.deepEqual(pushFor("mention", "Sean"), { title: "Sean mentioned you", body: "Tap to read it in the CRM." });
  assert.doesNotMatch(JSON.stringify(pushFor("watch", null)), /Lee|customer/i);
});

test("people are told only about records they may open, checked as them, and again when shown", () => {
  const lib = read("src/lib/collaboration.ts");
  const notify = lib.slice(lib.indexOf("export async function notifyPeople"), lib.indexOf("export async function tellAboutNote"));
  assert.match(notify, /filter\(\(id\) => id && id !== notice\.actorId\)/, "never about your own note");
  assert.match(notify, /const user = await staffUserFor\(userId\);\s*if \(!user \|\| !\(await canOpenRecord\(user, ref\)\)\)/);
  assert.match(notify, /if \(unread\) continue;/, "a watch says each kind of change once until read");
  assert.match(lib, /export async function visibleNotifications[\s\S]*getAccessibleLeadIds\(user\)/);
  assert.match(read("src/app/(app)/notifications/page.tsx"), /visibleNotifications\(user, tenantId\)/);
  const actions = read("src/app/actions/collaboration.ts");
  assert.match(actions, /if \(!\(await canOpenRecord\(user, \{ type: recordType, id: recordId \}\)\)\) refuse/, "you can only watch what you can open");
  assert.match(actions, /const user = await requireJobCardReadAccess\(jobCardId\);/);
});

test("every way a note, reply or change happens reaches the notifier, and none can fail because of it", () => {
  const db = read("src/lib/db.ts");
  assert.match(db, /if \(args\.data\?\.direction === "inbound"\) \{\s*try \{\s*const \{ onInboundMessage \} = await import\("\.\/collaboration"\);/);
  assert.match(read("src/lib/collaboration.ts"), /export function notifyWatchersLater[\s\S]*after\(\(\) => work\)/, "after the response, never holding a webhook up");
  const journey = read("src/lib/leadJourneyEvents.ts");
  assert.ok(journey.indexOf("onLeadEvent(trigger, leadId)") < journey.indexOf('isModuleEnabled("marketing")'), "watchers hear even with Marketing off");
  assert.match(read("src/app/actions/communications.ts"), /await tellAboutNote\(\{/);
  assert.match(read("src/app/actions/conversations.ts"), /mentionOn: \{ type: "conversation", id: conversationId \}/, "inbox mentions are finally sent");
  assert.match(read("src/components/ConversationCollab.tsx"), /addConversationNote\(collaboration\.conversationId, note, mentions\)/);
  const jobs = read("src/app/actions/jobcards.ts");
  assert.equal((jobs.match(/notifyWatchersLater\(jobCard\.tenantId, \[\{ type: "jobcard", id: jobCardId \}\], "status"/g) ?? []).length, 2, "status change and completion");
});

test("the new tables are behind the same workspace policy as every other", () => {
  const sql = read("prisma/migrations/20261105160000_mentions_and_watching/migration.sql");
  for (const table of ["StaffNotification", "RecordWatch", "JobCardNote"]) {
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`));
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`));
  }
});
