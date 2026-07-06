import { NextRequest, NextResponse } from "next/server";
import { put, list, del } from "@vercel/blob";
import { exportAllData } from "@/lib/backup";
import { getSetting } from "@/lib/settings";

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
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = await put(`backups/denagocrm-${stamp}.json`, JSON.stringify(data), {
    access: "public", // unguessable URL; contains no plaintext passwords (bcrypt hashes only)
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  // prune old backups beyond the retention window
  const { blobs } = await list({ prefix: "backups/" });
  const sorted = blobs.sort((a, b) => b.pathname.localeCompare(a.pathname));
  const stale = sorted.slice(KEEP);
  for (const b of stale) await del(b.url).catch(() => {});

  return NextResponse.json({
    ok: true,
    backup: blob.pathname,
    sizeBytes: JSON.stringify(data).length,
    kept: Math.min(sorted.length, KEEP),
    pruned: stale.length,
  });
}
