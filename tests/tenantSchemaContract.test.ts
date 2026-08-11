import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { GLOBAL_MODELS } from "../src/lib/tenantGuard";

/**
 * Activation-safety contract: every Prisma model must be EITHER declared global
 * (in GLOBAL_MODELS) OR carry a `tenantId` field — otherwise, once enforcement is
 * on, the guard would scope a model that has no such column and every query would
 * fail at activation time.
 *
 * Parses EVERY prisma/*.prisma file directly — Prisma runs in folder mode, so
 * all of them are the schema, and reading only schema.prisma is how the models in
 * the side-files escaped this contract once already. (The generated client's
 * runtime `Prisma.dmmf` proved unreliable here, returning models absent from the
 * current schema; the schema files never do.) No DB, no client.
 *
 * KNOWN PENDING: models intentionally not yet resolved. Each MUST be cleared
 * (given a tenantId, or moved to GLOBAL_MODELS) before enforcement is enabled.
 *
 * ── AND THE TABLES THE SCHEMA CANNOT SEE ───────────────────────────────────
 *
 * Everything above is a contract over the REPOSITORY. The 2026-08-10 production
 * audit found twenty tables with no tenantId column, and thirteen of them are in
 * no .prisma file at all — drift from renamed features and from the
 * preview-migration incidents, plus two tables Prisma generates and owns. Not
 * one of them could ever fail a schema-driven test, because none of them is in
 * the schema. DB_ONLY_TABLES, at the foot of this file, is where they are named
 * by hand and given a disposition, so "we decided" and "we never looked" stop
 * being the same thing.
 */
// Until this test read EVERY prisma/*.prisma file (it previously read only
// schema.prisma), the models below sat in side-files (journeys.prisma,
// governance.prisma) and escaped the contract unnoticed. They are listed here
// as the deliberately-visible escape hatch so the gap is TRACKED, not silent.
// Each MUST be resolved before tenant enforcement is enabled, or its queries
// fail closed on a missing column:
// governance.prisma's RBAC/forecast models are resolved: SalesPipeline/Team/
// TeamMember/UserRole/ForecastSnapshot/AuditEvent got a tenantId slice (migration
// 20260725160000); Permission (the fixed, code-defined capability catalog) was
// decided GLOBAL and lives in GLOBAL_MODELS in tenantGuard.ts. Role/RolePermission
// were ALSO originally GLOBAL under that same decision, but custom (non-system)
// roles are tenant-authored (createRole() in accessControl.ts), so they were
// reclassified: both got a tenantId slice instead (migration
// 20260727100000_role_tenant_scoping) — NULL means system/global, non-null means
// one tenant's own role — and were removed from GLOBAL_MODELS.
// journeys.prisma's Journey* models got their tenantId slice (migration
// 20260726200000_journey_tenant_isolation), so nothing remains PENDING — every
// model is now explicitly global or tenant-scoped, the precondition for enabling
// enforcement.
const PENDING = new Set<string>([]);

// Prisma is configured with `schema: "./prisma"` (folder mode), so it loads
// EVERY `prisma/*.prisma` file — not just schema.prisma. Read them all, or a
// model added to a side-file (journeys/governance/marketing/etc.) would escape
// this contract entirely and silently break the guard at enforcement time.
const prismaDir = fileURLToPath(new URL("../prisma", import.meta.url));
const SCHEMA_FILES = readdirSync(prismaDir)
  .filter((f) => f.endsWith(".prisma"))
  .sort();
const schema = SCHEMA_FILES.map((f) => readFileSync(join(prismaDir, f), "utf8")).join("\n");

/** Parse `model X { ... }` blocks (Prisma model bodies have no nested braces). */
function parseModels(src: string): Map<string, string> {
  const models = new Map<string, string>();
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) models.set(m[1], m[2]);
  return models;
}

/** A model owns a `tenantId` scalar field (a line `tenantId <Type>...`). */
function hasTenantId(body: string): boolean {
  return /^\s*tenantId\s+\w/m.test(body);
}

const MODELS = parseModels(schema);

test("schema parsed a plausible number of models", () => {
  // Guards against a broken parser silently passing the contract below.
  assert.ok(MODELS.size >= 50, `expected >= 50 models, parsed ${MODELS.size}`);
});

test("every model is global, tenant-scoped, or explicitly pending", () => {
  const offenders: string[] = [];
  for (const [name, body] of MODELS) {
    if (GLOBAL_MODELS.has(name)) continue;
    if (hasTenantId(body)) continue;
    if (PENDING.has(name)) continue;
    offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `Models neither global, tenant-scoped, nor pending — add tenantId, add to GLOBAL_MODELS, or (temporarily) to PENDING: ${offenders.join(", ")}`,
  );
});

test("no GLOBAL_MODELS entry is stale (each names a real model)", () => {
  for (const g of GLOBAL_MODELS) {
    assert.ok(MODELS.has(g), `GLOBAL_MODELS lists "${g}" but no such Prisma model exists`);
  }
});

test("no PENDING entry is stale (each is a real model still missing tenantId)", () => {
  for (const p of PENDING) {
    const body = MODELS.get(p);
    assert.ok(body !== undefined, `PENDING lists "${p}" but no such Prisma model exists`);
    assert.equal(hasTenantId(body!), false, `PENDING lists "${p}" but it now HAS tenantId — remove it from PENDING`);
  }
});

test("the contract reads EVERY prisma file, not just schema.prisma", () => {
  // The regression guard for this test's own worst bug. It once read only
  // schema.prisma, so every model in a side-file — governance.prisma's
  // Role/Permission/UserRole, journeys.prisma's whole engine — was never checked
  // at all. A reviewer reading the code could not tell: the test passed either
  // way, and passing was the symptom.
  //
  // Asserting the glob is not enough on its own, because a glob that silently
  // matched one file would also pass. So: several files, AND a model that only
  // exists in a side-file must be visible from here.
  assert.ok(
    SCHEMA_FILES.length >= 5,
    `expected the folder-mode glob to find several .prisma files, found ${SCHEMA_FILES.length}: ${SCHEMA_FILES.join(", ")}`,
  );
  assert.ok(SCHEMA_FILES.includes("governance.prisma"), "governance.prisma must be read");
  for (const [model, file] of [
    ["Permission", "governance.prisma"],
    ["Role", "governance.prisma"],
    ["Journey", "journeys.prisma"],
  ] as const) {
    assert.ok(MODELS.has(model), `${model} lives in ${file} and must be visible to this contract`);
  }
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TABLES THAT EXIST IN THE DATABASE AND IN NO prisma/*.prisma FILE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything above walks the Prisma schema, so a table the DATABASE has and the
 * repository does not is invisible to it — by definition, not by oversight. That
 * blind spot is the reason this section exists.
 *
 * The read-only production audit of 2026-08-10 (PREFLIP-TENANT-AUDIT.md §2)
 * found TWENTY tables with no tenantId column. Seven turned out to be Prisma
 * models already declared in GLOBAL_MODELS, and the tests above cover those. The
 * remaining THIRTEEN are not models at all: eleven are drift left behind by
 * renamed or withdrawn features and by the preview-migration incidents this
 * repository has now recorded three times, and two are tables Prisma generates
 * and owns.
 *
 * Not one of them could fail any test in this file, before or after this change,
 * because none of them is in the schema the file parses. `git log -S` across
 * every ref finds no commit that ever declared MarketingJourney*, StockLocation,
 * StockMovement or StockAttachment in a .prisma file. They have never been
 * visible to any repository-reading check, and they still would not be if this
 * register did not name them by hand.
 *
 * So they are named by hand — the same device tests/rlsPolicyCoverage.test.ts
 * uses for its five orphans, and load-bearing for the same reason: delete a line
 * here and a table silently stops being accounted for, with nothing else going
 * red.
 *
 * THE RULE THIS ENFORCES is the one the audit put plainly: every table ends up
 * either SCOPED (has a tenantId and is enforced) or DECLARED GLOBAL with a
 * reason. Being NEITHER is the only wrong answer, and it is where all twenty of
 * these sat. `deferred` is a third state on purpose — it is not a synonym for
 * neither, because it costs a reason and a named follow-up, and this test fails
 * if the reason is thin.
 */
type Disposition = "scoped" | "global" | "deferred";
const DB_ONLY_TABLES: Record<string, { disposition: Disposition; why: string }> = {
  // ── SCOPED by 20260810130000_orphan_table_tenant_coverage ─────────────────
  StockLocation: {
    disposition: "scoped",
    why:
      "Dealer-specific location (bay, yard, showroom floor) in a shared-catalogue stock model — " +
      "this IS the shared-stock/walled-data boundary, and it had none. 2 production rows, backfilled " +
      "to the founding tenant. Modelled siblings StockUnit/StockReservation/StockEvent have carried a " +
      "tenantId since the Phase B slice.",
  },
  StockMovement: {
    disposition: "scoped",
    why:
      "A dealer's own ledger entry — what left which bay, when, to whom. Same boundary as " +
      "StockLocation. 1 production row, backfilled to the founding tenant. Named in src/lib/backup.ts " +
      "as one of three whole tables missing from every backup because Prisma did not know it existed.",
  },
  StockAttachment: {
    disposition: "scoped",
    why:
      "Third of the same domain, 0 rows, so the column is free today. Split from its two siblings only " +
      "by row count; covering two of three would leave the next audit asking why.",
  },
  MarketingJourney: {
    disposition: "scoped",
    why:
      "Marketing-side journey engine present only in the production database. The engine this repo " +
      "ships is journeys.prisma's Journey/JourneyVersion/JourneyRun, all of which took a tenantId in " +
      "20260726200000_journey_tenant_isolation. 0 rows, so this is the cheap moment.",
  },
  MarketingJourneyVersion: {
    disposition: "scoped",
    why:
      "Version history for MarketingJourney — same prod-only origin, same drift, 0 rows. Scoped with " +
      "its parent rather than left to inherit through a join, following the convention this codebase " +
      "already uses for RolePermission and CampaignRecipient: a child carries a denormalized copy of " +
      "its parent's tenantId so raw-SQL reads and RLS policies can filter without a join.",
  },
  MarketingJourneyEnrollment: {
    disposition: "scoped",
    why:
      "An enrolment names a PERSON against a journey, so of the four MarketingJourney* tables this is " +
      "the one whose rows would be customer data — the exact thing the walled-data boundary exists for. " +
      "0 rows today.",
  },
  MarketingJourneyStepRun: {
    disposition: "scoped",
    why:
      "Per-step execution record beneath MarketingJourneyEnrollment; same prod-only origin, 0 rows. " +
      "Its modelled counterpart JourneyStepLog was found 6/6 unowned in the same audit, which is what " +
      "a run-level table looks like when nothing stamps it — scoped now, while it is empty and the " +
      "column is free, rather than after it has rows whose owner has to be reconstructed.",
  },
  PdfmeTemplate: {
    disposition: "scoped",
    why:
      "The only one of the eight this repository ever declared — 84d5f3b4 promoted a pdfme prototype to " +
      "a persisted Document Designer and the model was withdrawn when the rows/cols/blocks editor " +
      "replaced it. The table outlived the model. A document template is tenant-authored (a dealer's own " +
      "quote or invoice layout), so if anything writes here again it is tenant data. 0 rows.",
  },

  // ── GLOBAL by decision ────────────────────────────────────────────────────
  SecurityRateLimit: {
    disposition: "global",
    why:
      "Deliberately model-less, not accidentally: created by 54_security_rbac_hardening and read only " +
      "through basePrisma raw SQL in src/lib/rateLimit.ts. Keyed by scope:HMAC(identifier) where the " +
      "identifier is an IP, email, signing token or API key — LOGIN_POLICY, OTP_SEND_POLICY and " +
      "SIGNING_POLICY all throttle callers who have NOT authenticated and so have no tenant. Scoping it " +
      "would fail closed on exactly the requests it exists to slow down, and a limiter an attacker can " +
      "reset by switching tenant context is a security regression, not a neutral change.",
  },
  _prisma_migrations: {
    disposition: "global",
    why:
      "Prisma's own migration ledger — platform infrastructure, one per database, describing the " +
      "database rather than anything inside it. Read and written by scripts/apply-migrations.mjs on the " +
      "trusted path. A tenantId here would be a category error.",
  },

  // ── DEFERRED, with the follow-up named ────────────────────────────────────
  Organization: {
    disposition: "deferred",
    why:
      "NOT conceptual overlap with Tenant — it IS Tenant under its previous name. Commit d2f38109 " +
      "('rename Organization→Tenant') rewrote CREATE TABLE \"Organization\" to CREATE TABLE \"Tenant\" " +
      "inside 20260721130000_tenant_foundation, in place, after production had already applied the " +
      "earlier text; production kept the old table and gained the new one. The 1 Organization row and " +
      "the 1 Tenant row are the same founding dealer written twice. A tenantId here would ask which " +
      "tenant owns the tenant table. FOLLOW-UP: DROP, after diffing the rows against Tenant — " +
      "destructive, so out of scope for an additive migration.",
  },
  OrganizationMembership: {
    disposition: "deferred",
    why:
      "Predecessor of TenantMember, renamed in the same commit and stranded the same way. Its 2 rows " +
      "are the same memberships TenantMember holds. FOLLOW-UP: DROP alongside Organization, after the " +
      "same row-level confirmation.",
  },
  _ContactToTag: {
    disposition: "deferred",
    why:
      "The join table Prisma GENERATES for the implicit many-to-many between Contact and Tag. Prisma " +
      "owns its shape — exactly columns A and B — and a tenantId cannot be added without converting the " +
      "relation to an explicit ContactTag model, rewriting every `tags: { connect }` call site. Adding " +
      "the column anyway would be worse than leaving it: Prisma's implicit-m2m INSERT names only (A,B), " +
      "so every new link would be written tenantId NULL and a FORCE'd policy would reject it at the RLS " +
      "cutover — an outage created in the name of preventing a leak. Exposure is bounded because both " +
      "endpoints are tenant-scoped and Tag.tenantId is NOT NULL (20260727220000), so a cross-tenant link " +
      "cannot be made through the ORM without first reading another tenant's Tag; the residual risk is a " +
      "raw join. FOLLOW-UP: explicit ContactTag model, its own change.",
  },
};

/** The full audit finding: every table production had with no tenantId column. */
const AUDIT_TABLES_WITHOUT_TENANT_ID = [
  "MarketingJourney",
  "MarketingJourneyEnrollment",
  "MarketingJourneyStepRun",
  "MarketingJourneyVersion",
  "Organization",
  "OrganizationMembership",
  "OtpChallenge",
  "Passkey",
  "PdfmeTemplate",
  "Permission",
  "PlatformAdmin",
  "PlatformAdminSession",
  "PushSubscription",
  "SecurityRateLimit",
  "StockAttachment",
  "StockLocation",
  "StockMovement",
  "Tenant",
  "_ContactToTag",
  "_prisma_migrations",
];

const COVERAGE_MIGRATION = "20260810130000_orphan_table_tenant_coverage";
const coverageSql = readFileSync(
  join(prismaDir, "migrations", COVERAGE_MIGRATION, "migration.sql"),
  "utf8",
);
/** The file with every `-- comment` line removed, so prose cannot satisfy a check. */
const coverageBody = coverageSql.replace(/^\s*--.*$/gm, "");

test("every table the audit found is accounted for — model or DB-only register", () => {
  const unaccounted = AUDIT_TABLES_WITHOUT_TENANT_ID.filter(
    (t) => !MODELS.has(t) && !(t in DB_ONLY_TABLES),
  );
  assert.deepEqual(
    unaccounted,
    [],
    "Tables from PREFLIP-TENANT-AUDIT.md §2 that are neither a Prisma model (covered by the tests " +
      "above) nor entered in DB_ONLY_TABLES. Being NEITHER scoped nor declared is the one wrong " +
      `answer: ${unaccounted.join(", ")}`,
  );
  assert.equal(AUDIT_TABLES_WITHOUT_TENANT_ID.length, 20, "the audit found twenty; keep this list whole");
});

test("audit tables that ARE Prisma models are declared global", () => {
  // The seven models among the twenty. Each has no tenantId column and must
  // therefore be in GLOBAL_MODELS, or the guard fails closed on a column that
  // deliberately does not exist the moment enforcement is on.
  const modelled = AUDIT_TABLES_WITHOUT_TENANT_ID.filter((t) => MODELS.has(t));
  assert.equal(modelled.length, 7, `expected 7 of the twenty to be models, got ${modelled.length}`);
  for (const name of modelled) {
    assert.ok(
      GLOBAL_MODELS.has(name) || hasTenantId(MODELS.get(name)!),
      `"${name}" has no tenantId column on production and is not in GLOBAL_MODELS`,
    );
  }
});

test("no DB_ONLY_TABLES entry is stale (none may be a Prisma model)", () => {
  // If someone adds a Prisma model for one of these, the entry must move: the
  // model-driven tests above now cover it, and leaving it here would let a real
  // model hide behind a hand-written reason.
  for (const table of Object.keys(DB_ONLY_TABLES)) {
    assert.ok(
      !MODELS.has(table),
      `DB_ONLY_TABLES lists "${table}", but it is now a Prisma model — remove the entry and let the ` +
        "schema-driven contract cover it (add a tenantId or add it to GLOBAL_MODELS)",
    );
  }
});

test("every DB_ONLY_TABLES entry states a real reason", () => {
  for (const [table, { disposition, why }] of Object.entries(DB_ONLY_TABLES)) {
    assert.ok(
      ["scoped", "global", "deferred"].includes(disposition),
      `"${table}" has an unknown disposition "${disposition}"`,
    );
    // A declaration nobody can check is one somebody quietly reverses. This is
    // the same bar rlsPolicyCoverage.test.ts sets on NO_POLICY_BY_DESIGN.
    assert.ok(why.length > 120, `"${table}" needs a reason that survives being read in a year, not "${why}"`);
  }
});

test("every DEFERRED entry names its follow-up", () => {
  // `deferred` is only defensible while it is a decision with an owner. Without
  // this, it degrades into the "neither" state the audit was written about.
  for (const [table, { disposition, why }] of Object.entries(DB_ONLY_TABLES)) {
    if (disposition !== "deferred") continue;
    assert.match(
      why,
      /FOLLOW-UP:/,
      `"${table}" is deferred but names no follow-up — say what would resolve it and who it belongs to`,
    );
  }
});

test("every SCOPED table really is scoped by the migration", () => {
  // The register says these got a column. This checks the SQL, because a
  // register that can drift from the migration is a register that will.
  for (const [table, { disposition }] of Object.entries(DB_ONLY_TABLES)) {
    if (disposition !== "scoped") continue;
    assert.match(
      coverageBody,
      new RegExp(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "tenantId" TEXT`),
      `${table} must get a nullable tenantId`,
    );
    assert.match(
      coverageBody,
      new RegExp(`CREATE INDEX IF NOT EXISTS "${table}_tenantId_idx" ON "${table}"\\("tenantId"\\)`),
      `${table} must get the tenantId index every scoped table has`,
    );
    assert.match(
      coverageBody,
      new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`),
      `${table} must have RLS enabled`,
    );
    assert.match(
      coverageBody,
      new RegExp(`CREATE POLICY "${table}_tenant_isolation" ON "${table}"`),
      `${table} must have an isolation policy — RLS enabled with no policy denies every row`,
    );
    assert.match(
      coverageBody,
      new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`),
      `${table} must be FORCE'd, or the owning role is exempt from its own policy`,
    );
  }
});

test("the coverage migration is reentrant — the runner opens no transaction", () => {
  // scripts/apply-migrations.mjs executes statements one at a time with NO
  // transaction, by design and by comment. A failure part way through leaves the
  // earlier statements applied and the migration unrecorded, so it re-runs from
  // the top on the next deploy. That is not hypothetical here: a half-applied
  // migration took production's login down in July.
  const scoped = Object.entries(DB_ONLY_TABLES).filter(([, v]) => v.disposition === "scoped");

  // One guard per table, and no DDL outside one — these tables do not exist in a
  // database built from this repository, so CI and previews must skip them.
  assert.equal(
    (coverageBody.match(/^ALTER TABLE/gm) ?? []).length,
    0,
    "no top-level ALTER TABLE — every statement must sit inside an existence check",
  );
  assert.equal(
    (coverageBody.match(/FROM information_schema\.tables/g) ?? []).length,
    scoped.length,
    "one table guard per scoped table",
  );
  assert.doesNotMatch(coverageBody, /FROM pg_tables/, "ask information_schema, as the sibling migrations do");

  // Dollar-quoting must balance or the whole script is one syntax error, and the
  // statement splitter is dollar-quote aware precisely because of these blocks.
  assert.equal((coverageBody.match(/DO \$\$/g) ?? []).length, scoped.length);
  assert.equal((coverageBody.match(/END \$\$;/g) ?? []).length, scoped.length);
  assert.equal((coverageBody.match(/END IF;/g) ?? []).length, scoped.length);
  assert.doesNotMatch(coverageBody, /EXECUTE /, "no dynamic SQL");
  assert.doesNotMatch(coverageBody, /\$[a-z]+\$/, "no nested dollar-quoting");

  // Every backfill re-runnable: a second pass must find nothing left to claim.
  const updates = coverageBody.match(/UPDATE "[A-Za-z]+" SET "tenantId"[\s\S]*?;/g) ?? [];
  assert.equal(updates.length, scoped.length, "one backfill per scoped table");
  for (const u of updates) {
    assert.match(u, /WHERE "tenantId" IS NULL/, `backfill must be idempotent: ${u.slice(0, 60)}`);
    // Never invent an owner. On a database whose founding tenant row is absent
    // the backfill must claim nothing rather than write a dangling id.
    assert.match(u, /EXISTS \(SELECT 1 FROM "Tenant" WHERE "id" = 'tenant_denago_cpt'\)/, "backfill must verify the tenant exists");
  }
});

test("the coverage migration never tightens a column it just added", () => {
  // The rule that keeps a deploy from failing half way: two of these tables hold
  // rows, and NOT NULL in the same migration that adds the column to a populated
  // table is the classic way an additive change becomes an outage. Tightening
  // belongs with the enforcement flip, after the two-tenant harness is green.
  assert.doesNotMatch(coverageBody, /SET NOT NULL/i, "no NOT NULL in the migration that adds the column");
  assert.doesNotMatch(coverageBody, /ADD COLUMN[^;]*NOT NULL/i, "columns must be added nullable");
  // Additive only in the destructive sense: it may backfill, it may not delete.
  assert.doesNotMatch(coverageBody, /\b(DROP TABLE|TRUNCATE|DELETE FROM)\b/i, "nothing destructive");
});
