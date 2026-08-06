import { NextRequest, NextResponse } from "next/server";
import { processSigningOutbox } from "@/lib/signing/outboxWorker";
import { recoverStaleSigningClaims } from "@/lib/signing/dispatch";
import { withSystemScope } from "@/lib/tenantScopeEntry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [jobs, staleClaims] = await Promise.all([
    processSigningOutbox({ limit: Number(process.env.SIGNING_OUTBOX_BATCH || 50) }),
    withSystemScope(() => recoverStaleSigningClaims()),
  ]);
  return NextResponse.json({ ok: jobs.failed === 0, jobs, staleClaims }, { status: jobs.failed ? 207 : 200 });
}
