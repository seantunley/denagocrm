import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
