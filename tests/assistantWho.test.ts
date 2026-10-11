import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { OR_AUTOMATIC, WHO_LEGEND, whoLogged } from "../src/lib/assistantWho";

/*
 * WHO did it. The assistant was told what a note said and when, but not who
 * logged it — so asked who called a customer it guessed the person asking, and
 * was wrong (Sean, 2026-10-11). These hold the rule that replaced the guess,
 * including the one case where a name on a row does NOT mean that person did it.
 */

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SEAN = { id: "u-owner", name: "Sean Tunley" };
const DONOVAN = { id: "u-donovan", name: "Donovan Petersen" };
const STAND_IN = SEAN.id; // the workspace's oldest member: what automated entries are filed under

test("a colleague's entry is theirs, said plainly", () => {
  assert.equal(whoLogged(DONOVAN, STAND_IN), "Donovan Petersen");
  assert.equal(whoLogged({ id: "u-x", name: "  Anna Jacobs  " }, STAND_IN), "Anna Jacobs");
});

test("an entry under the stand-in account is NOT said to be that person's: it may have been automatic", () => {
  const who = whoLogged(SEAN, STAND_IN);
  assert.equal(who, `Sean Tunley ${OR_AUTOMATIC}`);
  assert.notEqual(who, "Sean Tunley", "the bare name would be the confident wrong answer this exists to stop");
  // No stand-in known (the lookup failed): the name is given as it is rather than withheld.
  assert.equal(whoLogged(SEAN, null), "Sean Tunley");
  assert.equal(whoLogged(SEAN, undefined), "Sean Tunley");
});

test("no author means no author — never an invented one", () => {
  for (const nobody of [null, undefined, { id: "u", name: null }, { id: "u", name: "   " }]) {
    assert.equal(whoLogged(nobody, STAND_IN), null);
  }
});

test("the assistant is told how to read these fields, next to the data", () => {
  assert.match(WHO_LEGEND, /say WHO did it/);
  assert.match(WHO_LEGEND, /never guess a person from the wording of a note/);
  assert.match(WHO_LEGEND, /Never say the person asking did something unless one of these fields names them/);
  assert.ok(WHO_LEGEND.includes(`"${OR_AUTOMATIC}" is NOT certain`), "the uncertain form is named exactly as it is written");
  assert.match(WHO_LEGEND, /the CRM does not record who did it — say so/);
});

test("a lead's brief carries who logged each message, who owns and who scheduled each activity, and who created the lead", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const brief = lib.slice(lib.indexOf("export async function leadBrief"), lib.indexOf("async function quotesForLead"));
  // Read from the records…
  assert.match(brief, /select: \{ occurredAt: true, direction: true, type: true, subject: true, body: true, user: \{ select: \{ id: true, name: true \} \} \},/);
  assert.match(brief, /assignedTo: \{ select: \{ id: true, name: true \} \},\s*createdBy: \{ select: \{ id: true, name: true \} \},/);
  assert.match(brief, /createdBy: \{ select: \{ id: true, name: true \} \},\s*\},\s*\}\);/, "the lead's own creator");
  // …measured against the stand-in account, whose failure costs the doubt, not the answer…
  assert.match(brief, /const standInId = \(await resolveTenantActor\(\)\.catch\(\(\) => null\)\)\?\.id \?\? null;/);
  // …and handed over with the rule beside them.
  assert.match(brief, /who: WHO_LEGEND,/);
  assert.match(brief, /\.\.\.\(loggedBy \? \{ loggedBy \} : \{\}\),/);
  assert.match(brief, /assignedTo: a\.assignedTo\?\.name \?\? null,\s*\.\.\.\(scheduledBy \? \{ scheduledBy \} : \{\}\),/);
  assert.match(brief, /\.\.\.\(whoLogged\(lead\.createdBy, standInId\) \? \{ createdBy: whoLogged\(lead\.createdBy, standInId\) \} : \{\}\),/);
  assert.match(brief, /salesperson: staffName\.get\(t\.salespersonId\)/);
});

test("a customer's own message is never given a staff author", () => {
  const lib = code("src/lib/crmAssistant.ts");
  // The row's user is only the stand-in there: an inbound message has no loggedBy at all.
  assert.match(lib, /const loggedBy = c\.direction === "inbound" \? null : whoLogged\(c\.user, standInId\);/);
  assert.match(lib, /from: c\.direction === "inbound" \? "customer" : "us",/);
});

test("still nothing that identifies a customer beyond what the brief already gave: no ids, emails or numbers of staff either", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const brief = lib.slice(lib.indexOf("export async function leadBrief"), lib.indexOf("async function quotesForLead"));
  // Staff are selected as id + name only — the id is used to compare, and only the name is returned.
  for (const select of brief.match(/(?:user|assignedTo|createdBy): \{ select: \{[^}]*\} \}/g) ?? []) {
    assert.doesNotMatch(select, /email|phone|passwordHash|role/, select);
  }
  assert.doesNotMatch(brief, /loggedBy: c\.user|scheduledBy: a\.createdBy|createdBy: lead\.createdBy[,\s}]/, "an object with an id must not be handed to the model");
});
