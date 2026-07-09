import { NextRequest, NextResponse } from "next/server";
import { put, list, del } from "@vercel/blob";
import { exportAllData } from "@/lib/backup";
import { purgeTrash } from "@/lib/trash";
import { getSetting, encryptValue } from "@/lib/settings";

const KEEP = 30; // retain the last 30 daily backups

/**
 * Daily database backup to Blob storage (backups/ prefix).
 * Auth: Vercel cron (CRON_SECRET bearer) or the intake API key.
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const viaCronSecret = Boolean(cronSecret) && authHeader === `Bearer ${cronSecret}`;
  const apiKey = await getSetting("INTAKE_API_KEY");
  const provided = req.nextUrl.searchParams.get("key") ?? req.headers.get("x-api-key");
  const viaApiKey = Boolean(apiKey) && provided === apiKey;
  if (!viaCronSecret && !viaApiKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "Blob storage not configured" }, { status: 500 });
  }

  const data = await exportAllData();
  const payload = JSON.stringify(data);
  // The dump holds all customer PII. This Blob store is public, so instead of
  // relying on an unguessable URL we AES-256-GCM encrypt the whole dump with
  // SETTINGS_ENCRYPTION_KEY — a leaked URL is then useless without the key.
  // Restore = download the .json.enc and run it back through decryptValue().
  const encrypted = encryptValue(payload);
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = await put(`backups/denagocrm-${stamp}.json.enc`, encrypted, {
    access: "public",
    contentType: "text/plain; charset=utf-8",
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  // prune old backups beyond the retention window
  const { blobs } = await list({ prefix: "backups/" });
  const sorted = blobs.sort((a, b) => b.pathname.localeCompare(a.pathname));
  const stale = sorted.slice(KEEP);
  for (const b of stale) await del(b.url).catch(() => {});

  // permanently remove trash past its 60-day retention (after backing up)
  const purgedTrash = await purgeTrash().catch(() => -1);

  return NextResponse.json({
    ok: true,
    backup: blob.pathname,
    sizeBytes: payload.length,
    kept: Math.min(sorted.length, KEEP),
    pruned: stale.length,
    purgedTrash,
  });
}
