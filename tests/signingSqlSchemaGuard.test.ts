import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

const SQL_MANAGED_SIGNING_TABLES = [
  "SigningUploadIntent",
  "SigningArtifact",
  "LegalArtifact",
  "SigningOutboxJob",
  "SigningDelivery",
  "SigningIdentityChallenge",
  "SigningEvidenceAnchor",
  "LegalArtifactDestructionRequest",
  "SigningRecoveryAction",
] as const;

async function migrationSql(): Promise<Array<{ name: string; sql: string }>> {
  const root = path.join(process.cwd(), "prisma", "migrations");
  const entries = await fs.readdir(root, { withFileTypes: true });
  const migrations: Array<{ name: string; sql: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "migration.sql");
    const sql = await fs.readFile(file, "utf8").catch(() => "");
    migrations.push({ name: entry.name, sql });
  }
  return migrations;
}

test("SQL-managed signing trust tables are present and cannot be dropped by schema drift", async () => {
  const migrations = await migrationSql();
  const allSql = migrations.map((migration) => migration.sql).join("\n");

  for (const table of SQL_MANAGED_SIGNING_TABLES) {
    assert.match(
      allSql,
      new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+"${table}"`, "i"),
      `${table} must remain declared by the signing security migrations`,
    );

    for (const migration of migrations) {
      assert.doesNotMatch(
        migration.sql,
        new RegExp(`DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+"${table}"`, "i"),
        `${migration.name} attempts to drop SQL-managed signing trust table ${table}`,
      );
    }
  }
});
