import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { claimCard, parseTriageReply, REPLACED_RUN, runnable, settleStale, statusAfter, triageOutcome, TRIAGE_STALE_MS, type TriageItem } from "../src/lib/triageRules";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const item = (leadId: string, cards: TriageItem["cards"]): TriageItem => ({ leadId, name: leadId, opportunity: null, ownerName: null, reasons: [], why: null, cards });
const c = (id: string, kind: string, status: TriageItem["cards"][number]["status"], extra: Record<string, unknown> = {}) =>
  ({ card: { id, kind, title: id, leadId: "l1", leadLabel: "x", ...extra }, status, ...extra }) as unknown as TriageItem["cards"][number];

test("DAX's reply is kept only for the deals it was given, in triage's kinds, at most two each", () => {
  const reply = `Here you go {"deals":[
    {"leadId":"clead0000aaaa","why":"Waiting 3 days for a price","actions":[
      {"type":"draft_message","channel":"whatsapp","body":"Hi Lee, the price is on its way","reason":"waiting"},
      {"type":"follow_up","when":"2026-11-06T09:00","activity":"call","summary":"Call Lee","reason":"keeps it moving"},
      {"type":"note","text":"third one","reason":"keeps it moving"}]},
    {"leadId":"clead0000bbbb","actions":[{"type":"lost","reason":"model got ideas"},{"type":"assign","leadId":"clead0000else","to":"Thabo","reason":"keeps it moving"}]},
    {"leadId":"clead0000evil","actions":[{"type":"note","text":"x","reason":"keeps it moving"}]}
  ]}`;
  const parsed = parseTriageReply(reply, ["clead0000aaaa", "clead0000bbbb"]);
  assert.deepEqual([...parsed.keys()], ["clead0000aaaa", "clead0000bbbb"], "a deal it wasn't given is ignored");
  assert.equal(parsed.get("clead0000aaaa")!.actions.length, 2, "two at most");
  assert.equal(parsed.get("clead0000aaaa")!.why, "Waiting 3 days for a price");
  const b = parsed.get("clead0000bbbb")!.actions;
  assert.equal(b.length, 1, "'lost' isn't a triage kind");
  assert.equal((b[0] as { leadId: string }).leadId, "clead0000bbbb", "a proposal is pinned to its own deal, whatever lead it names");
  assert.equal(parseTriageReply("not json", ["clead0000aaaa"]).size, 0);
});

test("a batch never sends a message, and never runs a card twice", () => {
  const items = [item("l1", [
    c("draft", "draft_message", "proposed"),
    c("todo", "follow_up", "proposed"),
    c("again", "follow_up", "failed"),
    c("didit", "follow_up", "done"),
    c("hmm", "assign", "unsure"),
    c("busy", "note", "running"),
  ])];
  const ids = runnable(items, new Set(["draft", "todo", "again", "didit", "hmm", "busy"])).map((r) => r.entry.card.id);
  assert.deepEqual(ids, ["todo", "again"], "only waiting or refused-with-nothing-changed; messages have their own Send");
  assert.deepEqual(runnable(items, new Set(["todo"])).map((r) => r.entry.card.id), ["todo"], "only what was ticked");
});

test("what a Confirm's answer means for the card", () => {
  assert.equal(statusAfter({ ok: true }), "done");
  assert.equal(statusAfter({ ok: false, unchanged: true }), "failed", "refused before changing anything: may be ticked again");
  assert.equal(statusAfter({ ok: false }), "unsure", "may have got part-way: never retried on its own");
});

test("a card whose request died is marked unsure, not retried", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const old = new Date(now.getTime() - TRIAGE_STALE_MS - 1000).toISOString();
  const fresh = new Date(now.getTime() - 1000).toISOString();
  const items = [item("l1", [{ ...c("a", "follow_up", "running"), claimedAt: old }, { ...c("b", "follow_up", "running"), claimedAt: fresh }])];
  assert.equal(settleStale(items, now), true);
  assert.deepEqual(items[0].cards.map((x) => x.status), ["unsure", "running"]);
});

test("the outcome: deals acted on, and how many customers replied since", () => {
  const items = [item("l1", [c("a", "follow_up", "done")]), item("l2", [c("b", "draft_message", "sent")]), item("l3", [c("c", "note", "proposed")])];
  assert.deepEqual(triageOutcome(items, new Set(["l2", "l3"])), { acted: 2, replied: 1 });
});

test("two tabs: once a newer triage is prepared, the older tab can neither do nor send anything (review of #1007)", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const run = () => ({ preparedAt: now.toISOString(), items: [item("l1", [c("todo", "follow_up", "proposed"), c("msg", "draft_message", "proposed")])] });
  // Tab A still shows run A; tab B prepared run B, which closed A.
  const runA = run();
  for (const [cardId, send] of [["todo", false], ["msg", true]] as const) {
    const claim = claimCard(runA, "closed", cardId, send, now);
    assert.deepEqual(claim, { ok: false, error: REPLACED_RUN });
  }
  assert.deepEqual(runA.items[0].cards.map((x) => x.status), ["proposed", "proposed"], "nothing on the old run moved");
  // The current run works — once per card, and a message only through Send.
  const runB = run();
  assert.equal(claimCard(runB, "open", "todo", false, now).ok, true);
  assert.equal(runB.items[0].cards[0].status, "running");
  assert.equal(claimCard(runB, "open", "todo", false, now).ok, false, "the second click finds it taken");
  assert.equal(claimCard(runB, "open", "msg", false, now).ok, false, "a batch never sends");
  assert.equal(claimCard(runB, "open", "msg", true, now).ok, true);
});

test("every card runs through the ordinary Confirm path, claimed under the row lock", () => {
  const lib = read("src/lib/assistantTriage.ts");
  assert.match(lib, /SELECT "id" FROM "AssistantTask" WHERE "id" = \$\{taskId\} AND "tenantId" = \$\{tenantId\} AND "userId" = \$\{userId\} FOR UPDATE/);
  // The run's status is read inside that locked transaction, and every claim goes through claimCard with it.
  assert.match(lib, /select: \{ details: true, status: true \} \}\);[\s\S]*?if \(change\(run, row\.status\)\)/);
  assert.equal((lib.match(/claimCard\(d, status, cardId, (true|false), new Date\(\)\)/g) ?? []).length, 2, "the batch and Send");
  assert.match(lib, /if \(startStatus !== "open"\) return \{ ok: false, error: REPLACED_RUN \};/);
  assert.match(lib, /const result: \{[^}]*\} = await runAssistantAction\(entry\.card\)/);
  // Proposals become cards exactly as an answer's do: names to ids and access, as the person.
  assert.match(lib, /await resolveActions\(user, proposal\.actions\)/);
  // A message goes only from its own Send, through DAX's own send, once per card.
  assert.match(lib, /await sendAssistantDraft\(\{[\s\S]*?compositionId: `triage-\$\{taskId\}-\$\{cardId\}`/);
  // Deals the person can no longer open drop out of the run they see.
  assert.match(lib, /if \(await canAccessLead\(user, item\.leadId\)\) visible\.push\(item\);/);
});

test("preparing replaces the run in one locked step, so two tabs can't leave two open runs (review of #1007)", () => {
  const store = read("src/lib/triageStore.ts");
  const tx = store.slice(store.indexOf("basePrisma.$transaction"));
  const lock = tx.indexOf("pg_advisory_xact_lock(hashtext(${`triage:${tenantId}:${userId}`}))");
  const close = tx.indexOf("tx.assistantTask.updateMany");
  const create = tx.indexOf("tx.assistantTask.create");
  assert.ok(lock > 0 && lock < close && close < create, "lock, then close, then create — all on the one transaction");
  const lib = read("src/lib/assistantTriage.ts");
  assert.match(lib, /const id = await replaceTriageRun\(tenantId, user\.id, /);
  assert.doesNotMatch(lib, /basePrisma\.assistantTask\.(create|updateMany)\(/, "no second, unlocked way to make or close a run");
  // The real-Postgres proof runs in CI's integration lane.
  assert.match(read(".github/workflows/security-rbac-ci.yml"), /scripts\/test-triage-prepare\.ts/);
});

test("triage runs stay out of DAX's job sheets and prompts", () => {
  const tasks = read("src/lib/assistantTask.ts");
  assert.equal((tasks.match(/kind: \{ notIn: \["delivery_goal", "plan", "triage"\] \}/g) ?? []).length, 2);
  assert.match(read("src/app/actions/triage.ts"), /requireAnyPermission\(\.\.\.ASSISTANT_PERMISSIONS\);\s*if \(!\(await isModuleEnabled\("automation"\)\)\)/);
});
