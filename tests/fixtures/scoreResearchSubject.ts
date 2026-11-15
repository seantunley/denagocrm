import { researchGate } from "../../src/lib/assistantResearchGate";
import { RESEARCH_SUBJECT_SCENARIOS } from "./researchSubjectScenarios";

/** Every case the gate gets wrong today: the before/after measure for item 4. */
export function misrouted() {
  const wrong: string[] = [];
  let total = 0;
  for (const s of RESEARCH_SUBJECT_SCENARIOS) {
    for (const c of s.cases) {
      total++;
      const got = researchGate({
        question: s.question,
        tools: c.lookups.map((l) => l.tool),
        steps: c.lookups,
        staff: s.staff,
        lastRoundEmpty: false,
        planSaysAnswer: true,
        stepsUsed: c.lookups.length,
        maxSteps: 8,
      } as Parameters<typeof researchGate>[0]);
      if (got !== c.expect) wrong.push(`${s.id}: [${c.lookups.map((l) => l.tool).join(", ")}] → ${got}, expected ${c.expect} (${c.why})`);
    }
  }
  return { total, wrong };
}

if (process.argv[1]?.endsWith("scoreResearchSubject.ts")) {
  const { total, wrong } = misrouted();
  console.log(`${total - wrong.length}/${total} right`);
  for (const w of wrong) console.log(`  ✗ ${w}`);
}
