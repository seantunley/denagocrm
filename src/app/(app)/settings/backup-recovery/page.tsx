import Link from "next/link";
import { list, type ListBlobResultBlob } from "@vercel/blob";
import {
  ArrowDownToLine,
  ArrowLeft,
  Check,
  Clock3,
  Cloud,
  DatabaseBackup,
  FileArchive,
  HardDrive,
  KeyRound,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { RunBackupControl, VerifyBackupControl } from "@/components/BackupControls";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

type BackupResult = {
  ok?: boolean;
  completedAt?: string;
  durationMs?: number;
  databaseBackup?: string;
  payloadBytes?: number;
  dataSha256?: string;
  databaseBackupsKept?: number;
  databaseBackupsPruned?: number;
  trashPurgeSkipped?: boolean;
  purgedTrash?: number;
  error?: string;
  assets?: { referenced?: number; created?: number; existing?: number; skipped?: number; failed?: number };
};

type VerifyResult = { pathname?: string; verifiedAt?: string; ok?: boolean; assetExceptions?: number };

async function listAll(prefix: string): Promise<ListBlobResultBlob[]> {
  const blobs: ListBlobResultBlob[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function formatBytes(bytes?: number) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatWhen(value?: string | Date) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-ZA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Johannesburg",
  }).format(new Date(value));
}

function relativeAge(value?: string) {
  if (!value) return "No completed run";
  const hours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000));
  if (hours < 1) return "Less than an hour ago";
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function ConfigRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  const Icon = ok ? Check : TriangleAlert;
  return (
    <li className="flex items-start gap-3 py-3">
      <span className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-full ${ok ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400"}`}>
        <Icon className="size-3.5" />
      </span>
      <div>
        <p className="text-[13px] font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </li>
  );
}

export default async function BackupsPage() {
  await requireOwner();

  const [lastRaw, verifyRaw] = await Promise.all([
    getSetting("BACKUP_LAST_RESULT"),
    getSetting("BACKUP_LAST_VERIFY"),
  ]);
  const last = parseJson<BackupResult>(lastRaw);
  const lastVerify = parseJson<VerifyResult>(verifyRaw);

  let databaseBackups: ListBlobResultBlob[] = [];
  let assetBackups: ListBlobResultBlob[] = [];
  let storageError = "";
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      [databaseBackups, assetBackups] = await Promise.all([
        listAll("backups/database/"),
        listAll("backups/assets/"),
      ]);
    } catch (error) {
      storageError = error instanceof Error ? error.message : "Blob storage could not be read.";
    }
  }
  databaseBackups.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());

  const latest = databaseBackups[0];
  const healthy = Boolean(last?.ok && latest);
  const totalDatabaseBytes = databaseBackups.reduce((sum, blob) => sum + blob.size, 0);
  const totalAssetBytes = assetBackups.reduce((sum, blob) => sum + blob.size, 0);
  const encryptionReady = /^[a-f\d]{64}$/i.test(process.env.SETTINGS_ENCRYPTION_KEY ?? "");
  const configuration = [
    { ok: Boolean(process.env.DATABASE_URL), label: "Neon database", detail: "Primary recovery uses Neon point-in-time restore or a recovery branch." },
    { ok: Boolean(process.env.BLOB_READ_WRITE_TOKEN), label: "Backup storage", detail: "Encrypted portable packages and asset snapshots are stored in Vercel Blob." },
    { ok: encryptionReady, label: "Encryption key", detail: "AES-256-GCM protects every portable package. Keep this key outside the application." },
    { ok: Boolean(process.env.CRON_SECRET), label: "Scheduled job authentication", detail: "Vercel calls the backup route daily at 02:00 UTC (04:00 SAST)." },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link href="/settings" className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" /> Settings
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">Backup &amp; recovery</h1>
          <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
            Monitor automated backups, verify retained packages and follow the safe recovery runbook.
          </p>
        </div>
        <RunBackupControl />
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Protection</p>
          <div className="mt-2 flex items-center gap-2">
            {healthy ? <ShieldCheck className="size-5 text-emerald-400" /> : <TriangleAlert className="size-5 text-amber-400" />}
            <p className="text-lg font-semibold">{healthy ? "Healthy" : "Attention"}</p>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{relativeAge(last?.completedAt)}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Database copies</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">{databaseBackups.length}</p>
          <p className="mt-1 text-xs text-muted-foreground">{formatBytes(totalDatabaseBytes)} encrypted</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Asset snapshots</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">{assetBackups.length}</p>
          <p className="mt-1 text-xs text-muted-foreground">{formatBytes(totalAssetBytes)} deduplicated</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Last verification</p>
          <p className="mt-2 text-sm font-semibold">{lastVerify?.ok ? "Passed" : "Not run manually"}</p>
          <p className="mt-1 text-xs text-muted-foreground">{formatWhen(lastVerify?.verifiedAt)}</p>
        </div>
      </div>

      {storageError && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
          Backup storage could not be inspected: {storageError}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.15fr_.85fr]">
        <section className="rounded-xl border border-border bg-card shadow-sm">
          <div className="border-b border-border px-5 py-4">
            <h2 className="font-semibold">Latest automated run</h2>
            <p className="text-xs text-muted-foreground">The backup job also verifies the package after uploading it.</p>
          </div>
          {last ? (
            <div className="grid grid-cols-2 gap-x-5 gap-y-4 p-5 sm:grid-cols-3">
              <div><p className="text-xs text-muted-foreground">Completed</p><p className="mt-1 text-sm font-medium">{formatWhen(last.completedAt)}</p></div>
              <div><p className="text-xs text-muted-foreground">Duration</p><p className="mt-1 text-sm font-medium">{last.durationMs != null ? `${(last.durationMs / 1000).toFixed(1)} sec` : "—"}</p></div>
              <div><p className="text-xs text-muted-foreground">Payload</p><p className="mt-1 text-sm font-medium">{formatBytes(last.payloadBytes)}</p></div>
              <div><p className="text-xs text-muted-foreground">Assets referenced</p><p className="mt-1 text-sm font-medium">{last.assets?.referenced ?? "—"}</p></div>
              <div><p className="text-xs text-muted-foreground">New / existing</p><p className="mt-1 text-sm font-medium">{last.assets ? `${last.assets.created ?? 0} / ${last.assets.existing ?? 0}` : "—"}</p></div>
              <div><p className="text-xs text-muted-foreground">Asset exceptions</p><p className={`mt-1 text-sm font-medium ${(last.assets?.failed ?? 0) + (last.assets?.skipped ?? 0) ? "text-amber-400" : "text-emerald-400"}`}>{(last.assets?.failed ?? 0) + (last.assets?.skipped ?? 0)}</p></div>
              {last.error && <p className="col-span-full rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{last.error}</p>}
              {last.dataSha256 && <p className="col-span-full truncate font-mono text-[11px] text-muted-foreground">SHA-256 · {last.dataSha256}</p>}
            </div>
          ) : (
            <div className="p-8 text-center"><DatabaseBackup className="mx-auto size-7 text-muted-foreground" /><p className="mt-2 text-sm font-medium">No run has been recorded</p><p className="text-xs text-muted-foreground">Run a backup now to establish the first restore point.</p></div>
          )}
        </section>

        <section className="rounded-xl border border-border bg-card shadow-sm">
          <div className="border-b border-border px-5 py-4"><h2 className="font-semibold">Configuration</h2><p className="text-xs text-muted-foreground">Secrets are checked for presence only and are never displayed.</p></div>
          <ul className="divide-y divide-border px-5">{configuration.map((item) => <ConfigRow key={item.label} {...item} />)}</ul>
        </section>
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div><h2 className="font-semibold">Retained portable backups</h2><p className="text-xs text-muted-foreground">The newest 30 database packages are retained. Asset snapshots are content-addressed and deduplicated.</p></div>
          <FileArchive className="size-5 text-muted-foreground" />
        </div>
        {databaseBackups.length ? (
          <div className="divide-y divide-border">
            {databaseBackups.map((blob, index) => (
              <div key={blob.pathname} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><DatabaseBackup className="size-4" /></span>
                  <div className="min-w-0"><p className="truncate text-[13px] font-medium">{index === 0 ? "Latest backup" : blob.pathname.split("/").at(-1)}</p><p className="mt-0.5 text-xs text-muted-foreground">{formatWhen(blob.uploadedAt)} · {formatBytes(blob.size)}</p></div>
                </div>
                <div className="flex items-start justify-end gap-2">
                  <VerifyBackupControl pathname={blob.pathname} />
                  <Button asChild variant="outline" size="sm"><a href={blob.url} target="_blank" rel="noreferrer"><ArrowDownToLine className="size-3.5" />Encrypted file</a></Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-8 text-center text-sm text-muted-foreground">No portable backup files are visible in Blob storage.</div>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card shadow-sm">
        <div className="border-b border-border px-5 py-4"><h2 className="font-semibold">Recovery runbook</h2><p className="text-xs text-muted-foreground">Recovery is deliberately guided, not one-click. Restore into an isolated environment and validate it before switching production traffic.</p></div>
        <div className="grid gap-0 divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
          <div className="p-5"><Cloud className="size-5 text-primary" /><p className="mt-3 text-sm font-semibold">1. Restore the database</p><p className="mt-1 text-xs leading-5 text-muted-foreground">In Neon, create a recovery branch at the required point in time. This is the fastest and primary recovery path.</p></div>
          <div className="p-5"><ShieldCheck className="size-5 text-primary" /><p className="mt-3 text-sm font-semibold">2. Validate in isolation</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Point a staging deployment at the recovery branch. Check sign-in, record counts, recent leads, quotes, files and background jobs.</p></div>
          <div className="p-5"><HardDrive className="size-5 text-primary" /><p className="mt-3 text-sm font-semibold">3. Promote safely</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Pause writes, record the cutover, switch the production connection and run smoke checks. Keep the old branch until sign-off.</p></div>
        </div>
        <div className="grid gap-3 border-t border-border bg-muted/20 p-5 sm:grid-cols-2">
          <div className="flex gap-3"><KeyRound className="mt-0.5 size-4 shrink-0 text-amber-400" /><p className="text-xs leading-5 text-muted-foreground"><strong className="text-foreground">Keep the encryption key separately.</strong> Downloaded portable files cannot be opened without the exact SETTINGS_ENCRYPTION_KEY used to create them.</p></div>
          <div className="flex gap-3"><Clock3 className="mt-0.5 size-4 shrink-0 text-amber-400" /><p className="text-xs leading-5 text-muted-foreground"><strong className="text-foreground">Portable restore is an emergency path.</strong> Packages are complete and verifiable, but this repository does not yet include an automated importer. Follow <code>docs/backup-and-recovery.md</code> during an incident.</p></div>
        </div>
      </section>
    </div>
  );
}
