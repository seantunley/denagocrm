import Link from "next/link";
import { basePrisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { hasPermission, requirePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

type AuditEventRow = {
  id: string;
  actorUserId: string | null;
  actorName: string;
  actorType: string;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  beforeJson: unknown;
  afterJson: unknown;
  changedFieldsJson: string[] | null;
  source: string;
  ipAddress: string | null;
  userAgent: string | null;
  correlationId: string | null;
  metadata: unknown;
  createdAt: Date;
};

function dateParam(value: string | string[] | undefined, endOfDay = false) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return new Date(`${value}T${endOfDay ? "23:59:59" : "00:00:00"}+02:00`);
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("audit.view");
  const canExport = await hasPermission(user, "audit.export");
  const params = await searchParams;
  const type = typeof params.type === "string" ? params.type.trim() || null : null;
  const entityType = typeof params.entity === "string" ? params.entity.trim() || null : null;
  const actor = typeof params.actor === "string" ? params.actor.trim() || null : null;
  const query = typeof params.q === "string" ? params.q.trim() || null : null;
  const from = dateParam(params.from);
  const to = dateParam(params.to, true);

  const [events, eventTypes, entityTypes, actors] = await Promise.all([
    basePrisma.$queryRaw<AuditEventRow[]>`
      SELECT * FROM "AuditEvent"
      WHERE (${type}::text IS NULL OR "eventType" = ${type})
        AND (${entityType}::text IS NULL OR "entityType" = ${entityType})
        AND (${actor}::text IS NULL OR "actorUserId" = ${actor})
        AND (${query}::text IS NULL OR "summary" ILIKE '%' || ${query} || '%' OR "entityId" ILIKE '%' || ${query} || '%')
        AND (${from}::timestamp IS NULL OR "createdAt" >= ${from})
        AND (${to}::timestamp IS NULL OR "createdAt" <= ${to})
      ORDER BY "createdAt" DESC LIMIT 500
    `,
    basePrisma.$queryRaw<Array<{ value: string }>>`
      SELECT DISTINCT "eventType" AS value FROM "AuditEvent" ORDER BY value
    `,
    basePrisma.$queryRaw<Array<{ value: string }>>`
      SELECT DISTINCT "entityType" AS value FROM "AuditEvent"
      WHERE "entityType" IS NOT NULL ORDER BY value
    `,
    basePrisma.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT "id", "name" FROM "User" ORDER BY "name"
    `,
  ]);

  const exportQuery = new URLSearchParams();
  for (const key of ["type", "entity", "actor", "from", "to", "q"] as const) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) exportQuery.set(key, value.trim());
  }
  const exportHref = `/api/audit/export${exportQuery.size ? `?${exportQuery.toString()}` : ""}`;

  function entityHref(event: AuditEventRow) {
    if (!event.entityId) return null;
    if (event.entityType === "Lead") return `/leads/${event.entityId}`;
    if (event.entityType === "Contact") return `/contacts/${event.entityId}`;
    if (event.entityType === "SalesPipeline" || event.entityType === "PipelineStage") return "/settings/pipelines";
    if (["Team", "Role", "User"].includes(event.entityType ?? "")) return "/settings/access";
    return null;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Audit events</h1>
          <p className="text-sm text-slate-400 mt-1">
            Append-only governance history with actors, changes, request context and correlation IDs.
          </p>
        </div>
        {canExport && <Link href={exportHref} className="btn-secondary">Export filtered CSV</Link>}
      </div>

      <form className="card grid md:grid-cols-6 gap-3 items-end">
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Event</span>
          <select name="type" className="input" defaultValue={type ?? ""}>
            <option value="">All events</option>
            {eventTypes.map((item) => <option key={item.value} value={item.value}>{item.value}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Entity</span>
          <select name="entity" className="input" defaultValue={entityType ?? ""}>
            <option value="">All entities</option>
            {entityTypes.map((item) => <option key={item.value} value={item.value}>{item.value}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Actor</span>
          <select name="actor" className="input" defaultValue={actor ?? ""}>
            <option value="">All actors</option>
            {actors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">From</span>
          <input name="from" type="date" className="input" defaultValue={typeof params.from === "string" ? params.from : ""} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">To</span>
          <input name="to" type="date" className="input" defaultValue={typeof params.to === "string" ? params.to : ""} />
        </label>
        <button className="btn-primary">Filter</button>
        <label className="space-y-1 md:col-span-5">
          <span className="text-xs text-slate-400">Search summary or entity ID</span>
          <input name="q" className="input" defaultValue={query ?? ""} />
        </label>
        <Link href="/audit" className="btn-secondary text-center">Clear</Link>
      </form>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>When</th><th>Actor</th><th>Event</th><th>Entity</th><th>Summary</th><th>Changes</th><th>Context</th></tr></thead>
          <tbody>
            {events.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-slate-400">No audit events match the filters.</td></tr>
            )}
            {events.map((event) => {
              const href = entityHref(event);
              return (
                <tr key={event.id}>
                  <td className="whitespace-nowrap">{formatDateTime(event.createdAt)}</td>
                  <td>{event.actorName}<p className="text-xs text-slate-500">{event.actorType}</p></td>
                  <td><code className="text-xs">{event.eventType}</code></td>
                  <td>
                    {href ? (
                      <Link href={href} className="text-orange-400 hover:underline">
                        {event.entityType} · {event.entityId}
                      </Link>
                    ) : (
                      <span>{event.entityType ?? "—"}{event.entityId ? ` · ${event.entityId}` : ""}</span>
                    )}
                  </td>
                  <td className="max-w-sm">{event.summary}</td>
                  <td>
                    <details>
                      <summary className="cursor-pointer text-xs text-orange-400">
                        {event.changedFieldsJson?.length ?? 0} fields
                      </summary>
                      <pre className="mt-2 text-[11px] max-w-lg overflow-auto whitespace-pre-wrap">
                        {JSON.stringify({ changed: event.changedFieldsJson, before: event.beforeJson, after: event.afterJson }, null, 2)}
                      </pre>
                    </details>
                  </td>
                  <td>
                    <details>
                      <summary className="cursor-pointer text-xs text-slate-400">Request</summary>
                      <div className="mt-2 text-[11px] max-w-xs break-all">
                        <p>Source: {event.source}</p><p>IP: {event.ipAddress ?? "—"}</p>
                        <p>Correlation: {event.correlationId ?? "—"}</p><p>User agent: {event.userAgent ?? "—"}</p>
                      </div>
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        Showing up to 500 newest matching events. AuditEvent rows are protected from UPDATE and DELETE by database triggers.
      </p>
    </div>
  );
}
