import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * ERRORLOG HAD NO RETENTION AT ALL, and it is the one table whose growth is
 * driven by things going wrong.
 *
 * Measured on production 2026-08-13: 1,190 rows, 1.9 MB — the LARGEST table in
 * the database, ahead of every business table, because each row carries a stack
 * trace. Oldest row 2026-07-15, so ~40 a day and nothing had ever been removed
 * except by an owner pressing "clear" in Settings → System.
 *
 * The only automatic deletion that existed was `clearErrorLog` in actions/ai.ts,
 * which is manual, and scoped to ONE tenant — so the rows a sweep most needs to
 * reach (`tenantId` null: errors raised before any tenant is known) were the ones
 * nothing could ever remove.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

const SOURCE = read("src/lib/errorLog.ts");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CRON = read("src/app/api/cron/backup/route.ts")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `could not find ${name} — this test would pass vacuously`);
  const open = source.indexOf("{", start);
  const end = source.indexOf("\n}", open);
  assert.notEqual(end, -1, `could not slice the body of ${name}`);
  return source.slice(open, end);
}

test("the retention window is a real, bounded number of days", () => {
  // Read from source rather than imported: errorLog.ts reaches `server-only`
  // through actingTenant.ts, which cannot resolve outside a Next build. Every
  // sibling test in this repo is a source assertion for the same reason.
  const declared = CODE.match(/export const ERROR_LOG_RETENTION_DAYS\s*=\s*(\d+)/);
  assert.ok(declared, "ERROR_LOG_RETENTION_DAYS must be exported as a literal number of days");
  const ERROR_LOG_RETENTION_DAYS = Number(declared[1]);
  assert.ok(
    ERROR_LOG_RETENTION_DAYS >= 30,
    "shorter than a month would delete the history a recurring fault is diagnosed from",
  );
  assert.ok(
    ERROR_LOG_RETENTION_DAYS <= 365,
    "a year of stack traces is an archive, not a log — the table is already the biggest one",
  );
});

test("the prune is NOT tenant-scoped", () => {
  const body = bodyOf(CODE, "pruneErrorLog");
  assert.doesNotMatch(
    body,
    /tenantId/,
    "ErrorLog is a GLOBAL model because errors happen where no tenant is known. A " +
      "per-tenant sweep would never reach the tenantId-null rows, so those — and only " +
      "those — would accumulate forever.",
  );
});

test("each delete re-asserts the cutoff instead of trusting the scan", () => {
  const body = bodyOf(CODE, "pruneErrorLog");
  // Same guarded-delete rule purgeTrash follows: a row must still qualify at the
  // moment it is removed, not merely when it was listed.
  assert.match(
    body,
    /deleteMany\(\{[\s\S]*?where:\s*\{[\s\S]*?id:\s*\{\s*in:[\s\S]*?createdAt:\s*\{\s*lt:\s*cutoff/,
    "the DELETE must carry `createdAt: { lt: cutoff }` alongside the id list",
  );
});

test("the sweep is bounded in both directions", () => {
  const body = bodyOf(CODE, "pruneErrorLog");
  assert.match(body, /take:\s*PRUNE_BATCH/, "batched, so one sweep cannot build an unbounded DELETE");
  assert.match(body, /batch < PRUNE_MAX_BATCHES/, "capped, so a sweep cannot run forever");
  // A scan that finds rows while the delete matches none would spin to the cap.
  assert.match(body, /if \(count === 0\) break;/, "stop on the first pass that removes nothing");
});

test("pruning is gated on a clean backup, exactly as the trash purge is", () => {
  // The gate matters MORE here than for Trash. If the backup run is degraded, the
  // System Log is the first thing anyone reads to find out why — pruning it on
  // that run would delete the evidence at the moment it became useful.
  assert.match(
    CRON,
    /const prunedErrorLog = degradedAssets\.length === 0\s*\?\s*await pruneErrorLog\(\)/,
    "pruneErrorLog must ride the same degradedAssets gate as purgeTrash",
  );
  assert.match(CRON, /import \{ pruneErrorLog \} from "@\/lib\/errorLog"/);
  // Reported, so a sweep that silently stops working is visible in Settings.
  assert.match(CRON, /\bprunedErrorLog,/, "the count belongs in the recorded result");
});

test("logError still cannot throw — retention must not have changed that", () => {
  const body = bodyOf(CODE, "logError");
  assert.match(body, /catch\s*\{/, "the error logger must never become the error");
});
