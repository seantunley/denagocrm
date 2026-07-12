import { notFound, redirect } from "next/navigation";
import { basePrisma } from "@/lib/db";
import { getPortalContact } from "@/lib/portal";
import { portalCanAccessCase } from "@/lib/portalAccess";
import { PortalCaseMessageForm } from "@/components/PortalExpansionForms";
import { formatDateTime } from "@/lib/format";

type CaseRow = {
  id: string;
  number: bigint;
  subject: string;
  description: string;
  type: string;
  priority: string;
  status: string;
  createdAt: Date;
};
type MessageRow = {
  id: string;
  direction: string;
  body: string;
  createdAt: Date;
};

export default async function PortalCasePage({ params }: { params: Promise<{ id: string }> }) {
  const contact = await getPortalContact();
  if (!contact) redirect("/portal/login");
  const { id } = await params;
  if (!(await portalCanAccessCase(id))) notFound();

  const [cases, messages] = await Promise.all([
    basePrisma.$queryRaw<CaseRow[]>`
      SELECT "id", "number", "subject", "description", "type", "priority", "status", "createdAt"
      FROM "CustomerCase" WHERE "id" = ${id} LIMIT 1
    `,
    basePrisma.$queryRaw<MessageRow[]>`
      SELECT "id", "direction", "body", "createdAt"
      FROM "CustomerCaseMessage" WHERE "caseId" = ${id}
      ORDER BY "createdAt" ASC
    `,
  ]);
  const item = cases[0];
  if (!item) notFound();

  await basePrisma.$executeRaw`
    UPDATE "CustomerCaseMessage" SET "readAt" = COALESCE("readAt", CURRENT_TIMESTAMP)
    WHERE "caseId" = ${id} AND "direction" = 'staff'
  `;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-slate-500">Case C-{item.number.toString()}</p>
        <h1 className="text-2xl font-bold mt-1">{item.subject}</h1>
        <p className="text-sm text-slate-400 mt-1">{item.type} · {item.priority} · {item.status}</p>
      </div>
      <section className="card">
        <p className="text-sm whitespace-pre-wrap">{item.description}</p>
        <p className="text-xs text-slate-500 mt-3">Opened {formatDateTime(item.createdAt)}</p>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Conversation</h2>
        <div className="space-y-3">
          {messages.map((message) => (
            <div key={message.id} className={`rounded-xl p-4 max-w-3xl ${message.direction === "staff" ? "bg-slate-800" : "bg-orange-950/40 border border-orange-900/50 ml-auto"}`}>
              <p className="text-xs font-semibold text-slate-400 mb-1">{message.direction === "staff" ? "Denago Cape Town" : "You"}</p>
              <p className="text-sm whitespace-pre-wrap">{message.body}</p>
              <p className="text-[11px] text-slate-500 mt-2">{formatDateTime(message.createdAt)}</p>
            </div>
          ))}
        </div>
      </section>
      {!['closed', 'cancelled'].includes(item.status) && (
        <section className="card space-y-3">
          <h2 className="font-semibold">Reply</h2>
          <PortalCaseMessageForm caseId={item.id} />
        </section>
      )}
    </div>
  );
}
