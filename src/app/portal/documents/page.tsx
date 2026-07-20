import { redirect } from "next/navigation";
import { Download, FileText, FolderOpen, UploadCloud } from "lucide-react";
import { basePrisma, prisma } from "@/lib/db";
import { getPortalContact } from "@/lib/portal";
import { requirePortalScope } from "@/lib/portalAccess";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { PortalUploadForm } from "@/components/PortalExpansionForms";
import { formatDate } from "@/lib/format";
import { EmptyState, PortalPageHeader, SectionHeading, Surface } from "@/components/visual-system";

type UploadRow = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
  status: string;
};
type CaseRow = { id: string; number: bigint; subject: string };

export default async function PortalDocumentsPage() {
  const contact = await getPortalContact();
  if (!contact) redirect("/portal/login");
  const scope = await requirePortalScope();
  const automotiveOn = await isModuleEnabled("automotive");

  const quoteIds = (
    await prisma.quote.findMany({
      where: { contactId: { in: scope.contactIds }, deletedAt: null },
      select: { id: true },
    })
  ).map((quote) => quote.id);

  const [vehicles, documents, uploads, cases] = await Promise.all([
    prisma.vehicle.findMany({
      where: {
        deletedAt: null,
        OR: [
          { contactId: { in: scope.contactIds } },
          ...(scope.fleetIds.length ? [{ fleetId: { in: scope.fleetIds } }] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.document.findMany({
      where: {
        deletedAt: null,
        OR: [
          { contactId: { in: scope.contactIds } },
          // Vehicle/fleet-linked paperwork is automotive-owned; when the pack is
          // off the customer must not see or download it, so drop those branches
          // (the contact-owned and quote-linked branches are core and stay).
          ...(automotiveOn ? [{ vehicle: { contactId: { in: scope.contactIds } } }] : []),
          ...(automotiveOn && scope.fleetIds.length ? [{ vehicle: { fleetId: { in: scope.fleetIds } } }] : []),
          ...(quoteIds.length ? [{ quoteId: { in: quoteIds } }] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    basePrisma.$queryRaw<UploadRow[]>`
      SELECT "id", "fileName", "mimeType", "sizeBytes", "createdAt", "status"
      FROM "PortalUpload"
      WHERE "contactId" = ANY(${scope.contactIds}::text[])
      ORDER BY "createdAt" DESC LIMIT 100
    `,
    basePrisma.$queryRaw<CaseRow[]>`
      SELECT "id", "number", "subject" FROM "CustomerCase"
      WHERE "contactId" = ANY(${scope.contactIds}::text[])
      ORDER BY "updatedAt" DESC LIMIT 100
    `,
  ]);

  return (
    <div className="space-y-10">
      <PortalPageHeader eyebrow="Document centre" title="Documents" description={automotiveOn ? "Download your customer, vehicle, quote and delivery documents, or send files securely to our team." : "Download your documents, or send files securely to our team."} />

      <Surface className="space-y-5 p-5 sm:p-6">
        <SectionHeading title="Secure upload" description="Files are attached directly to your customer record and are only visible to the Denago team." action={<span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary"><UploadCloud className="size-5" /></span>} />
        <PortalUploadForm
          automotive={automotiveOn}
          vehicles={automotiveOn ? vehicles.map((vehicle) => ({ id: vehicle.id, label: `${vehicle.model}${vehicle.regNumber ? ` (${vehicle.regNumber})` : ""}` })) : []}
          cases={cases.map((item) => ({ id: item.id, label: `C-${item.number.toString()} · ${item.subject}` }))}
        />
      </Surface>

      <section className="space-y-3">
        <SectionHeading title="Documents from Denago" description="Your latest official documents and completed paperwork." />
        {documents.length === 0 ? (
          <EmptyState icon={FolderOpen} title="No documents available yet" description="Quotes, delivery paperwork and other files shared with you will appear here." className="py-10" />
        ) : (
          <Surface className="divide-y divide-border">
            {documents.map((document) => (
              <a key={document.id} href={`/api/portal/documents/${document.id}`} className="group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-white/[0.025] sm:px-5">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-white/[0.07] bg-white/[0.035] text-slate-400"><FileText className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{document.fileName}</p>
                  <p className="text-xs text-slate-400">{document.tag || document.mimeType} · {formatDate(document.createdAt)}</p>
                </div>
                <Download className="size-4 shrink-0 text-slate-500 transition-colors group-hover:text-orange-400" />
              </a>
            ))}
          </Surface>
        )}
      </section>

      {uploads.length > 0 && (
        <section className="space-y-3">
          <SectionHeading title="Files you uploaded" description="A record of files you have securely shared with us." />
          <Surface className="divide-y divide-border">
            {uploads.map((upload) => (
              <a key={upload.id} href={`/api/portal/uploads/${upload.id}`} className="group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-white/[0.025] sm:px-5">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-white/[0.07] bg-white/[0.035] text-slate-400"><UploadCloud className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{upload.fileName}</p>
                  <p className="text-xs text-slate-400">{Math.ceil(upload.sizeBytes / 1024)} KB · {upload.status} · {formatDate(upload.createdAt)}</p>
                </div>
                <Download className="size-4 shrink-0 text-slate-500 transition-colors group-hover:text-orange-400" />
              </a>
            ))}
          </Surface>
        </section>
      )}
    </div>
  );
}
