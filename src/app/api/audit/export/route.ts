import { NextRequest, NextResponse } from "next/server";
import { basePrisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { logAuditStrict } from "@/lib/audit";

export const dynamic = "force-dynamic";

type AuditExportRow = {
  createdAt: Date;
  actorName: string;
  actorType: string;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  changedFieldsJson: unknown;
  source: string;
  ipAddress: string | null;
  correlationId: string | null;
};

function csvCell(value: unknown) {
  const text = value == null
    ? ""
    : typeof value === "string"
    ? value
    : value instanceof Date
    ? value.toISOString()
    : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await hasPermission(user, "audit.export"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const type = request.nextUrl.searchParams.get("type")?.trim() || null;
  const entityType = request.nextUrl.searchParams.get("entity")?.trim() || null;
  const actor = request.nextUrl.searchParams.get("actor")?.trim() || null;
  const query = request.nextUrl.searchParams.get("q")?.trim() || null;
  const fromRaw = request.nextUrl.searchParams.get("from");
  const toRaw = request.nextUrl.searchParams.get("to");
  const from = fromRaw && /^\d{4}-\d{2}-\d{2}$/.test(fromRaw)
    ? new Date(`${fromRaw}T00:00:00+02:00`)
    : null;
  const to = toRaw && /^\d{4}-\d{2}-\d{2}$/.test(toRaw)
    ? new Date(`${toRaw}T23:59:59+02:00`)
    : null;

  const rows = await basePrisma.$queryRaw<AuditExportRow[]>`
    SELECT "createdAt", "actorName", "actorType", "eventType", "entityType", "entityId",
      "summary", "changedFieldsJson", "source", "ipAddress", "correlationId"
    FROM "AuditEvent"
    WHERE (${type}::text IS NULL OR "eventType" = ${type})
      AND (${entityType}::text IS NULL OR "entityType" = ${entityType})
      AND (${actor}::text IS NULL OR "actorUserId" = ${actor})
      AND (${query}::text IS NULL OR "summary" ILIKE '%' || ${query} || '%' OR "entityId" ILIKE '%' || ${query} || '%')
      AND (${from}::timestamp IS NULL OR "createdAt" >= ${from})
      AND (${to}::timestamp IS NULL OR "createdAt" <= ${to})
    ORDER BY "createdAt" DESC
    LIMIT 10000
  `;

  const headers = [
    "created_at",
    "actor_name",
    "actor_type",
    "event_type",
    "entity_type",
    "entity_id",
    "summary",
    "changed_fields",
    "source",
    "ip_address",
    "correlation_id",
  ];
  const csv = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => [
      row.createdAt,
      row.actorName,
      row.actorType,
      row.eventType,
      row.entityType,
      row.entityId,
      row.summary,
      row.changedFieldsJson,
      row.source,
      row.ipAddress,
      row.correlationId,
    ].map(csvCell).join(",")),
  ].join("\n");

  await logAuditStrict({
    action: "audit.exported",
    summary: `Exported ${rows.length} audit events`,
    entityType: "AuditEvent",
    user,
    metadata: { filters: { type, entityType, actor, query, from: fromRaw, to: toRaw }, rowCount: rows.length },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="denagocrm-audit-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}
