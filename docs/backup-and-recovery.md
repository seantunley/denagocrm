# Denago CRM backup and recovery

## Architecture

Production uses:

- Vercel for the Next.js application and scheduled cron execution.
- Neon PostgreSQL, provisioned through Vercel, for the primary database.
- Vercel Blob for uploaded documents, signatures, generated files and backup objects.

The recovery design has three layers.

1. **Neon recovery** is the primary database recovery mechanism. Use the recovery features available for the connected Neon project, such as restore windows, point-in-time recovery or a recovery branch, according to the active Neon plan.
2. **Portable encrypted backup** is a secondary independent logical export. It contains every Prisma model, implicit contact/tag links, model counts, a SHA-256 checksum and an asset manifest.
3. **Encrypted asset snapshots** preserve the bytes referenced by CRM records. Snapshots are content-addressed by SHA-256 so unchanged files are not duplicated.

The portable export is not a replacement for Neon recovery. It is an additional escape hatch, migration aid and data-integrity check.

## Nightly process

Vercel Cron calls:

```text
GET /api/cron/backup
```

Authentication uses `CRON_SECRET`. The intake key remains supported for an authorised manual run.

The route:

1. Reads every Prisma model using the Prisma schema metadata.
2. Exports contact/tag many-to-many links.
3. Collects references to documents, library files, communication attachments and signatures.
4. Computes model counts and a SHA-256 checksum.
5. Reads each supported Vercel Blob asset.
6. Encrypts each asset with AES-256-GCM using `SETTINGS_ENCRYPTION_KEY`.
7. Stores asset snapshots under `backups/assets/<sha256>.bin.enc`.
8. Downloads and decrypts each newly-created asset snapshot to verify its checksum.
9. Encrypts the complete portability package.
10. Stores it under `backups/database/denagocrm-<timestamp>.json.enc`.
11. Downloads, decrypts and verifies the database package after upload.
12. Retains the newest 30 database packages.
13. Stores the latest result in the `BACKUP_LAST_RESULT` application setting.
14. Purges expired Trash records only after the backup has succeeded.

## Required environment variables

```text
DATABASE_URL
DATABASE_URL_UNPOOLED
BLOB_READ_WRITE_TOKEN
SETTINGS_ENCRYPTION_KEY
CRON_SECRET
```

`SETTINGS_ENCRYPTION_KEY` must be exactly 64 hexadecimal characters representing 32 random bytes.

Keep the encryption key outside the database and outside Vercel Blob. Store a protected copy in the organisation password manager or secrets vault. Losing this key makes encrypted portability and asset backups unrecoverable.

## Manual backup run

Use the deployed cron endpoint with the Vercel cron bearer secret. Do not place secrets into shell history when avoidable.

A successful response reports:

- Database backup path.
- Export checksum.
- Model counts.
- Asset references.
- Created, existing, skipped and failed asset snapshots.
- Retention and Trash-purge results.

HTTP `207` means the logical database package was created but one or more assets failed to snapshot. Treat this as a degraded backup and investigate immediately.

## Verify a downloaded portability package

Download the `.json.enc` object from Vercel Blob and run:

```bash
SETTINGS_ENCRYPTION_KEY=<64-hex-key> \
  npm run backup:verify -- ./denagocrm-backup.json.enc
```

The command also accepts the HTTPS Blob URL:

```bash
SETTINGS_ENCRYPTION_KEY=<64-hex-key> \
  npm run backup:verify -- "https://...blob.vercel-storage.com/backups/database/...json.enc"
```

Exit codes:

- `0`: package checksum and manifest are valid, with no failed asset snapshots.
- `1`: package cannot be decrypted, parsed or verified.
- `2`: database package is valid, but the recorded run contains failed asset snapshots.

## Neon database recovery

Use this order during an incident:

1. Stop or place the CRM into maintenance mode if writes could worsen the incident.
2. Record the incident time and the last known-good time.
3. Open the Neon project connected through Vercel.
4. Use the recovery option supported by the project and plan to create or restore a database state at the selected timestamp.
5. Prefer restoring to a separate Neon branch or isolated database first.
6. Point a staging deployment at the recovered connection string.
7. Run Prisma validation and application smoke tests.
8. Check record counts and critical workflows:
   - Users and login.
   - Contacts and leads.
   - Quotes and signatures.
   - Vehicles and job cards.
   - Campaigns and consent records.
   - Documents and library metadata.
9. Confirm Blob assets are reachable.
10. Only then promote or reconnect production using the recovery method approved for the incident.

Never test a restore by overwriting the production branch first.

## Asset recovery

The database portability package contains asset snapshot entries with:

- Original reference.
- Asset kind.
- Backup path.
- SHA-256 checksum.
- Plaintext size.
- Snapshot status.

Asset snapshots use the binary `DCRMBAK2` AES-256-GCM envelope. Restoration code must:

1. Download the encrypted snapshot.
2. Decrypt it with `SETTINGS_ENCRYPTION_KEY` using `decryptBytes`.
3. Confirm the plaintext SHA-256 matches the manifest.
4. Upload the recovered bytes into the active Vercel Blob store.
5. Update the relevant database reference only when the original object cannot be restored at its previous URL.

## Monthly recovery test

At least monthly:

1. Select a recent database package.
2. Run `npm run backup:verify`.
3. Confirm there were no failed asset snapshots.
4. Create an isolated Neon recovery branch from a recent point.
5. Deploy or run the CRM against that branch.
6. Perform the critical smoke-test checklist.
7. Recover and checksum at least one document, one signature and one library file from the asset snapshot namespace.
8. Record the test date, operator, selected recovery point and result.

## Monitoring

Alert when:

- `BACKUP_LAST_RESULT.ok` is false.
- The last completed backup is older than 26 hours.
- Any asset snapshot failed.
- The portability checksum fails.
- The encryption key or Blob token is missing.
- Vercel Cron did not run.

## Known limitations

- Content-addressed asset snapshots are retained indefinitely in this implementation. Add a separately reviewed garbage-collection policy only after proving that no retained database package references the candidate assets.
- Unsupported or legacy asset references are marked `skipped` rather than fetched from arbitrary hosts.
- Logical portability restore into an empty database is intentionally not automated in this change. Neon recovery is the primary full-database restore path; a future importer must respect foreign-key order, implicit relations and format versions.
