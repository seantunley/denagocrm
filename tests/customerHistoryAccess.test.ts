import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { customerHistoryWhere, viewableDealIds } from "../src/lib/customerHistory";

/*
 * A customer's page showed the audit trail of EVERY deal of that customer, and
 * every entry naming the customer whatever deal it was also about. Someone
 * allowed to open the customer but not a colleague's deal read that deal's
 * history there (review of #874, 2026-10-12).
 */

type Row = { id: string; contactId: string | null; leadId: string | null };
const ROWS: Row[] = [
  { id: "customer-edited", contactId: "c1", leadId: null },
  { id: "my-deal-stage-moved", contactId: null, leadId: "mine" },
  { id: "my-deal-quote-created", contactId: "c1", leadId: "mine" },
  { id: "their-deal-stage-moved", contactId: null, leadId: "theirs" },
  { id: "their-deal-quote-created", contactId: "c1", leadId: "theirs" }, // names the customer AND a deal I cannot open
  { id: "another-customer", contactId: "c2", leadId: null },
];
function shown(where: { OR: Record<string, unknown>[] }): string[] {
  return ROWS.filter((row) =>
    where.OR.some((alt) =>
      Object.entries(alt).every(([key, want]) => {
        const have = row[key as keyof Row];
        return want && typeof want === "object" ? (want as { in: unknown[] }).in.includes(have) : have === want;
      }),
    ),
  ).map((row) => row.id);
}

test("the deals a viewer may open: null is everyone's, a list is exactly those, an EMPTY list is none", () => {
  assert.deepEqual(viewableDealIds(["mine", "theirs"], null), ["mine", "theirs"]);
  assert.deepEqual(viewableDealIds(["mine", "theirs"], ["mine", "elsewhere"]), ["mine"]);
  assert.deepEqual(viewableDealIds(["mine", "theirs"], []), [], "an empty list must never read as 'no filter'");
  // A deal that is not this customer's never gets in by being accessible.
  assert.deepEqual(viewableDealIds(["mine"], ["mine", "somebody-elses-deal"]), ["mine"]);
});

test("A RESTRICTED DEAL'S HISTORY IS NOT SHOWN — not even the entries that also name the customer", () => {
  const mine = customerHistoryWhere("c1", viewableDealIds(["mine", "theirs"], ["mine"]));
  assert.deepEqual(shown(mine), ["customer-edited", "my-deal-stage-moved", "my-deal-quote-created"]);
  // Someone who may open none of the customer's deals sees the customer's own history only.
  assert.deepEqual(shown(customerHistoryWhere("c1", viewableDealIds(["mine", "theirs"], []))), ["customer-edited"]);
  // Unrestricted (an owner, or view-all): everything of this customer's, as before.
  assert.deepEqual(shown(customerHistoryWhere("c1", viewableDealIds(["mine", "theirs"], null))), [
    "customer-edited", "my-deal-stage-moved", "my-deal-quote-created", "their-deal-stage-moved", "their-deal-quote-created",
  ]);
  // "Names this customer" is never enough on its own.
  for (const ids of [[], ["mine"]]) {
    assert.ok(!customerHistoryWhere("c1", ids).OR.some((alt) => "contactId" in alt && !("leadId" in alt)));
  }
});

test("the customer's page reads its history by that rule, for the person looking", () => {
  const page = readFileSync("src/app/(app)/contacts/[id]/page.tsx", "utf8");
  assert.match(page, /prisma\.auditLog\.findMany\(\{\s*where: customerHistoryWhere\(\s*contact\.id,\s*viewableDealIds\(/);
  assert.match(page, /await getAccessibleLeadIds\(user\),/);
  // The old clause — every entry naming the customer, every deal of theirs — is gone.
  assert.doesNotMatch(page, /OR: \[\s*\{ contactId: contact\.id \},\s*\{ leadId: \{ in:/);
});
