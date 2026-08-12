import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";

/**
 * The research briefing parser decides whether a note is rendered as a
 * structured card or verbatim. Getting that wrong does not throw and does not
 * look broken — it silently removes sentences from a research note, which is
 * the one thing this component must never do.
 *
 * The bug these exist for: structured mode used to switch on as soon as ONE
 * line matched a label, and every non-matching line was then dropped. Mixed
 * output (the normal shape of model drift) lost its prose, and an old
 * free-form note containing a single "Company: ..." line lost everything else.
 */

type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;

// The component imports lucide-react and React for rendering; only the parser
// is under test, so the icon module is stubbed rather than pulled in.
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "lucide-react") {
    return new Proxy({}, { get: () => () => null });
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const { __parseBriefingForTests: parse } =
  require_("../src/components/ResearchBriefing.tsx") as typeof import("../src/components/ResearchBriefing");

test("a fully structured briefing is parsed into its three fields", () => {
  const parsed = parse(
    "Company: Example Estates, a 200ha wine estate outside Stellenbosch\n" +
      "Role: Mike Wainright is the CEO\n" +
      "Fit: Large estate with staff moving between cellar and tasting room",
  );
  assert.equal(parsed.structured, true);
  if (!parsed.structured) return;
  assert.match(parsed.company ?? "", /Stellenbosch/);
  assert.match(parsed.role ?? "", /CEO/);
  assert.match(parsed.fit ?? "", /tasting room/);
});

test("a subset of the labels is still structured — an omitted label is not a failure", () => {
  // aiResearch is told to omit a label entirely rather than write
  // "Company: not found", so two lines is a legitimate complete answer.
  const parsed = parse("Company: Example Estates\nFit: Large estate");
  assert.equal(parsed.structured, true);
  if (!parsed.structured) return;
  assert.equal(parsed.role, null, "an absent label is null, not an invented value");
});

test("MIXED output renders verbatim — no line may be silently dropped", () => {
  // THE DEFECT. This used to parse as Company + Fit, and the role sentence
  // disappeared from the UI entirely.
  const text =
    "Company: Example Estates, Stellenbosch\n" +
    "Current role appears to be Managing Director.\n" +
    "Fit: Large estate with internal transport needs";
  const parsed = parse(text);
  assert.equal(
    parsed.structured,
    false,
    "one non-conforming line must disqualify the structured view, so the full text is shown",
  );
});

test("a legacy free-form note containing one 'Company:' line is NOT hijacked", () => {
  // Reaches backwards into every note written before this format existed.
  const legacy =
    "Spoke to the buyer on Tuesday.\n" +
    "Company: they mentioned they run a lodge near Hermanus.\n" +
    "Wants pricing on a six-seater before month end.";
  assert.equal(parse(legacy).structured, false, "legacy prose must render in full");
});

test("ordinary free-form prose with no labels renders verbatim", () => {
  assert.equal(parse("No reliable information found.").structured, false);
  assert.equal(parse("A three line\nnote with\nno labels at all").structured, false);
});

test("blank lines and padding do not break a structured briefing", () => {
  const parsed = parse("\nCompany:   Example Estates  \n\n  Role: CEO\n\n");
  assert.equal(parsed.structured, true);
  if (!parsed.structured) return;
  assert.equal(parsed.company, "Example Estates", "surrounding whitespace is trimmed");
  assert.equal(parsed.role, "CEO");
});

test("a repeated label renders verbatim rather than letting one value overwrite the other", () => {
  // Same content-loss class: the second Company would silently replace the first.
  const parsed = parse("Company: First Estate\nCompany: Second Estate\nFit: Large site");
  assert.equal(parsed.structured, false);
});

test("empty input is not structured", () => {
  assert.equal(parse("").structured, false);
  assert.equal(parse("   \n  \n").structured, false);
});

test("a label must have content after the colon", () => {
  // "Company:" with nothing after it is drift, not a field.
  assert.equal(parse("Company:\nRole: CEO").structured, false);
});
