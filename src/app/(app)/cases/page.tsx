import Link from "next/link";
import { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { getAccessibleCaseIds, requireAnyPermission } from "@/lib/permissions";

type CaseRow = {
  id: string;
  number: bigint;
  subject: string;
  type: string;
  priority: string;
  status: string;
  contactName: string;
  vehicleModel: string | null;
  updatedAt: Date;
  unreadCount: bigint;
};

export const dynamic = "force-dynamic";

export default async function CustomerCasesPage() {
  const user = await requireAnyPermission("cases.view_all", "cases.view_owned");
  const accessibleIds = await getAccessibleCaseIds(user);
  const scope = accessibleIds === null
    ? Prisma.sql`TRUE`
    : Prisma.sql`c."id" = ANY(${accessibleIds}::text[])`;
  const cases = await basePrisma.$queryRaw<CaseRow[]>(Prisma.sql`
    SELECT c."id", c."number", c."subject", c."type", c."priority", c."status",
      CASE WHEN contact."isCompany" AND contact."company" IS NOT NULL THEN contact."company"
        ELSE TRIM(CONCAT(contact."firstName", ' ', COALESCE(contact."lastName", ''))) END AS "contactName",
      vehicle."model" AS "vehicleModel", c."updatedAt",
      COUNT(message."id") FILTER (WHERE message."direction" = 'customer' AND message."readAt" IS NULL) AS "unreadCount"
    FROM "CustomerCase" c
    JOIN "Contact" contact ON contact."id" = c."contactId"
    LEFT JOIN "Vehicle" vehicle ON vehicle."id" = c."vehicleId"
    LEFT JOIN "CustomerCaseMessage" message ON message."caseId" = c."id"
    WHERE ${scope}
    GROUP BY c."id", contact."id", vehicle."id"
    ORDER BY
      CASE c."status" WHEN 'new' THEN 0 WHEN 'open' THEN 1 WHEN 'waiting_internal' THEN 2 WHEN 'waiting_customer' THEN 3 ELSE 4 END,
      c."updatedAt" DESC
    LIMIT 500
  `);

  return (
    <div className="space-y-6">
      <PageHeader title="Customer cases" description={`${cases.length} accessible portal support, warranty, delivery and document requests.`} />
      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Case</th><th>Customer</th><th>Type</th><th>Priority</th><th>Status</th><th>Updated</th></tr></thead>
          <tbody>
            {cases.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-slate-400">No accessible customer cases.</td></tr>}
            {cases.map((item) => (
              <tr key={item.id}>
                <td><Link href={`/cases/${item.id}`} className="text-orange-400 hover:underline font-medium">C-{item.number.toString()} · {item.subject}</Link>{Number(item.unreadCount) > 0 && <span className="badge bg-orange-500/15 text-orange-300 ml-2">{Number(item.unreadCount)} new</span>}</td>
                <td>{item.contactName}{item.vehicleModel && <p className="text-xs text-slate-500">{item.vehicleModel}</p>}</td>
                <td className="capitalize">{item.type}</td>
                <td className="capitalize">{item.priority}</td>
                <td><span className="badge bg-slate-800 text-slate-300">{item.status.replaceAll("_", " ")}</span></td>
                <td>{formatDateTime(item.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
