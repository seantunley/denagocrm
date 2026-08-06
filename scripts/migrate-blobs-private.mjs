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
// A delete failure (or an old URL still reachable after polling) is recorded as FAILED.

import { PrismaClient } from "@prisma/client";
import { put, del, get } from "@vercel/blob";
import crypto from "node:crypto";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");
const LEGACY_TOKEN = process.env.BLOB_LEGACY_PUBLIC_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
const PRIVATE_TOKEN = process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;
const JOURNAL = process.env.BLOB_MIGRATION_JOURNAL || "migrate-blobs-private.journal.jsonl";
const journal = (entry) => {
  try {
    fs.appendFileSync(JOURNAL, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch (error) {
    console.error(`journal write failed (${JOURNAL}): ${error.message}`);
  }
};

async function waitUntilPublicUrlIsGone(url, timeoutMs = 75_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(url, { cache: "no-store" }).catch(() => null);
    if (!response || !response.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return false;
}

// Optional third item is a trusted, static SQL predicate. SignatureField.value can
// also be ordinary text, so only image-bearing field kinds are eligible.
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
  ["SignatureRecipient", "signatureRef"],
  ["SignatureField", "value", `kind IN ('signature','initials','stamp','attachment')`],
  ["LegalArtifact", "objectRef"],
  ["LegalArtifact", "timestampTokenRef"],
  ["SigningArtifact", "objectRef"],
];

const isPrivateBlobUrl = (value) =>
  typeof value === "string" && /^https:\/\/[^/]+\.private\.blob\.vercel-storage\.com\//.test(value);
const isPublicBlobUrl = (value) =>
  typeof value === "string" &&
  /^https:\/\/[^/]+\.blob\.vercel-storage\.com\//.test(value) &&
  !isPrivateBlobUrl(value);
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
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
  let scanned = 0;
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];
  const fail = (where, message) => {
    failed += 1;
    failures.push(`${where}: ${message}`);
    console.error(`FAILED ${where}: ${message}`);
  };

  try {
    for (const [table, column, predicate] of TARGETS) {
      let rows;
      try {
        const extra = predicate ? ` AND (${predicate})` : "";
        rows = await prisma.$queryRawUnsafe(
          `SELECT "id", "${column}" AS ref FROM "${table}" WHERE "${column}" LIKE 'https://%blob.vercel-storage.com%'${extra}`,
        );
      } catch (error) {
        console.warn(`skip ${table}.${column}: ${error.message}`);
        continue;
      }
      for (const row of rows) {
        const ref = row.ref;
        const where = `${table}.${column}#${row.id}`;
        if (isPrivateBlobUrl(ref)) { skipped += 1; continue; }
        if (!isPublicBlobUrl(ref)) continue;
        scanned += 1;

        const source = await fetch(ref, { cache: "no-store" }).catch(() => null);
        if (!source || !source.ok) {
          fail(where, `public source not fetchable (${source ? `HTTP ${source.status}` : "network error"}) — broken/dangling reference: ${ref}`);
          continue;
        }
        const sourceBuffer = Buffer.from(await source.arrayBuffer());
        const sourceHash = sha256(sourceBuffer);

        if (!APPLY) {
          migrated += 1;
          console.log(`would migrate ${where} (${sourceBuffer.length} bytes)`);
          continue;
        }

        let newUrl;
        try {
          const blob = await put(pathnameOf(ref), sourceBuffer, { access: "private", addRandomSuffix: true, token: PRIVATE_TOKEN });
          newUrl = blob.url;
        } catch (error) {
          fail(where, `private upload: ${error.message}`);
          continue;
        }

        try {
          const check = await get(pathnameOf(newUrl), { access: "private", token: PRIVATE_TOKEN });
          if (!check?.stream) throw new Error("private read returned no stream");
          const destinationBuffer = await streamToBuffer(check.stream);
          if (sha256(destinationBuffer) !== sourceHash) throw new Error("SHA-256 mismatch after private upload");
        } catch (error) {
          fail(where, `private verify: ${error.message}`);
          await del(newUrl, { token: PRIVATE_TOKEN }).catch(() => {});
          continue;
        }

        try {
          await prisma.$executeRawUnsafe(`UPDATE "${table}" SET "${column}" = $1 WHERE "id" = $2`, newUrl, row.id);
        } catch (error) {
          fail(where, `db update: ${error.message}`);
          continue;
        }
        journal({ where, status: "db-repointed", oldUrl: ref, newUrl });

        try {
          await del(ref, { token: LEGACY_TOKEN });
        } catch (error) {
          journal({ where, status: "delete-failed", oldUrl: ref, newUrl, error: error.message });
          fail(where, `PUBLIC OBJECT NOT DELETED — still accessible at ${ref} (replay from journal): ${error.message}`);
          continue;
        }
        const gone = await waitUntilPublicUrlIsGone(ref);
        if (!gone) {
          journal({ where, status: "delete-unconfirmed", oldUrl: ref, newUrl });
          fail(where, `old public URL still reachable 75s after delete (replay/verify from journal): ${ref}`);
          continue;
        }

        journal({ where, status: "public-deleted", oldUrl: ref, newUrl });
        migrated += 1;
        console.log(`migrated ${where}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`\n${APPLY ? "Applied" : "Dry run"}: scanned ${scanned}, ${APPLY ? "migrated" : "would migrate"} ${migrated}, skipped ${skipped}, failed ${failed}.`);
  if (failures.length) {
    console.error(`\n${failures.length} unresolved item(s) — investigate before considering the migration complete:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
