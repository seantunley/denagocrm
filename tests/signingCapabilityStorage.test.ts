import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
/**
 * SQL with comments removed.
 *
 * Every "the code must NOT do X" assertion below is otherwise satisfied by a
 * comment explaining that the code no longer does X — which has now produced a
 * false failure twice, once here and once in the platform 2FA suite.
 */
const readSqlCode = (p: string) => read(p).replace(/^\s*--.*$/gm, "");

/** SQL migrations, which `walk` deliberately does not return. */
function walkSql(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(root, dir))) {
    const rel = path.join(dir, entry);
    if (statSync(path.join(root, rel)).isDirectory()) walkSql(rel, out);
    else if (entry.endsWith(".sql")) out.push(rel);
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(root, dir))) {
    const rel = path.join(dir, entry);
    if (statSync(path.join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(rel);
  }
  return out;
}

/**
 * A signing link is a bearer credential. These tests exist because the failure
 * they guard against is silent in every environment that matters for catching it:
 *
 * an earlier draft of this branch stored the ENCRYPTED capability in the column
 * the public routes queried by raw value. Encryption is a no-op when no key is
 * configured, so development and CI both passed while production — the only
 * place with a key — would have failed to resolve any newly created signing
 * link at all. Nobody could have opened a document sent after the deploy.
 *
 * So these assert the storage contract itself, not a behaviour downstream of it.
 */

test("a signing capability is stored as a digest, never in readable form", () => {
  const vault = read("src/lib/signing/tokenVault.ts");
  // The digest is the stored value; the ciphertext is a separate column kept
  // only so a reminder can repeat the same link.
  assert.match(vault, /digest:\s*hashSignToken\(raw\)/);
  assert.match(vault, /ciphertext:\s*encryptValue\(raw\)/);

  const service = read("src/lib/signing/service.ts");
  assert.match(service, /token:\s*capability\.digest/, "the lookup column must receive the digest");
  assert.match(service, /tokenCiphertext:\s*capability\.ciphertext/);
  assert.doesNotMatch(service, /token:\s*capability\.raw/, "the raw capability must never be persisted");
});

test("no public surface resolves a signing or approval link by its raw value", () => {
  // Every one of these queries a UNIQUE column, so a plaintext lookup does not
  // error — it silently matches nothing, which is a 404 on a link the customer
  // was told to use rather than a failure anyone would notice in a test.
  // `scripts/` is included deliberately. It was not, and the omission cost a CI
  // failure: the tenant-guard harness seeded a recipient with a raw token and
  // then looked it up by raw value, which this test could not see. Test and
  // seeding code is exactly where a plaintext capability survives longest,
  // because nobody reads it as security-relevant.
  const offenders: string[] = [];
  for (const file of [...walk("src/app"), ...walk("src/lib"), ...walk("scripts")]) {
    const body = read(file);
    if (!/signatureRecipient|approvalStep/.test(body)) continue;
    // `where: { token }` (shorthand) or `where: { token: token }` — anything
    // that is not wrapped in the hash.
    const matches = body.match(/where:\s*\{[^}]*\btoken\b\s*(?:,|\}|:\s*(?!hashSignToken)[A-Za-z_$][\w$]*)/g) ?? [];
    for (const match of matches) {
      // Campaign and survey tokens are tracking identifiers, not credentials
      // that authorise signing, and keep their own resolvers.
      if (/campaignRecipient|surveyResponse/.test(body.slice(Math.max(0, body.indexOf(match) - 200), body.indexOf(match)))) continue;
      offenders.push(`${file}: ${match.replace(/\s+/g, " ").trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these resolve a capability by raw value instead of hashSignToken(token):\n${offenders.join("\n")}`,
  );
});

test("nothing anywhere WRITES a raw capability", () => {
  // The lookup guard below was not enough. Two blockers reached CI green
  // because they were WRITES, not reads: workflow materialisation inserted a
  // raw newSignToken() for approvals, and the terminal-status trigger rewrote
  // the token to 'revoked_<uuid>'. Both are refused by the storage trigger, so
  // new approvals could not be created and completing a request rolled back.
  const offenders: string[] = [];
  for (const file of [...walk("src/app"), ...walk("src/lib"), ...walk("scripts")]) {
    const body = read(file);
    // A raw capability reaching the token column, in any shape.
    for (const match of body.match(/token:\s*newSignToken\(\)/g) ?? []) {
      offenders.push(`${file}: ${match}`);
    }
    for (const match of body.match(/token:\s*\w*[Cc]apability\.raw/g) ?? []) {
      offenders.push(`${file}: ${match}`);
    }
  }
  // The SQL side: a trigger or statement assigning a non-digest to the column.
  for (const file of walkSql("prisma/migrations")) {
    const body = read(file).replace(/^\s*--.*$/gm, "");
    for (const match of body.match(/"token"\s*(:?=)\s*'revoked_/g) ?? []) {
      offenders.push(`${file}: ${match.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `these write a value the storage guard refuses:\n${offenders.join("\n")}`);
});

test("revocation marks the row rather than rewriting the capability", () => {
  const migration = read("prisma/migrations/20260805230000_signing_trust_platform/migration.sql");
  // Both revocation triggers fire in the same transaction as the status change,
  // so a refused write there rolls the whole transition back.
  assert.match(migration, /SET "tokenRevokedAt" = COALESCE\("tokenRevokedAt", now\(\)\)/);
  assert.match(migration, /NEW\."tokenRevokedAt" := COALESCE\(NEW\."tokenRevokedAt", now\(\)\)/);
});

test("an approval link carries the raw capability, not the stored digest", () => {
  const approvals = read("src/lib/signing/approvals.ts");
  // Putting the digest in the URL sends a link the route hashes again, so it
  // resolves to nothing — a dead link in every approval email.
  assert.doesNotMatch(approvals, /approvalUrl\(step\.token\)/);
  assert.match(approvals, /approvalUrl\(raw\)/);
  assert.match(approvals, /revealSignCapability\(/);
  // An unrecoverable ciphertext rotates rather than sending something unusable.
  assert.match(approvals, /newSignCapability\(\)/);
});

test("there is exactly one evidence-chain design", () => {
  // Two competing migrations both added chain columns; the second backfilled
  // only rows the first had not touched, left payloadHash NULL, and failed at
  // SET NOT NULL on any database with existing events. CI never saw it because
  // CI starts empty.
  const chainMigrations = walkSql("prisma/migrations").filter(
    (file) => /ADD COLUMN IF NOT EXISTS "eventHash"/.test(read(file)),
  );
  assert.equal(chainMigrations.length, 1, `one chain design only, found: ${chainMigrations.join(", ")}`);

  const ledger = read(chainMigrations[0]);
  // The backfill must not be conditional on the column being empty.
  assert.doesNotMatch(ledger, /WHERE "eventHash" IS NULL OR "eventHash" = ''/);
  assert.match(ledger, /payloadHash" SET NOT NULL/);
  assert.match(ledger, /application-computed payloadHash/);
});

test("the database refuses to store a capability that is not a digest", () => {
  const vaultMigration = read("prisma/migrations/20260805235000_signing_token_vault/migration.sql");
  // Defence in depth: even if application code regressed, the write is refused
  // rather than quietly storing something readable.
  assert.match(vaultMigration, /signing_reject_plaintext_capability/);
  assert.match(vaultMigration, /RAISE EXCEPTION '% capability must be stored as a SHA-256 digest/);
  assert.match(vaultMigration, /CREATE TRIGGER "SignatureRecipient_reject_plaintext_token"/);
  assert.match(vaultMigration, /CREATE TRIGGER "ApprovalStep_reject_plaintext_token"/);

  // The CONVERSION STATEMENTS must be replay-safe. Double-hashing produces a
  // value that matches nothing, which would silently kill every outstanding
  // signing link — and this repository has had a migration recorded as applied
  // whose SQL never ran, so a second run is not hypothetical.
  //
  // Asserted per UPDATE rather than by searching the whole file: the same guard
  // expression also appears in the trigger and the leftover check, so a
  // file-wide match still passes with the guard stripped from the statements
  // that actually rewrite the column. (Confirmed by removing it and watching an
  // earlier version of this test stay green.)
  const conversions = vaultMigration.match(/UPDATE "(?:SignatureRecipient|ApprovalStep)"\s+SET "token" = encode\([\s\S]*?;/g) ?? [];
  assert.equal(conversions.length, 2, "expected exactly the recipient and approval conversions");
  for (const statement of conversions) {
    assert.match(
      statement,
      /!~ '\^\[0-9a-f\]\{64\}\$'/,
      `this conversion would double-hash on replay:\n${statement}`,
    );
  }
  // …and the migration refuses to finish while anything readable is left behind.
  assert.match(vaultMigration, /RAISE EXCEPTION 'Signing token vault aborted/);
});

test("strict signing mode is opted into, never inferred from the environment", () => {
  const policy = read("src/lib/signing/securityPolicy.ts");
  // Returning "strict" because NODE_ENV happens to be production means the very
  // next signature completion throws on deploy, in the one environment whose
  // prerequisites are unconfigured — while every test run passes.
  assert.doesNotMatch(policy, /NODE_ENV\s*===\s*"production"\s*\?\s*"strict"/);
  assert.match(policy, /SIGNING_SECURITY_MODE/);

  // Flipping platform-wide tenancy enforcement is its own project with its own
  // rollback plan; a signing release must not be able to require it.
  assert.doesNotMatch(policy, /TENANT_ENFORCEMENT must be enforce/);
});

test("signing tenancy fails closed rather than defaulting to one tenant", () => {
  const migration = read("prisma/migrations/20260805230000_signing_trust_platform/migration.sql");
  // EVERY stamping trigger, not just the request one. The document trigger kept
  // its 'tenant_denago_cpt' fallback through the first fix precisely because the
  // test named one function instead of asserting the property — an unscoped
  // Document tagged for-signing was still filed under Denago.
  const triggerBodies = [...readSqlCode("prisma/migrations/20260805230000_signing_trust_platform/migration.sql").matchAll(/CREATE OR REPLACE FUNCTION (signing_stamp_\w+)\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;/g)];
  assert.ok(triggerBodies.length >= 3, `expected several stamping triggers, found ${triggerBodies.length}`);
  for (const [body, name] of triggerBodies) {
    assert.doesNotMatch(body, /tenant_denago_cpt/, `${name} still falls back to a named tenant`);
    assert.match(body, /RAISE EXCEPTION/, `${name} must fail closed`);
  }
});

test("evidence is append-only and chained by the database, not by convention", () => {
  const chain = read("prisma/migrations/20260805232000_signing_event_ledger/migration.sql");
  assert.match(chain, /CREATE TRIGGER "SignatureEvent_immutable"/);
  assert.match(chain, /BEFORE UPDATE OR DELETE ON "SignatureEvent"/);
  assert.match(chain, /CREATE TRIGGER "SignatureEvent_chain"/);
  // One writer at a time per request, or two events take the same position and
  // the unique index turns a routine race into a failed signature submission.
  assert.match(chain, /pg_advisory_xact_lock/);
  assert.match(chain, /SignatureEvent_request_sequence_key/);
  // The trigger must refuse a row with no application-computed content hash,
  // rather than chaining a hash of nothing.
  assert.match(chain, /must arrive with an application-computed payloadHash/);
});
