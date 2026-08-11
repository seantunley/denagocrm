/**
 * Provision + migrate the harness database, then exit. Useful on its own:
 *   npm run harness:provision
 * The first run pays for 190 migrations; every later run reuses the data
 * directory and is near-instant.
 */
import { provisionHarnessDatabase, migrateHarnessDatabase } from "./testDatabase";

async function main() {
  const db = await provisionHarnessDatabase();
  if ("skipped" in db) {
    console.log(db.reason);
    process.exit(0);
  }
  console.log(`provisioned: ${db.describe}`);
  const started = Date.now();
  await migrateHarnessDatabase(db.url, (m) => console.log(m));
  console.log(`ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`URL: ${db.url}`);
  await db.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
