import Link from "next/link";
import {
  BookOpen,
  ChevronRight,
  Clock3,
  FileText,
  Files,
  FolderOpen,
  FolderTree,
  History,
  Inbox,
  LayoutGrid,
  List,
  Plus,
  Search,
  Settings2,
  User,
  Users,
} from "lucide-react";
import { prisma } from "@/lib/db";
import { contactName, formatDate } from "@/lib/format";
import type { Prisma } from "@prisma/client";
import {
  getAccessibleContactIds,
  getAccessibleDocumentIds,
  getAccessibleJobCardIds,
  getAccessibleQuoteIds,
  getAccessibleVehicleIds,
  hasAnyPermission,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { getActiveTenantId } from "@/lib/auth";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { nonAutomotiveDocumentWhere } from "@/lib/modules/registry";
import {
  buildFolderTree,
  folderHref,
  inFolder,
  parseFolder,
  placeDocument,
  RECENT_DAYS,
  resolveFolder,
  uploadTargetFor,
  type DocFacts,
  type Folder,
  type RecordLabels,
} from "@/lib/documentFolders";
import DocumentBrowser, { DocumentUploader, type BrowserDoc } from "@/components/documents/DocumentBrowser";
import LibraryItemActions from "@/components/documents/LibraryItemActions";
import { AddDocumentsForm } from "@/components/LibraryUploader";
import ModalTrigger from "@/components/Modal";
import { type MoveTargets } from "@/components/RepoRow";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DesktopOnly,
  MobileOnly,
  MobileSection,
  MobileSegmentNav,
  MobileTaskCard,
  MobileTaskList,
  MobileWorkspaceHeader,
} from "@/components/mobile-workspace";
import { Surface } from "@/components/visual-system";
import { WorkspaceHero } from "@/components/workspace-hero";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Rows DISPLAYED at once. Counts, folders and search cover every file. */
const LIST_LIMIT = 300;

/** The start of the Recent folder's window. Read per request (the page is dynamic). */
function recentCutoff(): Date {
  return new Date(Date.now() - RECENT_DAYS * 86_400_000);
}

type TreeLinkProps = {
  target: Folder;
  icon: typeof Files;
  label: string;
  count: number;
  active: boolean;
  depth?: number;
  keep: Record<string, string | undefined>;
};

function FolderLink({ target, icon: Icon, label, count, active, depth = 0, keep }: TreeLinkProps) {
  return (
    <Link
      href={folderHref(target, keep)}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
        depth === 1 && "pl-7 text-[12.5px]",
        active ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      aria-current={active ? "page" : undefined}
    >
      <Icon className={cn("size-4 shrink-0", active && "text-primary")} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{count}</span>
    </Link>
  );
}

/**
 * A browsable tree of the files the viewer may see, not an unordered pile.
 *
 * Folders are DERIVED from the records files are filed against (see
 * lib/documentFolders.ts) — Customers › Gavin Tagg › Quote Q-1010 — so nothing
 * has to be filed by hand, and a file moved to another record moves folder.
 *
 * Permissions are unchanged: every list here starts from the same accessible
 * document ids the old page used, and uploads, previews and downloads all go
 * through the same server-side checks. A folder only ever narrows that list.
 */
export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; versions?: string; folder?: string; sub?: string; cat?: string; type?: string; view?: string }>;
}) {
  // The Document Library is merged into this page, so its permissions open it
  // too. Each half is then shown only to someone allowed it (below).
  const user = await requireAnyPermission(
    "documents.view_all",
    "documents.view_owned",
    "documents.upload",
    "documents.manage",
    "document_templates.manage",
    "library.view",
    "library.manage",
  );
  const params = await searchParams;
  const q = params.q?.trim() || undefined;
  const versions = params.versions === "all" ? "all" : undefined;
  const type = params.type || undefined;
  const view = params.view === "list" ? "list" : "grid";

  const [canSeeDocuments, canLibrary, canLibraryManage] = await Promise.all([
    hasAnyPermission(user, "documents.view_all", "documents.view_owned", "documents.upload", "documents.manage", "document_templates.manage"),
    hasAnyPermission(user, "library.view", "library.manage"),
    hasPermission(user, "library.manage"),
  ]);
  const folder = resolveFolder(parseFolder(params.folder, params.sub, params.cat), { canSeeDocuments, canLibrary });

  const [documentIds, contactIds, vehicleIds, quoteIds, jobCardIds, canUpload, canManage, canTemplates, automotiveOn, tenantId] =
    await Promise.all([
      getAccessibleDocumentIds(user),
      getAccessibleContactIds(user),
      getAccessibleVehicleIds(user),
      getAccessibleQuoteIds(user),
      getAccessibleJobCardIds(user),
      hasPermission(user, "documents.upload"),
      hasPermission(user, "documents.manage"),
      hasPermission(user, "document_templates.manage"),
      isModuleEnabled("automotive"),
      // Only names the folder uploads are written under; the upload route and
      // the register action resolve and check the workspace themselves.
      getActiveTenantId(),
    ]);

  // Every file the viewer may see: the permission filter, current versions, and
  // the automotive rule — the same three conditions the old flat list used.
  const visibleWhere: Prisma.DocumentWhereInput = {
    AND: [
      // Library-only access: no record documents at all. Stated here rather than
      // left to what getAccessibleDocumentIds returns for someone with no
      // document permission.
      ...(canSeeDocuments ? [] : [{ id: { in: [] as string[] } }]),
      ...(documentIds === null ? [] : [{ id: { in: documentIds } }]),
      ...(versions === "all" ? [] : [{ replacedById: null }]),
      // When automotive is off, drop automotive-owned paperwork: vehicle- or
      // job-card-linked docs, plus delivery paperwork. Null-safe positive
      // filter — see nonAutomotiveDocumentWhere().
      ...(automotiveOn ? [] : [nonAutomotiveDocumentWhere()]),
    ],
  };
  const recentSince = recentCutoff();

  /*
   * THE TREE COUNTS EVERY FILE, NOT THE NEWEST 2,000.
   *
   * The first version loaded up to 2,000 documents and did its foldering and
   * searching in memory, so past that number older files — and whole older
   * customer folders — silently dropped out, and search could not find them.
   *
   * Placement depends only on a document's links, so the tree is counted from
   * the database grouped BY those links: one row per combination, however many
   * documents share it. That covers every visible file and stays small — its
   * size is the number of records with paperwork, not the number of files.
   */
  const [groups, recentCount] = await Promise.all([
    prisma.document.groupBy({
      by: ["contactId", "quoteId", "vehicleId", "jobCardId", "tag"],
      where: visibleWhere,
      _count: { _all: true },
    }),
    prisma.document.count({ where: { AND: [visibleWhere, { createdAt: { gte: recentSince } }] } }),
  ]);
  const facts: DocFacts[] = groups.map((group) => ({
    contactId: group.contactId,
    quoteId: group.quoteId,
    vehicleId: group.vehicleId,
    jobCardId: group.jobCardId,
    tag: group.tag,
    count: group._count._all,
  }));

  const ids = (pick: (row: DocFacts) => string | null) =>
    [...new Set(facts.map(pick).filter((id): id is string => Boolean(id)))];
  const openable = (all: string[], accessible: string[] | null) =>
    accessible === null ? all : all.filter((id) => accessible.includes(id));

  // LABELS ONLY FOR RECORDS THE VIEWER MAY OPEN. A document is visible if any
  // of its links is, so its quote, job card or vehicle may be hidden from this
  // viewer; loading those labels anyway would put "Quote Q-1010" in a folder
  // tree for someone who may not open Q-1010. Unlabelled links are treated as
  // absent by placeDocument.
  const [vehicles, jobCards, quotes] = await Promise.all([
    prisma.vehicle.findMany({
      where: { id: { in: openable(ids((row) => row.vehicleId), vehicleIds) } },
      select: { id: true, model: true, contactId: true },
    }),
    prisma.jobCard.findMany({
      where: { id: { in: openable(ids((row) => row.jobCardId), jobCardIds) } },
      select: { id: true, number: true, contactId: true },
    }),
    prisma.quote.findMany({
      where: { id: { in: openable(ids((row) => row.quoteId), quoteIds) } },
      select: { id: true, number: true, contactId: true },
    }),
  ]);

  // Customer NAMES only for customers the viewer may see. A file reachable
  // through a quote whose customer is hidden from this viewer is placed under
  // "Other records" instead of a folder that would disclose the name.
  const candidateContactIds = [
    ...new Set([
      ...ids((row) => row.contactId),
      ...vehicles.map((vehicle) => vehicle.contactId),
      ...jobCards.map((jobCard) => jobCard.contactId),
      ...quotes.map((quote) => quote.contactId).filter((id): id is string => Boolean(id)),
    ]),
  ];
  const visibleContactIds =
    contactIds === null ? candidateContactIds : candidateContactIds.filter((id) => contactIds.includes(id));
  const contacts = visibleContactIds.length
    ? await prisma.contact.findMany({
        where: { id: { in: visibleContactIds } },
        select: { id: true, firstName: true, lastName: true, isCompany: true, company: true },
      })
    : [];

  const labels: RecordLabels = {
    contacts: new Map(contacts.map((contact) => [contact.id, contactName(contact)])),
    vehicles: new Map(vehicles.map((vehicle) => [vehicle.id, { label: vehicle.model, contactId: vehicle.contactId }])),
    jobCards: new Map(jobCards.map((jobCard) => [jobCard.id, { number: jobCard.number, contactId: jobCard.contactId }])),
    quotes: new Map(quotes.map((quote) => [quote.id, { number: quote.number, contactId: quote.contactId }])),
  };

  const tree = { ...buildFolderTree(facts, labels), recent: recentCount };

  /*
   * THE OPEN FOLDER, AS A DATABASE QUERY.
   *
   * A folder is the set of link combinations that place into it, so it becomes
   * an OR over those combinations and the file list, type counts, search and
   * sort all run in the database across every file — an old file is found as
   * readily as a new one. Only the rows DISPLAYED are capped, and the page says
   * so when there are more.
   */
  const folderWhere: Prisma.DocumentWhereInput | null = (() => {
    if (folder.kind === "all") return visibleWhere;
    if (folder.kind === "recent") return { AND: [visibleWhere, { createdAt: { gte: recentSince } }] };
    const combos = new Map<string, Prisma.DocumentWhereInput>();
    for (const row of facts) {
      if (!inFolder(row, folder, labels)) continue;
      const links = { contactId: row.contactId, quoteId: row.quoteId, vehicleId: row.vehicleId, jobCardId: row.jobCardId };
      combos.set(JSON.stringify(links), links);
    }
    return combos.size ? { AND: [visibleWhere, { OR: [...combos.values()] }] } : null;
  })();

  const typeGroups = folderWhere
    ? await prisma.document.groupBy({ by: ["tag"], where: folderWhere, _count: { _all: true } })
    : [];
  const typeCounts = new Map(typeGroups.map((group) => [group.tag ?? "untagged", group._count._all]));
  const folderTotal = [...typeCounts.values()].reduce((sum, n) => sum + n, 0);

  const listWhere: Prisma.DocumentWhereInput | null = folderWhere && {
    AND: [
      folderWhere,
      ...(type ? [{ tag: type === "untagged" ? null : type }] : []),
      ...(q ? [{ fileName: { contains: q, mode: "insensitive" as const } }] : []),
    ],
  };
  const [shown, matching] = listWhere
    ? await Promise.all([
        prisma.document.findMany({
          where: listWhere,
          orderBy: { createdAt: "desc" },
          take: LIST_LIMIT,
          select: {
            id: true,
            fileName: true,
            mimeType: true,
            sizeBytes: true,
            tag: true,
            createdAt: true,
            replacedById: true,
            contactId: true,
            vehicleId: true,
            jobCardId: true,
            quoteId: true,
            uploadedBy: { select: { name: true } },
          },
        }),
        prisma.document.count({ where: listWhere }),
      ])
    : [[], 0];

  const filedOn = (doc: DocFacts): string | null => {
    const placement = placeDocument(doc, labels);
    if (placement.kind === "company") return null;
    const customer = placement.kind === "customer" ? labels.contacts.get(placement.customerId) : null;
    return customer ? `${customer} › ${placement.subLabel}` : placement.subLabel;
  };

  const browserDocs: BrowserDoc[] = shown.map((doc) => ({
    id: doc.id,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    tag: doc.tag,
    createdAt: formatDate(doc.createdAt),
    uploadedBy: doc.uploadedBy.name,
    filedOn: filedOn(doc),
    superseded: doc.replacedById !== null,
  }));

  /*
   * THE LIBRARY, MERGED IN.
   *
   * Brochures, price lists and spec sheets used to live on a separate page,
   * while "Company files" here took files attached to nothing — two places for
   * the same kind of document. The Library is now a section of this page. It
   * keeps its own store (LibraryDocument, versioned), its own permissions
   * (library.view / library.manage) and its own actions, because email
   * attachments and the chatbot's knowledge read it directly.
   */
  // An uncategorised item is shown under "Other", as the old Library page did.
  const libraryWhere: Prisma.LibraryDocumentWhereInput = {
    AND: [
      ...(folder.kind === "library" && folder.category
        ? [folder.category === "Other" ? { OR: [{ category: "Other" }, { category: null }] } : { category: folder.category }]
        : []),
      ...(q ? [{ name: { contains: q, mode: "insensitive" as const } }] : []),
    ],
  };
  const [libraryCategories, libraryRows, libraryMatching] = canLibrary
    ? await Promise.all([
        prisma.libraryDocument.groupBy({ by: ["category"], _count: { _all: true } }),
        folder.kind === "library"
          ? prisma.libraryDocument.findMany({
              where: libraryWhere,
              orderBy: { name: "asc" },
              take: LIST_LIMIT,
              include: {
                versions: { orderBy: { version: "desc" }, include: { uploadedBy: { select: { name: true } } } },
              },
            })
          : Promise.resolve([]),
        folder.kind === "library" ? prisma.libraryDocument.count({ where: libraryWhere }) : Promise.resolve(0),
      ])
    : [[], [], 0];
  const libraryTotal = libraryCategories.reduce((sum, group) => sum + group._count._all, 0);
  const libraryCategoryCounts = [
    ...libraryCategories
      .reduce((counts, group) => {
        const category = group.category || "Other";
        return counts.set(category, (counts.get(category) ?? 0) + group._count._all);
      }, new Map<string, number>())
      .entries(),
  ]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => a.category.localeCompare(b.category));

  const libraryDocs: BrowserDoc[] = libraryRows
    .filter((doc) => doc.versions.length > 0)
    .map((doc) => {
      const latest = doc.versions[0];
      return {
        id: doc.id,
        fileName: doc.name,
        mimeType: latest.mimeType,
        sizeBytes: latest.sizeBytes,
        tag: doc.category,
        createdAt: formatDate(doc.updatedAt),
        uploadedBy: latest.uploadedBy.name,
        filedOn: `Library · v${latest.version}${doc.versions.length > 1 ? ` of ${doc.versions.length}` : ""}`,
        superseded: false,
        library: {
          versionId: latest.id,
          actions: (
            <LibraryItemActions documentId={doc.id} name={doc.name} versions={doc.versions} canManage={canLibraryManage} />
          ),
        },
      };
    });

  // What the main panel shows: the Library's items in the Library, record
  // documents everywhere else.
  const inLibrary = folder.kind === "library";
  const listDocs = inLibrary ? libraryDocs : browserDocs;
  const listMatching = inLibrary ? libraryMatching : matching;
  const listTotal = inLibrary
    ? folder.category ? libraryCategoryCounts.find((group) => group.category === folder.category)?.count ?? 0 : libraryTotal
    : folderTotal;

  // Destinations for "move to a different record" — unchanged from the old page.
  const [moveContacts, moveVehicles, moveQuotes] = canManage
    ? await Promise.all([
        prisma.contact.findMany({
          where: contactIds === null ? {} : { id: { in: contactIds } },
          orderBy: { firstName: "asc" },
          take: 500,
        }),
        prisma.vehicle.findMany({
          where: vehicleIds === null ? {} : { id: { in: vehicleIds } },
          include: { contact: true },
          orderBy: { model: "asc" },
          take: 500,
        }),
        prisma.quote.findMany({
          where: { AND: [{ supersededAt: null }, ...(quoteIds === null ? [] : [{ id: { in: quoteIds } }])] },
          include: { contact: true },
          orderBy: { createdAt: "desc" },
          take: 250,
        }),
      ])
    : [[], [], []];
  const targets: MoveTargets = {
    contacts: moveContacts.map((contact) => ({ id: contact.id, label: contactName(contact) })),
    vehicles: moveVehicles.map((vehicle) => ({ id: vehicle.id, label: `${vehicle.model} — ${contactName(vehicle.contact)}` })),
    quotes: moveQuotes.map((quote) => ({
      id: quote.id,
      label: `Q-${quote.number}${quote.contact ? ` — ${contactName(quote.contact)}` : ""}`,
    })),
  };

  /* ── Where am I, and what does dropping a file here do? ──────────── */

  const activeCustomer = folder.kind === "customer" ? tree.customers.find((c) => c.id === folder.customerId) : undefined;
  const activeSubs = folder.kind === "customer" ? activeCustomer?.subs ?? [] : folder.kind === "other" ? tree.other.subs : [];
  const activeSubLabel =
    folder.kind === "customer" || folder.kind === "other"
      ? activeSubs.find((subFolder) => subFolder.key === folder.sub)?.label
      : undefined;

  const crumbs: { label: string; href?: string }[] = [{ label: "Documents", href: "/documents" }];
  if (folder.kind === "recent") crumbs.push({ label: "Recent" });
  if (folder.kind === "company") crumbs.push({ label: "Unfiled" });
  if (folder.kind === "library") {
    crumbs.push({ label: "Library", href: folder.category ? folderHref({ kind: "library", category: null }) : undefined });
    if (folder.category) crumbs.push({ label: folder.category });
  }
  if (folder.kind === "customer") {
    crumbs.push({ label: "Customers" });
    crumbs.push({
      label: activeCustomer?.name ?? "Customer",
      href: folder.sub ? folderHref({ kind: "customer", customerId: folder.customerId, sub: null }) : undefined,
    });
  }
  if (folder.kind === "other") {
    crumbs.push({ label: "Other records", href: folder.sub ? folderHref({ kind: "other", sub: null }) : undefined });
  }
  if (activeSubLabel) crumbs.push({ label: activeSubLabel });

  const uploadTarget = uploadTargetFor(folder);
  const uploadHint =
    folder.kind === "company"
      ? "Drop files here to add them to Unfiled — move each onto its customer or record afterwards."
      : folder.kind === "all" || folder.kind === "recent"
        ? "Drop files here to add them to Unfiled, or open a customer to file them there. Brochures and price lists go in the Library."
      : folder.kind === "customer"
        ? `Drop files here to file them on ${activeSubLabel && folder.sub !== "general" ? activeSubLabel : activeCustomer?.name ?? "this customer"}.`
        : folder.kind === "other" && activeSubLabel
          ? `Drop files here to file them on ${activeSubLabel}.`
          : "Open a customer to upload into it.";

  // Unfiled is an inbox, not a destination: it shows only while something is in
  // it (or you are in it), so the tree does not invite filing things nowhere.
  const showUnfiled = tree.company > 0 || folder.kind === "company";
  const libraryAdd = inLibrary && canLibraryManage && (
    <ModalTrigger label={<><Plus className="size-4" />Add to library</>} title="Add documents to library">
      <AddDocumentsForm defaultCategory={folder.category} />
    </ModalTrigger>
  );

  // Links keep the view, type and history settings; a folder change clears the
  // search and the type filter, which belonged to the folder being left.
  const keep = { view: view === "list" ? "list" : undefined, versions };
  const here = (extra: Record<string, string | undefined>) => folderHref(folder, { ...keep, q, type, ...extra });

  const sameFolder = (a: Folder, b: Folder) => JSON.stringify(a) === JSON.stringify(b);

  return (
    <>
      <MobileOnly className="space-y-4">
        <MobileWorkspaceHeader
          title="Documents"
          description="Capture a file quickly or find the document you need."
          action={canTemplates ? <Link href="/document-studio" className={buttonVariants({ variant: "outline", size: "sm" })}><Settings2 className="size-4" />Studio</Link> : undefined}
        />
        {!inLibrary && canUpload && uploadTarget && (
          <DocumentUploader target={uploadTarget} tenantId={tenantId} hint={uploadHint} />
        )}
        {libraryAdd}
        <form className="flex gap-2" role="search">
          {params.folder && <input type="hidden" name="folder" value={params.folder} />}
          {params.sub && <input type="hidden" name="sub" value={params.sub} />}
          {params.cat && <input type="hidden" name="cat" value={params.cat} />}
          {versions && <input type="hidden" name="versions" value="all" />}
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input name="q" defaultValue={q ?? ""} placeholder="Find a file…" className="pl-9" />
          </div>
          <Button variant="secondary" type="submit">Find</Button>
        </form>
        <MobileSegmentNav items={[
          ...(canSeeDocuments
            ? [
                { label: "All", href: folderHref({ kind: "all" }, { versions }), active: folder.kind === "all" },
                { label: "Recent", href: folderHref({ kind: "recent" }, { versions }), active: folder.kind === "recent" },
              ]
            : []),
          ...(canSeeDocuments && showUnfiled
            ? [{ label: "Unfiled", href: folderHref({ kind: "company" }, { versions }), active: folder.kind === "company" }]
            : []),
          ...(canLibrary
            ? [{ label: "Library", href: folderHref({ kind: "library", category: null }), active: inLibrary }]
            : []),
        ]} />
        <MobileSection title={crumbs.at(-1)?.label ?? "Files"} detail={`${listDocs.length} file${listDocs.length === 1 ? "" : "s"}`}>
          {listDocs.length === 0 ? (
            <div className="rounded-2xl border border-border bg-card py-10 text-center text-sm text-muted-foreground">No documents here.</div>
          ) : (
            <MobileTaskList>
              {listDocs.map((doc) => (
                <MobileTaskCard
                  key={doc.id}
                  icon={FileText}
                  title={doc.fileName}
                  detail={doc.filedOn ?? "Unfiled"}
                  meta={`${Math.max(1, Math.round(doc.sizeBytes / 1024))} KB · ${doc.createdAt}${doc.superseded ? " · Replaced" : ""}`}
                  href={doc.library ? `/api/library/${doc.library.versionId}` : `/api/files/${doc.id}`}
                />
              ))}
            </MobileTaskList>
          )}
        </MobileSection>
      </MobileOnly>

      <DesktopOnly className="space-y-5">
        <WorkspaceHero
          icon={FolderTree}
          eyebrow="Business records"
          title="Documents"
          description="Every file the CRM holds, organised by the customer and record it belongs to, plus the Library of brochures, price lists and spec sheets."
          stats={[
            ...(canSeeDocuments
              ? [
                  { label: "All files", value: tree.all, detail: versions ? "Including version history" : "Current versions", icon: Files, tone: "primary" as const },
                  { label: "Customers", value: tree.customers.length, detail: "With files on record", icon: Users, tone: "success" as const },
                ]
              : []),
            ...(canLibrary ? [{ label: "Library", value: libraryTotal, detail: "Brochures, price lists, spec sheets", icon: BookOpen }] : []),
            ...(canSeeDocuments
              ? [{ label: "Added · 30 days", value: tree.recent, detail: "Recently uploaded", icon: Clock3, tone: tree.recent > 0 ? ("primary" as const) : ("default" as const) }]
              : []),
          ]}
          actions={libraryAdd || (canTemplates ? (
            <Link href="/document-studio" className={buttonVariants({ variant: "outline", size: "sm" })}>
              <Settings2 className="size-4" />
              Templates & Studio
            </Link>
          ) : undefined)}
        />

        <div className="grid items-start gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <Surface className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto p-2">
            <nav aria-label="Document folders" className="space-y-0.5">
              {canSeeDocuments && (
                <>
                  <FolderLink keep={keep} target={{ kind: "all" }} icon={Files} label="All files" count={tree.all} active={folder.kind === "all"} />
                  <FolderLink keep={keep} target={{ kind: "recent" }} icon={Clock3} label="Recent" count={tree.recent} active={folder.kind === "recent"} />
                  {showUnfiled && (
                    <FolderLink keep={keep} target={{ kind: "company" }} icon={Inbox} label="Unfiled" count={tree.company} active={folder.kind === "company"} />
                  )}
                </>
              )}

              {canLibrary && (
                <>
                  <p className="px-2 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    Library
                  </p>
                  <FolderLink keep={keep}
                    target={{ kind: "library", category: null }}
                    icon={BookOpen}
                    label="All library"
                    count={libraryTotal}
                    active={inLibrary && !folder.category}
                  />
                  {libraryCategoryCounts.map((group) => (
                    <FolderLink keep={keep}
                      key={group.category}
                      target={{ kind: "library", category: group.category }}
                      icon={FolderTree}
                      label={group.category}
                      count={group.count}
                      depth={1}
                      active={inLibrary && folder.category === group.category}
                    />
                  ))}
                </>
              )}

              {/* Library-only access sees no record documents, so the tree
                  below is empty for it; only the headings need hiding. */}
              {canSeeDocuments && (
                <>
                  <p className="px-2 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    Customers
                  </p>
                  {tree.customers.length === 0 && (
                    <p className="px-2 py-1 text-[12px] text-muted-foreground">No customer files yet.</p>
                  )}
                </>
              )}
              {tree.customers.map((customer) => {
                const open = folder.kind === "customer" && folder.customerId === customer.id;
                return (
                  <div key={customer.id}>
                    <FolderLink keep={keep}
                      target={{ kind: "customer", customerId: customer.id, sub: null }}
                      icon={open ? FolderOpen : User}
                      label={customer.name}
                      count={customer.count}
                      active={open && !folder.sub}
                    />
                    {open &&
                      customer.subs.map((subFolder) => (
                        <FolderLink keep={keep}
                          key={subFolder.key}
                          target={{ kind: "customer", customerId: customer.id, sub: subFolder.key }}
                          icon={FolderTree}
                          label={subFolder.label}
                          count={subFolder.count}
                          depth={1}
                          active={folder.kind === "customer" && folder.sub === subFolder.key}
                        />
                      ))}
                  </div>
                );
              })}

              {tree.other.count > 0 && (
                <>
                  <p className="px-2 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    Other records
                  </p>
                  <FolderLink keep={keep}
                    target={{ kind: "other", sub: null }}
                    icon={FolderTree}
                    label="Files on records"
                    count={tree.other.count}
                    active={folder.kind === "other" && !folder.sub}
                  />
                  {folder.kind === "other" &&
                    tree.other.subs.map((subFolder) => (
                      <FolderLink keep={keep}
                        key={subFolder.key}
                        target={{ kind: "other", sub: subFolder.key }}
                        icon={FolderTree}
                        label={subFolder.label}
                        count={subFolder.count}
                        depth={1}
                        active={sameFolder(folder, { kind: "other", sub: subFolder.key })}
                      />
                    ))}
                </>
              )}
            </nav>
          </Surface>

          <section className="min-w-0 space-y-3">
            <Surface className="space-y-3 p-3">
              <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-[13px]">
                {crumbs.map((crumb, index) => (
                  <span key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                    {index > 0 && <ChevronRight className="size-3.5 text-muted-foreground/60" />}
                    {crumb.href && index < crumbs.length - 1 ? (
                      <Link href={crumb.href} className="text-muted-foreground hover:text-foreground">{crumb.label}</Link>
                    ) : (
                      <span className={index === crumbs.length - 1 ? "font-medium text-foreground" : "text-muted-foreground"}>{crumb.label}</span>
                    )}
                  </span>
                ))}
                <span className="ml-auto text-[12px] text-muted-foreground">
                  {listMatching === listTotal
                    ? `${listTotal} file${listTotal === 1 ? "" : "s"}`
                    : `${listMatching} of ${listTotal} files match`}
                </span>
              </nav>

              <div className="flex flex-wrap items-center gap-2">
                <form className="flex min-w-64 flex-1 items-center gap-2" role="search">
                  {params.folder && <input type="hidden" name="folder" value={params.folder} />}
                  {params.sub && <input type="hidden" name="sub" value={params.sub} />}
                  {params.cat && <input type="hidden" name="cat" value={params.cat} />}
                  {type && <input type="hidden" name="type" value={type} />}
                  {view === "list" && <input type="hidden" name="view" value="list" />}
                  {versions && <input type="hidden" name="versions" value="all" />}
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input name="q" defaultValue={q ?? ""} placeholder="Search this folder…" className="pl-9" />
                  </div>
                  <Button variant="secondary" type="submit">Search</Button>
                </form>
                <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="View">
                  <Link
                    href={here({ view: undefined })}
                    className={cn("rounded px-2 py-1", view === "grid" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
                    aria-label="Grid view"
                    aria-current={view === "grid" ? "true" : undefined}
                  >
                    <LayoutGrid className="size-4" />
                  </Link>
                  <Link
                    href={here({ view: "list" })}
                    className={cn("rounded px-2 py-1", view === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
                    aria-label="List view"
                    aria-current={view === "list" ? "true" : undefined}
                  >
                    <List className="size-4" />
                  </Link>
                </div>
                {/* Library items carry their own version list in the preview. */}
                {!inLibrary && (
                  <Link
                    href={here({ versions: versions ? undefined : "all" })}
                    className={buttonVariants({ variant: versions ? "secondary" : "outline", size: "sm" })}
                  >
                    <History className="size-4" />
                    {versions ? "Showing old versions" : "Version history"}
                  </Link>
                )}
              </div>

              {!inLibrary && typeCounts.size > 1 && (
                <div className="flex flex-wrap gap-1.5">
                  <Link
                    href={here({ type: undefined })}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-[12px]",
                      !type ? "border-primary/40 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    All types
                  </Link>
                  {[...typeCounts.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([key, count]) => (
                      <Link
                        key={key}
                        href={here({ type: key })}
                        className={cn(
                          "rounded-full border px-2.5 py-0.5 text-[12px]",
                          type === key ? "border-primary/40 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {key === "untagged" ? "No type" : key} · {count}
                      </Link>
                    ))}
                </div>
              )}
            </Surface>

            {listMatching > listDocs.length && (
              <p className="rounded-lg border border-border bg-card/60 px-3 py-2 text-[12px] text-muted-foreground">
                Showing {inLibrary ? "the first" : "the newest"} {listDocs.length} of {listMatching}. Search to find the rest — search covers all of them.
              </p>
            )}
            <DocumentBrowser
              docs={listDocs}
              view={view}
              // The Library has its own uploader (Add to library, above): its
              // files are versioned LibraryDocuments, not record Documents.
              uploadTarget={inLibrary ? null : uploadTarget}
              uploadTenantId={tenantId}
              uploadHint={uploadHint}
              canUpload={!inLibrary && canUpload}
              canManage={!inLibrary && canManage}
              targets={targets}
            />
          </section>
        </div>
      </DesktopOnly>
    </>
  );
}
