import { readFileSync } from "node:fs";

/**
 * DAX'S CORE AS ONE TEXT, IN ITS ORIGINAL ORDER — for the tests that pin DAX's code by its words.
 *
 * crmAssistant.ts is being split into smaller files (docs/file-split-plan-2026-11-16.md). The code moves; what it
 * says does not. This puts the moved parts back where they stood — just above leadBrief, which followed them — so a
 * pin (or a slice between two names) reads the same code it always did, wherever that code now lives. Each split step
 * adds its files here, in the order they were in, and moves the anchor to whatever now follows them.
 *
 * `read`: the test's own reader (raw, or with comments stripped), applied to every file the same way.
 */
export const DAX_CORE_FILES = [
  "src/lib/assistant/lookupKit.ts",
  "src/lib/assistant/lookups/leads.ts",
  "src/lib/assistant/lookups/quotes.ts",
  "src/lib/assistant/lookups/activities.ts",
  "src/lib/assistant/lookups/customers.ts",
  // Step 3.
  "src/lib/assistant/lookups/leadBrief.ts",
  "src/lib/assistant/lookups/knowledge.ts",
  "src/lib/assistant/lookups/recall.ts",
  "src/lib/assistant/lookups/schedule.ts",
  "src/lib/assistant/lookups/vehicles.ts",
  "src/lib/assistant/lookups/deliveries.ts",
  "src/lib/assistant/lookups/documents.ts",
] as const;

export function daxCore(read: (rel: string) => string = (rel) => readFileSync(rel, "utf8")): string {
  const core = read("src/lib/crmAssistant.ts");
  // The moved code stood just above playbook's doc comment.
  const fnAt = core.search(/(export )?async function playbook\(/);
  if (fnAt < 0) throw new Error("daxCore: playbook not found in crmAssistant.ts — update DAX_CORE_FILES' anchor");
  const at = core.lastIndexOf("\n\n", fnAt) + 2;
  // Each file's own import lines are left out: they never stood there, and a slice from one moved function to the next
  // (customersNamed → leadBrief) would read them.
  const code = (rel: string) => read(rel).replace(/^(?:import [^;]*;[ \t]*\r?\n)+(?:\r?\n)?/, "");
  return `${core.slice(0, at)}${DAX_CORE_FILES.map(code).join("\n")}\n${core.slice(at)}`;
}
