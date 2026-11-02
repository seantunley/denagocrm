import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { briefForAssistant, buildBrief, nurtureReviewLine, type BriefInput, type NurtureReview } from "../src/lib/daxBriefRules";
import { NURTURE_RULE, parseActionList } from "../src/lib/assistantActions";
import { WHATSAPP_CONFIRMABLE } from "../src/lib/assistantWhatsAppRules";
import { briefQuestion } from "../src/lib/proactiveRules";

/**
 * Round 2, item 1 (Sean, 2026-11-02: "Lets do 1, 2 and 3"): a deal parked in Nurture — Werner, "until March when his
 * bonus comes" — comes back by itself. On its review day it is in its salesperson's brief, with why it was parked,
 * what they wanted and the trigger; a review nobody acted on stays, flagged overdue. One card brings it back, through
 * the Nurture page's own Reactivate.
 */
const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

// 07:00 in Johannesburg on Thursday 5 November 2026.
const MORNING = new Date("2026-11-05T05:00:00Z");
const ME = "u-me";
const review = (id: string, reviewOn: string, extra: Partial<NurtureReview> = {}): NurtureReview => ({
  id, name: `Deal ${id}`, ownerId: ME, why: "Buying later", interest: "Rover XL", trigger: "When his bonus comes in March",
  reviewAt: new Date(`${reviewOn}T09:00:00+02:00`), ...extra,
});
const input = (nurtureReviews: NurtureReview[]): BriefInput => ({
  now: MORNING, userId: ME, userName: "Sean Tunley", leads: [], hot: [], activities: [], testDrives: [], viewedQuotes: [], deliveries: [], nurtureReviews,
});

test("the brief: due today and overdue reviews — theirs and nobody's, never another rep's — most overdue named, flagged", () => {
  const brief = buildBrief(input([
    review("today", "2026-11-05"),
    review("late", "2026-11-02", { name: "Werner Kilian" }),
    review("nobodys", "2026-11-04", { ownerId: null }),
    review("theirs", "2026-10-01", { ownerId: "u-other" }),
  ]));
  const item = brief.items.find((i) => i.key === "nurture_review");
  assert.ok(item);
  assert.equal(item.title, "3 Nurture reviews due (2 overdue)");
  assert.equal(item.detail, "Werner Kilian — Buying later · wants Rover XL · “When his bonus comes in March” · review 3 days overdue");
  assert.equal(item.href, "/leads/nurture?due=1");
  assert.equal(item.tone, "orange");
  assert.deepEqual(brief.nurtureReviews?.map((r) => [r.leadId, r.daysPastReview, r.overdue]), [["late", 3, true], ["nobodys", 1, true], ["today", 0, false]]);
  // It counts as something needing attention, and one review goes straight to its deal.
  assert.match(brief.summary, /^3 things need your attention\.$/);
  const one = buildBrief(input([review("w1", "2026-11-05")]));
  assert.equal(one.items[0].title, "1 Nurture review due");
  assert.equal(one.items[0].href, "/leads/w1");
  assert.match(one.items[0].detail ?? "", /review due today$/);
  // Another rep's only: nothing at all.
  assert.equal(buildBrief(input([review("theirs", "2026-11-01", { ownerId: "u-other" })])).items.length, 0);
  assert.equal(buildBrief(input([])).nurtureReviews, undefined);
});

test("DAX reads every review — why, wants, trigger, review day, how overdue, its link — redacted like the rest", () => {
  const brief = buildBrief(input([review("late", "2026-11-02", { name: "+27 82 555 1234", trigger: "Call 082 555 1234 when the bonus lands" })]));
  const forDax = briefForAssistant(brief);
  assert.equal(forDax.nurtureReviews?.length, 1);
  const [row] = forDax.nurtureReviews!;
  assert.equal(row.leadId, "late");
  assert.equal(row.parkedBecause, "Buying later");
  assert.equal(row.wants, "Rover XL");
  assert.equal(row.reviewOn, "2026-11-02");
  assert.equal(row.daysPastReview, 3);
  assert.equal(row.flag, "overdue review");
  assert.equal(row.link, "/leads/late");
  assert.doesNotMatch(JSON.stringify(forDax), /555/);
  assert.equal(briefForAssistant(buildBrief(input([]))).nurtureReviews, undefined);
  // A long trigger is clipped on the brief's one line; DAX still gets it whole.
  assert.ok(nurtureReviewLine({ why: "Other", interest: null, trigger: "x".repeat(300), daysPastReview: 0 }).length < 130);
});

test("the morning brief asks for a Nurture part, and the brief's loader reads only due reviews within the leads scope", () => {
  assert.match(briefQuestion(MORNING, []), /If the daily brief has nurture reviews, add a short Nurture part: each parked deal with its link/);
  const loader = code("src/lib/daxBrief.ts");
  const due = loader.slice(loader.indexOf("async function dueNurtureReviews"), loader.indexOf("async function teamMembers"));
  assert.match(due, /const ids = await getAccessibleLeadIds\(user\);/);
  assert.match(due, /status: "nurture",\s*deletedAt: null,\s*nurtureReviewAt: \{ lt: dayEnd \},\s*OR: \[\{ assignedToId: user\.id \}, \{ assignedToId: null \}\],/);
  assert.match(loader, /dueNurtureReviews\(user, dayEnd\)/);
  assert.match(code("src/lib/crmAssistantPlan.ts"), /Nurture deals whose review day has come/);
});

test("the reactivate proposal: a stage, the next action and its day", () => {
  const ok = { type: "reactivate", leadId: "cmlead00000000000000001", stage: "Contacted", next: "Call Werner at 10:00", on: "2026-11-05" };
  assert.deepEqual(parseActionList([ok]), [ok]);
  for (const bad of [{ ...ok, on: "Thursday" }, { ...ok, next: "go" }, { ...ok, stage: "" }, { ...ok, when: "2026-11-05T10:00" }]) {
    assert.deepEqual(parseActionList([bad]), [], JSON.stringify(bad));
  }
  assert.match(NURTURE_RULE, /- reactivate: bring a PARKED \(nurture\) deal back into the pipeline — offer it when its review is due or overdue/);
  assert.match(NURTURE_RULE, /or when they say the customer is ready/);
  assert.match(NURTURE_RULE, /Missing the stage or the next step\? ASK in ONE question/);
  assert.ok(WHATSAPP_CONFIRMABLE.has("reactivate"));
  assert.match(code("src/components/AssistantActionCard.tsx"), /card\.kind === "reactivate"\) && <p/);
  assert.match(code("src/lib/assistantSoul.ts"), /bring a parked deal back into the pipeline when its review day comes/);
});

test("the card: only for a parked deal, with the Nurture page's permissions, an open stage and an active salesperson", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const branch = lib.slice(lib.indexOf('} else if (p.type === "reactivate") {'), lib.indexOf('} else if (p.type === "nurture") {'));
  assert.ok(branch.length > 0);
  assert.match(branch, /if \(lead\.status !== "nurture"\) \{/);
  assert.match(branch, /hasPermission\(user, "leads\.change_stage"\)\) \|\| !\(await hasPermission\(user, "activities\.manage"\)\)/);
  assert.match(branch, /if \(!reviewDate\(p\.on\)\)/);
  assert.match(branch, /where: \{ pipelineId: lead\.stage\.pipelineId, isClosed: false \}/);
  assert.match(branch, /`Next action: \$\{p\.next\} — \$\{day\}, a to-do for \$\{owner\.name\}`/);
  assert.match(branch, /Nobody is contacted\./);
});

test("Confirm: done already writes nothing; every refusal before reactivateNurturedLead; its own action does the work", () => {
  const action = code("src/app/actions/assistant.ts");
  const run = action.slice(action.indexOf('case "reactivate": {'), action.indexOf('case "nurture": {'));
  const write = run.indexOf("await reactivateNurturedLead(card.leadId, form)");
  assert.ok(write > 0);
  const done = run.indexOf("return { ok: true, success: backIn, href: `/leads/${card.leadId}` };");
  for (const before of [
    'return untouched("You can\'t open that deal any more.")',
    'return untouched("Your role can\'t bring deals back from Nurture.")',
    'return untouched("That deal is no longer there.")',
    "if (now.status !== \"nurture\") return untouched(",
    "return untouched(STALE_CARD)",
    "!reviewDate(String(card.on ?? \"\"))",
  ]) assert.ok(run.indexOf(before) > -1 && run.indexOf(before) < write, before);
  // A second Confirm finds it open in that stage with that next action, and says so — before "no longer in Nurture".
  assert.ok(done > -1 && done < run.indexOf("if (now.status !== \"nurture\")"));
  assert.match(run, /now\.stageId !== card\.fromStageId \|\| \(now\.nurtureReviewAt\?\.toISOString\(\) \?\? null\) !== \(card\.reviewAt \?\? null\) \|\| now\.assignedToId !== card\.assignedToId/);
  assert.match(run, /await confirmed\("bring the deal back from Nurture", card\.leadId\);/);
});
