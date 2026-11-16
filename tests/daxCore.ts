import { readFileSync } from "node:fs";

/**
 * DAX'S CORE AS ONE TEXT, IN ITS ORIGINAL ORDER — for the tests that pin DAX's code by its words.
 *
 * crmAssistant.ts is being split into smaller files (docs/file-split-plan-2026-11-16.md). The code moves; what it
 * says does not. This puts the moved parts back where they stood — each group just above the code that followed it —
 * so a pin (or a slice between two names) reads the same code it always did, wherever that code now lives. Each split
 * step adds its files here, in the order they were in, under the anchor that now follows them.
 *
 * `read`: the test's own reader (raw, or with comments stripped), applied to every file the same way.
 */
export const DAX_CORE_GROUPS: readonly { before: RegExp; files: readonly string[] }[] = [
  {
    // Steps 2 and 3: the lookups stood above playbook.
    before: /(export )?async function playbook\(/,
    files: [
      "src/lib/assistant/lookupKit.ts",
      "src/lib/assistant/lookups/leads.ts",
      "src/lib/assistant/lookups/quotes.ts",
      "src/lib/assistant/lookups/activities.ts",
      "src/lib/assistant/lookups/customers.ts",
      "src/lib/assistant/lookups/leadBrief.ts",
      "src/lib/assistant/lookups/knowledge.ts",
      "src/lib/assistant/lookups/recall.ts",
      "src/lib/assistant/lookups/schedule.ts",
      "src/lib/assistant/lookups/vehicles.ts",
      "src/lib/assistant/lookups/deliveries.ts",
      "src/lib/assistant/lookups/documents.ts",
    ],
  },
  {
    // Step 4: the conversation stood above the safeCodexError re-export (its three constants sat near the top; a
    // pin reading them still finds them, only in this place).
    before: /export \{ safeCodexError \};/,
    files: ["src/lib/assistant/context.ts"],
  },
];
export const DAX_CORE_FILES: readonly string[] = DAX_CORE_GROUPS.flatMap((group) => group.files);

export function daxCore(read: (rel: string) => string = (rel) => readFileSync(rel, "utf8")): string {
  // Each file's own import lines are left out: they never stood there, and a slice from one moved function to the next
  // (customersNamed → leadBrief) would read them.
  const code = (rel: string) => read(rel).replace(/^(?:import [^;]*;[ \t]*\r?\n)+(?:\r?\n)?/, "");
  let core = read("src/lib/crmAssistant.ts");
  for (const { before, files } of DAX_CORE_GROUPS) {
    const fnAt = core.search(before);
    if (fnAt < 0) throw new Error(`daxCore: ${before} not found in crmAssistant.ts — update DAX_CORE_GROUPS' anchor`);
    const at = core.lastIndexOf("\n\n", fnAt) + 2;
    core = `${core.slice(0, at)}${files.map(code).join("\n")}\n${core.slice(at)}`;
  }
  return core;
}
