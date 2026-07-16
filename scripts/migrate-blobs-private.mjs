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
//   → update DB reference → delete old public → confirm old URL inaccessible → done.
// A delete failure (or an old URL that is still reachable) is recorded as FAILED —
// never swallowed — because an undeleted public object defeats the whole purpose.

import { PrismaClient } from "@prisma/client";
import { put, del, get } from "@vercel/blob";
import crypto from "node:crypto";

const APPLY = process.argv.includes("--apply");
const LEGACY_TOKEN = process.env.BLOB_LEGACY_PUBLIC_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
const PRIVATE_TOKEN = process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;

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

const isPublicBlobUrl = (v) =>
  typeof v === "string" && /^https:\/\/[^/]+\.blob\.vercel-storage\.com\//.test(v);
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
        if (!isPublicBlobUrl(ref)) continue;
        scanned++;
        const where = `${table}.${column}#${row.id}`;

        // Idempotency: only migrate refs still PUBLICLY fetchable.
        const src = await fetch(ref).catch(() => null);
        if (!src || !src.ok) { skipped++; continue; } // already private, or gone
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

        // 3. Repoint the database at the private blob.
        try {
          await prisma.$executeRawUnsafe(`UPDATE "${table}" SET "${column}" = $1 WHERE "id" = $2`, newUrl, row.id);
        } catch (e) { fail(where, `db update: ${e.message}`); continue; }

        // 4. Delete the old PUBLIC object — a failure here is NOT swallowed: the
        // old public URL would remain accessible, defeating the migration.
        try {
          await del(ref, { token: LEGACY_TOKEN });
        } catch (e) {
          fail(where, `PUBLIC OBJECT NOT DELETED — still accessible at ${ref}: ${e.message}`);
          continue;
        }
        // 5. Confirm it is actually gone.
        const after = await fetch(ref).catch(() => null);
        if (after && after.ok) { fail(where, `old public URL still reachable after delete: ${ref}`); continue; }

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
