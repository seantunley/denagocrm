import Link from "next/link";
import { FileText, Search, Settings2, Upload } from "lucide-react";
import { prisma } from "@/lib/db";
import { contactName, formatDate } from "@/lib/format";
import { getAccessibleDocumentIds } from "@/lib/documentAccess";
import {
  getAccessibleContactIds,
  getAccessibleQuoteIds,
  getAccessibleVehicleIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { uploadDocument } from "@/app/actions/documents";
import RepoRow, { type MoveTargets, type RepoDoc } from "@/components/RepoRow";
import { PageHeader } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; versions?: string }>;
}) {
  const user = await requireAnyPermission(
    "documents.view_all",
    "documents.view_owned",
    "documents.upload",
    "documents.manage",
    "document_templates.manage"
  );
  const { q, versions } = await searchParams;
  const [documentIds, contactIds, vehicleIds, quoteIds, canUpload, canManage, canTemplates] =
    await Promise.all([
      getAccessibleDocumentIds(user),
      getAccessibleContactIds(user),
      getAccessibleVehicleIds(user),
      getAccessibleQuoteIds(user),
      hasPermission(user, "documents.upload"),
      hasPermission(user, "documents.manage"),
      hasPermission(user, "document_templates.manage"),
    ]);

  const docs = await prisma.document.findMany({
    where: {
      AND: [
        ...(documentIds === null ? [] : [{ id: { in: documentIds } }]),
        ...(versions === "all" ? [] : [{ replacedById: null }]),
        ...(q ? [{ fileName: { contains: q, mode: "insensitive" as const } }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 250,
    include: {
      contact: true,
      vehicle: { include: { contact: true } },
      jobCard: true,
      uploadedBy: { select: { name: true } },
    },
  });

  const docQuoteIds = [...new Set(docs.map((doc) => doc.quoteId).filter((id): id is string => Boolean(id)))];
  const docQuotes = docQuoteIds.length
    ? await prisma.quote.findMany({ where: { id: { in: docQuoteIds } }, select: { id: true, number: true } })
    : [];
  const quoteNumbers = new Map(docQuotes.map((quote) => [quote.id, quote.number]));

  const [contacts, vehicles, quotes] = await Promise.all([
    prisma.contact.findMany({
      where: !canManage
        ? { id: { in: [] } }
        : contactIds === null
          ? {}
          : { id: { in: contactIds } },
      orderBy: { firstName: "asc" },
      take: 500,
    }),
    prisma.vehicle.findMany({
      where: !canManage
        ? { id: { in: [] } }
        : vehicleIds === null
          ? {}
          : { id: { in: vehicleIds } },
      include: { contact: true },
      orderBy: { model: "asc" },
      take: 500,
    }),
    prisma.quote.findMany({
      where: {
        AND: [
          { supersededAt: null },
          ...(!canManage
            ? [{ id: { in: [] as string[] } }]
            : quoteIds === null
              ? []
              : [{ id: { in: quoteIds } }]),
        ],
      },
      include: { contact: true },
      orderBy: { createdAt: "desc" },
      take: 250,
    }),
  ]);

  const targets: MoveTargets = {
    contacts: contacts.map((contact) => ({ id: contact.id, label: contactName(contact) })),
    vehicles: vehicles.map((vehicle) => ({
      id: vehicle.id,
      label: `${vehicle.model} — ${contactName(vehicle.contact)}`,
    })),
    quotes: quotes.map((quote) => ({
      id: quote.id,
      label: `Q-${quote.number}${quote.contact ? ` — ${contactName(quote.contact)}` : ""}`,
    })),
  };

  const rows: RepoDoc[] = docs.map((doc) => ({
    id: doc.id,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeKB: Math.max(1, Math.round(doc.sizeBytes / 1024)),
    tag: doc.tag,
    createdAt: formatDate(doc.createdAt),
    superseded: doc.replacedById !== null,
    uploadedBy: doc.uploadedBy.name,
    filedOn: doc.contact
      ? `Customer · ${contactName(doc.contact)}`
      : doc.vehicle
        ? `Vehicle · ${doc.vehicle.model} (${contactName(doc.vehicle.contact)})`
        : doc.quoteId
          ? `Quote · Q-${quoteNumbers.get(doc.quoteId) ?? "?"}`
          : doc.jobCard
            ? `Job card · #${doc.jobCard.number}`
            : null,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documents"
        description={`${rows.length} accessible file${rows.length === 1 ? "" : "s"}. Downloads and management actions are checked again on the server.`}
      >
        {canTemplates && (
          <Link href="/document-studio" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Settings2 className="size-4" />
            Templates & Studio
          </Link>
        )}
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <form className="flex items-center gap-2" role="search">
          {versions === "all" && <input type="hidden" name="versions" value="all" />}
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input name="q" defaultValue={q ?? ""} placeholder="Search document names…" className="pl-9" />
          </div>
          <Button variant="secondary" type="submit">Search</Button>
          <Link href={versions === "all" ? "/documents" : "/documents?versions=all"} className={buttonVariants({ variant: "outline", size: "default" })}>
            {versions === "all" ? "Current versions" : "Version history"}
          </Link>
        </form>

        {canUpload && (
          <form action={uploadDocument} className="flex items-center gap-2 rounded-lg border border-border bg-card p-2">
            <input type="hidden" name="revalidate" value="/documents" />
            <input type="file" name="file" required className="max-w-56 text-xs text-muted-foreground" />
            <Button size="sm" type="submit"><Upload className="size-4" />Upload</Button>
          </form>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        {rows.length === 0 ? (
          <div className="py-14 text-center">
            <FileText className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">No accessible documents match this view.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border/50">
            {rows.map((doc) => <RepoRow key={doc.id} doc={doc} targets={targets} canManage={canManage} />)}
          </ul>
        )}
      </div>
    </div>
  );
}
