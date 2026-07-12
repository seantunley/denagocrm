import { notFound } from "next/navigation";
import { basePrisma } from "@/lib/db";
import { requireOperational } from "@/lib/auth";
import { replyToCustomerCase, updateCustomerCaseStatus } from "@/app/actions/customerCases";
import { formatDateTime } from "@/lib/format";

type CaseRow = {
  id: string;
  number: bigint;
  subject: string;
  description: string;
  type: string;
  category: string | null;
  priority: string;
  status: string;
  contactId: string;
  contactName: string;
  vehicleId: string | null;
  vehicleModel: string | null;
  createdAt: Date;
  updatedAt: Date;
};
type MessageRow = {
  id: string;
  direction: string;
  body: string;
  createdAt: Date;
  authorName: string | null;
};
type UploadRow = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
  status: string;
};

export const dynamic = "force-dynamic";

export default async function CustomerCaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOperational();
  const { id } = await params;
  const [cases, messages, uploads] = await Promise.all([
    basePrisma.$queryRaw<CaseRow[]>`
      SELECT c."id", c."number", c."subject", c."description", c."type", c."category", c."priority", c."status",
        c."contactId", CASE WHEN contact."isCompany" AND contact."company" IS NOT NULL THEN contact."company"
          ELSE TRIM(CONCAT(contact."firstName", ' ', COALESCE(contact."lastName", ''))) END AS "contactName",
        c."vehicleId", vehicle."model" AS "vehicleModel", c."createdAt", c."updatedAt"
      FROM "CustomerCase" c
      JOIN "Contact" contact ON contact."id" = c."contactId"
      LEFT JOIN "Vehicle" vehicle ON vehicle."id" = c."vehicleId"
      WHERE c."id" = ${id} LIMIT 1
    `,
    basePrisma.$queryRaw<MessageRow[]>`
      SELECT message."id", message."direction", message."body", message."createdAt",
        COALESCE(user_row."name", CASE WHEN contact."isCompany" AND contact."company" IS NOT NULL THEN contact."company"
          ELSE TRIM(CONCAT(contact."firstName", ' ', COALESCE(contact."lastName", ''))) END) AS "authorName"
      FROM "CustomerCaseMessage" message
      LEFT JOIN "User" user_row ON user_row."id" = message."userId"
      LEFT JOIN "Contact" contact ON contact."id" = message."contactId"
      WHERE message."caseId" = ${id}
      ORDER BY message."createdAt" ASC
    `,
    basePrisma.$queryRaw<UploadRow[]>`
      SELECT "id", "fileName", "mimeType", "sizeBytes", "createdAt", "status"
      FROM "PortalUpload" WHERE "caseId" = ${id}
      ORDER BY "createdAt" DESC
    `,
  ]);
  const item = cases[0];
  if (!item) notFound();

  await basePrisma.$executeRaw`
    UPDATE "CustomerCaseMessage" SET "readAt" = COALESCE("readAt", CURRENT_TIMESTAMP)
    WHERE "caseId" = ${id} AND "direction" = 'customer'
  `;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs text-slate-500">Case C-{item.number.toString()}</p>
          <h1 className="text-2xl font-bold mt-1">{item.subject}</h1>
          <p className="text-sm text-slate-400 mt-1">{item.contactName}{item.vehicleModel ? ` · ${item.vehicleModel}` : ""}</p>
        </div>
        <form action={updateCustomerCaseStatus.bind(null, item.id)} className="flex gap-2">
          <select name="status" className="input" defaultValue={item.status}>
            <option value="new">New</option><option value="open">Open</option><option value="waiting_customer">Waiting customer</option><option value="waiting_internal">Waiting internal</option><option value="resolved">Resolved</option><option value="closed">Closed</option><option value="cancelled">Cancelled</option>
          </select>
          <button className="btn-primary">Update</button>
        </form>
      </div>

      <section className="card">
        <div className="flex gap-2 flex-wrap mb-3"><span className="badge bg-slate-800 text-slate-300">{item.type}</span><span className="badge bg-slate-800 text-slate-300">{item.priority}</span><span className="badge bg-slate-800 text-slate-300">{item.status.replaceAll("_", " ")}</span></div>
        <p className="text-sm whitespace-pre-wrap">{item.description}</p>
        <p className="text-xs text-slate-500 mt-3">Opened {formatDateTime(item.createdAt)}</p>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Conversation</h2>
        {messages.length === 0 ? <div className="card text-sm text-slate-400">No messages yet.</div> : (
          <div className="space-y-3">
            {messages.map((message) => (
              <div key={message.id} className={`rounded-xl p-4 max-w-3xl ${message.direction === "staff" ? "bg-slate-800 ml-auto" : "bg-orange-950/40 border border-orange-900/50"}`}>
                <p className="text-xs font-semibold text-slate-400 mb-1">{message.authorName || (message.direction === "staff" ? "Staff" : "Customer")}</p>
                <p className="text-sm whitespace-pre-wrap">{message.body}</p>
                <p className="text-[11px] text-slate-500 mt-2">{formatDateTime(message.createdAt)}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {uploads.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-3">Customer uploads</h2>
          <ul className="divide-y divide-slate-800">
            {uploads.map((upload) => (
              <li key={upload.id} className="py-3 flex items-center justify-between gap-3">
                <div><p className="text-sm font-medium">{upload.fileName}</p><p className="text-xs text-slate-500">{Math.ceil(upload.sizeBytes / 1024)} KB · {formatDateTime(upload.createdAt)}</p></div>
                <a href={`/api/cases/uploads/${upload.id}`} className="btn-secondary btn-sm">Download</a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!['closed', 'cancelled'].includes(item.status) && (
        <section className="card space-y-3">
          <h2 className="font-semibold">Reply to customer</h2>
          <form action={replyToCustomerCase.bind(null, item.id)} className="space-y-3">
            <textarea name="body" className="input min-h-28" required placeholder="Write a customer-visible reply…" />
            <button className="btn-primary">Send reply</button>
          </form>
        </section>
      )}
    </div>
  );
}
