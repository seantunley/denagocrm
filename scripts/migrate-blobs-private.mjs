// One-time migration: re-store existing PUBLIC Vercel Blob assets as PRIVATE and
// repoint the database at the new private refs. Pairs with the storage change
// (BLOB_PRIVATE) so pre-existing customer files stop being reachable by direct
// public URL.
//
// ⚠️  UNVERIFIED / DESTRUCTIVE — it deletes the old public objects. It has NOT
//     been run against a real Blob store. REQUIRED before using on production:
//       1. Enable BLOB_PRIVATE=true and deploy.
//       2. `node scripts/migrate-blobs-private.mjs`            (dry run — reports only)
//       3. Run it against a PREVIEW/staging store first and confirm files still
//          open in-app and the old public URLs now 401/404.
//       4. Take a fresh backup, then `node scripts/migrate-blobs-private.mjs --apply`.
//
// Safety properties:
//  - dry-run by default; only --apply mutates.
//  - per ref: download (public) → put private → VERIFY private read → update the
//    DB row → only THEN delete the old public object.
//  - idempotent: a ref that is no longer publicly fetchable (already private or
//    gone) is skipped, so re-running is safe.

import { PrismaClient } from "@prisma/client";
import { put, del, get } from "@vercel/blob";

const APPLY = process.argv.includes("--apply");
const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

// (table, column) pairs that hold a storage ref. Mirrors backup.ts asset refs.
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
  if (!TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is required");
  const prisma = new PrismaClient();
  let scanned = 0;
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

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

        // Idempotency: only migrate refs that are still PUBLICLY fetchable.
        const res = await fetch(ref).catch(() => null);
        if (!res || !res.ok) {
          skipped++;
          continue; // already private, or gone
        }
        const buf = Buffer.from(await res.arrayBuffer());

        if (!APPLY) {
          migrated++;
          console.log(`would migrate ${table}.${column} #${row.id} (${buf.length} bytes)`);
          continue;
        }

        try {
          const pathname = new URL(ref).pathname.replace(/^\/+/, "");
          const blob = await put(pathname, buf, { access: "private", addRandomSuffix: true });
          // Verify the private read before we touch the DB or delete anything.
          const check = await get(new URL(blob.url).pathname.replace(/^\/+/, ""), { access: "private", token: TOKEN });
          if (!check?.stream) throw new Error("private verification read failed");
          const verified = await streamToBuffer(check.stream);
          if (verified.length !== buf.length) throw new Error("verification size mismatch");

          await prisma.$executeRawUnsafe(
            `UPDATE "${table}" SET "${column}" = $1 WHERE "id" = $2`,
            blob.url,
            row.id,
          );
          await del(ref).catch(() => {}); // remove the old public object
          migrated++;
          console.log(`migrated ${table}.${column} #${row.id}`);
        } catch (e) {
          failed++;
          console.error(`FAILED ${table}.${column} #${row.id}: ${e.message}`);
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `\n${APPLY ? "Applied" : "Dry run"}: scanned ${scanned}, ${APPLY ? "migrated" : "would migrate"} ${migrated}, skipped ${skipped}, failed ${failed}.`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
