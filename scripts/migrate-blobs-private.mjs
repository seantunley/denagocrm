// One-time migration: move existing PUBLIC Vercel Blob assets into a PRIVATE Blob
// store and repoint the database. Vercel Blob access is STORE-LEVEL, so this needs
// two stores/tokens:
//   BLOB_LEGACY_PUBLIC_READ_WRITE_TOKEN  — read + delete from the existing public store
//   BLOB_PRIVATE_READ_WRITE_TOKEN        — write + read the new private store
//
// ⚠️  UNVERIFIED / DESTRUCTIVE — deletes the old public objects. Not run against a
//     real Blob store. Required before production use:
//       1. Provision a private Blob store; set both tokens.
//       2. Dry run:  node scripts/migrate-blobs-private.mjs
//       3. Validate on a PREVIEW/staging store; confirm files still open in-app and
//          old public URLs return 401/404.
//       4. Take a fresh backup, then:  node scripts/migrate-blobs-private.mjs --apply
//
// Per-ref sequence (fail-closed):
//   fetch old public → sha256 → upload private → read private back → verify sha256
//   → update DB reference → JOURNAL (oldUrl→newUrl) → delete old public
//   → confirm old URL inaccessible (poll past the CDN cache TTL) → JOURNAL deleted.
// A delete failure (or an old URL still reachable after polling) is recorded as FAILED
// — never swallowed — because an undeleted public object defeats the whole purpose.
//
// RECOVERY: every repointed row is written to an append-only journal
// (migrate-blobs-private.journal.jsonl, override with BLOB_MIGRATION_JOURNAL) BEFORE
// the public object is deleted. If the process is killed or a delete fails, the DB
// already points at the private URL and would NOT be re-selected on a re-run, so the
// journal is the durable record of any `db-repointed` entry lacking a matching
// `public-deleted` — replay `del(oldUrl)` for those to finish the migration.
//
// Idempotent: rows already pointing at the private store are skipped; a row that still
// carries a PUBLIC url but is no longer fetchable is a broken/dangling reference and is
// reported as FAILED (not silently skipped as "already private").

import { PrismaClient } from "@prisma/client";
import { put, del, get } from "@vercel/blob";
import crypto from "node:crypto";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");
const LEGACY_TOKEN = process.env.BLOB_LEGACY_PUBLIC_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
const PRIVATE_TOKEN = process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;

// Durable, append-only recovery journal. Every row that gets its DB reference
// repointed is recorded BEFORE the public object is deleted, so if the process dies
// (or a delete fails) after the DB already points at the private URL, the old public
// URL is still recoverable from disk and its deletion can be replayed. A `db-repointed`
// entry with no matching `public-deleted` entry = a public object that may still be
// live and needs manual/replayed deletion.
const JOURNAL = process.env.BLOB_MIGRATION_JOURNAL || "migrate-blobs-private.journal.jsonl";
const journal = (entry) => {
  try {
    fs.appendFileSync(JOURNAL, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch (e) {
    console.error(`journal write failed (${JOURNAL}): ${e.message}`);
  }
};

// Deleted blobs can linger in Vercel's CDN cache for up to ~60s, so an immediate
// re-fetch of a just-deleted public URL can still 200 even though the origin object
// is gone. Poll (cache-bypassing) until it is unreachable or we give up.
async function waitUntilPublicUrlIsGone(url, timeoutMs = 75_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(url, { cache: "no-store" }).catch(() => null);
    if (!res || !res.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return false;
}

const TARGETS = [
  ["Document", "storedName"],
  ["LibraryVersion", "storedName"],
  ["Communication", "attachmentUrl"],
  ["User", "drawnSignatureRef"],
  ["Quote", "signatureRef"],
  ["Quote", "deliverySignatureRef"],
  ["Quote", "dealerSignatureRef"],
  ["JobCard", "signatureRef"],
  ["PortalUpload", "storedName"],
  ["SignatureRequest", "unsignedPdfRef"],
  ["SignatureRequest", "signedPdfRef"],
];

const isPrivateBlobUrl = (v) =>
  typeof v === "string" && /^https:\/\/[^/]+\.private\.blob\.vercel-storage\.com\//.test(v);
// Public store only — a private URL matches the bare `.blob.vercel-storage.com`
// pattern too, so exclude it explicitly (a re-run must not treat already-migrated
// private rows as broken public sources).
const isPublicBlobUrl = (v) =>
  typeof v === "string" &&
  /^https:\/\/[^/]+\.blob\.vercel-storage\.com\//.test(v) &&
  !isPrivateBlobUrl(v);
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const pathnameOf = (url) => new URL(url).pathname.replace(/^\/+/, "");

async function streamToBuffer(stream) {
  const reader = stream.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function main() {
  if (!APPLY) {
    console.log("DRY RUN — reporting only. Re-run with --apply to migrate.");
  } else {
    if (!LEGACY_TOKEN) throw new Error("BLOB_LEGACY_PUBLIC_READ_WRITE_TOKEN (or BLOB_READ_WRITE_TOKEN) is required");
    if (!PRIVATE_TOKEN) throw new Error("BLOB_PRIVATE_READ_WRITE_TOKEN is required");
  }

  const prisma = new PrismaClient();
  let scanned = 0, migrated = 0, skipped = 0, failed = 0;
  const failures = [];
  const fail = (where, msg) => { failed++; failures.push(`${where}: ${msg}`); console.error(`FAILED ${where}: ${msg}`); };

  try {
    for (const [table, column] of TARGETS) {
      let rows;
      try {
        rows = await prisma.$queryRawUnsafe(
          `SELECT "id", "${column}" AS ref FROM "${table}" WHERE "${column}" LIKE 'https://%blob.vercel-storage.com%'`,
        );
      } catch (e) {
        console.warn(`skip ${table}.${column}: ${e.message}`);
        continue;
      }
      for (const row of rows) {
        const ref = row.ref;
        const where = `${table}.${column}#${row.id}`;
        // Already migrated (points at the private store) → nothing to do. This keeps
        // re-runs idempotent without misclassifying private rows as broken below.
        if (isPrivateBlobUrl(ref)) { skipped++; continue; }
        if (!isPublicBlobUrl(ref)) continue;
        scanned++;

        // The row matched a PUBLIC blob URL, so the object is expected to be fetchable.
        // A 404/403/network error is therefore an unresolved/broken reference — a
        // dangling DB pointer — NOT an "already private, safe to skip" case. Report it.
        const src = await fetch(ref, { cache: "no-store" }).catch(() => null);
        if (!src || !src.ok) {
          fail(where, `public source not fetchable (${src ? `HTTP ${src.status}` : "network error"}) — broken/dangling reference: ${ref}`);
          continue;
        }
        const sourceBuf = Buffer.from(await src.arrayBuffer());
        const sourceHash = sha256(sourceBuf);

        if (!APPLY) {
          migrated++;
          console.log(`would migrate ${where} (${sourceBuf.length} bytes)`);
          continue;
        }

        // 1. Upload into the PRIVATE store.
        let newUrl;
        try {
          const blob = await put(pathnameOf(ref), sourceBuf, { access: "private", addRandomSuffix: true, token: PRIVATE_TOKEN });
          newUrl = blob.url;
        } catch (e) { fail(where, `private upload: ${e.message}`); continue; }

        // 2. Read it back from the private store and verify SHA-256.
        try {
          const check = await get(pathnameOf(newUrl), { access: "private", token: PRIVATE_TOKEN });
          if (!check?.stream) throw new Error("private read returned no stream");
          const destBuf = await streamToBuffer(check.stream);
          if (sha256(destBuf) !== sourceHash) throw new Error("SHA-256 mismatch after private upload");
        } catch (e) {
          fail(where, `private verify: ${e.message}`);
          await del(newUrl, { token: PRIVATE_TOKEN }).catch(() => {}); // roll back the private copy
          continue;
        }

        // 3. Repoint the database at the private blob, then immediately journal the
        // (oldUrl → newUrl) pair. From here the DB no longer holds the public URL, so
        // the journal is the only durable record that lets a failed/aborted delete be
        // replayed against `ref` later.
        try {
          await prisma.$executeRawUnsafe(`UPDATE "${table}" SET "${column}" = $1 WHERE "id" = $2`, newUrl, row.id);
        } catch (e) { fail(where, `db update: ${e.message}`); continue; }
        journal({ where, status: "db-repointed", oldUrl: ref, newUrl });

        // 4. Delete the old PUBLIC object — a failure here is NOT swallowed: the
        // old public URL would remain accessible, defeating the migration.
        try {
          await del(ref, { token: LEGACY_TOKEN });
        } catch (e) {
          journal({ where, status: "delete-failed", oldUrl: ref, newUrl, error: e.message });
          fail(where, `PUBLIC OBJECT NOT DELETED — still accessible at ${ref} (replay from journal): ${e.message}`);
          continue;
        }
        // 5. Confirm it is actually gone — poll past the CDN cache TTL before trusting
        // a 200 (a just-deleted object can serve from cache for up to ~60s).
        const gone = await waitUntilPublicUrlIsGone(ref);
        if (!gone) {
          journal({ where, status: "delete-unconfirmed", oldUrl: ref, newUrl });
          fail(where, `old public URL still reachable 75s after delete (replay/verify from journal): ${ref}`);
          continue;
        }

        journal({ where, status: "public-deleted", oldUrl: ref, newUrl });
        migrated++;
        console.log(`migrated ${where}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`\n${APPLY ? "Applied" : "Dry run"}: scanned ${scanned}, ${APPLY ? "migrated" : "would migrate"} ${migrated}, skipped ${skipped}, failed ${failed}.`);
  if (failures.length) {
    console.error(`\n${failures.length} unresolved item(s) — investigate before considering the migration complete:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
