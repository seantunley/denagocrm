import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { PHONE_TAIL_SQL } from "../src/lib/phoneMatch";

/**
 * PR #703 review blocker: Mark won's "find the existing customer" compared the
 * EXACT stored strings, so "Jane@Example.com" vs "jane@example.com" and
 * "083 123 4567" vs "+27831234567" still created a duplicate contact.
 *
 * lib/contactMatch.ts now holds the canonical rule — trimmed case-insensitive
 * email, the phoneMatch.ts digit tail against phone AND whatsapp — and both the
 * lookup and the drift report are built from it. Several matches is ambiguous
 * and refused, as the inbound matcher refuses to act on an ambiguous identity.
 */

/* ── load contactMatch.ts against a fake bypass client that records the query ── */

let rowsToReturn: Array<{ id: string }> = [];
const queries: Prisma.Sql[] = [];

type Loader = (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request, parent, isMain) {
  if (request === "server-only") return {};
  if ((parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/contactMatch.ts") && request === "./db") {
    return {
      basePrisma: {
        async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
          queries.push(Prisma.sql(strings, ...values));
          return rowsToReturn;
        },
      },
    };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const match = createRequire(import.meta.url)("../src/lib/contactMatch.ts") as typeof import("../src/lib/contactMatch");

async function lookup(email: string | null, phone: string | null, rows: string[] = []) {
  rowsToReturn = rows.map((id) => ({ id }));
  queries.length = 0;
  const result = await match.findExistingContact({ tenantId: "tenant_a", email, phone });
  return { result, query: queries[0] };
}

const shipped = (rel: string) =>
  readFileSync(rel, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");

/* ── the canonical keys ─────────────────────────────────────────────── */

test("mixed-case, padded email reduces to the same key", () => {
  assert.equal(match.emailKey("  Jane@Example.COM "), "jane@example.com");
  assert.equal(match.emailKey("jane@example.com"), "jane@example.com");
  assert.equal(match.emailKey("   "), null, "blank matches nobody");
});

test("the lookup binds the CANONICAL email, compares it case-insensitively, trimmed", async () => {
  const { query } = await lookup("  Jane@Example.COM ", null);
  assert.ok(query, "a lookup was made");
  assert.ok(query.values.includes("jane@example.com"), "the canonical key is what is compared");
  assert.ok(!query.values.includes("  Jane@Example.COM "), "never the raw string");
  assert.match(query.sql, /lower\(btrim\(coalesce\("email", ''\)\)\)/, "and the column side is normalised the same way");
});

test("differently formatted phones (spaces, +27 vs 0) bind the same tail, matched on phone AND whatsapp", async () => {
  const tails = new Set<unknown>();
  for (const written of ["083 123 4567", "0831234567", "+27 83 123 4567", "27831234567", "(083) 123-4567"]) {
    const { query } = await lookup(null, written);
    const bound = query.values.filter((value) => typeof value === "string" && /^\d+$/.test(value));
    assert.equal(bound.length > 0, true, `${written} must be looked up by its tail`);
    bound.forEach((value) => tails.add(value));
    assert.ok(query.sql.includes(PHONE_TAIL_SQL('"phone"')), "the indexed phoneMatch expression on phone");
    assert.ok(query.sql.includes(PHONE_TAIL_SQL('"whatsapp"')), "…and on whatsapp, as the inbound matcher does");
  }
  assert.deepEqual([...tails], ["831234567"], "every spelling is one number");
});

test("the lookup names the tenant and skips deleted contacts", async () => {
  const { query } = await lookup("a@b.co", null);
  assert.match(query.sql, /"tenantId" IS NOT DISTINCT FROM \?/);
  assert.equal(query.values[0], "tenant_a");
  assert.match(query.sql, /"deletedAt" IS NULL/);
});

test("too little to identify anyone asks nothing and matches nobody", async () => {
  const { result, query } = await lookup("  ", "x204");
  assert.deepEqual(result, { kind: "none" });
  assert.equal(query, undefined);
});

test("one match links; several matches are AMBIGUOUS — nothing picked, nothing created", async () => {
  assert.deepEqual((await lookup("a@b.co", null, [])).result, { kind: "none" });
  assert.deepEqual((await lookup("a@b.co", null, ["c1"])).result, { kind: "one", contactId: "c1" });
  assert.deepEqual((await lookup("a@b.co", "0831234567", ["c1", "c2"])).result, { kind: "ambiguous", count: 2 });
  assert.match(match.ambiguousContactMessage(2), /none was picked and no new customer was created/);
});

/* ── the wiring: every lead→contact path uses it, and so does the report ── */

test("linking a lead's customer uses the canonical lookup and refuses an ambiguous one", () => {
  const leads = shipped("src/app/actions/leads.ts");
  const helper = leads.slice(leads.indexOf("async function linkOrCreateLeadContact"));
  const body = helper.slice(0, helper.indexOf("\nexport "));
  assert.match(body, /findExistingContact\(\{ tenantId: lead\.tenantId, email: lead\.email, phone: lead\.phone \}\)/);
  assert.match(body, /if \(match\.kind === "ambiguous"\) refuse\(/);
  // The ambiguity check must come BEFORE anything is created.
  assert.ok(body.indexOf('match.kind === "ambiguous"') < body.indexOf("contact.create("));
});

test("no exact-string contact matching is left anywhere a lead becomes a customer", () => {
  const leads = shipped("src/app/actions/leads.ts");
  assert.doesNotMatch(leads, /\{ email: (lead|data|before)\.email \}/, "exact email equality creates duplicates");
  assert.doesNotMatch(leads, /\{ phone: (lead|data|before)\.phone \}/, "exact phone equality creates duplicates");
  const create = leads.slice(leads.indexOf("export async function createLead("));
  assert.match(create.slice(0, create.indexOf("\nexport ")), /findExistingContact\(/, "creating a lead matches the same way");
});

test("the drift report and the prevention share one identity rule", () => {
  const report = shipped("scripts/report-mark-won-gaps.ts");
  assert.match(report, /contactIdentitySql\(/, "the report must use the helper, not its own comparison");
  assert.doesNotMatch(report, /lower\(trim|regexp_replace/, "no second copy of the rule");
});
