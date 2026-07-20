import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { leadAttribution } from "@/lib/attribution";

/**
 * Google Ads offline-conversion export: won leads that arrived with a GCLID,
 * as a CSV ready for Google Ads → Goals → Conversions → Uploads. Teaching
 * Smart Bidding which clicks became actual sales (not just form submits).
 *
 * Prerequisite in Google Ads: an offline conversion action named to match
 * (default "Qualified lead (offline)", override with ?name=...) created via
 * New conversion action → Import → Manual upload.
 *
 * Only gclid rows are exported: iOS consent variants (gbraid/wbraid) need a
 * different upload template, and are rare enough here to skip.
 */
export async function GET(req: NextRequest) {
  // This exports every won lead's Google Click ID + deal value — commercially
  // sensitive attribution data. Gate to owner or reports.view_all; hasPermission
  // already returns true for owners.
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await hasPermission(user, "reports.view_all"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const conversionName = req.nextUrl.searchParams.get("name") || "Qualified lead (offline)";

  const leads = await prisma.lead.findMany({
    where: { status: "won", deletedAt: null, raw: { not: null } },
    select: { id: true, raw: true, valueCents: true, updatedAt: true },
  });

  // Prefer the lead.won audit timestamp — stable across re-exports, so Google
  // can deduplicate repeat uploads (dedup key is gclid + name + time).
  const wonAudits = await prisma.auditLog.findMany({
    where: { action: "lead.won", leadId: { in: leads.map((l) => l.id) } },
    orderBy: { createdAt: "asc" },
    select: { leadId: true, createdAt: true },
  });
  const wonAt = new Map(wonAudits.map((a) => [a.leadId, a.createdAt]));

  const rows = leads.flatMap((lead) => {
    const gclid = leadAttribution(lead.raw)?.gclid;
    if (!gclid) return [];
    const when = wonAt.get(lead.id) ?? lead.updatedAt;
    const value = lead.valueCents > 0 ? (lead.valueCents / 100).toFixed(2) : "";
    return [[gclid, conversionName, sastTime(when), value, value ? "ZAR" : ""].map(csvField).join(",")];
  });

  const csv = [
    "Parameters:TimeZone=Africa/Johannesburg",
    "Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency",
    ...rows,
  ].join("\r\n");

  await logAudit({
    action: "leads.ads_conversions_exported",
    summary: `Exported ${rows.length} Google Ads offline conversion(s) (GCLID + deal value)`,
    user: { id: user.id, name: user.name },
    source: "app",
  });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="google-ads-conversions.csv"`,
    },
  });
}

// "yyyy-MM-dd HH:mm:ss" in SAST (UTC+2, no DST).
function sastTime(date: Date): string {
  return new Date(date.getTime() + 2 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
