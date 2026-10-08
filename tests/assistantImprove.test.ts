import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { activityArgs, isSmallTalk, leadArgs, lookupStatus, planInstructions, ANSWER_RULES } from "../src/lib/crmAssistantPlan";

// From real questions asked in production on 2026-10-05 that got weak answers.
const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const lib = code("src/lib/crmAssistant.ts");
const fn = (name: string) => lib.slice(lib.indexOf(`async function ${name}(`), lib.indexOf("\n}\n", lib.indexOf(`async function ${name}(`)));

test('"How many leads came in last month?" — a real count over the calendar month, any status', () => {
  assert.equal(leadArgs.safeParse({ status: "any", createdFrom: "2026-09-01", createdTo: "2026-09-30" }).success, true);
  assert.equal(leadArgs.safeParse({ createdFrom: "1 Sept" }).success, false, "dates are YYYY-MM-DD only");
  const find = fn("findLeads");
  assert.match(find, /\.\.\.\(args\.status === "any" \? \{\} : \{ status: args\.status \?\? "open" \}\)/);
  assert.match(find, /createdTo \? \{ lt: new Date\(new Date\(`\$\{args\.createdTo\}T00:00:00\+02:00`\)\.getTime\(\) \+ DAY\) \}/, "the whole last day counts");
  assert.match(find, /prisma\.lead\.count\(\{ where \}\)/, "the total isn't capped at the rows read");
  assert.match(find, /data: \[\{ total, listed: page\.length \}, \.\.\.page\.map/);
  const plan = planInstructions({ today: "2026-10-05", userName: "Sean", stages: [], staff: [], activityTypes: [] });
  assert.match(plan, /last month is the previous calendar month, not the last 30 days/);
  assert.match(ANSWER_RULES, /a TOTAL in the results is the real count: give it/);
});

test('"What does Donovan have to do today?" — today AND what\'s overdue, including meetings he attends', () => {
  assert.equal(activityArgs.safeParse({ when: "today_and_overdue", assignedTo: "Donovan" }).success, true);
  const find = fn("findActivities");
  assert.match(find, /today_and_overdue: \{ lt: new Date\(startOfToday\.getTime\(\) \+ DAY\) \}/);
  assert.match(find, /attendees: \{ some: \{ user: \{ name: fuzzy\(args\.assignedTo\) \} \} \}/);
  assert.match(find, /overdue: true/, "late items are marked");
});

test('"When is the next golf day?" — events are searched in the calendar by their words', () => {
  assert.equal(activityArgs.safeParse({ when: "upcoming", search: "golf day" }).success, true);
  assert.match(fn("findActivities"), /args\.search \? \[\{ OR: \[\{ summary: fuzzy\(args\.search\) \}, \{ note: fuzzy\(args\.search\) \}\] \}\]/);
  assert.match(planInstructions({ today: "2026-10-05", userName: "Sean", stages: [], staff: [], activityTypes: [] }), /events live here, not in knowledge/);
});

test('"Has Lisa opened her quote?" — several Lisas: read the likeliest in full; a draft was never sent', () => {
  const brief = fn("leadBrief");
  assert.doesNotMatch(brief, /Several leads match — ask which one/, "no more stopping at a list of names");
  assert.match(brief, /const \[best, \.\.\.others\] = \[\.\.\.matches\]\.sort\(/);
  assert.match(brief, /otherMatches: others\.map/);
  // (A draft sent from the signing hub HAS been sent — assistantSigningQuotes.test.ts.)
  assert.match(lib, /return q\.status === "draft" && !s \? "not sent yet \(still a draft\)" : "not yet";/);
  assert.equal((lib.match(/viewedByCustomer\((quote|q), signing\.get\((quote|q)\.id\)\)/g) ?? []).length, 3, "every place a quote's opened state is shown");
  assert.match(ANSWER_RULES, /a quote still in draft hasn't been sent, so it hasn't been opened/);
});

test("small talk skips the research round — and nothing that could be about the CRM does", () => {
  for (const q of ["Hi", "hi DAX!", "Thanks", "thank you.", "👍", "😂😂", "Who are you?", "What can you do?", "Good morning", "ok"]) assert.equal(isSmallTalk(q), true, q);
  for (const q of ["Hi, how's the pipeline?", "Thanks — and Donovan's?", "What's overdue?", "Who is Lisa?", "who are you talking to today", "12", "#1", "", "Can you tell me a joke about Gavin's deal?"]) {
    assert.equal(isSmallTalk(q), false, q);
  }
  assert.match(lib, /const research = !\(isSmallTalk\(question\) && !images\.length\) && !fast;/, "an attached image always gets the normal path");
  assert.match(lib, /for \(let step = 0; research && step < MAX_STEPS/);
});

test("no hedging filler", () => {
  assert.match(ANSWER_RULES, /Answer what was asked, then stop\. No disclaimers/);
});

test("the research step runs on the quicker model; the answer doesn't", () => {
  assert.match(lib, /export const PLAN_MODEL = "gpt-6-astra";/);
  // Every research call — first try, firm retry, transient retry — goes through the one plan helper.
  assert.equal((lib.match(/preferModel: PLAN_MODEL/g) ?? []).length, 1, "the one plan call");
  assert.match(lib, /const plan = \(step: number, insist: boolean\) =>[\s\S]{0,200}preferModel: PLAN_MODEL/);
  // (lastIndexOf: degraded mode earlier in askCrm builds its rows too.)
  const answer = lib.slice(lib.indexOf("const answerReply = await withRetry("), lib.lastIndexOf("const rows = dedupeRows("));
  assert.ok(answer.length > 100, "found the answer step");
  assert.doesNotMatch(answer, /preferModel/);
});

test("while it researches, the person sees what it's doing", () => {
  assert.equal(lookupStatus([{ tool: "find_leads" }]), "Checking leads…");
  assert.equal(lookupStatus([{ tool: "lead_brief", args: { lead: "Lisa" } }]), "Reading Lisa's lead…");
  assert.equal(lookupStatus([{ tool: "lead_brief", args: { lead: "cmuh795ui0001jp04ir2xjozw" } }]), "Reading the lead…", "an id is never shown");
  assert.equal(lookupStatus([{ tool: "find_leads" }, { tool: "find_leads" }, { tool: "schedule" }]), "Checking leads and checking the calendar…");
  assert.equal(lookupStatus([{ tool: "find_activities" }, { tool: "find_leads" }, { tool: "find_quotes" }]), "Checking activities, checking leads and checking quotes…", "one sentence, one capital");
  assert.match(lib, /progress\(lookupStatus\(batch\)\);/);
  assert.match(code("src/app/api/assistant/ask/route.ts"), /onProgress: \(status\) => \{\s*send\(\{ t: "status", v: status \}\);/);
  assert.match(code("src/components/askStream.ts"), /if \(event\.t === "status"\) onStatus\(event\.v\);/);
});
