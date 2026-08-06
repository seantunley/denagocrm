/**
 * The upgrade test: a database that ALREADY HAS SIGNING DATA, then migrated.
 *
 * Every signing blocker in this branch survived review, a full unit suite and a
 * green CI run for the same reason — CI applies migrations to a completely empty
 * PostgreSQL, and its own comment says so. An empty database cannot show you:
 *
 *   - a backfill that skips rows another migration already populated, and then
 *     fails at SET NOT NULL (there were no rows to skip);
 *   - a terminal-status trigger whose write is refused by a later guard, rolling
 *     back every completion (nothing was ever completed);
 *   - an approval insert refused by that same guard (none were created).
 *
 * So this seeds the state a real upgrade meets, applies the migrations in the
 * same numeric order the deploy uses, and then exercises the transitions that
 * only happen at runtime.
 *
 * Run against a SCRATCH database. It writes freely and drops nothing.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const MIGRATIONS = path.join(process.cwd(), "prisma", "migrations");

/** Numeric order — the same rule the deploy runner uses, not lexical. */
function migrationsInOrder(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => existsSync(path.join(MIGRATIONS, name, "migration.sql")))
    .sort((a, b) => {
      const na = Number(a.split("_")[0]);
      const nb = Number(b.split("_")[0]);
      return na === nb ? a.localeCompare(b) : na - nb;
    });
}

function applyMigration(name: string): void {
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["prisma", "db", "execute", "--schema", "./prisma", "--file", `prisma/migrations/${name}/migration.sql`],
    { stdio: "inherit" },
  );
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  const all = migrationsInOrder();
  // Everything before the signing trust work. The seeded rows must exist BEFORE
  // those migrations run — that is the entire point of this script.
  const firstSigning = all.findIndex((name) => name.includes("signing_trust_platform"));
  if (firstSigning < 0) throw new Error("could not locate the signing trust migrations");

  console.log(`\n== applying ${firstSigning} migrations (pre-signing baseline)`);
  for (const name of all.slice(0, firstSigning)) applyMigration(name);

  console.log("\n== seeding signing data that predates the upgrade");
  const tenantId = "t_upgrade";
  const requestId = "sr_upgrade";
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Tenant"(id,name,slug,active) VALUES ($1,'Upgrade Co','upgrade-co',true) ON CONFLICT (id) DO NOTHING`,
    tenantId,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "SignatureRequest"(id,"tenantId",title,status,ordering,"createdAt","updatedAt")
     VALUES ($1,$2,'Historic contract','sent','parallel',now(),now()) ON CONFLICT (id) DO NOTHING`,
    requestId, tenantId,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "SignatureRecipient"(id,"tenantId","requestId",name,email,token,status,"order",color)
     VALUES ('rec_upgrade',$1,$2,'A Signer','signer@example.com',$3,'sent',0,'#2563eb')
     ON CONFLICT (id) DO NOTHING`,
    tenantId, requestId,
    // A LEGACY PLAINTEXT token, 56 hex — exactly what production holds today.
    "a".repeat(56),
  );
  // Several events, so the chain backfill has real history to walk.
  for (let index = 0; index < 5; index += 1) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "SignatureEvent"(id,"tenantId","requestId",type,actor,"createdAt")
       VALUES ($1,$2,$3,$4,'system',now() + ($5 || ' seconds')::interval) ON CONFLICT (id) DO NOTHING`,
      `sev_upgrade_${index}`, tenantId, requestId, index === 0 ? "created" : "sent", String(index),
    );
  }
  const seeded = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT count(*)::bigint AS count FROM "SignatureEvent" WHERE "requestId" = $1`, requestId,
  );
  check("seeded events exist before migrating", Number(seeded[0].count) === 5);

  console.log("\n== applying the signing migrations onto populated data");
  for (const name of all.slice(firstSigning)) applyMigration(name);

  console.log("\n== the upgrade itself");
  const chain = await prisma.$queryRawUnsafe<Array<{
    id: string; sequence: number; prevHash: string; payloadHash: string; eventHash: string;
  }>>(
    `SELECT id,"sequence","prevHash","payloadHash","eventHash" FROM "SignatureEvent"
      WHERE "requestId" = $1 ORDER BY "sequence"`, requestId,
  );
  check("every historic event was backfilled", chain.length === 5);
  check("payloadHash is populated on every row", chain.every((row) => /^[0-9a-f]{64}$/.test(row.payloadHash)));

  const { signEventLinkHash, EVIDENCE_CHAIN_ROOT } = await import("../src/lib/signing/evidenceHash");
  let prev = EVIDENCE_CHAIN_ROOT;
  let linked = true;
  for (const [index, row] of chain.entries()) {
    if (row.sequence !== index + 1 || row.prevHash !== prev) linked = false;
    if (signEventLinkHash(row.prevHash, row.payloadHash) !== row.eventHash) linked = false;
    prev = row.eventHash;
  }
  check("the backfilled chain links end to end", linked);

  const tokens = await prisma.$queryRawUnsafe<Array<{ token: string }>>(
    `SELECT token FROM "SignatureRecipient" WHERE "requestId" = $1`, requestId,
  );
  check("the legacy plaintext token was converted to a digest", /^[0-9a-f]{64}$/.test(tokens[0]?.token ?? ""));

  console.log("\n== runtime transitions the empty-database run never reaches");
  let completed = true;
  try {
    // THE BLOCKER: the terminal-status trigger used to rewrite the token into a
    // value the storage guard refuses, rolling the whole transition back.
    await prisma.$executeRawUnsafe(
      `UPDATE "SignatureRequest" SET status='completed', "completedAt"=now() WHERE id = $1`, requestId,
    );
  } catch (error) {
    completed = false;
    check("completing a request does not roll back", false, String(error).slice(0, 200));
  }
  if (completed) check("completing a request does not roll back", true);

  const revoked = await prisma.$queryRawUnsafe<Array<{ token: string; tokenRevokedAt: Date | null }>>(
    `SELECT token,"tokenRevokedAt" FROM "SignatureRecipient" WHERE "requestId" = $1`, requestId,
  );
  check("completion marked the capability revoked", revoked[0]?.tokenRevokedAt !== null);
  check("…without corrupting the stored digest", /^[0-9a-f]{64}$/.test(revoked[0]?.token ?? ""));

  // THE OTHER BLOCKER: a decision approval must be insertable.
  let approvalOk = true;
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ApprovalStep"(id,"tenantId","requestId","nodeId",label,mode,"assigneeType",token,status,"order","createdAt")
       VALUES ('ap_upgrade',$1,$2,'n1','Approve','decision','owner',$3,'pending',0,now())`,
      tenantId, requestId, "b".repeat(64),
    );
  } catch (error) {
    approvalOk = false;
    check("a decision approval can be created", false, String(error).slice(0, 200));
  }
  if (approvalOk) check("a decision approval can be created", true);

  console.log("\n== the guards still refuse what they should");
  let rejected = false;
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "SignatureRecipient" SET token = 'plaintext-not-a-digest' WHERE "requestId" = $1`, requestId,
    );
  } catch { rejected = true; }
  check("a raw capability is refused by the database", rejected);

  let immutable = false;
  try {
    await prisma.$executeRawUnsafe(`UPDATE "SignatureEvent" SET actor='tampered' WHERE id='sev_upgrade_0'`);
  } catch { immutable = true; }
  check("evidence cannot be edited", immutable);

  console.log(failures === 0 ? "\nAll upgrade checks passed.\n" : `\n${failures} upgrade check(s) FAILED.\n`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
