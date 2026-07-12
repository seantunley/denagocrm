import fs from "fs/promises";
import { decryptValue } from "../src/lib/settings";
import {
  PORTABLE_BACKUP_FORMAT,
  PORTABLE_BACKUP_VERSION,
  type PortableBackup,
  verifyPortableBackup,
} from "../src/lib/backup";

type BackupPackage = {
  portable: PortableBackup;
  assets: Array<{
    kind: string;
    sourceRef: string;
    backupPath?: string;
    sha256?: string;
    sizeBytes?: number;
    status: "created" | "existing" | "skipped" | "failed";
    error?: string;
  }>;
};

async function readInput(input: string): Promise<string> {
  if (/^https:\/\//i.test(input)) {
    const response = await fetch(input, { cache: "no-store" });
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    return response.text();
  }
  return fs.readFile(input, "utf8");
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    throw new Error("Usage: npm run backup:verify -- <encrypted-file-or-https-url>");
  }
  if (!process.env.SETTINGS_ENCRYPTION_KEY) {
    throw new Error("SETTINGS_ENCRYPTION_KEY is required to verify an encrypted backup");
  }

  const encrypted = await readInput(input);
  const parsed = JSON.parse(decryptValue(encrypted)) as BackupPackage;
  const result = verifyPortableBackup(parsed.portable);
  const failedAssets = parsed.assets.filter((asset) => asset.status === "failed");
  const skippedAssets = parsed.assets.filter((asset) => asset.status === "skipped");

  if (!result.ok) throw new Error(`Backup verification failed: ${result.errors.join("; ")}`);

  console.log(JSON.stringify({
    ok: true,
    format: PORTABLE_BACKUP_FORMAT,
    version: PORTABLE_BACKUP_VERSION,
    exportedAt: parsed.portable.metadata.exportedAt,
    modelCounts: parsed.portable.metadata.modelCounts,
    dataSha256: parsed.portable.metadata.dataSha256,
    assets: {
      total: parsed.assets.length,
      created: parsed.assets.filter((asset) => asset.status === "created").length,
      existing: parsed.assets.filter((asset) => asset.status === "existing").length,
      skipped: skippedAssets.length,
      failed: failedAssets.length,
    },
  }, null, 2));

  if (failedAssets.length) {
    process.exitCode = 2;
    console.error("Backup data is valid, but one or more asset snapshots failed.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
