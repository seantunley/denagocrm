/**
 * Live research-quality eval runner.
 *
 * Reads a JSON file of recorded traces (from askCrm or a capture script),
 * scores them with the pure harness, and prints a report.
 *
 * Usage:
 *   npx tsx evals/runResearchEval.ts path/to/traces.json
 *
 * traces.json shape:
 *   [{ "scenarioId": "why-stuck", "tools": ["find_leads","lead_brief"], "steps": 2,
 *      "hitBudget": false, "answer": "...", "latencyMs": 4200, "tokens": 1800 }]
 *
 * A future capture step can call askCrm and write this file. The scorer stays pure.
 */
import { readFileSync } from "node:fs";
import { RESEARCH_SCENARIOS, formatReport, scoreTrace, type ResearchTrace } from "./daxResearchQuality";

type Recorded = ResearchTrace & { scenarioId: string };

function load(path: string): Recorded[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("traces file must be an array");
  return raw as Recorded[];
}

export function scoreRecorded(records: Recorded[]) {
  return records.map((r) => {
    const scenario = RESEARCH_SCENARIOS.find((s) => s.id === r.scenarioId);
    if (!scenario) return { scenarioId: r.scenarioId, score: 0, checks: [{ name: "unknown-scenario", ok: false }] };
    return scoreTrace(scenario, r);
  });
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: npx tsx evals/runResearchEval.ts <traces.json>");
    process.exit(1);
  }
  const scores = scoreRecorded(load(path));
  console.log(formatReport(scores));
  const mean = scores.reduce((s, x) => s + x.score, 0) / (scores.length || 1);
  process.exit(mean >= 70 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();


export type AskFn = (question: string) => Promise<{ tools: string[]; steps: number; answer: string; latencyMs?: number }>;

/**
 * Run the scenarios against a live ask function (askCrm in a script, or a
 * mock in tests). Returns scores. Does not itself open a database.
 */
export async function runLive(ask: AskFn) {
  const records = [];
  for (const s of RESEARCH_SCENARIOS) {
    const started = Date.now();
    const result = await ask(s.question);
    records.push({
      scenarioId: s.id,
      question: s.question,
      tools: result.tools,
      steps: result.steps,
      hitBudget: false,
      answer: result.answer,
      latencyMs: result.latencyMs ?? Date.now() - started,
    });
  }
  return scoreRecorded(records);
}
