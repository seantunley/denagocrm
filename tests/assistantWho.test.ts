import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { OR_AUTOMATIC, WHO_LEGEND, messageAuthor, whoLogged } from "../src/lib/assistantWho";

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
});

test("WHEN THE STAND-IN CANNOT BE ESTABLISHED, no name is certain — 'could not check' is not 'a person wrote it'", () => {
  // The lookup failed, or found nobody. An automated entry filed under the owner must still not be credited to the owner…
  for (const unknown of [null, undefined, ""]) {
    assert.equal(whoLogged(SEAN, unknown), `Sean Tunley ${OR_AUTOMATIC}`, String(unknown));
    // …and with nothing to compare against, a colleague's name is not certain either. The name is kept; the doubt is added.
    assert.equal(whoLogged(DONOVAN, unknown), `Donovan Petersen ${OR_AUTOMATIC}`, String(unknown));
  }
  // The same through a message: an outbound automatic reply, with the stand-in unknown.
  assert.deepEqual(messageAuthor({ direction: "outbound", type: "whatsapp", user: SEAN }, null), { from: "us", loggedBy: `Sean Tunley ${OR_AUTOMATIC}` });
  // In the brief, a failed lookup becomes exactly that null — it is never swallowed into "certain".
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /const standInId = \(await resolveTenantActor\(\)\.catch\(\(\) => null\)\)\?\.id \?\? null;/);
  const who = code("src/lib/assistantWho.ts");
  assert.match(who, /return standInId && person\.id !== standInId \? name : `\$\{name\} \$\{OR_AUTOMATIC\}`;/, "certain ONLY when the stand-in is known and this is somebody else");
});

test("an INCOMING CALL a member of staff logged keeps that member of staff; a customer's own WhatsApp has no staff author", () => {
  // Donovan logs an inbound phone call (Log a call / email / note): the customer rang, Donovan recorded it.
  assert.deepEqual(messageAuthor({ direction: "inbound", type: "call", user: DONOVAN }, STAND_IN), { from: "customer", loggedBy: "Donovan Petersen" });
  assert.deepEqual(messageAuthor({ direction: "inbound", type: "meeting", user: DONOVAN }, STAND_IN), { from: "customer", loggedBy: "Donovan Petersen" });
  assert.deepEqual(messageAuthor({ direction: "inbound", type: "note", user: DONOVAN }, STAND_IN), { from: "customer", loggedBy: "Donovan Petersen" });
  // The same call logged under the stand-in account: still from the customer, the logger given with the doubt.
  assert.deepEqual(messageAuthor({ direction: "inbound", type: "call", user: SEAN }, STAND_IN), { from: "customer", loggedBy: `Sean Tunley ${OR_AUTOMATIC}` });

  // An inbound WhatsApp arrives by itself and is filed under the stand-in: nobody on staff logged it.
  assert.deepEqual(messageAuthor({ direction: "inbound", type: "whatsapp", user: SEAN }, STAND_IN), { from: "customer", loggedBy: null });
  for (const channel of ["email", "sms", "messenger", "instagram", "telegram"]) {
    assert.deepEqual(messageAuthor({ direction: "inbound", type: channel, user: SEAN }, STAND_IN), { from: "customer", loggedBy: null }, channel);
  }
  // …but an inbound email a colleague typed in by hand is under THEIR account, and names them.
  assert.deepEqual(messageAuthor({ direction: "inbound", type: "email", user: DONOVAN }, STAND_IN), { from: "customer", loggedBy: "Donovan Petersen" });
  // With the stand-in unknown, an inbound channel message claims nothing about who logged it.
  assert.deepEqual(messageAuthor({ direction: "inbound", type: "whatsapp", user: DONOVAN }, null), { from: "customer", loggedBy: null });

  // Outbound, and entries with no direction (a plain note): ours, by whoever logged it.
  assert.deepEqual(messageAuthor({ direction: "outbound", type: "email", user: DONOVAN }, STAND_IN), { from: "us", loggedBy: "Donovan Petersen" });
  assert.deepEqual(messageAuthor({ direction: null, type: "note", user: DONOVAN }, STAND_IN), { from: "us", loggedBy: "Donovan Petersen" });
  assert.deepEqual(messageAuthor({ direction: null, type: "note", user: null }, STAND_IN), { from: "us", loggedBy: null });
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

test("the brief asks ONE rule who each message is from and who logged it — never direction alone", () => {
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /const \{ from, loggedBy \} = messageAuthor\(c, standInId\);/);
  // The first version: "inbound means the customer wrote it and nobody logged it". It lost the staff member who logged an incoming call.
  assert.doesNotMatch(lib, /c\.direction === "inbound" \? null : whoLogged/);
  assert.match(WHO_LEGEND, /"from: customer" with a loggedBy means the customer rang or wrote and that member of staff recorded it/);
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
