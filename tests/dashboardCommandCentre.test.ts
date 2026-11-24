import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  deliveredOnTime,
  exceptionGroups,
  lastMonths,
  winRatePct,
  wonByMonth,
  wonOn,
  wonWithin,
} from "../src/lib/dashboard/commandCentre";
import { DASHBOARD_TEMPLATES, offersTemplate, templateBySlug, templateConfig } from "../src/lib/dashboard/templates";
import { DASHBOARD_CARDS, DEFAULT_LAYOUT, MAX_CARDS, isDashboardCardId } from "../src/lib/dashboard/registry";
import { LIMITS, parseConfigStrict } from "../src/lib/dashboard/config";
import { HELP_ARTICLES } from "../src/lib/help/content";
import { helpSlugForScreen } from "../src/lib/help/screenHelp";

/**
 * The Command Centre (brief §8): new builtin cards on the existing registry, and
 * role templates served the way the Home default is. These pin the KPI
 * definitions (pure), the per-currency rule, the record scope of every query
 * (source guards, like dashboardRecordScope.test.ts) and the templates.
 */

/** Source with comments removed — a rule satisfied by a comment is not satisfied. */
const shipped = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const day = (iso: string) => new Date(`${iso}T12:00:00`);

/* ── definitions ──────────────────────────────────────────────────── */

test("won and lost are dated by wonAt/lostAt, the /targets rule — never by a bare updatedAt", () => {
  const within = { gte: day("2026-11-01"), lt: day("2026-11-24") };
  assert.deepEqual(wonWithin(within), { status: "won", OR: [{ wonAt: within }, { wonAt: null, updatedAt: within }] });
  assert.equal(wonOn({ wonAt: day("2026-10-03"), updatedAt: day("2026-11-20") }).getDate(), 3, "an edit does not move a win");
  assert.equal(wonOn({ wonAt: null, updatedAt: day("2026-11-20") }).getDate(), 20, "legacy rows fall back");
  // The shared dashboard query uses the same helper, so the Won tile, the sales ring and Reports agree.
  const data = shipped("src/lib/dashboard/data.ts");
  assert.match(data, /\.\.\.wonWithin\(\{ gte: monthStart, lt: now \}\)/);
  assert.doesNotMatch(data, /status: "won", updatedAt:/);
});

test("win rate has a denominator and no rate when nothing was decided", () => {
  assert.equal(winRatePct(3, 1), 75);
  assert.equal(winRatePct(0, 4), 0);
  assert.equal(winRatePct(0, 0), null, "0% would claim every deal was lost");
});

test("on-time delivery counts only deliveries that had a booked date, by the day", () => {
  const result = deliveredOnTime([
    { deliveredAt: new Date("2026-11-10T17:30:00"), deliveryScheduledFor: new Date("2026-11-10T09:00:00") }, // same day, later hour: on time
    { deliveredAt: new Date("2026-11-12T08:00:00"), deliveryScheduledFor: new Date("2026-11-11T09:00:00") }, // a day late
    { deliveredAt: new Date("2026-11-09T08:00:00"), deliveryScheduledFor: new Date("2026-11-11T09:00:00") }, // early
    { deliveredAt: new Date("2026-11-09T08:00:00"), deliveryScheduledFor: null }, // no promise: not counted
  ]);
  assert.deepEqual(result, { onTime: 2, booked: 3, pct: 67 });
  assert.equal(deliveredOnTime([]).pct, null);
});

test("the trend never adds currencies: bars are the base, the rest are named per currency", () => {
  const months = lastMonths(day("2026-11-24"), 3);
  assert.deepEqual(months.map((m) => m.label), ["Sep", "Oct", "Nov"]);
  const { bars, others } = wonByMonth(
    [
      { at: day("2026-09-05"), valueCents: 100_00, currency: null },
      { at: day("2026-11-02"), valueCents: 250_00, currency: "ZAR" },
      { at: day("2026-11-03"), valueCents: 999_00, currency: "USD" },
      { at: day("2026-11-04"), valueCents: 1_00, currency: "USD" },
      { at: day("2026-06-01"), valueCents: 5_00, currency: null }, // outside the window
    ],
    months,
    "ZAR",
  );
  assert.deepEqual(bars.map((b) => b.baseCents), [100_00, 0, 250_00]);
  assert.deepEqual(bars.map((b) => b.count), [1, 0, 3]);
  assert.deepEqual(others, [{ currency: "USD", cents: 1000_00 }]);
});

test("exceptions group the Attention list by reason, per currency, in the engine's weight order", () => {
  const groups = exceptionGroups(
    [
      { id: "a", name: "Ann", valueCents: 100, currency: null, signals: [{ kind: "stage_age", detail: "30 days in Proposal" }, { kind: "unanswered_inbound", detail: "Ann wrote 6h ago" }] },
      { id: "b", name: "Bob", valueCents: 50, currency: "USD", signals: [{ kind: "stage_age", detail: "40 days" }, { kind: "stage_age", detail: "dup" }] },
    ],
    "ZAR",
  );
  assert.deepEqual(groups.map((g) => [g.kind, g.count]), [["unanswered_inbound", 1], ["stage_age", 2]], "a customer waiting outranks a stale stage; one deal counts once per reason");
  assert.deepEqual(groups[1].totals, [{ currency: "ZAR", cents: 100 }, { currency: "USD", cents: 50 }]);
  assert.equal(groups[1].example.id, "a");
  const usdOnly = exceptionGroups([{ id: "c", name: "Cy", valueCents: 70, currency: "USD", signals: [{ kind: "no_next_step", detail: "x" }] }], "ZAR");
  assert.deepEqual(usdOnly[0].totals, [{ currency: "USD", cents: 70 }], "no empty base figure beside a real one");
});

/* ── record scope: no card counts a record its viewer could not open ── */

function prismaCalls(code: string) {
  const calls: { model: string; op: string; args: string }[] = [];
  const pattern = /prisma\.(\w+)\.(\w+)\(/g;
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
    const open = pattern.lastIndex - 1;
    let depth = 0;
    let end = open;
    for (; end < code.length; end += 1) {
      if ("({[".includes(code[end])) depth += 1;
      else if (")}]".includes(code[end]) && --depth === 0) break;
    }
    calls.push({ model: match[1], op: match[2], args: code.slice(open + 1, end) });
  }
  return calls;
}

test("every Command Centre read of a scoped record carries the viewer's scope", () => {
  const calls = prismaCalls(shipped("src/lib/dashboard/commandCards.tsx"));
  const SCOPE: Record<string, RegExp> = {
    lead: /await leadWhere\(\)/,
    quote: /await quoteWhere\(\)/,
    jobCard: /await jobCardWhere\(\)/,
    customerCase: /await caseWhere\(\)/,
    activity: /await activityWhere\(\)/,
  };
  for (const model of Object.keys(SCOPE)) {
    assert.ok(calls.some((c) => c.model === model), `no prisma.${model} call found — has the card moved?`);
  }
  for (const call of calls) {
    const scope = SCOPE[call.model];
    if (!scope) continue;
    assert.match(call.args, scope, `prisma.${call.model}.${call.op} is not narrowed to what the viewer may open`);
  }
  // The only other reads: names of people already in the scoped rows, and the month's target.
  assert.deepEqual(
    [...new Set(calls.map((c) => c.model).filter((m) => !SCOPE[m]))].sort(),
    ["target", "user"],
  );
});

test("each strand is gated on its own permission and module, and quotes are current revisions only", () => {
  const cards = shipped("src/lib/dashboard/commandCards.tsx");
  assert.match(cards, /access\.modules\.has\("automotive"\) && grants\(access, "deliveries\.view", "deliveries\.manage"\)/);
  assert.match(cards, /automotive && grants\(access, "jobcards\.view_all", "jobcards\.view_owned"\)/);
  assert.match(cards, /access\.modules\.has\("support"\) && grants\(access, "cases\.view_all", "cases\.view_owned"\)/);
  assert.match(cards, /getAccessibleCaseIds\(/);
  assert.match(cards, /grants\(access, "activities\.manage"\) \? \{\} : \{ assignedToId: user\.id \}/, "activities.view sees only your own diary");
  for (const call of prismaCalls(cards).filter((c) => c.model === "quote")) {
    assert.match(call.args, /supersededAt: null/, "a replaced revision is not an order");
  }
  // Quote money goes through the canonical pricing helper, per currency.
  assert.match(cards, /quotePricing\(q\.items, q\.fees,/);
  assert.match(cards, /totalsByCurrency\(priced,/);
  // The forecast card reuses the forecast page's loader and narrows it to the viewer's deals.
  assert.match(cards, /listForecastLeads\(\{ closeFrom: monthStart, closeTo: monthEnd \}\)/);
  assert.match(cards, /ids === null \? rows : rows\.filter\(\(row\) => allowed\.has\(row\.id\)\)/);
  // The assistant is never named on screen.
  assert.doesNotMatch(cards, /DAX/);
});

/* ── registry and templates ───────────────────────────────────────── */

test("the new cards are template-only: Home's default is unchanged", () => {
  const ccCards = DASHBOARD_CARDS.filter((c) => c.id.startsWith("cc-"));
  assert.equal(ccCards.length, 7);
  for (const card of ccCards) {
    assert.equal(card.templateOnly, true, card.id);
    assert.ok(card.permissions.length > 0, `${card.id} must not be open to everyone`);
    assert.ok(!DEFAULT_LAYOUT.includes(card.id), `${card.id} leaked onto Home`);
  }
  assert.ok(DEFAULT_LAYOUT.length <= MAX_CARDS);
});

test("every template uses only registered cards, parses strictly and fits the caps", () => {
  const slugs = new Set<string>();
  for (const template of DASHBOARD_TEMPLATES) {
    assert.ok(!slugs.has(template.slug), `duplicate slug ${template.slug}`);
    slugs.add(template.slug);
    assert.notEqual(template.slug, "home", "home is the default, not a template");
    assert.ok(template.permissions.length > 0);
    assert.equal(new Set(template.cards).size, template.cards.length, `${template.slug} repeats a card`);
    for (const id of template.cards) assert.ok(isDashboardCardId(id), `${template.slug}: ${id} is not a registered card`);
    assert.ok(template.cards.length <= LIMITS.cardsPerSection);
    const parsed = parseConfigStrict(templateConfig(template));
    assert.ok(parsed.ok, `${template.slug}: ${parsed.ok ? "" : parsed.error}`);
  }
  // Brief §8: owners, managers, sales and operations.
  assert.deepEqual(DASHBOARD_TEMPLATES.map((t) => t.audience), ["Owners", "Managers", "Sales", "Operations"]);
  assert.equal(templateBySlug("command-centre")?.title, "Command Centre");
});

test("a template is offered by permission; it confers nothing", () => {
  const cc = templateBySlug("command-centre")!;
  assert.equal(offersTemplate(cc, new Set(["reports.view_all"])), true);
  assert.equal(offersTemplate(cc, new Set(["leads.view_owned"])), false);
  const store = shipped("src/lib/dashboard/store.ts");
  assert.match(store, /offersTemplate\(template, access\.permissions\) \? templateDashboard\(template\.slug\) : null/);
  // The sidebar link, the template and its own page answer to one set of keys.
  assert.deepEqual([...cc.permissions], ["reports.view", "reports.view_all", "reports.view_team"]);
  assert.match(shipped("src/components/nav-config.ts"), /if \(can\("reports\.view", "reports\.view_all", "reports\.view_team"\)\) \{\s*insightLinks\.push\(\{ href: "\/d\/command-centre"/);
  const page = shipped("src/app/(app)/d/command-centre/page.tsx");
  assert.match(page, /await requireAnyPermission\(\.\.\.templateBySlug\(SLUG\)!\.permissions\);/);
  // The guard comes before ANY read: someone without Reports who has a stored or shared
  // copy at this slug (takeControl lets anyone materialise one) is still turned away.
  const guard = page.indexOf("await requireAnyPermission(");
  assert.ok(guard > 0 && guard < page.indexOf("dashboardBySlug(SLUG)"), "permission checked before the stored dashboard is looked up");
  assert.equal(page.match(/return /g)?.length, 1, "no early return around the guard");
});

test("a template is generated until edited, then materialised at its own address", () => {
  const actions = shipped("src/app/actions/dashboardConfig.ts");
  assert.match(actions, /export async function takeControl\(slug: unknown = DEFAULT_DASHBOARD_SLUG\)/);
  assert.match(actions, /const seed = \(typeof slug === "string" \? templateDashboard\(slug\) : null\) \?\? defaultDashboard\(\);/);
  // Checked per address, or owning one dashboard would skip creating the next.
  assert.match(actions, /prisma\.dashboard\.count\(\{ where: \{ userId: user\.id, slug: seed\.slug \} \}\)/);
  assert.match(shipped("src/components/dashboard/editor/EditorProvider.tsx"), /await takeControl\(slug\)/);
  assert.match(shipped("src/app/(app)/d/[slug]/page.tsx"), /await offeredTemplateDashboard\(slug\)/);
});

/* ── help ─────────────────────────────────────────────────────────── */

test("the KPI definitions, currency handling and refresh time are documented, and the screens open them", () => {
  const article = HELP_ARTICLES.find((a) => a.slug === "command-centre");
  assert.ok(article);
  const text = JSON.stringify(article.body);
  for (const figure of ["Won this month", "Win rate (90 days)", "Open pipeline", "Delivered on time (90 days)", "Operations status", "Management by exception", "Team workload", "Deals most at risk", "Forecast vs target"]) {
    assert.ok(text.includes(figure), `${figure} is not defined in the help article`);
  }
  assert.match(text, /as of/);
  assert.match(text, /never added in/);
  assert.doesNotMatch(text, /DAX/);
  assert.equal(helpSlugForScreen("/d/command-centre"), "command-centre");
});
