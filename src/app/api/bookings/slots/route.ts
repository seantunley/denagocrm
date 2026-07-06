import { NextRequest, NextResponse } from "next/server";
import { getSetting } from "@/lib/settings";
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
  const apiKey = await getSetting("INTAKE_API_KEY");
  if (!apiKey || req.headers.get("x-api-key") !== apiKey) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401, headers: corsHeaders });
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
}
