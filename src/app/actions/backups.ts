"use server";

import { NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { GET as executeBackup } from "@/app/api/cron/backup/route";
import { requireOwner } from "@/lib/auth";
import { type PortableBackup, verifyPortableBackup } from "@/lib/backup";
import { decryptValue, putSetting } from "@/lib/settings";
import { listAllBackupBlobs, readFile } from "@/lib/storage";

export type BackupActionState = {
  ok?: string;
  error?: string;
  pathname?: string;
};

export async function runBackupNow(
  _previous: BackupActionState | undefined,
  _formData: FormData,
): Promise<BackupActionState> {
  void _previous;
  void _formData;
  await requireOwner();

  // The backup route now only accepts CRON_SECRET (the intake-key fallback was
  // removed as a privilege-escalation risk). Without it, sending the intake key
  // would just 401, so fail with a clear configuration error instead.
  if (!process.env.CRON_SECRET) {
    return { error: "Backups aren't configured — CRON_SECRET is not set on the server." };
  }
  const headers = new Headers();
  headers.set("authorization", `Bearer ${process.env.CRON_SECRET}`);

  try {
    const response = await executeBackup(
      new NextRequest("http://internal/api/cron/backup", { headers }),
    );
    const result = (await response.json()) as {
      error?: string;
      databaseBackup?: string;
      assets?: { failed?: number; skipped?: number };
    };
    revalidatePath("/settings/backup-recovery");

    if (!response.ok && response.status !== 207) {
      return { error: result.error ?? "The backup did not complete." };
    }
    const exceptions = (result.assets?.failed ?? 0) + (result.assets?.skipped ?? 0);
    return {
      ok: exceptions
        ? `Backup created with ${exceptions} asset exception${exceptions === 1 ? "" : "s"}.`
        : "Backup created and verified.",
      pathname: result.databaseBackup,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The backup did not complete." };
  }
}

export async function verifyBackup(
  _previous: BackupActionState | undefined,
  formData: FormData,
): Promise<BackupActionState> {
  await requireOwner();
  const pathname = String(formData.get("pathname") ?? "");
  if (!pathname.startsWith("backups/database/") || !pathname.endsWith(".json.enc")) {
    return { error: "That is not a recognised database backup." };
  }

  try {
    const blobs = await listAllBackupBlobs(pathname);
    const blob = blobs.find((candidate) => candidate.pathname === pathname);
    if (!blob) return { error: "Backup file not found." };

    const uploadedText = (await readFile(blob.url)).toString("utf8");
    const payload = JSON.parse(decryptValue(uploadedText)) as {
      portable: PortableBackup;
      assets?: Array<{ status?: string }>;
    };
    const verification = verifyPortableBackup(payload.portable);
    if (!verification.ok) return { error: verification.errors.join("; ") };

    const assetExceptions = (payload.assets ?? []).filter(
      (asset) => asset.status === "failed" || asset.status === "skipped",
    ).length;
    await putSetting("BACKUP_LAST_VERIFY", JSON.stringify({
      pathname,
      verifiedAt: new Date().toISOString(),
      ok: true,
      assetExceptions,
    }));
    revalidatePath("/settings/backup-recovery");
    return {
      ok: assetExceptions
        ? `Database checksum passed; ${assetExceptions} asset exception${assetExceptions === 1 ? "" : "s"} recorded.`
        : "Checksum, manifest and asset index passed.",
      pathname,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "The backup could not be verified.",
      pathname,
    };
  }
}
