import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { planTidy, type TidyEntry } from "../src/lib/assistantMemory";

// crmAssistant reaches server-only + Prisma; describePerson is pure, so load it with those stubbed.
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

/*
 * What one person's conversation teaches it must not reach someone else before
 * the owner has looked: that conversation ran with THEIR visibility.
 */

test("unreviewed learning reaches only the person it came from", () => {
  const store = code("src/lib/assistantMemoryStore.ts");
  assert.match(store, /export const visibleTo = \(userId: string\) => \(\{ OR: \[\{ status: "approved" \}, \{ createdById: userId \}\] \}\);/);
  const load = store.slice(store.indexOf("export async function loadLearned"), store.indexOf("export async function loadPlaybook"));
  assert.match(load, /kind: "memory", \.\.\.visibleTo\(userId\)/);
  assert.match(load, /kind: "profile", userId \}/, "a profile only for the person it describes");
  assert.match(load, /kind: "playbook", \.\.\.visibleTo\(userId\)/);
  const book = store.slice(store.indexOf("export async function loadPlaybook"), store.indexOf("export async function applyLearn"));
  assert.match(book, /\.\.\.visibleTo\(userId\)/, "loading a playbook by name can't reach someone else's unreviewed one");
  assert.match(code("src/lib/crmAssistant.ts"), /loadPlaybook\(name, user\.id\)/);
});

test("learning can only match, rewrite or remove what that person may see", () => {
  const store = code("src/lib/assistantMemoryStore.ts");
  const apply = store.slice(store.indexOf("export async function applyLearn"));
  assert.match(apply, /const mine = \(e: \(typeof all\)\[number\]\) => e\.status === "approved" \|\| e\.createdById === userId;/);
  assert.match(apply, /const entries: Entry\[\] = all\.filter\(mine\)/);
  assert.match(apply, /planNoteChanges\(entries, ops, Math\.max\(0, limit - othersSize\)\)/, "others' entries still count against the cap");
  assert.match(apply, /const where = \{ \.\.\.scope, createdById: userId \};/, "writes re-assert ownership");
  assert.match(apply, /existing\.status === "approved" \|\| existing\.createdById !== userId\) continue;/);
});

test("the nightly tidy-up never merges two people's unreviewed entries", () => {
  const entry = (id: string, createdById: string | null): TidyEntry => ({ id, kind: "memory", userId: null, createdById, content: `fact ${id}`, status: "unreviewed" });
  const block = { merge: [{ ids: ["a", "b"], content: "fact a and b" }] };
  assert.deepEqual(planTidy([entry("a", "u1"), entry("b", "u2")], block), []);
  assert.equal(planTidy([entry("a", "u1"), entry("b", "u1")], block).length, 1);
  assert.match(code("src/lib/assistantTidy.ts"), /createdById: true/);
});

test("a person's own 'about me' is theirs alone, written by them", () => {
  const actions = code("src/app/actions/assistantNotes.ts");
  const save = actions.slice(actions.indexOf("export async function saveMyAssistantNote"));
  assert.match(save, /await requireAnyPermission\(\.\.\.ASSISTANT_PERMISSIONS\);\s*if \(!\(await isModuleEnabled\("automation"\)\)\) refuse/);
  assert.match(save, /const mine = \{ tenantId, kind: "profile", userId: user\.id \};/);
  assert.match(save, /updateMany\(\{ where: \{ id, \.\.\.mine \}/, "an id belonging to someone else is not found");
  assert.match(save, /pg_advisory_xact_lock/);
  assert.match(save, /PROFILE_CHAR_LIMIT/);
  assert.match(save, /scanEntry\(/, "same injection and contact-detail scan as everything it learns");
  assert.doesNotMatch(save, /summary: `[^`]*\$\{scanned/, "the audit line doesn't copy what they wrote");
  assert.match(code("src/app/(app)/assistant/page.tsx"), /saveMyAssistantNote\.bind\(null, null\)/);
});

test("the answer knows who it's talking with — the business first, then the person", async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { describePerson } = require("../src/lib/crmAssistant") as typeof import("../src/lib/crmAssistant");
  const text = describePerson({ name: "Donovan", jobTitle: "Fleet Sales Manager", sees: "their own", teams: ["Fleet"], manages: ["Fleet"] });
  assert.match(text, /^THE PERSON YOU'RE TALKING WITH: Donovan, Fleet Sales Manager\./);
  assert.match(text, /never about anyone else's/);
  assert.match(text, /They manage: Fleet — "my team" means the people in it\./);
  const owner = describePerson({ name: "Sean", jobTitle: null, sees: "everything", teams: [], manages: [] });
  assert.match(owner, /^THE PERSON YOU'RE TALKING WITH: Sean\. They can see everything in this workspace\./);
  assert.doesNotMatch(owner, /Their team|They manage/);
  const lib = code("src/lib/crmAssistant.ts");
  const person = lib.slice(lib.indexOf("export async function personContext"), lib.indexOf("export function describePerson"));
  assert.match(person, /where: \{ id: user\.id \}/, "only their own user row");
  assert.match(person, /where: \{ userId: user\.id,/);
  assert.match(lib, /const learned = \[memoryPrompt\(learnedNow\), person\]\.filter\(Boolean\)\.join\("\\n\\n"\);/);
});

test("one person can't sweep the CRM through the assistant at machine speed", () => {
  const helper = code("src/lib/assistantUser.ts");
  assert.match(helper, /const ASK_POLICY: RateLimitPolicy = \{ limit: 60, windowMs: 60 \* 60 \* 1000, blockMs: 30 \* 60 \* 1000 \};/);
  assert.match(helper, /rateLimitKey\("assistant-ask", userId\)/, "one key per person, every channel");
  const action = code("src/app/actions/assistant.ts");
  const ask = action.slice(action.indexOf("export async function askCrmAction"));
  assert.ok(
    ask.indexOf("assistantAskAllowed(user.id)") > 0 && ask.indexOf("assistantAskAllowed(user.id)") < ask.indexOf("return askCrm("),
    "checked before any lookup runs",
  );
});

test("acting for someone without a session needs exactly one workspace", () => {
  const helper = code("src/lib/assistantUser.ts");
  const body = helper.slice(helper.indexOf("export async function assistantUserFor"));
  assert.match(body, /const scope = currentTenantScope\(\);\s*if \(scope\?\.system\) return null;\s*if \(tenantEnforcing\(\) && !scope\?\.tenantId\) return null;\s*const member = await resolveTenantMemberUser/);
});
