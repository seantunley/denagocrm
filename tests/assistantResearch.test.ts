import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { MAX_LOOKUPS, MAX_PARALLEL, parseSteps, planInstructions } from "../src/lib/crmAssistantPlan";
import { MIN_METHOD_LOOKUPS, methodInstructions } from "../src/lib/assistantMemory";

// crmAssistant reaches server-only + Prisma; the recall ranking is pure, so load it with those stubbed.
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const realLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  return realLoad.call(this, request, parent, isMain);
};

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("independent lookups come as one batch; a bad one is dropped, not the batch", () => {
  assert.deepEqual(parseSteps('{"tool":"pipeline_summary"}'), [{ tool: "pipeline_summary", args: {} }]);
  assert.deepEqual(parseSteps('{"tool":"done"}'), [{ tool: "done" }]);
  assert.deepEqual(
    parseSteps('{"lookups":[{"tool":"find_leads","args":{"assignedTo":"Donovan"}},{"tool":"find_leads","args":{"assignedTo":"Kristina"}}]}'),
    [
      { tool: "find_leads", args: { assignedTo: "Donovan" } },
      { tool: "find_leads", args: { assignedTo: "Kristina" } },
    ],
  );
  // Invented tools and extra fields go; the valid one stays.
  assert.deepEqual(
    parseSteps('{"lookups":[{"tool":"run_sql","args":{"q":"select"}},{"tool":"find_leads","args":{"hack":1}},{"tool":"schedule"}]}'),
    [{ tool: "schedule", args: {} }],
  );
  // Capped per step; "done" beside real lookups means nothing.
  const many = { lookups: Array.from({ length: 8 }, (_, i) => ({ tool: "knowledge", args: { topic: `t${i}` } })) };
  assert.equal(parseSteps(JSON.stringify(many))?.length, MAX_PARALLEL);
  assert.deepEqual(parseSteps('{"lookups":[{"tool":"done"},{"tool":"pipeline_summary"}]}'), [{ tool: "pipeline_summary", args: {} }]);
  for (const bad of ["no json", '{"lookups":[]}', '{"lookups":[{"tool":"nope"}]}', '{"tool":"nope"}']) {
    assert.equal(parseSteps(bad), null, bad);
  }
  assert.match(planInstructions({ today: "2026-10-05", userName: "Sean", stages: [], staff: [], activityTypes: [] }), /up to 3 at once: \{"lookups":\[/);
});

test("the loop runs a batch side by side, skips repeats, and stops at the total cap", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const loop = lib.slice(lib.indexOf("const observations: Observation[] = [];"), lib.indexOf("const [profileRaw, company]"));
  assert.ok(loop.length > 200);
  assert.match(loop, /step < MAX_STEPS && observations\.length < MAX_LOOKUPS/);
  assert.match(loop, /const next = parseSteps\(reply\.text\)/);
  assert.match(loop, /if \(seen\.has\(key\)\) continue;/, "a lookup already run isn't run again");
  assert.match(loop, /fresh\.slice\(0, MAX_LOOKUPS - observations\.length\)/);
  assert.match(loop, /await Promise\.all\(\s*batch\.map/);
  assert.match(loop, /runTool\(user, s\)\.catch\(/, "one failed lookup doesn't sink the batch");
  assert.ok(MAX_LOOKUPS >= MAX_PARALLEL);
});

test("recall searches the words that matter and ranks by how many it matches", async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { recallWords, rankRecall } = require("../src/lib/crmAssistant") as typeof import("../src/lib/crmAssistant");
  assert.deepEqual(recallWords("What did we decide about the Jacobs fleet deal last week?"), ["jacobs", "fleet", "deal"]);
  assert.deepEqual(recallWords("finance finance FINANCE"), ["finance"]);
  const at = (d: number) => new Date(Date.UTC(2026, 9, d));
  const turns = [
    { question: "fleet pricing", answer: "R1.2m", createdAt: at(3) },
    { question: "Jacobs fleet deal?", answer: "Hold until finance", createdAt: at(1) },
    { question: "weather", answer: "sunny", createdAt: at(4) },
    { question: "Jacobs", answer: "", createdAt: at(2) },
  ];
  assert.deepEqual(rankRecall(turns, ["jacobs", "fleet", "deal"]).map((t) => t.question), ["Jacobs fleet deal?", "fleet pricing", "Jacobs"]);
  const lib = code("src/lib/crmAssistant.ts");
  const recall = lib.slice(lib.indexOf("async function recall("), lib.indexOf("const RECALL_MATCHES"));
  assert.match(recall, /userId: user\.id/, "only this person's own conversations");
  assert.equal((recall.match(/userId: user\.id/g) ?? []).length, 3, "the turns either side are this person's too");
});

test("after several lookups it may save the method as a playbook — never on a quick answer", () => {
  assert.equal(methodInstructions([{ tool: "find_leads", args: {} }]), "");
  const two = [
    { tool: "find_leads", args: { noContactDays: 7 } },
    { tool: "lead_brief", args: { lead: "x" } },
  ];
  assert.equal(two.length, MIN_METHOD_LOOKUPS);
  const text = methodInstructions(two);
  assert.match(text, /^METHOD\. Answering this took several lookups:\n1\. find_leads \{"noContactDays":7\}\n2\. lead_brief/);
  assert.match(text, /not one about a particular customer/);
  assert.match(text, /improve it \(replace\)/);
  assert.match(code("src/lib/crmAssistant.ts"), /LEARN_INSTRUCTIONS,\s*methodInstructions\(observations\),/);
});

test("tasks are proposed only in chat; a scheduled run asks nothing back", async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { CHANNEL_RULES } = require("../src/lib/crmAssistant") as typeof import("../src/lib/crmAssistant");
  assert.equal(CHANNEL_RULES.chat, "");
  assert.match(CHANNEL_RULES.schedule, /don't ask them anything and don't offer choices/);
  assert.match(CHANNEL_RULES.whatsapp, /put the draft itself in your answer/);
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /const actions = source !== "chat" \? \[\] : await resolveActions/);
  assert.match(lib, /const choices = source === "schedule" \? \[\] : choiceSplit\.choices;/);
  assert.match(lib, /source,\s*scheduleId: source === "schedule" \? opts\.scheduleId \?\? null : null,/);
  // The browser can't pick a source: the action passes none.
  assert.match(code("src/app/actions/assistant.ts"), /return askCrm\(user, q, typeof page === "string" \? page\.slice\(0, 200\) : null\);/);
});

test("running for someone without a session re-checks membership, permission and module", () => {
  const helper = code("src/lib/assistantUser.ts");
  assert.match(helper, /await resolveTenantMemberUser\(userId\);\s*if \(!member\) return null;/);
  assert.match(helper, /if \(!\(await hasAnyPermission\(user, \.\.\.ASSISTANT_PERMISSIONS\)\)\) return null;/);
  assert.match(helper, /if \(!\(await isModuleEnabled\("automation"\)\)\) return null;/);
  assert.match(code("src/app/actions/assistant.ts"), /import \{ ASSISTANT_PERMISSIONS \} from "@\/lib\/assistantUser";/);
});
