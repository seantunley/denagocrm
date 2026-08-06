import { Prisma } from "@prisma/client";
import { basePrisma } from "../src/lib/db";
import { readFile } from "../src/lib/storage";
import crypto from "node:crypto";

async function main() {
  const rows = await basePrisma.$queryRaw<Array<{ id: string; objectRef: string; sha256: string; timestampTokenRef: string | null }>>(Prisma.sql`
    SELECT id,"objectRef",sha256,"timestampTokenRef" FROM "LegalArtifact" WHERE "destroyedAt" IS NULL ORDER BY "createdAt" DESC
  `);
  const failures: string[] = [];
  for (const row of rows) {
    try {
      const pdf = await readFile(row.objectRef);
      const digest = crypto.createHash("sha256").update(pdf).digest("hex");
      if (digest !== row.sha256) failures.push(`${row.id}: PDF hash mismatch`);
      if (row.timestampTokenRef) await readFile(row.timestampTokenRef);
    } catch (error) {
      failures.push(`${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const event = await basePrisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM "SignatureEvent" ORDER BY "createdAt" DESC LIMIT 1
  `);
  if (event[0]) {
    const mutationBlocked = await basePrisma
      .$executeRaw(Prisma.sql`UPDATE "SignatureEvent" SET actor = actor WHERE id = ${event[0].id}`)
      .then(() => false)
      .catch(() => true);
    if (!mutationBlocked) failures.push("SignatureEvent immutability trigger did not reject an UPDATE");
  } else {
    console.warn("No SignatureEvent row exists, so the append-only trigger could not be exercised.");
  }
  console.log(JSON.stringify({ artifacts: rows.length, failures }, null, 2));
  if (failures.length) process.exitCode = 2;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
