import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** Source with comments stripped — a naive regex otherwise matches the very
 *  comment that documents the fix. */
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Every .ts/.tsx module under `dir`, as repo-relative POSIX paths. */
function modulesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".next") out.push(...modulesUnder(rel));
    } else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** The one module allowed to write a Lead row. */
const HOME = "src/lib/leadCreate.ts";

/**
 * FIVE code paths each ran `prisma.lead.create` with their own idea of what
 * "a lead was created" means:
 *
 *   leadIntake.ts   audit + push + lead_created automation   (the complete one)
 *   actions/leads.ts  audit + automation
 *   whatsapp.ts     audit only
 *   messenger.ts    audit only            (Facebook / Instagram DMs)
 *   flowActions.ts  no audit, no push, no automation   (the chatbot)
 *
 * So a rule configured "when a new lead is created → notify me / create a
 * follow-up activity" fired for web-form and manual leads and did NOTHING for
 * WhatsApp, Facebook, Instagram and chatbot leads. Staff got no push for an
 * inbound WhatsApp lead. The bot's leads had no audit trail at all.
 *
 * These are source-scanning tests because the property is architectural: a
 * behavioural test cannot see a SIXTH path that someone adds next month.
 */

test("only one module creates a Lead", () => {
  const offenders = modulesUnder("src")
    .filter((rel) => rel !== HOME)
    .filter((rel) => /\b(base)?[Pp]risma\.lead\.create\(/.test(shipped(rel)));
  assert.deepEqual(
    offenders,
    [],
    `these create a lead outside ${HOME}, so they can skip the audit, the push ` +
      `and the lead_created trigger:\n  ${offenders.join("\n  ")}`,
  );
});

test("a transaction cannot smuggle a second path in", () => {
  // `tx.lead.create` inside an interactive transaction is the same write with a
  // different client name — the regex above would not see it.
  const offenders = modulesUnder("src")
    .filter((rel) => rel !== HOME)
    .filter((rel) => /\btx\.lead\.create\(/.test(shipped(rel)));
  assert.deepEqual(offenders, [], `these create a lead on a transaction client outside ${HOME}`);
});

test("every inbound channel goes through the one creator", () => {
  // Named individually: these are the four that were missing something, and a
  // silent revert to a local create is exactly the regression this guards.
  for (const [rel, what] of [
    ["src/lib/leadIntake.ts", "website / Lead Ads intake"],
    ["src/app/actions/leads.ts", "the staff form"],
    ["src/lib/whatsapp.ts", "inbound WhatsApp"],
    ["src/lib/messenger.ts", "Facebook / Instagram DMs"],
    ["src/lib/flowActions.ts", "the chatbot"],
  ] as const) {
    assert.match(
      shipped(rel),
      /createLeadRecord(IfPipelineReady)?\(/,
      `${what} (${rel}) must create its lead through ${HOME}`,
    );
  }
});

test("the creator owns everything a new lead owes the workspace", () => {
  // If any of these moves back out to the call sites, the sources diverge again.
  const core = shipped(HOME);
  // The Journey engine is the one surviving automation engine; runLeadAutomations
  // and the AutomationRule engine behind it are retired.
  assert.match(core, /emitLeadJourneyEvent\("lead_created", lead\.id/, "the automation trigger");
  assert.doesNotMatch(core, /runLeadAutomations/, "the retired engine must not come back");
  assert.match(core, /sendPushToAll\(/, "the push");
  // A strict audit for staff-facing paths — and now INSIDE the transaction that
  // creates the lead. Auditing after the commit is what turned an audit failure
  // into duplicate leads in production: the row was already there, the operator
  // was told it had failed, and they tried again.
  assert.match(core, /logAuditStrict\(auditFor\(created\), tx\)/, "a strict audit, atomic with the row");
  // …and a best-effort one for webhooks, deliberately OUTSIDE the transaction:
  // logAudit swallows its error, and swallowing one inside a transaction is
  // worse than not catching it — PostgreSQL has already aborted, so the commit
  // dies anyway and takes the lead with it.
  assert.match(core, /logAudit\(auditFor\(lead\)\)/, "…and a best-effort one for webhooks");
  // Top-of-column placement. Resolved BEFORE the transaction now, so the write
  // does not hold its locks across an extra query — the value it produces is
  // what matters, not where the call sits.
  assert.match(core, /const position = await topPosition\(stageId\)/, "top-of-column placement");
  assert.match(core, /^\s*position,$/m, "…and it reaches the row");
});

test("a webhook is not failed by its own side effects", () => {
  // The DM, WhatsApp and bot handlers run inside webhooks. A push provider that
  // is down, or a broken automation rule, must not cost us the customer's
  // message — which is why these are best-effort and why the pipeline-not-ready
  // case returns null instead of throwing.
  const core = shipped(HOME);
  assert.match(core, /sendPushToAll\([\s\S]*?\)\.catch\(\(\) => \{\}\)/, "the push must be best-effort");
  assert.match(
    core,
    /export async function createLeadRecordIfPipelineReady/,
    "inbound channels need the non-throwing variant they each carried as an `if (firstStage)` guard",
  );
  assert.match(core, /if \(!stageId\) return null;/);
});

test("the staff form still decides its own stage", () => {
  // The form passes a stage it has ALREADY validated as open. Resolving one in
  // the creator would silently move a lead the user deliberately placed.
  const core = shipped(HOME);
  assert.match(core, /if \(stageId\) return stageId;/, "an explicit stage must win");
  assert.match(core, /pipelineStage\.findFirst\(\{ orderBy: \{ order: "asc" \} \}\)/, "…and only then the first stage");
});
