import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * "May we contact this person?" had FOUR answers.
 *
 *   consentGuard.ts        → Contact.marketingOptOut + PortalPreference
 *   communicationPolicy.ts → Contact.marketingOptOut + ConsentRecord
 *                            + quiet hours + frequency cap + duplicate guard
 *   journeyStepExecutor.ts → Contact.marketingOptOut, and nothing else
 *   automations.ts         → nothing at all
 *
 * Neither of the first two read the other's table, so someone who unsubscribed
 * in the portal kept receiving campaign and survey mail, and someone who
 * withdrew a ConsentRecord kept receiving journey and anniversary mail. Quiet
 * hours and the 3-per-24h cap applied to campaigns only, so an automation could
 * email at 03:00 uncapped. The visible symptom is "I unsubscribed and you keep
 * emailing me" — which is also the POPIA problem.
 */

test("there is exactly one consent gate", () => {
  assert.throws(() => src("src/lib/consentGuard.ts"), "the second gate must be gone entirely");

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".next") walk(full, out);
      } else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  // Only communicationPolicy may DEFINE the answer; everyone else imports it.
  const definers: string[] = [];
  for (const file of walk(path.join(root, "src"))) {
    // walk() yields ABSOLUTE paths; shipped() takes one relative to the repo.
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s+/g, " ");
    if (/export (async )?function canContactPerson/.test(code)) {
      definers.push(path.relative(root, file).split(path.sep).join("/"));
    }
  }
  assert.deepEqual(definers, ["src/lib/communicationPolicy.ts"], "a second definition is a second policy");
});

test("the one gate checks every rule the four used to check between them", () => {
  const gate = shipped("src/lib/communicationPolicy.ts");
  // The union, not the intersection — dropping any one of these would let a
  // person through who had told us not to contact them.
  assert.match(gate, /marketingOptOut/, "the contact's own flag");
  assert.match(gate, /consentRecord\.findFirst/, "a withdrawn ConsentRecord");
  assert.match(gate, /portalPreference\.findFirst/, "the portal unsubscribe switch");
  assert.match(gate, /marketingEmail === false \|\| pref\.emailMarketing === false/, "…both of its overlapping flags");
  assert.match(gate, /isCommunicationQuietHour\(now\)/, "quiet hours");
  assert.match(gate, /frequency_cap/, "the 24h frequency cap");
});

test("every outbound marketing path goes through it", () => {
  for (const [rel, why] of [
    ["src/lib/marketingCampaignQueue.ts", "campaigns"],
    ["src/lib/surveyDistributionQueue.ts", "surveys"],
    ["src/lib/lifecycleJourneys.ts", "anniversary / win-back"],
    ["src/lib/journeyStepExecutor.ts", "journey email and SMS steps"],
    ["src/lib/automations.ts", "automation rule emails"],
  ] as const) {
    assert.match(
      shipped(rel),
      /canContactPerson\(/,
      `${rel} sends marketing (${why}) and must ask the one gate first`,
    );
  }
});

test("a journey step cannot fall back to the weaker check", () => {
  // It read contact.marketingOptOut off the in-memory journey context, which
  // knows nothing about ConsentRecord, the portal switch, the hour or the cap.
  const code = shipped("src/lib/journeyStepExecutor.ts");
  assert.doesNotMatch(code, /contact\.marketingOptOut === true/, "the local opt-out read is what this replaced");
  assert.match(code, /marketingBlocked\(context, "email"\)/);
  assert.match(code, /marketingBlocked\(context, "sms"\)/);
  // No contact id means no way to check, and the safe answer is no.
  assert.match(code, /if \(!contactId\) return "no contact record to check consent against"/);
});

test("an automation email is gated before it is sent", () => {
  const code = shipped("src/lib/automations.ts");
  const gate = code.indexOf("canContactPerson(");
  const send = code.indexOf("await sendEmail(");
  assert.ok(gate !== -1, "the automation send path must consult the gate");
  assert.ok(gate < send, `the gate must precede the send (gate ${gate}, send ${send})`);
});
