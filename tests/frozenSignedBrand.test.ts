import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { frozenBrand, parseFrozenBrand } from "../src/lib/signing/frozenBrand";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const PROFILE = {
  name: "Acme Golf Carts",
  tagline: "Fleet sales & service",
  address: "1 Fairway Road, Somerset West",
  phone: "021 555 0100",
  email: "accounts@acmegolf.co.za",
  website: "acmegolf.co.za",
  facebook: "",
  instagram: "@acmegolf",
  logoUrl: "https://app.example.com/api/brand/logo/t1?v=abc",
};

/**
 * SIGNED AND SEALED DOCUMENTS MUST NOT CHANGE.
 *
 * `SignatureRequest.snapshotJson` already freezes the DOCUMENT a signature is
 * evidence of, so that editing a template cannot retroactively change what a
 * customer agreed to. `brandJson` freezes who that document says it is FROM, at
 * the same moment and for the same reason.
 *
 * The sealed PDF was never the thing at risk: it is bytes in blob storage with a
 * sha-256 beside it. What was at risk is every RE-RENDER of the snapshot — the
 * print view of a signed quote, the signing-hub preview, a regenerated copy.
 * Those resolved {{company.*}} live, so a rebrand would have shown a different
 * company's name and logo above the same clauses and the same signatures, and
 * the views would have disagreed with the sealed artifact they depict.
 */

test("the brand is captured from the same profile the document text is frozen from", () => {
  // ONE lookup, used twice. Two could disagree, and the second is what the
  // document would claim about itself for the rest of its life.
  const code = shipped("src/lib/signing/service.ts");
  assert.match(code, /const profile = await getCompanyProfile\(\);/);
  assert.match(code, /const brand = frozenBrand\(profile\);/);
  assert.match(code, /\.\.\.companyTokens\(profile\),/, "the frozen TEXT uses the same profile");
  assert.match(code, /brandJson: brand as object,/, "…and it is stored on the request");
  assert.equal(
    (code.match(/getCompanyProfile\(\)/g) ?? []).length,
    1,
    "exactly one resolution — a second could differ from the first",
  );
});

test("a frozen brand carries the tokens and the logo", () => {
  const brand = frozenBrand(PROFILE);
  assert.equal(brand.tokens["company.name"], "Acme Golf Carts");
  assert.equal(brand.tokens["company.address"], "1 Fairway Road, Somerset West");
  assert.equal(brand.logoUrl, PROFILE.logoUrl);
});

test("a blank logo freezes as null, not as an empty string", () => {
  // Null means "use the built-in asset". An empty string would render a broken
  // image on a document that is supposed to be permanent.
  assert.equal(frozenBrand({ ...PROFILE, logoUrl: "" }).logoUrl, null);
  assert.equal(frozenBrand({ ...PROFILE, logoUrl: "   " }).logoUrl, null);
});

test("the frozen brand round-trips through JSON", () => {
  // It is stored in a JSONB column and read back as `unknown`.
  const stored = JSON.parse(JSON.stringify(frozenBrand(PROFILE)));
  const parsed = parseFrozenBrand(stored);
  assert.deepEqual(parsed, frozenBrand(PROFILE));
});

test("anything that is not a brand we wrote falls back to resolving live", () => {
  // Every request predating this column reads null, and so does a legacy or
  // corrupted shape. Null means "resolve live", which is what those rows have
  // always done — so a bad value degrades to today's behaviour, never to a
  // document with every {{company.*}} placeholder blank.
  for (const bad of [
    null,
    undefined,
    {},
    { tokens: null },
    { tokens: "nope" },
    { tokens: {} }, // an empty token set is not a brand
    { logoUrl: "https://x/y.png" }, // logo without tokens
    "a string",
    42,
    [],
  ]) {
    assert.equal(parseFrozenBrand(bad), null, `${JSON.stringify(bad)} must not parse as a brand`);
  }
});

test("non-string token values are dropped rather than rendered", () => {
  const parsed = parseFrozenBrand({
    tokens: { "company.name": "Acme", "company.phone": 12345, "company.email": null },
    logoUrl: null,
  });
  assert.deepEqual(parsed?.tokens, { "company.name": "Acme" });
});

test("the frozen brand WINS over the live profile at render time", () => {
  const code = shipped("src/lib/signing/render.ts");
  assert.match(
    code,
    /const company = frozen \? frozen\.tokens : companyTokens\(await getCompanyProfile\(\)\);/,
    "frozen first, live only as the fallback",
  );
  assert.match(code, /frozen\?: FrozenBrand \| null/, "and it is optional, so unfrozen rows are unchanged");
});

test("every renderer of a frozen document reads the frozen brand", () => {
  // Both the signer's own view and the printed copy. If one took the live brand
  // they would disagree with each other as well as with the sealed PDF.
  const code = shipped("src/lib/signing/render.ts");
  for (const fn of ["renderRequestDocHtml", "renderRequestSigningSheets"]) {
    const start = code.indexOf(`export async function ${fn}(`);
    assert.notEqual(start, -1, `${fn} is gone — was it renamed?`);
    const body = code.slice(start, code.indexOf("\n}", start));
    assert.match(body, /parseFrozenBrand\(req\.brandJson\)/, `${fn} must read the frozen brand`);
    assert.match(body, /bindCtx\(req\.quoteId, req\.jobCardId, frozen\)/, `${fn} must bind it`);
    assert.match(body, /frozen\?\.logoUrl \?\? logoDataUri\(\)/, `${fn} must use the frozen logo`);
    assert.match(body, /"brandJson"/, `${fn} must select the column it reads`);
  }
});

test("the signed quote's print view binds the frozen brand, not the current one", () => {
  // The ordering here is load-bearing: the context carries the {{company.*}}
  // tokens, so binding it BEFORE the request is looked up made a signed quote
  // print the workspace's current name above signatures given to its old one.
  const code = shipped("src/lib/quotePrintDocument.ts");
  const requestAt = code.indexOf("const request = await prisma.signatureRequest.findFirst");
  const bindAt = code.indexOf("const ctx = await bindCtx(");
  assert.ok(requestAt !== -1 && bindAt !== -1);
  assert.ok(requestAt < bindAt, "the request must be resolved BEFORE the context is bound");
  assert.match(code, /brandJson: true/, "…and the column must be selected");
  assert.match(code, /bindCtx\(opts\.quoteId, null, frozen\)/);
  assert.match(code, /renderDocumentHtml\(signedDoc, ctx, frozen\?\.logoUrl \?\? logoDataUri\(\)/);
});

test("the migration is one nullable column and nothing else", () => {
  const sql = read("prisma/migrations/20260806160000_signature_request_brand/migration.sql");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "brandJson" JSONB;/);
  assert.doesNotMatch(sql, /\bDROP\b|\bALTER COLUMN\b|\bSET NOT NULL\b|\bUPDATE\b/i);
  // No backfill on purpose: an existing signed request has no record of what the
  // brand was when it was signed, and inventing one from today's profile would
  // be asserting something we do not know.
  assert.doesNotMatch(sql, /INSERT|backfill/i);
});
