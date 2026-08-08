import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { distinctLeadNotes } from "../src/lib/timelineNotes";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Notes typed on a lead used to vanish the moment the lead became a customer.
 *
 * Three paths create a Contact from a Lead — createLead (when no contact is
 * matched), markWon, and convertLeadToContact — and none of them copied `notes`.
 * The field was read off the form and written to the Lead, so a salesperson's
 * "wants the 48V model, financing through Absa" survived exactly until the deal
 * was won, and then existed nowhere.
 *
 * This was fixed in PR #241 on 2026-07-28 and the fix never reached main: the PR
 * was merged into `fix/update-lead-tenantid-fk` rather than main, so GitHub
 * showed it MERGED while the bug stayed live for eleven days.
 *
 * The test is structural rather than three string comparisons, because the
 * regression that matters is a FOURTH conversion path being added later and
 * forgetting the field — which is exactly how the first three came to be missing
 * it.
 */

/** Every `contact.create({ data: {…} })` body in a file, brace-matched. */
function contactCreateBodies(code: string): string[] {
  const bodies: string[] = [];
  const marker = /(?:prisma|tx)\.contact\.create\(\s*\{/g;
  for (let match = marker.exec(code); match; match = marker.exec(code)) {
    // Start just inside the object literal opened by the match, then walk until
    // its matching close. Counting braces is what makes this a real extraction —
    // slicing a fixed number of characters would silently read the NEXT call's
    // body and pass no matter what this one contained.
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < code.length && depth > 0; i += 1) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}") depth -= 1;
    }
    bodies.push(code.slice(match.index, i));
  }
  return bodies;
}

test("the extractor finds each create separately, and does not run them together", () => {
  // Guard on the tool before trusting what it reports. A broken extractor that
  // returned the whole file would make every assertion below vacuous.
  const sample = `
    const a = await prisma.contact.create({ data: { firstName: "A", notes: x } });
    const b = await prisma.contact.create({ data: { firstName: "B" } });
  `;
  const bodies = contactCreateBodies(sample);
  assert.equal(bodies.length, 2);
  assert.match(bodies[0], /notes/);
  assert.doesNotMatch(bodies[1], /notes/, "the second must not pick up the first's fields");
});

test("every path that turns a lead into a contact carries the lead's notes", () => {
  const code = src("src/app/actions/leads.ts");
  const bodies = contactCreateBodies(code);
  assert.ok(bodies.length >= 3, `expected at least 3 contact.create sites, found ${bodies.length}`);
  for (const [index, body] of bodies.entries()) {
    assert.match(
      body,
      /\bnotes:/,
      `contact.create #${index + 1} in leads.ts drops the lead's notes:\n${body.slice(0, 300)}`,
    );
  }
});

test("the contact page can render a lead note, so the pin has something to pin", () => {
  // LeadTimeline already knew the `lead_note` pin KIND. Without the notes being
  // passed in, the pin row existed with no item to render on — a pin you could
  // create and then never see.
  const timeline = src("src/components/LeadTimeline.tsx");
  assert.match(timeline, /leadNotes\??:/, "LeadTimeline must accept the notes");
  assert.match(timeline, /kind: "lead_note"/, "and target them for pinning");

  const contactPage = src("src/app/(app)/contacts/[id]/page.tsx");
  assert.match(contactPage, /leadNotes=\{/, "the contact page must supply them");
  // The author's name comes from the lead's creator, which has to be fetched.
  assert.match(contactPage, /createdBy/, "and include createdBy to attribute the note");
});

/**
 * …AND IT MUST APPEAR ONCE — WITHOUT DELETING A REAL ONE.
 *
 * Carrying the lead's note onto the contact and surfacing every linked lead's
 * notes on the contact timeline are both right, and together they printed the
 * same sentence twice for every converted lead.
 *
 * The first fix compared the TEXT. Review was right that this is not provenance:
 * an existing customer whose own note happens to read the same as a later,
 * unrelated lead's note has TWO genuine CRM events, and comparing sentences
 * silently deletes one from the history.
 *
 * The copy is recorded when it is made — Contact.notesFromLeadId — and the filter
 * drops that lead and no other. The case below that used to fail is the third one.
 */

const leadNote = (leadId: string, text: string) => ({
  leadId,
  title: "Rover XL enquiry",
  text,
  when: new Date("2026-08-01T09:00:00Z"),
  who: "Rep",
});

test("a lead converted to a NEW contact shows its note once", () => {
  const notes = [leadNote("lead_1", "Wants the Rover XL, needs finance")];
  assert.equal(distinctLeadNotes(notes, "lead_1").length, 0, "the copied lead note is dropped");
});

test("an EXISTING contact keeps its own note AND a linked lead's different note", () => {
  // No conversion happened, so nothing was copied and nothing is dropped.
  const notes = [leadNote("lead_9", "Asked about the 48V pack")];
  assert.equal(distinctLeadNotes(notes, null).length, 1);
});

test("IDENTICAL TEXT on an unrelated lead is NOT deleted", () => {
  // The case that broke the text comparison, and the reason this is provenance.
  // Two separate CRM events that happen to be worded the same: the contact's own
  // note (copied from lead_1) and a later, independent lead saying the same thing.
  const sameWords = "Interested in Rover XL";
  const notes = [leadNote("lead_1", sameWords), leadNote("lead_2", sameWords)];
  const shown = distinctLeadNotes(notes, "lead_1");
  assert.equal(shown.length, 1, "only the COPIED lead's note may be dropped");
  assert.equal(shown[0].leadId, "lead_2", "the unrelated lead's identical note survives");
});

test("unknown provenance shows both, which is the safe direction", () => {
  // Null for a contact converted before the column existed and not resolvable by
  // the migration's backfill. A visible duplicate can be judged; a hidden note is
  // gone with no trace that it existed.
  const notes = [leadNote("lead_1", "Wants the Rover XL")];
  assert.equal(distinctLeadNotes(notes, null).length, 1);
  assert.equal(distinctLeadNotes(notes, undefined).length, 1);
});

test("one duplicate among several leads drops only that one", () => {
  const notes = [leadNote("lead_1", "A"), leadNote("lead_2", "B"), leadNote("lead_3", "C")];
  const shown = distinctLeadNotes(notes, "lead_2");
  assert.deepEqual(shown.map((n) => n.leadId), ["lead_1", "lead_3"]);
});

test("all three conversion paths record where the note came from", () => {
  // A filter reading a column nothing writes would drop nothing, forever.
  const code = src("src/app/actions/leads.ts");
  assert.equal(
    (code.match(/notesFromLeadId:/g) ?? []).length,
    3,
    "createLead, markWon and convertLeadToContact must each record provenance",
  );
  // And only when a note was actually copied — otherwise every contact would
  // claim a note it does not have.
  assert.match(code, /notes\?\.trim\(\) \? \w+\.id : null/);
});

test("the timeline reads provenance and never compares text", () => {
  const rule = src("src/lib/timelineNotes.ts");
  assert.match(rule, /note\.leadId !== notesFromLeadId/, "identity, not similarity");
  assert.doesNotMatch(rule, /normalise|\.text ===|replace\(\/\s\+\//, "no text comparison may remain");

  const timeline = src("src/components/LeadTimeline.tsx");
  assert.match(timeline, /distinctLeadNotes\(leadNotes, notesFromLeadId\)/);
  assert.equal(
    (timeline.match(/\.\.\.shownLeadNotes\.map\(/g) ?? []).length,
    2,
    "both the pin targets and the rendered items must use the filtered list",
  );
});
