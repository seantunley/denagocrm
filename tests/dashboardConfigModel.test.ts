import test from "node:test";
import assert from "node:assert/strict";
import {
  CARD_TYPES,
  CONFIG_VERSION,
  CONTAINER_TYPES,
  LIMITS,
  MAX_CARD_DEPTH,
  QUERY,
  QUERY_TYPES,
  cardProblems,
  countCards,
  emptyConfig,
  isContainer,
  isQueryCard,
  normaliseHref,
  parseConfig,
  parseConfigStrict,
  slugify,
  structuralProblems,
  walkCards,
  type CardConfig,
  type CardQuery,
  type ChartCard,
  type DashboardConfig,
  type ListCard,
  type StatCard,
  type ViewConfig,
} from "../src/lib/dashboard/config";

/**
 * Guards for the saved dashboard config: dashboard → views → sections → cards.
 *
 * A config is JSON a user saved, possibly under an older release, possibly typed
 * by hand into the raw editor. The home screen is the one page nobody can route
 * around, so the failure that matters most is not "a card is wrong" — it is "the
 * config could not be read and the user has no home screen". Everything below is
 * about the two halves of that: the WRITE path refusing loudly, and the READ path
 * degrading to something usable while naming what it lost.
 */

/* ── fixtures ─────────────────────────────────────────────────────── */

function query(over: Record<string, unknown> = {}): CardQuery {
  return QUERY.parse({ source: "leads", ...over });
}

function statCard(over: Partial<StatCard> = {}): StatCard {
  return { id: "c1", type: "stat", span: 1, query: query(), metric: { fn: "count" }, compare: false, ...over };
}

function listCard(over: Partial<ListCard> = {}): ListCard {
  return { id: "c1", type: "list", span: 1, query: query(), columns: [], ...over };
}

function chartCard(over: Partial<ChartCard> = {}): ChartCard {
  return {
    id: "c1",
    type: "chart",
    span: 1,
    query: query(),
    groupBy: "status",
    metric: { fn: "count" },
    style: "bar",
    ...over,
  };
}

function view(over: Partial<ViewConfig> = {}): ViewConfig {
  return { id: "v1", title: "Sales", path: "sales", columns: 3, sections: [], ...over };
}

function config(views: ViewConfig[]): DashboardConfig {
  return { version: CONFIG_VERSION, views };
}

/** Raw (untyped) JSON, the way a stored row actually arrives. */
const rawView = (over: Record<string, unknown> = {}) => ({
  id: "v1",
  title: "Sales",
  path: "sales",
  sections: [],
  ...over,
});

/* ── strict REFUSES, lenient DROPS — the whole degradation story ──── */

test("the strict parser refuses a malformed card and says where", () => {
  // The write path. Someone who has just hand-edited a card wants to be told
  // "guage is not a card type", not to have the save succeed with their card
  // quietly missing — which is what a lenient write path would do.
  const result = parseConfigStrict({
    views: [rawView({ sections: [{ id: "s1", cards: [{ id: "c1", type: "guage" }] }] })],
  });
  assert.equal(result.ok, false, "a config with an unknown card type must not save");
  assert.ok(result.ok === false && result.error.length > 0, "a refusal must carry a message");
  assert.ok(
    result.ok === false && result.error.includes("views.0.sections.0.cards.0.type"),
    "the message must locate the offending card, or the user cannot find it",
  );
});

test("the lenient parser keeps the config, drops the card, and names what it dropped", () => {
  // The read path, on the very same input. It must never fail: a config that
  // fails to save is a message, a config that fails to load is a broken home
  // screen. And the drop has to be REPORTED, or the user is left to notice a gap.
  const { config: parsed, dropped } = parseConfig({
    views: [rawView({ sections: [{ id: "s1", cards: [{ id: "c1", type: "guage" }] }] })],
  });
  assert.equal(parsed.views.length, 1, "the tab must survive its bad card");
  assert.deepEqual(parsed.views[0].sections[0].cards, [], "the unreadable card must be gone");
  assert.deepEqual(
    dropped,
    ['A "guage" card could not be read and was removed.'],
    "the dropped card must be named, and named by the type the user typed",
  );
});

test("a valid config passes both parsers and reports nothing dropped", () => {
  // The control for the pair above. Without it, a parser that refused or dropped
  // EVERYTHING would satisfy every other test in this file.
  const input = {
    version: 1,
    title: "Mine",
    views: [rawView({ sections: [{ id: "s1", cards: [{ id: "c1", type: "heading", title: "Today" }] }] })],
  };
  const strict = parseConfigStrict(input);
  assert.equal(strict.ok, true, "a well-formed config must save");
  const { config: parsed, dropped } = parseConfig(input);
  assert.deepEqual(dropped, [], "a well-formed config must lose nothing on read");
  assert.equal(parsed.title, "Mine");
  assert.equal(countCards(parsed.views[0]), 1);
});

/* ── input that is not a config at all ────────────────────────────── */

test("a stored value that is not an object degrades to an empty config, never a throw", () => {
  // A row holding `null`, an array, or a bare string is what a half-finished
  // migration or a hand-edited JSON column looks like. Any throw here is a 500 on
  // the home page.
  for (const junk of [null, undefined, [], [1, 2], "nonsense", 42, true]) {
    const { config: parsed, dropped } = parseConfig(junk);
    assert.deepEqual(parsed, emptyConfig(), `${JSON.stringify(junk)} should give the default config`);
    assert.deepEqual(dropped, ["The saved dashboard could not be read."], "and must say so");
  }
  // An object with no views is not junk — it is a config with no tabs yet.
  assert.deepEqual(parseConfig({}).dropped, [], "an empty object is a valid empty config");
  assert.deepEqual(parseConfig({}).config.views, []);
  // Neither is a `views` key holding something that is not an array.
  assert.deepEqual(parseConfig({ views: "nope" }).config.views, []);
});

test("emptyConfig is stamped with the current version so a save round-trips", () => {
  assert.deepEqual(emptyConfig(), { version: CONFIG_VERSION, views: [] });
  assert.equal(parseConfigStrict(emptyConfig()).ok, true, "the default must itself be saveable");
});

/* ── salvage: one bad card must not cost a whole tab ──────────────── */

test("a malformed card does not take the other cards in its section with it", () => {
  // The named scenario: a card written by a newer release sits in a section of
  // twelve. Losing the eleven around it — or the whole tab — is the failure.
  const { config: parsed, dropped } = parseConfig({
    views: [
      rawView({
        sections: [
          {
            id: "s1",
            cards: [
              { id: "keep-1", type: "markdown", content: "hello" },
              { id: "bad", type: "sparkline" },
              { id: "keep-2", type: "heading", title: "Later" },
            ],
          },
        ],
      }),
    ],
  });
  assert.deepEqual(
    parsed.views[0].sections[0].cards.map((c) => c.id),
    ["keep-1", "keep-2"],
    "the intact cards must survive, in their original order",
  );
  assert.deepEqual(dropped, ['A "sparkline" card could not be read and was removed.']);
});

test("a tab with no readable title is dropped whole, because there is nothing to label it", () => {
  // Salvage needs SOMETHING to render as the tab. A titleless view would come
  // back as a blank tab the user cannot identify or delete.
  const { config: parsed, dropped } = parseConfig({ views: [{ id: "v1", sections: [] }] });
  assert.deepEqual(parsed.views, []);
  assert.deepEqual(dropped, ["A tab could not be read and was removed."]);
});

test("a salvaged tab gets a usable path even when its own was missing or unusable", () => {
  // A view whose path is absent falls back to a slug of its title. A path of ""
  // would shadow the dashboard root and make one of the tabs unreachable.
  const { config: parsed } = parseConfig({
    views: [{ title: "This Month!", sections: [{ id: "s1", cards: [{ type: "nope" }] }] }],
  });
  assert.equal(parsed.views.length, 1);
  assert.equal(parsed.views[0].path, "this-month", "the path must be derived from the title");
  assert.ok(parsed.views[0].id.length > 0, "a salvaged tab must still get an id");
});

/* ── version ──────────────────────────────────────────────────────── */

test("the strict parser refuses a config from a newer release", () => {
  // Half-understanding a newer config and saving it back would silently delete
  // whatever this build did not recognise. Refusing is the only safe answer on
  // the write path.
  const future = parseConfigStrict({ version: CONFIG_VERSION + 1, views: [] });
  assert.equal(future.ok, false, "a future version must not save");
  assert.ok(future.ok === false && /newer version/i.test(future.error));
  // An absent version is a config written before the field existed, and is fine.
  const legacy = parseConfigStrict({ views: [] });
  assert.equal(legacy.ok, true, "an absent version must default to 1, not be refused");
  assert.equal(legacy.ok === true && legacy.config.version, 1);
});

/* ── depth caps: degrade, do not blow the stack ───────────────────── */

test("a condition tree far deeper than the cap is dropped rather than overflowing the stack", () => {
  // 50 nested `and`s is what a generated or hand-edited config looks like when
  // something has gone wrong. The schema is unrolled to a fixed depth precisely
  // so this fails to VALIDATE — a `z.lazy` schema would happily accept it and the
  // recursion downstream would take the home page down.
  let condition: unknown = { kind: "data", field: "count", operator: "greater_than", value: 0 };
  for (let i = 0; i < 50; i += 1) condition = { kind: "and", conditions: [condition] };
  const input = {
    views: [
      rawView({ sections: [{ id: "s1", cards: [{ id: "c1", type: "heading", visibility: [condition] }] }] }),
    ],
  };
  const strict = parseConfigStrict(input);
  assert.equal(strict.ok, false, "a too-deep condition must not save");
  // And the read path degrades — no throw, no stack overflow, one named drop.
  const { config: parsed, dropped } = parseConfig(input);
  assert.deepEqual(parsed.views[0].sections[0].cards, [], "the card carrying it must be dropped");
  assert.deepEqual(dropped, ['A "heading" card could not be read and was removed.']);
});

test("container cards nested past the cap are dropped rather than overflowing the stack", () => {
  assert.equal(MAX_CARD_DEPTH, 3, "the fixture below is written against this cap");
  let card: unknown = { id: "leaf", type: "heading" };
  for (let i = 0; i < 10; i += 1) card = { id: `g${i}`, type: "grid", cards: [card] };
  const input = { views: [rawView({ sections: [{ id: "s1", cards: [card] }] })] };
  assert.equal(parseConfigStrict(input).ok, false, "a ten-deep grid must not save");
  const { config: parsed, dropped } = parseConfig(input);
  assert.deepEqual(parsed.views[0].sections[0].cards, [], "the whole over-deep tree is dropped");
  assert.deepEqual(dropped, ['A "grid" card could not be read and was removed.']);
  // Control: nesting UP TO the cap is legal, so the test above is about depth
  // rather than about containers being rejected outright.
  const legal = {
    views: [
      rawView({
        sections: [
          { id: "s1", cards: [{ id: "g1", type: "grid", cards: [{ id: "g2", type: "grid", cards: [{ id: "leaf", type: "heading" }] }] }] },
        ],
      }),
    ],
  };
  assert.equal(parseConfigStrict(legal).ok, true, "nesting within the cap must still be accepted");
});

/* ── structural rules zod cannot express ──────────────────────────── */

test("two tabs sharing an address are reported, because one of them is unreachable", () => {
  const problems = structuralProblems(config([view(), view({ id: "v2", title: "Other" })]));
  assert.ok(
    problems.some((p) => p.includes('"sales"')),
    "a duplicate view path must be named in the problem",
  );
  assert.deepEqual(structuralProblems(config([view(), view({ id: "v2", title: "Other", path: "other" })])), []);
});

test("an id reused anywhere across tabs, sections or cards is reported", () => {
  // One id namespace, deliberately: React keys, drag ids and the "which card did
  // you mean" of every editor action all key off it. A collision between a
  // section and a card is just as broken as one between two cards.
  const twoTabs = structuralProblems(config([view(), view({ title: "Other", path: "other" })]));
  assert.ok(twoTabs.some((p) => p.includes("tabs share an id")), "duplicate view ids");

  const sectionClash = structuralProblems(
    config([view({ sections: [{ id: "v1", columnSpan: 1, cards: [] }] })]),
  );
  assert.ok(
    sectionClash.some((p) => p.includes("sections share an id")),
    "a section reusing its tab's id must be reported",
  );

  const cardClash = structuralProblems(
    config([
      view({
        sections: [
          { id: "s1", columnSpan: 1, cards: [{ id: "dup", type: "heading", span: 4 }] },
          { id: "s2", columnSpan: 1, cards: [{ id: "dup", type: "heading", span: 4 }] },
        ],
      }),
    ]),
  );
  assert.ok(cardClash.some((p) => p.includes("cards share an id")), "duplicate card ids across sections");

  // Including a card buried inside a container — walkCards has to reach it.
  const nestedClash = structuralProblems(
    config([
      view({
        sections: [
          {
            id: "s1",
            columnSpan: 1,
            cards: [
              { id: "dup", type: "heading", span: 4 },
              { id: "g1", type: "grid", span: 1, columns: 2, cards: [{ id: "dup", type: "heading", span: 4 }] },
            ],
          },
        ],
      }),
    ]),
  );
  assert.ok(
    nestedClash.some((p) => p.includes("cards share an id")),
    "a duplicate hiding inside a container must still be found",
  );
});

test("a tab over the per-view card cap is reported with the real count", () => {
  // The cap is about cost, not tidiness: every query card is a round trip on the
  // first screen every user sees. A view sitting just under it must not trip.
  const cards = (n: number, prefix: string): CardConfig[] =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, type: "heading", span: 4 }) as CardConfig);
  const atCap = config([
    view({ sections: [{ id: "s1", columnSpan: 1, cards: cards(LIMITS.cardsPerView, "a") }] }),
  ]);
  assert.deepEqual(structuralProblems(atCap), [], "exactly at the cap must be accepted");
  const overCap = config([
    view({ sections: [{ id: "s1", columnSpan: 1, cards: cards(LIMITS.cardsPerView + 1, "a") }] }),
  ]);
  assert.ok(
    structuralProblems(overCap).some((p) => p.includes(`${LIMITS.cardsPerView + 1} cards`)),
    "the problem must state how many cards there actually are",
  );
});

/* ── per-card rules that depend on the source catalogue ───────────── */

test("cardProblems ignores cards that never run a query", () => {
  // Only query cards can name a field. Reporting on a heading would be noise the
  // editor would have to special-case away again.
  assert.equal(cardProblems({ id: "h", type: "heading", span: 4 }), null);
  assert.equal(cardProblems({ id: "m", type: "markdown", span: 1, content: "" }), null);
  assert.equal(cardProblems({ id: "b", type: "button", span: 1, href: "/leads" }), null);
  // And the happy path for one that does, or every assertion below would pass
  // for a function that always complained.
  assert.equal(cardProblems(statCard()), null, "a plain count over a real source is fine");
});

test("an unknown data source is reported rather than reaching the compiler", () => {
  const card = statCard({ query: { ...query(), source: "payroll" } as CardQuery });
  assert.match(cardProblems(card) ?? "", /Unknown data source/);
});

test("a filter, sort, column, group-by or metric field that is not on the source is refused", () => {
  // Zod can prove these are strings; only this can prove they name something
  // real. An unreal name reaching the compiler is where a mistake stops being a
  // message and starts being a query nobody designed.
  assert.match(
    cardProblems(statCard({ query: query({ filters: [{ field: "salary", operator: "equals" }] }) })) ?? "",
    /"salary" is not a field of Leads/,
  );
  assert.match(
    cardProblems(statCard({ query: query({ sort: { field: "salary", dir: "asc" } }) })) ?? "",
    /Cannot sort by "salary"/,
  );
  assert.match(
    cardProblems(statCard({ query: query({ periodField: "salary" }) })) ?? "",
    /"salary" is not a date field of Leads/,
  );
  assert.match(cardProblems(listCard({ columns: ["salary"] })) ?? "", /"salary" is not a field of Leads/);
  assert.match(cardProblems(chartCard({ groupBy: "salary" })) ?? "", /Cannot group by "salary"/);
  assert.match(
    cardProblems(statCard({ metric: { fn: "sum", field: "salary" } })) ?? "",
    /"salary" is not a field of Leads/,
  );
});

test("a field that exists but is not filterable, sortable, groupable or aggregatable is refused", () => {
  // These flags are not decoration. A composite display name cannot honestly
  // answer a filter, a relation hop the compiler cannot order by cannot be
  // sorted on, and totalling a title is meaningless — each would otherwise
  // produce a card that renders and is wrong.
  const contacts = { source: "contacts" } as const;
  assert.match(
    cardProblems(
      statCard({ query: query({ ...contacts, filters: [{ field: "name", operator: "contains", value: "x" }] }) }),
    ) ?? "",
    /cannot be filtered on/,
    "the joined contact display name is filterable: false",
  );
  assert.match(
    cardProblems(statCard({ query: query({ sort: { field: "stage", dir: "asc" } }) })) ?? "",
    /cannot be sorted by/,
    "lead stage is a relation hop with sortable: false",
  );
  assert.match(
    cardProblems(chartCard({ groupBy: "name" })) ?? "",
    /cannot be grouped by/,
    "grouping by a lead name gives one bar per row, which is not a chart",
  );
  assert.match(
    cardProblems(statCard({ metric: { fn: "sum", field: "title" } })) ?? "",
    /cannot be totalled/,
    "a text field is not aggregatable",
  );
  // Controls: the same operations on fields that DO allow them.
  assert.equal(cardProblems(statCard({ query: query({ sort: { field: "createdAt", dir: "desc" } }) })), null);
  assert.equal(cardProblems(chartCard({ groupBy: "status" })), null);
  assert.equal(cardProblems(statCard({ metric: { fn: "sum", field: "value" } })), null);
});

test("a non-count metric with no field at all is refused before it reaches the query", () => {
  // "Sum of nothing" is the shape a half-configured card is saved in. The
  // compiler has no sensible answer for it, so the editor has to.
  assert.equal(cardProblems(statCard({ metric: { fn: "sum" } })), "Choose a field to total.");
  assert.equal(cardProblems(statCard({ metric: { fn: "avg" } })), "Choose a field to total.");
  // `count` is the exception: a field is ignored for it, so its absence is fine.
  assert.equal(cardProblems(statCard({ metric: { fn: "count" } })), null);
});

test("structuralProblems surfaces a card's own problem alongside the structural ones", () => {
  const problems = structuralProblems(
    config([
      view({
        sections: [{ id: "s1", columnSpan: 1, cards: [chartCard({ id: "c1", groupBy: "salary" })] }],
      }),
    ]),
  );
  assert.ok(problems.some((p) => /Cannot group by/.test(p)), "a card problem must reach the strict parser");
});

/* ── the card budget is trimmed from the END ──────────────────────── */

test("a stored config over the card budget is trimmed from the end and reports what went", () => {
  // Only ever reached by a config that was already oversized when it was stored,
  // e.g. because the cap was lowered afterwards. Trimming from the END keeps the
  // top of the screen — the part anyone actually looks at — exactly as saved;
  // trimming proportionally or from the front would rearrange a working
  // dashboard behind the user's back.
  const cards = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, type: "heading" }));
  const { config: parsed, dropped } = parseConfig({
    views: [
      rawView({
        sections: [
          { id: "s1", cards: cards(23, "a") },
          { id: "s2", cards: cards(23, "b") },
        ],
      }),
    ],
  });
  assert.equal(countCards(parsed.views[0]), LIMITS.cardsPerView, "the view must come back at the cap");
  assert.deepEqual(
    parsed.views[0].sections[0].cards.map((c) => c.id),
    cards(23, "a").map((c) => c.id),
    "the first section is untouched — trimming starts at the far end",
  );
  assert.deepEqual(
    parsed.views[0].sections[1].cards.map((c) => c.id),
    cards(17, "b").map((c) => c.id),
    "the second section keeps its leading cards and loses its trailing ones",
  );
  assert.deepEqual(
    dropped,
    [`"Sales" was over the ${LIMITS.cardsPerView}-card limit; 6 were removed.`],
    "the trim must be reported with a count, not done silently",
  );
  // Control: a config within budget is not trimmed and reports nothing.
  const fine = parseConfig({ views: [rawView({ sections: [{ id: "s1", cards: cards(5, "a") }] })] });
  assert.equal(countCards(fine.config.views[0]), 5);
  assert.deepEqual(fine.dropped, []);
});

/* ── walking and the type predicates ──────────────────────────────── */

test("walkCards yields containers and their contents, depth first", () => {
  // countCards and the budget both ride on this. A walk that skipped containers
  // would let a grid of twenty cards pass a forty-card cap as one card.
  const tree: CardConfig[] = [
    { id: "a", type: "heading", span: 4 },
    {
      id: "g",
      type: "grid",
      span: 1,
      columns: 2,
      cards: [
        { id: "b", type: "heading", span: 4 },
        { id: "s", type: "stack", span: 1, direction: "vertical", cards: [{ id: "c", type: "heading", span: 4 }] },
      ],
    },
  ];
  assert.deepEqual([...walkCards(tree)].map((c) => c.id), ["a", "g", "b", "s", "c"]);
});

test("isContainer and isQueryCard agree with the card type list", () => {
  // Both lists drive real decisions — one whether to recurse, the other whether
  // the card costs a round trip — and a type missing from either is a silent
  // miscount rather than an error.
  for (const type of CARD_TYPES) {
    assert.equal(isContainer(type), (CONTAINER_TYPES as readonly string[]).includes(type), type);
    assert.equal(isQueryCard(type), (QUERY_TYPES as readonly string[]).includes(type), type);
  }
  assert.ok(isContainer("grid") && isContainer("stack"));
  assert.ok(!isContainer("heading"), "a heading is a leaf");
  assert.ok(isQueryCard("stat") && !isQueryCard("markdown"));
});

/* ── slugify ──────────────────────────────────────────────────────── */

test("slugify never returns the empty string", () => {
  // A view whose path is "" shadows the dashboard root and makes one of the tabs
  // unreachable — the user sees the wrong tab's contents and cannot get back.
  assert.equal(slugify(""), "tab");
  assert.equal(slugify("!!!"), "tab");
  assert.equal(slugify("   "), "tab");
  assert.equal(slugify("---"), "tab");
  assert.equal(slugify("？？"), "tab", "non-latin punctuation must not survive as a path");
});

test("slugify lower-cases, collapses runs, trims and caps the length", () => {
  assert.equal(slugify("This Month"), "this-month");
  assert.equal(slugify("  Sales & Ops!  "), "sales-ops", "a run of punctuation collapses to one dash");
  assert.equal(slugify("A---B"), "a-b");
  assert.equal(slugify("-leading-and-trailing-"), "leading-and-trailing");
  assert.ok(slugify("x".repeat(200)).length <= 60, "a path must not exceed the stored column's length");
});

/* ── normaliseHref is a phishing guard ────────────────────────────── */

test("normaliseHref accepts a path inside this app", () => {
  assert.equal(normaliseHref("/leads"), "/leads");
  assert.equal(normaliseHref("  /workshop/abc?tab=parts  "), "/workshop/abc?tab=parts", "trimmed, not rejected");
  assert.equal(normaliseHref("/"), "/");
});

test("normaliseHref refuses anything that could navigate off this app", () => {
  // This is a PHISHING guard, not tidiness. A dashboard is shared by screenshot
  // and over someone's shoulder, so a button in the product's own chrome that
  // lands on an attacker's page is trusted far more than a link in an email.
  //
  // `//evil.example` is the case worth naming: it looks like a path in the saved
  // config and every browser reads it as protocol-relative — https://evil.example.
  assert.equal(normaliseHref("//evil.example"), null, "protocol-relative is an off-site URL");
  assert.equal(normaliseHref("//evil.example/leads"), null);
  // A backslash is rejected because some parsers normalise it to a slash, which
  // turns /\evil.example back into //evil.example after this check would have run.
  assert.equal(normaliseHref("/\\evil.example"), null);
  assert.equal(normaliseHref("/leads\\..\\admin"), null, "a backslash anywhere is refused");
  // Anything not starting with a slash: absolute URLs, other schemes, bare words.
  assert.equal(normaliseHref("https://evil.example"), null);
  assert.equal(normaliseHref("javascript:alert(1)"), null);
  assert.equal(normaliseHref("mailto:someone@example.com"), null);
  assert.equal(normaliseHref("leads"), null);
  assert.equal(normaliseHref(""), null);
  assert.equal(normaliseHref("   "), null);
  // Whitespace must not be a way to smuggle a leading slash past the check.
  assert.equal(normaliseHref("  //evil.example"), null, "trimming happens BEFORE the guards, not after");
});

/* ── degradation must never REVEAL ────────────────────────────────── */

/*
 * The three guards below all pin the same principle from different angles: a
 * read path is allowed to show LESS than the config asked for, and never more.
 * Each replaced a real defect found by mutation testing, and each failure mode
 * was silent — which is why they are worth the length.
 */

test("a slug is never left ending in a dash, even when the title is truncated", () => {
  // The dash-trim cannot know where the length cap will cut, so trimming only
  // before the slice leaves a trailing dash on any title long enough to be
  // truncated at a word boundary. This is a stored URL segment, not a label.
  const slug = slugify(`${"a".repeat(59)} b`);
  // 59, not 60: the cap cuts at the dash and the second trim then removes it.
  // Losing a character to the trim is the correct outcome — the alternative is
  // a slug that ends in a separator.
  assert.ok(slug.length <= 60 && slug.length >= 59, `unexpected length ${slug.length}`);
  assert.ok(!slug.endsWith("-"), `slug ends in a dash: ${JSON.stringify(slug)}`);
  // A title that is nothing but separators still has to produce a usable segment.
  assert.equal(slugify("--- --- ---"), "tab");
  assert.ok(!slugify(`${"x".repeat(58)}   yy`).endsWith("-"));
});

test("a config from a newer release is reported and its version left alone", () => {
  /*
   * The dangerous version of this bug is not the rendering — it is the SAVE.
   *
   * Rewriting the stamp down to this build's version would make the config pass
   * the strict parser on the way back out, so the user's next unrelated edit
   * would quietly persist a half-understood config as though it were complete,
   * and whatever the newer release had written would be gone for good. Leaving
   * the stamp alone keeps the write path refusing, which is recoverable.
   */
  const future = { version: CONFIG_VERSION + 1, views: [] };
  const { config, dropped } = parseConfig(future);
  assert.equal(config.version, CONFIG_VERSION + 1, "the version stamp must be carried through unchanged");
  assert.ok(
    dropped.some((message) => /newer version/i.test(message)),
    "the reader must say that it could not fully understand this config",
  );
  // And the round trip must still be refused, which is the whole point.
  const strict = parseConfigStrict(config);
  assert.equal(strict.ok, false, "a config from the future must not be saveable");
});

test("one bad card cannot unhide the section or the tab it sits in", () => {
  /*
   * A section fails to parse most often because ONE card in it is malformed.
   * Rebuilding that section without its `visibility` takes something somebody
   * deliberately hid — behind a role, a permission, a time of day — and shows it
   * to everyone, triggered by a completely unrelated card. That is a hide→show
   * regression caused by bad data, which is the wrong direction to fail in.
   */
  const hidden = [{ kind: "role", roles: ["owner"] }];
  const { config } = parseConfig({
    version: 1,
    views: [
      {
        id: "v1",
        title: "Money",
        path: "money",
        columns: 2,
        visibility: hidden,
        sections: [
          {
            id: "s1",
            columnSpan: 2,
            visibility: hidden,
            // The malformed card is what forces the salvage path.
            cards: [{ id: "c1", type: "not-a-real-card-type" }],
          },
        ],
      },
    ],
  });
  const view = config.views[0];
  assert.ok(view, "the tab itself must survive one bad card");
  assert.deepEqual(view.visibility, hidden, "the tab's visibility rule must survive the salvage");
  assert.deepEqual(view.sections[0].visibility, hidden, "the section's visibility rule must survive");
  // The layout the user chose survives too, rather than snapping back to a default.
  assert.equal(view.columns, 2, "the tab's column count must survive");
  assert.equal(view.sections[0].columnSpan, 2, "the section's span must survive");
});

test("a visibility rule that cannot be read at all hides, rather than reveals", () => {
  // If every clause is unreadable, `undefined` would mean "always visible" — the
  // one answer that must not be reachable by corruption. It degrades to a rule
  // nobody can satisfy, and stays editable so someone can say what they meant.
  const { config } = parseConfig({
    version: 1,
    views: [
      {
        id: "v1",
        title: "Money",
        path: "money",
        columns: 3,
        visibility: [{ kind: "not-a-condition-kind" }],
        sections: [{ id: "s1", columnSpan: 1, cards: [{ id: "c1", type: "nonsense" }] }],
      },
    ],
  });
  const visibility = config.views[0]?.visibility;
  assert.ok(visibility && visibility.length > 0, "an unreadable rule must not become 'always visible'");
  // Whatever it degrades to must still be a rule this build can save back, or
  // the user's next unrelated edit is refused because of corruption elsewhere.
  const strict = parseConfigStrict(config);
  assert.equal(strict.ok, true, `the degraded config must still be saveable: ${JSON.stringify(strict)}`);
});
