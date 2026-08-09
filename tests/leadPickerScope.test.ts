import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/** Source with comments stripped, so a rule cannot be satisfied by prose about it. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * WHO MAY APPEAR IN A LEAD PICKER.
 *
 * Reaching the quotes page needs `quotes.view_all` or `quotes.view_owned`.
 * Neither says anything about which LEADS the viewer may see — that is
 * `leads.view_all` versus `leads.view_owned`, with its own owner/creator/team
 * rules — and the open-lead query had no scope at all. The picker offered every
 * open lead in the tenant to anyone who could open a quote.
 *
 * It mattered less while the option showed `title`, the vehicle. Changing the
 * label to lead with the CUSTOMER NAME turned a scoping gap into a disclosure of
 * customer names for leads the viewer cannot open — a change to the label made a
 * pre-existing query bug worse, which is why this is tested at the query.
 *
 * Source contracts: both pages are server components that import Prisma and
 * `server-only`, so they cannot be executed in a test process.
 */

const QUOTES = "src/app/(app)/quotes/page.tsx";
const JOURNEYS = "src/app/(app)/journeys/page.tsx";
const SAVE = "src/app/actions/quotes.ts";

test("the quotes lead picker is scoped by LEAD rbac", () => {
  const page = code(QUOTES);
  assert.match(page, /getAccessibleLeadIds\(user\)/, "quote permissions do not grant lead visibility");

  // The filter must be on the QUERY. Filtering the results afterwards would
  // still have fetched the rows, and labelling runs off the query result.
  const query = page.slice(page.indexOf("prisma.lead.findMany"));
  const where = query.slice(0, query.indexOf("select:"));
  assert.match(where, /accessibleLeadIds \? \{ id: \{ in: accessibleLeadIds \} \} : \{\}/);
});

test("the journeys test-lead picker is scoped the same way", () => {
  // The same hole, on a page nobody would think to check after a change to a
  // shared label helper.
  const page = code(JOURNEYS);
  assert.match(page, /getAccessibleLeadIds\(user\)/);
  const query = page.slice(page.indexOf("prisma.lead.findMany"));
  const where = query.slice(0, query.indexOf("select:"));
  assert.match(where, /accessibleLeadIds \? \{ id: \{ in: accessibleLeadIds \} \} : \{\}/);
});

test("scoping happens before labels are produced", () => {
  // Labelling a list the viewer should never have received is not a fix.
  const page = code(QUOTES);
  const scopedAt = page.indexOf("getAccessibleLeadIds");
  const labelledAt = page.indexOf("leadOptionLabels");
  assert.ok(scopedAt !== -1 && labelledAt !== -1);
  assert.ok(scopedAt < labelledAt, "the query must be scoped before its results are labelled");
});

test("the quote save path checks lead access, not just ownership of the customer", () => {
  // A server action is reachable by direct POST, so scoping the picker query
  // alone leaves the write open: a leadId that never appeared in any picker
  // could still be attached.
  // Anchored on CODE, not on a comment: this reads comment-stripped source, so
  // slicing from a comment finds nothing and silently inspects the wrong region.
  const action = code(SAVE);
  const start = action.indexOf("prisma.lead.findUnique");
  const end = action.indexOf("linkedLeadId = lead.id;", start);
  assert.ok(start !== -1 && end !== -1 && start < end, "the optional-lead-link block must exist");
  const linkBlock = action.slice(start, end);
  assert.match(linkBlock, /canAccessLead\(user, lead\.id\)/, "the write path needs its own check");
});

test("a lead the caller cannot see is refused as if it did not exist", () => {
  // Telling somebody a lead exists but is not theirs confirms the record.
  const action = read(SAVE);
  const idx = action.indexOf("canAccessLead(user, lead.id)");
  assert.ok(idx !== -1);
  const refusal = action.slice(idx, idx + 260);
  assert.match(refusal, /That lead is no longer available\./);
  assert.doesNotMatch(refusal, /permission|not yours|access denied/i, "do not confirm the record exists");
});
