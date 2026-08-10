import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * Audit P0-2 and P0-3: quote and job-card creation authorise a scoped record,
 * then enter a `basePrisma` transaction for advisory-locked numbering — and
 * `basePrisma` is the documented RLS BYPASS. A tenant-scoped permission check
 * before a bypass transaction does NOT scope the transaction.
 *
 * So every row created inside carried no tenant. That is not a leak, it is worse:
 * a tenantless row is invisible to the workspace that created it the moment
 * enforcement is switched on, and its children are unowned too.
 *
 * Nested creates inherit nothing from the parent in Prisma, so items and fees
 * each need their own stamp.
 */

const QUOTES = "src/app/actions/quotes.ts";
const JOBCARDS = "src/app/actions/jobcards.ts";

/** Every `X.create(`/`createMany(` inside the file, with the object that follows. */
function creates(source: string, model: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(new RegExp(`tx\\.${model}\\.(?:create|createMany)\\(`, "g"))) {
    out.push(source.slice(m.index!, m.index! + 500));
  }
  return out;
}

test("every quote row created through the bypass client carries its owner", () => {
  const source = src(QUOTES);
  const quoteCreates = creates(source, "quote");
  assert.ok(quoteCreates.length >= 4, `expected the quote create paths, found ${quoteCreates.length}`);
  for (const block of quoteCreates) {
    assert.match(block, /\btenantId\b/, `a quote is created with no tenant:\n${block.slice(0, 160)}`);
  }
});

test("quote children are stamped too, because a nested create inherits nothing", () => {
  const source = src(QUOTES);
  // Line items and fees, whether created nested or rewritten by createMany.
  assert.match(source, /items: itemRows\.length > 0 \? \{ create: itemRows\.map\(\(row\) => \(\{ \.\.\.row, tenantId \}\)\) \}/);
  assert.match(source, /fees: feeRows\.length > 0 \? \{ create: feeRows\.map\(\(row\) => \(\{ \.\.\.row, tenantId \}\)\) \}/);
  assert.match(source, /tx\.quoteItem\.createMany\(\{ data: itemRows\.map\(\(row\) => \(\{ \.\.\.row, quoteId: existing\.id, tenantId \}\)\) \}\)/);
  assert.match(source, /tx\.quoteFee\.createMany\(\{ data: feeRows\.map\(\(row\) => \(\{ \.\.\.row, quoteId: existing\.id, tenantId \}\)\) \}\)/);
});

test("a revision belongs to whoever owned the original", () => {
  // Not to whoever is revising it. The acting workspace is only the fallback for
  // a row that predates tenancy.
  const source = src(QUOTES);
  assert.match(source, /const tenantId = original\.tenantId \?\? actingTenant;/);
  // The copied custom-field values ride along with it.
  assert.match(source, /cfValues\.map\(\(v\) => \(\{ defId: v\.defId, recordId: created\.id, value: v\.value, tenantId \}\)\)/);
});

test("every job-card row created through the bypass client carries its owner", () => {
  const source = src(JOBCARDS);
  for (const model of ["jobCard", "jobCardItem", "mileageLog"]) {
    const blocks = creates(source, model);
    assert.ok(blocks.length > 0, `expected ${model} creates`);
    for (const block of blocks) {
      assert.match(block, /\btenantId\b/, `a ${model} is created with no tenant:\n${block.slice(0, 160)}`);
    }
  }
});

test("stock cannot be claimed from another workspace's part", () => {
  // The job card's authorisation says nothing about a partId that arrived in the
  // same form post, and this runs on the bypass client — so a forged id locked,
  // counted and DECREMENTED another tenant's stock.
  const source = src(JOBCARDS);
  const fn = source.slice(source.indexOf("async function claimPartStock"), source.indexOf("export async function addJobCardItem"));

  assert.match(fn, /tenantId: string,/, "the claim must be told whose stock it may touch");
  // The predicate has to be on the lock, the read, the reservation total AND the
  // decrement. A filtered read in front of an unfiltered update is a race, not a
  // boundary.
  assert.match(fn, /FROM "Part" WHERE id = \$\{partId\} AND "deletedAt" IS NULL AND "tenantId" = \$\{tenantId\} FOR UPDATE/);
  assert.match(fn, /findFirst\(\{\s*where: \{ id: partId, deletedAt: null, tenantId \}/);
  assert.match(fn, /partReservation\.aggregate\(\{ where: \{ partId, status: "active", tenantId \}/);
  assert.match(fn, /updateMany\(\{\s*where: \{ id: partId, deletedAt: null, tenantId \}/);
  // updateMany reports how many rows it touched; update() would have thrown or
  // silently hit the wrong row.
  assert.match(fn, /if \(claimed\.count !== 1\) return \{ ok: false/);
});

test("restoring stock is guarded the same way as claiming it", () => {
  // A credit through a bare part id is the same defect with the sign flipped.
  const source = src(JOBCARDS);
  assert.match(source, /part\.updateMany\(\{ where: \{ id: owned\.partId, tenantId \}, data: \{ stockQty: \{ increment: inc \} \} \}\)/);
  assert.doesNotMatch(source, /part\.update\(\{ where: \{ id: reservation\.partId \}/, "an unguarded decrement by bare id");
});

test("the owner is resolved from the acting workspace, not the dormant scope", () => {
  // writeTenantId() is null while enforcement is dormant, so `?? DEFAULT_TENANT_ID`
  // would stamp the founding tenant onto every workspace's rows.
  for (const file of [QUOTES, JOBCARDS]) {
    const source = src(file);
    assert.match(source, /import \{ actingTenantId \} from "@\/lib\/actingTenant";/, `${file} resolves no owner`);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /writeTenantId\(\) \?\? DEFAULT_TENANT_ID/, `${file} uses the dormant fallback`);
  }
});
