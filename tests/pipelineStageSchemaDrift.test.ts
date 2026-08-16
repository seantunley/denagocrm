import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stageTenantId, pipelineRowVisible, pipelineScopeFor } from "../src/lib/pipelineTenantRule";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

/**
 * PIPELINESTAGE: THE MODEL MUST DESCRIBE THE TABLE, AND "ADD STAGE" MUST WORK.
 *
 * Two linked defects, one cause.
 *
 * (1) Five columns — pipelineId, defaultProbability, staleAfterDays, isClosed,
 *     closedStatus — have existed on "PipelineStage" since migration
 *     52_pipelines_forecasting_rbac_audit and were never declared on the Prisma
 *     model. An UNDECLARED column is not invisible to Prisma, it is EXTRA: the
 *     next `prisma migrate dev` proposes DROPPING all five off a live table.
 *
 * (2) Because `pipelineId` was undeclared, `createStage` could not supply it —
 *     and it is NOT NULL with no default, so every "Add stage" submission on the
 *     settings screen failed. Defect 1 is why defect 2 was unfixable.
 *
 * WHAT THIS FILE PROVES, AND HOW:
 *
 *   - The column contract is DERIVED from the migration SQL and compared against
 *     the model. Nothing about the five columns' types, nullability or defaults is
 *     hardcoded here; if the migration says INTEGER NOT NULL DEFAULT 10, that is
 *     what the model is held to. So the test cannot agree with a wrong guess.
 *   - The ownership decision is EXECUTED (via the real `stageTenantId`), with two
 *     concrete tenant ids, rather than pattern-matched.
 *   - The unique-index collision that broke `moveStage` is EXECUTED against a
 *     model of a non-deferrable UNIQUE ("pipelineId", "order"), so "the old swap
 *     could not work" is demonstrated, not asserted.
 *   - And the wiring is checked against the real action source, because a correct
 *     rule nobody calls fixes nothing. `src/app/actions/settings.ts` is a
 *     "use server" module reaching `server-only`, which `node:test` cannot import,
 *     so the seam is the source text — read with comments STRIPPED, since this
 *     codebase documents its own defects in prose and an unstripped regex would
 *     happily match the paragraph describing the bug it is meant to forbid.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const strip = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");

const MIGRATIONS = path.join(root, "prisma", "migrations");
const ORIGIN = "52_pipelines_forecasting_rbac_audit";

/* ── the database's own account of the table ──────────────────────────────── */

type Column = { name: string; sqlType: string; notNull: boolean; sqlDefault: string | null };

/** Every column statement any migration issues against "PipelineStage", in order. */
function columnsFromMigrations(): Map<string, Column> {
  const columns = new Map<string, Column>();
  const dirs = readdirSync(MIGRATIONS).sort((a, b) => {
    const num = (d: string) => (/^\d+_/.test(d) ? parseInt(d, 10) : Number.MAX_SAFE_INTEGER);
    return num(a) - num(b) || a.localeCompare(b);
  });

  const record = (name: string, rest: string) => {
    const notNull = /\bNOT\s+NULL\b/i.test(rest);
    const def = rest.match(/\bDEFAULT\s+('(?:[^']|'')*'|[^\s,]+)/i);
    const sqlType = rest.trim().split(/\s+/)[0].toUpperCase();
    columns.set(name, { name, sqlType, notNull, sqlDefault: def ? def[1] : null });
  };

  for (const dir of dirs) {
    let sql: string;
    try {
      sql = readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8");
    } catch {
      continue;
    }
    // CREATE TABLE "PipelineStage" ( ... )
    const created = sql.match(/CREATE TABLE\s+"PipelineStage"\s*\(([\s\S]*?)\n\);/);
    if (created) {
      for (const line of created[1].split("\n")) {
        const m = line.match(/^\s*"(\w+)"\s+(.+?),?\s*$/);
        if (m && !/^CONSTRAINT/i.test(m[1])) record(m[1], m[2]);
      }
    }
    // ALTER TABLE "PipelineStage" ADD COLUMN [IF NOT EXISTS] "x" TYPE ...
    const add = /ALTER TABLE\s+"PipelineStage"\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"(\w+)"\s+([^;]+);/gi;
    for (const m of sql.matchAll(add)) if (!columns.has(m[1])) record(m[1], m[2]);
    // ALTER TABLE "PipelineStage" ALTER COLUMN "x" SET NOT NULL
    const tighten = /ALTER TABLE\s+"PipelineStage"\s+ALTER COLUMN\s+"(\w+)"\s+SET NOT NULL/gi;
    for (const m of sql.matchAll(tighten)) {
      const existing = columns.get(m[1]);
      if (existing) columns.set(m[1], { ...existing, notNull: true });
    }
    // No migration drops a PipelineStage column today; if one ever does, this
    // test must learn about it rather than silently keep a phantom field.
    assert.doesNotMatch(
      sql,
      /ALTER TABLE\s+"PipelineStage"\s+DROP COLUMN/i,
      `${dir} drops a PipelineStage column — teach columnsFromMigrations() about it`,
    );
  }
  return columns;
}

/** The Prisma field declaration a SQL column obliges the model to carry. */
function expectedField(column: Column): { type: string; optional: boolean; def: string | null } {
  const type = { TEXT: "String", INTEGER: "Int", BOOLEAN: "Boolean" }[column.sqlType];
  assert.ok(type, `no Prisma mapping for SQL type ${column.sqlType} (${column.name})`);
  const def =
    column.sqlDefault === null
      ? null
      : column.sqlDefault.startsWith("'")
        ? `"${column.sqlDefault.slice(1, -1).replace(/''/g, "'")}"`
        : column.sqlDefault;
  return { type: type!, optional: !column.notNull, def };
}

/* ── the model's account of it ─────────────────────────────────────────────── */

function modelBody(model: string): string {
  const dir = path.join(root, "prisma");
  const schema = readdirSync(dir)
    .filter((f) => f.endsWith(".prisma"))
    .sort()
    .map((f) => readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
  const m = schema.match(new RegExp(`^model\\s+${model}\\s*\\{([\\s\\S]*?)^\\}`, "m"));
  assert.ok(m, `model ${model} not found in any prisma/*.prisma file`);
  return m![1];
}

/** The declaration line for a scalar field, comments and attributes intact. */
function fieldLine(body: string, field: string): string | null {
  const line = body.split("\n").find((l) => new RegExp(`^\\s*${field}\\s+\\S`).test(l));
  return line ?? null;
}

const DRIFTED = ["pipelineId", "defaultProbability", "staleAfterDays", "isClosed", "closedStatus"];

test("the five drifted columns are declared, with the migration's own types", () => {
  const columns = columnsFromMigrations();
  const body = modelBody("PipelineStage");

  for (const name of DRIFTED) {
    const column = columns.get(name);
    assert.ok(column, `${name} is not created by any migration — the premise is wrong`);
    const want = expectedField(column!);

    const line = fieldLine(body, name);
    assert.ok(line, `PipelineStage.${name} is still undeclared — prisma migrate dev would DROP it`);

    const declared = line!.trim().split(/\s+/)[1];
    assert.equal(
      declared.replace(/\?$/, ""),
      want.type,
      `${name}: migration says ${column!.sqlType}, model says ${declared}`,
    );
    assert.equal(
      declared.endsWith("?"),
      want.optional,
      `${name}: migration says ${column!.notNull ? "NOT NULL" : "nullable"}, model disagrees`,
    );
    if (want.def === null) {
      assert.doesNotMatch(line!, /@default\(/, `${name} has no DEFAULT in the database`);
    } else {
      assert.match(
        line!,
        new RegExp(`@default\\(\\s*${want.def.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\)`),
        `${name}: the database defaults to ${want.def}`,
      );
    }
  }

  // The specific facts this branch was told to honour, stated once so a future
  // reader can see them without re-deriving: pipelineId is REQUIRED with no
  // default (added nullable, backfilled, then SET NOT NULL by migration 52).
  const pipelineId = columns.get("pipelineId")!;
  assert.equal(pipelineId.notNull, true);
  assert.equal(pipelineId.sqlDefault, null);
  assert.match(fieldLine(body, "pipelineId")!, /^\s*pipelineId\s+String\s*$/);
});

test("no column of the table is left off the model at all", () => {
  // The general form of the same defect. Written as "every column the migrations
  // create is declared" so the NEXT undeclared column fails here instead of in a
  // migrate-dev diff that proposes dropping it.
  const columns = [...columnsFromMigrations().keys()];
  const body = modelBody("PipelineStage");
  const missing = columns.filter((c) => fieldLine(body, c) === null);
  assert.deepEqual(missing, [], `undeclared PipelineStage columns: ${missing.join(", ")}`);
  // 11 → 15 with 20260813120000_stage_gates, which adds entryCriteria,
  // exitCriteria, entryGateMode and exitGateMode. All four are declared on the
  // model in the same change — the `missing` assertion above is what proves it;
  // this number only exists to make the NEXT undeclared column fail here.
  assert.equal(columns.length, 15, "the table's column count changed — re-check the model");
});

test("the relation to SalesPipeline is declared on both sides, and matches the FK", () => {
  const stage = modelBody("PipelineStage");
  assert.match(
    stage,
    /pipeline\s+SalesPipeline\s+@relation\(fields:\s*\[pipelineId\],\s*references:\s*\[id\]\)/,
    "PipelineStage.pipelineId must be a real relation, not a loose string",
  );
  // The back-reference lives in governance.prisma. Prisma runs in FOLDER mode
  // (schema: "./prisma"), so the relation legitimately crosses files.
  assert.match(modelBody("SalesPipeline"), /stages\s+PipelineStage\[\]/);

  // Prisma's DEFAULT referential actions for a required relation are exactly the
  // FK migration 52 created — RESTRICT/CASCADE — so declaring none keeps the
  // generated DDL identical to the live constraint. Spelling different ones here
  // would be a silent schema change on a live table.
  const fk = read(`prisma/migrations/${ORIGIN}/migration.sql`);
  assert.match(
    fk,
    /ADD CONSTRAINT "PipelineStage_pipelineId_fkey" FOREIGN KEY \("pipelineId"\)\s*\n?\s*REFERENCES "SalesPipeline"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE/,
  );
  assert.doesNotMatch(
    stage.split("\n").find((l) => /pipeline\s+SalesPipeline/.test(l))!,
    /onDelete|onUpdate/,
    "the defaults already match the live FK; naming others would change it",
  );
});

test("the declared indexes are the ones the database actually has", () => {
  const stage = modelBody("PipelineStage");
  const sql = read(`prisma/migrations/${ORIGIN}/migration.sql`);

  // Prisma derives "PipelineStage_pipelineId_order_key" from this @@unique, which
  // is the index migration 52 created when it dropped the global order key.
  assert.match(sql, /CREATE UNIQUE INDEX "PipelineStage_pipelineId_order_key" ON "PipelineStage"\("pipelineId", "order"\)/);
  assert.match(sql, /DROP INDEX IF EXISTS "PipelineStage_order_key"/);
  assert.match(stage, /@@unique\(\[pipelineId, order\]\)/);

  assert.match(sql, /CREATE INDEX "PipelineStage_pipelineId_idx" ON "PipelineStage"\("pipelineId"\)/);
  assert.match(stage, /@@index\(\[pipelineId\]\)/);

  // Already declared before this change; asserted so a later edit cannot quietly
  // drop the composite parent key the tenant FKs point at.
  assert.match(stage, /@@unique\(\[tenantId, id\]\)/);
  assert.match(
    read("prisma/migrations/20260727150000_composite_tenant_fks_supplement/migration.sql"),
    /CREATE UNIQUE INDEX IF NOT EXISTS "PipelineStage_tenantId_id_key"/,
  );

  // The two PARTIAL unique indexes on entryAction (migration 79) have no DSL
  // equivalent — a WHERE clause on an index. They must stay undeclared, or Prisma
  // would render them as TOTAL uniques and change what the database enforces.
  const m79 = read("prisma/migrations/79_pipeline_stage_actions/migration.sql");
  assert.match(m79, /CREATE UNIQUE INDEX IF NOT EXISTS "PipelineStage_tenant_pipeline_entryAction_key"[\s\S]*?WHERE/);
  assert.doesNotMatch(stage, /@@unique\(\[[^\]]*entryAction[^\]]*\]\)/);
});

/* ── defect 2: the create path ─────────────────────────────────────────────── */

const settings = strip(read("src/app/actions/settings.ts"));
const slice = (from: string, to: string) => settings.slice(settings.indexOf(from), settings.indexOf(to));
const CREATE = slice("export async function createStage", "export async function renameStage");
const MOVE = slice("export async function moveStage", "export async function deleteStage");

test("createStage attaches the stage to a pipeline", () => {
  assert.ok(CREATE.length > 0, "createStage not found — the slice markers moved");

  // The defect, stated as the thing that must never come back: a create whose
  // data carries no pipelineId at all. "pipelineId" is NOT NULL with no default.
  assert.match(CREATE, /pipelineId: pipeline\.id/, "the stage is created without a pipeline");
  assert.match(CREATE, /pipelineStage\.create\(\{[\s\S]*?pipelineId:/, "pipelineId is not in the create payload");

  // And WHICH pipeline is the codebase's existing rule, not a fresh one. Anything
  // hand-rolled here (a literal id, a bare findFirst) is a second answer to a
  // question src/lib/pipelines.ts already answers.
  assert.match(CREATE, /await getDefaultPipeline\(\)/, "the pipeline must come from the shared default rule");
  assert.doesNotMatch(CREATE, /pipeline_default_retail/, "a hardcoded pipeline id is not a rule");
  assert.doesNotMatch(CREATE, /salesPipeline\.findFirst/, "that re-derives getDefaultPipeline()");
  assert.match(CREATE, /refuse\(/, "no active pipeline must refuse, not write a broken row");

  // Ordering is unique WITHIN a pipeline, so the next order must be read within
  // one. The unscoped global max this replaces drifts upward forever.
  assert.match(CREATE, /aggregate\(\{[\s\S]*?where: \{ pipelineId: pipeline\.id \}/);
});

test("createStage stamps the PARENT PIPELINE's tenant, not the actor's", () => {
  assert.match(
    CREATE,
    /tenantId: stageTenantId\(\{\s*pipelineTenantId: owner\.tenantId/,
    "the stage's owner must be resolved from its parent pipeline",
  );
  assert.match(settings, /import \{[^}]*stageTenantId[^}]*\} from "@\/lib\/pipelineTenantRule"/);

  // The two wrong answers, each named so neither can be reintroduced as a
  // "simplification". writeTenantId() is null while enforcement is dormant — a
  // row born unowned, invisible to its own workspace at the flip.
  assert.doesNotMatch(CREATE, /tenantId: writeTenantId\(\)/, "writeTenantId() is null while dormant");
  assert.doesNotMatch(CREATE, /tenantId: await getActiveTenantId\(\)/, "that is the EDITOR's tenant");
  assert.doesNotMatch(CREATE, /tenantId: DEFAULT_TENANT_ID/, "the founding tenant is not every stage's owner");

  // The write must bypass the guarded client, or the stamp is decorative: under
  // enforcement stampCreate() overwrites data.tenantId with the ACTING scope.
  assert.match(CREATE, /basePrisma\.pipelineStage\.create/, "a guarded create would overwrite the parent's tenant");
  assert.doesNotMatch(CREATE, /[^e]\bprisma\.pipelineStage\.create/, "the guarded client rewrites tenantId");
});

test("a stage created against another workspace's pipeline belongs to THAT workspace", () => {
  // Executed, with two concrete tenants: an owner acting in the founding tenant
  // adds a stage to a pipeline owned by a second dealer. Composed from the same
  // functions the action calls, so this is the decision, not a paraphrase.
  const TENANT_A = DEFAULT_TENANT_ID;
  const TENANT_B = "tenant_second_dealer";

  const stamp = (pipelineTenantId: string | null, actingTenantId: string) =>
    stageTenantId({ pipelineTenantId, actingTenantId });

  assert.equal(stamp(TENANT_B, TENANT_A), TENANT_B, "the stage was split off from its own pipeline");
  assert.equal(stamp(TENANT_A, TENANT_B), TENANT_A);
  assert.equal(stamp(TENANT_A, TENANT_A), TENANT_A);

  // A stage never lands unowned when its pipeline is owned — the dormant-null
  // outcome that made this bug survivable-looking.
  assert.notEqual(stamp(TENANT_A, TENANT_A), null);

  // And the consequence that matters to a CONSTRAINED reader: tenant A cannot
  // see the stage it just created inside tenant B's pipeline; tenant B can.
  const stamped = stamp(TENANT_B, TENANT_A);
  assert.equal(pipelineRowVisible(stamped, pipelineScopeFor({ actingTenantId: TENANT_A })), false);
  assert.equal(pipelineRowVisible(stamped, pipelineScopeFor({ actingTenantId: TENANT_B })), true);

  // Parent and child agree, which is the invariant the composite
  // (tenantId, id) key on PipelineStage exists to express.
  for (const [pipelineTenant, acting] of [
    [TENANT_A, TENANT_B],
    [TENANT_B, TENANT_A],
    [TENANT_B, TENANT_B],
  ] as const) {
    assert.equal(stamp(pipelineTenant, acting), pipelineTenant, "child must match its parent");
  }
});

/* ── defect 2, second half: moveStage against a non-deferrable UNIQUE ─────── */

type StageRow = { id: string; pipelineId: string; order: number };

/**
 * One UPDATE against a table carrying UNIQUE ("pipelineId", "order").
 *
 * `CREATE UNIQUE INDEX` produces a NON-DEFERRABLE constraint — it cannot be
 * deferred to COMMIT even inside a transaction — so the check lands as the
 * statement writes the index tuple, not at the end of the transaction. That is
 * the whole defect, so it is modelled rather than described.
 */
function update(rows: StageRow[], id: string, order: number): StageRow[] {
  const target = rows.find((r) => r.id === id);
  assert.ok(target, `no such row ${id}`);
  const next = rows.map((r) => (r.id === id ? { ...r, order } : r));
  const clashes = next.filter((r) => r.pipelineId === target!.pipelineId && r.order === order);
  if (clashes.length > 1) {
    throw new Error('duplicate key value violates unique constraint "PipelineStage_pipelineId_order_key"');
  }
  return next;
}

const board = (): StageRow[] => [
  { id: "new", pipelineId: "p1", order: 0 },
  { id: "quoted", pipelineId: "p1", order: 1 },
  { id: "won", pipelineId: "p1", order: 2 },
];

test("the old two-update swap could not have worked", () => {
  const rows = board();
  // Exactly what the previous moveStage ran, both statements in one transaction.
  assert.throws(
    () => {
      const afterFirst = update(rows, "new", 1); // A takes B's order
      update(afterFirst, "quoted", 0); // never reached
    },
    /duplicate key value violates unique constraint "PipelineStage_pipelineId_order_key"/,
    "the first UPDATE must collide — one transaction does not defer an index-backed unique",
  );
});

test("the park-then-place two pass reorderPipelineStages uses does work", () => {
  // The manoeuvre reorderPipelineStages performs: park EVERY stage of the
  // pipeline at 1000+i, then place each at i. No transient duplicate at any point.
  const desired = ["quoted", "new", "won"];
  let rows = board();
  desired.forEach((id, i) => {
    rows = update(rows, id, 1000 + i);
  });
  desired.forEach((id, i) => {
    rows = update(rows, id, i);
  });

  assert.deepEqual(
    [...rows].sort((a, b) => a.order - b.order).map((r) => r.id),
    desired,
  );
  assert.deepEqual([...rows].map((r) => r.order).sort((a, b) => a - b), [0, 1, 2]);

  // The park pass is only safe because it covers EVERY stage of the pipeline —
  // reorderPipelineStages refuses a partial list for exactly this reason.
  const lib = strip(read("src/lib/pipelines.ts"));
  const reorder = lib.slice(
    lib.indexOf("export async function reorderPipelineStages"),
    lib.indexOf("export async function archivePipeline"),
  );
  assert.match(reorder, /1000 \+ index/, "the parking pass is what makes the swap legal");
  assert.match(reorder, /throw new Error\("Stage order does not match the pipeline"\)/);
});

test("moveStage delegates the swap instead of keeping a broken copy of it", () => {
  assert.ok(MOVE.length > 0, "moveStage not found — the slice markers moved");
  assert.match(MOVE, /await reorderPipelineStages\(pipeline\.id, ids\)/);
  assert.doesNotMatch(
    MOVE,
    /\$transaction\(\[/,
    "the colliding two-update swap must not survive",
  );
  assert.doesNotMatch(MOVE, /data: \{ order:/, "no direct order write may bypass the two pass");

  // And it must swap against a neighbour in the SAME pipeline. Reading every
  // stage ordered by `order` interleaves pipelines once there is more than one.
  // The pipeline is the one the ownership-carrying lookup returned, so bounding the
  // list by it and bounding it by the boundary are now the same act.
  assert.match(MOVE, /where: \{ pipelineId: pipeline\.id \}/);
  assert.match(MOVE, /const pipeline = await findOwnedPipelineForStage\(id\)/);
});

test("neither stage action READS outside the boundary, not just writes inside it", () => {
  // WHY THIS TEST EXISTS, and why it is separate from the owner gate above.
  //
  // Both actions run on `basePrisma`, the documented RLS bypass, and both take an
  // id straight off a POST. The reason that is safe is #457
  // (feat/kanban-pipeline-context), which this change is stacked on: it scopes
  // `getDefaultPipeline()` to the acting workspace and puts `requireOwnedPipeline()`
  // in front of `reorderPipelineStages()`. Against plain main neither of those
  // exists — so this file must not be merged ahead of #457, and if it ever is
  // rebased back onto a base without them, these assertions are what says so.
  //
  // "The write refuses eventually" is not the property being asserted here. A read
  // that resolves before the refusal has already crossed the boundary.

  // createStage: the pipeline comes from the scoped default rule, and its OWNER is
  // read through the gate rather than by a bare id lookup beside it.
  assert.match(CREATE, /const owner = await requireOwnedPipeline\(pipeline\.id\)/);
  assert.doesNotMatch(
    CREATE,
    /salesPipeline\.findUnique/,
    "an unscoped SalesPipeline read by id is the shape the gate replaces",
  );
  assert.match(settings, /import \{[^}]*requireOwnedPipeline[^}]*\} from "@\/lib\/pipelines"/);

  // moveStage: the gate must sit BEFORE the stage list and before either
  // positional refusal, or a forged id reads another workspace's ordered stage
  // list and is told where in it that stage sits.
  //
  // It must also be the FIRST thing that touches a row. #466 put the gate above
  // the list but left an unscoped `findUnique` by the bound id above the gate, and
  // whether that read RESOLVED then chose between a thrown Error and a refuse() —
  // one distinguishable bit of "this id exists somewhere". The lookup and the gate
  // are now one statement; tests/stageLookupOracle.test.ts executes the property.
  const gateAt = MOVE.indexOf("await findOwnedPipelineForStage(id)");
  assert.ok(gateAt > 0, "moveStage must resolve the parent pipeline through the tenant boundary");
  assert.doesNotMatch(MOVE, /pipelineStage\.findUnique/, "no unscoped stage read may precede the gate");
  for (const [what, needle] of [
    ["the stage list", "pipelineStage.findMany"],
    ["the position oracle", "already at the end"],
    ["the reorder", "reorderPipelineStages(pipeline.id, ids)"],
  ] as const) {
    const at = MOVE.indexOf(needle);
    assert.ok(at > 0, `moveStage no longer contains ${what} — the markers moved`);
    assert.ok(gateAt < at, `${what} runs before ownership is established`);
  }

  // And the gate has to be the scoped one. An export that stopped filtering would
  // satisfy every assertion above, so the query itself is checked here too.
  const lib = strip(read("src/lib/pipelines.ts"));
  const gate = lib.slice(
    lib.indexOf("async function requireOwnedPipeline"),
    lib.indexOf("export async function findOwnedPipelineForStage"),
  );
  assert.match(gate, /await pipelineTenantFilter\(\)/, "the gate must build a tenant predicate");
  assert.match(gate, /WHERE "id" = \$\{id\} AND "deletedAt" IS NULL \$\{scope\}/);
  assert.match(gate, /throw new Error\("Pipeline not found"\)/);
});

/* ── constrained callers ───────────────────────────────────────────────────── */

test("both stage actions are still owner-gated on their own entry path", () => {
  // A Server Action is a POST endpoint: the settings screen not rendering the form
  // for a member is not a boundary. Neither action may become reachable to one.
  for (const [name, body] of [["createStage", CREATE], ["moveStage", MOVE]] as const) {
    assert.match(body, /await requireOwner\(\);/, `${name} lost its guard`);
    const guardAt = body.indexOf("requireOwner");
    const writeAt = Math.min(
      ...[body.indexOf("pipelineStage.create"), body.indexOf("reorderPipelineStages")].filter((i) => i >= 0),
    );
    assert.ok(guardAt >= 0 && guardAt < writeAt, `${name} writes before it checks the caller`);
  }
});
