/**
 * DOES THE BACKUP ACTUALLY CONTAIN EVERY COLUMN?
 *
 * `exportAllModels` walks Prisma's DMMF and calls each model's ordinary
 * `findMany()`. That returns only the fields Prisma DECLARES — so a column that
 * exists in the database and not in the schema is silently absent from every
 * backup. Four signing tables use `SELECT *` and are complete; the other ~170 are
 * complete only as long as the schema matches the database.
 *
 * The unit test could never see this: it hands a hand-built object to the
 * serialiser, so it proves the serialiser carries unknown keys and nothing about
 * what was retrieved. Review caught exactly that, and the honest fix is to ask
 * the database instead of asserting a contract the exporter does not provide.
 *
 * Not hypothetical. `BackupRun.tenantId` exists in production and not in the
 * schema — documented in 20260806180000_rls_enforce_gap — so it is missing from
 * the export right now. This is the check that reports it.
 *
 * Read-only: information_schema and Prisma's DMMF. Safe against any database,
 * including production, which is the point — the drift only exists there.
 *
 * Exits non-zero when a column would be lost, because a backup that quietly omits
 * a column is worse than a backup that fails: one of them you find out about.
 */
import { Prisma } from "@prisma/client";
import { basePrisma } from "../src/lib/db";

/** Tables the exporter reads with SELECT *, so every column is captured. */
const RAW_SELECT_TABLES = new Set([
  "SigningJob",
  "SigningIdentityChallenge",
  "LegalArtifact",
  "LegalArtifactValidation",
]);

/**
 * Columns known to be absent from the export and accepted as such. Each needs a
 * reason that survives being read in a year — the alternative to a justified
 * exclusion is a quietly widened check.
 */
const ACCEPTED: Record<string, string> = {
  // Nothing accepted yet. BackupRun.tenantId is deliberately NOT listed: it is a
  // real gap and should be resolved by adding the field to the model (or dropping
  // the column), not by excusing it here.
};

type Row = { table_name: string; column_name: string };

async function main() {
  const modelFields = new Map<string, Set<string>>();
  const tableToModel = new Map<string, string>();
  for (const model of Prisma.dmmf.datamodel.models) {
    const table = model.dbName ?? model.name;
    tableToModel.set(table, model.name);
    modelFields.set(
      table,
      // Scalar and enum fields only. A relation is not a column, and counting one
      // would mask a missing scalar of the same name.
      new Set(
        model.fields
          .filter((field) => field.kind === "scalar" || field.kind === "enum")
          .map((field) => field.dbName ?? field.name),
      ),
    );
  }

  const columns = await basePrisma.$queryRaw<Row[]>`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position
  `;

  const missing: Array<{ table: string; column: string }> = [];
  const orphanTables = new Set<string>();
  for (const { table_name: table, column_name: column } of columns) {
    if (table.startsWith("_prisma")) continue;
    if (RAW_SELECT_TABLES.has(table)) continue;
    const fields = modelFields.get(table);
    if (!fields) {
      // A table in no Prisma model is invisible to the exporter ENTIRELY, not just
      // one of its columns. Reported separately because the fix differs.
      orphanTables.add(table);
      continue;
    }
    if (fields.has(column)) continue;
    if (ACCEPTED[`${table}.${column}`]) continue;
    missing.push({ table, column });
  }

  console.log(`Checked ${columns.length} columns across ${modelFields.size} Prisma-mapped tables.`);
  console.log(`  read with SELECT * (always complete): ${RAW_SELECT_TABLES.size}`);

  if (orphanTables.size > 0) {
    console.log(`\n${orphanTables.size} table(s) exist in the database and in NO Prisma model.`);
    console.log("  The exporter never reads these at all:");
    for (const table of [...orphanTables].sort()) console.log(`    ${table}`);
    console.log("  Either add a model, or drop the table — the audit already lists five of these.");
  }

  if (missing.length === 0) {
    console.log("\nEvery database column is reachable by the backup exporter.");
    return;
  }

  console.error(`\n✖ ${missing.length} column(s) exist in the database and would NOT be backed up:\n`);
  for (const { table, column } of missing) {
    console.error(`  ${table}.${column}   (model ${tableToModel.get(table)} does not declare it)`);
  }
  console.error(
    `\nexportAllModels uses findMany(), which returns only declared fields. Add the\n` +
      `field to the Prisma model, drop the column, or — if it is genuinely disposable —\n` +
      `list it in ACCEPTED in this script with the reason.\n`,
  );
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => basePrisma.$disconnect());
