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
  // A NEW quote has no prior owner, so the actor owns the parent — and the
  // children take the SAME value, which is still parent-owns-child.
  assert.match(source, /items: itemRows\.length > 0 \? \{ create: itemRows\.map\(\(row\) => \(\{ \.\.\.row, tenantId: actingTenant \}\)\) \}/);
  assert.match(source, /fees: feeRows\.length > 0 \? \{ create: feeRows\.map\(\(row\) => \(\{ \.\.\.row, tenantId: actingTenant \}\)\) \}/);
  // An EXISTING quote's replacement rows take the QUOTE's owner — see below.
  assert.match(source, /tx\.quoteItem\.createMany\(\{ data: itemRows\.map\(\(row\) => \(\{ \.\.\.row, quoteId: existing\.id, tenantId: quoteTenantId \}\)\) \}\)/);
  assert.match(source, /tx\.quoteFee\.createMany\(\{ data: feeRows\.map\(\(row\) => \(\{ \.\.\.row, quoteId: existing\.id, tenantId: quoteTenantId \}\)\) \}\)/);
});

test("an existing quote's children inherit the QUOTE's owner, not the editor's", () => {
  /*
   * saveQuoteDraft resolves the acting tenant BEFORE the transaction. That is
   * the right owner for a quote it is about to create, and the WRONG one for a
   * quote that already exists: the Quote is the parent, so its replacement
   * items and fees must inherit ITS tenant — the same ownership invariant
   * createQuoteRevision applies when it copies a quote.
   *
   * Stamping the actor instead splits one quote across two workspaces whenever
   * the editor's acting tenant differs from the quote's. This runs inside a
   * `basePrisma` transaction — the documented RLS BYPASS — so there is no guard
   * downstream to notice a parent and child disagreeing about who owns them.
   *
   * The acting tenant survives only as the fallback for a pre-tenancy quote,
   * exactly as in the revision path.
   */
  const source = src(QUOTES);
  assert.match(source, /const quoteTenantId = existing\.tenantId \?\? actingTenant;/);

  // The edit path's child writes, from the derivation to the re-read that ends it.
  const editChildren = source.slice(
    source.indexOf("const quoteTenantId ="),
    source.indexOf("tx.quote.findUniqueOrThrow"),
  );
  assert.ok(editChildren.length > 0, "the edit path's child writes must be locatable");
  assert.doesNotMatch(
    editChildren,
    /tenantId: actingTenant/,
    "a replacement item or fee is stamped with the EDITOR instead of the quote",
  );
  assert.equal(
    (editChildren.match(/tenantId: quoteTenantId/g) ?? []).length,
    2,
    "both the items and the fees must inherit the quote's owner",
  );
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

/**
 * saveQuoteDraft's edit path is the busiest write in this file and was the one
 * left out when P0-2 was first fixed: it locked and rewrote an existing quote by
 * a bare `id`, on `basePrisma`. `requireQuoteAccess` authorised the id, but its
 * `activeTenantPredicate()` is `{}` while dormant, so it said nothing about
 * ownership. Driven live, workspace A rewrote workspace B's terms and wrote a
 * QuoteItem into B's quote stamped with B's own tenant, so the row read as an
 * ordinary one of theirs — the harness's Quote OWN probe was passing for the
 * wrong reason until this landed. The real proof is the two-tenant harness
 * (scripts/harness/, Quote FORGERY); this pins the source shape alongside it.
 */
test("editing a quote is scoped on the lock, the read, and the write — all three", () => {
  const source = src(QUOTES);
  const start = source.indexOf("export async function saveQuoteDraft");
  const end = source.indexOf("\nexport async function", start + 1);
  const fn = source.slice(start, end === -1 ? undefined : end);

  assert.match(
    fn,
    /SELECT id FROM "Quote" WHERE id = \$\{data\.id\} AND "tenantId" = \$\{actingTenant\} FOR UPDATE/,
    "the row lock must carry the tenant predicate, not just the id"
  );
  assert.match(
    fn,
    /tx\.quote\.findFirst\(\{\s*where: \{ id: data\.id, tenantId: actingTenant \}/,
    "the re-read inside the transaction must be tenant-filtered — findUnique cannot be"
  );
  assert.match(
    fn,
    /tx\.quote\.updateMany\(\{\s*where: \{ id: existing\.id, tenantId: actingTenant \}/,
    "the rewrite must be an updateMany scoped by tenant, not update() by bare id"
  );
  assert.match(
    fn,
    /if \(updated\.count !== 1\) return null;/,
    "a zero-row match (foreign quote) must refuse, not silently proceed"
  );
});
