import { notFound, redirect } from "next/navigation";
import { portalBrand } from "@/lib/portalBrand";
import Link from "next/link";
import { ArrowLeft, Download, MessageCircle, Paperclip, Send } from "lucide-react";
import { basePrisma } from "@/lib/db";
import { getPortalContact } from "@/lib/portal";
import { portalCanAccessCase } from "@/lib/portalAccess";
import { PortalCaseMessageForm } from "@/components/PortalExpansionForms";
import { formatDate, formatDateTime } from "@/lib/format";
import { PortalPageHeader, SectionHeading, StatusPill, Surface } from "@/components/visual-system";

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
type UploadRow = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
};

export default async function PortalCasePage({ params }: { params: Promise<{ id: string }> }) {
  const contact = await getPortalContact();
  if (!contact) redirect("/portal/login");
  // Cached per request — the layout and every page share one resolution.
  const brand = await portalBrand();
  const { id } = await params;
  if (!(await portalCanAccessCase(id))) notFound();

  const [cases, messages, uploads] = await Promise.all([
    basePrisma.$queryRaw<CaseRow[]>`
      SELECT "id", "number", "subject", "description", "type", "priority", "status", "createdAt"
      FROM "CustomerCase" WHERE "id" = ${id} LIMIT 1
    `,
    basePrisma.$queryRaw<MessageRow[]>`
      SELECT "id", "direction", "body", "createdAt"
      FROM "CustomerCaseMessage" WHERE "caseId" = ${id} AND "type" IN ('customer', 'staff')
      ORDER BY "createdAt" ASC
    `,
    basePrisma.$queryRaw<UploadRow[]>`
      SELECT "id", "fileName", "mimeType", "sizeBytes", "createdAt"
      FROM "PortalUpload" WHERE "caseId" = ${id}
      ORDER BY "createdAt" DESC
    `,
  ]);
  const item = cases[0];
  if (!item) notFound();

  await basePrisma.$executeRaw`
    UPDATE "CustomerCaseMessage" SET "readAt" = COALESCE("readAt", CURRENT_TIMESTAMP)
    WHERE "caseId" = ${id} AND "direction" = 'staff'
  `;

  return (
    <div className="space-y-8">
      <Link href="/portal/support" className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition-colors hover:text-white"><ArrowLeft className="size-3.5" />All support requests</Link>
      <PortalPageHeader eyebrow={`Case C-${item.number.toString()}`} title={item.subject} description={`${item.type} · ${item.priority} priority`} action={<StatusPill tone={['closed', 'resolved'].includes(item.status) ? 'success' : item.status === 'cancelled' ? 'danger' : 'info'}>{item.status.replaceAll('_', ' ')}</StatusPill>} />
      <Surface className="p-5 sm:p-6">
        <p className="text-sm whitespace-pre-wrap">{item.description}</p>
        <p className="text-xs text-slate-500 mt-3">Opened {formatDateTime(item.createdAt)}</p>
      </Surface>
      <section className="space-y-3">
        <SectionHeading title="Conversation" description={brand.branded ? `Messages between you and the ${brand.displayName} team.` : "Messages between you and the Denago team."} action={<MessageCircle className="size-5 text-muted-foreground" />} />
        <div className="space-y-3">
          {messages.map((message) => (
            <div key={message.id} className={`max-w-3xl rounded-2xl border p-4 shadow-sm ${message.direction === "staff" ? "border-white/[0.07] bg-white/[0.045]" : "ml-auto border-orange-500/20 bg-orange-500/[0.08]"}`}>
              <p className="text-xs font-semibold text-slate-400 mb-1">{message.direction === "staff" ? (brand.branded ? brand.displayName : "Denago Cape Town") : "You"}</p>
              <p className="text-sm whitespace-pre-wrap">{message.body}</p>
              <p className="text-[11px] text-slate-500 mt-2">{formatDateTime(message.createdAt)}</p>
            </div>
          ))}
        </div>
      </section>
      {uploads.length > 0 && (
        <section className="space-y-3">
          <SectionHeading title="Attachments" description="Files attached to this support request." action={<Paperclip className="size-5 text-muted-foreground" />} />
          <Surface className="divide-y divide-border">
            {uploads.map((upload) => (
              <a key={upload.id} href={`/api/portal/uploads/${upload.id}`} className="group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-white/[0.025] sm:px-5">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-white/[0.07] bg-white/[0.035] text-slate-400"><Paperclip className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{upload.fileName}</p>
                  <p className="text-xs text-slate-400">{(upload.sizeBytes / 1024).toFixed(0)} KB · {formatDate(upload.createdAt)}</p>
                </div>
                <Download className="size-4 shrink-0 text-slate-500 transition-colors group-hover:text-orange-400" />
              </a>
            ))}
          </Surface>
        </section>
      )}
      {!['closed', 'cancelled'].includes(item.status) && (
        <Surface className="space-y-4 p-5 sm:p-6">
          <SectionHeading title="Reply" description="Continue the conversation securely through your portal." action={<Send className="size-5 text-primary" />} />
          <PortalCaseMessageForm caseId={item.id} />
        </Surface>
      )}
    </div>
  );
}
