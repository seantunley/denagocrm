import { NextRequest, NextResponse } from "next/server";
import { reconcileCompletedEnvelopes, collectSettledOrphans, collectUnregisteredUploadIntents } from "@/lib/signing/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [integrity, orphans, uploadIntents] = await Promise.all([
    reconcileCompletedEnvelopes(Number(process.env.SIGNING_RECONCILE_BATCH || 100)),
    collectSettledOrphans(Number(process.env.SIGNING_ORPHAN_BATCH || 100)),
    collectUnregisteredUploadIntents(Number(process.env.SIGNING_ORPHAN_BATCH || 100)),
  ]);
  return NextResponse.json({ ok: integrity.failed === 0, integrity, orphans, uploadIntents }, { status: integrity.failed ? 207 : 200 });
}
