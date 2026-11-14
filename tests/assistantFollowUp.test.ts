import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { FOLLOW_UP_CODE, WORDING_EDIT_RULE, followUpRoute } from "../src/lib/assistantFollowUp";

const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("a clear thank-you takes the shortcut — SA English, emoji, the assistant's name", () => {
  for (const q of ["Shot, thanks", "Thanks!", "shot", "Sharp sharp", "Lekker, thank you!", "Cheers DAX 👍", "ok thanks", "thanks a lot", "Much appreciated.", "thx", "Dankie"]) {
    assert.equal(followUpRoute(q), "ack", q);
  }
});

test("a wording-only edit is rewritten from the conversation", () => {
  for (const q of ["Make it warmer", "make it a bit shorter please", "Can you make it shorter?", "less salesy", "More formal", "shorten it", "tone it down", "Make the email friendlier"]) {
    assert.equal(followUpRoute(q), "wording", q);
  }
  assert.match(WORDING_EDIT_RULE, /Keep every figure, amount, date, name, product, recipient and Cc exactly/);
});

test("anything mixed, a question, a name, a figure or an instruction goes the full way (conservative)", () => {
  for (const q of [
    "Thanks, has she paid yet?",
    "Thanks, and Marcel?",
    "ok send it",
    "no thanks",
    "thanks 2",
    "Make it warmer for Anna",
    "Make it R5 000 cheaper",
    "Add the Golf Caddie",
    "Turn that into a WhatsApp",
    "What's overdue?",
    "",
  ]) {
    assert.equal(followUpRoute(q), "full", q);
  }
  // A fresh photo may change what the words mean.
  assert.equal(followUpRoute("thanks", true), "full");
});

test("the workspace's own assistant name counts like DAX — beside a bare thank-you or greeting only", () => {
  assert.equal(followUpRoute("Thanks Jarvis", false, "Jarvis"), "ack");
  assert.equal(followUpRoute("Shot jarvis 👍", false, "Jarvis"), "ack");
  assert.equal(followUpRoute("Hi Jarvis!", false, "Jarvis"), "chat");
  assert.equal(followUpRoute("Cheers DAX", false, "Jarvis"), "ack", "DAX is still recognised");
  // No name given: an unknown word, so the full way (safe, just slower).
  assert.equal(followUpRoute("Thanks Jarvis"), "full");
  assert.equal(followUpRoute("Hi Jarvis"), "full");
  // The name never widens anything else.
  assert.equal(followUpRoute("Jarvis, has Anna paid?", false, "Jarvis"), "full");
  assert.equal(followUpRoute("Jarvis send it", false, "Jarvis"), "full");
  assert.equal(followUpRoute("Thanks Anna, and the deposit?", false, "Anna"), "full", "a name that is also a customer's widens nothing");
  assert.equal(followUpRoute("Jarvis", false, "Jarvis"), "full", "the name alone is no greeting");
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /const route = followUpRoute\(question, Boolean\(opts\.images\?\.length\), parseProfile\(profileRaw\)\.name\);/);
  assert.ok(lib.indexOf("const profileRead = getSetting(ASSISTANT_PROFILE_KEY);") < lib.indexOf("const thread = tasksOn"), "read alongside the conversation pick");
});

test("the small talk DAX already answered without research keeps doing so", () => {
  for (const q of ["Hi", "ok", "👍", "Who are you?", "Good morning"]) assert.equal(followUpRoute(q), "chat", q);
  assert.deepEqual(new Set(Object.values(FOLLOW_UP_CODE)).size, 4, "each route has its own code in the timings");
});

test("a route that never researches reads no CRM context, and the timings say which route ran", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const ask = lib.slice(lib.indexOf("export async function askCrm("));
  // Decided BEFORE the reads, from the words alone.
  const decided = ask.indexOf("const route = followUpRoute(question, Boolean(opts.images?.length), parseProfile(profileRaw).name);");
  const reads = ask.indexOf("await Promise.all([\n    isCodexConnected(),");
  assert.ok(decided > 0 && decided < reads, "routed before anything is read");
  // The page's record, the workspace's stages/staff/types and the listed-record re-check: none on a light route.
  assert.match(ask, /light \? "" : pageContext\(user, page\),\s*light \? quietContext\(user\) : planContext\(user\),/);
  assert.match(ask, /const slots: ListedSlot\[\] = earlierList\.length && !light\s*\? await listedNow/);
  assert.match(lib, /async function quietContext\(user: User\)[^{]*\{\s*return \{ today: johannesburgDateKey\(new Date\(\)\), userName: user\.name \|\| "the user", stages: \[\], staff: \[\], activityTypes: \[\] \};/);
  // No lookup: no fast path, no research round.
  assert.match(ask, /const fast = images\.length \|\| light \? null : fastPath\(/);
  assert.match(ask, /const research = !light && !fast;/);
  // Numbers only — never the words.
  assert.match(ask, /timings\.followUp = FOLLOW_UP_CODE\[route\];/);
  // The wording rule reaches the answer step on a wording edit only.
  assert.match(ask, /route === "wording" \? WORDING_EDIT_RULE : "",/);
});
