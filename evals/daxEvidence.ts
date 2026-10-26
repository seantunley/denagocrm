/**
 * DAX evidence evals (roadmap Phase 2, section 4): multi-turn scripted
 * scenarios run against a SEEDED LOCAL database (evals/runEvidenceEval.ts),
 * never the hosted dev database with live credentials.
 *
 * Each scenario is scored on the plan's dimensions:
 *  - work completed  — the evidence was actually reached: the lookups ran AND
 *                      returned the seeded record (checked from what the
 *                      lookups returned, not from the answer's wording);
 *  - factual accuracy — the answer holds the right figures / page / status and
 *                      not the wrong ones (the old figure stated as current, an
 *                      email called "delivered", text invented for a scan);
 *  - unnecessary questions — it did not ask the person for something the CRM had;
 *  - recovery        — where the evidence is unreadable or contradicted, it says
 *                      so instead of guessing;
 *  - time            — each turn inside its budget.
 * A fluent answer scores zero on "work completed" when the lookups show the
 * evidence was never reached.
 *
 * Pure: no database, no model. The runner feeds it real turns.
 */

export type EvidenceTurn = {
  ask: string;
  /** Lookups that must have run this turn. */
  tools: string[];
  /** Seeded record keys (see the runner's seed) that the lookups must have RETURNED this turn. */
  reached?: string[];
  mustMatch?: RegExp[];
  mustNotMatch?: RegExp[];
  /** True when nothing needs asking: a question back to the person counts against it. */
  noQuestions?: boolean;
  /** The answer must own up to what it can't do (a scan, a bounce, a contradiction). */
  recovery?: RegExp;
  maxMs?: number;
};

export type EvidenceScenario = { id: string; note: string; turns: EvidenceTurn[] };

const DEFAULT_TURN_MS = 60_000;

export const EVIDENCE_SCENARIOS: EvidenceScenario[] = [
  {
    id: "promise-vs-quote",
    note: "What did we promise about delivery, and does the quote match? The promise (R5,000) is in a 40-day-old WhatsApp, beyond what lead_brief shows; the quote says R6,500.",
    turns: [
      {
        ask: "What did we promise Hendrik about delivery?",
        tools: ["search_messages"],
        reached: ["promise"],
        mustMatch: [/R\s?5[ ,]?000/],
        noQuestions: true,
      },
      {
        ask: "And does his quote match that?",
        tools: ["find_quotes|lead_brief"],
        reached: ["quote"],
        mustMatch: [/R\s?6[ ,]?500/, /(doesn'?t|does not|don'?t|do not) match|differ|higher|more than|not the same|mismatch|^no\b|\bnot the R/im],
        mustNotMatch: [/\b(it|they|the quote) (matches|match)\b(?! ?\?)/i],
        noQuestions: true,
        recovery: /R\s?5[ ,]?000[\s\S]*R\s?6[ ,]?500|R\s?6[ ,]?500[\s\S]*R\s?5[ ,]?000/,
      },
    ],
  },
  {
    id: "contradicted-old-info",
    note: "An old message says R5,000; the quote says R6,500. Asked for the delivery cost, the current record wins and the old figure is flagged, not repeated as fact.",
    turns: [
      {
        ask: "How much is Hendrik paying for delivery? I think someone told him a different price before.",
        tools: ["search_messages", "find_quotes|lead_brief"],
        reached: ["promise", "quote"],
        mustMatch: [/R\s?6[ ,]?500/],
        mustNotMatch: [/(delivery|it) (is|costs) R\s?5[ ,]?000/i],
        noQuestions: true,
        recovery: /R\s?5[ ,]?000/,
      },
    ],
  },
  {
    id: "contract-page",
    note: "Read the signed agreement's PDF text and say which page the fee is on.",
    turns: [
      {
        ask: "What delivery fee is in Hendrik's signed sales agreement, and on which page?",
        tools: ["read_document"],
        reached: ["contract"],
        mustMatch: [/R\s?6[ ,]?500/, /page 2|p\.? ?2\b/i],
        noQuestions: true,
      },
    ],
  },
  {
    id: "scanned-pdf",
    note: "The ID copy is a scan: no text layer. It must say so — not invent what is on it.",
    turns: [
      {
        ask: "What does Hendrik's ID scan say?",
        tools: ["read_document"],
        mustMatch: [/scan/i],
        mustNotMatch: [/\b\d{13}\b/, /date of birth:? \d/i],
        recovery: /can'?t read|cannot read|unable to read|no text/i,
      },
    ],
  },
  {
    id: "bounced-email",
    note: "The email with the delivery date bounced. Never 'delivered', never 'he read it'.",
    turns: [
      {
        ask: "Did Hendrik get our email with the delivery date?",
        tools: ["search_messages|lead_brief"],
        reached: ["bounced"],
        mustMatch: [/bounc|never (got|received)|didn'?t (get|reach)|not (received|delivered)/i],
        mustNotMatch: [/\b(was|got) delivered\b/i, /\b(he|hendrik) (has )?read it\b/i],
        noQuestions: true,
        recovery: /another way|phone|whatsapp|call/i,
      },
    ],
  },
];

/** What one turn produced, captured by the runner. */
export type TurnTrace = {
  tools: string[];
  /** Seeded record keys found anywhere in what this turn's lookups returned. */
  reached: string[];
  answer: string;
  ms: number;
};

export type Check = { name: string; ok: boolean; detail?: string };
export type ScenarioScore = { id: string; score: number; checks: Check[] };

/** "a|b" — either tool will do. */
const ran = (tools: string[], want: string) => want.split("|").some((t) => tools.includes(t));

/**
 * A question back to the person: a line ending in "?" that isn't quoting the
 * customer and isn't a closing offer ("Want me to draft a reply?").
 */
export function asksThePerson(answer: string): boolean {
  return answer
    .split(/\n+/)
    .map((l) => l.trim())
    .some((l) => l.endsWith("?") && !/^(want|shall|should|would you like|do you want) (me|i)\b/i.test(l) && !/^["“']/.test(l));
}

export function scoreScenario(scenario: EvidenceScenario, turns: TurnTrace[]): ScenarioScore {
  const checks: Check[] = [];
  scenario.turns.forEach((want, i) => {
    const got = turns[i];
    const at = `turn ${i + 1}`;
    if (!got) {
      checks.push({ name: `${at}: ran`, ok: false, detail: "no trace" });
      return;
    }
    const missingTools = want.tools.filter((t) => !ran(got.tools, t));
    const missingRecords = (want.reached ?? []).filter((r) => !got.reached.includes(r));
    // Work completed: the evidence was reached. Without it nothing else counts.
    const worked = missingTools.length === 0 && missingRecords.length === 0;
    checks.push({
      name: `${at}: work completed`,
      ok: worked,
      detail: worked ? undefined : `tools missing: ${missingTools.join(", ") || "-"}; records not reached: ${missingRecords.join(", ") || "-"} (ran ${got.tools.join(", ") || "nothing"})`,
    });
    const wrongs = [
      ...(want.mustMatch ?? []).filter((r) => !r.test(got.answer)).map((r) => `missing ${r}`),
      ...(want.mustNotMatch ?? []).filter((r) => r.test(got.answer)).map((r) => `said ${r}`),
    ];
    checks.push({ name: `${at}: factual accuracy`, ok: worked && wrongs.length === 0, detail: wrongs.join("; ") || (worked ? undefined : "evidence never reached") });
    if (want.noQuestions) checks.push({ name: `${at}: no unnecessary questions`, ok: !asksThePerson(got.answer) });
    if (want.recovery) checks.push({ name: `${at}: recovery`, ok: want.recovery.test(got.answer), detail: want.recovery.test(got.answer) ? undefined : `wanted ${want.recovery}` });
    const budget = want.maxMs ?? DEFAULT_TURN_MS;
    checks.push({ name: `${at}: time`, ok: got.ms <= budget, detail: `${got.ms} ms of ${budget}` });
  });
  const passed = checks.filter((c) => c.ok).length;
  return { id: scenario.id, score: checks.length ? Math.round((passed / checks.length) * 100) : 0, checks };
}

export function evidenceReport(scores: ScenarioScore[]): string {
  const mean = scores.length ? Math.round(scores.reduce((n, s) => n + s.score, 0) / scores.length) : 0;
  const lines = [`DAX evidence: ${mean} / 100 (${scores.length} scenarios)`, ""];
  for (const s of scores) {
    lines.push(`${s.id}: ${s.score}`);
    for (const c of s.checks.filter((x) => !x.ok)) lines.push(`  - ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Which seeded records a turn's lookups returned: every string in the results,
 * matched against the seeded ids. Walks the data as returned, so an id nested
 * in a message list or a quote's link counts.
 */
export function reachedKeys(data: unknown, seeded: Record<string, string>): string[] {
  const text = JSON.stringify(data ?? null);
  return Object.entries(seeded).filter(([, id]) => text.includes(id)).map(([key]) => key);
}
