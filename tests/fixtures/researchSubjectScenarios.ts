/**
 * DAX_Conversational_Upgrades item 4 — the MEASUREMENT for "choose research according to the subject": fixed
 * questions, what they are about, and which lookups are enough (the gate may let DAX answer) or not (it must keep
 * looking). No model: the research gate is deterministic, so this table is the before/after evaluation.
 *
 * Each case: given these lookups so far and a plan that says "answer", the gate must say `expect`.
 */
export type Lookup = { tool: string; args?: Record<string, unknown>; people?: string[] };
export type ScenarioCase = { lookups: Lookup[]; expect: "answer" | "continue"; why: string };
/** `staff`: the workspace's staff names, so a comparison is checked against the people the QUESTION names. */
export type Scenario = { id: string; question: string; subject: string; staff?: string[]; cases: ScenarioCase[] };

const t = (tool: string, args?: Record<string, unknown>): Lookup => ({ tool, ...(args ? { args } : {}) });
/** A team-wide sales_stats whose per-person breakdown lists these people. */
const team = (period: string, people: string[]): Lookup => ({ tool: "sales_stats", args: { period }, people });
const STAFF = ["Donovan Hodgman", "Kristina Botha", "Sean Tunley"];

export const RESEARCH_SUBJECT_SCENARIOS: Scenario[] = [
  {
    id: "compare-products",
    question: "Compare the Rover XL and Scout 4 for an estate buyer",
    subject: "products",
    cases: [
      { lookups: [t("knowledge", { topic: "Rover XL Scout 4" })], expect: "answer", why: "the catalogue holds both products" },
      { lookups: [t("find_leads"), t("find_leads")], expect: "continue", why: "pipeline lookups say nothing about the products" },
      { lookups: [], expect: "continue", why: "nothing looked up yet" },
    ],
  },
  {
    id: "compare-people-same-period",
    question: "Compare Donovan's and Kristina's pipelines this month",
    subject: "people",
    staff: STAFF,
    cases: [
      { lookups: [t("sales_stats", { period: "this_month", assignedTo: "Donovan" }), t("sales_stats", { period: "this_month", assignedTo: "Kristina" })], expect: "answer", why: "both people, same period" },
      { lookups: [t("sales_stats", { period: "this_month", assignedTo: "Donovan" }), t("sales_stats", { period: "last_month", assignedTo: "Kristina" })], expect: "continue", why: "two different periods are not a comparison" },
      { lookups: [t("sales_stats", { period: "this_month", assignedTo: "Donovan" })], expect: "continue", why: "only one of the two people" },
      { lookups: [team("this_month", ["Donovan Hodgman", "Kristina Botha"])], expect: "answer", why: "the team's per-person breakdown lists both" },
      { lookups: [t("find_leads", { assignedTo: "Donovan" }), t("find_leads", { assignedTo: "Kristina" })], expect: "answer", why: "a list for each, same (default) period" },
      // Review of #1121: each of these used to clear the gate.
      { lookups: [t("sales_stats", { period: "this_month" })], expect: "continue", why: "a team total alone is not either person's figures" },
      { lookups: [team("this_month", ["Donovan Hodgman", "Sean Tunley"])], expect: "continue", why: "the breakdown doesn't list Kristina" },
      { lookups: [t("sales_stats", { period: "this_month", assignedTo: "Donovan" }), t("sales_stats", { period: "last_month", assignedTo: "Donovan" })], expect: "continue", why: "Donovan twice, Kristina never" },
      { lookups: [t("sales_stats", { period: "this_month", assignedTo: "Donovan" }), t("sales_stats", { period: "this_month", assignedTo: "Sean" })], expect: "continue", why: "a person nobody asked about doesn't stand in for Kristina" },
    ],
  },
  {
    id: "compare-people-tools-only",
    question: "Compare Donovan and Kristina's pipelines",
    subject: "people",
    cases: [
      { lookups: [t("find_leads")], expect: "continue", why: "one list is not two people" },
      { lookups: [t("find_leads"), t("find_leads")], expect: "answer", why: "a lookup for each (no arguments known)" },
    ],
  },
  {
    id: "compare-months",
    question: "Compare this month's sales with last month",
    subject: "people",
    cases: [
      { lookups: [t("sales_stats")], expect: "answer", why: "sales numbers" },
      { lookups: [t("knowledge")], expect: "continue", why: "the catalogue is not sales" },
    ],
  },
  {
    // Comparisons that are NOT person against person must not be held to the two-people rule.
    id: "compare-won-lost",
    question: "Compare won and lost leads this month",
    subject: "deal",
    staff: STAFF,
    cases: [
      { lookups: [t("find_leads", { status: "won" }), t("find_leads", { status: "lost" })], expect: "answer", why: "a list for each side, no person named" },
      { lookups: [t("knowledge")], expect: "continue", why: "the catalogue is not the pipeline" },
    ],
  },
  {
    id: "compare-one-person-two-months",
    question: "Compare Donovan's sales this month vs last month",
    subject: "people",
    staff: STAFF,
    cases: [
      { lookups: [t("sales_stats", { period: "this_month", assignedTo: "Donovan" }), t("sales_stats", { period: "last_month", assignedTo: "Donovan" })], expect: "answer", why: "one person, both periods" },
      { lookups: [t("sales_stats", { period: "this_month", assignedTo: "Donovan" })], expect: "continue", why: "one period is one side" },
      { lookups: [t("sales_stats", { period: "this_month", assignedTo: "Kristina" }), t("sales_stats", { period: "last_month", assignedTo: "Kristina" })], expect: "continue", why: "the wrong person's two months" },
      { lookups: [t("sales_stats", { period: "this_month" })], expect: "continue", why: "this month's team total has no last month for Donovan" },
    ],
  },
  {
    id: "compare-one-person-vs-team",
    question: "Compare Donovan with the rest of the team this month",
    subject: "people",
    staff: STAFF,
    cases: [
      { lookups: [team("this_month", ["Donovan Hodgman", "Kristina Botha"])], expect: "answer", why: "the team's numbers, with Donovan's own line in them" },
      { lookups: [t("sales_stats", { period: "this_month" })], expect: "continue", why: "the team total without Donovan's own line" },
    ],
  },
  {
    id: "workshop-stuck",
    question: "Why is the Scout job card stuck?",
    subject: "workshop",
    cases: [
      { lookups: [t("vehicles", { kind: "workshop" })], expect: "answer", why: "the workshop's job cards" },
      { lookups: [t("stuck", { lead: "Scout" })], expect: "continue", why: "the deal check doesn't read job cards" },
    ],
  },
  {
    id: "compare-workshop",
    question: "Compare the workshop's job cards this week vs last week",
    subject: "workshop",
    cases: [
      { lookups: [t("vehicles", { kind: "workshop" })], expect: "answer", why: "the workshop's job cards" },
      { lookups: [t("find_leads"), t("find_leads")], expect: "continue", why: "deals are not job cards" },
    ],
  },
  {
    id: "delivery-late",
    question: "Why is Anna's delivery late?",
    subject: "delivery",
    cases: [
      { lookups: [t("deliveries"), t("why", { record: "Anna" })], expect: "answer", why: "the delivery record and its history" },
      { lookups: [t("deliveries")], expect: "continue", why: "the record without its history" },
      { lookups: [t("lead_brief", { lead: "Anna" })], expect: "continue", why: "the deal brief is not the delivery record" },
    ],
  },
  {
    id: "parts-short",
    question: "Why are we short of brake pads for the XL?",
    subject: "parts",
    cases: [
      { lookups: [t("parts", { search: "brake pads XL" })], expect: "answer", why: "the parts stock" },
      { lookups: [t("sales_stats")], expect: "continue", why: "sales numbers are not stock" },
    ],
  },
  {
    id: "invoice-unpaid",
    question: "Why hasn't Anna's invoice been paid?",
    subject: "invoices",
    cases: [
      { lookups: [t("invoices", { customer: "Anna" })], expect: "answer", why: "the invoice and what was received" },
      { lookups: [t("find_leads")], expect: "continue", why: "a deal list is not the invoice" },
    ],
  },
  // Sales questions: the rules that already hold must keep holding.
  {
    id: "deal-stuck",
    question: "Why is the Jacobs deal stuck?",
    subject: "deal",
    cases: [
      { lookups: [t("stuck", { lead: "Jacobs" })], expect: "answer", why: "the stuck check" },
      { lookups: [t("lead_brief", { lead: "Jacobs" })], expect: "answer", why: "the deal in depth" },
      { lookups: [t("find_leads")], expect: "continue", why: "a list alone isn't why" },
    ],
  },
  {
    id: "deal-what-should",
    question: "What should I do with the Jacobs deal?",
    subject: "deal",
    cases: [
      { lookups: [t("lead_brief", { lead: "Jacobs" })], expect: "answer", why: "the deal in depth" },
      { lookups: [t("find_leads")], expect: "continue", why: "a list alone isn't advice" },
    ],
  },
  {
    id: "sales-slower",
    question: "Why are sales slower this month?",
    subject: "people",
    cases: [
      { lookups: [t("sales_stats")], expect: "answer", why: "the numbers behind sales" },
      { lookups: [], expect: "continue", why: "nothing looked up yet" },
    ],
  },
];
