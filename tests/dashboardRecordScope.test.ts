import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
/** Source with comments removed — a rule satisfied by a comment is not satisfied. */
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const DASHBOARD = "src/lib/dashboard/data.ts";
const LEADS_BOARD = "src/app/(app)/leads/page.tsx";

/**
 * Two pages read customer data for whoever asked.
 *
 * The dashboard called `requireUser()` and then computed showSales / showService
 * — but those only chose which TAB RENDERED. Every tile's query sat in one
 * unconditional Promise.all, so a workshop technician with no sales permission
 * still made the server count every open lead, sum the whole pipeline, list the
 * quotes waiting on signature and load the customer names attached to them. In a
 * server component that is not a near miss: what a query returns is serialised
 * into the RSC payload whether or not a component renders it, so the rows were
 * on the wire. Not rendering is not a boundary.
 *
 * The leads board never checked at all. `getCurrentUser()`, then the full open
 * pipeline — every lead, its value, its assignee, its customer — for any signed-in
 * user, including one whose leads permissions had been revoked.
 *
 * These are source guards. Running a server component under the unit runner means
 * loading its client components, next/link and the whole lucide barrel; the
 * behavioural half of this file tests the scope contract those pages depend on
 * (see "an unrestricted scope and an empty scope are different answers").
 */

type PrismaCall = { model: string; op: string; args: string; index: number };

/**
 * Every `prisma.<model>.<op>( … )` in a file, with its argument text.
 *
 * Bracket counting, not a parser: no string literal in either page contains a
 * bracket, so depth is exact here. `assertModelsFound` below fails loudly if that
 * ever stops being true and the extractor starts silently missing calls.
 */
function prismaCalls(code: string): PrismaCall[] {
  const calls: PrismaCall[] = [];
  const pattern = /prisma\.(\w+)\.(\w+)\(/g;
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
    const open = pattern.lastIndex - 1;
    let depth = 0;
    let end = open;
    for (; end < code.length; end += 1) {
      const char = code[end];
      if (char === "(" || char === "{" || char === "[") depth += 1;
      else if (char === ")" || char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push({ model: match[1], op: match[2], args: code.slice(open + 1, end), index: match.index });
  }
  return calls;
}

function assertModelsFound(calls: PrismaCall[], expected: string[], where: string) {
  const found = new Set(calls.map((call) => call.model));
  for (const model of expected) {
    assert.ok(found.has(model), `${where}: no prisma.${model} call was extracted — the extractor is broken or the query moved`);
  }
}

/**
 * The scope variable each model's queries must name, and the tab whose absence
 * must skip them. `activity` has no tab: the agenda is on both, and the one
 * activity query that omits activityScope is narrower still — the caller's own
 * assignments.
 */



/**
 * THE DASHBOARD SCOPE CONTRACT, against the architecture that now exists.
 *
 * This file originally asserted the shape of a hand-built dashboard page:
 * conditional tabs, a `leadScope` ternary, per-tab permission lookups. That page
 * was replaced by a card registry whose reads live in src/lib/dashboard/data.ts,
 * so those five assertions described code that no longer exists. Retargeting
 * them at the new file made them fail for the right reason — the structure they
 * describe is gone — and deleting them outright would have dropped the invariant
 * with the implementation.
 *
 * The invariant survives the rewrite: a dashboard aggregate must never count
 * records the viewer cannot see. `prisma.lead.count({ where: { status: "open" } })`
 * counts EVERY open lead in the workspace, which is a disclosure even though no
 * row is rendered. In the new layer that is enforced by spreading a scope helper
 * into every query, so that is what is asserted.
 */
const SCOPED_MODELS: Array<{ model: string; where: string }> = [
  { model: "lead", where: "leadWhere" },
  { model: "jobCard", where: "jobCardWhere" },
  { model: "quote", where: "quoteWhere" },
  { model: "vehicle", where: "vehicleWhere" },
];

test("every dashboard read of a scoped record carries its scope", () => {
  const source = shipped(DASHBOARD);
  // Each call's OWN arguments, by bracket matching — not a fixed window from the
  // call site. My first version sliced 600 characters and passed while the scope
  // was deleted, because the window ran on into the next query and found ITS
  // `leadWhere()`. A guard that can be satisfied by the neighbouring statement
  // guards nothing.
  const calls = prismaCalls(source);
  assertModelsFound(calls, SCOPED_MODELS.map((entry) => entry.model), DASHBOARD);

  for (const { model, where } of SCOPED_MODELS) {
    const reads = calls.filter(
      (call) => call.model === model && /^(findMany|findFirst|count|aggregate|groupBy)$/.test(call.op),
    );
    assert.ok(reads.length > 0, `no prisma.${model} reads found — has the data layer moved?`);
    for (const read of reads) {
      assert.match(
        read.args,
        new RegExp(`await ${where}\\(\\)`),
        `prisma.${model}.${read.op} in ${DASHBOARD} does not spread ${where}() — it would aggregate over records the viewer cannot see`,
      );
    }
  }
});

test("the scope helpers are built from the caller's access, not from a role guess", () => {
  const source = shipped("src/lib/dashboard/data.ts");
  // getAccessible*Ids returns null for "everything" and an array for a
  // restricted set; the difference has to survive into the where clause, or an
  // empty set silently becomes unrestricted.
  assert.match(source, /getAccessibleLeadIds/);
  assert.match(source, /getAccessibleQuoteIds/);
  assert.match(source, /getAccessibleVehicleIds/);
  assert.match(source, /getAccessibleJobCardIds/);
  assert.match(source, /dashboardViewer\(\)/);
});

test("the leads board is guarded, not merely decorated", () => {
  const code = shipped(LEADS_BOARD);
  assert.match(
    code,
    /await requireAnyPermission\("leads\.view_all", "leads\.view_owned"\)/,
    "the board must demand the same keys as /leads/list, /leads/closed and the sidebar link",
  );
  assert.doesNotMatch(
    code,
    /getCurrentUser\(/,
    "getCurrentUser answers 'who', never 'may they' — the board rendered the pipeline on that answer alone",
  );
});

test("the leads board shows only the leads and customers the caller may see", () => {
  const code = shipped(LEADS_BOARD);
  const calls = prismaCalls(code);
  assertModelsFound(calls, ["pipelineStage", "contact"], LEADS_BOARD);

  const board = calls.find((call) => call.model === "pipelineStage");
  assert.ok(board, "the board query is gone — was it renamed?");
  assert.match(
    board.args,
    /\.\.\.\(accessibleLeadIds \? \{ id: \{ in: accessibleLeadIds \} \} : \{\}\)/,
    "the board's nested lead query must carry the accessible-lead filter",
  );

  const contacts = calls.find((call) => call.model === "contact");
  assert.ok(contacts, "the customer picker query is gone — was it renamed?");
  assert.match(
    contacts.args,
    /where: accessibleContactIds \? \{ id: \{ in: accessibleContactIds \} \} : \{\}/,
    "the New-lead customer picker handed 500 customer records to anyone who opened the board",
  );

  // Everything downstream — planned activities, timeline pins, quotes, signature
  // requests — is keyed off the ids the board query returned, so scoping the
  // board scopes them. That only holds while they stay keyed off it.
  assert.match(
    code,
    /const leadIds = stages\.flatMap\(\(stage\) => stage\.leads\.map\(\(lead\) => lead\.id\)\);/,
    "the follow-up queries must key off the scoped board, not re-query leads",
  );
});
