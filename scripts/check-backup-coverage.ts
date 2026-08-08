/**
 * DOES THE BACKUP CONTAIN EVERY TABLE AND EVERY COLUMN?
 *
 * The exporter used to walk Prisma's model list and call each delegate's ordinary
 * `findMany()`, which returns only DECLARED fields. Measured against production on
 * 2026-08-08, that silently omitted 68 columns and 19 whole tables — Lead's
 * pipeline and forecast fields, twelve StockUnit fields including the PDI
 * checklist and warranty dates, nine PurchaseOrder cost and date fields,
 * User.disabledAt, and StockLocation / StockMovement / StockAttachment entirely.
 *
 * Nothing failed and nothing warned. A column Prisma does not know about is a
 * column nothing in the application ever looks for in the output, so the backup
 * was wrong in the one direction nobody checks: quietly.
 *
 * The exporter now reads the table list from the DATABASE and selects every
 * column. This is the check that keeps it that way. It compares what the database
 * has against what the export plan covers, and FAILS when anything is outside it.
 *
 * Read-only — information_schema only. Safe against production, which is where
 * the drift lives, and it runs in CI against the migrated schema so a table added
 * by a migration is covered on the day the migration lands.
 */
import { basePrisma } from "../src/lib/db";
import { backupTableNames } from "../src/lib/backup";

type Column = { table_name: string; column_name: string };

async function main() {
  const covered = new Set(await backupTableNames());

  const tables = await basePrisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name
  `;
  const columns = await basePrisma.$queryRaw<Column[]>`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position
  `;

  // A table is either in the plan or deliberately excluded. `backupTableNames`
  // owns that decision and states a reason for every exclusion, so anything it
  // leaves out that is not in EXCLUDED_TABLES cannot exist — but the assertion is
  // here rather than assumed, because the plan is code and code changes.
  const EXPECTED_EXCLUSIONS = new Set(["_prisma_migrations"]);
  const uncovered = tables
    .map((row) => row.table_name)
    .filter((table) => !covered.has(table) && !EXPECTED_EXCLUSIONS.has(table));

  const byTable = new Map<string, number>();
  for (const { table_name: table } of columns) {
    byTable.set(table, (byTable.get(table) ?? 0) + 1);
  }
  const coveredColumns = [...covered].reduce((sum, table) => sum + (byTable.get(table) ?? 0), 0);

  console.log(`Database has ${tables.length} tables and ${columns.length} columns in "public".`);
  console.log(`  covered by the backup : ${covered.size} tables, ${coveredColumns} columns`);
  console.log(`  deliberately excluded : ${[...EXPECTED_EXCLUSIONS].join(", ")}`);

  // SELECT * means per-column coverage follows from table coverage. That is the
  // whole point of the change, and it is worth saying plainly: if a table is in
  // the plan, every column it has is in the backup, today and after the next
  // migration adds one.
  if (uncovered.length === 0) {
    console.log("\nEvery table is in the backup, and SELECT * covers every column in it.");
    return;
  }

  console.error(`\n✖ ${uncovered.length} table(s) exist in the database and would NOT be backed up:\n`);
  for (const table of uncovered) {
    console.error(`  ${table}   (${byTable.get(table) ?? 0} columns, ${0} of them exported)`);
  }
  console.error(
    `\nbackupTableNames() reads information_schema, so a table can only be missing\n` +
      `here if it was explicitly excluded. Add it, or give it an entry in\n` +
      `EXCLUDED_TABLES in src/lib/backup.ts with the reason it may be lost.\n`,
  );
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => basePrisma.$disconnect());
