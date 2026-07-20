import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { del, list, put } from "@vercel/blob";
import {
  exportAllData,
  stringifyBackup,
  type AssetReference,
  type PortableBackup,
  verifyPortableBackup,
} from "@/lib/backup";
import { basePrisma } from "@/lib/db";
import { purgeTrash } from "@/lib/trash";
import { readFile } from "@/lib/storage";
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
  const paths = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: ASSET_PREFIX, cursor, limit: 1000 });
    for (const blob of page.blobs) paths.add(blob.pathname);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return paths;
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
      const blob = await put(backupPath, encrypted, {
        access: "public",
        contentType: "application/octet-stream",
        addRandomSuffix: false,
        allowOverwrite: false,
      });

      const verificationResponse = await fetch(blob.url, { cache: "no-store" });
      if (!verificationResponse.ok) {
        throw new Error(`Asset verification download failed: ${verificationResponse.status}`);
      }
      const downloaded = Buffer.from(await verificationResponse.arrayBuffer());
      const verified = decryptBytes(downloaded);
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
  await basePrisma.appSetting.upsert({
    where: { key: "BACKUP_LAST_RESULT" },
    update: { value: JSON.stringify(result) },
    create: { key: "BACKUP_LAST_RESULT", value: JSON.stringify(result) },
  });
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
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "Blob storage not configured" }, { status: 500 });
  }
  if (!process.env.SETTINGS_ENCRYPTION_KEY) {
    return NextResponse.json({ error: "Backup encryption key not configured" }, { status: 500 });
  }

  try {
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

    const blob = await put(`${DATABASE_PREFIX}denagocrm-${stamp}.json.enc`, encrypted, {
      access: "public",
      contentType: "text/plain; charset=utf-8",
      addRandomSuffix: false,
      allowOverwrite: false,
    });

    const response = await fetch(blob.url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Backup verification download failed: ${response.status}`);
    const uploadedPackage = JSON.parse(decryptValue(await response.text())) as {
      portable: PortableBackup;
      assets: AssetSnapshot[];
    };
    const afterUpload = verifyPortableBackup(uploadedPackage.portable);
    if (!afterUpload.ok) throw new Error(afterUpload.errors.join("; "));

    const databaseBlobs = await list({ prefix: DATABASE_PREFIX, limit: 1000 });
    const sorted = databaseBlobs.blobs.sort((a, b) => b.pathname.localeCompare(a.pathname));
    const stale = sorted.slice(DATABASE_KEEP);
    for (const old of stale) await del(old.url).catch(() => {});

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
