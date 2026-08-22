import { NextRequest, NextResponse } from "next/server";
import { authenticateIntakeKey } from "@/lib/apiKeys";
import { throttlePublic } from "@/lib/publicThrottle";
import { API_KEY_POLICY } from "@/lib/rateLimit";
import { withTenantScopeFromId } from "@/lib/tenantScopeEntry";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { getDayAvailability, getSlotConfig } from "@/lib/bookingSlots";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/** Slot availability for a given day: GET /api/bookings/slots?date=YYYY-MM-DD */
export async function GET(req: NextRequest) {
  // Authenticate before any tenant-owned read. The key itself resolves the tenant;
  // the callback below keeps that scope enclosing the rest of this Route Handler
  // rather than relying on enterWith from a helper to propagate back into it.
  {
    const throttled = await throttlePublic("api-bookings-slots", req.headers.get("x-api-key"), API_KEY_POLICY);
    if (throttled) return throttled;
  }
  const auth = await authenticateIntakeKey(req.headers.get("x-api-key"), "bookings");
  if (!auth) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401, headers: corsHeaders });
  }

  return withTenantScopeFromId(auth.tenantId, async () => {
    // Workshop bookings belong to the automotive pack — gone when it's off.
    if (!(await isModuleEnabled("automotive"))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const date = req.nextUrl.searchParams.get("date") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date required (YYYY-MM-DD)" }, { status: 422, headers: corsHeaders });
    }
    const config = await getSlotConfig();
    const max = new Date();
    max.setDate(max.getDate() + config.horizonDays);
    if (new Date(`${date}T12:00:00`) > max) {
      return NextResponse.json(
        { date, open: false, slots: [], reason: "beyond booking horizon" },
        { headers: corsHeaders }
      );
    }
    const availability = await getDayAvailability(date);
    return NextResponse.json(availability, { headers: corsHeaders });
  });
}
