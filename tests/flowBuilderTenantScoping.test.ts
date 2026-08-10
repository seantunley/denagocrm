import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { nullableTenantWhere, ownsNullableTenantRow } from "../src/lib/flowTenantScope";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The chatbot ADMINISTRATION surface — the flow builder, its version/blocks/
 * simulator tools, the analytics workspace and the chatbot settings page.
 *
 * Every route here already calls `requireOwner()`, so this is not an
 * authentication gap. It is that "an owner" says nothing about WHICH workspace,
 * and the db.ts guard only supplies the missing tenant predicate when
 * `tenantEnforcing()` is true — which it is not in production. Until it is, an
 * administration query that does not name the tenant itself runs GLOBALLY: a
 * second workspace's owner could list, open, edit, publish, roll back or delete
 * another workspace's flows.
 *
 * The runtime half of this was fixed already (botOutbox/flowPublishing); this is
 * the same rule for the surface that edits what the runtime executes.
 */

const SECOND_TENANT = "tenant_second_workspace";

/* ─── the rule, executed ──────────────────────────────────────────────────── */

type Row = { id: string; tenantId: string | null };

const FIXTURE: Row[] = [
  // What an existing single-tenant install actually has: rows written before
  // tenancy, still unstamped because the guard only stamps under enforcement.
  { id: "legacy-null", tenantId: null },
  { id: "founding-owned", tenantId: DEFAULT_TENANT_ID },
  { id: "second-owned", tenantId: SECOND_TENANT },
];

/**
 * Interpret the `where` fragment the way Postgres would, so the test executes the
 * shipped filter rather than asserting on its source text. Only the two shapes
 * {@link nullableTenantWhere} can produce are understood — anything else is a
 * change the test must be made to see.
 */
function selectWith(where: ReturnType<typeof nullableTenantWhere>, rows: Row[]): string[] {
  return rows
    .filter((row) => {
      if ("OR" in where) return where.OR.some((arm) => arm.tenantId === row.tenantId);
      return row.tenantId === where.tenantId;
    })
    .map((row) => row.id);
}

test("the founding tenant keeps its legacy un-owned flows; a second workspace never sees them", () => {
  assert.deepEqual(
    selectWith(nullableTenantWhere(DEFAULT_TENANT_ID), FIXTURE),
    ["legacy-null", "founding-owned"],
    "filtering strictly would hide every flow an existing single-tenant install has",
  );
  assert.deepEqual(
    selectWith(nullableTenantWhere(SECOND_TENANT), FIXTURE),
    ["second-owned"],
    "a second workspace must never absorb the founding tenant's un-owned rows",
  );
});

test("neither workspace can reach the other's stamped rows", () => {
  const founding = selectWith(nullableTenantWhere(DEFAULT_TENANT_ID), FIXTURE);
  const second = selectWith(nullableTenantWhere(SECOND_TENANT), FIXTURE);
  assert.ok(!founding.includes("second-owned"));
  assert.ok(!second.includes("founding-owned"));
  assert.deepEqual([...founding, ...second].sort(), FIXTURE.map((row) => row.id).sort());
});

test("the query fragment selects exactly the rows the ownership predicate claims", () => {
  // The fragment is what ships; the predicate is the statement of the rule. If a
  // later edit makes them disagree, the SQL is no longer the rule anyone read.
  for (const tenantId of [DEFAULT_TENANT_ID, SECOND_TENANT, "tenant_third"]) {
    const bySql = selectWith(nullableTenantWhere(tenantId), FIXTURE);
    const byRule = FIXTURE.filter((row) => ownsNullableTenantRow(tenantId, row.tenantId)).map((row) => row.id);
    assert.deepEqual(bySql, byRule, `fragment and predicate disagree for ${tenantId}`);
  }
});

test("ownership is decided by the row, not by being an owner somewhere", () => {
  assert.equal(ownsNullableTenantRow(DEFAULT_TENANT_ID, null), true);
  assert.equal(ownsNullableTenantRow(SECOND_TENANT, null), false);
  assert.equal(ownsNullableTenantRow(SECOND_TENANT, SECOND_TENANT), true);
  assert.equal(ownsNullableTenantRow(SECOND_TENANT, DEFAULT_TENANT_ID), false);
  assert.equal(ownsNullableTenantRow(DEFAULT_TENANT_ID, SECOND_TENANT), false);
});

/* ─── the same rule, as an invariant over the surface ─────────────────────── */

/**
 * Walked instead of listed, so a query ADDED LATER to any of these files is
 * caught too — the failure mode a fixed list of assertions cannot cover.
 */
const SURFACE = [
  "src/app/(app)/bot-builder/page.tsx",
  "src/app/(app)/bot-builder/[id]/page.tsx",
  "src/app/(app)/bot-builder/[id]/versions/page.tsx",
  "src/app/(app)/bot-builder/[id]/blocks/page.tsx",
  "src/app/(app)/bot-builder/[id]/test/page.tsx",
  "src/app/(app)/bot-analytics/page.tsx",
  "src/app/(app)/chatbot/page.tsx",
  "src/app/actions/flow.ts",
  "src/app/actions/flowVersions.ts",
  "src/app/actions/flowSnippets.ts",
  "src/app/actions/flowAi.ts",
  "src/app/actions/flowSimulator.ts",
  "src/app/actions/bot.ts",
  "src/lib/flowPublishing.ts",
  "src/lib/flowValidationServer.ts",
  "src/lib/botFlowAnalyticsReport.ts",
];

/** Models a workspace owns. Reading one without naming a tenant reads every workspace's. */
const TENANT_OWNED = new Set([
  "botFlow",
  "botFlowVersion",
  "botFlowPublication",
  "botFlowOutbox",
  "botSession",
  "journey",
  "libraryDocument",
  "appSetting",
]);

const OPS = [
  "findFirst", "findMany", "findUnique", "findUniqueOrThrow", "findFirstOrThrow",
  "create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany",
  "count", "aggregate", "groupBy",
];

type Call = { file: string; line: number; model: string; op: string; args: string | null };

/** The source text of `key`'s value inside an argument object — object OR call expression. */
function valueOf(args: string, key: string): string | null {
  const at = args.indexOf(`${key}:`);
  if (at < 0) return null;
  const start = at + key.length + 1;
  let depth = 0;
  let i = start;
  for (; i < args.length; i++) {
    const c = args[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
  }
  return args.slice(start, i).trim();
}

/** Balanced `{…}` starting at `from`, which must index the `{`. */
function braced(code: string, from: number): string {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return code.slice(from, i + 1);
    }
  }
  return code.slice(from);
}

function prismaCalls(file: string): Call[] {
  const code = src(file);
  const out: Call[] = [];
  const pattern = new RegExp(String.raw`\b(?:prisma|basePrisma|tx)\.(\w+)\.(${OPS.join("|")})\(`, "g");
  for (const m of code.matchAll(pattern)) {
    if (!TENANT_OWNED.has(m[1])) continue;
    const after = m.index + m[0].length;
    const brace = code.slice(after).search(/\S/) >= 0 && code[after + code.slice(after).search(/\S/)] === "{"
      ? after + code.slice(after).search(/\S/)
      : -1;
    out.push({
      file,
      line: code.slice(0, m.index).split("\n").length,
      model: m[1],
      op: m[2],
      // No argument object at all (`count()`) is the strongest form of unscoped.
      args: brace < 0 ? null : braced(code, brace),
    });
  }
  return out;
}

/** Does this fragment pin the query to one workspace? */
function namesTenant(fragment: string | null): boolean {
  if (!fragment) return false;
  return /\btenantId\b/.test(fragment)
    || /builderOwnedWhere\(\)/.test(fragment)
    || /legacyFlowTenant\(/.test(fragment)
    || /\bownedFlow\b/.test(fragment);
}

test("every chatbot administration query names the workspace that owns the rows", () => {
  const offenders: string[] = [];
  for (const file of SURFACE) {
    for (const call of prismaCalls(file)) {
      const at = `${file}:${call.line} ${call.model}.${call.op}`;

      // findUnique cannot express the founding-tenant OR at all, and a bare unique
      // id is precisely the leaked/guessed-id path a list filter does not close.
      if (call.op === "findUnique" || call.op === "findUniqueOrThrow") {
        offenders.push(`${at} — fetches by bare id; use findFirst with the tenant named`);
        continue;
      }

      const fragment = call.op === "create" || call.op === "createMany"
        // A create that does not stamp the owner writes a row no workspace owns —
        // invisible once enforcement flips on, and everyone's until it does.
        ? valueOf(call.args ?? "", "data")
        : valueOf(call.args ?? "", "where");

      if (!namesTenant(fragment)) {
        offenders.push(`${at} — ${fragment === null ? "no filter at all" : `filter does not name a tenant: ${fragment}`}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "These administration queries reach other workspaces while enforcement is dormant:\n  " + offenders.join("\n  "),
  );
});

test("raw chatbot SQL in the administration surface names the tenant too", () => {
  const offenders: string[] = [];
  for (const file of SURFACE) {
    const code = src(file);
    for (const m of code.matchAll(/(?:FROM|UPDATE|INTO)\s+"(Bot\w+)"/g)) {
      // The rest of the template literal holding this statement.
      const end = code.indexOf("`", m.index);
      const statement = code.slice(m.index, end < 0 ? m.index + 400 : end);
      if (!/"tenantId"/.test(statement)) {
        offenders.push(`${file}:${code.slice(0, m.index).split("\n").length} ${m[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `raw statements with no tenant predicate: ${offenders.join(", ")}`);
});

test("the walker actually finds the queries it is supposed to guard", () => {
  // Guards against a broken matcher silently passing the two invariants above.
  const builder = prismaCalls("src/app/actions/flow.ts");
  assert.ok(builder.length >= 8, `expected the flow actions to be parsed, found ${builder.length}`);
  assert.ok(builder.some((call) => call.op === "create"), "creates must be parsed, not just reads");
  assert.ok(builder.every((call) => call.args !== null), "every parsed call should expose its arguments");

  // And that `namesTenant` is a real test rather than something everything passes.
  assert.equal(namesTenant("{ id }"), false);
  assert.equal(namesTenant(null), false);
  assert.equal(namesTenant("{ id, ...builderOwnedWhere() }"), true);
  assert.equal(namesTenant("{ tenantId, flowId }"), true);

  const total = SURFACE.flatMap(prismaCalls).length;
  assert.ok(total >= 20, `expected the whole administration surface to be parsed, found ${total}`);
});

test("the builder resolves its workspace the same way the chatbot runtime does", () => {
  // One resolution rule, or the page an owner edits and the flow a customer runs
  // can disagree about who they belong to.
  const scope = src("src/lib/flowTenantScopeServer.ts");
  assert.match(scope, /writeTenantId\(\) \?\? DEFAULT_TENANT_ID/);
  assert.match(src("src/lib/botOutbox.ts"), /writeTenantId\(\) \?\? DEFAULT_TENANT_ID/);
  // And one ownership rule: flowPublishing must reuse it, not restate it.
  assert.match(src("src/lib/flowPublishing.ts"), /legacyFlowTenant = nullableTenantWhere/);
});
