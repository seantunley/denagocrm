import Link from "next/link";
import {
  BookOpen,
  Building2,
  ChevronRight,
  Clock3,
  FileText,
  Files,
  FolderOpen,
  FolderTree,
  History,
  LayoutGrid,
  List,
  Search,
  Settings2,
  User,
  Users,
} from "lucide-react";
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
import { getActiveTenantId } from "@/lib/auth";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { nonAutomotiveDocumentWhere } from "@/lib/modules/registry";
import {
  buildFolderTree,
  folderHref,
  inFolder,
  parseFolder,
  placeDocument,
  uploadTargetFor,
  type DocFacts,
  type Folder,
  type RecordLabels,
} from "@/lib/documentFolders";
import DocumentBrowser, { DocumentUploader, type BrowserDoc } from "@/components/documents/DocumentBrowser";
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
  searchParams: Promise<{ q?: string; versions?: string; folder?: string; sub?: string; type?: string; view?: string }>;
}) {
  const user = await requireAnyPermission(
    "documents.view_all",
    "documents.view_owned",
    "documents.upload",
    "documents.manage",
    "document_templates.manage"
  );
  const params = await searchParams;
  const q = params.q?.trim() || undefined;
  const versions = params.versions === "all" ? "all" : undefined;
  const type = params.type || undefined;
  const view = params.view === "list" ? "list" : "grid";
  const folder = parseFolder(params.folder, params.sub);

  const [documentIds, contactIds, vehicleIds, quoteIds, canUpload, canManage, canTemplates, automotiveOn, tenantId] =
    await Promise.all([
      getAccessibleDocumentIds(user),
      getAccessibleContactIds(user),
      getAccessibleVehicleIds(user),
      getAccessibleQuoteIds(user),
      hasPermission(user, "documents.upload"),
      hasPermission(user, "documents.manage"),
      hasPermission(user, "document_templates.manage"),
      isModuleEnabled("automotive"),
      // Only names the folder uploads are written under; the upload route and
      // the register action resolve and check the workspace themselves.
      getActiveTenantId(),
    ]);

  // Every file the viewer may see — the tree needs all of them to count its
  // folders, not only the ones in the folder that is open.
  const docs = await prisma.document.findMany({
    where: {
      AND: [
        ...(documentIds === null ? [] : [{ id: { in: documentIds } }]),
        ...(versions === "all" ? [] : [{ replacedById: null }]),
        // When automotive is off, drop automotive-owned paperwork: vehicle- or
        // job-card-linked docs, plus delivery paperwork. Null-safe positive
        // filter — see nonAutomotiveDocumentWhere().
        ...(automotiveOn ? [] : [nonAutomotiveDocumentWhere()]),
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 2000,
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
  });

  const ids = (pick: (doc: (typeof docs)[number]) => string | null) =>
    [...new Set(docs.map(pick).filter((id): id is string => Boolean(id)))];

  const [vehicles, jobCards, quotes] = await Promise.all([
    prisma.vehicle.findMany({ where: { id: { in: ids((doc) => doc.vehicleId) } }, select: { id: true, model: true, contactId: true } }),
    prisma.jobCard.findMany({ where: { id: { in: ids((doc) => doc.jobCardId) } }, select: { id: true, number: true, contactId: true } }),
    prisma.quote.findMany({ where: { id: { in: ids((doc) => doc.quoteId) } }, select: { id: true, number: true, contactId: true } }),
  ]);

  // Customer NAMES only for customers the viewer may see. A file reachable
  // through a quote whose customer is hidden from this viewer is placed under
  // "Other records" instead of a folder that would disclose the name.
  const candidateContactIds = [
    ...new Set([
      ...ids((doc) => doc.contactId),
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

  const facts = (doc: (typeof docs)[number]): DocFacts => doc;
  const tree = buildFolderTree(docs.map(facts), labels);
  const inThisFolder = docs.filter((doc) => inFolder(facts(doc), folder, labels));

  // The types present in this folder, for the filter chips.
  const typeCounts = new Map<string, number>();
  for (const doc of inThisFolder) {
    const key = doc.tag ?? "untagged";
    typeCounts.set(key, (typeCounts.get(key) ?? 0) + 1);
  }
  const shown = inThisFolder.filter(
    (doc) =>
      (!type || (doc.tag ?? "untagged") === type) &&
      (!q || doc.fileName.toLowerCase().includes(q.toLowerCase())),
  );

  const filedOn = (doc: (typeof docs)[number]): string | null => {
    const placement = placeDocument(facts(doc), labels);
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
  if (folder.kind === "company") crumbs.push({ label: "Company files" });
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
      ? "Drop files here to add them to Company files — shared with everyone who can see documents."
      : folder.kind === "all" || folder.kind === "recent"
        ? "Drop files here to add them to Company files, or open a customer to file them there."
      : folder.kind === "customer"
        ? `Drop files here to file them on ${activeSubLabel && folder.sub !== "general" ? activeSubLabel : activeCustomer?.name ?? "this customer"}.`
        : folder.kind === "other" && activeSubLabel
          ? `Drop files here to file them on ${activeSubLabel}.`
          : "Open a customer or Company files to upload into it.";

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
        {canUpload && uploadTarget && (
          <DocumentUploader target={uploadTarget} tenantId={tenantId} hint={uploadHint} />
        )}
        <form className="flex gap-2" role="search">
          {params.folder && <input type="hidden" name="folder" value={params.folder} />}
          {params.sub && <input type="hidden" name="sub" value={params.sub} />}
          {versions && <input type="hidden" name="versions" value="all" />}
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input name="q" defaultValue={q ?? ""} placeholder="Find a file…" className="pl-9" />
          </div>
          <Button variant="secondary" type="submit">Find</Button>
        </form>
        <MobileSegmentNav items={[
          { label: "All", href: folderHref({ kind: "all" }, { versions }), active: folder.kind === "all" },
          { label: "Recent", href: folderHref({ kind: "recent" }, { versions }), active: folder.kind === "recent" },
          { label: "Company", href: folderHref({ kind: "company" }, { versions }), active: folder.kind === "company" },
        ]} />
        <MobileSection title={crumbs.at(-1)?.label ?? "Files"} detail={`${browserDocs.length} file${browserDocs.length === 1 ? "" : "s"}`}>
          {browserDocs.length === 0 ? (
            <div className="rounded-2xl border border-border bg-card py-10 text-center text-sm text-muted-foreground">No documents here.</div>
          ) : (
            <MobileTaskList>
              {browserDocs.map((doc) => (
                <MobileTaskCard
                  key={doc.id}
                  icon={FileText}
                  title={doc.fileName}
                  detail={doc.filedOn ?? "Company file"}
                  meta={`${Math.max(1, Math.round(doc.sizeBytes / 1024))} KB · ${doc.createdAt}${doc.superseded ? " · Replaced" : ""}`}
                  href={`/api/files/${doc.id}`}
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
          description="Every file the CRM holds, organised by the customer and record it belongs to, plus shared company files."
          stats={[
            { label: "All files", value: tree.all, detail: versions ? "Including version history" : "Current versions", icon: Files, tone: "primary" },
            { label: "Customers", value: tree.customers.length, detail: "With files on record", icon: Users, tone: "success" },
            { label: "Company files", value: tree.company, detail: "Not tied to a customer", icon: Building2 },
            { label: "Added · 30 days", value: tree.recent, detail: "Recently uploaded", icon: Clock3, tone: tree.recent > 0 ? "primary" : "default" },
          ]}
          actions={canTemplates ? (
            <Link href="/document-studio" className={buttonVariants({ variant: "outline", size: "sm" })}>
              <Settings2 className="size-4" />
              Templates & Studio
            </Link>
          ) : undefined}
        />

        <div className="grid items-start gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <Surface className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto p-2">
            <nav aria-label="Document folders" className="space-y-0.5">
              <FolderLink keep={keep} target={{ kind: "all" }} icon={Files} label="All files" count={tree.all} active={folder.kind === "all"} />
              <FolderLink keep={keep} target={{ kind: "recent" }} icon={Clock3} label="Recent" count={tree.recent} active={folder.kind === "recent"} />
              <FolderLink keep={keep} target={{ kind: "company" }} icon={Building2} label="Company files" count={tree.company} active={folder.kind === "company"} />

              <p className="px-2 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                Customers
              </p>
              {tree.customers.length === 0 && (
                <p className="px-2 py-1 text-[12px] text-muted-foreground">No customer files yet.</p>
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

              <div className="mt-3 border-t border-border pt-2">
                <Link
                  href="/library"
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <BookOpen className="size-4" />
                  Brochures &amp; price lists
                </Link>
              </div>
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
                  {browserDocs.length} of {inThisFolder.length} file{inThisFolder.length === 1 ? "" : "s"}
                </span>
              </nav>

              <div className="flex flex-wrap items-center gap-2">
                <form className="flex min-w-64 flex-1 items-center gap-2" role="search">
                  {params.folder && <input type="hidden" name="folder" value={params.folder} />}
                  {params.sub && <input type="hidden" name="sub" value={params.sub} />}
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
                <Link
                  href={here({ versions: versions ? undefined : "all" })}
                  className={buttonVariants({ variant: versions ? "secondary" : "outline", size: "sm" })}
                >
                  <History className="size-4" />
                  {versions ? "Showing old versions" : "Version history"}
                </Link>
              </div>

              {typeCounts.size > 1 && (
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

            <DocumentBrowser
              docs={browserDocs}
              view={view}
              uploadTarget={uploadTarget}
              uploadTenantId={tenantId}
              uploadHint={uploadHint}
              canUpload={canUpload}
              canManage={canManage}
              targets={targets}
            />
          </section>
        </div>
      </DesktopOnly>
    </>
  );
}
