/**
 * Should the research loop keep looking, or answer with what it has?
 *
 * Pure. Called after each round of lookups. Prefers a deterministic answer
 * (required tool missing, empty result, repeated lookup) and only falls
 * through to "unsure" when the model should decide.
 */

export type GateInput = {
  question: string;
  /** Tools called so far, in order. */
  tools: string[];
  /** The same lookups with their arguments, when known — lets a comparison check WHO and WHICH PERIOD it covered. */
  steps?: { tool: string; args?: unknown }[];
  /** True if the last round returned no rows and no data. */
  lastRoundEmpty: boolean;
  /** True if the plan step said "then":"answer". */
  planSaysAnswer: boolean;
  stepsUsed: number;
  maxSteps: number;
};

export type GateDecision = "continue" | "answer" | "unsure";

const WHY_OR_STUCK = /\b(why|stuck|stalled|quiet|no sales|what should)\b/i;
const COMPARE = /\b(compare|versus|vs\.?|difference between)\b/i;

/**
 * WHAT the question is about (DAX_Conversational_Upgrades item 4): the evidence a "why" or a comparison needs depends
 * on it. A product or workshop question used to be held to the sales rules, so the gate pushed DAX into pipeline
 * lookups that could not answer it. First match wins; sales words outrank the rest so "why did sales drop after the
 * delivery delays" stays a sales question. Anything unrecognised keeps the sales rules ("deal").
 */
export type ResearchSubject = "people" | "workshop" | "delivery" | "parts" | "invoices" | "products" | "deal";

// ponytail: keyword rules, not a classifier — a new kind of question that misroutes gets a row in the scenario table
// (tests/fixtures/researchSubjectScenarios.ts) and a word here.
const SUBJECTS: [ResearchSubject, RegExp][] = [
  ["people", /\b(pipelines?|sales|salespe(?:ople|rson)|reps?|team|targets?|conversion|win rate|performance)\b/i],
  ["workshop", /\b(job ?cards?|workshop|repairs?|service (?:history|due|booking))\b/i],
  ["delivery", /\bdeliver(?:y|ies|ed)\b/i],
  ["parts", /\b(parts|spares|spare parts?|brake pads?|tyres?|tires?)\b/i],
  ["invoices", /\binvoices?\b/i],
];
/** A comparison of THINGS: a model name ("Scout 4", "Rover XL") or "for an estate buyer". Only read for comparisons. */
const PRODUCTS = /\b[A-Z][a-z]+ (?:\d+|XL|LX|XR)\b|\bfor an? [\w-]+ (?:buyer|customer|estate|course|lodge)\b|\b(models?|specs?|seaters?|range)\b/;

export function researchSubject(question: string): ResearchSubject {
  for (const [subject, words] of SUBJECTS) if (words.test(question)) return subject;
  return COMPARE.test(question) && PRODUCTS.test(question) ? "products" : "deal";
}

const has = (tools: string[], ...any: string[]) => any.some((t) => tools.includes(t));
const arg = (args: unknown, key: string) => (args && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined);

/**
 * A comparison by PERSON, from the lookups' own arguments. Null — the count rule below decides — when the arguments
 * aren't known (an older caller) or no lookup named a person (won vs lost, this month vs last for the team):
 *  - the whole team's numbers cover everyone;
 *  - two people: covered only by lookups of one pipeline tool for both with the SAME dates;
 *  - one person: covered when their lookups span two periods (their own this month vs last) — one period of one
 *    person is only one side.
 */
function peopleCovered(steps: GateInput["steps"]): boolean | null {
  if (!steps?.length || steps.every((s) => s.args === undefined)) return null;
  const pipeline = steps.filter((s) => s.tool === "sales_stats" || s.tool === "find_leads");
  if (pipeline.some((s) => s.tool === "sales_stats" && !arg(s.args, "assignedTo"))) return true;
  const period = (s: { tool: string; args?: unknown }) =>
    s.tool === "sales_stats"
      ? `sales_stats ${String(arg(s.args, "period") ?? "this_month")}`
      : `find_leads ${JSON.stringify(["createdWithinDays", "createdFrom", "createdTo", "closedFrom", "closedTo"].map((k) => arg(s.args, k) ?? null))}`;
  const named = pipeline.flatMap((s) => {
    const who = arg(s.args, "assignedTo");
    return typeof who === "string" && who.trim() ? [{ who: who.trim().toLowerCase(), when: period(s) }] : [];
  });
  const people = new Set(named.map((n) => n.who));
  if (people.size === 0) return null;
  if (people.size === 1) return new Set(named.map((n) => n.when)).size >= 2;
  const byPeriod = new Map<string, Set<string>>();
  for (const n of named) byPeriod.set(n.when, (byPeriod.get(n.when) ?? new Set()).add(n.who));
  return [...byPeriod.values()].some((names) => names.size >= 2);
}

/**
 * What evidence the question still lacks, in plain words — or null when it has enough. Also told to the answer step
 * when research stops short, so DAX says exactly what it couldn't check instead of answering it from guesswork.
 */
export function missingEvidence(question: string, tools: string[], steps?: GateInput["steps"]): string | null {
  const why = WHY_OR_STUCK.test(question);
  const compare = COMPARE.test(question);
  if (!why && !compare) return null;
  switch (researchSubject(question)) {
    case "products":
      return has(tools, "knowledge", "find_quotes") ? null : "the catalogue entries for the products being compared (knowledge)";
    case "workshop":
      return has(tools, "vehicles", "search_everything") ? null : "the workshop's job cards (vehicles)";
    case "delivery":
      if (!has(tools, "deliveries")) return "the delivery record (deliveries)";
      return has(tools, "why", "deal_file", "stuck") ? null : "the delivery's history (why or deal_file)";
    case "parts":
      return has(tools, "parts", "knowledge", "search_everything") ? null : "the parts stock (parts)";
    case "invoices":
      return has(tools, "invoices", "match_payment", "deal_file") ? null : "the invoice and the payments received (invoices)";
    case "people":
    case "deal":
      break;
  }
  // The sales rules, as they were — never weaker.
  if (why && !has(tools, "lead_brief", "sales_stats", "stuck")) {
    return "the deal or the sales numbers behind it (lead_brief, stuck or sales_stats)";
  }
  if (compare) {
    const covered = peopleCovered(steps);
    if (covered !== null) return covered ? null : "pipeline numbers for EACH person over the same period (sales_stats or find_leads per person)";
    const pipelineLookups = tools.filter((t) => t === "find_leads" || t === "sales_stats").length;
    // A comparison of two people needs evidence for both sides, not one shared lookup.
    const namesTwo = /\b(and|vs\.?|versus)\b/i.test(question);
    if (namesTwo && pipelineLookups < 2 && !tools.includes("sales_stats")) return "a pipeline lookup for each side of the comparison";
    if (pipelineLookups < 1) return "at least one pipeline lookup (find_leads or sales_stats)";
  }
  return null;
}

export function researchGate(input: GateInput): GateDecision {
  if (input.stepsUsed >= input.maxSteps) return "answer";
  const missing = missingEvidence(input.question, input.tools, input.steps);
  if (input.planSaysAnswer && !missing) return "answer";
  if (missing) return "continue";

  // Last round found nothing and we already tried the obvious tool: stop.
  if (input.lastRoundEmpty && input.tools.length > 0) return "answer";

  // Repeated the same tool three times: stop.
  const last = input.tools.at(-1);
  if (last && input.tools.filter((t) => t === last).length >= 3) return "answer";

  return "unsure";
}
