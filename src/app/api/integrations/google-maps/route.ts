import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getSetting } from "@/lib/settings";

/**
 * Delivered at runtime so owners can rotate the browser key without rebuilding.
 * Browser keys are public by design and must be HTTP-referrer restricted.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = await getSetting("GOOGLE_MAPS_BROWSER_API_KEY");
  return NextResponse.json(
    { apiKey: apiKey || null },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
