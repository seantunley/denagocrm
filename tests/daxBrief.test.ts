import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_BRIEF_ITEMS,
  MAX_TEAM_ROWS,
  briefForAssistant,
  buildBrief,
  buildTeamRows,
  hotReason,
  type BriefInput,
  type BriefLead,
} from "../src/lib/daxBriefRules";
import { scoreLead } from "../src/lib/leadScore";

/**
 * The DAX brief is deterministic CRM logic, so its promises are testable: the
 * order is Sean's priority list, groups collapse to one line with a count, the
 * count in the headline is honest, and nothing reaching the model carries a
 * phone number or an email address.
 */

// 07:00 in Johannesburg (UTC+2).
const MORNING = new Date("2026-10-06T05:00:00Z");
const ME = "u-me";

function lead(id: string, kinds: BriefLead["signals"][number]["kind"][], extra: Partial<BriefLead> = {}): BriefLead {
  return {
    id,
    name: `Lead ${id}`,
    valueCents: 100_000_00,
    ownerId: ME,
    ownerName: "Sean Tunley",
    signals: kinds.map((kind, i) => ({
      kind,
      detail: `${kind} detail`,
      since: `2026-10-0${1 + i}T08:00:00.000Z`,
      actionHref: `/leads/${id}#${kind}`,
    })),
    ...extra,
  };
}

function input(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    now: MORNING,
    userId: ME,
    userName: "Sean Tunley",
    leads: [],
    hot: [],
    activities: [],
    testDrives: [],
    viewedQuotes: [],
    deliveries: [],
    ...overrides,
  };
}

const keys = (brief: ReturnType<typeof buildBrief>) => brief.items.map((item) => item.key);

test("empty brief says so in one line, with a South African greeting", () => {
  const brief = buildBrief(input());
  assert.deepEqual(brief.items, []);
  assert.equal(brief.summary, "Nothing urgent, a clean slate.");
  assert.equal(brief.headline, "Good morning Sean — nothing urgent, a clean slate.");
  // 15:00 UTC is 17:00 in Johannesburg — evening there, afternoon on a UTC server.
  assert.match(buildBrief(input({ now: new Date("2026-10-06T15:00:00Z") })).headline, /^Good evening Sean/);
});

test("items follow the priority order, whatever order the facts arrive in", () => {
  const brief = buildBrief(
    input({
      leads: [lead("stale", ["stage_age"]), lead("quote", ["quote_expiring"]), lead("late", ["overdue_task"]), lead("wait", ["unanswered_inbound"])],
      hot: [{ id: "warm", name: "Warm Lead", valueCents: 0, reasons: ["Opened the quote yesterday"] }],
      activities: [{ type: "meeting", dueDate: new Date("2026-10-06T10:00:00Z") }],
    }),
  );
  assert.deepEqual(keys(brief), ["waiting", "today", "overdue", "hot", "quote_expiring", "stale"]);
  assert.equal(brief.items[0].tone, "red");
});

test("a group collapses to one line: the count, and the oldest example named", () => {
  const older = lead("a", ["unanswered_inbound"], { name: "Anna Jacobs" });
  older.signals[0].since = "2026-10-01T00:00:00.000Z";
  older.signals[0].detail = "Customer wrote on WhatsApp 6h ago and has had no reply";
  const newer = lead("b", ["unanswered_inbound"]);
  newer.signals[0].since = "2026-10-05T00:00:00.000Z";
  const brief = buildBrief(input({ leads: [newer, older] }));
  assert.equal(brief.items.length, 1);
  const [item] = brief.items;
  assert.equal(item.title, "2 customers waiting for a reply");
  assert.equal(item.count, 2);
  assert.equal(item.detail, "Anna Jacobs — Customer wrote on WhatsApp 6h ago and has had no reply");
  assert.equal(item.href, "/inbox", "several → the list");
  // One → straight to it.
  assert.equal(buildBrief(input({ leads: [older] })).items[0].href, "/leads/a#unanswered_inbound");
});

test("headline counts only red/orange things, before the cap, and attention value counts each lead once", () => {
  const brief = buildBrief(
    input({
      leads: [lead("a", ["unanswered_inbound", "overdue_task"]), lead("b", ["overdue_task"]), lead("c", ["quote_expiring"]), lead("d", ["stage_age"])],
      hot: [{ id: "h", name: "Hot", valueCents: 0, reasons: ["Opened the quote today"] }],
    }),
  );
  // 1 waiting + 2 overdue + 1 expiring; hot and stale are not "problems".
  assert.equal(brief.summary, "4 things need your attention.");
  assert.equal(brief.headline, "Good morning Sean — 4 things need your attention.");
  assert.equal(brief.attentionValueCents, 4 * 100_000_00);
  assert.equal(buildBrief(input({ hot: [{ id: "h", name: "Hot", valueCents: 0, reasons: ["Replied today"] }] })).summary, "Nothing urgent right now.");
});

test("the brief is capped, dropping the lowest priorities", () => {
  const brief = buildBrief(
    input({
      leads: [lead("a", ["unanswered_inbound", "overdue_task", "quote_expiring", "stage_age"])],
      hot: [{ id: "h", name: "Hot", valueCents: 0, reasons: ["Replied yesterday"] }],
      activities: [{ type: "call", dueDate: new Date("2026-10-06T09:00:00Z") }],
      viewedQuotes: [{ id: "q1", number: 7, leadId: "other", leadName: "Other", viewedAt: MORNING }],
      deliveries: [
        { id: "d1", number: 1, customer: "X", invoicedAt: MORNING, depositPaidAt: MORNING, deliveryScheduledFor: new Date("2026-10-01T00:00:00Z"), deliveredAt: null },
        { id: "d2", number: 2, customer: "Y", invoicedAt: MORNING, depositPaidAt: null, deliveryScheduledFor: null, deliveredAt: null },
      ],
    }),
  );
  assert.equal(brief.items.length, MAX_BRIEF_ITEMS);
  assert.deepEqual(keys(brief), ["waiting", "today", "overdue", "hot", "quote_expiring", "quote_viewed", "delivery_overdue"]);
  // Waiting, overdue, expiring, delivery overdue — the cut groups are info only.
  assert.equal(brief.summary, "4 things need your attention.");
});

test("only my leads and unassigned ones; someone else's deal is not my brief", () => {
  const brief = buildBrief(
    input({ leads: [lead("mine", ["overdue_task"]), lead("free", ["overdue_task"], { ownerId: null }), lead("theirs", ["overdue_task"], { ownerId: "u-other" })] }),
  );
  assert.equal(brief.items[0].count, 2);
});

test("today's agenda counts what is still ahead and names the next test drive", () => {
  const brief = buildBrief(
    input({
      activities: [
        { type: "meeting", dueDate: new Date("2026-10-06T04:00:00Z") }, // 06:00 — already past
        { type: "meeting", dueDate: new Date("2026-10-06T08:00:00Z") },
        { type: "meeting", dueDate: new Date("2026-10-06T09:00:00Z") },
      ],
      testDrives: [{ scheduledStart: new Date("2026-10-06T12:00:00Z"), vehicle: "Rover XL" }],
    }),
  );
  assert.equal(brief.items[0].title, "Today: 2 meetings, 1 test drive (14:00 Rover XL)");
  assert.equal(brief.items[0].tone, "info");
});

test("people are not counted twice across groups", () => {
  const brief = buildBrief(
    input({
      leads: [lead("w", ["unanswered_inbound"]), lead("e", ["quote_expiring"])],
      hot: [
        { id: "w", name: "Waiting", valueCents: 0, reasons: ["Opened the quote today"] },
        { id: "h", name: "Hot", valueCents: 0, reasons: ["Opened the quote today"] },
      ],
      viewedQuotes: [
        { id: "q1", number: 1, leadId: "h", leadName: "Hot", viewedAt: MORNING },
        { id: "q2", number: 2, leadId: "e", leadName: "Expiring", viewedAt: MORNING },
      ],
    }),
  );
  assert.equal(brief.items.find((i) => i.key === "hot")?.count, 1, "the waiting customer is item 1, not also 'close'");
  assert.equal(brief.items.find((i) => i.key === "quote_viewed"), undefined, "already said by hot / expiring");
});

test("'looks close' matches the Today queue's real reasons, not a copy of them", () => {
  const base = {
    valueCents: 0, status: "open", stageName: "Quoted", stageIsClosed: false, daysInStage: 1, staleAfterDays: null,
    lastInboundAt: null, quoteSentNotSigned: true, hasOverdueActivity: false, nextPlannedActivityAt: MORNING, createdAt: new Date("2026-09-01T00:00:00Z"),
  };
  const viewed = scoreLead({ ...base, lastContactAt: new Date("2026-10-05T08:00:00Z"), quoteViewedAt: new Date("2026-10-05T09:00:00Z") }, MORNING);
  assert.ok(hotReason(viewed.reasons), `quote view not recognised in ${JSON.stringify(viewed.reasons)}`);
  const replied = scoreLead(
    { ...base, quoteSentNotSigned: false, quoteViewedAt: null, lastInboundAt: new Date("2026-10-05T08:00:00Z"), lastContactAt: new Date("2026-10-05T09:00:00Z") },
    MORNING,
  );
  assert.ok(hotReason(replied.reasons), `reply not recognised in ${JSON.stringify(replied.reasons)}`);
  const cold = scoreLead({ ...base, quoteSentNotSigned: false, quoteViewedAt: null, lastContactAt: null }, MORNING);
  assert.equal(hotReason(cold.reasons), null);
});

test("team rows: most needing attention first, only my team, capped", () => {
  const leads = [
    lead("1", ["overdue_task"], { ownerId: "u-a", ownerName: "Amy" }),
    lead("2", ["unanswered_inbound"], { ownerId: "u-b", ownerName: "Ben" }),
    lead("3", ["stage_age"], { ownerId: "u-c", ownerName: "Cat", valueCents: 50_00 }),
    lead("4", ["unanswered_inbound"], { ownerId: "u-outsider", ownerName: "Out" }),
  ];
  const rows = buildTeamRows({
    leads,
    pipeline: [{ ownerId: "u-d", valueCents: 10_00 }, { ownerId: "u-a", valueCents: 99_00 }],
    names: new Map([["u-d", "Dee"]]),
    members: new Set(["u-a", "u-b", "u-c", "u-d"]),
  });
  assert.deepEqual(rows.map((r) => r.name), ["Ben", "Amy", "Cat", "Dee"]);
  assert.equal(rows[1].pipelineValueCents, 99_00);
  assert.equal(rows[2].stalledValueCents, 50_00);

  const many = Array.from({ length: 12 }, (_, i) => lead(`m${i}`, ["overdue_task"], { ownerId: `u${i}` }));
  assert.equal(buildTeamRows({ leads: many, pipeline: [], names: new Map(), members: null }).length, MAX_TEAM_ROWS);
});

test("briefForAssistant carries no phone number or email address", () => {
  const phoneLead = lead("p", ["unanswered_inbound"], { name: "+27 82 555 1234" });
  phoneLead.signals[0].detail = "Customer wrote from anna@example.com on WhatsApp";
  const brief = buildBrief(
    input({
      leads: [phoneLead],
      team: [{ userId: "u", name: "0825551234", overdue: 1, waiting: 0, stalledValueCents: 0, pipelineValueCents: 0 }],
    }),
  );
  const text = JSON.stringify(briefForAssistant(brief));
  assert.doesNotMatch(text, /555|@example\.com/);
  assert.match(text, /customer waiting for a reply/);
  assert.ok(!("userId" in (briefForAssistant(brief).team?.[0] ?? {})));
});


test("waiting names the longest wait; other groups name the highest-value deal", () => {
  // Waiting: small but longest wait must be named, not the high-value newer one.
  const longWait = lead("small", ["unanswered_inbound"], { name: "Small Wait", valueCents: 15_000_00 });
  longWait.signals[0].since = "2026-10-01T00:00:00.000Z";
  const highWait = lead("big", ["unanswered_inbound"], { name: "Big Wait", valueCents: 180_000_00 });
  highWait.signals[0].since = "2026-10-05T00:00:00.000Z";
  const waitingBrief = buildBrief(input({ leads: [highWait, longWait] }));
  const waiting = waitingBrief.items.find((i) => i.key === "waiting");
  assert.ok(waiting);
  assert.match(waiting.detail ?? "", /Small Wait/, "longest wait is named even if lower value");
  assert.equal(waiting.exampleValueCents, 15_000_00);
  assert.equal(waiting.valueCents, 15_000_00 + 180_000_00, "group total is the sum");

  // Stale: highest value is named.
  const smallStale = lead("s", ["stage_age"], { name: "Small Stale", valueCents: 10_000_00 });
  const bigStale = lead("b", ["stage_age"], { name: "Big Stale", valueCents: 180_000_00 });
  const staleBrief = buildBrief(input({ leads: [smallStale, bigStale] }));
  const stale = staleBrief.items.find((i) => i.key === "stale");
  assert.ok(stale);
  assert.match(stale.detail ?? "", /Big Stale/);
  assert.equal(stale.exampleValueCents, 180_000_00);

  // Assistant view distinguishes group total from the named example.
  const forModel = briefForAssistant(staleBrief);
  const staleItem = forModel.items.find((i) => i.title.includes("stale"));
  assert.ok(staleItem);
  assert.equal(staleItem.groupValueCents, 10_000_00 + 180_000_00);
  assert.equal(staleItem.exampleValueCents, 180_000_00);
  assert.equal("valueCents" in staleItem, false, "bare valueCents is not sent — it was ambiguous");
});
