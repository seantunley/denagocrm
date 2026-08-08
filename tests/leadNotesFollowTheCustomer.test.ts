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
 * …AND IT MUST APPEAR ONCE.
 *
 * Reported in review. Carrying the lead's note onto the contact and surfacing
 * every linked lead's notes on the contact timeline are both right, and together
 * they printed the same sentence twice for every converted lead:
 *
 *   Original contact note              "Wants the Rover XL, needs finance"
 *   Original lead note — Rover XL      "Wants the Rover XL, needs finance"
 *
 * Both of the review's cases are covered below, because fixing the first by
 * dropping lead notes wholesale would break the second — and the second is the
 * reason the feature exists.
 */

const leadNote = (text: string, over: Partial<{ leadId: string; title: string }> = {}) => ({
  leadId: over.leadId ?? "lead_1",
  title: over.title ?? "Rover XL enquiry",
  text,
  when: new Date("2026-08-01T09:00:00Z"),
  who: "Rep",
});

test("a lead converted to a NEW contact shows its note once", () => {
  const note = "Wants the Rover XL, needs finance";
  // The contact note is a verbatim copy made by convertLeadToContact.
  const shown = distinctLeadNotes([leadNote(note)], { text: note });
  assert.equal(shown.length, 0, "the lead copy must be dropped; the contact note is the one shown");
});

test("an EXISTING contact keeps its own note AND the linked lead's different note", () => {
  // The case the historical lead-note support exists for. Two genuinely different
  // notes, both belonging on the timeline.
  const shown = distinctLeadNotes(
    [leadNote("Asked about the 48V pack")],
    { text: "Long-standing account, pays on 30 days" },
  );
  assert.equal(shown.length, 1, "a different lead note must survive");
  assert.equal(shown[0].text, "Asked about the 48V pack");
});

test("formatting differences do not make one note into two", () => {
  // The value travels through a textarea, so a trailing newline or a wrapped line
  // is not a different note.
  const shown = distinctLeadNotes(
    [leadNote("  Wants the Rover XL,\n  needs finance  ")],
    { text: "Wants the Rover XL, needs finance" },
  );
  assert.equal(shown.length, 0, "whitespace must be normalised before comparing");
});

test("on a LEAD's own timeline every note is kept", () => {
  // No contact note to collide with. Filtering here would hide the note entirely,
  // which is the bug this PR set out to fix.
  const notes = [leadNote("A"), leadNote("B", { leadId: "lead_2" })];
  assert.equal(distinctLeadNotes(notes, null).length, 2);
  assert.equal(distinctLeadNotes(notes, undefined).length, 2);
});

test("one duplicate among several leads drops only that one", () => {
  const note = "Wants the Rover XL, needs finance";
  const shown = distinctLeadNotes(
    [leadNote(note), leadNote("Different enquiry", { leadId: "lead_2" })],
    { text: note },
  );
  assert.equal(shown.length, 1);
  assert.equal(shown[0].leadId, "lead_2");
});

test("the timeline renders the filtered list in BOTH places it uses it", () => {
  // Pin targets and rendered items are built from separate maps. Filtering one and
  // not the other leaves a pin row for an item that is no longer drawn — the exact
  // defect the leadNotes support was added to fix, reintroduced from the other side.
  const code = src("src/components/LeadTimeline.tsx");
  assert.match(code, /const shownLeadNotes = distinctLeadNotes\(leadNotes, creationNote\)/);
  assert.equal(
    (code.match(/\.\.\.shownLeadNotes\.map\(/g) ?? []).length,
    2,
    "both the pin targets and the items must use the filtered list",
  );
  assert.doesNotMatch(code, /\.\.\.leadNotes\.map\(/, "the unfiltered list must not be rendered");
});
