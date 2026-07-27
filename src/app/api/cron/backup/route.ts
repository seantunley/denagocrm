import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  exportAllData,
  stringifyBackup,
  type AssetReference,
  type PortableBackup,
  verifyPortableBackup,
} from "@/lib/backup";
import { putSetting } from "@/lib/settings";
import { withSystemScope } from "@/lib/tenantScopeEntry";
import { purgeTrash } from "@/lib/trash";
import { readFile, putManagedBlob, listActiveBackupBlobs, deleteFile, activeBlobWriteTokenPresent } from "@/lib/storage";
import {
  decryptBytes,
  decryptValue,
  encryptBytes,
  encryptValue,
} from "@/lib/settings";

export const maxDuration = 300;

const DATABASE_KEEP = 30;
const DATABASE_PREFIX = "backups/database/";
const ASSET_PREFIX = "backups/assets/";

const sha256 = (value: Buffer | string) =>
  crypto.createHash("sha256").update(value).digest("hex");

function isSupportedAssetRef(ref: string): boolean {
  if (!ref.startsWith("http")) return !ref.includes("..") && !ref.includes("/");
  try {
    const url = new URL(ref);
    return url.protocol === "https:" && url.hostname.endsWith(".blob.vercel-storage.com");
  } catch {
    return false;
  }
}

async function existingAssetPaths(): Promise<Set<string>> {
  // Dedupe only against the ACTIVE store — after cutover a content-addressed
  // asset that exists only in the legacy public store must still be written into
  // the private store, or private backups keep depending on public assets.
  const blobs = await listActiveBackupBlobs(ASSET_PREFIX);
  return new Set(blobs.map((blob) => blob.pathname));
}

type AssetSnapshot = {
  kind: string;
  sourceRef: string;
  backupPath?: string;
  sha256?: string;
  sizeBytes?: number;
  status: "created" | "existing" | "skipped" | "failed";
  error?: string;
};

async function snapshotAssets(refs: AssetReference[]): Promise<AssetSnapshot[]> {
  const existing = await existingAssetPaths();
  const snapshots: AssetSnapshot[] = [];

  for (const asset of refs) {
    const identity = { kind: asset.kind, sourceRef: asset.ref };
    if (!isSupportedAssetRef(asset.ref)) {
      snapshots.push({ ...identity, status: "skipped", error: "Unsupported asset reference" });
      continue;
    }

    try {
      const plain = await readFile(asset.ref);
      const digest = sha256(plain);
      const backupPath = `${ASSET_PREFIX}${digest}.bin.enc`;

      if (existing.has(backupPath)) {
        snapshots.push({ ...identity, status: "existing", backupPath, sha256: digest, sizeBytes: plain.length });
        continue;
      }

      const encrypted = encryptBytes(plain);
      const blob = await putManagedBlob(backupPath, encrypted, "application/octet-stream");

      // Verify by reading it straight back (private-store-aware).
      const verified = decryptBytes(await readFile(blob.url));
      if (sha256(verified) !== digest) throw new Error("Asset verification checksum mismatch");

      existing.add(backupPath);
      snapshots.push({ ...identity, status: "created", backupPath, sha256: digest, sizeBytes: plain.length });
    } catch (error) {
      snapshots.push({
        ...identity,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown asset backup error",
      });
    }
  }

  return snapshots;
}

async function recordResult(result: Record<string, unknown>) {
  // Runs inside withSystemScope → putSetting resolves to the founding tenant
  // (the platform-default settings owner).
  await putSetting("BACKUP_LAST_RESULT", JSON.stringify(result));
}

/**
 * Neon/Vercel backup layers:
 * 1. Neon restore/PITR is the primary database recovery mechanism.
 * 2. This route creates a complete encrypted portable data export.
 * 3. Every referenced Vercel Blob asset is copied into a content-addressed,
 *    encrypted backup namespace and verified after upload.
 */
export async function GET(req: NextRequest) {
  const startedAt = new Date();
  // Backups export the ENTIRE encrypted database, snapshot assets and purge
  // trash — administrative maintenance. Only the dedicated CRON_SECRET (sent as a
  // Bearer header by Vercel Cron) may trigger it. The website intake key
  // (INTAKE_API_KEY) is a lower-privilege integration secret and must NOT
  // authorize this; a query-string ?key= is also refused since URLs leak into
  // logs and telemetry.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const viaCronSecret = Boolean(cronSecret) && authHeader === `Bearer ${cronSecret}`;

  if (!viaCronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!activeBlobWriteTokenPresent()) {
    // Validate the token for the store we actually write to (private in private
    // mode, public otherwise), so the public token can be retired post-cutover.
    return NextResponse.json({ error: "Blob storage not configured for the active mode" }, { status: 500 });
  }
  if (!process.env.SETTINGS_ENCRYPTION_KEY) {
    return NextResponse.json({ error: "Backup encryption key not configured" }, { status: 500 });
  }

  try {
    // Whole-DB export + trash purge is a platform-global sweep across EVERY
    // tenant's rows, so it runs in the trusted system scope (guard bypass). The
    // guarded reads inside `exportAllData` would otherwise fail closed under
    // enforcement (no principal → no tenant scope). Dormant → a bare call.
    return await withSystemScope(async () => {
    const portable = await exportAllData();
    const beforeUpload = verifyPortableBackup(portable);
    if (!beforeUpload.ok) throw new Error(beforeUpload.errors.join("; "));

    const assets = await snapshotAssets(portable.assetReferences);
    const failedAssets = assets.filter((asset) => asset.status === "failed");
    const skippedAssets = assets.filter((asset) => asset.status === "skipped");
    const degradedAssets = [...failedAssets, ...skippedAssets];
    const packagePayload = stringifyBackup({ portable, assets });
    const encrypted = encryptValue(packagePayload);
    const stamp = startedAt.toISOString().replace(/[:.]/g, "-");

    const blob = await putManagedBlob(
      `${DATABASE_PREFIX}denagocrm-${stamp}.json.enc`,
      encrypted,
      "text/plain; charset=utf-8",
    );

    // Verify by reading it straight back (private-store-aware).
    const uploadedText = (await readFile(blob.url)).toString("utf8");
    const uploadedPackage = JSON.parse(decryptValue(uploadedText)) as {
      portable: PortableBackup;
      assets: AssetSnapshot[];
    };
    const afterUpload = verifyPortableBackup(uploadedPackage.portable);
    if (!afterUpload.ok) throw new Error(afterUpload.errors.join("; "));

    // Retention prunes the ACTIVE store only — never reach across and delete a
    // backup in the other store (e.g. private/preview blobs while still public).
    const databaseBlobs = await listActiveBackupBlobs(DATABASE_PREFIX);
    const sorted = databaseBlobs.sort((a, b) => b.pathname.localeCompare(a.pathname));
    const stale = sorted.slice(DATABASE_KEEP);
    for (const old of stale) await deleteFile(old.url).catch(() => {});

    // Never permanently delete Trash records unless both the logical export and
    // every referenced asset were backed up successfully.
    const purgedTrash = degradedAssets.length === 0
      ? await purgeTrash().catch(() => -1)
      : 0;
    const result = {
      ok: degradedAssets.length === 0,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      databaseBackup: blob.pathname,
      payloadBytes: Buffer.byteLength(packagePayload),
      modelCounts: portable.metadata.modelCounts,
      dataSha256: portable.metadata.dataSha256,
      assets: {
        referenced: assets.length,
        created: assets.filter((asset) => asset.status === "created").length,
        existing: assets.filter((asset) => asset.status === "existing").length,
        skipped: skippedAssets.length,
        failed: failedAssets.length,
      },
      databaseBackupsKept: Math.min(sorted.length, DATABASE_KEEP),
      databaseBackupsPruned: stale.length,
      trashPurgeSkipped: degradedAssets.length > 0,
      purgedTrash,
    };
    await recordResult(result);

    return NextResponse.json(result, { status: degradedAssets.length ? 207 : 200 });
    });
  } catch (error) {
    const result = {
      ok: false,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      error: error instanceof Error ? error.message : "Unknown backup error",
    };
    await recordResult(result).catch(() => {});
    return NextResponse.json(result, { status: 500 });
  }
}
