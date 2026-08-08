import Link from "next/link";
import { Clock3, FileText, FolderTree, HardDrive, Search, Settings2, Upload } from "lucide-react";
import { prisma } from "@/lib/db";
import { contactName, formatDate } from "@/lib/format";
import {
  getAccessibleContactIds,
  getAccessibleDocumentIds,
  getAccessibleQuoteIds,
  getAccessibleVehicleIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { uploadDocument } from "@/app/actions/documents";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { nonAutomotiveDocumentWhere } from "@/lib/modules/registry";
import RepoRow, { type MoveTargets, type RepoDoc } from "@/components/RepoRow";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, SectionHeading, Surface, WorkspaceToolbar } from "@/components/visual-system";
import { WorkspaceHero } from "@/components/workspace-hero";

export const dynamic = "force-dynamic";

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

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
  const [documentIds, contactIds, vehicleIds, quoteIds, canUpload, canManage, canTemplates, automotiveOn] =
    await Promise.all([
      getAccessibleDocumentIds(user),
      getAccessibleContactIds(user),
      getAccessibleVehicleIds(user),
      getAccessibleQuoteIds(user),
      hasPermission(user, "documents.upload"),
      hasPermission(user, "documents.manage"),
      hasPermission(user, "document_templates.manage"),
      isModuleEnabled("automotive"),
    ]);

  const docs = await prisma.document.findMany({
    where: {
      AND: [
        ...(documentIds === null ? [] : [{ id: { in: documentIds } }]),
        ...(versions === "all" ? [] : [{ replacedById: null }]),
        ...(q ? [{ fileName: { contains: q, mode: "insensitive" as const } }] : []),
        // When automotive is off, drop automotive-owned paperwork from the repo:
        // vehicle- or job-card-linked docs, plus delivery paperwork (tagged, but
        // filed against a contact/quote). Null-safe positive filter — see
        // nonAutomotiveDocumentWhere(); a NOT { tag in […] } would drop core
        // documents with a NULL tag.
        ...(automotiveOn ? [] : [nonAutomotiveDocumentWhere()]),
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
  const recentCutoff = new Date();
  recentCutoff.setDate(recentCutoff.getDate() - 30);
  const filedCount = rows.filter((document) => document.filedOn).length;
  const recentCount = docs.filter((document) => document.createdAt >= recentCutoff).length;
  const totalSize = docs.reduce((bytes, document) => bytes + document.sizeBytes, 0);

  return (
    <div className="space-y-6">
      <WorkspaceHero
        icon={FolderTree}
        eyebrow="Business records"
        title="Documents"
        description="Find customer paperwork, understand where every file belongs and manage the repository without losing record context."
        stats={[
          { label: "Files in view", value: rows.length, detail: versions === "all" ? "Including version history" : "Current versions only", icon: FileText, tone: "primary" },
          { label: "Filed", value: filedCount, detail: "Linked to a CRM record", icon: FolderTree, tone: "success" },
          { label: "Added · 30 days", value: recentCount, detail: "Recently uploaded", icon: Clock3, tone: recentCount > 0 ? "primary" : "default" },
          { label: "Storage in view", value: formatFileSize(totalSize), detail: "Across accessible files", icon: HardDrive },
        ]}
        actions={canTemplates ? (
          <Link href="/document-studio" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Settings2 className="size-4" />
            Templates & Studio
          </Link>
        ) : undefined}
      />

      <WorkspaceToolbar className="grid gap-3 lg:grid-cols-[1fr_auto]">
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
          <form action={uploadDocument} className="flex items-center gap-2 rounded-xl border border-border bg-background/40 p-1.5">
            <input type="hidden" name="revalidate" value="/documents" />
            <input type="file" name="file" required className="max-w-56 text-xs text-muted-foreground" />
            <Button size="sm" type="submit"><Upload className="size-4" />Upload</Button>
          </form>
        )}
      </WorkspaceToolbar>

      <Surface className="p-4">
        <SectionHeading
          title="Document register"
          description={`${rows.length} accessible file${rows.length === 1 ? "" : "s"} · downloads and management actions are rechecked on the server.`}
          className="mb-3"
        />
        {rows.length === 0 ? (
          <EmptyState
            icon={q ? Search : FileText}
            title={q ? "No matching documents" : "No documents in this view"}
            description={q ? "Try another file name or clear the current search." : "Uploaded customer and business files will appear here."}
            action={q ? <Link href={versions === "all" ? "/documents?versions=all" : "/documents"} className={buttonVariants({ variant: "outline", size: "sm" })}>Clear search</Link> : undefined}
            className="border-0 bg-transparent"
          />
        ) : (
          <ul className="divide-y divide-border/50">
            {rows.map((doc) => <RepoRow key={doc.id} doc={doc} targets={targets} canManage={canManage} />)}
          </ul>
        )}
      </Surface>
    </div>
  );
}
