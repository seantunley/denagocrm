import test from "node:test";
import assert from "node:assert/strict";
import {
  BREAKPOINT_QUERY,
  BREAKPOINTS,
  CONDITION_KINDS,
  MAX_CONDITION_DEPTH,
  compare,
  conditionMet,
  conditionsMet,
  isSecurityRelevant,
  isServerDecidable,
  needsData,
  parseClock,
  screenBreakpoints,
  withinWindow,
  type Condition,
  type ConditionContext,
  type ConditionOperator,
} from "../src/lib/dashboard/conditions";

/**
 * Guards for dashboard visibility conditions.
 *
 * The module is deliberately free of Prisma and `server-only`, so everything
 * below exercises the real evaluator rather than a restatement of it. Three
 * failures are worth more than all the others put together, and each has its own
 * banner: a condition that does not understand itself FAILING OPEN and revealing
 * a card it was meant to hide, a window that wraps midnight quietly never
 * matching, and `screen` being mistaken for a privacy control when the thing it
 * hides has already been sent to the browser.
 */

function ctx(over: Partial<ConditionContext> = {}): ConditionContext {
  return {
    userId: "user-1",
    role: "sales",
    permissions: new Set<string>(),
    modules: new Set<string>(),
    now: new Date("2026-08-05T09:00:00.000Z"),
    localMinutes: 9 * 60,
    localWeekday: 3,
    ...over,
  };
}

/** A leaf that is true for the default context, for building nests out of. */
const ALWAYS: Condition = { kind: "role", roles: ["sales"] };
/** A leaf that is false for the default context. */
const NEVER: Condition = { kind: "role", roles: ["owner"] };

/* ── an absent list means visible, and entries are AND-ed ─────────── */

test("an absent or empty condition list admits the thing it is attached to", () => {
  // Most cards are unconditional. If `undefined` or `[]` meant "hidden", every
  // caller passing `card.visibility` straight through would blank the dashboard.
  assert.equal(conditionsMet(undefined, ctx()), true, "an absent list must mean visible");
  assert.equal(conditionsMet([], ctx()), true, "an empty list must mean visible");
});

test("multiple top-level entries are AND-ed, not OR-ed", () => {
  // The editor reads "show this card when: X, and: Y". An OR here would show a
  // card to anyone satisfying only the loosest of its conditions — the exact
  // shape of an over-sharing bug that looks like a working feature.
  assert.equal(conditionsMet([ALWAYS, ALWAYS], ctx()), true);
  assert.equal(
    conditionsMet([ALWAYS, NEVER], ctx()),
    false,
    "one unsatisfied entry must hide the card even when the others pass",
  );
  assert.equal(conditionsMet([NEVER, ALWAYS], ctx()), false, "order must not matter");
});

/* ── unknown input fails CLOSED ───────────────────────────────────── */

test("a condition kind this build does not know hides rather than reveals", () => {
  // A config written by a newer release lands in an older one. The cast is the
  // point: there is no way to spell this in the type system, and the runtime is
  // the only place the answer exists. If the evaluator's default were `true`, a
  // downgrade would turn every unrecognised rule into "always show".
  const future = { kind: "geofence", areas: ["hq"] } as unknown as Condition;
  assert.equal(conditionMet(future, ctx()), false, "an unknown kind must hide the card");
  assert.equal(conditionsMet([future], ctx()), false);
  // Control: the known kinds are exactly the ones the union lists, so this test
  // is about a genuinely unknown kind rather than a typo in the fixture.
  assert.ok(
    !(CONDITION_KINDS as readonly string[]).includes("geofence"),
    "the fixture must name a kind this build really does not have",
  );
});

test("an operator this build does not know compares as false", () => {
  // Same failure one level down: `compare`'s default arm. A newer release's
  // operator arriving in a saved filter must not be treated as satisfied.
  const future = "matches_regex" as ConditionOperator;
  assert.equal(compare("anything", future, "anything"), false, "an unknown operator must not match");
  assert.equal(
    conditionMet({ kind: "data", field: "count", operator: future, value: 1 }, ctx({ signals: { count: 1 } })),
    false,
    "a data condition with an unknown operator must hide the card",
  );
});

/* ── grouping: and / or / not ─────────────────────────────────────── */

test("an emptied `or` group is false, not vacuously true", () => {
  // `and` over an empty list is true, which is correct for a top-level list
  // nobody has filled in. Inheriting that for `or` would mean deleting the last
  // branch of a group turns a hidden card ON — a user clearing conditions to
  // narrow a card would widen it instead.
  assert.equal(conditionMet({ kind: "or", conditions: [] }, ctx()), false, "an empty `or` must be false");
  assert.equal(conditionMet({ kind: "and", conditions: [] }, ctx()), true, "an empty `and` stays true");
});

test("`or` is satisfied by any one branch and `and` by all of them", () => {
  assert.equal(conditionMet({ kind: "or", conditions: [NEVER, ALWAYS] }, ctx()), true);
  assert.equal(conditionMet({ kind: "or", conditions: [NEVER, NEVER] }, ctx()), false);
  assert.equal(conditionMet({ kind: "and", conditions: [ALWAYS, ALWAYS] }, ctx()), true);
  assert.equal(conditionMet({ kind: "and", conditions: [ALWAYS, NEVER] }, ctx()), false);
});

test("`not` inverts its child rather than ignoring it", () => {
  // A `not` that returned its child unchanged would be invisible in every test
  // that only ever asserts "hidden": both spellings hide. Assert BOTH directions.
  assert.equal(conditionMet({ kind: "not", condition: NEVER }, ctx()), true);
  assert.equal(conditionMet({ kind: "not", condition: ALWAYS }, ctx()), false);
  assert.equal(
    conditionMet({ kind: "not", condition: { kind: "not", condition: ALWAYS } }, ctx()),
    true,
    "a double negative must come back to the original answer",
  );
});

test("and/or/not nest correctly all the way to the depth cap", () => {
  // MAX_CONDITION_DEPTH is what the parser will accept; the evaluator has to be
  // correct for every tree the parser lets through, or a legal config gets the
  // wrong answer. Built to exactly that depth rather than to a round number.
  assert.equal(MAX_CONDITION_DEPTH, 3, "the fixtures below are written to this cap");
  const deepTrue: Condition = {
    kind: "and",
    conditions: [{ kind: "or", conditions: [NEVER, { kind: "not", condition: NEVER }] }],
  };
  const deepFalse: Condition = {
    kind: "and",
    conditions: [{ kind: "or", conditions: [NEVER, { kind: "not", condition: ALWAYS }] }],
  };
  assert.equal(conditionMet(deepTrue, ctx()), true, "a satisfied tree at the cap must admit");
  assert.equal(conditionMet(deepFalse, ctx()), false, "an unsatisfied tree at the cap must hide");
});

/* ── the leaf kinds ───────────────────────────────────────────────── */

test("user, role, module and permission each match on membership only", () => {
  assert.equal(conditionMet({ kind: "user", users: ["user-1", "user-2"] }, ctx()), true);
  assert.equal(conditionMet({ kind: "user", users: ["user-2"] }, ctx()), false);
  assert.equal(conditionMet({ kind: "role", roles: ["sales", "owner"] }, ctx()), true);
  assert.equal(conditionMet({ kind: "role", roles: ["owner"] }, ctx()), false);
  // `permission` and `module` are ANY-of, matching how the source gates read.
  const held = ctx({ permissions: new Set(["leads.view_all"]), modules: new Set(["core"]) });
  assert.equal(conditionMet({ kind: "permission", permissions: ["leads.view_all", "x"] }, held), true);
  assert.equal(conditionMet({ kind: "permission", permissions: ["x"] }, held), false);
  assert.equal(conditionMet({ kind: "module", modules: ["automotive", "core"] }, held), true);
  assert.equal(conditionMet({ kind: "module", modules: ["automotive"] }, held), false);
});

test("a data condition reads the card's own signals and tolerates their absence", () => {
  const withSignals = ctx({ signals: { count: 3 } });
  assert.equal(
    conditionMet({ kind: "data", field: "count", operator: "greater_than", value: 0 }, withSignals),
    true,
  );
  assert.equal(
    conditionMet({ kind: "data", field: "count", operator: "greater_than", value: 5 }, withSignals),
    false,
  );
  // Above card level there are no signals at all. Reading a missing one must be
  // a miss, not a throw — a section-level data condition is a config mistake,
  // and a config mistake must not take the home page down.
  assert.equal(
    conditionMet({ kind: "data", field: "count", operator: "greater_than", value: 0 }, ctx()),
    false,
    "an absent signal must compare false rather than throw",
  );
  assert.equal(
    conditionMet({ kind: "data", field: "count", operator: "is_empty", value: undefined }, ctx()),
    true,
    "is_empty on an absent signal is the one case that should still be true",
  );
});

/* ── compare(): the numeric arm is where silent wrongness lives ───── */

test("numeric operators coerce both sides instead of falling back to string order", () => {
  // The named failure: "value greater than 90" matching nothing at 100 because
  // "100" < "90" as strings. Both fixtures below have the opposite answer under
  // a lexicographic compare, so a regression to string ordering fails here.
  assert.equal(compare("100", "greater_than", "90"), true, '"100" must be greater than "90"');
  assert.equal(compare("2", "less_than", "10"), true, '"2" must be less than "10"');
  assert.equal(compare(100, "greater_or_equal", 100), true);
  assert.equal(compare(99, "greater_or_equal", 100), false);
  assert.equal(compare(100, "less_or_equal", 100), true);
});

test("a numeric operator refuses when either side will not convert", () => {
  // Refusing is the point. A silent string comparison here would let a text
  // field answer a "more than" question, confidently and wrongly.
  assert.equal(compare("abc", "greater_than", 5), false, "a non-numeric actual must not match");
  assert.equal(compare(5, "greater_than", "abc"), false, "a non-numeric expected must not match");
  assert.equal(compare("abc", "less_than", "abd"), false, "two strings must not string-compare");
  assert.equal(compare(null, "greater_than", 0), false);
  assert.equal(compare("", "greater_than", -1), false, "an empty string is not zero");
  assert.equal(compare(Number.NaN, "greater_than", 0), false);
  assert.equal(compare(Number.POSITIVE_INFINITY, "greater_than", 0), false, "infinity is not a value");
});

test("`in` accepts both a real array and the comma string the editor stores", () => {
  // The editor writes a comma-separated string; a hand-edited config or an older
  // row holds an array. Supporting only one of the two silently drops the filter
  // for whichever half of the configs used the other.
  assert.equal(compare("won", "in", ["open", "won"]), true);
  assert.equal(compare("won", "in", "open, won, lost"), true, "surrounding spaces must be trimmed");
  assert.equal(compare("won", "in", "open,lost"), false);
  assert.equal(compare(2, "in", "1,2,3"), true, "membership is compared as strings on both sides");
});

test("`contains` is substring-and-case-insensitive for text but exact-member for arrays", () => {
  // The two behaviours are not interchangeable. Substring-matching an array of
  // ids would make "lead-1" match "lead-12"; exact-matching a title would make
  // "contains" useless. Both directions are asserted so neither can drift.
  assert.equal(compare("Hello World", "contains", "hello"), true);
  assert.equal(compare("hello world", "contains", "WORLD"), true);
  assert.equal(compare("Hello", "contains", "z"), false);
  assert.equal(compare(["open", "won"], "contains", "open"), true);
  assert.equal(compare(["open", "won"], "contains", "pe"), false, "an array member must match exactly");
  assert.equal(compare(["open"], "contains", "OPEN"), false, "array membership is case-SENSITIVE");
  // not_contains is the exact negation, including for arrays.
  assert.equal(compare(["open", "won"], "not_contains", "open"), false);
  assert.equal(compare("Hello", "not_contains", "z"), true);
});

test("equals compares stringified values so 5 and \"5\" are the same answer", () => {
  assert.equal(compare(5, "equals", "5"), true);
  assert.equal(compare("5", "not_equals", 5), false);
  assert.equal(compare(true, "equals", "true"), true, "a boolean signal must match its stored text");
});

test("is_empty covers null, undefined, blank, whitespace and the empty array", () => {
  // Whitespace is the one people forget. A card configured "hide when the note
  // is empty" would stay visible forever for every row holding a single space.
  for (const empty of [null, undefined, "", "   ", "\t\n", []]) {
    assert.equal(compare(empty, "is_empty", null), true, `${JSON.stringify(empty)} should be empty`);
    assert.equal(compare(empty, "is_not_empty", null), false);
  }
  for (const filled of [0, false, "x", " x ", [0], {}]) {
    assert.equal(compare(filled, "is_empty", null), false, `${JSON.stringify(filled)} should not be empty`);
    assert.equal(compare(filled, "is_not_empty", null), true);
  }
  // 0 and false deserve their own mention: treating them as empty is the classic
  // falsy bug, and on a dashboard it hides exactly the "nothing happened today"
  // card that is worth seeing.
  assert.equal(compare(0, "is_empty", null), false, "zero is a value, not an absence");
  assert.equal(compare(false, "is_empty", null), false, "false is a value, not an absence");
});

/* ── clocks and windows ───────────────────────────────────────────── */

test("parseClock accepts only a real 24-hour HH:MM", () => {
  assert.equal(parseClock("00:00"), 0, "midnight must parse to zero, not to null");
  assert.equal(parseClock("23:59"), 23 * 60 + 59);
  assert.equal(parseClock(" 09:30 "), 570, "surrounding whitespace is trimmed");
  // Each rejection is a different way a hand-edited config goes wrong, and each
  // must yield null rather than NaN — NaN would sail into withinWindow and make
  // every comparison false, hiding the card with no explanation.
  assert.equal(parseClock("24:00"), null, "24:00 is not a time of day");
  assert.equal(parseClock("7:00"), null, "a one-digit hour is rejected rather than guessed at");
  assert.equal(parseClock("09:60"), null, "there is no 60th minute");
  assert.equal(parseClock("aa:bb"), null);
  assert.equal(parseClock(""), null);
  assert.equal(parseClock(undefined), null, "an absent bound is null, which means unbounded");
});

test("withinWindow handles a window that wraps midnight", () => {
  // THE case this function exists for. "After 22:00, before 06:00" describes a
  // night shift; the naive `after <= x && x < before` is empty for every such
  // window, so the card would never appear and only whoever works nights would
  // ever notice.
  const after = parseClock("22:00")!;
  const before = parseClock("06:00")!;
  assert.equal(withinWindow(23 * 60 + 30, after, before), true, "23:30 is inside a 22:00-06:00 window");
  assert.equal(withinWindow(2 * 60, after, before), true, "02:00 is inside it, after the wrap");
  assert.equal(withinWindow(12 * 60, after, before), false, "midday is outside it");
  assert.equal(withinWindow(after, after, before), true, "the start bound is inclusive");
  assert.equal(withinWindow(before, after, before), false, "the end bound is exclusive");
});

test("withinWindow handles a plain non-wrapping window", () => {
  const after = parseClock("09:00")!;
  const before = parseClock("17:00")!;
  assert.equal(withinWindow(12 * 60, after, before), true);
  assert.equal(withinWindow(8 * 60, after, before), false);
  assert.equal(withinWindow(18 * 60, after, before), false);
  assert.equal(withinWindow(after, after, before), true, "the start bound is inclusive");
  assert.equal(withinWindow(before, after, before), false, "the end bound is exclusive");
});

test("withinWindow treats a missing bound as unbounded on that side", () => {
  // Half-open windows are what the editor produces when someone fills in one box
  // and not the other. Defaulting the missing side to midnight would turn "after
  // 22:00" into an empty window.
  assert.equal(withinWindow(23 * 60, 22 * 60, null), true, "after-only: later is inside");
  assert.equal(withinWindow(21 * 60, 22 * 60, null), false, "after-only: earlier is outside");
  assert.equal(withinWindow(5 * 60, null, 6 * 60), true, "before-only: earlier is inside");
  assert.equal(withinWindow(7 * 60, null, 6 * 60), false, "before-only: later is outside");
  assert.equal(withinWindow(13 * 60, null, null), true, "neither bound means always");
  assert.equal(withinWindow(0, null, null), true);
});

test("withinWindow with identical bounds means the whole day, not an empty instant", () => {
  // after === before is what an "all day" window collapses to. Falling through to
  // the wrapping branch would give `x >= t || x < t`, which happens to be every
  // minute anyway — but relying on that accident would break the moment either
  // bound became exclusive. Pinned deliberately.
  const t = parseClock("09:00")!;
  assert.equal(withinWindow(t, t, t), true);
  assert.equal(withinWindow(0, t, t), true);
  assert.equal(withinWindow(23 * 60 + 59, t, t), true);
});

test("a time condition combines the weekday list with the clock window", () => {
  // Wednesday, 09:00 local in the default context.
  const wed = ctx({ localWeekday: 3, localMinutes: 9 * 60 });
  assert.equal(conditionMet({ kind: "time", weekdays: [1, 2, 3, 4, 5] }, wed), true);
  assert.equal(conditionMet({ kind: "time", weekdays: [0, 6] }, wed), false, "a weekday miss hides it");
  // An absent or empty weekday list is EVERY day, not no day — the difference
  // between a time-only condition working and never matching at all.
  assert.equal(conditionMet({ kind: "time", after: "08:00" }, wed), true);
  assert.equal(conditionMet({ kind: "time", weekdays: [], after: "08:00" }, wed), true);
  // Both halves must pass: right day, wrong hour still hides.
  assert.equal(conditionMet({ kind: "time", weekdays: [3], after: "17:00" }, wed), false);
  assert.equal(conditionMet({ kind: "time", weekdays: [3], after: "08:00", before: "17:00" }, wed), true);
  // An unparseable bound degrades to "unbounded on that side" rather than to a
  // window nothing can satisfy.
  assert.equal(conditionMet({ kind: "time", after: "not a time" }, wed), true);
});

/* ── screen is a layout tool, never a privacy control ─────────────── */

test("a screen condition evaluates TRUE on the server and is not server-decidable", () => {
  // These two facts together are the whole security story for `screen`, and they
  // have to be read as a pair. Evaluating true means the server never uses a
  // media query to decide anything; `isServerDecidable` being false means the
  // loader knows it cannot settle the card before querying. If `screen` were
  // false server-side instead, a card would vanish for everyone; if it were
  // reported server-decidable, the loader would skip a query on the strength of
  // a viewport it cannot see.
  const screen: Condition = { kind: "screen", breakpoints: ["mobile"] };
  assert.equal(conditionMet(screen, ctx()), true, "screen must not narrow anything server-side");
  assert.equal(conditionsMet([screen], ctx()), true);
  assert.equal(
    isServerDecidable([screen]),
    false,
    "a screen condition must never let the loader decide before the browser does",
  );
  // And the editor must be able to warn about it.
  assert.equal(isSecurityRelevant(screen), true);
});

test("hiding by screen size never gates loading, even nested under and/or/not", () => {
  // The leak this prevents: someone uses "hide on mobile" believing it keeps the
  // card's contents back. It does not — the rows were already sent. What the code
  // must guarantee is only that the SERVER never treats it as a decision it can
  // make, at any depth.
  const nested: Condition = {
    kind: "and",
    conditions: [ALWAYS, { kind: "not", condition: { kind: "screen", breakpoints: ["desktop"] } }],
  };
  assert.equal(isServerDecidable([nested]), false, "a buried screen condition still blocks the shortcut");
  assert.equal(isSecurityRelevant(nested), true, "the editor's warning must survive nesting");
});

test("every breakpoint has a media query and the two lists cannot drift", () => {
  // A breakpoint present in the union but missing from the query map would make
  // a card configured for it match nothing in the browser, silently.
  assert.deepEqual(
    Object.keys(BREAKPOINT_QUERY).sort(),
    [...BREAKPOINTS].sort(),
    "BREAKPOINTS and BREAKPOINT_QUERY disagree about which sizes exist",
  );
  for (const b of BREAKPOINTS) {
    assert.match(BREAKPOINT_QUERY[b], /^\(m(in|ax)-width: \d+px\)/, `${b} needs a real media query`);
  }
});

/* ── the questions the loader and the editor ask ──────────────────── */

test("needsData finds a data condition at any depth and reports none when there is none", () => {
  // False here means the loader may drop a card WITHOUT querying it. A walk that
  // missed a nested data condition would drop a card whose data was going to
  // reveal it — the card would disappear rather than appear.
  assert.equal(needsData(undefined), false);
  assert.equal(needsData([]), false);
  assert.equal(needsData([ALWAYS, { kind: "screen", breakpoints: ["mobile"] }]), false);
  const dataLeaf: Condition = { kind: "data", field: "count", operator: "greater_than", value: 0 };
  assert.equal(needsData([dataLeaf]), true);
  assert.equal(needsData([{ kind: "not", condition: dataLeaf }]), true, "not must be walked into");
  assert.equal(
    needsData([{ kind: "and", conditions: [ALWAYS, { kind: "or", conditions: [NEVER, dataLeaf] }] }]),
    true,
    "a data condition two groups down must still be found",
  );
});

test("isServerDecidable is true only when nothing in the tree needs rows or a browser", () => {
  assert.equal(isServerDecidable(undefined), true, "no conditions at all is decidable");
  assert.equal(isServerDecidable([]), true);
  assert.equal(isServerDecidable([ALWAYS, { kind: "user", users: ["user-1"] }]), true);
  const dataLeaf: Condition = { kind: "data", field: "count", operator: "greater_than", value: 0 };
  assert.equal(isServerDecidable([dataLeaf]), false);
  assert.equal(isServerDecidable([{ kind: "not", condition: dataLeaf }]), false);
  assert.equal(
    isServerDecidable([{ kind: "and", conditions: [ALWAYS, { kind: "or", conditions: [ALWAYS, dataLeaf] }] }]),
    false,
    "one undecidable leaf anywhere makes the whole list undecidable",
  );
  // An unknown kind counts as decidable — and that is safe precisely because
  // conditionMet already fails it CLOSED, so the loader drops the card early
  // rather than querying it and dropping it late.
  assert.equal(isServerDecidable([{ kind: "geofence" } as unknown as Condition]), true);
});

test("isSecurityRelevant flags only screen, and finds it wherever it hides", () => {
  assert.equal(isSecurityRelevant(ALWAYS), false);
  assert.equal(isSecurityRelevant({ kind: "data", field: "count", operator: "is_empty" }), false);
  assert.equal(isSecurityRelevant({ kind: "screen", breakpoints: ["tablet"] }), true);
  assert.equal(
    isSecurityRelevant({
      kind: "or",
      conditions: [ALWAYS, { kind: "and", conditions: [{ kind: "screen", breakpoints: ["mobile"] }] }],
    }),
    true,
    "the warning must not depend on where in the group the screen condition sits",
  );
});

test("screenBreakpoints collects every size in the tree, deduplicated", () => {
  // This is the list the client subscribes to. Missing one means a card that
  // never re-evaluates when the window crosses that boundary; duplicates mean
  // duplicate listeners.
  assert.deepEqual(screenBreakpoints(undefined), []);
  assert.deepEqual(screenBreakpoints([ALWAYS]), []);
  // Each of the three sizes appears at exactly one place in the tree, so a walk
  // that skipped any branch loses a distinct breakpoint rather than a duplicate.
  const tree: Condition[] = [
    { kind: "screen", breakpoints: ["mobile"] },
    {
      kind: "and",
      conditions: [
        { kind: "not", condition: { kind: "screen", breakpoints: ["tablet"] } },
        { kind: "or", conditions: [{ kind: "screen", breakpoints: ["desktop"] }] },
      ],
    },
  ];
  assert.deepEqual(
    screenBreakpoints(tree).sort(),
    ["desktop", "mobile", "tablet"],
    "every breakpoint in the tree, each exactly once",
  );
  // Duplicates across branches collapse to one listener.
  assert.deepEqual(
    screenBreakpoints([
      { kind: "screen", breakpoints: ["mobile"] },
      { kind: "not", condition: { kind: "screen", breakpoints: ["mobile"] } },
    ]),
    ["mobile"],
  );
});
