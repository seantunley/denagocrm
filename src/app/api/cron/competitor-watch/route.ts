import { NextRequest, NextResponse } from "next/server";
import { getSetting } from "@/lib/settings";
import { collectSource, dueSourceIds } from "@/lib/competitors";

export const maxDuration = 300;

/** Daily competitor watch — checks the due public pages, snapshots on change. */
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

  const ids = await dueSourceIds(25);
  let changed = 0;
  let errors = 0;
  // Sequential + a small delay keeps us polite to each host and within limits.
  for (const id of ids) {
    const res = await collectSource(id).catch(() => ({ ok: false, changed: false }));
    if (res.changed) changed += 1;
    if (!res.ok) errors += 1;
    await new Promise((r) => setTimeout(r, 1500));
  }

  return NextResponse.json({ ok: true, checked: ids.length, changed, errors });
}
