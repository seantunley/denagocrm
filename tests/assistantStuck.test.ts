import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  QUOTE_UNOPENED_DAYS,
  STUCK_LEGEND,
  STUCK_ORDER,
  conversationFacts,
  rankStuckReasons,
  setAsideNotes,
  stageFacts,
  stuckReasons,
  waitingOn,
  type StuckInput,
  type StuckKind,
  type StuckQuote,
} from "../src/lib/assistantStuck";
import { CATCH_UP_LEGEND, CATCH_UP_MAX_ITEMS, catchUpSince, messagesByCustomer, newestFirst, quoteNews, taskList } from "../src/lib/assistantCatchUp";
import { ANSWER_RULES, assistantStep, lookupStatus, planInstructions } from "../src/lib/crmAssistantPlan";
import { fastPath } from "../src/lib/assistantFastPath";
import { researchGate } from "../src/lib/assistantResearchGate";
import { selfKnowledge } from "../src/lib/assistantSoul";

// "Why is this deal stuck?" and "Catch me up" — both read straight from the records by fixed rules; DAX only
// writes them up, and may state as fact only what they list.

const NOW = new Date("2026-11-02T08:00:00Z"); // Monday 10:00 in South Africa
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const base: StuckInput = {
  now: NOW, leadId: "lead1", status: "open", createdAt: ago(60), signals: [], setAside: new Map(), quote: null,
  deliveries: true, lastIn: null, lastOut: null, lastContactAt: ago(1),
};
const quote: StuckQuote = {
  id: "q1", number: 1031, status: "sent", sentAt: ago(3), viaLink: true, emailOpen: null, emailBounced: false, openedAt: null, signedAt: null,
  declinedAt: null, declineReason: null, changeRequestedAt: null, changeRequestNote: null,
  invoicedAt: null, depositPaidAt: null, deliveryScheduledFor: null, deliveredAt: null,
};

/* ── Why is this deal stuck? ─────────────────────────────────────────────── */

test("RANKED: most pressing kind first — customer waiting > overdue task > quote unopened > stage limit > no next step > quiet", () => {
  const pos = (k: StuckKind) => STUCK_ORDER.indexOf(k);
  for (const [a, b] of [["customer_waiting", "overdue_task"], ["overdue_task", "quote_unopened"], ["quote_unopened", "stage_age"], ["stage_age", "no_next_step"], ["no_next_step", "customer_quiet"]] as const) {
    assert.ok(pos(a) < pos(b), `${a} before ${b}`);
  }
  const r = (kind: StuckKind, days: number | null) => ({ kind, why: kind, date: days === null ? null : ago(days), link: "/x" });
  const ranked = rankStuckReasons([r("customer_quiet", 9), r("stage_age", 30), r("no_next_step", null), r("overdue_task", 1), r("overdue_task", 5), r("customer_waiting", 2), r("quote_unopened", 4)]);
  assert.deepEqual(ranked.map((x) => x.kind), ["customer_waiting", "overdue_task", "overdue_task", "quote_unopened", "stage_age", "no_next_step", "customer_quiet"]);
  assert.equal(ranked[1].date?.getTime(), ago(5).getTime(), "within a kind, the one waiting longest first");
});

test("ONE RULE, ONE PLACE: the Attention Centre's signals become reasons verbatim, with their own date and link", () => {
  const reasons = stuckReasons({
    ...base,
    signals: [
      { kind: "stage_age", key: "stage_age", detail: "In this stage 30 days — past the 14-day mark", since: ago(30).toISOString(), actionHref: "/leads/lead1" },
      { kind: "unanswered_inbound", key: "unanswered_inbound:conv1", detail: "Customer wrote on WhatsApp 2d ago and has had no reply", since: ago(2).toISOString(), actionHref: "/inbox?conversation=conv1" },
      { kind: "no_next_step", key: "no_next_step", detail: "No next step planned", actionHref: "/leads/lead1#activities" },
    ],
    setAside: new Map([["stage_age", 'snoozed until 2026-11-19: "In Italy"']]),
  });
  assert.deepEqual(reasons.map((r) => [r.kind, r.why, r.link]), [
    ["customer_waiting", "Customer wrote on WhatsApp 2d ago and has had no reply", "/inbox?conversation=conv1"],
    ["stage_age", "In this stage 30 days — past the 14-day mark", "/leads/lead1"],
    ["no_next_step", "No next step planned", "/leads/lead1#activities"],
  ]);
  assert.equal(reasons[0].date?.getTime(), ago(2).getTime());
  assert.equal(reasons[1].setAside, 'snoozed until 2026-11-19: "In Italy"', "someone set it aside, and said why");
  assert.equal(reasons[2].date, null);
});

test("THE QUOTE: unopened only after QUOTE_UNOPENED_DAYS; a bounce, a change asked for, a decline — never a draft or a signed one", () => {
  const kinds = (q: Partial<StuckQuote>) => stuckReasons({ ...base, quote: { ...quote, ...q } }).map((r) => r.kind);
  const [unopened] = stuckReasons({ ...base, quote });
  assert.equal(unopened.why, "Q-1031 went out 3 days ago (2026-10-30) and the customer hasn't opened it");
  assert.equal(unopened.link, "/quotes/q1");
  assert.deepEqual(kinds({ sentAt: ago(QUOTE_UNOPENED_DAYS - 1) }), [], "too soon to say");
  assert.deepEqual(kinds({ openedAt: ago(1) }), [], "she opened it");
  assert.deepEqual(kinds({ sentAt: null, status: "draft" }), [], "a draft never sent cannot be unopened");
  assert.deepEqual(kinds({ emailBounced: true }), ["quote_bounced"], "a bounce says more than 'not opened'");
  assert.deepEqual(kinds({ emailOpen: "opened" }), [], "the email that carried it was opened: never say she hasn't");
  // An emailed PDF can be read without a trace: only its email's open tracking speaks, and never as proof.
  const emailed = (emailOpen: StuckQuote["emailOpen"]) => stuckReasons({ ...base, quote: { ...quote, viaLink: false, emailOpen } }).map((r) => r.why);
  assert.deepEqual(emailed("not_detected"), ["Q-1031 was emailed 3 days ago (2026-10-30) and no open of that email has been detected"]);
  assert.deepEqual(emailed("untracked"), [], "no tracking: nothing can be said");
  assert.deepEqual(emailed(null), [], "no email found and no link: nothing can be said");
  const changes = stuckReasons({ ...base, quote: { ...quote, openedAt: ago(5), changeRequestedAt: ago(4), changeRequestNote: "Black, not grey" } });
  assert.deepEqual(changes.map((r) => [r.kind, r.why]), [["changes_requested", 'The customer asked for changes to Q-1031: "Black, not grey" — no revised quote since']]);
  const declined = stuckReasons({ ...base, quote: { ...quote, status: "declined", openedAt: ago(5), declinedAt: ago(2), declineReason: "Too expensive" } });
  assert.deepEqual(declined.map((r) => [r.kind, r.why]), [["quote_declined", 'The customer declined Q-1031: "Too expensive"']]);
  assert.deepEqual(kinds({ status: "accepted", signedAt: ago(1), openedAt: ago(2), invoicedAt: ago(1), depositPaidAt: ago(1), deliveryScheduledFor: new Date(NOW.getTime() + 3 * DAY) }), [], "signed, paid, delivery booked ahead: nothing holds it up");
});

test("AFTER SIGNING: the deliveries board's own rule — invoice, deposit, booking, a delivery date gone by — only with the board on", () => {
  const signed: StuckQuote = { ...quote, status: "accepted", signedAt: ago(10), openedAt: ago(12) };
  const why = (q: Partial<StuckQuote>) => stuckReasons({ ...base, status: "won", quote: { ...signed, ...q } }).map((r) => r.why);
  assert.deepEqual(why({}), ["Q-1031 was signed on 2026-10-23 but hasn't been invoiced yet"]);
  assert.deepEqual(why({ invoicedAt: ago(8) }), ["Q-1031 was invoiced on 2026-10-25 and the deposit hasn't been marked paid"]);
  assert.deepEqual(why({ invoicedAt: ago(8), depositPaidAt: ago(5) }), ["The deposit on Q-1031 was paid on 2026-10-28 but delivery hasn't been booked"]);
  assert.deepEqual(why({ invoicedAt: ago(8), depositPaidAt: ago(5), deliveryScheduledFor: ago(2) }), ["Delivery of Q-1031 was booked for 2026-10-31 and hasn't been marked delivered"]);
  assert.deepEqual(why({ invoicedAt: ago(8), depositPaidAt: ago(5), deliveryScheduledFor: ago(2), deliveredAt: ago(1) }), []);
  assert.deepEqual(stuckReasons({ ...base, status: "won", deliveries: false, quote: signed }), [], "no deliveries board: those dates are never kept, so they say nothing");
});

test("QUIET: the customer's silence after the Today queue's NO_CONTACT_DAYS — never while they wait on us, never on a won deal", () => {
  const quiet = (input: Partial<StuckInput>) => stuckReasons({ ...base, ...input }).filter((r) => r.kind === "customer_quiet").map((r) => r.why);
  assert.deepEqual(quiet({ lastIn: { at: ago(12), channel: "whatsapp" }, lastOut: { at: ago(9), channel: "whatsapp" }, lastContactAt: ago(9) }), ["Our last message (whatsapp, 2026-10-24) has had no reply — no contact for 9 days"]);
  assert.deepEqual(quiet({ lastOut: { at: ago(3), channel: "email" }, lastContactAt: ago(3) }), [], "not quiet for long enough yet");
  assert.deepEqual(quiet({ lastIn: { at: ago(9), channel: "whatsapp" }, lastOut: { at: ago(12), channel: "email" }, lastContactAt: ago(9) }), [], "they wrote last: it is us they are waiting on");
  assert.deepEqual(quiet({ lastContactAt: ago(10) }), ["No contact with the customer for 10 days"], "a call or meeting was the last contact");
  assert.deepEqual(quiet({ lastContactAt: null, createdAt: ago(20) }), ["No message, call or meeting with the customer is logged on this deal (added 20 days ago)"]);
  assert.deepEqual(quiet({ lastContactAt: null, createdAt: ago(1) }), [], "a brand-new lead isn't stuck");
  assert.deepEqual(quiet({ status: "won", lastContactAt: ago(30) }), []);
});

test("PARKED: a deal put in nurture says so first, with the reason given and when it is reviewed", () => {
  const reasons = stuckReasons({ ...base, status: "nurture", parked: { since: ago(14), reason: "Waiting for his bonus in December", reviewAt: new Date("2026-12-01T08:00:00Z") }, lastContactAt: ago(14) });
  assert.equal(reasons[0].kind, "parked");
  assert.equal(reasons[0].why, 'Parked in nurture on 2026-10-19: "Waiting for his bonus in December" — review due 2026-12-01');
});

test("SET ASIDE: read with the Attention Centre's own parser — a snooze that has run out is not one", () => {
  const notes = setAsideNotes({
    stage_age: { kind: "stage_age", signalKey: "stage_age", state: "snoozed", reason: "In Italy until the 19th", snoozedUntil: "2026-11-19T08:00:00.000Z", snoozeCount: 1 },
    no_next_step: { kind: "no_next_step", signalKey: "no_next_step", state: "snoozed", reason: "Old snooze, over now", snoozedUntil: "2026-10-01T08:00:00.000Z", snoozeCount: 1 },
    "overdue_task:a1": { kind: "overdue_task", signalKey: "overdue_task:a1", state: "dismissed", reason: "Done by phone, not logged", dismissedAt: "2026-10-30T08:00:00.000Z", snoozeCount: 0 },
  }, NOW);
  assert.deepEqual([...notes.entries()], [
    ["stage_age", 'snoozed until 2026-11-19: "In Italy until the 19th"'],
    ["overdue_task:a1", 'dismissed on 2026-10-30: "Done by phone, not logged"'],
  ]);
  assert.equal(setAsideNotes(null, NOW).size, 0);
});

test("FACTS: days in the stage against its limit (or plainly none); the last word each way and who is waiting", () => {
  assert.deepEqual(stageFacts({ name: "Quoted", staleAfterDays: 14 }, ago(20), NOW), { name: "Quoted", since: "2026-10-13", days: 20, limitDays: 14, overTheLimit: true });
  const none = stageFacts({ name: "New", staleAfterDays: null }, ago(3), NOW);
  assert.ok("limit" in none && /no time limit set/.test(none.limit), JSON.stringify(none));
  assert.ok(!("overTheLimit" in none));
  assert.equal(waitingOn({ at: ago(1) }, { at: ago(2) }), "us");
  assert.equal(waitingOn({ at: ago(3) }, { at: ago(2) }), "customer");
  assert.equal(waitingOn(null, null), null);
  const facts = conversationFacts({ at: ago(1), channel: "whatsapp" }, { at: ago(2), channel: "email" }, ago(1), NOW);
  assert.deepEqual(facts.lastFromCustomer, { when: "2026-11-01 10:00", channel: "whatsapp" });
  assert.match(facts.waitingOn, /^us — the customer wrote last/);
  assert.equal(facts.lastContact, "2026-11-01 10:00 (yesterday)");
  assert.equal(conversationFacts(null, null, null, NOW).waitingOn, "nobody — no messages either way");
});

test("HONESTY: the ranked reasons are the only ones stated as fact; anything else is 'My read:'", () => {
  assert.match(STUCK_LEGEND, /They are the ONLY reasons you may state as fact/);
  assert.match(STUCK_LEGEND, /start it with "My read:"/);
  assert.match(STUCK_LEGEND, /each with its date and its link/);
  assert.match(STUCK_LEGEND, /`financeMentions`[^.]*not a reason on their own/);
  assert.ok(ANSWER_RULES.includes("they are the ONLY reasons you may state as fact; anything else you suspect is \"My read:\""));
  assert.ok(ANSWER_RULES.includes("if nothing changed say so plainly"));
});

/* ── Catch me up ─────────────────────────────────────────────────────────── */

test("THE WINDOW: since their last question, at most 7 days back; the last 24 hours with none; a day they name replaces it", () => {
  assert.deepEqual(catchUpSince(NOW, ago(1), null), { since: ago(1), basis: "their last question to DAX" });
  const capped = catchUpSince(NOW, ago(30), null);
  assert.equal(capped.since.getTime(), ago(7).getTime());
  assert.match(capped.basis, /at most 7 days/);
  const first = catchUpSince(NOW, null, null);
  assert.equal(first.since.getTime(), NOW.getTime() - 24 * 3_600_000);
  assert.match(first.basis, /last 24 hours/);
  assert.equal(catchUpSince(NOW, ago(1), "2026-10-30").since.toISOString(), "2026-10-29T22:00:00.000Z", "Friday from midnight, South African time");
  assert.equal(catchUpSince(NOW, ago(1), "2026-09-01").since.getTime(), ago(7).getTime(), "never more than 7 days back");
  assert.equal(catchUpSince(NOW, ago(1), "2026-12-01").since.toISOString(), "2026-11-01T22:00:00.000Z", "a day still to come: today");
});

test("MESSAGES: one item per customer — how many, which channels, the latest words, and whether anyone answered since", () => {
  const m = (key: string, at: Date, extra: Record<string, unknown> = {}) => ({ at, channel: "whatsapp", text: `hi from ${key}`, customerKey: key, customer: key, link: `/leads/${key}`, leadId: key, contactId: `c-${key}`, ...extra });
  const items = messagesByCustomer(
    [m("Anna", ago(0.5)), m("Anna", ago(0.8), { channel: "email", text: "older" }), m("Ben", ago(0.3))],
    [{ at: ago(0.2), leadId: null, contactId: "c-Anna", bot: false }, { at: ago(0.1), leadId: "Ben", contactId: null, bot: true }],
  );
  const anna = items.find((i) => i.customer === "Anna")!;
  assert.equal(anna.what, "Anna wrote 2 messages (whatsapp, email)");
  assert.equal(anna.latest, "hi from Anna");
  assert.equal(anna.at.getTime(), ago(0.5).getTime());
  assert.equal(anna.replied, "yes — 2026-11-02 05:12", "a person answered, after her latest message");
  assert.match(String(items.find((i) => i.customer === "Ben")!.replied), /^only the chatbot — /);
  assert.equal(messagesByCustomer([m("Cara", ago(0.5))], [{ at: ago(0.9), leadId: "Cara", contactId: null, bot: false }])[0].replied, "not yet", "a reply BEFORE their message doesn't answer it");
});

test("QUOTES: first open, opened again (never once signed), signed, declined — only inside the window", () => {
  const since = ago(1);
  const q = { id: "q1", number: 1031, customer: "Anna", viewedAt: ago(0.5), signedAt: null, declinedAt: null, declineReason: null, changeRequestedAt: null, changeRequestNote: null, revisits: [ago(0.4), ago(0.2)] };
  assert.deepEqual(quoteNews(q, since).map((i) => i.what), ["Anna opened Q-1031 for the first time", "Anna opened Q-1031 again (2 times)"]);
  assert.equal(quoteNews(q, since)[1].at.getTime(), ago(0.2).getTime(), "dated by the latest time back");
  assert.deepEqual(quoteNews({ ...q, viewedAt: ago(3), revisits: [ago(0.4)] }, since).map((i) => i.what), ["Anna opened Q-1031 again"]);
  assert.deepEqual(quoteNews({ ...q, viewedAt: ago(3), signedAt: ago(0.1) }, since).map((i) => i.what), ["Anna signed Q-1031"], "back at a signed quote is not news");
  assert.deepEqual(quoteNews({ ...q, viewedAt: ago(3), revisits: [], declinedAt: ago(0.1), declineReason: "Too pricey" }, since).map((i) => [i.what, i.reason]), [["Anna declined Q-1031", "Too pricey"]]);
  assert.equal(quoteNews({ ...q, viewedAt: ago(3), revisits: [ago(2)] }, since).length, 0, "nothing inside the window");
  assert.equal(quoteNews(q, since)[0].link, "/quotes/q1");
});

test("ORDER: newest first, capped, each with its South African time; tasks overdue first, then today's", () => {
  const many = Array.from({ length: CATCH_UP_MAX_ITEMS + 3 }, (_, i) => ({ at: ago(i / 10), type: "deal" as const, what: `e${i}`, link: "/x" }));
  const { items, cut } = newestFirst([...many].reverse());
  assert.equal(items[0].what, "e0");
  assert.equal(items[0].when, "2026-11-02 10:00");
  assert.ok(!("at" in items[0]));
  assert.equal(items.length, CATCH_UP_MAX_ITEMS);
  assert.equal(cut, 3);
  const tasks = taskList([
    { summary: "Call Anna", type: "call", dueDate: new Date("2026-11-02T12:00:00Z"), customer: "Anna", link: "/leads/a" },
    { summary: "Morning check-in", type: "call", dueDate: new Date("2026-11-02T05:00:00Z"), customer: null, link: "/activities" },
    { summary: "Send brochure", type: "todo", dueDate: ago(3), customer: null, link: "/activities" },
  ], NOW);
  assert.deepEqual(tasks.map((t) => [t.summary, t.overdue ?? false]), [["Send brochure", true], ["Morning check-in", false], ["Call Anna", false]], "07:00 today is due today, not overdue");
  assert.match(CATCH_UP_LEGEND, /say plainly that nothing has changed since then/);
  assert.match(CATCH_UP_LEGEND, /Never add anything that is not listed/);
});

/* ── Wiring, access and read-only — pinned on the source ─────────────────── */

test("PLANNER: two lookups with strict arguments, described for their questions; 'catch me up' skips the research round", () => {
  assert.ok(assistantStep.safeParse({ tool: "stuck", args: { lead: "Anna" } }).success);
  assert.ok(!assistantStep.safeParse({ tool: "stuck", args: {} }).success);
  assert.ok(!assistantStep.safeParse({ tool: "stuck", args: { lead: "Anna", userId: "x" } }).success, "nothing outside the schema");
  assert.ok(assistantStep.safeParse({ tool: "catch_up" }).success, "no arguments needed");
  assert.ok(assistantStep.safeParse({ tool: "catch_up", args: { since: "2026-10-30" } }).success);
  assert.ok(!assistantStep.safeParse({ tool: "catch_up", args: { since: "last week" } }).success);
  assert.ok(!assistantStep.safeParse({ tool: "catch_up", args: { userId: "someone-else" } }).success, "never another person's");
  const plan = planInstructions({ today: "2026-11-02", userName: "Sean", stages: [], staff: [], activityTypes: [] });
  assert.match(plan, /- stuck: \{"lead":/);
  assert.match(plan, /"why is X stuck \/ stalled \/ not moving \/ gone quiet \/ not closing"/);
  assert.match(plan, /- catch_up: /);
  assert.match(plan, /"catch me up", "what's changed", "what did I miss", "anything new \(since…\)"/);
  assert.equal(lookupStatus([{ tool: "stuck", args: { lead: "Anna" } }]), "Working out what's holding it up…");
  assert.equal(lookupStatus([{ tool: "catch_up" }]), "Catching you up…");
  for (const q of ["Catch me up", "Hey DAX, catch me up please", "what's changed?", "What did I miss", "anything new since I last asked?", "whats new", "any updates for me"]) {
    assert.deepEqual(fastPath(q, { userName: "Sean", pageLead: null }), [{ tool: "catch_up", args: {} }], q);
  }
  for (const q of ["anything new since Friday?", "catch me up on Anna", "what's changed on the Rover XL quote"]) {
    assert.equal(fastPath(q, { userName: "Sean", pageLead: null }), null, `${q} — a named day or customer goes the normal way`);
  }
  // A stuck result IS the evidence a "why is it stuck" question needs: no forced extra round after it.
  assert.equal(researchGate({ question: "Why is the Jacobs deal stuck?", tools: ["stuck"], lastRoundEmpty: false, planSaysAnswer: true, stepsUsed: 1, maxSteps: 8 }), "answer");
  assert.equal(researchGate({ question: "Why is the Jacobs deal stuck?", tools: ["find_leads"], lastRoundEmpty: false, planSaysAnswer: true, stepsUsed: 1, maxSteps: 8 }), "continue", "a list alone still isn't");
  const assistant = readFileSync("src/lib/crmAssistant.ts", "utf8");
  assert.match(assistant, /case "stuck": return stuckLookup\(user, step\.args\.lead\);/);
  assert.match(assistant, /case "catch_up": return catchUpLookup\(user, step\.args\.since\);/);
});

test("SELF-KNOWLEDGE and HELP: DAX can say it does both", () => {
  const about = selfKnowledge("DAX", new Set(["core"]));
  assert.match(about, /say why ONE deal is stuck — its blockers ranked, each with its date and a link to its record/);
  assert.match(about, /catch the person up on what changed on their own deals since they last asked you/);
  const help = readFileSync("src/lib/help/articles/assistant-and-more.ts", "utf8");
  assert.match(help, /Why is Anna's deal stuck\?/);
  assert.match(help, /Catch me up/);
});

const source = (rel: string) => readFileSync(rel, "utf8").replace(/\/\*\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const stuck = source("src/lib/assistantStuckLookup.ts");
const catchUp = source("src/lib/assistantCatchUpLookup.ts");

test("READ-ONLY: both lookups write nothing, use only the tenant-scoped client and log nothing", () => {
  for (const code of [stuck, catchUp]) {
    assert.doesNotMatch(code, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|basePrisma|logAudit|logError|console\./);
    assert.match(code, /import \{ prisma \} from "\.\/db";/);
  }
});

test("STUCK sees no more than the person may open", () => {
  // Only a deal in their own list, found by id or by name.
  assert.match(stuck, /const ids = await getAccessibleLeadIds\(user\);[\s\S]{0,300}\.\.\.\(ids === null \? \{\} : \{ id: \{ in: ids \} \}\)/);
  // The customer's own rows only when they may open that customer — the lead page's rule.
  assert.match(stuck, /\(await canAccessContact\(user, lead\.contactId\)\) \? lead\.contactId : null/);
  assert.match(stuck, /dealTimelineWhere\(\{ id: lead\.id, contactId \}\)/);
  // A quote only when they may open it — and a quote warning likewise.
  assert.match(stuck, /getAccessibleQuoteIds\(user\)/);
  assert.match(stuck, /\.\.\.\(quoteIds === null \? \{\} : \{ id: \{ in: quoteIds \} \}\)/);
  assert.match(stuck, /if \(s\.kind !== "quote_expiring"\) return true;[\s\S]{0,120}quoteIds === null \|\| quoteIds\.includes\(id\)/);
  // The Attention Centre's own signals, and only for an open deal, as its list.
  assert.match(stuck, /lead\.status === "open"\s*\? collectAttentionSignals\(/);
  // "Opened" is the customer, never a colleague countersigning.
  assert.match(stuck, /memoCustomer\(\(r\) => isCustomerSigner\(r, ownedWriteTenantId\(\)\)\)/);
});

test("CATCH-UP is the person's own: their own questions, their own deals as the brief counts them, inside their own lists", () => {
  assert.match(catchUp, /assistantTurn\.findFirst\(\{\s*where: \{ userId: user\.id, source: \{ in: \["chat", "whatsapp"\] \}, createdAt: \{ lt: now \} \}/);
  assert.match(catchUp, /\.\.\.\(leadIds === null \? \{\} : \{ id: \{ in: leadIds \} \}\), OR: \[\{ assignedToId: user\.id \}, \{ assignedToId: null \}\]/);
  for (const helper of ["getAccessibleLeadIds(user)", "getAccessibleContactIds(user)", "getAccessibleQuoteIds(user)"]) assert.ok(catchUp.includes(helper), helper);
  // Customers they own, only those they may open; a deal's messages and its customer's on no deal.
  assert.match(catchUp, /ownerId: user\.id, \.\.\.\(contactIds === null \? \{\} : \{ id: \{ in: contactIds \} \}\)/);
  assert.match(catchUp, /const filedOnMine = \{ OR: \[\{ leadId: \{ in: mineLeadIds \} \}, \{ leadId: null, contactId: \{ in: mineContactIds \} \}\] \};/);
  // Quotes: inside the access list, and only theirs.
  assert.match(catchUp, /\.\.\.\(quoteIds === null \? \{\} : \{ id: \{ in: quoteIds \} \}\),\s*AND: \[/);
  // Moves made by someone else (a person or the CRM) — never their own.
  assert.match(catchUp, /OR: \[\{ userId: null \}, \{ userId: \{ not: user\.id \} \}\]/);
  // Opened again: the customer, never a colleague.
  assert.match(catchUp, /memoCustomer\(\(r\) => isCustomerSigner\(r, ownedWriteTenantId\(\)\)\)/);
  // Their tasks: assigned to them or attending, behind the activities permission.
  assert.match(catchUp, /hasAnyPermission\(user, "activities\.view", "activities\.manage"\)/);
  assert.match(catchUp, /OR: \[\{ assignedToId: user\.id \}, \{ attendees: \{ some: \{ userId: user\.id \} \} \}\]/);
});
