import { redirect } from "next/navigation";
import { basePrisma, prisma } from "@/lib/db";
import { getPortalContact } from "@/lib/portal";
import { requirePortalScope } from "@/lib/portalAccess";
import { PortalUploadForm } from "@/components/PortalExpansionForms";
import { formatDate } from "@/lib/format";

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
          { vehicle: { contactId: { in: scope.contactIds } } },
          ...(scope.fleetIds.length ? [{ vehicle: { fleetId: { in: scope.fleetIds } } }] : []),
          { quoteId: { not: null }, quoteId: { in: (await prisma.quote.findMany({ where: { contactId: { in: scope.contactIds }, deletedAt: null }, select: { id: true } })).map((quote) => quote.id) } },
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
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Documents</h1>
        <p className="text-sm text-slate-400 mt-1">Download customer, vehicle, quote and delivery documents, or upload files securely to our team.</p>
      </div>

      <section className="card space-y-4">
        <h2 className="font-semibold">Secure upload</h2>
        <PortalUploadForm
          vehicles={vehicles.map((vehicle) => ({ id: vehicle.id, label: `${vehicle.model}${vehicle.regNumber ? ` (${vehicle.regNumber})` : ""}` }))}
          cases={cases.map((item) => ({ id: item.id, label: `C-${item.number.toString()} · ${item.subject}` }))}
        />
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Documents from Denago</h2>
        {documents.length === 0 ? (
          <div className="card text-sm text-slate-400">No documents are currently available.</div>
        ) : (
          <div className="card p-0 divide-y divide-slate-800">
            {documents.map((document) => (
              <a key={document.id} href={`/api/portal/documents/${document.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-900/60">
                <div>
                  <p className="text-sm font-medium">{document.fileName}</p>
                  <p className="text-xs text-slate-400">{document.tag || document.mimeType} · {formatDate(document.createdAt)}</p>
                </div>
                <span className="btn-secondary btn-sm">Download</span>
              </a>
            ))}
          </div>
        )}
      </section>

      {uploads.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-semibold">Files you uploaded</h2>
          <div className="card p-0 divide-y divide-slate-800">
            {uploads.map((upload) => (
              <a key={upload.id} href={`/api/portal/uploads/${upload.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-900/60">
                <div>
                  <p className="text-sm font-medium">{upload.fileName}</p>
                  <p className="text-xs text-slate-400">{Math.ceil(upload.sizeBytes / 1024)} KB · {upload.status} · {formatDate(upload.createdAt)}</p>
                </div>
                <span className="btn-secondary btn-sm">Download</span>
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
