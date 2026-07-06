/**
 * Local backup: exports the entire database to backups/denagocrm-YYYY-MM-DD.json
 * and prunes local backups older than 60 days.
 *
 *   npx tsx scripts/backup.ts
 */
import * as fs from "fs";
import * as path from "path";
import { exportAllData } from "../src/lib/backup";

const DIR = path.join(process.cwd(), "backups");
const KEEP_DAYS = 60;

async function main() {
  const data = await exportAllData();
  fs.mkdirSync(DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(DIR, `denagocrm-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));

  const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  let pruned = 0;
  for (const f of fs.readdirSync(DIR)) {
    const p = path.join(DIR, f);
    if (f.startsWith("denagocrm-") && fs.statSync(p).mtimeMs < cutoff) {
      fs.unlinkSync(p);
      pruned++;
    }
  }
  console.log(`Backup written: ${file} (${(fs.statSync(file).size / 1024).toFixed(1)} KB, pruned ${pruned} old)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
