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

const DASHBOARD = "src/app/(app)/page.tsx";
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
const SCOPED: Record<string, { scope: string; gate: string | null }> = {
  lead: { scope: "leadScope", gate: "showSales" },
  quote: { scope: "quoteScope", gate: "showSales" },
  signatureRequest: { scope: "quoteIds", gate: "showSales" },
  jobCard: { scope: "jobCardScope", gate: "showService" },
  vehicle: { scope: "vehicleScope", gate: "showService" },
  activity: { scope: "activityScope", gate: null },
};

test("every dashboard read of a customer record names its scope", () => {
  const code = shipped(DASHBOARD);
  const calls = prismaCalls(code);
  assertModelsFound(calls, ["lead", "quote", "jobCard", "vehicle", "activity", "signatureRequest"], DASHBOARD);

  for (const call of calls) {
    const rule = SCOPED[call.model];
    if (!rule) continue;
    const scoped =
      call.args.includes(`...${rule.scope}`) ||
      call.args.includes(`${rule.scope} ?`) ||
      // The overdue-prompt query: the caller's own assignments, which is a
      // tighter predicate than the activity scope, not a missing one.
      call.args.includes("assignedToId: user.id");
    assert.ok(
      scoped,
      `prisma.${call.model}.${call.op} on the dashboard runs without ${rule.scope} — ` +
        `a view_owned user would get every row:\n${call.args.trim().slice(0, 200)}`,
    );
  }
});

test("a dashboard tab the user cannot see issues no queries for it", () => {
  // The original bug, stated as an invariant. Filtering the RESULT is not enough
  // and neither is hiding the component: the read already happened and its rows
  // are already in the payload.
  const code = shipped(DASHBOARD);
  for (const call of prismaCalls(code)) {
    const rule = SCOPED[call.model];
    if (!rule?.gate) continue;
    if (call.args.includes("assignedToId: user.id")) continue;

    // The condition of the ternary this call is the consequent of — read
    // exactly, not by looking for the gate name somewhere nearby, because the
    // neighbouring array element's gate is always "somewhere nearby".
    const before = code.slice(0, call.index).replace(/\s*(await\s+)?$/, "");
    assert.ok(
      before.endsWith("?"),
      `prisma.${call.model}.${call.op} is not the consequent of a conditional — it runs unconditionally`,
    );
    const stem = before.slice(0, -1);
    const boundary = Math.max(
      stem.lastIndexOf(","),
      stem.lastIndexOf("("),
      stem.lastIndexOf("["),
      stem.lastIndexOf("="),
      stem.lastIndexOf(";"),
    );
    const condition = stem.slice(boundary + 1).trim();
    assert.ok(
      condition.split(/\s*&&\s*/).includes(rule.gate),
      `prisma.${call.model}.${call.op} runs on \`${condition}\`, not on ${rule.gate} — ` +
        "it reads rows for a tab the user cannot see",
    );
  }
});

test("an unrestricted scope and an empty scope stay different in the where clause", () => {
  // getAccessible*Ids answers with three distinct values and the difference
  // between two of them IS the security boundary:
  //   null → owner / *.view_all  → no filter
  //   []   → no accessible rows  → `in: []`, an impossible match
  //   [id] → those rows
  // `ids?.length ? … : {}` and `{ in: ids ?? [] }` both collapse the first two,
  // and the collapse silently opens EVERY row to a user with no access at all.
  for (const file of [DASHBOARD, LEADS_BOARD]) {
    const code = shipped(file);
    assert.doesNotMatch(
      code,
      /accessible\w*Ids\s*\?\./i,
      `${file}: optional chaining on an accessible-ids list turns "no access" into "no filter"`,
    );
    assert.doesNotMatch(
      code,
      /(Ids|Scope)\s*\?\?\s*(\[\]|\{\})/,
      `${file}: defaulting an accessible-ids list turns "no access" into "no filter"`,
    );
    assert.doesNotMatch(
      code,
      /\w*Ids\.length\s*\?\s*\{\s*id:/,
      `${file}: a length test turns "no access" into "no filter"`,
    );
  }

  // And the shape that is correct, spelled out where it is defined.
  const dash = shipped(DASHBOARD);
  for (const scope of ["leadScope", "quoteScope", "jobCardScope", "vehicleScope", "activityScope"]) {
    const declaration = new RegExp(
      `const ${scope} = (\\w+) \\? \\{ id: \\{ in: \\1 \\} \\} : \\{\\};`,
    );
    assert.match(dash, declaration, `${scope} must be built as \`ids ? { id: { in: ids } } : {}\``);
  }
});

test("hiding a dashboard tab also skips the permission lookups it needs", () => {
  // getAccessibleLeadIds walks the lead table; getAccessibleQuoteIds walks quotes
  // AND leads AND contacts to build its union. Resolving all five scopes for a
  // user who can see one tab is the same waste the tiles themselves had.
  const code = shipped(DASHBOARD);
  for (const [helper, gate] of [
    ["getAccessibleLeadIds", "showSales"],
    ["getAccessibleQuoteIds", "showSales"],
    ["getAccessibleJobCardIds", "showService"],
    ["getAccessibleVehicleIds", "showService"],
  ] as const) {
    assert.match(
      code,
      new RegExp(`${gate} \\? ${helper}\\(user\\) : NO_ACCESS`),
      `${helper} must only be resolved when ${gate}`,
    );
  }
  assert.match(
    code,
    /const NO_ACCESS: Promise<string\[\] \| null> = Promise\.resolve\(\[\]\)/,
    "the skipped branch must resolve to [] — no accessible rows — never null",
  );
});

test("the dashboard does not ship whole rows to print one field", () => {
  // `include: { assignedTo: true }` on the agenda serialised the whole User row —
  // password hash included — into the RSC payload, twenty times per day column,
  // to render a first name. Same for `include: { contact: true }` on the fleet
  // query: every customer's phone, email, address and notes, to print a name.
  const code = shipped(DASHBOARD);
  assert.doesNotMatch(
    code,
    /include:\s*\{/,
    "dashboard queries must select the fields they render, not include whole relations",
  );
  assert.match(code, /const AGENDA_SELECT = \{/, "the agenda select must be one shared definition");
  assert.doesNotMatch(
    shipped("src/app/(app)/page.tsx"),
    /assignedTo:\s*true/,
    "assignedTo: true is the User row, password hash and all",
  );
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
