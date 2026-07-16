import { NextRequest, NextResponse } from "next/server";
import { getSetting } from "@/lib/settings";
import {
  collectSource,
  competitorsDueForResearch,
  competitorsNeedingDiscovery,
  discoverSources,
  dueSourceIds,
  researchCompetitor,
} from "@/lib/competitors";

export const maxDuration = 300;

/**
 * Daily competitor watch. Three layers on a cost ladder:
 *  1. cheap daily page-diff of due public pages (Haiku classifies material changes)
 *  2. auto-discovery (strong model + web search) for competitors with no sources
 *  3. weekly deep-research brief (strong model + web search), a couple per run
 * Layers 2–3 are capped per run to bound token spend and stay within maxDuration.
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

  // 1. Cheap page-diff watch.
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

  // 2. Auto-discover a couple of competitors that have no sources yet.
  let discovered = 0;
  for (const id of await competitorsNeedingDiscovery(2)) {
    const res = await discoverSources(id).catch(() => ({ ok: false }));
    if (res.ok) discovered += 1;
  }

  // 3. Weekly deep-research brief for a couple of due competitors.
  let researched = 0;
  for (const id of await competitorsDueForResearch(2)) {
    const res = await researchCompetitor(id).catch(() => ({ ok: false }));
    if (res.ok) researched += 1;
  }

  return NextResponse.json({ ok: true, checked: ids.length, changed, errors, discovered, researched });
}
